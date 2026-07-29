//! Directory primitives plus fuzzy file path discovery for autocomplete and
//! @-mention resolution.
//!
//! `readDirLimited` provides bounded single-directory enumeration without
//! recursion, while `fuzzyFind` searches for files and directories whose paths
//! match a query string via subsequence scoring using the shared [`fs_cache`].

use std::{fs, path::Path};

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::{fs_cache, task};

const INVALID_UTF8_ENTRY_REASON: &str = "Directory entry name is not valid UTF-8";

/// Options for bounded single-directory enumeration.
#[derive(Debug)]
#[napi(object)]
pub struct ReadDirLimitedOptions {
	/// Directory to enumerate.
	pub path:  String,
	/// Maximum number of entries to return. Must be an integer in the `u32`
	/// range.
	pub limit: f64,
}

/// A single filesystem entry returned by `readDirLimited`.
#[derive(Debug)]
#[napi(object)]
pub struct ReadDirLimitedEntry {
	/// Basename only; no path separators or parent path included.
	pub name:             String,
	/// Whether this entry itself is a directory.
	pub is_directory:     bool,
	/// Whether this entry itself is a symbolic link.
	pub is_symbolic_link: bool,
}

/// Bounded single-directory enumeration result.
#[derive(Debug)]
#[napi(object)]
pub struct ReadDirLimitedResult {
	/// Entries observed before truncation, capped at `limit`.
	pub entries:   Vec<ReadDirLimitedEntry>,
	/// Whether more direct children existed beyond `entries`.
	pub truncated: bool,
}

fn invalid_limit_error() -> Error {
	Error::from_reason(
		"readDirLimited requires `limit` to be an integer between 1 and 4294967295".to_string(),
	)
}

fn io_error(err: std::io::Error, context: &str) -> Error {
	Error::from_reason(format!("{context}: {err}"))
}

fn consume_limited_results<I, T, U, E, F>(
	mut iter: I,
	limit: usize,
	mut convert: F,
) -> std::result::Result<(Vec<U>, bool), E>
where
	I: Iterator<Item = std::result::Result<T, E>>,
	F: FnMut(T) -> std::result::Result<U, E>,
{
	let mut entries = Vec::new();
	while entries.len() < limit {
		match iter.next() {
			Some(Ok(entry)) => entries.push(convert(entry)?),
			Some(Err(err)) => return Err(err),
			None => return Ok((entries, false)),
		}
	}

	Ok((entries, iter.next().is_some()))
}

fn read_dir_limited_sync(options: ReadDirLimitedOptions) -> Result<ReadDirLimitedResult> {
	if !options.limit.is_finite()
		|| options.limit.fract() != 0.0
		|| options.limit < 1.0
		|| options.limit > f64::from(u32::MAX)
	{
		return Err(invalid_limit_error());
	}
	let limit = usize::try_from(options.limit as u32).map_err(|_| invalid_limit_error())?;

	let direct_entries = fs::read_dir(&options.path)
		.map_err(|err| io_error(err, "Failed to read directory"))?
		.map(|entry| entry.map_err(|err| io_error(err, "Failed to read directory entry")));

	let (entries, truncated) = consume_limited_results(direct_entries, limit, |entry| {
		let file_type = entry
			.file_type()
			.map_err(|err| io_error(err, "Failed to inspect directory entry type"))?;
		let name = entry
			.file_name()
			.into_string()
			.map_err(|_| Error::from_reason(INVALID_UTF8_ENTRY_REASON.to_string()))?;
		Ok(ReadDirLimitedEntry {
			name,
			is_directory: file_type.is_dir(),
			is_symbolic_link: file_type.is_symlink(),
		})
	})?;
	Ok(ReadDirLimitedResult { entries, truncated })
}

/// Read at most `limit` direct children from one directory without recursion.
#[napi(js_name = "readDirLimited")]
pub fn read_dir_limited(options: ReadDirLimitedOptions) -> task::Promise<ReadDirLimitedResult> {
	task::blocking("readDirLimited", task::CancelToken::default(), move |_| {
		read_dir_limited_sync(options)
	})
}

/// Options for fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindOptions<'env> {
	/// Fuzzy query to match against file paths (case-insensitive).
	pub query:            String,
	/// Directory to search.
	pub path:             String,
	/// Include hidden files (default: false).
	pub hidden:           Option<bool>,
	/// Respect .gitignore (default: true).
	pub gitignore:        Option<bool>,
	/// Enable shared filesystem scan cache (default: false).
	pub cache:            Option<bool>,
	/// Best-effort discovery containment that follows symlinks only when their
	/// canonical target remains under the search root (default: false). This is
	/// not a security boundary against concurrent filesystem mutation.
	pub stay_within_root: Option<bool>,
	/// Maximum number of matches to return (default: 100).
	pub max_results:      Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:           Option<Unknown<'env>>,
	/// Timeout in milliseconds for the operation.
	pub timeout_ms:       Option<u32>,
}

/// A single match in fuzzy find results.
#[napi(object)]
pub struct FuzzyFindMatch {
	/// Relative path from the search root (uses `/` separators).
	pub path:         String,
	/// Whether this entry is a directory.
	pub is_directory: bool,
	/// Match quality score (higher is better).
	pub score:        u32,
}

/// Result of fuzzy file path search.
#[napi(object)]
pub struct FuzzyFindResult {
	/// Matched entries (up to `maxResults`).
	pub matches:       Vec<FuzzyFindMatch>,
	/// Total number of matches found (may exceed `matches.len()`).
	pub total_matches: u32,
}

fn normalize_fuzzy_text(value: &str) -> String {
	value
		.chars()
		.filter(|ch| !ch.is_whitespace() && !matches!(ch, '/' | '\\' | '.' | '_' | '-'))
		.flat_map(|ch| ch.to_lowercase())
		.collect()
}

fn fuzzy_subsequence_score(query_chars: &[char], target: &str) -> u32 {
	if query_chars.is_empty() {
		return 1;
	}
	let mut query_index = 0usize;
	let mut gaps = 0u32;
	let mut last_match_index: Option<usize> = None;
	for (target_index, target_ch) in target.chars().enumerate() {
		if query_index >= query_chars.len() {
			break;
		}
		if query_chars[query_index] == target_ch {
			if let Some(last_index) = last_match_index
				&& target_index > last_index + 1
			{
				gaps = gaps.saturating_add(1);
			}
			last_match_index = Some(target_index);
			query_index += 1;
		}
	}
	if query_index != query_chars.len() {
		return 0;
	}
	let gap_penalty = gaps.saturating_mul(5);
	40u32.saturating_sub(gap_penalty).max(1)
}

fn score_fuzzy_path(
	path: &str,
	is_directory: bool,
	query_lower: &str,
	normalized_query: &str,
	query_chars: &[char],
) -> u32 {
	if query_lower.is_empty() {
		return if is_directory { 11 } else { 1 };
	}

	// Match against the full relative path only when the user typed a path-style
	// query (contains '/'). Plain queries should match by basename only, otherwise
	// '@plan' surfaces every file whose ancestor directories contain 'plan'.
	let query_has_slash = query_lower.contains('/');

	let file_name = Path::new(path)
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or(path);
	let lower_file_name = file_name.to_lowercase();

	let mut score = if lower_file_name == query_lower {
		120
	} else if lower_file_name.starts_with(query_lower) {
		100
	} else if lower_file_name.contains(query_lower) {
		80
	} else if !query_has_slash {
		let normalized_file_name = normalize_fuzzy_text(file_name);
		let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
		if file_name_fuzzy > 0 {
			50 + file_name_fuzzy
		} else {
			0
		}
	} else {
		let lower_path = path.to_lowercase();
		if lower_path.contains(query_lower) {
			60
		} else {
			let normalized_file_name = normalize_fuzzy_text(file_name);
			let file_name_fuzzy = fuzzy_subsequence_score(query_chars, &normalized_file_name);
			if file_name_fuzzy > 0 {
				50 + file_name_fuzzy
			} else {
				let normalized_path = normalize_fuzzy_text(path);
				let path_fuzzy = if normalized_path == normalized_query {
					40
				} else {
					fuzzy_subsequence_score(query_chars, &normalized_path)
				};
				if path_fuzzy > 0 { 30 + path_fuzzy } else { 0 }
			}
		}
	};

	if is_directory && score > 0 {
		score += 10;
	}

	score
}

struct FuzzyFindConfig {
	query:            String,
	path:             String,
	hidden:           Option<bool>,
	gitignore:        Option<bool>,
	max_results:      Option<u32>,
	cache:            Option<bool>,
	stay_within_root: Option<bool>,
}

fn score_entries(
	entries: &[fs_cache::GlobMatch],
	query_lower: &str,
	normalized_query: &str,
	query_chars: &[char],
	ct: &task::CancelToken,
) -> Result<Vec<FuzzyFindMatch>> {
	let mut scored = Vec::with_capacity(entries.len().min(256));
	for entry in entries {
		ct.heartbeat()?;
		if entry.file_type == fs_cache::FileType::Symlink {
			continue;
		}

		let is_directory = entry.file_type == fs_cache::FileType::Dir;
		let score =
			score_fuzzy_path(&entry.path, is_directory, query_lower, normalized_query, query_chars);
		if score == 0 {
			continue;
		}

		let mut path = entry.path.clone();
		if is_directory {
			path.push('/');
		}
		scored.push(FuzzyFindMatch { path, is_directory, score });
	}
	Ok(scored)
}

fn fuzzy_find_sync(config: FuzzyFindConfig, ct: task::CancelToken) -> Result<FuzzyFindResult> {
	let root = fs_cache::resolve_search_path(&config.path)?;
	let include_hidden = config.hidden.unwrap_or(false);
	let respect_gitignore = config.gitignore.unwrap_or(true);
	let max_results = config.max_results.unwrap_or(100) as usize;
	if max_results == 0 {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let query_lower = config.query.trim().to_lowercase();
	let normalized_query = normalize_fuzzy_text(&query_lower);
	let query_chars: Vec<char> = normalized_query.chars().collect();
	if !query_lower.is_empty() && normalized_query.is_empty() {
		return Ok(FuzzyFindResult { matches: Vec::new(), total_matches: 0 });
	}

	let use_cache = config.cache.unwrap_or(false);
	let scan_options = fs_cache::ScanOptions {
		include_hidden,
		use_gitignore: respect_gitignore,
		skip_node_modules: true,
		follow_links: true,
		stay_within_root: config.stay_within_root.unwrap_or(false),
		detail: fs_cache::ScanDetail::Minimal,
	};
	let mut scored = if use_cache {
		let scan = fs_cache::get_or_scan(&root, scan_options, &ct)?;
		let mut scored =
			score_entries(&scan.entries, &query_lower, &normalized_query, &query_chars, &ct)?;
		if scored.is_empty()
			&& !query_lower.is_empty()
			&& scan.cache_age_ms >= fs_cache::empty_recheck_ms()
		{
			let fresh = fs_cache::force_rescan(&root, scan_options, true, &ct)?;
			scored = score_entries(&fresh, &query_lower, &normalized_query, &query_chars, &ct)?;
		}
		scored
	} else {
		let fresh = fs_cache::force_rescan(&root, scan_options, false, &ct)?;
		score_entries(&fresh, &query_lower, &normalized_query, &query_chars, &ct)?
	};

	scored.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.path.cmp(&b.path)));
	let total_matches = crate::utils::clamp_u32(scored.len() as u64);
	let matches = scored.into_iter().take(max_results).collect();
	Ok(FuzzyFindResult { matches, total_matches })
}

/// Fuzzy file path search for autocomplete.
#[napi(js_name = "fuzzyFind")]
pub fn fuzzy_find(options: FuzzyFindOptions<'_>) -> task::Promise<FuzzyFindResult> {
	let FuzzyFindOptions {
		query,
		path,
		hidden,
		gitignore,
		cache,
		stay_within_root,
		max_results,
		timeout_ms,
		signal,
	} = options;
	let ct = task::CancelToken::new(timeout_ms, signal);
	let config =
		FuzzyFindConfig { query, path, hidden, gitignore, max_results, cache, stay_within_root };
	task::blocking("fuzzy_find", ct, move |ct| fuzzy_find_sync(config, ct))
}

#[cfg(test)]
mod tests {
	use std::{
		cell::Cell,
		collections::BTreeMap,
		fs,
		path::{Path, PathBuf},
		rc::Rc,
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::{ReadDirLimitedOptions, consume_limited_results, read_dir_limited_sync};

	struct TempDir {
		path: PathBuf,
	}

	impl TempDir {
		fn new(prefix: &str) -> Self {
			static NEXT_ID: AtomicU64 = AtomicU64::new(0);
			let unique = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system clock before unix epoch")
				.as_nanos();
			let suffix = NEXT_ID.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir().join(format!("{prefix}-{unique}-{suffix}"));
			fs::create_dir_all(&path).expect("create temp directory");
			Self { path }
		}

		fn path(&self) -> &Path {
			&self.path
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.path);
		}
	}

	fn read_dir_names(root: &Path, limit: u32) -> super::ReadDirLimitedResult {
		read_dir_limited_sync(ReadDirLimitedOptions {
			path:  root.to_string_lossy().into_owned(),
			limit: f64::from(limit),
		})
		.expect("readDirLimited should succeed")
	}

	fn create_symlink(target: &Path, link: &Path) -> Option<()> {
		#[cfg(unix)]
		{
			std::os::unix::fs::symlink(target, link).expect("create unix symlink");
			Some(())
		}
		#[cfg(windows)]
		{
			let result = if target.is_dir() {
				std::os::windows::fs::symlink_dir(target, link)
			} else {
				std::os::windows::fs::symlink_file(target, link)
			};
			match result {
				Ok(()) => Some(()),
				Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => None,
				Err(err) => panic!("create windows symlink: {err}"),
			}
		}
	}

	#[test]
	fn rejects_invalid_limits() {
		let root = TempDir::new("pi-read-dir-limited");
		for limit in [0.0, -1.0, 1.5, f64::from(u32::MAX) + 1.0, f64::NAN, f64::INFINITY] {
			let err = read_dir_limited_sync(ReadDirLimitedOptions {
				path: root.path().to_string_lossy().into_owned(),
				limit,
			})
			.expect_err("invalid limits should be rejected");

			assert!(err.to_string().contains("integer between 1 and 4294967295"));
		}
	}

	#[test]
	fn returns_empty_result_for_empty_directory() {
		let root = TempDir::new("pi-read-dir-limited");
		let result = read_dir_names(root.path(), 4);
		assert!(result.entries.is_empty());
		assert!(!result.truncated);
	}

	#[test]
	fn returns_all_entries_when_fewer_than_limit() {
		let root = TempDir::new("pi-read-dir-limited");
		fs::write(root.path().join("alpha.txt"), "alpha").expect("write alpha");
		fs::write(root.path().join("beta.txt"), "beta").expect("write beta");

		let result = read_dir_names(root.path(), 4);
		let truncated = result.truncated;
		let names: Vec<_> = result.entries.into_iter().map(|entry| entry.name).collect();
		assert_eq!(names.len(), 2);
		assert!(names.contains(&"alpha.txt".to_string()));
		assert!(names.contains(&"beta.txt".to_string()));
		assert!(!truncated);
	}

	#[test]
	fn returns_exact_limit_without_truncation() {
		let root = TempDir::new("pi-read-dir-limited");
		for name in ["alpha.txt", "beta.txt", "gamma.txt"] {
			fs::write(root.path().join(name), name).expect("write fixture file");
		}

		let result = read_dir_names(root.path(), 3);
		assert_eq!(result.entries.len(), 3);
		assert!(!result.truncated);
	}

	#[test]
	fn truncates_after_limit_entries() {
		let root = TempDir::new("pi-read-dir-limited");
		for name in ["alpha.txt", "beta.txt", "gamma.txt"] {
			fs::write(root.path().join(name), name).expect("write fixture file");
		}

		let result = read_dir_names(root.path(), 2);
		assert_eq!(result.entries.len(), 2);
		assert!(result.truncated);
	}

	#[test]
	fn truncates_when_limit_is_one() {
		let root = TempDir::new("pi-read-dir-limited");
		for name in ["alpha.txt", "beta.txt"] {
			fs::write(root.path().join(name), name).expect("write fixture file");
		}

		let result = read_dir_names(root.path(), 1);
		assert_eq!(result.entries.len(), 1);
		assert!(result.truncated);
	}

	#[test]
	fn accepts_the_maximum_u32_limit() {
		let root = TempDir::new("pi-read-dir-limited");
		fs::write(root.path().join("alpha.txt"), "alpha").expect("write alpha");

		let result = read_dir_names(root.path(), u32::MAX);
		assert_eq!(result.entries.len(), 1);
		assert!(!result.truncated);
	}

	#[test]
	fn classifies_files_directories_and_symlinks() {
		let root = TempDir::new("pi-read-dir-limited");
		let regular = root.path().join("regular.txt");
		let directory = root.path().join("nested");
		let symlink = root.path().join("regular-link");
		fs::write(&regular, "alpha").expect("write regular file");
		fs::create_dir(&directory).expect("create nested directory");
		if create_symlink(&regular, &symlink).is_none() {
			return;
		}

		let result = read_dir_names(root.path(), 8);
		let entries = result
			.entries
			.into_iter()
			.map(|entry| (entry.name.clone(), entry))
			.collect::<BTreeMap<_, _>>();

		assert_eq!(entries["regular.txt"].is_directory, false);
		assert_eq!(entries["regular.txt"].is_symbolic_link, false);
		assert_eq!(entries["nested"].is_directory, true);
		assert_eq!(entries["nested"].is_symbolic_link, false);
		assert_eq!(entries["regular-link"].is_directory, false);
		assert_eq!(entries["regular-link"].is_symbolic_link, true);
	}

	#[test]
	fn returns_errors_for_missing_or_non_directory_paths() {
		let root = TempDir::new("pi-read-dir-limited");
		let missing = root.path().join("missing");
		let file = root.path().join("plain.txt");
		fs::write(&file, "plain").expect("write plain file");

		let missing_error = read_dir_limited_sync(ReadDirLimitedOptions {
			path:  missing.to_string_lossy().into_owned(),
			limit: 1.0,
		})
		.expect_err("missing path should fail");
		assert!(
			missing_error
				.to_string()
				.contains("Failed to read directory")
		);
		assert!(
			!missing_error
				.to_string()
				.contains(&missing.to_string_lossy().to_string())
		);

		let file_error = read_dir_limited_sync(ReadDirLimitedOptions {
			path:  file.to_string_lossy().into_owned(),
			limit: 1.0,
		})
		.expect_err("file path should fail");
		assert!(file_error.to_string().contains("Failed to read directory"));
		assert!(
			!file_error
				.to_string()
				.contains(&file.to_string_lossy().to_string())
		);
	}

	#[test]
	fn never_returns_recursive_children() {
		let root = TempDir::new("pi-read-dir-limited");
		let nested = root.path().join("nested");
		fs::create_dir(&nested).expect("create nested directory");
		fs::write(nested.join("child.txt"), "child").expect("write nested child");

		let result = read_dir_names(root.path(), 8);
		let names: Vec<_> = result.entries.into_iter().map(|entry| entry.name).collect();
		assert_eq!(names, vec!["nested".to_string()]);
	}

	#[test]
	fn repeated_calls_do_not_hold_directory_handles() {
		let root = TempDir::new("pi-read-dir-limited");
		fs::write(root.path().join("alpha.txt"), "alpha").expect("write alpha");

		for _ in 0..32 {
			let result = read_dir_names(root.path(), 1);
			assert_eq!(result.entries.len(), 1);
		}

		fs::remove_file(root.path().join("alpha.txt")).expect("remove file after repeated reads");
	}

	struct CountingIterator {
		next_value: usize,
		total:      usize,
		observed:   Rc<Cell<usize>>,
	}

	impl Iterator for CountingIterator {
		type Item = std::result::Result<usize, &'static str>;

		fn next(&mut self) -> Option<Self::Item> {
			if self.next_value >= self.total {
				return None;
			}
			let current = self.next_value;
			self.next_value += 1;
			self.observed.set(self.observed.get() + 1);
			Some(Ok(current))
		}
	}

	#[test]
	fn iterator_core_observes_at_most_limit_plus_one_entries() {
		let observed = Rc::new(Cell::new(0));
		let iterator =
			CountingIterator { next_value: 0, total: 50, observed: observed.clone() };
		let (values, truncated) =
			consume_limited_results(iterator, 3, Ok).expect("iterator core should succeed");

		assert_eq!(values, vec![0, 1, 2]);
		assert!(truncated);
		assert_eq!(observed.get(), 4);
	}

	#[test]
	fn iterator_core_does_not_convert_the_lookahead_entry() {
		let values = [Ok::<_, &'static str>("alpha"), Ok("invalid")];
		let (values, truncated) = consume_limited_results(values.into_iter(), 1, |value| {
			if value == "invalid" {
				return Err("lookahead should not be converted");
			}
			Ok(value)
		})
		.expect("lookahead should only detect truncation");

		assert_eq!(values, vec!["alpha"]);
		assert!(truncated);
	}

	#[test]
	fn iterator_core_treats_a_lookahead_error_as_truncation() {
		let values = [Ok::<_, &'static str>("alpha"), Err("lookahead read failed")];
		let (values, truncated) = consume_limited_results(values.into_iter(), 1, Ok)
			.expect("lookahead errors are not part of the page");

		assert_eq!(values, vec!["alpha"]);
		assert!(truncated);
	}

	#[test]
	fn iterator_core_still_rejects_errors_inside_the_returned_page() {
		let iterator_error = [Err::<&str, _>("page read failed")];
		assert_eq!(
			consume_limited_results(iterator_error.into_iter(), 1, Ok),
			Err("page read failed")
		);

		let conversion_error = [Ok::<_, &'static str>("invalid")];
		assert_eq!(
			consume_limited_results(conversion_error.into_iter(), 1, |_| {
				Err::<&str, _>("page conversion failed")
			}),
			Err("page conversion failed")
		);
	}

	#[cfg(all(unix, not(target_os = "macos")))]
	#[test]
	fn invalid_utf8_entry_uses_a_fixed_error_message() {
		use std::os::unix::ffi::OsStringExt;

		let root = TempDir::new("pi-read-dir-limited");
		let invalid_name = std::ffi::OsString::from_vec(vec![0xff, b'.', b't', b's']);
		fs::File::create(root.path().join(invalid_name)).expect("create invalid utf8 entry");

		let err = read_dir_limited_sync(ReadDirLimitedOptions {
			path:  root.path().to_string_lossy().into_owned(),
			limit: 1.0,
		})
		.expect_err("invalid utf8 entry should fail");

		assert_eq!(err.reason, super::INVALID_UTF8_ENTRY_REASON);
	}
}
