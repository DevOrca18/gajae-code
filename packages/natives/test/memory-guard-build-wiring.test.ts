import { describe, expect, it } from "bun:test";
import { assertRequiredSymbols } from "../scripts/embed-guard";
import { missingRequiredAddonExports } from "../scripts/embed-native";

describe("memory-guard native build wiring", () => {
	it("rejects generated bindings that omit the Windows memory probe", () => {
		expect(() =>
			assertRequiredSymbols("export function nativeBuildInfo(): unknown;", [
				"nativeBuildInfo",
				"probeWindowsJobMemory",
				"__piNativesReadDirLimitedV1",
				"readDirLimited",
			]),
		).toThrow("probeWindowsJobMemory");
	});

	it("keeps bounded directory enumeration in the actual generated-binding guard", async () => {
		const buildSource = await Bun.file(new URL("../scripts/build-native.ts", import.meta.url)).text();
		const requiredSymbols = buildSource.match(/const requiredGeneratedBindingSymbols = \[([\s\S]*?)] as const;/)?.[1];

		expect(requiredSymbols).toContain('"__piNativesReadDirLimitedV1"');
		expect(requiredSymbols).toContain('"readDirLimited"');
	});

	it("rejects native addons that omit required bounded-directory exports", () => {
		expect(missingRequiredAddonExports({ nativeBuildInfo: () => ({}) })).toEqual([
			"probeWindowsJobMemory",
			"__piNativesReadDirLimitedV1",
			"readDirLimited",
		]);
		expect(
			missingRequiredAddonExports({
				nativeBuildInfo: () => ({}),
				probeWindowsJobMemory: () => ({}),
				__piNativesReadDirLimitedV1: () => ({}),
				readDirLimited: () => ({}),
			}),
		).toEqual([]);
	});
});
