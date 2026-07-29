import { describe, expect, it } from "bun:test";
import { assertRequiredSymbols, missingRequiredFunctions } from "../scripts/embed-guard";

describe("memory-guard native build wiring", () => {
	it("rejects generated bindings that omit the Windows memory probe", () => {
		expect(() =>
			assertRequiredSymbols("export function nativeBuildInfo(): unknown;", [
				"nativeBuildInfo",
				"probeWindowsJobMemory",
				"readDirLimited",
			]),
		).toThrow("probeWindowsJobMemory");
	});

	it("rejects native addons that omit required bounded-directory exports", () => {
		expect(
			missingRequiredFunctions({ nativeBuildInfo: () => ({}) }, [
				"nativeBuildInfo",
				"probeWindowsJobMemory",
				"readDirLimited",
			]),
		).toEqual(["probeWindowsJobMemory", "readDirLimited"]);
		expect(
			missingRequiredFunctions(
				{
					nativeBuildInfo: () => ({}),
					probeWindowsJobMemory: () => ({}),
					readDirLimited: () => ({}),
				},
				["nativeBuildInfo", "probeWindowsJobMemory", "readDirLimited"],
			),
		).toEqual([]);
	});
});
