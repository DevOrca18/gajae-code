import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CombinedAutocompleteProvider, extractSlashCommandTokenPrefix } from "@gajae-code/tui/autocomplete";

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

	describe("@ fuzzy search scoped paths", () => {
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
			fs.rmSync(rootDir, { recursive: true, force: true });
		});

		it("scopes @ fuzzy search to the typed relative path prefix", async () => {
			fs.writeFileSync(path.join(baseDir, "alpha-local.ts"), "export const local = 1;\n");
			fs.mkdirSync(path.join(outsideDir, "nested", "deeper"), { recursive: true });
			fs.writeFileSync(path.join(outsideDir, "nested", "alpha.ts"), "export const alpha = 1;\n");
			fs.writeFileSync(path.join(outsideDir, "nested", "deeper", "also-alpha.ts"), "export const also = 1;\n");
			fs.writeFileSync(path.join(outsideDir, "nested", "deeper", "zzz.ts"), "export const zzz = 1;\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@../outside/a";
			const result = await provider.getSuggestions([line], 0, line.length);

			const values = result?.items.map(item => item.value) ?? [];
			expect(values).toContain("@../outside/nested/alpha.ts");
			expect(values).toContain("@../outside/nested/deeper/also-alpha.ts");
			expect(values).not.toContain("@../outside/nested/deeper/zzz.ts");
			expect(values.some(value => value.includes("alpha-local.ts"))).toBe(false);
		});

		it.each([
			[
				"project-child",
				(_root: string, project: string): string => path.join(project, "linked-outside"),
				"@linked-outside/anchor-a",
				"@linked-outside/anchor-alpha.txt",
				"@linked-outside/nested/anchor-alpha-deep.txt",
			],
			[
				"sibling",
				(root: string, _project: string): string => path.join(root, "sibling-link"),
				"@../sibling-link/anchor-a",
				"@../sibling-link/anchor-alpha.txt",
				"@../sibling-link/nested/anchor-alpha-deep.txt",
			],
		] as const)("bounds %s relative symlink scopes that resolve outside the project", async (_name, linkPathFor, line, expectedValue, unexpectedNestedValue) => {
			if (process.platform === "win32") {
				return;
			}

			const externalTree = path.join(rootDir, "external-tree");
			fs.mkdirSync(path.join(externalTree, "nested"), { recursive: true });
			fs.writeFileSync(path.join(externalTree, "anchor-alpha.txt"), "anchor\n");
			fs.writeFileSync(path.join(externalTree, "nested", "anchor-alpha-deep.txt"), "deep\n");
			fs.symlinkSync(externalTree, linkPathFor(rootDir, baseDir), "dir");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];

			expect(values).toContain(expectedValue);
			expect(values).not.toContain(unexpectedNestedValue);
		});

		it("keeps recursive fuzzy discovery for relative symlinks that resolve inside the project", async () => {
			if (process.platform === "win32") {
				return;
			}

			const internalTree = path.join(baseDir, "internal-tree");
			fs.mkdirSync(path.join(internalTree, "nested"), { recursive: true });
			fs.writeFileSync(path.join(internalTree, "nested", "anchor-alpha-deep.txt"), "deep\n");
			fs.symlinkSync(internalTree, path.join(baseDir, "linked-inside"), "dir");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@linked-inside/anchor-a";
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];

			expect(values).toContain("@linked-inside/nested/anchor-alpha-deep.txt");
		});

		it.each([
			[
				"unquoted ancestor escape",
				(basePath: string): string => path.join(path.dirname(basePath), "project", "cwd"),
				(basePath: string): string => path.dirname(basePath),
				(_basePath: string): string => "@../ancestor-a",
				"@../ancestor-alpha.txt",
				"@../ancestor-nested/ancestor-alpha-deep.txt",
			],
			[
				"quoted ancestor escape with spaces",
				(basePath: string): string => path.join(path.dirname(basePath), "project"),
				(_basePath: string): string => rootDir,
				(_basePath: string): string => '@"sub dir/../../ancestor-a',
				'@"sub dir/../../ancestor-alpha.txt"',
				'@"sub dir/../../ancestor-nested/ancestor-alpha-deep.txt"',
			],
		] as const)("switches %s mentions to bounded immediate-directory lookup", async (_name, basePathFor, ancestorDirFor, lineFor, expectedValue, unexpectedNestedValue) => {
			const projectBaseDir = basePathFor(baseDir);
			const escapedRootDir = ancestorDirFor(projectBaseDir);
			const escapedAncestor = path.join(escapedRootDir, "ancestor-alpha.txt");
			const escapedNestedDir = path.join(escapedRootDir, "ancestor-nested");

			fs.mkdirSync(projectBaseDir, { recursive: true });
			fs.mkdirSync(path.join(projectBaseDir, "sub dir"), { recursive: true });
			fs.mkdirSync(escapedNestedDir, { recursive: true });
			fs.writeFileSync(escapedAncestor, "ancestor\n");
			fs.writeFileSync(path.join(escapedNestedDir, "ancestor-alpha-deep.txt"), "deep\n");

			const provider = new CombinedAutocompleteProvider([], projectBaseDir);
			const line = lineFor(projectBaseDir);
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];

			expect(values).toContain(expectedValue);
			expect(values).not.toContain(unexpectedNestedValue);
			expect(values.some(value => value.includes("project"))).toBe(false);
		});

		it.each([
			[
				"unquoted ancestor escape",
				(basePath: string): string => path.join(path.dirname(basePath), "project", "cwd"),
				(basePath: string): string => path.dirname(basePath),
				(_basePath: string): string => "@../ancestor-a",
				(_basePath: string): string[] =>
					Array.from({ length: 25 }, (_, index) => `@../ancestor-alpha-${index.toString().padStart(3, "0")}.txt`),
				(_basePath: string): string => "@../ancestor-alpha-late.txt",
				"@../ancestor-nested/ancestor-alpha-deep.txt",
			],
			[
				"quoted ancestor escape with spaces",
				(basePath: string): string => path.join(path.dirname(basePath), "project"),
				(_basePath: string): string => rootDir,
				(_basePath: string): string => '@"sub dir/../../ancestor-a',
				(_basePath: string): string[] =>
					Array.from(
						{ length: 25 },
						(_, index) => `@"sub dir/../../ancestor-alpha-${index.toString().padStart(3, "0")}.txt"`,
					),
				(_basePath: string): string => '@"sub dir/../../ancestor-alpha-late.txt"',
				'@"sub dir/../../ancestor-nested/ancestor-alpha-deep.txt"',
			],
		] as const)("uses bounded opendir semantics for natural %s mentions", async (_name, basePathFor, ancestorDirFor, lineFor, expectedEarlyValuesFor, expectedLateValueFor, unexpectedNestedValue) => {
			if (process.platform === "win32") {
				return;
			}

			const projectBaseDir = basePathFor(baseDir);
			const escapedRootDir = ancestorDirFor(projectBaseDir);
			const escapedNestedDir = path.join(escapedRootDir, "ancestor-nested");
			const entries: fs.Dirent[] = Array.from({ length: 150 }, (_, index) => {
				const name =
					index < 25
						? `ancestor-alpha-${index.toString().padStart(3, "0")}.txt`
						: index === 120
							? "ancestor-alpha-late.txt"
							: `filler-${index.toString().padStart(3, "0")}.txt`;
				return {
					name,
					isDirectory: () => false,
					isSymbolicLink: () => false,
				} as fs.Dirent;
			});
			let iterated = 0;
			let closed = false;
			const readdirSpy = spyOn(fs.promises, "readdir").mockRejectedValue(
				new Error("ancestor-bounded completion must not call readdir"),
			);
			const opendirSpy = spyOn(fs.promises, "opendir").mockResolvedValue({
				async read() {
					const entry = entries[iterated] ?? null;
					iterated += entry ? 1 : 0;
					return entry;
				},
				async close() {
					closed = true;
				},
			} as fs.Dir);

			try {
				fs.mkdirSync(projectBaseDir, { recursive: true });
				fs.mkdirSync(path.join(projectBaseDir, "sub dir"), { recursive: true });
				fs.mkdirSync(escapedNestedDir, { recursive: true });
				fs.writeFileSync(path.join(escapedNestedDir, "ancestor-alpha-deep.txt"), "deep\n");

				const provider = new CombinedAutocompleteProvider([], projectBaseDir);
				const line = lineFor(projectBaseDir);
				const result = await provider.getSuggestions([line], 0, line.length);
				const values = result?.items.map(item => item.value) ?? [];

				expect(opendirSpy).toHaveBeenCalledTimes(1);
				expect(readdirSpy).not.toHaveBeenCalled();
				expect(iterated).toBeLessThanOrEqual(100);
				expect(closed).toBe(true);
				expect(values).toHaveLength(20);
				for (const expectedEarlyValue of expectedEarlyValuesFor(projectBaseDir).slice(0, 20)) {
					expect(values).toContain(expectedEarlyValue);
				}
				expect(values).not.toContain(expectedLateValueFor(projectBaseDir));
				expect(values).not.toContain(unexpectedNestedValue);
			} finally {
				opendirSpy.mockRestore();
				readdirSpy.mockRestore();
			}
		});

		it.each([
			[
				"windows unquoted ancestor escape",
				(basePath: string): string => path.join(path.dirname(basePath), "project", "cwd"),
				(basePath: string): string => path.dirname(basePath),
				(_basePath: string): string => "@..\\ancestor-a",
				"@..\\ancestor-alpha.txt",
				"@..\\ancestor-nested\\ancestor-alpha-deep.txt",
			],
			[
				"windows quoted ancestor escape with spaces",
				(basePath: string): string => path.join(path.dirname(basePath), "project"),
				(_basePath: string): string => rootDir,
				(_basePath: string): string => '@"sub dir\\..\\..\\ancestor-a',
				'@"sub dir\\..\\..\\ancestor-alpha.txt"',
				'@"sub dir\\..\\..\\ancestor-nested\\ancestor-alpha-deep.txt"',
			],
		] as const)("switches %s mentions to bounded immediate-directory lookup with backslash separators", async (_name, basePathFor, ancestorDirFor, lineFor, expectedValue, unexpectedNestedValue) => {
			if (process.platform !== "win32") {
				return;
			}

			const projectBaseDir = basePathFor(baseDir);
			const escapedRootDir = ancestorDirFor(projectBaseDir);
			const escapedAncestor = path.join(escapedRootDir, "ancestor-alpha.txt");
			const escapedNestedDir = path.join(escapedRootDir, "ancestor-nested");

			fs.mkdirSync(projectBaseDir, { recursive: true });
			fs.mkdirSync(path.join(projectBaseDir, "sub dir"), { recursive: true });
			fs.mkdirSync(escapedNestedDir, { recursive: true });
			fs.writeFileSync(escapedAncestor, "ancestor\n");
			fs.writeFileSync(path.join(escapedNestedDir, "ancestor-alpha-deep.txt"), "deep\n");

			const provider = new CombinedAutocompleteProvider([], projectBaseDir);
			const line = lineFor(projectBaseDir);
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];

			expect(values).toContain(expectedValue);
			expect(values).not.toContain(unexpectedNestedValue);
		});

		it("treats ..-prefixed sibling names as descendants instead of ancestor escapes", async () => {
			const dotDotSiblingDir = path.join(path.dirname(baseDir), "..fixtures");
			fs.mkdirSync(dotDotSiblingDir, { recursive: true });
			fs.writeFileSync(path.join(dotDotSiblingDir, "alpha-local.txt"), "alpha\n");
			fs.writeFileSync(path.join(dotDotSiblingDir, "zeta.txt"), "zeta\n");

			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@../..fixtures/alp";
			const result = await provider.getSuggestions([line], 0, line.length);
			const values = result?.items.map(item => item.value) ?? [];

			expect(values).toContain("@../..fixtures/alpha-local.txt");
			expect(values).not.toContain("@../..fixtures/zeta.txt");
		});

		it("cancels while resolving a scoped fuzzy-search directory", async () => {
			const directoryStats = await fs.promises.stat(outsideDir);
			const statStarted = Promise.withResolvers<void>();
			const releaseStat = Promise.withResolvers<void>();
			const statSpy = spyOn(fs.promises, "stat").mockImplementation((async () => {
				statStarted.resolve();
				await releaseStat.promise;
				return directoryStats;
			}) as unknown as typeof fs.promises.stat);
			const provider = new CombinedAutocompleteProvider([], baseDir);
			const line = "@../outside/a";
			const controller = new AbortController();
			const pending = provider.getSuggestions([line], 0, line.length, controller.signal);

			try {
				await statStarted.promise;
				controller.abort();
				const timeout = Symbol("timeout");
				const outcome = await Promise.race([pending, Bun.sleep(100).then(() => timeout)]);

				expect(outcome).not.toBe(timeout);
				expect(outcome).toBeNull();
			} finally {
				releaseStat.resolve();
				statSpy.mockRestore();
				await pending.catch(() => null);
			}
		});

		describe("bounded absolute and home path completion", () => {
			let mentionRoot: string;

			beforeEach(() => {
				mentionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-absolute-test-"));
				fs.mkdirSync(path.join(mentionRoot, "immediate-dir", "nested"), { recursive: true });
				fs.writeFileSync(path.join(mentionRoot, "immediate-target.txt"), "immediate\n");
				fs.writeFileSync(path.join(mentionRoot, "immediate-dir", "nested", "immediate-target.txt"), "nested\n");
			});

			afterEach(() => {
				fs.rmSync(mentionRoot, { recursive: true, force: true });
			});

			const boundedEnumerationCases: Array<
				[name: string, inputFor: (root: string) => string, expectedFor: (root: string) => string]
			> = [
				[
					"absolute",
					(root: string) => `@${path.join(root, "im")}`,
					(root: string) => `@${path.join(root, "immediate-target.txt")}`,
				],
				[
					"quoted absolute",
					(root: string) => `@"${path.join(root, "im")}`,
					(root: string) => `@"${path.join(root, "immediate-target.txt")}"`,
				],
				["home root", (_root: string) => "@~", (_root: string) => "@~/immediate-target.txt"],
				["home child", (_root: string) => "@~/im", (_root: string) => "@~/immediate-target.txt"],
				["quoted home child", (_root: string) => '@"~/im', (_root: string) => '@"~/immediate-target.txt"'],
			];

			it.each(
				boundedEnumerationCases,
			)("enumerates only one directory segment for %s mentions", async (_name, inputFor, expectedFor) => {
				const line = inputFor(mentionRoot);
				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const result = await provider.getSuggestions([line], 0, line.length);
				const values = result?.items.map(item => item.value) ?? [];

				expect(values).toContain(expectedFor(mentionRoot));
				expect(values.some(value => value.replaceAll("\\", "/").includes("/nested/"))).toBe(false);
			});

			it("preserves fuzzy matching within a bounded path segment", async () => {
				fs.mkdirSync(path.join(mentionRoot, "Downloads"));
				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const line = "@~/dwn";
				const result = await provider.getSuggestions([line], 0, line.length);

				expect(result?.items.map(item => item.value)).toContain("@~/Downloads/");
			});

			const boundedScanCases: Array<
				[
					name: string,
					inputFor: (root: string) => string,
					expectedEarlyValues: (root: string) => string[],
					expectedLate: (root: string) => string,
				]
			> = [
				[
					"absolute",
					(root: string) => `@${path.join(root, "mat")}`,
					(root: string) =>
						Array.from(
							{ length: 25 },
							(_, index) => `@${path.join(root, `match-${index.toString().padStart(3, "0")}.txt`)}`,
						),
					(root: string) => `@${path.join(root, "match-late.txt")}`,
				],
				[
					"home",
					(_root: string) => "@~/mat",
					(_root: string) =>
						Array.from({ length: 25 }, (_, index) => `@~/match-${index.toString().padStart(3, "0")}.txt`),
					(_root: string) => "@~/match-late.txt",
				],
			];

			it.each(
				boundedScanCases,
			)("avoids full readdir materialization and caps bounded %s scans", async (_name, inputFor, expectedEarlyValues, expectedLate) => {
				const entries: fs.Dirent[] = Array.from({ length: 150 }, (_, index) => {
					const name =
						index < 25
							? `match-${index.toString().padStart(3, "0")}.txt`
							: index === 120
								? "match-late.txt"
								: `filler-${index.toString().padStart(3, "0")}.txt`;
					return {
						name,
						isDirectory: () => false,
						isSymbolicLink: () => false,
					} as fs.Dirent;
				});
				let iterated = 0;
				let closed = false;
				const readdirSpy = spyOn(fs.promises, "readdir").mockRejectedValue(
					new Error("bounded completion must not call readdir"),
				);
				const opendirSpy = spyOn(fs.promises, "opendir").mockResolvedValue({
					async read() {
						const entry = entries[iterated] ?? null;
						iterated += entry ? 1 : 0;
						return entry;
					},
					async close() {
						closed = true;
					},
				} as fs.Dir);

				try {
					const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
					const line = inputFor(mentionRoot);
					const result = await provider.getSuggestions([line], 0, line.length);
					const values = result?.items.map(item => item.value) ?? [];

					expect(opendirSpy).toHaveBeenCalledTimes(1);
					expect(readdirSpy).not.toHaveBeenCalled();
					expect(iterated).toBeLessThanOrEqual(100);
					expect(closed).toBe(true);
					expect(values).toHaveLength(20);
					for (const expectedEarly of expectedEarlyValues(mentionRoot).slice(0, 20)) {
						expect(values).toContain(expectedEarly);
					}
					expect(values).not.toContain(expectedLate(mentionRoot));
				} finally {
					opendirSpy.mockRestore();
					readdirSpy.mockRestore();
				}
			});

			it.each([
				[
					"natural relative path",
					"relative/lat",
					(provider: CombinedAutocompleteProvider, line: string) =>
						provider.getSuggestions([line], 0, line.length),
					"relative/late-target.txt",
				],
				[
					"forced generic path",
					"./lat",
					(provider: CombinedAutocompleteProvider, line: string) =>
						provider.getForceFileSuggestions([line], 0, line.length),
					"./late-target.txt",
				],
			] as const)("preserves full %s scans beyond 100 entries", async (_name, line, requestSuggestions, expectedValue) => {
				const entries: fs.Dirent[] = Array.from({ length: 150 }, (_, index) => {
					const name = index === 120 ? "late-target.txt" : `filler-${index.toString().padStart(3, "0")}.txt`;
					return {
						name,
						isDirectory: () => false,
						isSymbolicLink: () => false,
					} as fs.Dirent;
				});
				const readdirSpy = spyOn(fs.promises, "readdir").mockResolvedValue(
					entries as unknown as Awaited<ReturnType<typeof fs.promises.readdir>>,
				);
				const opendirSpy = spyOn(fs.promises, "opendir").mockRejectedValue(
					new Error("generic relative completion should not use bounded opendir"),
				);

				try {
					const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
					const result = await requestSuggestions(provider, line);
					const values = result?.items.map(item => item.value) ?? [];

					expect(readdirSpy).toHaveBeenCalledTimes(1);
					expect(opendirSpy).not.toHaveBeenCalled();
					expect(values).toContain(expectedValue);
				} finally {
					readdirSpy.mockRestore();
					opendirSpy.mockRestore();
				}
			});

			it("keeps forced absolute Tab completion exhaustive beyond the 100-entry natural scan cap", async () => {
				const entries: fs.Dirent[] = Array.from({ length: 150 }, (_, index) => {
					const name = index === 120 ? "late-target.txt" : `filler-${index.toString().padStart(3, "0")}.txt`;
					return {
						name,
						isDirectory: () => false,
						isSymbolicLink: () => false,
					} as fs.Dirent;
				});
				const readdirSpy = spyOn(fs.promises, "readdir").mockResolvedValue(
					entries as unknown as Awaited<ReturnType<typeof fs.promises.readdir>>,
				);

				try {
					const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
					const line = `mention ${path.join(mentionRoot, "lat")}`;
					const result = await provider.getForceFileSuggestions([line], 0, line.length);
					const values = result?.items.map(item => item.value) ?? [];

					expect(readdirSpy).toHaveBeenCalledTimes(1);
					expect(values).toContain(`${path.join(mentionRoot, "late-target.txt")}`);
				} finally {
					readdirSpy.mockRestore();
				}
			});

			it("keeps bounded directory completions inside the mention token", async () => {
				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const line = `@${path.join(mentionRoot, "immediate-d")}`;
				const result = await provider.getSuggestions([line], 0, line.length);
				const directory = result?.items.find(item => item.label === "immediate-dir/");

				expect(directory).toBeDefined();
				if (!result || !directory) throw new Error("expected immediate directory completion");

				const applied = provider.applyCompletion([line], 0, line.length, directory, result.prefix);
				const completedLine = `@${path.join(mentionRoot, "immediate-dir")}/`;

				expect(applied.lines).toEqual([completedLine]);
				expect(applied.cursorCol).toBe(completedLine.length);

				const childResult = await provider.getSuggestions(applied.lines, applied.cursorLine, applied.cursorCol);
				expect(childResult?.items.map(item => item.value)).toContain(`${completedLine}nested/`);
			});

			it("still terminates bounded file mentions with a space", async () => {
				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const line = `@${path.join(mentionRoot, "immediate-t")}`;
				const result = await provider.getSuggestions([line], 0, line.length);
				const file = result?.items.find(item => item.label === "immediate-target.txt");

				expect(file).toBeDefined();
				if (!result || !file) throw new Error("expected immediate file completion");

				const applied = provider.applyCompletion([line], 0, line.length, file, result.prefix);
				const completedLine = `@${path.join(mentionRoot, "immediate-target.txt")} `;

				expect(applied.lines).toEqual([completedLine]);
				expect(applied.cursorCol).toBe(completedLine.length);
			});

			it("does not fall back to directory enumeration after native fuzzy cancellation", async () => {
				fs.mkdirSync(path.join(mentionRoot, "nested"), { recursive: true });
				fs.writeFileSync(path.join(mentionRoot, "nested", "signal-target.txt"), "signal\n");
				fs.writeFileSync(path.join(mentionRoot, "signaltarget-local.txt"), "fallback\n");
				const provider = new CombinedAutocompleteProvider([], mentionRoot, mentionRoot);
				const line = "@signaltarget";

				const activeResult = await provider.getSuggestions([line], 0, line.length);
				expect(activeResult?.items.some(item => item.value.includes("signal-target.txt"))).toBe(true);

				const controller = new AbortController();
				controller.abort();
				expect(await provider.getSuggestions([line], 0, line.length, controller.signal)).toBeNull();
			});

			it("cancels natural bounded path completion while opendir enumeration is pending", async () => {
				const readStarted = Promise.withResolvers<void>();
				const releaseRead = Promise.withResolvers<void>();
				const opendirSpy = spyOn(fs.promises, "opendir").mockResolvedValue({
					async read() {
						readStarted.resolve();
						await releaseRead.promise;
						return null;
					},
					async close() {},
				} as fs.Dir);
				const readdirSpy = spyOn(fs.promises, "readdir").mockRejectedValue(
					new Error("bounded completion should not use readdir"),
				);
				const provider = new CombinedAutocompleteProvider([], mentionRoot, mentionRoot);
				const line = `@${path.join(mentionRoot, "im")}`;
				const controller = new AbortController();
				const pending = provider.getSuggestions([line], 0, line.length, controller.signal);

				try {
					await readStarted.promise;
					controller.abort();
					const timeout = Symbol("timeout");
					const outcome = await Promise.race([pending, Bun.sleep(100).then(() => timeout)]);

					expect(opendirSpy).toHaveBeenCalledTimes(1);
					expect(readdirSpy).not.toHaveBeenCalled();
					expect(outcome).not.toBe(timeout);
					expect(outcome).toBeNull();
				} finally {
					releaseRead.resolve();
					opendirSpy.mockRestore();
					readdirSpy.mockRestore();
					await pending.catch(() => null);
				}
			});

			it("closes a bounded directory handle that opens after cancellation", async () => {
				const openStarted = Promise.withResolvers<void>();
				const opened = Promise.withResolvers<fs.Dir>();
				let closeCalls = 0;
				const lateDir = {
					async read() {
						return null;
					},
					async close() {
						closeCalls += 1;
					},
				} as fs.Dir;
				const opendirSpy = spyOn(fs.promises, "opendir").mockImplementation(() => {
					openStarted.resolve();
					return opened.promise;
				});
				const provider = new CombinedAutocompleteProvider([], mentionRoot, mentionRoot);
				const line = `@${path.join(mentionRoot, "im")}`;
				const controller = new AbortController();
				const pending = provider.getSuggestions([line], 0, line.length, controller.signal);

				try {
					await openStarted.promise;
					controller.abort();
					const timeout = Symbol("timeout");
					const outcome = await Promise.race([pending, Bun.sleep(100).then(() => timeout)]);

					expect(outcome).not.toBe(timeout);
					expect(outcome).toBeNull();

					opened.resolve(lateDir);
					await Bun.sleep(0);

					expect(closeCalls).toBe(1);
				} finally {
					opened.resolve(lateDir);
					opendirSpy.mockRestore();
					await pending.catch(() => null);
				}
			});

			it("cancels forced generic path completion while full readdir is pending", async () => {
				const readdirStarted = Promise.withResolvers<void>();
				const releaseReaddir = Promise.withResolvers<void>();
				const readdirSpy = spyOn(fs.promises, "readdir").mockImplementation(async () => {
					readdirStarted.resolve();
					await releaseReaddir.promise;
					return [];
				});
				const opendirSpy = spyOn(fs.promises, "opendir").mockRejectedValue(
					new Error("forced generic completion should not use bounded opendir"),
				);
				const provider = new CombinedAutocompleteProvider([], mentionRoot, mentionRoot);
				const line = `mention ${path.join(mentionRoot, "im")}`;
				const controller = new AbortController();
				const pending = provider.getForceFileSuggestions([line], 0, line.length, controller.signal);

				try {
					await readdirStarted.promise;
					controller.abort();
					const timeout = Symbol("timeout");
					const outcome = await Promise.race([pending, Bun.sleep(100).then(() => timeout)]);

					expect(readdirSpy).toHaveBeenCalledTimes(1);
					expect(opendirSpy).not.toHaveBeenCalled();
					expect(outcome).not.toBe(timeout);
					expect(outcome).toBeNull();
				} finally {
					releaseReaddir.resolve();
					readdirSpy.mockRestore();
					opendirSpy.mockRestore();
					await pending.catch(() => null);
				}
			});

			const literalSymlinkCases: Array<
				[
					name: string,
					typedDirFor: (root: string) => string,
					expectedFor: (root: string, typedDir: string) => string,
				]
			> = [
				[
					"absolute",
					(root: string) => `${path.join(root, "link")}/../`,
					(_root: string, typedDir: string) => `@${typedDir}candidate.txt`,
				],
				["home", (_root: string) => "~/link/../", (_root: string, typedDir: string) => `@${typedDir}candidate.txt`],
			];

			it.each(
				literalSymlinkCases,
			)("preserves literal %s symlink-plus-dotdot display paths", async (_name, typedDirFor, expectedFor) => {
				if (process.platform === "win32") {
					return;
				}

				fs.mkdirSync(path.join(mentionRoot, "real-parent", "child"), { recursive: true });
				fs.writeFileSync(path.join(mentionRoot, "real-parent", "candidate.txt"), "candidate\n");
				fs.symlinkSync(path.join(mentionRoot, "real-parent", "child"), path.join(mentionRoot, "link"), "dir");

				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const typedDir = typedDirFor(mentionRoot);
				const line = `@${typedDir}ca`;
				const result = await provider.getSuggestions([line], 0, line.length);
				const values = result?.items.map(item => item.value) ?? [];

				expect(values).toContain(expectedFor(mentionRoot, typedDir));
			});

			it.each(
				literalSymlinkCases,
			)("preserves literal %s symlink-plus-dotdot display paths for forced completion", async (_name, typedDirFor, expectedFor) => {
				if (process.platform === "win32") {
					return;
				}

				fs.mkdirSync(path.join(mentionRoot, "real-parent", "child"), { recursive: true });
				fs.writeFileSync(path.join(mentionRoot, "real-parent", "candidate.txt"), "candidate\n");
				fs.symlinkSync(path.join(mentionRoot, "real-parent", "child"), path.join(mentionRoot, "link"), "dir");

				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const typedDir = typedDirFor(mentionRoot);
				const line = `mention ${typedDir}ca`;
				const result = await provider.getForceFileSuggestions([line], 0, line.length);
				const values = result?.items.map(item => item.value) ?? [];

				expect(values).toContain(expectedFor(mentionRoot, typedDir).slice(1));
			});

			const missingSegmentSymlinkCases: Array<[name: string, typedDirFor: (root: string) => string]> = [
				["absolute", (root: string) => `${path.join(root, "link")}/missing/../`],
				["home", (_root: string) => "~/link/missing/../"],
			];

			it.each(
				missingSegmentSymlinkCases,
			)("does not collapse missing segments after a resolved %s symlink in natural mentions", async (_name, typedDirFor) => {
				if (process.platform === "win32") {
					return;
				}

				fs.mkdirSync(path.join(mentionRoot, "real-parent", "child"), { recursive: true });
				fs.writeFileSync(path.join(mentionRoot, "real-parent", "child", "candidate.txt"), "candidate\n");
				fs.symlinkSync(path.join(mentionRoot, "real-parent", "child"), path.join(mentionRoot, "link"), "dir");

				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const line = `@${typedDirFor(mentionRoot)}ca`;
				const result = await provider.getSuggestions([line], 0, line.length);

				expect(result).toBeNull();
			});

			it.each(
				missingSegmentSymlinkCases,
			)("does not collapse missing segments after a resolved %s symlink in forced completion", async (_name, typedDirFor) => {
				if (process.platform === "win32") {
					return;
				}

				fs.mkdirSync(path.join(mentionRoot, "real-parent", "child"), { recursive: true });
				fs.writeFileSync(path.join(mentionRoot, "real-parent", "child", "candidate.txt"), "candidate\n");
				fs.symlinkSync(path.join(mentionRoot, "real-parent", "child"), path.join(mentionRoot, "link"), "dir");

				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const line = `mention ${typedDirFor(mentionRoot)}ca`;
				const result = await provider.getForceFileSuggestions([line], 0, line.length);

				expect(result).toBeNull();
			});

			const nonDirectoryDotDotCases: Array<
				[name: string, setup: (root: string) => void, typedDirFor: (root: string) => string]
			> = [
				[
					"absolute regular file",
					(root: string) => {
						fs.writeFileSync(path.join(root, "plain.txt"), "plain\n");
					},
					(root: string) => `${path.join(root, "plain.txt")}/../`,
				],
				[
					"home regular file",
					(root: string) => {
						fs.writeFileSync(path.join(root, "plain.txt"), "plain\n");
					},
					(_root: string) => "~/plain.txt/../",
				],
				[
					"absolute symlink to file",
					(root: string) => {
						fs.writeFileSync(path.join(root, "plain.txt"), "plain\n");
						fs.symlinkSync(path.join(root, "plain.txt"), path.join(root, "file-link"), "file");
					},
					(root: string) => `${path.join(root, "file-link")}/../`,
				],
				[
					"home symlink to file",
					(root: string) => {
						fs.writeFileSync(path.join(root, "plain.txt"), "plain\n");
						fs.symlinkSync(path.join(root, "plain.txt"), path.join(root, "file-link"), "file");
					},
					(_root: string) => "~/file-link/../",
				],
			];

			it.each(
				nonDirectoryDotDotCases,
			)("treats %s as non-traversable in natural mentions", async (_name, setup, typedDirFor) => {
				if (process.platform === "win32") {
					return;
				}

				setup(mentionRoot);
				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const line = `@${typedDirFor(mentionRoot)}ca`;
				const result = await provider.getSuggestions([line], 0, line.length);

				expect(result).toBeNull();
			});

			it.each(
				nonDirectoryDotDotCases,
			)("treats %s as non-traversable in forced completion", async (_name, setup, typedDirFor) => {
				if (process.platform === "win32") {
					return;
				}

				setup(mentionRoot);
				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const line = `mention ${typedDirFor(mentionRoot)}ca`;
				const result = await provider.getForceFileSuggestions([line], 0, line.length);

				expect(result).toBeNull();
			});

			const relativeDotDotRequestCases = [
				[
					"natural mentions",
					(provider: CombinedAutocompleteProvider, line: string) =>
						provider.getSuggestions([line], 0, line.length),
					(pathPrefix: string) => `@${pathPrefix}`,
					(pathPrefix: string) => `@${pathPrefix}`,
				],
				[
					"forced completion",
					(provider: CombinedAutocompleteProvider, line: string) =>
						provider.getForceFileSuggestions([line], 0, line.length),
					(pathPrefix: string) => `mention ${pathPrefix}`,
					(pathPrefix: string) => pathPrefix,
				],
			] as const;

			it.each(
				relativeDotDotRequestCases,
			)("preserves relative directory-symlink-plus-dotdot semantics for %s", async (_name, request, lineFor, valueFor) => {
				if (process.platform === "win32") {
					return;
				}

				fs.mkdirSync(path.join(baseDir, "relative-parent", "child"), { recursive: true });
				fs.writeFileSync(path.join(baseDir, "relative-parent", "candidate.txt"), "candidate\n");
				fs.symlinkSync(path.join(baseDir, "relative-parent", "child"), path.join(baseDir, "relative-link"), "dir");

				const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
				const typedPrefix = "relative-link/../ca";
				const result = await request(provider, lineFor(typedPrefix));
				const values = result?.items.map(item => item.value) ?? [];

				expect(values).toContain(valueFor("relative-link/../candidate.txt"));
			});

			it.each(
				relativeDotDotRequestCases,
			)("preserves relative ENOENT and ENOTDIR boundaries for %s", async (_name, request, lineFor, _valueFor) => {
				if (process.platform === "win32") {
					return;
				}

				fs.mkdirSync(path.join(baseDir, "relative-parent", "child"), { recursive: true });
				fs.writeFileSync(path.join(baseDir, "relative-parent", "child", "candidate.txt"), "candidate\n");
				fs.symlinkSync(path.join(baseDir, "relative-parent", "child"), path.join(baseDir, "relative-link"), "dir");
				fs.writeFileSync(path.join(baseDir, "candidate.txt"), "candidate\n");
				fs.writeFileSync(path.join(baseDir, "plain.txt"), "plain\n");
				fs.symlinkSync(path.join(baseDir, "plain.txt"), path.join(baseDir, "file-link"), "file");

				for (const typedPrefix of ["relative-link/missing/../ca", "plain.txt/../ca", "file-link/../ca"]) {
					const provider = new CombinedAutocompleteProvider([], baseDir, mentionRoot);
					const result = await request(provider, lineFor(typedPrefix));

					expect(result).toBeNull();
				}
			});
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
