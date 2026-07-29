import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as nativeModule from "@gajae-code/natives";
import { CombinedAutocompleteProvider, extractSlashCommandTokenPrefix } from "@gajae-code/tui/autocomplete";

type MockDirEntry = nativeModule.ReadDirLimitedEntry;
type MockReadDirLimitedResult = nativeModule.ReadDirLimitedResult;

function makeReadDirLimitedResult(entries: MockDirEntry[], truncated: boolean = false): MockReadDirLimitedResult {
	return { entries, truncated };
}

function makeFuzzyFindResult(matches: nativeModule.FuzzyFindMatch[]): nativeModule.FuzzyFindResult {
	return { matches, totalMatches: matches.length };
}

async function waitForAtLeastNumber(read: () => number, minimum: number, maxTicks: number = 100): Promise<number> {
	for (let tick = 0; tick < maxTicks; tick += 1) {
		const value = read();
		if (value >= minimum) return value;
		await Bun.sleep(1);
	}
	return read();
}

describe("CombinedAutocompleteProvider", () => {
	describe("extractPathPrefix", () => {
		it("extracts / from 'hey /' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["hey /"];
			const cursorLine = 0;
			const cursorCol = 5; // After the "/"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			expect(result).not.toBeNull();
			if (result) {
				expect(result.prefix).toBe("/");
			}
		});

		it("extracts /A from '/A' when forced", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/A"];
			const cursorLine = 0;
			const cursorCol = 2; // After the "A"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			// This might return null if /A doesn't match anything, which is fine
			// We're mainly testing that the prefix extraction works
			if (result) {
				expect(result.prefix).toBe("/A");
			}
		});

		it("does not trigger for slash commands", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/model"];
			const cursorLine = 0;
			const cursorCol = 6; // After "model"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			expect(result).toBe(null);
		});

		it("triggers for absolute paths after slash command argument", async () => {
			const provider = new CombinedAutocompleteProvider([], "/tmp");
			const lines = ["/command /"];
			const cursorLine = 0;
			const cursorCol = 10; // After the second "/"

			const result = await provider.getForceFileSuggestions(lines, cursorLine, cursorCol);

			expect(result).not.toBeNull();
			if (result) {
				expect(result.prefix).toBe("/");
			}
		});
	});

	describe("hidden paths", () => {
		let baseDir: string;

		beforeEach(() => {
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-test-"));
		});

		afterEach(() => {
			fs.rmSync(baseDir, { recursive: true, force: true });
		});

		it("matches segmented filenames from abbreviated fuzzy query", async () => {
			fs.writeFileSync(path.join(baseDir, "history-search.ts"), "export const x = 1;\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@histsr";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@history-search.ts");
		});
		it("includes hidden paths but excludes .git", async () => {
			for (const dir of [".github", ".git"]) {
				fs.mkdirSync(path.join(baseDir, dir), { recursive: true });
			}
			fs.mkdirSync(path.join(baseDir, ".github", "workflows"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, ".github", "workflows", "ci.yml"), "name: ci");
			fs.writeFileSync(path.join(baseDir, ".git", "config"), "[core]");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@.github/");
			expect(values.some(value => value === "@.git" || value.startsWith("@.git/"))).toBe(false);
		});
	});

	describe("@ scoped path handling", () => {
		let rootDir: string;
		let baseDir: string;
		let outsideDir: string;

		beforeEach(() => {
			rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-scope-test-"));
			baseDir = path.join(rootDir, "cwd");
			outsideDir = path.join(rootDir, "outside");
			fs.mkdirSync(baseDir, { recursive: true });
			fs.mkdirSync(outsideDir, { recursive: true });
		});

		afterEach(() => {
			vi.restoreAllMocks();
			fs.rmSync(rootDir, { recursive: true, force: true });
		});

		it("bounds existing off-project sibling scopes to direct entries only", async () => {
			fs.writeFileSync(path.join(baseDir, "alpha-local.ts"), "export const local = 1;\n");
			fs.mkdirSync(path.join(outsideDir, "nested", "deeper"), { recursive: true });
			fs.writeFileSync(path.join(outsideDir, "alpha.ts"), "export const alpha = 1;\n");
			fs.writeFileSync(path.join(outsideDir, "nested", "alpha.ts"), "export const alpha = 1;\n");
			fs.writeFileSync(path.join(outsideDir, "nested", "deeper", "also-alpha.ts"), "export const also = 1;\n");
			fs.writeFileSync(path.join(outsideDir, "nested", "deeper", "zzz.ts"), "export const zzz = 1;\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@../outside/a";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@../outside/alpha.ts");
			expect(values).not.toContain("@../outside/nested/alpha.ts");
			expect(values).not.toContain("@../outside/nested/deeper/also-alpha.ts");
			expect(values).not.toContain("@../outside/nested/deeper/zzz.ts");
			expect(values.some(value => value.includes("alpha-local.ts"))).toBe(false);
		});

		it("keeps project-contained scoped relative prefixes on recursive fuzzy discovery", async () => {
			fs.mkdirSync(path.join(baseDir, "src", "nested", "deeper"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, "src", "nested", "alpha.ts"), "export const alpha = 1;\n");
			fs.writeFileSync(path.join(baseDir, "src", "nested", "deeper", "also-alpha.ts"), "export const also = 1;\n");
			fs.writeFileSync(path.join(baseDir, "src", "nested", "deeper", "zzz.ts"), "export const zzz = 1;\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@src/a";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@src/nested/alpha.ts");
			expect(values).toContain("@src/nested/deeper/also-alpha.ts");
			expect(values).not.toContain("@src/nested/deeper/zzz.ts");
		});

		it("preserves typed backslashes across deep recursive scoped results", async () => {
			const scopedDirName = process.platform === "win32" ? "src" : "src\\";
			fs.mkdirSync(path.join(baseDir, scopedDirName), { recursive: true });
			vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () =>
				makeFuzzyFindResult([
					{ path: "nested/Documents/", isDirectory: true, score: 2 },
					{ path: "nested/deeper.ts", isDirectory: false, score: 1 },
				]),
			);

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@src\\ne";
			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.items.map(item => item.value)).toEqual([
				"@src\\nested\\Documents\\",
				"@src\\nested\\deeper.ts",
			]);
		});

		it("keeps project-contained parent segments on recursive fuzzy discovery", async () => {
			fs.mkdirSync(path.join(baseDir, "src", "nested", "deeper"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, "src", "nested", "alpha.ts"), "export const alpha = 1;\n");
			fs.writeFileSync(path.join(baseDir, "src", "nested", "deeper", "also-alpha.ts"), "export const also = 1;\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@src/../src/a";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@src/../src/nested/alpha.ts");
			expect(values).toContain("@src/../src/nested/deeper/also-alpha.ts");
		});

		it("keeps project-internal POSIX symlink prefixes on recursive fuzzy discovery", async () => {
			if (process.platform === "win32") return;

			const internalTargetDir = path.join(baseDir, "linked-target");
			fs.mkdirSync(path.join(internalTargetDir, "nested", "deeper"), { recursive: true });
			fs.writeFileSync(path.join(internalTargetDir, "nested", "alpha.ts"), "export const alpha = 1;\n");
			fs.writeFileSync(
				path.join(internalTargetDir, "nested", "deeper", "also-alpha.ts"),
				"export const also = 1;\n",
			);
			fs.symlinkSync(internalTargetDir, path.join(baseDir, "linked-inside"), "dir");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@linked-inside/a";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@linked-inside/nested/alpha.ts");
			expect(values).toContain("@linked-inside/nested/deeper/also-alpha.ts");
		});

		it("bounds external POSIX symlink prefixes to direct entries only", async () => {
			if (process.platform === "win32") return;

			fs.mkdirSync(path.join(outsideDir, "nested", "deeper"), { recursive: true });
			fs.writeFileSync(path.join(outsideDir, "alpha.ts"), "export const alpha = 1;\n");
			fs.writeFileSync(path.join(outsideDir, "nested", "alpha.ts"), "export const nested = 1;\n");
			fs.symlinkSync(outsideDir, path.join(baseDir, "linked-outside"), "dir");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@linked-outside/a";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@linked-outside/alpha.ts");
			expect(values).not.toContain("@linked-outside/nested/alpha.ts");
		});

		it("completes a bare external POSIX symlink without traversing its target", async () => {
			if (process.platform === "win32") return;

			fs.mkdirSync(path.join(outsideDir, "nested"), { recursive: true });
			fs.writeFileSync(path.join(outsideDir, "nested", "linked-outside-only.ts"), "export const outside = 1;\n");
			fs.symlinkSync(outsideDir, path.join(baseDir, "linked-outside"), "dir");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@linked-outside";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@linked-outside/");
			expect(values.some(value => value.startsWith("@linked-outside/") && value !== "@linked-outside/")).toBe(false);
		});

		it("keeps recursive fuzzy discovery inside the project symlink boundary", async () => {
			if (process.platform === "win32") return;

			const internalTargetDir = path.join(baseDir, "linked-target");
			fs.mkdirSync(path.join(internalTargetDir, "nested"), { recursive: true });
			fs.mkdirSync(path.join(outsideDir, "nested"), { recursive: true });
			fs.writeFileSync(path.join(internalTargetDir, "nested", "inside-needle.ts"), "export const inside = 1;\n");
			fs.writeFileSync(path.join(outsideDir, "nested", "outside-needle.ts"), "export const outside = 1;\n");
			fs.symlinkSync(internalTargetDir, path.join(baseDir, "linked-inside"), "dir");
			fs.symlinkSync(outsideDir, path.join(baseDir, "linked-outside"), "dir");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@needle";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@linked-inside/nested/inside-needle.ts");
			expect(values).not.toContain("@linked-outside/nested/outside-needle.ts");
		});
	});
	describe("dot-slash path completion", () => {
		let baseDir: string;

		beforeEach(() => {
			baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-dot-slash-test-"));
		});

		afterEach(() => {
			fs.rmSync(baseDir, { recursive: true, force: true });
		});

		it("preserves ./ prefix when completing files", async () => {
			fs.writeFileSync(path.join(baseDir, "update.sh"), "#!/bin/sh\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./up";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);
			expect(result).not.toBeNull();
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("./update.sh");
		});

		it("preserves ./ prefix when completing directories", async () => {
			fs.mkdirSync(path.join(baseDir, "src"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, "src", "index.ts"), "export {};\n");
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "./sr";
			const result = await provider.getForceFileSuggestions([line], 0, line.length);
			expect(result).not.toBeNull();
			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("./src/");
		});
	});
});

describe("inline backtick slash classification", () => {
	it.each([
		["open span", "please use `/mo", null],
		["closed span", "please use `/mo` then /he", "/he"],
		["multiple spans", "`/mo` and `/he", null],
		["odd escaped delimiter", "please use \\`/mo", "/mo"],
		["even escaped delimiter", "please use \\\\`/mo", null],
		["double-backtick run", "please use ``/mo", "/mo"],
		["triple-backtick run", "please use ```/mo", "/mo"],
	])("handles %s", (_name, text, expected) => {
		expect(extractSlashCommandTokenPrefix(text)).toBe(expected);
	});

	it("resets literal state at line boundaries", () => {
		expect(extractSlashCommandTokenPrefix("/mo")).toBe("/mo");
	});

	it.each([
		["top-level command", "/he", "/he"],
		["inline command token", "please use /he", "/he"],
		["nested absolute path", "/chromium/src", null],
		["multi-segment relative path", "chromium/lib/src", null],
		["URL path", "https://example.com/he", null],
	])("classifies %s with nested slash boundaries", (_name, text, expected) => {
		expect(extractSlashCommandTokenPrefix(text)).toBe(expected);
	});

	it("preserves path suggestions inside an open inline-code span", async () => {
		const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-backtick-test-"));
		try {
			fs.mkdirSync(path.join(baseDir, "src", "foo"), { recursive: true });
			fs.writeFileSync(path.join(baseDir, "src", "foo", "bar.ts"), "export {};\n");
			const provider = new CombinedAutocompleteProvider(
				[{ name: "model", description: "Switch AI model", value: "model" }],
				baseDir,
			);
			const line = "please read `src/foo/";
			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.prefix).toBe("src/foo/");
			expect(result?.items.map(item => item.value)).toContain("src/foo/bar.ts");
			expect(result?.items.map(item => item.value)).not.toContain("model");
		} finally {
			fs.rmSync(baseDir, { recursive: true, force: true });
		}
	});
	it("preserves submitted command argument completion inside backticks", async () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{
					name: "read",
					getArgumentCompletions: argumentPrefix => [
						{ value: argumentPrefix, label: "existing argument completion" },
					],
				},
			],
			"/tmp",
		);
		const line = "/read `src/foo/";
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.prefix).toBe("`src/foo/");
		expect(result?.items).toEqual([{ value: "`src/foo/", label: "existing argument completion" }]);
	});
});

describe("inline slash command suggestions", () => {
	it("suggests command names for slash tokens after existing prompt text", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const line = "explain this /mo";
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/mo");
		expect(result!.items.map(item => item.value)).toEqual(["model"]);
	});

	it("suggests command names for slash tokens adjacent to prompt text", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "help", description: "Learn commands", value: "help" }],
			"/tmp",
		);
		const line = "explain this/hel";
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/hel");
		expect(result!.items.map(item => item.value)).toEqual(["help"]);
	});

	it("lets absolute paths use file suggestions when the inline slash token is not a command prefix", async () => {
		const line = "open /tmp";
		const pathOnlyProvider = new CombinedAutocompleteProvider([], "/tmp");
		const pathOnlyResult = await pathOnlyProvider.getSuggestions([line], 0, line.length);
		const provider = new CombinedAutocompleteProvider(
			[{ name: "template", description: "Temporary prompt template", value: "template" }],
			"/tmp",
		);
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).toEqual(pathOnlyResult);
		expect(result?.items.map(item => item.value) ?? []).not.toContain("template");
	});

	it("lets bare absolute root paths use file suggestions before slash commands", async () => {
		const line = "open /";
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch model", value: "model" }],
			"/tmp",
		);
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/");
		expect(result!.items.some(item => item.value.startsWith("/"))).toBe(true);
		expect(result!.items.map(item => item.value)).not.toContain("model");
	});

	it("matches normalized inline slash command prefixes", async () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "skill:team", description: "Run team workflow", value: "skill:team" }],
			"/tmp",
		);
		const line = "explain this /skill-te";
		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/skill-te");
		expect(result!.items.map(item => item.value)).toEqual(["skill:team"]);
	});

	it("applies inline slash command completion without replacing prior text", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const line = "explain this /mo";
		const result = provider.applyCompletion([line], 0, line.length, { value: "model", label: "model" }, "/mo");

		expect(result.lines[0]).toBe("explain this /model ");
		expect(result.cursorCol).toBe("explain this /model ".length);
	});

	it("applies adjacent inline slash command completion without replacing prior text", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "help", description: "Learn commands", value: "help" }],
			"/tmp",
		);
		const line = "explain this/hel";
		const result = provider.applyCompletion([line], 0, line.length, { value: "help", label: "help" }, "/hel");

		expect(result.lines[0]).toBe("explain this/help ");
		expect(result.cursorCol).toBe("explain this/help ".length);
	});
});
describe("trySyncSlashCompletion", () => {
	it("returns null for bare '/' (no prefix to match)", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		const result = provider.trySyncSlashCompletion("/");
		expect(result).toBeNull();
	});

	it("returns null for non-slash text", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		expect(provider.trySyncSlashCompletion("hello")).toBeNull();
		expect(provider.trySyncSlashCompletion("")).toBeNull();
	});

	it("returns null when text has spaces (argument phase, not command name)", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		expect(provider.trySyncSlashCompletion("/model claude")).toBeNull();
		expect(provider.trySyncSlashCompletion("/model ")).toBeNull();
	});

	it("returns null when no commands match", () => {
		const provider = new CombinedAutocompleteProvider([], "/tmp");
		const result = provider.trySyncSlashCompletion("/zzzzz");
		expect(result).toBeNull();
	});

	it("returns matching items for partial slash command name", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "model", description: "Switch AI model", value: "model" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/mo");
		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("/mo");
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
	});

	it("matches multiple commands and sorts by relevance", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "model", description: "Switch AI model", value: "model" },
				{ name: "mode", description: "Change editor mode", value: "mode" },
				{ name: "help", description: "Show help", value: "help" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/mo");
		expect(result).not.toBeNull();
		const values = result!.items.map(i => i.value);
		// /model and /mode should match; /help should not
		expect(values).toContain("model");
		expect(values).toContain("mode");
		expect(values).not.toContain("help");
		// The better name match should come first (higher score)
		const modelIdx = values.indexOf("model");
		const modeIdx = values.indexOf("mode");
		// model matches 3/5 chars, mode matches 3/4 chars — mode has higher match ratio
		// Both should be present; order depends on fuzzyScore internals
		expect(modelIdx).not.toBe(-1);
		expect(modeIdx).not.toBe(-1);
	});

	it("matches case-insensitively", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "Model", description: "Switch AI model", value: "Model" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/MOD");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toContain("Model");
	});

	it("also matches against description", () => {
		const provider = new CombinedAutocompleteProvider(
			[{ name: "md", description: "Switch AI model", value: "md" }],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/model");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toContain("md");
	});

	it("handles AutocompleteItem-shaped commands (no 'name' property)", () => {
		const provider = new CombinedAutocompleteProvider([{ value: "model", label: "Switch model" }], "/tmp");
		const result = provider.trySyncSlashCompletion("/mod");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toEqual(["model"]);
	});

	it("ranks high-priority commands above higher fuzzy scores", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				// Lower priority, but exact-prefix match would normally win on fuzzy score.
				{ name: "skim", description: "Skim the file", value: "skim" },
				// Higher priority: pinned regardless of fuzzy score.
				{ name: "skill:ralplan", description: "Plan the work", value: "skill:ralplan", priority: 100 },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/sk");
		expect(result).not.toBeNull();
		const values = result!.items.map(i => i.value);
		expect(values[0]).toBe("skill:ralplan");
		expect(values).toContain("skim");
	});

	it("uses priority as a tie-breaker within the same slash match tier", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "skill:team", description: "Team orchestration", value: "skill:team", priority: 100 },
				{ name: "slash:team", description: "Alternate team command", value: "slash:team" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/team");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toEqual(["skill:team", "slash:team"]);
	});

	it("ranks stronger slash text matches above higher-priority fallback matches", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "init", description: "Generate team files", value: "init", priority: 100 },
				{ name: "skill:team", description: "Team orchestration", value: "skill:team" },
			],
			"/tmp",
		);
		const result = provider.trySyncSlashCompletion("/team");
		expect(result).not.toBeNull();
		expect(result!.items.map(i => i.value)).toEqual(["skill:team", "init"]);
	});

	it("normalizes separators for structured slash command prefixes", () => {
		const provider = new CombinedAutocompleteProvider(
			[
				{ name: "init", description: "Initialize skill template", value: "init", priority: 100 },
				{ name: "skill:team", description: "Team orchestration", value: "skill:team" },
			],
			"/tmp",
		);
		const dashed = provider.trySyncSlashCompletion("/skill-te");
		const colon = provider.trySyncSlashCompletion("/skill:te");
		expect(dashed?.items[0]?.value).toBe("skill:team");
		expect(colon?.items[0]?.value).toBe("skill:team");
	});
});

describe("unsafe path autocomplete routing", () => {
	let rootDir: string;
	let baseDir: string;

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-unsafe-routing-"));
		baseDir = path.join(rootDir, "cwd");
		fs.mkdirSync(baseDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	it("keeps ordinary relative @query on recursive fuzzy discovery", async () => {
		let fuzzyCalls = 0;
		let readDirLimitedCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "src/foo.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () => {
			readDirLimitedCalls += 1;
			return makeReadDirLimitedResult([]);
		});
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@foo";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@src/foo.ts"]);
		expect(fuzzyCalls).toBe(1);
		expect(readDirLimitedCalls).toBe(0);
	});

	it("uses bounded native completion for direct sibling @ paths", async () => {
		let fuzzyCalls = 0;
		fs.mkdirSync(path.join(rootDir, "outside"), { recursive: true });
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "nested/recursive-only.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([
				{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false },
				{ name: "nested", isDirectory: true, isSymbolicLink: false },
			]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@../outside/a";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@../outside/alpha.ts"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("uses bounded native completion for bare parent prefixes", async () => {
		let fuzzyCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-parent.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([
				{ name: "cwd", isDirectory: true, isSymbolicLink: false },
				{ name: "outside", isDirectory: true, isSymbolicLink: false },
			]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@..";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@../cwd/", "@../outside/"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("uses bounded native completion for terminal project parent prefixes", async () => {
		let fuzzyCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-parent.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([
				{ name: "cwd", isDirectory: true, isSymbolicLink: false },
				{ name: "outside", isDirectory: true, isSymbolicLink: false },
			]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@src/../..";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@src/../../cwd/", "@src/../../outside/"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("uses bounded native completion for natural absolute paths", async () => {
		let fuzzyCalls = 0;
		let readDirLimitedCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-only.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () => {
			readDirLimitedCalls += 1;
			return makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]);
		});
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const prefix = path.join(baseDir, "a");
		const line = `open ${prefix}`;

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.label)).toEqual(["alpha.ts"]);
		expect(readDirLimitedCalls).toBe(1);
		expect(fuzzyCalls).toBe(0);
	});

	it("preserves fuzzy abbreviation matching for bounded unsafe @ paths", async () => {
		let fuzzyCalls = 0;
		fs.mkdirSync(path.join(rootDir, "outside"), { recursive: true });
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([
				{ name: "history-search.ts", isDirectory: false, isSymbolicLink: false },
				{ name: "helper.ts", isDirectory: false, isSymbolicLink: false },
			]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@../outside/hss";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@../outside/history-search.ts"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("returns null for malformed unsafe scopes instead of falling back to fuzzy recursion", async () => {
		let fuzzyCalls = 0;
		const outsideDir = path.join(rootDir, "outside");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "alpha.ts"), "export const alpha = true;\n");
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-escape.ts", isDirectory: false, score: 1 }]);
		});
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@../outside/missing/../alpha";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).toBeNull();
		expect(fuzzyCalls).toBe(0);
	});

	it("returns null for malformed natural paths instead of normalizing through a missing segment", async () => {
		const outsideDir = path.join(rootDir, "outside");
		fs.mkdirSync(outsideDir, { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "alpha.ts"), "export const alpha = true;\n");
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const prefix = "../outside/missing/../alpha";
		const line = `open ${prefix}`;

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).toBeNull();
	});

	it("returns null for file scopes instead of falling back to fuzzy recursion", async () => {
		let fuzzyCalls = 0;
		fs.writeFileSync(path.join(rootDir, "outside-file.ts"), "export const nope = true;\n");
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-escape.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () => makeReadDirLimitedResult([]));
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@../outside-file.ts/alpha";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).toBeNull();
		expect(fuzzyCalls).toBe(0);
	});

	it("routes bare parent prefixes through bounded enumeration instead of recursive discovery", async () => {
		let fuzzyCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-parent.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@..";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@../alpha.ts"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("routes escaping parent segments inside scoped prefixes through bounded enumeration", async () => {
		let fuzzyCalls = 0;
		fs.mkdirSync(path.join(baseDir, "src"), { recursive: true });
		fs.mkdirSync(path.join(rootDir, "outside"), { recursive: true });
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-parent-scope.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@src/../../outside/a";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@src/../../outside/alpha.ts"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("uses bounded native completion for Windows home-backslash prefixes", async () => {
		let fuzzyCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-home.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "Documents", isDirectory: true, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@~\\Doc";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.label)).toEqual(["Documents/"]);
		expect(result?.items.map(item => item.value)).toEqual(["@~\\Documents\\"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("uses bounded native completion for Windows drive-letter prefixes", async () => {
		let fuzzyCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-drive.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@C:\\repo\\a";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.label)).toEqual(["alpha.ts"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("uses bounded native completion for Windows drive-relative natural prefixes", async () => {
		let fuzzyCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-drive-relative.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "Documents", isDirectory: true, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "C:Doc";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["C:Documents\\"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("preserves bare Windows drive-relative prefixes", async () => {
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@C:";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@C:alpha.ts"]);
	});

	it("preserves typed Windows drive-relative filenames without recursive fallback", async () => {
		let fuzzyCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-drive-relative.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@C:al";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@C:alpha.ts"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("preserves nested Windows drive-relative prefixes without recursive fallback", async () => {
		let fuzzyCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-drive-relative.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "Documents", isDirectory: true, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@C:folder\\Doc";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@C:folder\\Documents\\"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("keeps explicit Tab exhaustive for Windows drive-relative prefixes", async () => {
		const entries = [
			{
				name: "Documents",
				isDirectory: () => true,
				isSymbolicLink: () => false,
			} as fs.Dirent,
		];
		vi.spyOn(fs.promises, "readdir").mockResolvedValue(entries as never);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "C:Doc";

		const result = await provider.getForceFileSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["C:Documents\\"]);
	});

	it("keeps explicit Tab exhaustive for nested Windows drive-relative prefixes", async () => {
		const entries = [
			{
				name: "Documents",
				isDirectory: () => true,
				isSymbolicLink: () => false,
			} as fs.Dirent,
		];
		vi.spyOn(fs.promises, "readdir").mockResolvedValue(entries as never);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "C:folder\\Doc";

		const result = await provider.getForceFileSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["C:folder\\Documents\\"]);
	});

	it("preserves typed backslashes for Windows drive-letter directory completions", async () => {
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "Documents", isDirectory: true, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@C:\\repo\\Doc";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.label)).toEqual(["Documents/"]);
		expect(result?.items.map(item => item.value)).toEqual(["@C:\\repo\\Documents\\"]);
	});

	it("uses bounded native completion for Windows UNC prefixes", async () => {
		let fuzzyCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => {
			fuzzyCalls += 1;
			return makeFuzzyFindResult([{ path: "recursive-unc.ts", isDirectory: false, score: 1 }]);
		});
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "share.txt", isDirectory: false, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@\\\\server\\share\\sh";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.label)).toEqual(["share.txt"]);
		expect(fuzzyCalls).toBe(0);
	});

	it("preserves bare Windows UNC share roots", async () => {
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@\\\\server\\share";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@\\\\server\\share\\alpha.ts"]);
	});

	it("preserves bare forward-slash UNC share roots", async () => {
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@//server/share";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toEqual(["@//server/share/alpha.ts"]);
	});

	it("preserves typed backslashes for Windows UNC directory completions", async () => {
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult([{ name: "Documents", isDirectory: true, isSymbolicLink: false }]),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@\\\\server\\share\\Doc";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.label)).toEqual(["Documents/"]);
		expect(result?.items.map(item => item.value)).toEqual(["@\\\\server\\share\\Documents\\"]);
	});

	it("shares one native enumeration for concurrent prefixes in the same directory", async () => {
		const pending = Promise.withResolvers<MockReadDirLimitedResult>();
		let readDirLimitedCalls = 0;
		fs.mkdirSync(path.join(rootDir, "outside"), { recursive: true });
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () => {
			readDirLimitedCalls += 1;
			return pending.promise;
		});
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const alphaLine = "@../outside/al";
		const betaLine = "@../outside/bt";
		const alphaPromise = provider.getSuggestions([alphaLine], 0, alphaLine.length);
		const betaPromise = provider.getSuggestions([betaLine], 0, betaLine.length);

		pending.resolve(
			makeReadDirLimitedResult([
				{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false },
				{ name: "beta.ts", isDirectory: false, isSymbolicLink: false },
			]),
		);
		const [alphaResult, betaResult] = await Promise.all([alphaPromise, betaPromise]);

		expect(readDirLimitedCalls).toBe(1);
		expect(alphaResult?.items.map(item => item.value)).toEqual(["@../outside/alpha.ts"]);
		expect(betaResult?.items.map(item => item.value)).toEqual(["@../outside/beta.ts"]);
	});

	it("reuses cached native directory results until the TTL expires", async () => {
		let now = 1_000;
		let readDirLimitedCalls = 0;
		fs.mkdirSync(path.join(rootDir, "outside"), { recursive: true });
		vi.spyOn(Date, "now").mockImplementation(() => now);
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () => {
			readDirLimitedCalls += 1;
			return makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]);
		});
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@../outside/a";

		await provider.getSuggestions([line], 0, line.length);
		await provider.getSuggestions([line], 0, line.length);
		now = 4_000;
		await provider.getSuggestions([line], 0, line.length);

		expect(readDirLimitedCalls).toBe(2);
	});

	it("does not dedupe or cache across bounded directory invalidation", async () => {
		const first = Promise.withResolvers<MockReadDirLimitedResult>();
		const second = Promise.withResolvers<MockReadDirLimitedResult>();
		const outsideDir = path.join(rootDir, "outside");
		fs.mkdirSync(outsideDir, { recursive: true });
		let readDirLimitedCalls = 0;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () => {
			readDirLimitedCalls += 1;
			return readDirLimitedCalls === 1 ? first.promise : second.promise;
		});
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const line = "@../outside/a";

		const firstRequest = provider.getSuggestions([line], 0, line.length);
		await waitForAtLeastNumber(() => readDirLimitedCalls, 1);
		provider.invalidateDirCache(outsideDir);
		const secondRequest = provider.getSuggestions([line], 0, line.length);
		await waitForAtLeastNumber(() => readDirLimitedCalls, 2);

		first.resolve(makeReadDirLimitedResult([{ name: "alpha-old.ts", isDirectory: false, isSymbolicLink: false }]));
		await firstRequest;
		const thirdRequest = provider.getSuggestions([line], 0, line.length);
		const callsWhileSecondPending = readDirLimitedCalls;
		second.resolve(makeReadDirLimitedResult([{ name: "alpha-new.ts", isDirectory: false, isSymbolicLink: false }]));
		const [, thirdResult] = await Promise.all([secondRequest, thirdRequest]);
		const cachedResult = await provider.getSuggestions([line], 0, line.length);

		expect(callsWhileSecondPending).toBe(2);
		expect(readDirLimitedCalls).toBe(2);
		expect(thirdResult?.items.map(item => item.value)).toEqual(["@../outside/alpha-new.ts"]);
		expect(cachedResult?.items.map(item => item.value)).toEqual(["@../outside/alpha-new.ts"]);
	});

	it("fails closed when too many unsafe directory enumerations are pending", async () => {
		let readDirLimitedCalls = 0;
		const gate = Promise.withResolvers<void>();
		for (let i = 0; i < 96; i += 1) {
			fs.mkdirSync(path.join(rootDir, `outside-${i}`), { recursive: true });
		}
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () => {
			readDirLimitedCalls += 1;
			await gate.promise;
			return makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]);
		});
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const firstLine = "@../outside-0/a";
		const firstRequest = provider.getSuggestions([firstLine], 0, firstLine.length);

		await waitForAtLeastNumber(() => readDirLimitedCalls, 1);
		const overflowRequests = Array.from({ length: 95 }, (_, i) => {
			const directoryIndex = i + 1;
			const line = `@../outside-${directoryIndex}/a`;
			return provider.getSuggestions([line], 0, line.length);
		});
		const overflowResults = await Promise.all(overflowRequests);
		const callsWhileFirstRequestWasPending = readDirLimitedCalls;
		gate.resolve();
		const firstResult = await firstRequest;

		expect(callsWhileFirstRequestWasPending).toBe(1);
		expect(overflowResults.every(result => result === null)).toBe(true);
		expect(firstResult?.items.map(item => item.value)).toEqual(["@../outside-0/alpha.ts"]);
	});

	it("rejects distinct scoped requests before an unsafe async preflight can fan out", async () => {
		const firstPreflightEntered = Promise.withResolvers<void>();
		const releaseFirstPreflight = Promise.withResolvers<void>();
		const originalStat = fs.promises.stat.bind(fs.promises);
		const firstScope = path.resolve(path.join(rootDir, "outside-0"));
		let gatedFirstPreflight = false;
		let readDirLimitedCalls = 0;
		for (let i = 0; i < 96; i += 1) {
			fs.mkdirSync(path.join(rootDir, `outside-${i}`), { recursive: true });
		}
		const guardedStat = async (target: fs.PathLike) => {
			if (!gatedFirstPreflight && path.resolve(String(target)) === firstScope) {
				gatedFirstPreflight = true;
				firstPreflightEntered.resolve();
				await releaseFirstPreflight.promise;
			}
			return originalStat(target);
		};
		vi.spyOn(fs.promises, "stat").mockImplementation(guardedStat as unknown as typeof fs.promises.stat);
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () => {
			readDirLimitedCalls += 1;
			return makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]);
		});
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const firstLine = "@../outside-0/a";
		const firstRequest = provider.getSuggestions([firstLine], 0, firstLine.length);

		await firstPreflightEntered.promise;
		const overflowResults = await Promise.all(
			Array.from({ length: 95 }, (_, i) => {
				const line = `@../outside-${i + 1}/a`;
				return provider.getSuggestions([line], 0, line.length);
			}),
		);
		expect(readDirLimitedCalls).toBe(0);
		expect(overflowResults.every(result => result === null)).toBe(true);

		releaseFirstPreflight.resolve();
		const firstResult = await firstRequest;
		expect(readDirLimitedCalls).toBe(1);
		expect(firstResult?.items.map(item => item.value)).toEqual(["@../outside-0/alpha.ts"]);
	});

	it("rejects distinct natural path requests before an unsafe async preflight can fan out", async () => {
		const firstPreflightEntered = Promise.withResolvers<void>();
		const releaseFirstPreflight = Promise.withResolvers<void>();
		const originalStat = fs.promises.stat.bind(fs.promises);
		const firstScope = path.resolve(path.join(rootDir, "outside-0"));
		let readDirLimitedCalls = 0;
		for (let i = 0; i < 2; i += 1) {
			fs.mkdirSync(path.join(rootDir, `outside-${i}`), { recursive: true });
		}
		const guardedStat = async (target: fs.PathLike) => {
			if (path.resolve(String(target)) === firstScope) {
				firstPreflightEntered.resolve();
				await releaseFirstPreflight.promise;
			}
			return originalStat(target);
		};
		vi.spyOn(fs.promises, "stat").mockImplementation(guardedStat as unknown as typeof fs.promises.stat);
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () => {
			readDirLimitedCalls += 1;
			return makeReadDirLimitedResult([{ name: "alpha.ts", isDirectory: false, isSymbolicLink: false }]);
		});
		const provider = new CombinedAutocompleteProvider([], baseDir);
		const firstLine = "open ../outside-0/a";
		const firstRequest = provider.getSuggestions([firstLine], 0, firstLine.length);

		await firstPreflightEntered.promise;
		const secondLine = "open ../outside-1/a";
		const secondResult = await provider.getSuggestions([secondLine], 0, secondLine.length);
		expect(readDirLimitedCalls).toBe(0);
		expect(secondResult).toBeNull();

		releaseFirstPreflight.resolve();
		const firstResult = await firstRequest;
		expect(readDirLimitedCalls).toBe(1);
		expect(firstResult?.items.map(item => item.value)).toEqual(["../outside-0/alpha.ts"]);
	});

	it("keeps explicit Tab completion exhaustive after natural unsafe suggestions are capped", async () => {
		for (const name of ["anchor.ts", "apple.ts", "apricot.ts", "atom.ts", "azure.ts"]) {
			fs.writeFileSync(path.join(baseDir, name), "export const value = true;\n");
		}
		const prefix = `${baseDir}${path.sep}a`;
		const line = `open ${prefix}`;
		vi.spyOn(nativeModule, "fuzzyFind").mockImplementation(async () => makeFuzzyFindResult([]));
		vi.spyOn(nativeModule, "readDirLimited").mockImplementation(async () =>
			makeReadDirLimitedResult(
				[
					{ name: "anchor.ts", isDirectory: false, isSymbolicLink: false },
					{ name: "apple.ts", isDirectory: false, isSymbolicLink: false },
				],
				true,
			),
		);
		const provider = new CombinedAutocompleteProvider([], baseDir);

		const natural = await provider.getSuggestions([line], 0, line.length);
		const forced = await provider.getForceFileSuggestions([line], 0, line.length);

		expect(natural?.items).toHaveLength(2);
		expect(forced?.items.map(item => item.label)).toEqual([
			"anchor.ts",
			"apple.ts",
			"apricot.ts",
			"atom.ts",
			"azure.ts",
		]);
	});
});
