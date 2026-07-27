import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type AuthCredentialIfAbsentSnapshotResult,
	type AuthCredentialSelector,
	AuthStorage,
	type AuthStorageGenerationEvent,
	type CredentialDisabledEvent,
	createCredentialRecoveryKey,
	SelectedCredentialUnavailableError,
} from "@gajae-code/ai";
import { Container } from "@gajae-code/tui";
import { logger, VERSION } from "@gajae-code/utils";

import { handleCredentialsSetup } from "../src/cli/setup-cli";
import { ModelRegistry } from "../src/config/model-registry";
import { ProviderOnboardingSelectorComponent } from "../src/modes/components/provider-onboarding-selector";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import {
	CREDENTIAL_AUTO_IMPORT_PERSISTENCE_WARNING,
	CREDENTIAL_AUTO_IMPORT_REFRESH_WARNING,
	CREDENTIAL_AUTO_IMPORT_RETRY_WARNING,
	CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING,
	type CredentialAutoImportStateFile,
	type CredentialAutoImportStateMutation,
	type CredentialAutoImportStateStore,
	type CredentialAutoImportStateStoreDependencies,
	createAcceptedExternalCredentialRecovery,
	createCredentialAutoImportStateStore,
	getCredentialAutoImportStatePath,
	readCredentialAutoImportState,
	runStartupCredentialAutoImportIfNeeded,
} from "../src/setup/credential-auto-import";
import type { CredentialDiscoveryResult, DiscoveryOptions, ImportableCredential } from "../src/setup/credential-import";
import * as credentialImport from "../src/setup/credential-import";
import { executeBuiltinSlashCommand } from "../src/slash-commands/builtin-registry";

const testTheme = await getThemeByName("red-claw");

function installTestTheme(): void {
	if (!testTheme) throw new Error("Failed to load test theme");
	setThemeInstance(testTheme);
}

function oauthCredential(overrides: Partial<ImportableCredential> = {}): ImportableCredential {
	return {
		provider: "anthropic",
		origin: "claude-code-file",
		source: "Claude Code (test)",
		kind: "oauth",
		expiresAt: Date.now() + 60_000,
		redactedToken: "sk-a…oken",
		credential: { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 60_000 },
		...overrides,
	} as ImportableCredential;
}

function apiKeyCredential(): ImportableCredential {
	return {
		provider: "openai-codex",
		origin: "codex-file",
		source: "Codex CLI (test)",
		kind: "api_key",
		redactedToken: "sk-c…oken",
		credential: { type: "api_key", key: "sk-codex" },
	};
}

function discovery(
	importable: ImportableCredential[] = [],
	skipped: CredentialDiscoveryResult["skipped"] = [],
): CredentialDiscoveryResult {
	return { importable, skipped, environment: [] };
}

function inserted(provider = "anthropic"): AuthCredentialIfAbsentSnapshotResult {
	return { inserted: true, reason: "inserted", provider, entries: [] };
}

function skipped(provider = "anthropic"): AuthCredentialIfAbsentSnapshotResult {
	return { inserted: false, reason: "skipped-existing", provider, entries: [] };
}

describe("credential auto-import trigger guards", () => {
	afterEach(() => {
		spyOn(credentialImport, "discoverExternalCredentials").mockRestore?.();
	});

	function runtime() {
		const calls: Array<{ mode: string; providerId?: string; options?: unknown }> = [];
		return {
			calls,
			runtime: {
				ctx: {
					oauthManualInput: {
						hasPending: () => false,
						pendingProviderId: undefined,
						submit: () => false,
					},
					showOAuthSelector: (mode: string, providerId?: string, options?: unknown) => {
						calls.push({ mode, providerId, options });
					},
					showWarning: () => {},
					showStatus: () => {},
					editor: { setText: () => {} },
				},
			},
		};
	}

	test("bare /login is the only slash path that enables external discovery", async () => {
		const bare = runtime();
		await executeBuiltinSlashCommand("/login", bare.runtime as never);
		expect(bare.calls).toHaveLength(1);
		expect(bare.calls[0]?.options).toEqual({ allowExternalCredentialDiscovery: true, trigger: "bare-login" });

		const providerSpecific = runtime();
		await executeBuiltinSlashCommand("/login anthropic", providerSpecific.runtime as never);
		expect(providerSpecific.calls).toEqual([{ mode: "login", providerId: "anthropic", options: undefined }]);

		const callback = runtime();
		await executeBuiltinSlashCommand("/login https://localhost/callback?code=abc", callback.runtime as never);
		expect(callback.calls).toHaveLength(0);

		const logout = runtime();
		await executeBuiltinSlashCommand("/logout anthropic", logout.runtime as never);
		expect(logout.calls).toEqual([{ mode: "logout", providerId: "anthropic", options: undefined }]);
	});

	test("excluded trigger paths perform zero discovery and zero Claude keychain reads", async () => {
		const discoverSpy = spyOn(credentialImport, "discoverExternalCredentials").mockResolvedValue(discovery());
		let keychainReads = 0;
		const readClaudeKeychain = async () => {
			keychainReads += 1;
			return null;
		};

		const providerSpecific = runtime();
		await executeBuiltinSlashCommand("/login anthropic", providerSpecific.runtime as never);
		const callback = runtime();
		await executeBuiltinSlashCommand("/login http://127.0.0.1:1455/callback?code=abc", callback.runtime as never);
		const logout = runtime();
		await executeBuiltinSlashCommand("/logout anthropic", logout.runtime as never);

		// Simulates provider-onboarding oauth-login: direct selector open without discovery option.
		const onboarding = runtime();
		onboarding.runtime.ctx.showOAuthSelector("login");

		expect(discoverSpy).toHaveBeenCalledTimes(0);
		expect(keychainReads).toBe(0);
		await readClaudeKeychain();
		expect(keychainReads).toBe(1);
	});
});

describe("startup credential auto-import marker matrix", () => {
	function makeStateStore(lastVersion?: string) {
		const state: CredentialAutoImportStateFile = lastVersion ? { lastImportVersion: lastVersion } : {};
		let writes = 0;
		const stateStore: CredentialAutoImportStateStore = {
			read: async () => ({ state: { ...state }, problems: [], unreadable: false }),
			write: async mutation => {
				if (mutation.lastImportVersion !== undefined) state.lastImportVersion = mutation.lastImportVersion;
				if (state.initialImportResolution === undefined && mutation.initialImportResolution !== undefined) {
					state.initialImportResolution = mutation.initialImportResolution;
				}
				writes += 1;
				return true;
			},
		};
		return {
			stateStore,
			get marker() {
				return state.lastImportVersion;
			},
			get resolution() {
				return state.initialImportResolution;
			},
			get writes() {
				return writes;
			},
		};
	}

	function authStorage(outcomes: Array<AuthCredentialIfAbsentSnapshotResult | Error>) {
		const calls: string[] = [];
		return {
			calls,
			authStorage: {
				importCredentialIfAbsent: async (provider: string) => {
					calls.push(provider);
					const outcome = outcomes.shift() ?? skipped(provider);
					if (outcome instanceof Error) throw outcome;
					return outcome;
				},
			},
		};
	}

	async function runCase(args: {
		lastVersion?: string;
		discover: (options?: DiscoveryOptions) => Promise<CredentialDiscoveryResult>;
		outcomes?: Array<AuthCredentialIfAbsentSnapshotResult | Error>;
	}) {
		const marker = makeStateStore(args.lastVersion);
		const a = authStorage(args.outcomes ?? []);
		const refreshCalls: string[] = [];
		const notice = await runStartupCredentialAutoImportIfNeeded({
			authStorage: a.authStorage as never,
			modelRegistry: { refresh: async (mode?: string) => refreshCalls.push(mode ?? "") } as never,
			discover: args.discover,
			stateStore: marker.stateStore,
		});
		return { marker, auth: a, refreshCalls, notice };
	}

	test("marker at VERSION skips discovery and reads", async () => {
		let discoveryReads = 0;
		let keychainReads = 0;
		const result = await runCase({
			lastVersion: VERSION,
			discover: async options => {
				discoveryReads += 1;
				await options?.readClaudeKeychain?.();
				keychainReads += 1;
				return discovery();
			},
		});
		expect(discoveryReads).toBe(0);
		expect(keychainReads).toBe(0);
		expect(result.marker.marker).toBe(VERSION);
		expect(result.marker.writes).toBe(0);
	});

	test("global discovery failure logs only bounded failure evidence and does not advance marker", async () => {
		const errorSentinel = "STARTUP_GLOBAL_DISCOVERY_ERROR_SENTINEL";
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await runCase({
				discover: async () => {
					throw new Error(`global discovery failed ${errorSentinel}`);
				},
			});
			expect(result.marker.marker).toBeUndefined();
			expect(result.marker.writes).toBe(0);
			expect(result.refreshCalls).toHaveLength(0);
			expect(result.notice).toBeUndefined();
			expect(warning).toHaveBeenCalledWith("Credential auto-import completed with failures", {
				trigger: "startup",
				failureCounts: { "discovery-unavailable": 1 },
			});
			expect(JSON.stringify(warning.mock.calls)).not.toContain(errorSentinel);
		} finally {
			warning.mockRestore();
		}
	});

	test("no candidates advances marker without refresh or notice", async () => {
		const result = await runCase({ discover: async () => discovery([]) });
		expect(result.marker.marker).toBe(VERSION);
		expect(result.marker.writes).toBe(1);
		expect(result.refreshCalls).toHaveLength(0);
		expect(result.notice).toBeUndefined();
		expect(result.marker.resolution).toBeUndefined();
	});

	test("all skipped advances marker without refresh or notice", async () => {
		const result = await runCase({ discover: async () => discovery([oauthCredential()]), outcomes: [skipped()] });
		expect(result.marker.marker).toBe(VERSION);
		expect(result.refreshCalls).toHaveLength(0);
		expect(result.notice).toBeUndefined();
		expect(result.marker.resolution).toBe("accepted");
	});

	test("all failed does not advance marker or refresh", async () => {
		const result = await runCase({
			discover: async () => discovery([oauthCredential()]),
			outcomes: [new Error("write conflict")],
		});
		expect(result.marker.marker).toBeUndefined();
		expect(result.marker.writes).toBe(0);
		expect(result.refreshCalls).toHaveLength(0);
		expect(result.notice).toBeUndefined();
		expect(result.marker.resolution).toBeUndefined();
	});

	test("partial import advances marker, refreshes registry, and emits exact rotation warning", async () => {
		const result = await runCase({
			discover: async () =>
				discovery([oauthCredential(), oauthCredential({ provider: "openai-codex", origin: "codex-file" })]),
			outcomes: [inserted("anthropic"), skipped("openai-codex")],
		});
		expect(result.marker.marker).toBe(VERSION);
		expect(result.refreshCalls).toEqual(["offline"]);
		expect(result.notice).toContain(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING);
		expect(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING).toBe(
			"Refreshing in gjc may log out the Claude/Codex CLI because OAuth refresh tokens can rotate.",
		);
		expect(result.marker.resolution).toBe("accepted");
	});

	test("startup keeps an accepted transition and logs bounded mixed failure evidence", async () => {
		const marker = makeStateStore();
		const sourceSentinel = "STARTUP_SOURCE_SENTINEL";
		const reasonSentinel = "STARTUP_REASON_SENTINEL";
		const environmentSentinel = "STARTUP_ENVIRONMENT_SENTINEL";
		const errorSentinel = "STARTUP_ERROR_SENTINEL";
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const notice = await runStartupCredentialAutoImportIfNeeded({
				authStorage: authStorage([
					inserted("anthropic"),
					skipped("openai-codex"),
					new Error(`write conflict ${errorSentinel}`),
				]).authStorage as never,
				modelRegistry: { refresh: async () => {} } as never,
				discover: async () => ({
					importable: [
						oauthCredential({ source: sourceSentinel }),
						oauthCredential({ provider: "openai-codex", origin: "codex-file", source: sourceSentinel }),
						oauthCredential({ source: sourceSentinel }),
					],
					skipped: [
						{
							origin: "claude-code-file",
							source: sourceSentinel,
							reason: `unreadable ${reasonSentinel}`,
						},
					],
					environment: [
						{ provider: "anthropic", variable: environmentSentinel, redactedValue: environmentSentinel },
					],
				}),
				stateStore: marker.stateStore,
			});
			expect(marker.marker).toBe(VERSION);
			expect(marker.resolution).toBe("accepted");
			expect(notice).toContain(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING);
			expect(warning).toHaveBeenCalledWith("Credential auto-import completed with failures", {
				trigger: "startup",
				failureCounts: { "source-unreadable": 1, "write-conflict": 1 },
			});
			const emitted = JSON.stringify(warning.mock.calls);
			for (const sentinel of [sourceSentinel, reasonSentinel, environmentSentinel, errorSentinel]) {
				expect(emitted).not.toContain(sentinel);
			}
		} finally {
			warning.mockRestore();
		}
	});

	test("source-failed zero candidates remain unresolved for a later startup retry", async () => {
		const marker = makeStateStore();
		const result = await runStartupCredentialAutoImportIfNeeded({
			authStorage: authStorage([]).authStorage as never,
			modelRegistry: { refresh: async () => {} } as never,
			discover: async () =>
				discovery(
					[],
					[
						{
							origin: "claude-code-file",
							source: "external credential source",
							reason: "unreadable credential file",
						},
					],
				),
			stateStore: marker.stateStore,
		});
		expect(result).toBeUndefined();
		expect(marker.writes).toBe(0);
		expect(marker.resolution).toBeUndefined();
	});

	test("startup keeps its accepted decision when the provider refresh fails", async () => {
		const marker = makeStateStore();
		const notice = await runStartupCredentialAutoImportIfNeeded({
			authStorage: authStorage([inserted()]).authStorage as never,
			modelRegistry: {
				refresh: async () => {
					throw new Error("refresh failed");
				},
			} as never,
			discover: async () => discovery([oauthCredential()]),
			stateStore: marker.stateStore,
		});
		expect(marker.resolution).toBe("accepted");
		expect(notice).toContain(CREDENTIAL_AUTO_IMPORT_REFRESH_WARNING);
	});
});

describe("accepted external credential recovery", () => {
	function stateStore(initialImportResolution: "accepted" | "declined"): CredentialAutoImportStateStore {
		return {
			read: async () => ({
				state: { initialImportResolution, lastImportVersion: VERSION },
				problems: [],
				unreadable: false,
			}),
			write: async () => true,
		};
	}

	function createHarness(options: {
		initialImportResolution?: "accepted" | "declined";
		candidate?: ImportableCredential;
		stateStore?: CredentialAutoImportStateStore;
		discover?: () => Promise<CredentialDiscoveryResult>;
		importOutcomes?: AuthCredentialIfAbsentSnapshotResult[];
		notifyGenerationOnImport?: boolean;
		notifyExternalGenerationOnImport?: boolean;
	}) {
		let disabledListener: ((event: CredentialDisabledEvent) => void | Promise<void>) | undefined;
		let generationListener: ((generation: number, event?: AuthStorageGenerationEvent) => void) | undefined;
		let generation = 1;
		let candidate =
			options.candidate ??
			oauthCredential({
				provider: "openai-codex",
				origin: "codex-file",
				source: "Codex CLI (test)",
				credential: {
					type: "oauth",
					access: "codex-access-1",
					refresh: "codex-refresh-1",
					expires: Date.now() + 60_000,
				},
			});
		const importOutcomes = [...(options.importOutcomes ?? [])];
		const importAttemptRefreshTokens: string[] = [];
		const importedRefreshTokens: string[] = [];
		let discoveryReads = 0;
		const recover = createAcceptedExternalCredentialRecovery({
			authStorage: {
				onCredentialDisabled: listener => {
					disabledListener = listener;
					return () => {
						disabledListener = undefined;
					};
				},
				onGenerationChanged: listener => {
					generationListener = listener;
					return () => {
						generationListener = undefined;
					};
				},
				importCredentialIfAbsent: async (provider, credential, importOptions) => {
					const outcome = importOutcomes.shift() ?? inserted(provider);
					if (credential.type === "oauth") {
						importAttemptRefreshTokens.push(credential.refresh);
						if (outcome.inserted) importedRefreshTokens.push(credential.refresh);
					}
					if (outcome.inserted && options.notifyGenerationOnImport) {
						generation += 1;
						generationListener?.(generation, {
							kind: "credential-import",
							provider,
							...(importOptions?.mutationToken ? { mutationToken: importOptions.mutationToken } : {}),
						});
					}
					if (outcome.inserted && options.notifyExternalGenerationOnImport) {
						generation += 1;
						generationListener?.(generation, { kind: "mutation", provider });
					}
					return outcome;
				},
			},
			modelRegistry: { refresh: async () => {} },
			stateStore: options.stateStore ?? stateStore(options.initialImportResolution ?? "accepted"),
			discover:
				options.discover ??
				(async () => {
					discoveryReads += 1;
					return discovery([candidate]);
				}),
		});
		return {
			recover,
			emitDisabled: async (disabledCause = "oauth refresh failed: invalid_grant") => {
				generation += 1;
				const recoverable = disabledCause.startsWith("oauth refresh failed:");
				generationListener?.(generation, {
					kind: recoverable ? "credential-disabled" : "mutation",
					provider: "openai-codex",
					...(recoverable ? { recoveryKey: createCredentialRecoveryKey("openai-codex") } : {}),
				});
				await disabledListener?.({ provider: "openai-codex", disabledCause });
			},
			emitSelectedDisabled: async (
				selector: AuthCredentialSelector,
				disabledCause = "oauth refresh failed: invalid_grant",
			) => {
				generation += 1;
				const recoverable = disabledCause.startsWith("oauth refresh failed:");
				generationListener?.(generation, {
					kind: recoverable ? "credential-disabled" : "mutation",
					provider: "openai-codex",
					...(recoverable ? { recoveryKey: createCredentialRecoveryKey("openai-codex", selector) } : {}),
				});
				await disabledListener?.({
					provider: "openai-codex",
					disabledCause,
					recoveryKey: createCredentialRecoveryKey("openai-codex", selector),
				});
			},
			emitSelectedDisabledAfterExternalGeneration: async (selector: AuthCredentialSelector) => {
				const recoveryKey = createCredentialRecoveryKey("openai-codex", selector);
				generation += 1;
				generationListener?.(generation, {
					kind: "credential-disabled",
					provider: "openai-codex",
					recoveryKey,
				});
				generation += 1;
				generationListener?.(generation, {
					kind: "mutation",
					provider: "openai-codex",
				});
				await disabledListener?.({
					provider: "openai-codex",
					disabledCause: "oauth refresh failed: invalid_grant",
					recoveryKey,
				});
			},
			emitGenerationChanged: (nextGeneration = generation + 1) => {
				generation = nextGeneration;
				generationListener?.(generation, { kind: "mutation" });
			},
			replaceCandidate: (next: ImportableCredential) => {
				candidate = next;
			},
			importAttemptRefreshTokens,
			importedRefreshTokens,
			get discoveryReads() {
				return discoveryReads;
			},
		};
	}

	test("does not inspect external credentials for an ordinary missing key", async () => {
		const harness = createHarness({});

		expect(await harness.recover("openai-codex")).toBe(false);
		expect(harness.discoveryReads).toBe(0);
		expect(harness.importedRefreshTokens).toEqual([]);
	});

	test("recovers Codex OAuth only after a definitive refresh disable", async () => {
		const harness = createHarness({});
		await harness.emitDisabled();

		expect(await harness.recover("openai-codex")).toBe(true);
		expect(harness.discoveryReads).toBe(1);
		expect(harness.importedRefreshTokens).toEqual(["codex-refresh-1"]);
	});

	test("does not recover after user deletion or when external imports were declined", async () => {
		const deleted = createHarness({});
		await deleted.emitDisabled("deleted by user");
		expect(await deleted.recover("openai-codex")).toBe(false);
		expect(deleted.discoveryReads).toBe(0);

		const declined = createHarness({ initialImportResolution: "declined" });
		await declined.emitDisabled();
		expect(await declined.recover("openai-codex")).toBe(false);
		expect(declined.discoveryReads).toBe(0);
	});

	test("clears an unconsumed disable trigger when logout changes the credential generation", async () => {
		const harness = createHarness({});
		await harness.emitDisabled();
		harness.emitGenerationChanged();

		expect(await harness.recover("openai-codex")).toBe(false);
		expect(harness.discoveryReads).toBe(0);
		expect(harness.importedRefreshTokens).toEqual([]);
	});

	test("does not re-import the same rejected Codex credential generation", async () => {
		const harness = createHarness({});
		await harness.emitDisabled();
		expect(await harness.recover("openai-codex")).toBe(true);

		await harness.emitDisabled();
		expect(await harness.recover("openai-codex")).toBe(false);
		expect(harness.importedRefreshTokens).toEqual(["codex-refresh-1"]);

		harness.replaceCandidate(
			oauthCredential({
				provider: "openai-codex",
				origin: "codex-file",
				source: "Codex CLI (test)",
				credential: {
					type: "oauth",
					access: "codex-access-2",
					refresh: "codex-refresh-2",
					expires: Date.now() + 120_000,
				},
			}),
		);
		await harness.emitDisabled();
		expect(await harness.recover("openai-codex")).toBe(true);
		expect(harness.importedRefreshTokens).toEqual(["codex-refresh-1", "codex-refresh-2"]);
	});

	test("matches account and project selectors against the stored OAuth payload", async () => {
		const accountSelector = { kind: "account" as const, value: "payload-account" };
		const account = createHarness({
			candidate: oauthCredential({
				provider: "openai-codex",
				origin: "codex-file",
				identity: { accountId: "display-account" },
				credential: {
					type: "oauth",
					access: "account-access",
					refresh: "account-refresh",
					expires: Date.now() + 60_000,
					accountId: "payload-account",
				},
			}),
		});
		await account.emitSelectedDisabled(accountSelector);
		expect(await account.recover("openai-codex", accountSelector)).toBe(true);
		expect(account.importedRefreshTokens).toEqual(["account-refresh"]);

		const projectSelector = { kind: "project" as const, value: "payload-project" };
		const project = createHarness({
			candidate: oauthCredential({
				provider: "openai-codex",
				origin: "codex-file",
				credential: {
					type: "oauth",
					access: "project-access",
					refresh: "project-refresh",
					expires: Date.now() + 60_000,
					projectId: "payload-project",
				},
			}),
		});
		await project.emitSelectedDisabled(projectSelector);
		expect(await project.recover("openai-codex", projectSelector)).toBe(true);
		expect(project.importedRefreshTokens).toEqual(["project-refresh"]);
	});

	test("rejects an account selector when only the display identity matches", async () => {
		const selector = { kind: "account" as const, value: "pinned-account" };
		const harness = createHarness({
			candidate: oauthCredential({
				provider: "openai-codex",
				origin: "codex-file",
				identity: { accountId: "pinned-account" },
				credential: {
					type: "oauth",
					access: "other-account-access",
					refresh: "other-account-refresh",
					expires: Date.now() + 60_000,
					accountId: "other-account",
				},
			}),
		});
		await harness.emitSelectedDisabled(selector);

		expect(await harness.recover("openai-codex", selector)).toBe(false);
		expect(harness.importedRefreshTokens).toEqual([]);
		expect(harness.discoveryReads).toBe(1);
	});

	test("fails closed for a local row-id selector", async () => {
		const selector = { kind: "id" as const, value: "1" };
		const harness = createHarness({});
		await harness.emitSelectedDisabled(selector);

		expect(await harness.recover("openai-codex", selector)).toBe(false);
		expect(harness.importedRefreshTokens).toEqual([]);
		expect(harness.discoveryReads).toBe(1);
	});

	test("does not let an unpinned recovery consume a selector-scoped disable trigger", async () => {
		const selector = { kind: "email" as const, value: "pinned@example.com" };
		const harness = createHarness({
			candidate: oauthCredential({
				provider: "openai-codex",
				origin: "codex-file",
				credential: {
					type: "oauth",
					access: "pinned-access",
					refresh: "pinned-refresh",
					expires: Date.now() + 60_000,
					email: selector.value,
				},
			}),
		});
		await harness.emitSelectedDisabled(selector);

		expect(await harness.recover("openai-codex")).toBe(false);
		expect(harness.discoveryReads).toBe(0);
		expect(await harness.recover("openai-codex", selector)).toBe(true);
		expect(harness.importedRefreshTokens).toEqual(["pinned-refresh"]);
	});

	test("keeps concurrent recovery triggers isolated across distinct selectors", async () => {
		const firstSelector = { kind: "email" as const, value: "first@example.com" };
		const secondSelector = { kind: "email" as const, value: "second@example.com" };
		const firstDiscoveryStarted = Promise.withResolvers<void>();
		const releaseFirstDiscovery = Promise.withResolvers<void>();
		let discoveryCalls = 0;
		const candidates = [
			oauthCredential({
				provider: "openai-codex",
				origin: "codex-file",
				credential: {
					type: "oauth",
					access: "first-access",
					refresh: "first-refresh",
					expires: Date.now() + 60_000,
					email: firstSelector.value,
				},
			}),
			oauthCredential({
				provider: "openai-codex",
				origin: "codex-file",
				credential: {
					type: "oauth",
					access: "second-access",
					refresh: "second-refresh",
					expires: Date.now() + 60_000,
					email: secondSelector.value,
				},
			}),
		];
		const harness = createHarness({
			notifyGenerationOnImport: true,
			importOutcomes: [inserted("openai-codex"), skipped("openai-codex")],
			discover: async () => {
				discoveryCalls += 1;
				if (discoveryCalls === 1) {
					firstDiscoveryStarted.resolve();
					await releaseFirstDiscovery.promise;
				}
				return discovery(candidates);
			},
		});
		await harness.emitSelectedDisabled(firstSelector);
		await harness.emitSelectedDisabled(secondSelector);

		const firstRecovery = harness.recover("openai-codex", firstSelector);
		await firstDiscoveryStarted.promise;
		const secondRecovery = harness.recover("openai-codex", secondSelector);
		try {
			expect(await secondRecovery).toBe(true);
		} finally {
			releaseFirstDiscovery.resolve();
		}
		expect(await firstRecovery).toBe(false);
		expect(harness.importAttemptRefreshTokens).toEqual(["second-refresh", "first-refresh"]);
		expect(harness.importedRefreshTokens).toEqual(["second-refresh"]);
	});

	test("cancels other selector triggers on a nested external generation during recovery import", async () => {
		const firstSelector = { kind: "email" as const, value: "first@example.com" };
		const secondSelector = { kind: "email" as const, value: "second@example.com" };
		let discoveryReads = 0;
		const harness = createHarness({
			notifyGenerationOnImport: true,
			notifyExternalGenerationOnImport: true,
			discover: async () => {
				discoveryReads += 1;
				return discovery([
					oauthCredential({
						provider: "openai-codex",
						origin: "codex-file",
						credential: {
							type: "oauth",
							access: "first-access",
							refresh: "first-refresh",
							expires: Date.now() + 60_000,
							email: firstSelector.value,
						},
					}),
					oauthCredential({
						provider: "openai-codex",
						origin: "codex-file",
						credential: {
							type: "oauth",
							access: "second-access",
							refresh: "second-refresh",
							expires: Date.now() + 60_000,
							email: secondSelector.value,
						},
					}),
				]);
			},
		});
		await harness.emitSelectedDisabled(firstSelector);
		await harness.emitSelectedDisabled(secondSelector);

		expect(await harness.recover("openai-codex", firstSelector)).toBe(true);
		expect(await harness.recover("openai-codex", secondSelector)).toBe(false);
		expect(discoveryReads).toBe(1);
		expect(harness.importedRefreshTokens).toEqual(["first-refresh"]);
	});

	test("does not re-arm a disable trigger after a nested external generation", async () => {
		const selector = { kind: "email" as const, value: "pinned@example.com" };
		const harness = createHarness({});

		await harness.emitSelectedDisabledAfterExternalGeneration(selector);

		expect(await harness.recover("openai-codex", selector)).toBe(false);
		expect(harness.discoveryReads).toBe(0);
		expect(harness.importedRefreshTokens).toEqual([]);
	});

	test("preserves real selector triggers across sequential definitive disables", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-trigger-order-"));
		const firstSelector = { kind: "email" as const, value: "first@example.com" };
		const secondSelector = { kind: "email" as const, value: "second@example.com" };
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
				refreshOAuthCredential: async () => {
					throw new Error("401 invalid_grant");
				},
			});
			await authStorage.set("openai-codex", [
				{
					type: "oauth",
					access: "stale-first-access",
					refresh: "stale-first-refresh",
					expires: Date.now() - 1,
					accountId: "first-account",
					email: firstSelector.value,
				},
				{
					type: "oauth",
					access: "stale-second-access",
					refresh: "stale-second-refresh",
					expires: Date.now() - 1,
					accountId: "second-account",
					email: secondSelector.value,
				},
			]);
			let discoveryReads = 0;
			const recover = createAcceptedExternalCredentialRecovery({
				authStorage,
				modelRegistry: { refresh: async () => {} },
				stateStore: stateStore("accepted"),
				discover: async () => {
					discoveryReads += 1;
					return discovery([
						oauthCredential({
							provider: "openai-codex",
							origin: "codex-file",
							credential: {
								type: "oauth",
								access: "fresh-first-access",
								refresh: "fresh-first-refresh",
								expires: Date.now() + 10 * 60_000,
								accountId: "first-account",
								email: firstSelector.value,
							},
						}),
						oauthCredential({
							provider: "openai-codex",
							origin: "codex-file",
							credential: {
								type: "oauth",
								access: "fresh-second-access",
								refresh: "fresh-second-refresh",
								expires: Date.now() + 10 * 60_000,
								accountId: "second-account",
								email: secondSelector.value,
							},
						}),
					]);
				},
			});
			const disable = async (selector: AuthCredentialSelector): Promise<void> => {
				const error = await authStorage
					?.getApiKey("openai-codex", undefined, { credentialSelector: selector })
					.then(
						() => undefined,
						reason => reason,
					);
				expect(error).toBeInstanceOf(SelectedCredentialUnavailableError);
			};

			await disable(firstSelector);
			await disable(secondSelector);

			expect(await recover("openai-codex", firstSelector)).toBe(true);
			expect(await recover("openai-codex", secondSelector)).toBe(false);
			expect(discoveryReads).toBe(2);
			expect(
				await authStorage.getApiKey("openai-codex", undefined, {
					credentialSelector: firstSelector,
				}),
			).toBe("fresh-first-access");
			expect(authStorage.exportSnapshot().credentials).toHaveLength(1);
			expect(authStorage.exportSnapshot().credentials[0]?.credential).toMatchObject({
				type: "oauth",
				email: firstSelector.value,
			});
		} finally {
			authStorage?.close();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("preserves an armed trigger across unreadable and malformed consent state", async () => {
		let stateReads = 0;
		const retryingStateStore: CredentialAutoImportStateStore = {
			read: async () => {
				stateReads += 1;
				if (stateReads === 1) return { state: {}, problems: [], unreadable: true };
				if (stateReads === 2) return { state: {}, problems: ["malformed-json"], unreadable: false };
				return {
					state: { initialImportResolution: "accepted", lastImportVersion: VERSION },
					problems: [],
					unreadable: false,
				};
			},
			write: async () => true,
		};
		const harness = createHarness({ stateStore: retryingStateStore });
		await harness.emitDisabled();

		expect(await harness.recover("openai-codex")).toBe(false);
		expect(await harness.recover("openai-codex")).toBe(false);
		expect(await harness.recover("openai-codex")).toBe(true);
		expect(stateReads).toBe(3);
		expect(harness.importedRefreshTokens).toEqual(["codex-refresh-1"]);
	});

	test("preserves malformed Codex discovery for a bounded retry", async () => {
		let discoveryReads = 0;
		const candidate = oauthCredential({
			provider: "openai-codex",
			origin: "codex-file",
			source: "Codex CLI (test)",
			credential: {
				type: "oauth",
				access: "codex-access-retry",
				refresh: "codex-refresh-retry",
				expires: Date.now() + 60_000,
			},
		});
		const harness = createHarness({
			discover: async () => {
				discoveryReads += 1;
				return discoveryReads === 1
					? discovery(
							[],
							[
								{
									origin: "codex-file",
									source: "Codex CLI (~/.codex/auth.json)",
									reason: "malformed credential file (SyntaxError)",
								},
							],
						)
					: discovery([candidate]);
			},
		});
		await harness.emitDisabled();

		expect(await harness.recover("openai-codex")).toBe(false);
		expect(await harness.recover("openai-codex")).toBe(true);
		expect(discoveryReads).toBe(2);
		expect(harness.importedRefreshTokens).toEqual(["codex-refresh-retry"]);
	});

	test("bounds repeated transient discovery failures for one disable event", async () => {
		let discoveryReads = 0;
		const harness = createHarness({
			discover: async () => {
				discoveryReads += 1;
				return discovery(
					[],
					[
						{
							origin: "codex-file",
							source: "Codex CLI (~/.codex/auth.json)",
							reason: "unreadable credential file (EACCES)",
						},
					],
				);
			},
		});
		await harness.emitDisabled();

		for (let attempt = 0; attempt < 4; attempt += 1) {
			expect(await harness.recover("openai-codex")).toBe(false);
		}
		expect(discoveryReads).toBe(3);
	});

	test("cancels an in-flight recovery when generation changes during discovery", async () => {
		const discoveryStarted = Promise.withResolvers<void>();
		const releaseDiscovery = Promise.withResolvers<void>();
		const candidate = oauthCredential({
			provider: "openai-codex",
			origin: "codex-file",
			source: "Codex CLI (test)",
		});
		const harness = createHarness({
			discover: async () => {
				discoveryStarted.resolve();
				await releaseDiscovery.promise;
				return discovery([candidate]);
			},
		});
		await harness.emitDisabled();

		const recovery = harness.recover("openai-codex");
		await discoveryStarted.promise;
		harness.emitGenerationChanged();
		releaseDiscovery.resolve();

		expect(await recovery).toBe(false);
		expect(harness.importedRefreshTokens).toEqual([]);
	});

	test("startup installs recovery before a resolved accepted marker skips discovery", async () => {
		let disabledListener: ((event: { provider: string; disabledCause: string }) => void | Promise<void>) | undefined;
		let recovery: ((provider: string) => Promise<boolean>) | undefined;
		let discoveryReads = 0;
		const importedProviders: string[] = [];
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: {
				onCredentialDisabled: listener => {
					disabledListener = listener;
					return () => {};
				},
				onGenerationChanged: () => () => {},
				importCredentialIfAbsent: async provider => {
					importedProviders.push(provider);
					return inserted(provider);
				},
			},
			modelRegistry: {
				refresh: async () => {},
				setCredentialRecovery: callback => {
					recovery = callback;
				},
			},
			stateStore: stateStore("accepted"),
			recoveryDiscover: async () => {
				discoveryReads += 1;
				return discovery([
					oauthCredential({
						provider: "openai-codex",
						origin: "codex-file",
						source: "Codex CLI (test)",
					}),
				]);
			},
		});

		expect(discoveryReads).toBe(0);
		await disabledListener?.({
			provider: "openai-codex",
			disabledCause: "oauth refresh failed: invalid_grant",
		});
		expect(await recovery?.("openai-codex")).toBe(true);
		expect(discoveryReads).toBe(1);
		expect(importedProviders).toEqual(["openai-codex"]);
	});

	test("does not install local Codex recovery for a remote credential store", async () => {
		let recoveryInstallCalls = 0;
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: {
				isRemoteCredentialStore: () => true,
				onCredentialDisabled: () => () => {},
				onGenerationChanged: () => () => {},
				importCredentialIfAbsent: async provider => inserted(provider),
			},
			modelRegistry: {
				refresh: async () => {},
				setCredentialRecovery: () => {
					recoveryInstallCalls += 1;
				},
			},
			stateStore: stateStore("accepted"),
		});

		expect(recoveryInstallCalls).toBe(0);
		expect(() =>
			createAcceptedExternalCredentialRecovery({
				authStorage: {
					isRemoteCredentialStore: () => true,
					onCredentialDisabled: () => () => {},
					onGenerationChanged: () => () => {},
					importCredentialIfAbsent: async provider => inserted(provider),
				},
				modelRegistry: { refresh: async () => {} },
				stateStore: stateStore("accepted"),
			}),
		).toThrow("supported only for local credential storage");
	});

	test("retries the failed live lookup with the newly imported Codex credential", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-oauth-recovery-"));
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
				refreshOAuthCredential: async () => {
					throw new Error("401 invalid_grant");
				},
			});
			await authStorage.importCredentialIfAbsent("openai-codex", {
				type: "oauth",
				access: "stale-access",
				refresh: "stale-refresh",
				expires: Date.now() - 1,
			});
			const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
			let discoveryReads = 0;
			registry.setCredentialRecovery(
				createAcceptedExternalCredentialRecovery({
					authStorage,
					modelRegistry: registry,
					stateStore: stateStore("accepted"),
					discover: async () => {
						discoveryReads += 1;
						return discovery([
							oauthCredential({
								provider: "openai-codex",
								origin: "codex-file",
								source: "Codex CLI (test)",
								credential: {
									type: "oauth",
									access: "fresh-access",
									refresh: "fresh-refresh",
									expires: Date.now() + 10 * 60_000,
								},
								expiresAt: Date.now() + 10 * 60_000,
							}),
						]);
					},
				}),
			);

			expect(await registry.getApiKeyForProvider("openai-codex")).toBe("fresh-access");
			expect(discoveryReads).toBe(1);

			await authStorage.remove("openai-codex");
			expect(await registry.getApiKeyForProvider("openai-codex")).toBeUndefined();
			expect(discoveryReads).toBe(1);
		} finally {
			authStorage?.close();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("logout cancels real local recovery while Codex discovery is in flight", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-codex-oauth-logout-race-"));
		const discoveryStarted = Promise.withResolvers<void>();
		const releaseDiscovery = Promise.withResolvers<void>();
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
				refreshOAuthCredential: async () => {
					throw new Error("401 invalid_grant");
				},
			});
			await authStorage.importCredentialIfAbsent("openai-codex", {
				type: "oauth",
				access: "stale-race-access",
				refresh: "stale-race-refresh",
				expires: Date.now() - 1,
			});
			const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
			registry.setCredentialRecovery(
				createAcceptedExternalCredentialRecovery({
					authStorage,
					modelRegistry: registry,
					stateStore: stateStore("accepted"),
					discover: async () => {
						discoveryStarted.resolve();
						await releaseDiscovery.promise;
						return discovery([
							oauthCredential({
								provider: "openai-codex",
								origin: "codex-file",
								source: "Codex CLI (test)",
								credential: {
									type: "oauth",
									access: "fresh-race-access",
									refresh: "fresh-race-refresh",
									expires: Date.now() + 10 * 60_000,
								},
								expiresAt: Date.now() + 10 * 60_000,
							}),
						]);
					},
				}),
			);

			const lookup = registry.getApiKeyForProvider("openai-codex");
			await discoveryStarted.promise;
			await authStorage.logout("openai-codex");
			releaseDiscovery.resolve();

			expect(await lookup).toBeUndefined();
			expect(authStorage.has("openai-codex")).toBe(false);
		} finally {
			releaseDiscovery.resolve();
			authStorage?.close();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("preserves the selector that started a pinned lookup across an in-flight selector change", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-pinned-codex-selector-race-"));
		const refreshStarted = Promise.withResolvers<void>();
		const releaseRefresh = Promise.withResolvers<void>();
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
				refreshOAuthCredential: async () => {
					refreshStarted.resolve();
					await releaseRefresh.promise;
					throw new Error("401 invalid_grant");
				},
			});
			await authStorage.set("openai-codex", [
				{
					type: "oauth",
					access: "stale-first-access",
					refresh: "stale-first-refresh",
					expires: Date.now() - 1,
					accountId: "account-first",
					email: "first@example.com",
				},
				{
					type: "oauth",
					access: "fresh-second-access",
					refresh: "fresh-second-refresh",
					expires: Date.now() + 10 * 60_000,
					accountId: "account-second",
					email: "second@example.com",
				},
			]);
			authStorage.setRuntimeCredentialSelector("openai-codex", {
				kind: "email",
				value: "first@example.com",
			});

			const outcome = authStorage.getApiKey("openai-codex").then(
				value => value,
				error => error,
			);
			await refreshStarted.promise;
			authStorage.setRuntimeCredentialSelector("openai-codex", {
				kind: "email",
				value: "second@example.com",
			});
			releaseRefresh.resolve();

			const error = await outcome;
			expect(error).toBeInstanceOf(SelectedCredentialUnavailableError);
			if (!(error instanceof SelectedCredentialUnavailableError)) {
				throw new Error("Expected typed selected credential failure");
			}
			expect(error.selector).toEqual({ kind: "email", value: "first@example.com" });
		} finally {
			releaseRefresh.resolve();
			authStorage?.close();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("retries a pinned lookup only after its selected credential is definitively disabled", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-pinned-codex-oauth-recovery-"));
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
				refreshOAuthCredential: async () => {
					throw new Error("401 invalid_grant");
				},
			});
			await authStorage.importCredentialIfAbsent("openai-codex", {
				type: "oauth",
				access: "stale-pinned-access",
				refresh: "stale-pinned-refresh",
				expires: Date.now() - 1,
				accountId: "account-pinned",
				email: "pinned@example.com",
			});
			authStorage.setRuntimeCredentialSelector("openai-codex", {
				kind: "email",
				value: "PINNED@EXAMPLE.COM",
			});
			const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
			let discoveryReads = 0;
			registry.setCredentialRecovery(
				createAcceptedExternalCredentialRecovery({
					authStorage,
					modelRegistry: registry,
					stateStore: stateStore("accepted"),
					discover: async () => {
						discoveryReads += 1;
						return discovery([
							oauthCredential({
								provider: "openai-codex",
								origin: "codex-file",
								source: "Codex CLI (test)",
								identity: { accountId: "account-pinned", email: "pinned@example.com" },
								credential: {
									type: "oauth",
									access: "fresh-pinned-access",
									refresh: "fresh-pinned-refresh",
									expires: Date.now() + 10 * 60_000,
									accountId: "account-pinned",
									email: "pinned@example.com",
								},
								expiresAt: Date.now() + 10 * 60_000,
							}),
						]);
					},
				}),
			);

			expect(await registry.getApiKeyForProvider("openai-codex")).toBe("fresh-pinned-access");
			expect(discoveryReads).toBe(1);
		} finally {
			authStorage?.close();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("does not import a Codex credential that belongs to a different pinned identity", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-pinned-codex-oauth-identity-mismatch-"));
		let authStorage: AuthStorage | undefined;
		try {
			authStorage = await AuthStorage.create(path.join(agentDir, "agent.db"), {
				refreshOAuthCredential: async () => {
					throw new Error("401 invalid_grant");
				},
			});
			await authStorage.importCredentialIfAbsent("openai-codex", {
				type: "oauth",
				access: "stale-pinned-access",
				refresh: "stale-pinned-refresh",
				expires: Date.now() - 1,
				accountId: "account-pinned",
				email: "pinned@example.com",
			});
			authStorage.setRuntimeCredentialSelector("openai-codex", {
				kind: "email",
				value: "pinned@example.com",
			});
			const registry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
			let discoveryReads = 0;
			registry.setCredentialRecovery(
				createAcceptedExternalCredentialRecovery({
					authStorage,
					modelRegistry: registry,
					stateStore: stateStore("accepted"),
					discover: async () => {
						discoveryReads += 1;
						return discovery([
							oauthCredential({
								provider: "openai-codex",
								origin: "codex-file",
								source: "Codex CLI (test)",
								identity: { accountId: "account-pinned", email: "pinned@example.com" },
								credential: {
									type: "oauth",
									access: "other-access",
									refresh: "other-refresh",
									expires: Date.now() + 10 * 60_000,
									accountId: "account-other",
									email: "other@example.com",
								},
								expiresAt: Date.now() + 10 * 60_000,
							}),
						]);
					},
				}),
			);

			const error = await registry.getApiKeyForProvider("openai-codex").then(
				() => undefined,
				reason => reason,
			);
			expect(error).toBeInstanceOf(SelectedCredentialUnavailableError);
			if (!(error instanceof SelectedCredentialUnavailableError)) {
				throw new Error("Expected typed selected credential failure");
			}
			expect(error.selector).toEqual({ kind: "email", value: "pinned@example.com" });
			expect(discoveryReads).toBe(1);
			expect(authStorage.has("openai-codex")).toBe(false);
		} finally {
			authStorage?.close();
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});
});

describe("credential auto-import state classification and compatibility", () => {
	const temporaryAgentDirs: string[] = [];

	afterEach(async () => {
		await Promise.all(
			temporaryAgentDirs.splice(0).map(agentDir => fs.rm(agentDir, { recursive: true, force: true })),
		);
	});

	async function createTemporaryAgentDir(): Promise<string> {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-auto-import-"));
		temporaryAgentDirs.push(agentDir);
		return agentDir;
	}

	function createWriteTransactionBarrier(): {
		dependencies: CredentialAutoImportStateStoreDependencies;
		firstEntered: Promise<void>;
		secondEntered: Promise<void>;
		releaseNext: () => Promise<void>;
	} {
		const firstEntered = Promise.withResolvers<void>();
		const secondEntered = Promise.withResolvers<void>();
		const queued: Array<() => Promise<void>> = [];
		let entries = 0;
		const dependencies: CredentialAutoImportStateStoreDependencies = {
			withFileLock: async <T>(_statePath: string, transaction: () => Promise<T>): Promise<T> => {
				const result = Promise.withResolvers<T>();
				queued.push(async () => {
					try {
						result.resolve(await transaction());
					} catch (error) {
						result.reject(error);
					}
				});
				entries += 1;
				if (entries === 1) firstEntered.resolve();
				if (entries === 2) secondEntered.resolve();
				return result.promise;
			},
		};
		return {
			dependencies,
			firstEntered: firstEntered.promise,
			secondEntered: secondEntered.promise,
			releaseNext: async () => {
				const transaction = queued.shift();
				if (!transaction) throw new Error("No queued state transaction");
				await transaction();
			},
		};
	}

	async function writeStateTransactionsInOrder(
		agentDir: string,
		firstMutation: CredentialAutoImportStateMutation,
		secondMutation: CredentialAutoImportStateMutation,
	): Promise<[boolean, boolean]> {
		const barrier = createWriteTransactionBarrier();
		const firstStore = createCredentialAutoImportStateStore(agentDir, barrier.dependencies);
		const secondStore = createCredentialAutoImportStateStore(agentDir, barrier.dependencies);
		const firstWrite = firstStore.write(firstMutation);
		await barrier.firstEntered;
		const secondWrite = secondStore.write(secondMutation);
		await barrier.secondEntered;
		await barrier.releaseNext();
		await barrier.releaseNext();
		const [firstResult, secondResult] = await Promise.all([firstWrite, secondWrite]);
		return [firstResult, secondResult];
	}

	test("classifies malformed JSON and non-object state without projecting a resolution", async () => {
		const agentDir = await createTemporaryAgentDir();
		const statePath = getCredentialAutoImportStatePath(agentDir);
		for (const [serialized, problem] of [
			["{", "malformed-json"],
			["null", "malformed-root"],
			["[]", "malformed-root"],
		] as const) {
			await fs.writeFile(statePath, serialized);
			expect(await readCredentialAutoImportState(agentDir)).toEqual({
				state: {},
				problems: [problem],
				unreadable: false,
			});
		}
	});

	test("refuses invalid state mutations without creating a state file", async () => {
		const agentDir = await createTemporaryAgentDir();
		const store = createCredentialAutoImportStateStore(agentDir);
		expect(await store.write({ lastImportVersion: "not a version" })).toBe(false);
		expect(await store.write({ initialImportResolution: "later" as never })).toBe(false);
		expect(await fs.readdir(agentDir)).toEqual([]);
	});

	test("keeps startup discovery behind an injected unreadable state gate", async () => {
		let reads = 0;
		let writes = 0;
		let discoveryReads = 0;
		const stateStore: CredentialAutoImportStateStore = {
			read: async () => {
				reads += 1;
				return { state: {}, problems: [], unreadable: true };
			},
			write: async () => {
				writes += 1;
				return true;
			},
		};
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: { importCredentialIfAbsent: mock(async () => inserted()) },
			modelRegistry: { refresh: async () => {} } as never,
			discover: async () => {
				discoveryReads += 1;
				return discovery([oauthCredential()]);
			},
			stateStore,
		});
		expect(reads).toBe(1);
		expect(writes).toBe(0);
		expect(discoveryReads).toBe(0);
	});

	test("writes state through a mode-restricted temporary file and removes it after atomic replacement", async () => {
		const rootDir = await createTemporaryAgentDir();
		const agentDir = path.join(rootDir, "state");
		const statePath = getCredentialAutoImportStatePath(agentDir);
		expect(await createCredentialAutoImportStateStore(agentDir).write({ initialImportResolution: "accepted" })).toBe(
			true,
		);
		expect((await fs.stat(agentDir)).mode & 0o777).toBe(0o700);
		expect((await fs.stat(statePath)).mode & 0o777).toBe(0o600);
		expect((await fs.readdir(agentDir)).filter(entry => entry.includes(".tmp."))).toEqual([]);
	});

	test("keeps durable state and removes the temporary file when atomic replacement fails", async () => {
		const agentDir = await createTemporaryAgentDir();
		const statePath = getCredentialAutoImportStatePath(agentDir);
		const durableBytes = '{"initialImportResolution":"declined"}\n';
		const errorSentinel = "ATOMIC_WRITE_FAILURE_SENTINEL";
		await fs.writeFile(statePath, durableBytes);
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const store = createCredentialAutoImportStateStore(agentDir, {
				rename: async () => {
					throw new Error(errorSentinel);
				},
			});
			expect(await store.write({ lastImportVersion: "1.2.3" })).toBe(false);
			expect(await fs.readFile(statePath, "utf-8")).toBe(durableBytes);
			expect((await fs.readdir(agentDir)).filter(entry => entry.includes(".tmp."))).toEqual([]);
			expect(warning).toHaveBeenCalledWith("Credential auto-import state persistence failed", {
				classification: "state-write-failed",
			});
			expect(JSON.stringify(warning.mock.calls)).not.toContain(errorSentinel);
		} finally {
			warning.mockRestore();
		}
	});

	test("uses the normal-read projection inside the lock transaction", async () => {
		const agentDir = await createTemporaryAgentDir();
		const statePath = getCredentialAutoImportStatePath(agentDir);
		await fs.writeFile(statePath, '{"initialImportResolution":"later","lastImportVersion":"1.2.3"}\n');
		const store = createCredentialAutoImportStateStore(agentDir);
		expect(await store.read()).toEqual({
			state: { lastImportVersion: "1.2.3" },
			problems: ["invalid-initial-import-resolution"],
			unreadable: false,
		});
		expect(await store.write({ initialImportResolution: "accepted" })).toBe(true);
		expect(await fs.readFile(statePath, "utf-8")).toBe(
			'{"lastImportVersion":"1.2.3","initialImportResolution":"accepted"}\n',
		);
	});

	test("projects valid canonical resolution independently and repairs an invalid marker sibling", async () => {
		const agentDir = await createTemporaryAgentDir();
		const statePath = getCredentialAutoImportStatePath(agentDir);
		await fs.writeFile(statePath, '{"ignored":true,"initialImportResolution":"declined","lastImportVersion":7}\n');

		const initialRead = await readCredentialAutoImportState(agentDir);
		expect(initialRead.state).toEqual({ initialImportResolution: "declined" });
		expect(initialRead.problems).toEqual(["invalid-last-import-version"]);

		const store = createCredentialAutoImportStateStore(agentDir);
		expect(await store.write({ lastImportVersion: "1.2.3" })).toBe(true);
		expect(await fs.readFile(statePath, "utf-8")).toBe(
			'{"lastImportVersion":"1.2.3","initialImportResolution":"declined"}\n',
		);
	});

	test("keeps a valid marker when the canonical sibling is invalid and replaces it with the first terminal resolution", async () => {
		const agentDir = await createTemporaryAgentDir();
		const statePath = getCredentialAutoImportStatePath(agentDir);
		await fs.writeFile(statePath, '{"initialImportResolution":"later","lastImportVersion":"1.2.3"}\n');

		const initialRead = await readCredentialAutoImportState(agentDir);
		expect(initialRead.state).toEqual({ lastImportVersion: "1.2.3" });
		expect(initialRead.problems).toEqual(["invalid-initial-import-resolution"]);

		const store = createCredentialAutoImportStateStore(agentDir);
		expect(await store.write({ initialImportResolution: "accepted" })).toBe(true);
		expect(await readCredentialAutoImportState(agentDir)).toEqual({
			state: { lastImportVersion: "1.2.3", initialImportResolution: "accepted" },
			problems: [],
			unreadable: false,
		});
	});

	for (const { label, first, second, expectedBytes } of [
		{
			label: "accepted before declined",
			first: "accepted",
			second: "declined",
			expectedBytes: '{"initialImportResolution":"accepted"}\n',
		},
		{
			label: "declined before accepted",
			first: "declined",
			second: "accepted",
			expectedBytes: '{"initialImportResolution":"declined"}\n',
		},
	] as const) {
		test(`preserves the first terminal resolution with barrier-controlled ${label} writers`, async () => {
			const agentDir = await createTemporaryAgentDir();
			expect(
				await writeStateTransactionsInOrder(
					agentDir,
					{ initialImportResolution: first },
					{ initialImportResolution: second },
				),
			).toEqual([true, true]);
			expect(await fs.readFile(getCredentialAutoImportStatePath(agentDir), "utf-8")).toBe(expectedBytes);
		});
	}

	for (const { label, first, second } of [
		{
			label: "marker before resolution",
			first: { lastImportVersion: "1.2.3" },
			second: { initialImportResolution: "declined" },
		},
		{
			label: "resolution before marker",
			first: { initialImportResolution: "declined" },
			second: { lastImportVersion: "1.2.3" },
		},
	] as const) {
		test(`merges marker and terminal resolution with barrier-controlled ${label} writers`, async () => {
			const agentDir = await createTemporaryAgentDir();
			expect(await writeStateTransactionsInOrder(agentDir, first, second)).toEqual([true, true]);
			expect(await fs.readFile(getCredentialAutoImportStatePath(agentDir), "utf-8")).toBe(
				'{"lastImportVersion":"1.2.3","initialImportResolution":"declined"}\n',
			);
		});
	}

	test("accepted state is version-pinned while declined state remains durable", async () => {
		const acceptedAgentDir = await createTemporaryAgentDir();
		let acceptedDiscoveryReads = 0;
		const acceptedAuthStorage = {
			importCredentialIfAbsent: async () => skipped(),
		};
		const acceptedDiscover = async () => {
			acceptedDiscoveryReads += 1;
			return discovery([oauthCredential()]);
		};
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: acceptedAuthStorage as never,
			modelRegistry: { refresh: async () => {} } as never,
			discover: acceptedDiscover,
			version: "1.2.3",
			agentDir: acceptedAgentDir,
		});
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: acceptedAuthStorage as never,
			modelRegistry: { refresh: async () => {} } as never,
			discover: acceptedDiscover,
			version: "1.2.4",
			agentDir: acceptedAgentDir,
		});
		expect(acceptedDiscoveryReads).toBe(2);

		const declinedAgentDir = await createTemporaryAgentDir();
		const declinedStore = createCredentialAutoImportStateStore(declinedAgentDir);
		expect(await declinedStore.write({ initialImportResolution: "declined" })).toBe(true);
		let declinedDiscoveryReads = 0;
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: acceptedAuthStorage as never,
			modelRegistry: { refresh: async () => {} } as never,
			discover: async () => {
				declinedDiscoveryReads += 1;
				return discovery([oauthCredential()]);
			},
			version: "1.2.3",
			agentDir: declinedAgentDir,
		});
		expect(declinedDiscoveryReads).toBe(0);
		await runStartupCredentialAutoImportIfNeeded({
			authStorage: acceptedAuthStorage as never,
			modelRegistry: { refresh: async () => {} } as never,
			discover: async () => {
				declinedDiscoveryReads += 1;
				return discovery([oauthCredential()]);
			},
			version: "1.2.4",
			agentDir: declinedAgentDir,
		});
		expect(declinedDiscoveryReads).toBe(0);
	});

	for (const { label, serialized } of [
		{
			label: "canonical-valid marker-invalid",
			serialized: '{"initialImportResolution":"accepted","lastImportVersion":"later"}\n',
		},
		{
			label: "marker-valid canonical-invalid",
			serialized: `{"initialImportResolution":"later","lastImportVersion":"${VERSION}"}\n`,
		},
	] as const) {
		test(`startup skips discovery for ${label} state projection`, async () => {
			const agentDir = await createTemporaryAgentDir();
			const statePath = getCredentialAutoImportStatePath(agentDir);
			let discoveryReads = 0;
			await fs.writeFile(statePath, serialized);
			await runStartupCredentialAutoImportIfNeeded({
				authStorage: { importCredentialIfAbsent: async () => inserted() },
				modelRegistry: { refresh: async () => {} } as never,
				discover: async () => {
					discoveryReads += 1;
					return discovery([oauthCredential()]);
				},
				agentDir,
			});
			expect(discoveryReads).toBe(0);
			expect(await fs.readFile(statePath, "utf-8")).toBe(serialized);
		});
	}
});
describe("setup credentials keychain and preview behavior", () => {
	let stdout = "";
	let exitCode: string | number | undefined | null;

	beforeEach(() => {
		stdout = "";
		exitCode = process.exitCode;
		spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			stdout += String(chunk);
			return true;
		});
		spyOn(process.stderr, "write").mockImplementation((_chunk: string | Uint8Array) => {
			return true;
		});
	});

	afterEach(() => {
		spyOn(process.stdout, "write").mockRestore?.();
		spyOn(process.stderr, "write").mockRestore?.();
		process.exitCode = exitCode;
	});

	function deps(reads: { discover: number; keychain: number }, result: CredentialDiscoveryResult) {
		return {
			openStore: async () => ({ close: () => {} }) as never,
			createAuthStorage: () =>
				({
					reload: async () => {},
					importCredentialIfAbsent: async (provider: string) => inserted(provider),
				}) as never,
			discover: async (options?: DiscoveryOptions) => {
				reads.discover += 1;
				if (options?.readClaudeKeychain) {
					await options.readClaudeKeychain();
				} else {
					reads.keychain += 1;
				}
				return result;
			},
		};
	}

	test.each([
		["default", {}],
		["dry-run", { dryRun: true }],
		["json", { json: true }],
		["yes", { yes: true }],
	])("setup credentials %s does not invoke keychain reader", async (_label, flags) => {
		const reads = { discover: 0, keychain: 0 };
		await handleCredentialsSetup({ ...flags, dryRun: true, yes: true }, deps(reads, discovery([oauthCredential()])));
		expect(reads.discover).toBe(1);
		expect(reads.keychain).toBe(0);
	});

	test("setup credentials --keychain allows keychain discovery", async () => {
		const reads = { discover: 0, keychain: 0 };
		await handleCredentialsSetup(
			{ keychain: true, dryRun: true, yes: true },
			deps(reads, discovery([oauthCredential({ origin: "claude-code-keychain" })])),
		);
		expect(reads.discover).toBe(1);
		expect(reads.keychain).toBe(1);
	});

	test("setup preview filters API keys out of importable counts and JSON", async () => {
		const reads = { discover: 0, keychain: 0 };
		await handleCredentialsSetup({ json: true, dryRun: true }, deps(reads, discovery([apiKeyCredential()])));
		const payload = JSON.parse(stdout.trim());
		expect(payload.importable).toEqual([]);
		expect(JSON.stringify(payload)).not.toContain("api_key");
	});

	test("setup dry-run keeps expired OAuth discoveries visible but non-importable", async () => {
		const reads = { discover: 0, keychain: 0 };
		const expired = oauthCredential({
			expiresAt: 0,
			credential: { type: "oauth", access: "expired-access", refresh: "expired-refresh", expires: 0 },
		});
		await handleCredentialsSetup({ json: true, dryRun: true }, deps(reads, discovery([expired])));
		const payload = JSON.parse(stdout.trim());
		expect(payload.importable).toEqual([]);
		expect(payload.skipped).toEqual([
			expect.objectContaining({
				source: "Claude Code (test)",
				reason: "OAuth credential has no valid future expiry",
			}),
		]);
		expect(payload.imported).toEqual([]);
	});

	test("denied keychain read records sanitized skip and continues", async () => {
		const reads = { discover: 0, keychain: 0 };
		await handleCredentialsSetup(
			{ keychain: true, json: true, dryRun: true },
			deps(
				reads,
				discovery(
					[],
					[
						{
							origin: "claude-code-keychain",
							source: "Claude Code (macOS Keychain)",
							reason: "unreadable credential file (Error: denied)",
						},
					],
				),
			),
		);
		const payload = JSON.parse(stdout.trim());
		expect(payload.skipped).toHaveLength(1);
		expect(payload.skipped[0].reason).toContain("denied");
		expect(payload.imported).toEqual([]);
	});
});

describe("bare /login external credential import gate", () => {
	function inMemoryStateStore(initial: CredentialAutoImportStateFile = {}) {
		const state: CredentialAutoImportStateFile = { ...initial };
		const writes: CredentialAutoImportStateFile[] = [];
		const stateStore: CredentialAutoImportStateStore = {
			read: async () => ({ state: { ...state }, problems: [], unreadable: false }),
			write: async mutation => {
				if (mutation.lastImportVersion !== undefined) state.lastImportVersion = mutation.lastImportVersion;
				if (state.initialImportResolution === undefined && mutation.initialImportResolution !== undefined) {
					state.initialImportResolution = mutation.initialImportResolution;
				}
				writes.push({ ...state });
				return true;
			},
		};
		return { state, stateStore, writes };
	}
	function createControllerHarness(
		args: {
			confirm: boolean;
			importOutcome?: AuthCredentialIfAbsentSnapshotResult;
			importOutcomes?: Array<AuthCredentialIfAbsentSnapshotResult | Error>;
			onImport?: () => void;
			onRequestRender?: () => void;
			agentDir?: string;
		},
		stateStore?: CredentialAutoImportStateStore,
	) {
		installTestTheme();
		const importCalls: string[] = [];
		const refreshCalls: string[] = [];
		const confirmMessages: Array<{ title: string; message: string }> = [];
		const warnings: string[] = [];
		const statuses: string[] = [];
		const settingsReads: string[] = [];
		const editorContainer = new Container();
		const ctx = {
			ui: { setFocus: mock(() => {}), requestRender: mock(() => args.onRequestRender?.()) },
			editorContainer,
			editor: new Container(),
			chatContainer: new Container(),
			settings: {
				getAgentDir: () => {
					settingsReads.push("read");
					return args.agentDir ?? path.join(os.tmpdir(), "gjc-credential-auto-import-controller");
				},
			},
			showWarning: (message: string) => warnings.push(message),
			showStatus: (message: string) => statuses.push(message),
			showHookConfirm: mock(async (title: string, message: string) => {
				confirmMessages.push({ title, message });
				return args.confirm;
			}),
			session: {
				sessionId: "session-1",
				modelRegistry: {
					refresh: mock(async (mode?: string) => refreshCalls.push(mode ?? "")),
					authStorage: {
						hasAuth: () => false,
						importCredentialIfAbsent: async (provider: string) => {
							importCalls.push(provider);
							const outcome = args.importOutcomes?.shift() ?? args.importOutcome ?? inserted(provider);
							if (outcome instanceof Error) throw outcome;
							args.onImport?.();
							return outcome;
						},
					},
					getApiKeyForProvider: mock(async () => undefined),
				},
			},
		} as never;
		return {
			controller: new SelectorController(ctx, stateStore),
			importCalls,
			refreshCalls,
			confirmMessages,
			editorContainer,
			settingsReads,
			statuses,
			warnings,
		};
	}

	function bareLoginOptions(result: CredentialDiscoveryResult = discovery([oauthCredential()])) {
		return {
			allowExternalCredentialDiscovery: true,
			trigger: "bare-login" as const,
			externalCredentialDiscover: async () => result,
		};
	}

	test("bare /login shows rotation warning before persisting imported OAuth credentials", async () => {
		const state = inMemoryStateStore();
		const harness = createControllerHarness({ confirm: true }, state.stateStore);

		await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions());

		expect(harness.confirmMessages).toHaveLength(1);
		expect(harness.confirmMessages[0]?.message).toContain("Claude (Anthropic) · Claude Code file: 1");
		expect(harness.confirmMessages[0]?.message).not.toContain("Claude Code (test)");
		expect(harness.confirmMessages[0]?.message).not.toContain(oauthCredential().redactedToken);
		expect(harness.confirmMessages[0]?.message).toContain(CREDENTIAL_AUTO_IMPORT_ROTATION_WARNING);
		expect(harness.importCalls).toEqual(["anthropic"]);
		expect(harness.refreshCalls).toEqual(["offline"]);
		expect(state.state.initialImportResolution).toBe("accepted");
	});

	test("declining bare /login import persists a permanent decline without importing credentials", async () => {
		const state = inMemoryStateStore();
		const harness = createControllerHarness({ confirm: false }, state.stateStore);

		await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions());

		expect(harness.confirmMessages).toHaveLength(1);
		expect(harness.importCalls).toEqual([]);
		expect(harness.refreshCalls).toEqual([]);
		expect(state.state.initialImportResolution).toBe("declined");
	});

	test("confirmed bare /login import remains idempotent when credential already exists", async () => {
		const harness = createControllerHarness(
			{ confirm: true, importOutcome: skipped() },
			inMemoryStateStore().stateStore,
		);

		await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions());

		expect(harness.confirmMessages).toHaveLength(1);
		expect(harness.importCalls).toEqual(["anthropic"]);
		expect(harness.refreshCalls).toEqual([]);
	});

	test("bare /login leaves canonical state unresolved when every accepted credential write fails", async () => {
		const errorSentinel = "LOGIN_ALL_WRITES_FAILED_SENTINEL";
		const state = inMemoryStateStore();
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const harness = createControllerHarness(
				{ confirm: true, importOutcomes: [new Error(`write conflict ${errorSentinel}`)] },
				state.stateStore,
			);
			let discoveryReads = 0;
			await harness.controller.showOAuthSelector("login", undefined, {
				...bareLoginOptions(),
				externalCredentialDiscover: async () => {
					discoveryReads += 1;
					return discovery([oauthCredential()]);
				},
			});
			expect(discoveryReads).toBe(2);
			expect(harness.importCalls).toEqual(["anthropic"]);
			expect(state.writes).toEqual([]);
			expect(state.state).toEqual({});
			expect(harness.warnings).toEqual([CREDENTIAL_AUTO_IMPORT_RETRY_WARNING]);
			expect(harness.editorContainer.children).toHaveLength(1);
			expect(warning).toHaveBeenCalledWith("Credential auto-import completed with failures", {
				trigger: "bare-login",
				failureCounts: { "write-conflict": 1 },
			});
			const visible = JSON.stringify({
				logs: warning.mock.calls,
				confirmMessages: harness.confirmMessages,
				warnings: harness.warnings,
				statuses: harness.statuses,
			});
			expect(visible).not.toContain(errorSentinel);
		} finally {
			warning.mockRestore();
		}
	});

	test("bare /login leaves canonical state unresolved when the accepted second scan fails globally", async () => {
		const errorSentinel = "LOGIN_SECOND_SCAN_FAILURE_SENTINEL";
		const state = inMemoryStateStore();
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const harness = createControllerHarness({ confirm: true }, state.stateStore);
			let discoveryReads = 0;
			await harness.controller.showOAuthSelector("login", undefined, {
				...bareLoginOptions(),
				externalCredentialDiscover: async () => {
					discoveryReads += 1;
					if (discoveryReads === 2) throw new Error(`second scan failed ${errorSentinel}`);
					return discovery([oauthCredential()]);
				},
			});
			expect(discoveryReads).toBe(2);
			expect(harness.importCalls).toEqual([]);
			expect(state.writes).toEqual([]);
			expect(state.state).toEqual({});
			expect(harness.warnings).toEqual([CREDENTIAL_AUTO_IMPORT_RETRY_WARNING]);
			expect(harness.editorContainer.children).toHaveLength(1);
			expect(warning).toHaveBeenCalledWith("Credential auto-import completed with failures", {
				trigger: "bare-login",
				failureCounts: { "discovery-unavailable": 1 },
			});
			const visible = JSON.stringify({
				logs: warning.mock.calls,
				confirmMessages: harness.confirmMessages,
				warnings: harness.warnings,
				statuses: harness.statuses,
			});
			expect(visible).not.toContain(errorSentinel);
		} finally {
			warning.mockRestore();
		}
	});

	test("bare /login keeps accepted state and exposes only bounded mixed failure evidence", async () => {
		const sourceSentinel = "LOGIN_SOURCE_SENTINEL";
		const reasonSentinel = "LOGIN_REASON_SENTINEL";
		const environmentSentinel = "LOGIN_ENVIRONMENT_SENTINEL";
		const errorSentinel = "LOGIN_ERROR_SENTINEL";
		const result: CredentialDiscoveryResult = {
			importable: [
				oauthCredential({ source: sourceSentinel }),
				oauthCredential({ provider: "openai-codex", origin: "codex-file", source: sourceSentinel }),
				oauthCredential({ source: sourceSentinel }),
			],
			skipped: [{ origin: "claude-code-file", source: sourceSentinel, reason: `unreadable ${reasonSentinel}` }],
			environment: [{ provider: "anthropic", variable: environmentSentinel, redactedValue: environmentSentinel }],
		};
		const state = inMemoryStateStore();
		const warning = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const harness = createControllerHarness(
				{
					confirm: true,
					importOutcomes: [
						inserted("anthropic"),
						skipped("openai-codex"),
						new Error(`write conflict ${errorSentinel}`),
					],
				},
				state.stateStore,
			);
			await harness.controller.showOAuthSelector("login", undefined, bareLoginOptions(result));
			expect(state.state.initialImportResolution).toBe("accepted");
			expect(harness.importCalls).toEqual(["anthropic", "openai-codex", "anthropic"]);
			expect(harness.warnings).toEqual([CREDENTIAL_AUTO_IMPORT_RETRY_WARNING]);
			expect(warning).toHaveBeenCalledWith("Credential auto-import completed with failures", {
				trigger: "bare-login",
				failureCounts: { "source-unreadable": 1, "write-conflict": 1 },
			});
			const visible = JSON.stringify({
				state: state.state,
				logs: warning.mock.calls,
				confirmMessages: harness.confirmMessages,
				warnings: harness.warnings,
				statuses: harness.statuses,
			});
			for (const sentinel of [sourceSentinel, reasonSentinel, environmentSentinel, errorSentinel]) {
				expect(visible).not.toContain(sentinel);
			}
		} finally {
			warning.mockRestore();
		}
	});

	test("resolved and same-version legacy state suppress bare /login discovery before preview", async () => {
		for (const initialState of [
			{ initialImportResolution: "accepted" as const },
			{ initialImportResolution: "declined" as const },
			{ lastImportVersion: VERSION },
		]) {
			const state = inMemoryStateStore(initialState);
			const harness = createControllerHarness({ confirm: true }, state.stateStore);
			let discoveryReads = 0;
			await harness.controller.showOAuthSelector("login", undefined, {
				...bareLoginOptions(),
				externalCredentialDiscover: async () => {
					discoveryReads += 1;
					return discovery([oauthCredential()]);
				},
			});
			expect(discoveryReads).toBe(0);
			expect(harness.confirmMessages).toHaveLength(0);
		}
	});

	test("bare /login reads resolved state from the configured agent directory", async () => {
		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-auto-import-controller-"));
		try {
			await createCredentialAutoImportStateStore(agentDir).write({ initialImportResolution: "declined" });
			const harness = createControllerHarness({ confirm: true, agentDir });
			let discoveryReads = 0;
			await harness.controller.showOAuthSelector("login", undefined, {
				...bareLoginOptions(),
				externalCredentialDiscover: async () => {
					discoveryReads += 1;
					return discovery();
				},
			});
			expect(harness.settingsReads).toEqual(["read"]);
			expect(discoveryReads).toBe(0);
			expect(harness.confirmMessages).toHaveLength(0);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	for (const { label, serialized } of [
		{
			label: "canonical-valid marker-invalid",
			serialized: '{"initialImportResolution":"accepted","lastImportVersion":"later"}\n',
		},
		{
			label: "marker-valid canonical-invalid",
			serialized: `{"initialImportResolution":"later","lastImportVersion":"${VERSION}"}\n`,
		},
	] as const) {
		test(`bare /login skips discovery for ${label} state projection`, async () => {
			const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-auto-import-controller-"));
			const statePath = getCredentialAutoImportStatePath(agentDir);
			try {
				await fs.writeFile(statePath, serialized);
				const harness = createControllerHarness({ confirm: true, agentDir });
				let discoveryReads = 0;
				await harness.controller.showOAuthSelector("login", undefined, {
					...bareLoginOptions(),
					externalCredentialDiscover: async () => {
						discoveryReads += 1;
						return discovery([oauthCredential()]);
					},
				});
				expect(harness.settingsReads).toEqual(["read"]);
				expect(discoveryReads).toBe(0);
				expect(harness.confirmMessages).toHaveLength(0);
				expect(await fs.readFile(statePath, "utf-8")).toBe(serialized);
			} finally {
				await fs.rm(agentDir, { recursive: true, force: true });
			}
		});
	}

	test("persists accepted and declined across controller restart with real state I/O", async () => {
		for (const [resolution, confirm] of [
			["accepted", true],
			["declined", false],
		] as const) {
			const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-auto-import-controller-"));
			try {
				let firstDiscoveryReads = 0;
				const first = createControllerHarness({ confirm, agentDir });
				await first.controller.showOAuthSelector("login", undefined, {
					...bareLoginOptions(),
					externalCredentialDiscover: async () => {
						firstDiscoveryReads += 1;
						return discovery([oauthCredential()]);
					},
				});
				expect(first.settingsReads).toEqual(["read"]);
				expect(firstDiscoveryReads).toBe(confirm ? 2 : 1);
				expect(await readCredentialAutoImportState(agentDir)).toEqual({
					state: {
						initialImportResolution: resolution,
						...(resolution === "accepted" ? { lastImportVersion: VERSION } : {}),
					},
					problems: [],
					unreadable: false,
				});

				let restartDiscoveryReads = 0;
				const restarted = createControllerHarness({ confirm: true, agentDir });
				await restarted.controller.showOAuthSelector("login", undefined, {
					...bareLoginOptions(),
					externalCredentialDiscover: async () => {
						restartDiscoveryReads += 1;
						return discovery([oauthCredential()]);
					},
				});
				expect(restarted.settingsReads).toEqual(["read"]);
				expect(restartDiscoveryReads).toBe(0);
				expect(restarted.confirmMessages).toEqual([]);
				expect(restarted.importCalls).toEqual([]);
			} finally {
				await fs.rm(agentDir, { recursive: true, force: true });
			}
		}
	});

	test("old legacy marker remains eligible and failed persistence re-offers after a real-state restart", async () => {
		const oldMarker = inMemoryStateStore({ lastImportVersion: "0.0.1" });
		const oldMarkerHarness = createControllerHarness({ confirm: false }, oldMarker.stateStore);
		await oldMarkerHarness.controller.showOAuthSelector("login", undefined, bareLoginOptions());
		expect(oldMarkerHarness.confirmMessages).toHaveLength(1);

		const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "gjc-credential-auto-import-controller-"));
		try {
			const realStateStore = createCredentialAutoImportStateStore(agentDir);
			let writes = 0;
			const failingStateStore: CredentialAutoImportStateStore = {
				read: realStateStore.read,
				write: async () => {
					writes += 1;
					return false;
				},
			};
			const first = createControllerHarness({ confirm: false, agentDir }, failingStateStore);
			await first.controller.showOAuthSelector("login", undefined, bareLoginOptions());
			expect(writes).toBe(1);
			expect(first.warnings).toEqual([CREDENTIAL_AUTO_IMPORT_PERSISTENCE_WARNING]);
			expect(await readCredentialAutoImportState(agentDir)).toEqual({ state: {}, problems: [], unreadable: false });

			let retryDiscoveryReads = 0;
			const restarted = createControllerHarness({ confirm: false, agentDir }, failingStateStore);
			await restarted.controller.showOAuthSelector("login", undefined, {
				...bareLoginOptions(),
				externalCredentialDiscover: async () => {
					retryDiscoveryReads += 1;
					return discovery([oauthCredential()]);
				},
			});
			expect(retryDiscoveryReads).toBe(1);
			expect(restarted.confirmMessages).toHaveLength(1);
		} finally {
			await fs.rm(agentDir, { recursive: true, force: true });
		}
	});

	test("explicit provider credential import bypasses automatic import state after the final render", async () => {
		let discoveryReads = 0;
		const { promise: importCompleted, resolve: resolveImport } = Promise.withResolvers<void>();
		const discoverSpy = spyOn(credentialImport, "discoverExternalCredentials").mockImplementation(async () => {
			discoveryReads += 1;
			return discovery([oauthCredential()]);
		});
		let stateReads = 0;
		let stateWrites = 0;
		const stateStore: CredentialAutoImportStateStore = {
			read: async () => {
				stateReads += 1;
				return { state: {}, problems: [], unreadable: false };
			},
			write: async () => {
				stateWrites += 1;
				return true;
			},
		};
		let importStarted = false;
		try {
			const harness = createControllerHarness(
				{
					confirm: true,
					onImport: () => {
						importStarted = true;
					},
					onRequestRender: () => {
						if (importStarted) resolveImport();
					},
				},
				stateStore,
			);
			harness.controller.showProviderOnboarding();
			const selector = harness.editorContainer.children[0];
			if (!(selector instanceof ProviderOnboardingSelectorComponent)) {
				throw new Error("Expected provider onboarding selector");
			}
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");
			selector.handleInput("\n");
			await importCompleted;
			expect(discoveryReads).toBe(2);
			expect(harness.importCalls).toEqual(["anthropic"]);
			expect(stateReads).toBe(0);
			expect(stateWrites).toBe(0);
			expect(harness.settingsReads).toEqual([]);
		} finally {
			discoverSpy.mockRestore();
		}
	});
});
