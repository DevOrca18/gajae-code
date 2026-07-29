import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as natives from "@gajae-code/natives";
import { CombinedAutocompleteProvider } from "@gajae-code/tui/autocomplete";

const isWindows = process.platform === "win32";
const uncRoot = process.env.GJC_AUTOCOMPLETE_UNC_ROOT?.trim() || null;

describe.skipIf(!isWindows)("CombinedAutocompleteProvider Windows path regressions", () => {
	let rootDir: string;
	let baseDir: string;
	let outsideDir: string;
	let provider: CombinedAutocompleteProvider;

	beforeEach(() => {
		rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocomplete-win32-"));
		baseDir = path.join(rootDir, "cwd");
		outsideDir = path.join(rootDir, "outside");
		fs.mkdirSync(baseDir, { recursive: true });
		fs.mkdirSync(outsideDir, { recursive: true });
		provider = new CombinedAutocompleteProvider([], baseDir);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		fs.rmSync(rootDir, { recursive: true, force: true });
	});

	it("requires the live UNC fixture in GitHub Actions", () => {
		if (process.env.GITHUB_ACTIONS !== "true") return;
		expect(uncRoot).not.toBeNull();
	});

	it("imports and calls readDirLimited through the built Windows addon", async () => {
		fs.writeFileSync(path.join(baseDir, "alpha.ts"), "export const alpha = true;\n");
		fs.writeFileSync(path.join(baseDir, "beta.ts"), "export const beta = true;\n");
		fs.mkdirSync(path.join(baseDir, "nested"), { recursive: true });
		fs.writeFileSync(path.join(baseDir, "nested", "gamma.ts"), "export const gamma = true;\n");

		const result = await natives.readDirLimited({ path: baseDir, limit: 2 });

		expect(result.entries).toHaveLength(2);
		expect(result.truncated).toBe(true);
		expect(result.entries.every(entry => !entry.name.includes("gamma.ts"))).toBe(true);
	});

	it("completes drive-letter natural prefixes from the built native addon", async () => {
		fs.writeFileSync(path.join(baseDir, "alpha.ts"), "export const alpha = true;\n");
		const line = `@${path.win32.join(baseDir, "al")}`;

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.label)).toContain("alpha.ts");
	});

	it("preserves a bare drive-relative prefix with the built native addon", async () => {
		const previousCwd = process.cwd();
		try {
			process.chdir(baseDir);
			fs.writeFileSync(path.join(baseDir, "bare-drive.ts"), "export const bareDrive = true;\n");
			const drivePrefix = path.win32.parse(baseDir).root.slice(0, 2);
			const line = `@${drivePrefix}`;

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.items.map(item => item.value)).toContain(`@${drivePrefix}bare-drive.ts`);
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("completes home-backslash prefixes from the built native addon", async () => {
		const homeFixtureDir = path.join(os.homedir(), `gjc-autocomplete-home-${Date.now()}`);
		try {
			fs.mkdirSync(homeFixtureDir, { recursive: true });
			fs.writeFileSync(path.join(homeFixtureDir, "alpha.ts"), "export const alpha = true;\n");
			const relativeHomePath = path.relative(os.homedir(), homeFixtureDir).split(path.sep).join("\\");
			const line = `@~\\${relativeHomePath}\\al`;

			const result = await provider.getSuggestions([line], 0, line.length);

			expect(result?.items.map(item => item.label)).toContain("alpha.ts");
		} finally {
			fs.rmSync(homeFixtureDir, { recursive: true, force: true });
		}
	});

	it("preserves the typed backslash form for Windows drive-letter directory completions", async () => {
		fs.mkdirSync(path.join(baseDir, "Documents"), { recursive: true });
		const line = `@${path.win32.join(baseDir, "Doc")}`;

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toContain(`@${path.win32.join(baseDir, "Documents")}\\`);
	});

	it("preserves the typed backslash form for recursive project-relative directory completions", async () => {
		fs.mkdirSync(path.join(baseDir, "src", "nested", "Documents"), { recursive: true });
		fs.writeFileSync(path.join(baseDir, "src", "nested", "deeper.ts"), "export const deeper = true;\n");

		const directoryLine = "@src\\Doc";
		const directoryResult = await provider.getSuggestions([directoryLine], 0, directoryLine.length);
		const fileLine = "@src\\deep";
		const fileResult = await provider.getSuggestions([fileLine], 0, fileLine.length);

		expect(directoryResult?.items.map(item => item.value)).toContain("@src\\nested\\Documents\\");
		expect(fileResult?.items.map(item => item.value)).toContain("@src\\nested\\deeper.ts");
	});

	it("limits junction suggestions to direct entries", async () => {
		fs.writeFileSync(path.join(outsideDir, "alpha.ts"), "export const alpha = true;\n");
		fs.mkdirSync(path.join(outsideDir, "nested"), { recursive: true });
		fs.writeFileSync(path.join(outsideDir, "nested", "alpha-deep.ts"), "export const alpha = true;\n");
		const junctionPath = path.join(baseDir, "outside-link");
		fs.symlinkSync(outsideDir, junctionPath, "junction");
		const line = "@outside-link\\a";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toContain("@outside-link\\alpha.ts");
		expect(result?.items.map(item => item.value)).not.toContain("@outside-link\\nested\\alpha-deep.ts");
	});

	it("returns null for missing segments after an external junction", async () => {
		const junctionPath = path.join(baseDir, "outside-link");
		fs.symlinkSync(outsideDir, junctionPath, "junction");
		const line = "@outside-link\\missing\\a";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).toBeNull();
	});

	it("does not invoke recursive fuzzy fallback for malformed Windows scopes", async () => {
		const junctionPath = path.join(baseDir, "outside-link");
		fs.symlinkSync(outsideDir, junctionPath, "junction");
		const fuzzyFind = vi
			.spyOn(natives, "fuzzyFind")
			.mockImplementation(async () => ({ matches: [], totalMatches: 0 }));
		const line = "@outside-link\\missing\\..\\alpha";

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result).toBeNull();
		expect(fuzzyFind).not.toHaveBeenCalled();
	});

	it("keeps recursive fuzzy discovery inside the project junction boundary", async () => {
		const internalTarget = path.join(baseDir, "internal-target", "nested");
		fs.mkdirSync(internalTarget, { recursive: true });
		fs.mkdirSync(path.join(outsideDir, "nested"), { recursive: true });
		fs.writeFileSync(path.join(internalTarget, "inside-boundary-needle.ts"), "export const inside = true;\n");
		fs.writeFileSync(path.join(outsideDir, "nested", "outside-boundary-needle.ts"), "export const outside = true;\n");
		fs.symlinkSync(path.join(baseDir, "internal-target"), path.join(baseDir, "linked-inside"), "junction");
		fs.symlinkSync(outsideDir, path.join(baseDir, "linked-outside"), "junction");
		const line = "@boundaryneedle";

		const result = await provider.getSuggestions([line], 0, line.length);

		const values = result?.items.map(item => item.value) ?? [];
		expect(values).toContain("@linked-inside/nested/inside-boundary-needle.ts");
		expect(values).not.toContain("@linked-outside/nested/outside-boundary-needle.ts");
		const outsideRootLine = "@linkedoutside";
		const outsideRootResult = await provider.getSuggestions([outsideRootLine], 0, outsideRootLine.length);
		expect(outsideRootResult?.items.map(item => item.value) ?? []).not.toContain("@linked-outside/");
	});

	it("completes UNC prefixes from the built native addon when a live UNC root is provided", async () => {
		if (!uncRoot) return;
		fs.writeFileSync(path.join(uncRoot, "alpha.ts"), "export const alpha = true;\n");
		const line = `@${path.win32.join(uncRoot, "al")}`;

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.label)).toContain("alpha.ts");
	});

	it("preserves a bare UNC share root with the built native addon", async () => {
		if (!uncRoot) return;
		const bareUncRoot = uncRoot.replace(/[\\/]+$/, "");
		const fixtureName = "bare-unc-root.ts";
		fs.writeFileSync(path.join(bareUncRoot, fixtureName), "export const bareUnc = true;\n");
		const line = `@${bareUncRoot}`;

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toContain(`@${bareUncRoot}\\${fixtureName}`);
	});

	it("preserves a bare forward-slash UNC share root with the built native addon", async () => {
		if (!uncRoot) return;
		const bareUncRoot = uncRoot.replace(/[\\/]+$/, "");
		const forwardSlashUncRoot = bareUncRoot.replaceAll("\\", "/");
		const fixtureName = "bare-forward-unc-root.ts";
		fs.writeFileSync(path.join(bareUncRoot, fixtureName), "export const bareForwardUnc = true;\n");
		const line = `@${forwardSlashUncRoot}`;

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toContain(`@${forwardSlashUncRoot}/${fixtureName}`);
	});

	it("preserves the typed UNC backslash form for directory completions", async () => {
		if (!uncRoot) return;
		fs.mkdirSync(path.join(uncRoot, "Documents"), { recursive: true });
		const line = `@${path.win32.join(uncRoot, "Doc")}`;

		const result = await provider.getSuggestions([line], 0, line.length);

		expect(result?.items.map(item => item.value)).toContain(`@${path.win32.join(uncRoot, "Documents")}\\`);
	});
});
