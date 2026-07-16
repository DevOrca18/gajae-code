import { describe, expect, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseDaemonArgs, runDaemonCommand, UnknownDaemonKindError } from "../src/cli/daemon-cli";
import { Settings } from "../src/config/settings";
import { createBuiltInDaemonControllers, selectDaemonControllers } from "../src/daemon/builtin";
import type { BuiltInDaemonController, DaemonOperationResult, DaemonStatus } from "../src/daemon/control-types";
import {
	DAEMON_ACTION_ALIASES,
	formatDaemonResult,
	formatDaemonStatus,
	OWNERSHIP_MISMATCH_MESSAGE,
	ownershipMismatchRecovery,
	resolveDaemonAction,
} from "../src/daemon/operator-contract";
import { resolveGjcRuntimeSpawnInfo } from "../src/daemon/runtime";
import {
	acquireChatDaemonOwnership,
	buildChatDaemonSpawnArgs,
	ChatDaemonController,
	chatDaemonGeneration,
	chatDaemonPaths,
	ensureDiscordDaemon,
	ensureSlackDaemon,
	hasSafeChatDaemonStateShape,
	releaseChatDaemonOwnership,
} from "../src/sdk/bus/chat-daemon-control";
import { tokenFingerprint } from "../src/sdk/bus/config";
import { DAEMON_GENERATION, daemonPaths, renewDaemonHeartbeat } from "../src/sdk/bus/telegram-daemon";
import {
	clearTelegramControlRequest,
	readTelegramControlRequest,
	TelegramDaemonController,
	writeTelegramControlRequest,
} from "../src/sdk/bus/telegram-daemon-control";
import { TopicRegistry } from "../src/sdk/bus/topic-registry";

const BOT_TOKEN = "123456:secret-token";

function tempAgentDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "gjc-daemon-control-test-"));
}

function setPrivateAgentDir(s: Settings, agentDir: string): Settings {
	return new Proxy(s, {
		get(target, prop) {
			if (prop === "getAgentDir") return () => agentDir;
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as Settings;
}

function settings(agentDir: string): Settings {
	return setPrivateAgentDir(
		Settings.isolated({
			"notifications.enabled": true,
			"notifications.telegram.botToken": BOT_TOKEN,
			"notifications.telegram.chatId": "42",
		}) as Settings,
		agentDir,
	);
}

function writeState(agentDir: string, state: Record<string, unknown>): void {
	const paths = daemonPaths(agentDir);
	fs.mkdirSync(paths.dir, { recursive: true });
	fs.writeFileSync(paths.state, JSON.stringify(state));
}

function freshState(extra: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		pid: 999,
		incarnation: "stable",
		ownerId: "old",
		tokenFingerprint: tokenFingerprint(BOT_TOKEN),
		chatId: "42",
		startedAt: Date.now(),
		heartbeatAt: Date.now(),
		roots: [],
		version: 1,
		acquisitionId: "old",
		ownershipPhase: "ready",
		generation: DAEMON_GENERATION,
		...extra,
	};
}

function readyTelegramSpawnFixture({
	settings,
	firstChildPid,
	onSpawn,
}: {
	settings: Settings;
	firstChildPid: number;
	onSpawn?: (pid: number, command: string, args: string[]) => void;
}) {
	let nextChildPid = firstChildPid;
	let pending: { ownerId: string; pid: number } | undefined;
	return {
		spawn: (command: string, args: string[]) => {
			const ownerId = args[args.indexOf("--owner-id") + 1]!;
			const pid = nextChildPid++;
			pending = { ownerId, pid };
			onSpawn?.(pid, command, args);
			return { pid, unref() {} };
		},
		sleep: async () => {
			if (!pending) return;
			expect(
				await renewDaemonHeartbeat({
					settings,
					ownerId: pending.ownerId,
					acquisitionId: pending.ownerId,
					pid: pending.pid,
					pidIncarnation: () => "stable",
				}),
			).toBe(true);
		},
	};
}

async function captureStdout(fn: () => Promise<void>): Promise<string> {
	const orig = process.stdout.write.bind(process.stdout);
	let out = "";
	process.stdout.write = ((chunk: unknown): boolean => {
		out += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		await fn();
	} finally {
		process.stdout.write = orig;
	}
	return out;
}

describe("daemon runtime detection", () => {
	test("source runtime picks up edits; compiled warns", () => {
		const source = resolveGjcRuntimeSpawnInfo("/usr/local/bin/node");
		expect(source.mode).toBe("source");
		expect(source.reloadPicksUpSourceEdits).toBe(true);
		expect(source.warning).toBeUndefined();

		const compiled = resolveGjcRuntimeSpawnInfo("/opt/gjc/gjc");
		expect(compiled.mode).toBe("compiled");
		expect(compiled.reloadPicksUpSourceEdits).toBe(false);
		expect(compiled.warning).toContain("Rebuild");
		expect(compiled.argsPrefix).toEqual([]);
	});

	test("chat daemon spawn uses source and compiled command forms", () => {
		const source = buildChatDaemonSpawnArgs({
			kind: "discord",
			ownerId: "owner-source",
			agentDir: "/tmp/agent",
			execPath: "/usr/local/bin/bun",
		});
		expect(source.args).toEqual(expect.arrayContaining(["daemon", "discord-internal", "--owner-id", "owner-source"]));
		expect(source.runtime.mode).toBe("source");

		const compiled = buildChatDaemonSpawnArgs({
			kind: "slack",
			ownerId: "owner-compiled",
			agentDir: "/tmp/agent",
			execPath: "/opt/gjc/gjc",
		});
		expect(compiled.command).toBe("/opt/gjc/gjc");
		expect(compiled.args[0]).toBe("daemon");
		expect(compiled.args).toEqual(expect.arrayContaining(["slack-internal", "--agent-dir", "/tmp/agent"]));
		expect(compiled.runtime.mode).toBe("compiled");
	});
});

describe("static built-in controller map", () => {
	test("createBuiltInDaemonControllers exposes every built-in kind", () => {
		const s = settings(tempAgentDir());
		const map = createBuiltInDaemonControllers(s);
		expect(Object.keys(map)).toEqual(["telegram", "discord", "slack"]);
		expect(map.telegram).toBeInstanceOf(TelegramDaemonController);
		expect(map.discord).toBeInstanceOf(ChatDaemonController);
		expect(map.slack).toBeInstanceOf(ChatDaemonController);
	});

	test("selectDaemonControllers defaults to Telegram, selects all kinds, and rejects unknown kinds", () => {
		const s = settings(tempAgentDir());
		expect(selectDaemonControllers(s, undefined, false)).toHaveLength(1);
		expect(selectDaemonControllers(s, ["telegram"], false)).toHaveLength(1);
		expect(selectDaemonControllers(s, undefined, true).map(controller => controller.kind)).toEqual([
			"telegram",
			"discord",
			"slack",
		]);
		expect(() => selectDaemonControllers(s, ["mystery" as never], false)).toThrow(/unknown daemon kind/);
	});
});

describe("parseDaemonArgs", () => {
	test("parses all kinds and internal worker flags", () => {
		const parsed = parseDaemonArgs([
			"daemon",
			"reload",
			"telegram",
			"discord",
			"slack",
			"--all",
			"--json",
			"--force",
			"--graceful-timeout-ms",
			"1500",
		]);
		expect(parsed).toMatchObject({
			action: "reload",
			kinds: ["telegram", "discord", "slack"],
			all: true,
			json: true,
			force: true,
			gracefulTimeoutMs: 1500,
		});

		expect(
			parseDaemonArgs(["daemon", "discord-internal", "--smoke", "--owner-id", "owner", "--agent-dir", "/tmp/a"]),
		).toMatchObject({
			action: "discord-internal",
			smoke: true,
			ownerId: "owner",
			agentDir: "/tmp/a",
		});
	});

	test("defaults to status and ignores non-daemon argv", () => {
		expect(parseDaemonArgs(["notify", "status"])).toBeUndefined();
		expect(parseDaemonArgs(["daemon"])?.action).toBe("status");
	});

	test("unknown kinds throw a typed error before settings initialization", async () => {
		await expect(
			runDaemonCommand({ action: "status", kinds: ["mystery" as never], all: false, json: false, force: false }),
		).rejects.toBeInstanceOf(UnknownDaemonKindError);
	});

	test("resolves the restart alias to reload and parses --verbose/-v", () => {
		expect(parseDaemonArgs(["daemon", "restart"])?.action).toBe("reload");
		expect(parseDaemonArgs(["daemon", "restart", "telegram"])?.kinds).toEqual(["telegram"]);
		expect(parseDaemonArgs(["daemon", "status", "--verbose"])?.verbose).toBe(true);
		expect(parseDaemonArgs(["daemon", "status", "-v"])?.verbose).toBe(true);
		expect(parseDaemonArgs(["daemon", "status"])?.verbose).toBe(false);
	});
});

describe("daemon operator contract", () => {
	test("resolveDaemonAction maps canonical verbs and the restart alias", () => {
		expect(resolveDaemonAction("status")).toBe("status");
		expect(resolveDaemonAction("reload")).toBe("reload");
		expect(resolveDaemonAction("restart")).toBe("reload");
		expect(DAEMON_ACTION_ALIASES.restart).toBe("reload");
		expect(resolveDaemonAction("bogus")).toBeUndefined();
		expect(resolveDaemonAction(undefined)).toBeUndefined();
	});

	test("formatDaemonStatus stays concise by default and expands under verbose", () => {
		const status: DaemonStatus = {
			kind: "telegram",
			configured: true,
			health: "running",
			pid: 7,
			ownerId: "o1",
			startedAt: 0,
			heartbeatAt: 0,
			roots: ["/a", "/b"],
			rootCount: 2,
			runtime: { mode: "source", execPath: "/usr/bin/node", reloadPicksUpSourceEdits: true },
		};
		const concise = formatDaemonStatus(status);
		expect(concise).toBe("telegram: running (pid 7, owner o1, 2 roots)");
		expect(concise).not.toContain("/a");

		const verbose = formatDaemonStatus(status, { verbose: true });
		expect(verbose).toContain("runtime: source (/usr/bin/node)");
		expect(verbose).toContain("roots: 2");
		expect(verbose).toContain("- /a");
		expect(verbose).toContain("- /b");
	});

	test("formatDaemonStatus reports an unconfigured daemon without runtime noise", () => {
		const status: DaemonStatus = {
			kind: "telegram",
			configured: false,
			health: "not_configured",
			runtime: { mode: "source", execPath: "/usr/bin/node", reloadPicksUpSourceEdits: true },
		};
		expect(formatDaemonStatus(status)).toBe("telegram: not configured");
	});

	test("formatDaemonResult renders the ownership-mismatch recovery steps", () => {
		const recovery = ownershipMismatchRecovery();
		expect(recovery.reason).toBe("ownership_mismatch");
		expect(recovery.steps.length).toBeGreaterThan(0);

		const result: DaemonOperationResult = {
			kind: "telegram",
			action: "reload",
			ok: false,
			warnings: [],
			message: OWNERSHIP_MISMATCH_MESSAGE,
			recovery,
		};
		const rendered = formatDaemonResult(result);
		expect(rendered).toContain("telegram reload: failed");
		expect(rendered).toContain(OWNERSHIP_MISMATCH_MESSAGE);
		expect(rendered).toContain("to recover:");
		expect(rendered).toContain("1. ");
		for (const step of recovery.steps) expect(rendered).toContain(step);
	});
});

describe("control request helpers", () => {
	test("write/read/clear roundtrip is owner-scoped", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		await writeTelegramControlRequest(s, {
			version: 1,
			requestId: "r1",
			action: "reload",
			ownerId: "owner-a",
			pid: 123,
			createdAt: Date.now(),
		});
		const read = await readTelegramControlRequest(s);
		expect(read?.requestId).toBe("r1");
		expect(read?.ownerId).toBe("owner-a");

		// Clearing with a mismatched requestId must not remove a newer request.
		await clearTelegramControlRequest(s, "different-id");
		expect(await readTelegramControlRequest(s)).toBeTruthy();

		await clearTelegramControlRequest(s, "r1");
		expect(await readTelegramControlRequest(s)).toBeUndefined();
	});
});

describe("TelegramDaemonController.status", () => {
	test("reports not_configured when token/chat missing", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(Settings.isolated({}) as Settings, agentDir);
		const status = await new TelegramDaemonController(s).status();
		expect(status.configured).toBe(false);
		expect(status.health).toBe("not_configured");
	});

	test("reports not_configured for blank Telegram credentials even when another adapter is configured", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.telegram.botToken": " ",
				"notifications.telegram.chatId": "\t",
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.parentChannelId": "discord-channel",
			}) as Settings,
			agentDir,
		);
		const status = await new TelegramDaemonController(s).status();

		expect(status.configured).toBe(false);
		expect(status.health).toBe("not_configured");
	});

	test("reports running for a fresh live owner and stopped for a dead one", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());

		const running = await new TelegramDaemonController(s, {
			pidAlive: () => true,
			pidIncarnation: () => "stable",
		}).status();
		expect(running.health).toBe("running");
		expect(running.pid).toBe(999);
		expect(running.ownerId).toBe("old");

		const stopped = await new TelegramDaemonController(s, { pidAlive: () => false }).status();
		expect(stopped.health).toBe("stopped");
	});
});

describe("Telegram daemon PID provenance fencing", () => {
	test("refuses stop and forced reload when a live PID has a reused or unavailable incarnation", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		for (const incarnation of ["reused", undefined] as const) {
			writeState(agentDir, freshState());
			fs.writeFileSync(daemonPaths(agentDir).lock, "");
			const signals: NodeJS.Signals[] = [];
			const result = await new TelegramDaemonController(s, {
				pidAlive: pid => pid === 999,
				pidIncarnation: () => incarnation,
				sendSignal: (_pid, signal) => signals.push(signal),
			}).reload({ force: true, spawnIfStopped: false });
			expect(result.ok).toBe(true);
			expect(signals).toEqual([]);
		}
	});
});

describe("TelegramDaemonController.reload", () => {
	test("cooperatively stops the old owner and spawns a fresh one", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState({ generation: DAEMON_GENERATION - 1 }));
		fs.writeFileSync(daemonPaths(agentDir).lock, "");

		const alive = new Set<number>([999, 4242]);
		const signals: Array<[number, string]> = [];
		const spawns: Array<{ command: string; args: string[] }> = [];
		const child = readyTelegramSpawnFixture({
			settings: s,
			firstChildPid: 4243,
			onSpawn: (pid, command, args) => {
				alive.add(pid);
				spawns.push({ command, args });
			},
		});
		const ctrl = new TelegramDaemonController(s, {
			ownerPid: 4242,
			pidAlive: pid => alive.has(pid),
			pidIncarnation: () => "stable",
			sendSignal: (pid, sig) => {
				signals.push([pid, sig]);
				if (sig === "SIGTERM") alive.delete(999);
			},
			spawn: child.spawn,
			sleep: child.sleep,
		});

		const result = await ctrl.reload();
		expect(result.ok).toBe(true);
		expect(signals).toContainEqual([999, "SIGTERM"]);
		expect(spawns).toHaveLength(1);
		const after = JSON.parse(fs.readFileSync(daemonPaths(agentDir).state, "utf8")) as {
			ownerId: string;
			pid: number;
			generation?: number;
		};
		expect(after.ownerId).not.toBe("old");
		expect(after.ownerId.startsWith("4242-")).toBe(true);
		expect(after.pid).toBe(4243);
		expect(after.generation).toBe(DAEMON_GENERATION);
		// No leftover control request after a successful reload.
		expect(await readTelegramControlRequest(s)).toBeUndefined();
	});

	test("reload accepts a successor only when its PID incarnation still matches", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState({ generation: DAEMON_GENERATION - 1 }));
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		let oldAlive = true;
		let published = false;
		const result = await new TelegramDaemonController(s, {
			pidAlive: pid => (pid === 999 ? oldAlive : pid === 1001),
			pidIncarnation: pid => (pid === 1001 ? "successor" : "stable"),
			sendSignal: () => undefined,
			sleep: async () => {
				if (published) return;
				published = true;
				oldAlive = false;
				writeState(
					agentDir,
					freshState({ pid: 1001, incarnation: "successor", ownerId: "next", acquisitionId: "next" }),
				);
			},
			waitStepMs: 1,
		}).reload({ gracefulTimeoutMs: 5 });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("attached");
	});

	test("escalates to SIGKILL when the old owner ignores SIGTERM", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");

		const alive = new Set<number>([999, 4242]);
		const signals: Array<[number, string]> = [];
		const child = readyTelegramSpawnFixture({
			settings: s,
			firstChildPid: 4244,
			onSpawn: pid => alive.add(pid),
		});
		const ctrl = new TelegramDaemonController(s, {
			ownerPid: 4242,
			pidAlive: pid => alive.has(pid),
			pidIncarnation: () => "stable",
			sendSignal: (pid, sig) => {
				signals.push([pid, sig]);
				if (sig === "SIGKILL") alive.delete(999);
			},
			spawn: child.spawn,
			sleep: child.sleep,
			waitStepMs: 1,
		});

		const result = await ctrl.reload({ gracefulTimeoutMs: 5, killTimeoutMs: 50, force: true });
		expect(result.ok).toBe(true);
		expect(signals.some(([, sig]) => sig === "SIGTERM")).toBe(true);
		expect(signals.some(([, sig]) => sig === "SIGKILL")).toBe(true);
	});

	test("does not escalate or kill when ownership changes mid-wait", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");

		const alive = new Set<number>([999, process.pid, 1000]);
		const signals: Array<[number, string]> = [];
		let mutated = false;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			pidIncarnation: () => "stable",
			// SIGTERM never kills 999 here; ownership changes underneath instead.
			sendSignal: (pid, sig) => signals.push([pid, sig]),
			spawn: () => ({ unref() {} }),
			sleep: async () => {
				if (!mutated) {
					mutated = true;
					writeState(agentDir, freshState({ ownerId: "newer", pid: 1000 }));
				}
			},
			waitStepMs: 1,
		});

		const result = await ctrl.reload({ gracefulTimeoutMs: 50 });
		expect(result.ok).toBe(false);
		// We must never SIGKILL a different/newer owner.
		expect(signals.some(([, sig]) => sig === "SIGKILL")).toBe(false);
		expect(result.message).toMatch(/ownership changed before the captured daemon exited/i);
	});

	test("without --force, an unresponsive old daemon is not killed or replaced", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		const alive = new Set<number>([999, process.pid]);
		const signals: Array<[number, string]> = [];
		let spawnCalls = 0;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			pidIncarnation: () => "stable",
			sendSignal: (pid, sig) => signals.push([pid, sig]),
			spawn: () => {
				spawnCalls++;
				return { unref() {} };
			},
			sleep: async () => undefined,
			waitStepMs: 1,
		});
		const result = await ctrl.reload({ gracefulTimeoutMs: 5 });
		expect(result.ok).toBe(false);
		expect(signals.some(([, sig]) => sig === "SIGKILL")).toBe(false);
		expect(spawnCalls).toBe(0);
		expect(result.message).toMatch(/--force/);
	});

	test("keeps configured credentials out of stale-owner status and reload failure evidence", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		let now = 1_000;
		writeState(agentDir, freshState({ startedAt: now, heartbeatAt: now }));
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		const ctrl = new TelegramDaemonController(s, {
			now: () => now,
			pidAlive: pid => pid === 999,
			pidIncarnation: () => "stable",
			sendSignal: () => undefined,
			sleep: async () => {
				now += 5;
			},
			waitStepMs: 5,
		});

		const status = await ctrl.status();
		const result = await ctrl.reload({ gracefulTimeoutMs: 5 });
		const observable = JSON.stringify({ status, result });
		expect(result.ok).toBe(false);
		expect(observable).not.toContain(BOT_TOKEN);
		expect(observable).not.toContain("secret-token");
	});

	test("never spawns while the captured old pid is still alive (stale changed-owner)", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		// 999 stays alive; ownership flips to a DEAD different owner (pid 1000 not alive).
		const alive = new Set<number>([999]);
		let spawnCalls = 0;
		let mutated = false;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			pidIncarnation: () => "stable",
			sendSignal: () => undefined,
			spawn: () => {
				spawnCalls++;
				return { unref() {} };
			},
			sleep: async () => {
				if (!mutated) {
					mutated = true;
					writeState(agentDir, freshState({ ownerId: "stale-newer", pid: 1000 }));
				}
			},
			waitStepMs: 1,
		});
		const result = await ctrl.reload({ gracefulTimeoutMs: 20, force: true });
		// Old pid 999 never died and the changed owner is not live -> must not spawn.
		expect(spawnCalls).toBe(0);
		expect(result.ok).toBe(false);
	});

	test("spawns the fresh owner only after the old pid is confirmed dead (no poll overlap)", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		const alive = new Set<number>([999, 4242]);
		let oldAliveAtSpawn: boolean | undefined;
		const child = readyTelegramSpawnFixture({
			settings: s,
			firstChildPid: 4245,
			onSpawn: pid => {
				alive.add(pid);
				oldAliveAtSpawn = alive.has(999);
			},
		});
		const ctrl = new TelegramDaemonController(s, {
			ownerPid: 4242,
			pidAlive: pid => alive.has(pid),
			pidIncarnation: () => "stable",
			sendSignal: (_pid, sig) => {
				if (sig === "SIGTERM") alive.delete(999);
			},
			spawn: child.spawn,
			sleep: child.sleep,
		});
		const result = await ctrl.reload();
		expect(result.ok).toBe(true);
		// The no-409 invariant: the old poller must be dead before a new one spawns.
		expect(oldAliveAtSpawn).toBe(false);
	});

	test("rejects an unknown kind with a typed error", async () => {
		await expect(
			runDaemonCommand(
				{ action: "status", kinds: ["bogus" as never], all: false, json: true, force: false },
				{ controllers: undefined },
			),
		).rejects.toMatchObject({
			message: "Unknown daemon kind(s): bogus. Known kinds: telegram, discord, slack.",
			kinds: ["bogus"],
			knownKinds: ["telegram", "discord", "slack"],
		});
	});

	test("reload with no running daemon spawns a fresh one (spawnIfStopped default)", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		const spawns: Array<{ command: string; args: string[] }> = [];
		let childPid: number | undefined;
		const child = readyTelegramSpawnFixture({
			settings: s,
			firstChildPid: 4246,
			onSpawn: (pid, command, args) => {
				childPid = pid;
				spawns.push({ command, args });
			},
		});
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => pid === childPid,
			pidIncarnation: () => "stable",
			spawn: child.spawn,
			sleep: child.sleep,
		});
		const result = await ctrl.reload();
		expect(result.ok).toBe(true);
		expect(spawns).toHaveLength(1);
	});
	test("reloads a physically-live matching owner whose heartbeat is stale (hung owner)", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		// Physically alive (pid 999) but heartbeat far past the TTL: status is "stale",
		// not "running". A forced reload must still cooperatively signal and replace it.
		writeState(agentDir, freshState({ heartbeatAt: Date.now() - 60 * 60_000 }));
		fs.writeFileSync(daemonPaths(agentDir).lock, "");

		const alive = new Set<number>([999, 4242]);
		const signals: Array<[number, string]> = [];
		const spawns: Array<{ command: string; args: string[] }> = [];
		const child = readyTelegramSpawnFixture({
			settings: s,
			firstChildPid: 4247,
			onSpawn: (pid, command, args) => {
				alive.add(pid);
				spawns.push({ command, args });
			},
		});
		const ctrl = new TelegramDaemonController(s, {
			ownerPid: 4242,
			pidAlive: pid => alive.has(pid),
			pidIncarnation: () => "stable",
			sendSignal: (pid, sig) => {
				signals.push([pid, sig]);
				if (sig === "SIGTERM") alive.delete(999);
			},
			spawn: child.spawn,
			sleep: child.sleep,
		});

		expect((await ctrl.status()).health).toBe("stale");
		const result = await ctrl.reload({ force: true });
		expect(result.ok).toBe(true);
		expect(signals).toContainEqual([999, "SIGTERM"]);
		expect(spawns).toHaveLength(1);
	});
	test("reload without --force refuses a stale-heartbeat live owner (no signal)", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState({ heartbeatAt: Date.now() - 60 * 60_000 }));
		fs.writeFileSync(daemonPaths(agentDir).lock, "");

		const signals: Array<[number, string]> = [];
		let spawnCalls = 0;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => pid === 999,
			pidIncarnation: () => "stable",
			sendSignal: (pid, sig) => signals.push([pid, sig]),
			spawn: () => {
				spawnCalls++;
				return { unref() {} };
			},
			sleep: async () => undefined,
			waitStepMs: 1,
			readinessTimeoutMs: 1,
		});

		expect((await ctrl.status()).health).toBe("stale");
		const result = await ctrl.reload();
		expect(result.ok).toBe(false);
		expect(signals).toEqual([]);
		expect(spawnCalls).toBe(0);
	});
});

describe("renewDaemonHeartbeat steal-lock contention", () => {
	test("recovers when the steal lock is briefly held then released (bind-vs-heartbeat race)", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState({ heartbeatAt: 1 }));
		const paths = daemonPaths(agentDir);
		// A concurrent lifecycle op (e.g. bindProvisionalDaemonPid) holds the steal lock,
		// releasing it after the first retry sleep.
		fs.writeFileSync(paths.steal, "");
		let slept = 0;
		const ok = await renewDaemonHeartbeat({
			settings: s,
			ownerId: "old",
			acquisitionId: "old",
			pid: 999,
			generation: DAEMON_GENERATION,
			pidIncarnation: () => "stable",
			now: () => 5_000,
			stealRetries: 5,
			stealRetryDelayMs: 1,
			sleep: async () => {
				if (++slept === 1) fs.rmSync(paths.steal);
			},
		});
		expect(ok).toBe(true);
		const state = JSON.parse(fs.readFileSync(paths.state, "utf8")) as { heartbeatAt: number; ownershipPhase: string };
		expect(state.heartbeatAt).toBe(5_000);
		expect(state.ownershipPhase).toBe("ready");
	});

	test("binds a child heartbeat only through its matching provisional acquisition", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState({ ownershipPhase: "provisional", pid: 4242, incarnation: "launcher" }));
		const bound = await renewDaemonHeartbeat({
			settings: s,
			ownerId: "old",
			acquisitionId: "old",
			pid: 4243,
			generation: DAEMON_GENERATION,
			pidIncarnation: pid => (pid === 4243 ? "child" : "launcher"),
		});
		expect(bound).toBe(true);
		const state = JSON.parse(fs.readFileSync(daemonPaths(agentDir).state, "utf8")) as {
			pid: number;
			incarnation: string;
		};
		expect(state).toEqual(expect.objectContaining({ pid: 4243, incarnation: "child" }));
	});

	test("reports failure when the steal lock stays held even if state is unchanged", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState({ heartbeatAt: 1 }));
		const paths = daemonPaths(agentDir);
		fs.writeFileSync(paths.steal, ""); // never released
		const ok = await renewDaemonHeartbeat({
			settings: s,
			ownerId: "old",
			acquisitionId: "old",
			pid: 999,
			generation: DAEMON_GENERATION,
			stealRetries: 2,
			stealRetryDelayMs: 1,
			sleep: async () => undefined,
		});
		// Exhausted transition-lock contention cannot prove or publish readiness.
		expect(ok).toBe(false);
		const state = JSON.parse(fs.readFileSync(paths.state, "utf8")) as { heartbeatAt: number };
		expect(state.heartbeatAt).toBe(1);
	});

	test("reports ownership loss when the steal lock is held and ownership changed", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState({ ownerId: "successor", acquisitionId: "successor" }));
		const paths = daemonPaths(agentDir);
		fs.writeFileSync(paths.steal, "");
		const ok = await renewDaemonHeartbeat({
			settings: s,
			ownerId: "old",
			acquisitionId: "old",
			pid: 999,
			generation: DAEMON_GENERATION,
			stealRetries: 2,
			stealRetryDelayMs: 1,
			sleep: async () => undefined,
		});
		expect(ok).toBe(false);
	});
});

describe("cooperative handoff when the captured owner exits before the recheck", () => {
	test("stop succeeds when the owner exits between the control request and the signal recheck", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		let ownerAlive = true;
		const signals: Array<[number, string]> = [];
		const ctrl = new TelegramDaemonController(s, {
			// randomId runs immediately after the control request is written and right
			// before signalCapturedOwner's recheck: flip the owner dead there to model
			// a cooperative exit that wins the race.
			pidAlive: pid => pid === 999 && ownerAlive,
			pidIncarnation: () => "stable",
			randomId: () => {
				ownerAlive = false;
				return "req-stop";
			},
			sendSignal: (pid, sig) => signals.push([pid, sig]),
			sleep: async () => undefined,
			waitStepMs: 1,
		});
		const result = await ctrl.stop();
		expect(result.ok).toBe(true);
		expect(result.message).toContain("stopped telegram daemon");
	});

	test("reload spawns the replacement when the owner exits before the signal recheck", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		let ownerAlive = true;
		const alive = new Set<number>([4242]);
		const spawns: Array<{ command: string; args: string[] }> = [];
		const child = readyTelegramSpawnFixture({
			settings: s,
			firstChildPid: 4250,
			onSpawn: (pid, command, args) => {
				alive.add(pid);
				spawns.push({ command, args });
			},
		});
		const ctrl = new TelegramDaemonController(s, {
			ownerPid: 4242,
			pidAlive: pid => (pid === 999 ? ownerAlive : alive.has(pid)),
			pidIncarnation: () => "stable",
			randomId: () => {
				ownerAlive = false;
				return "req-reload";
			},
			spawn: child.spawn,
			sleep: child.sleep,
		});
		const result = await ctrl.reload();
		expect(result.ok).toBe(true);
		expect(spawns).toHaveLength(1);
	});
});

describe("TelegramDaemonController captured-owner signal races", () => {
	for (const [name, mutate] of [
		["malformed state", () => ({ pid: "not-a-pid" })],
		["different bot identity", () => freshState({ tokenFingerprint: "different-bot" })],
		["different chat identity", () => freshState({ chatId: "different-chat" })],
		["different acquisition", () => freshState({ acquisitionId: "successor-acquisition" })],
		["different PID", () => freshState({ pid: 1000 })],
		["different process incarnation", () => freshState({ incarnation: "reused" })],
		["different generation", () => freshState({ generation: DAEMON_GENERATION + 1 })],
	] as const) {
		test(`does not SIGTERM after a ${name} mutation`, async () => {
			const agentDir = tempAgentDir();
			const s = settings(agentDir);
			writeState(agentDir, freshState());
			fs.writeFileSync(daemonPaths(agentDir).lock, "");
			const signals: NodeJS.Signals[] = [];
			const ctrl = new TelegramDaemonController(s, {
				pidAlive: () => true,
				pidIncarnation: () => "stable",
				randomId: () => {
					writeState(agentDir, mutate());
					return "request-race";
				},
				sendSignal: (_pid, signal) => signals.push(signal),
			});

			const result = await ctrl.stop();
			expect(result.ok).toBe(false);
			expect(result.message).toContain("ownership changed");
			expect(signals).toEqual([]);
		});
	}

	test("does not SIGKILL after an acquisition mutation during the graceful wait", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");
		const signals: NodeJS.Signals[] = [];
		let mutated = false;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: () => true,
			pidIncarnation: () => "stable",
			sendSignal: (_pid, signal) => signals.push(signal),
			sleep: async () => {
				if (mutated) return;
				mutated = true;
				writeState(agentDir, freshState({ acquisitionId: "successor-acquisition" }));
			},
			waitStepMs: 1,
		});

		const result = await ctrl.stop({ force: true, gracefulTimeoutMs: 2, killTimeoutMs: 2 });
		expect(result.ok).toBe(false);
		expect(signals).toEqual(["SIGTERM"]);
	});
});

describe("TelegramDaemonController provisional launcher signal fencing", () => {
	for (const action of ["stop", "reload"] as const) {
		test(`${action} never signals a live generation-4 provisional launcher`, async () => {
			const agentDir = tempAgentDir();
			const s = settings(agentDir);
			writeState(agentDir, freshState({ ownershipPhase: "provisional" }));
			fs.writeFileSync(daemonPaths(agentDir).lock, "");
			const signals: NodeJS.Signals[] = [];
			const result = await new TelegramDaemonController(s, {
				pidAlive: pid => pid === 999,
				pidIncarnation: () => "stable",
				sendSignal: (_pid, signal) => signals.push(signal),
				spawn: () => {
					throw new Error("provisional ownership must block spawning");
				},
			})[action]({ spawnIfStopped: false });

			expect(result.ok).toBe(true);
			expect(signals).toEqual([]);
		});
	}
});

describe("TelegramDaemonController.stop", () => {
	test("stops a running owner without spawning a replacement", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState());
		fs.writeFileSync(daemonPaths(agentDir).lock, "");

		const alive = new Set<number>([999]);
		let spawnCalls = 0;
		const ctrl = new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			pidIncarnation: () => "stable",
			sendSignal: (pid, sig) => {
				if (sig === "SIGTERM") alive.delete(pid);
			},
			spawn: () => {
				spawnCalls++;
				return { unref() {} };
			},
			sleep: async () => undefined,
		});
		const result = await ctrl.stop();
		expect(result.ok).toBe(true);
		expect(spawnCalls).toBe(0);
	});

	test("signals and proves death for a live matching legacy owner without spawning", async () => {
		const agentDir = tempAgentDir();
		const s = settings(agentDir);
		writeState(agentDir, freshState({ generation: DAEMON_GENERATION - 1 }));
		const alive = new Set<number>([999]);
		let spawns = 0;
		const signals: NodeJS.Signals[] = [];
		const result = await new TelegramDaemonController(s, {
			pidAlive: pid => alive.has(pid),
			pidIncarnation: () => "stable",
			sendSignal: (pid, signal) => {
				signals.push(signal);
				if (signal === "SIGTERM") alive.delete(pid);
			},
			spawn: () => {
				spawns++;
				return { unref() {} };
			},
			sleep: async () => undefined,
		}).stop();
		expect(result.ok).toBe(true);
		expect(signals).toEqual(["SIGTERM"]);
		expect(spawns).toBe(0);
		expect(
			(
				await new TelegramDaemonController(s, {
					pidAlive: pid => alive.has(pid),
					pidIncarnation: () => "stable",
				}).status()
			).health,
		).toBe("stopped");
	});
});

describe("ChatDaemonController ownership safety", () => {
	test("does not signal a reused PID incarnation", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 77,
				ownerId: "owner-a",
				identity,
				incarnation: "original",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		const signals: NodeJS.Signals[] = [];
		const controller = new ChatDaemonController(s, "discord", {
			pidAlive: pid => pid === 77,
			pidIncarnation: () => "reused",
			sendSignal: (_pid, signal) => signals.push(signal),
		});
		expect((await controller.status()).health).toBe("stopped");
		const result = await controller.stop();
		expect(result.ok).toBe(true);
		expect(signals).toEqual([]);
	});

	test("releases chat ownership only with live exact PID and incarnation provenance", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		const state = {
			version: 1,
			kind: "discord",
			pid: 77,
			ownerId: "owner-a",
			identity: "identity",
			incarnation: "stable",
			startedAt: 1,
			heartbeatAt: 1,
			transportHealthy: true,
			generation: chatDaemonGeneration("discord"),
		};
		const restore = () => {
			fs.writeFileSync(paths.state, JSON.stringify(state));
			fs.writeFileSync(paths.lock, JSON.stringify({ pid: state.pid, incarnation: state.incarnation, createdAt: 1 }));
		};
		const unchanged = () => {
			const persisted = JSON.parse(fs.readFileSync(paths.state, "utf8"));
			expect(persisted).not.toHaveProperty("stoppedAt");
			expect(persisted.transportHealthy).toBe(true);
			expect(fs.existsSync(paths.lock)).toBe(true);
		};
		const release = (input: Record<string, unknown>) =>
			releaseChatDaemonOwnership({
				agentDir,
				kind: "discord",
				ownerId: "owner-a",
				pid: 77,
				incarnation: "stable",
				...input,
			} as any);

		for (const input of [
			{ ownerId: "wrong-owner" },
			{ pid: undefined },
			{ pid: 78 },
			{ incarnation: undefined },
			{ incarnation: "wrong" },
			{ incarnation: "stale" },
			{ pidIncarnation: () => "reused" },
			{ pidIncarnation: () => undefined },
			{ pidAlive: () => false, pidIncarnation: () => "stable" },
		]) {
			restore();
			await release(input);
			unchanged();
		}

		restore();
		await release({
			pidAlive: (pid: number) => pid === 77,
			pidIncarnation: (pid: number) => (pid === 77 ? "stable" : undefined),
		});
		const released = JSON.parse(fs.readFileSync(paths.state, "utf8"));
		expect(released).toMatchObject({ ownerId: "owner-a", pid: 77, incarnation: "stable", transportHealthy: false });
		expect(released.stoppedAt).toEqual(expect.any(Number));
		expect(fs.existsSync(paths.lock)).toBe(false);
	});

	test("reports a live PID with a disconnected provider as stale", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 77,
				ownerId: "owner-a",
				identity,
				incarnation: "stable",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: false,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		expect(
			(
				await new ChatDaemonController(s, "discord", {
					pidAlive: () => true,
					pidIncarnation: () => "stable",
				}).status()
			).health,
		).toBe("stale");
	});

	test("attaches to a matching live owner without restarting it", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 81,
				ownerId: "owner-a",
				identity,
				incarnation: "stable",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		let spawns = 0;
		expect(
			await ensureDiscordDaemon(s, {
				pidAlive: pid => pid === 81,
				pidIncarnation: () => "stable",
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			}),
		).toBe("attached");
		expect(spawns).toBe(0);
	});

	test("waits for a compatible mid-startup owner to become healthy instead of failing", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		// A concurrent ensure just acquired ownership: physically live and compatible,
		// but transportHealthy:false until its transport heartbeats healthy.
		const baseState = {
			version: 1 as const,
			kind: "discord" as const,
			pid: 90,
			ownerId: "owner-a",
			identity,
			incarnation: "stable",
			startedAt: Date.now(),
			heartbeatAt: Date.now(),
			transportHealthy: false,
			generation: chatDaemonGeneration("discord"),
		};
		fs.writeFileSync(paths.state, JSON.stringify(baseState));
		let spawns = 0;
		const result = await ensureDiscordDaemon(s, {
			pidAlive: pid => pid === 90,
			pidIncarnation: () => "stable",
			spawnReadyTimeoutMs: 1_000,
			sleep: async () => {
				// The owning process finishes startup and publishes a healthy heartbeat.
				fs.writeFileSync(
					paths.state,
					JSON.stringify({ ...baseState, transportHealthy: true, heartbeatAt: Date.now() }),
				);
			},
			spawn: () => {
				spawns++;
				return { unref() {} };
			},
		});
		expect(result).toBe("attached");
		expect(spawns).toBe(0);
	});

	test("fails a compatible owner that never becomes healthy within the wait", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "discord-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 91,
				ownerId: "owner-a",
				identity,
				incarnation: "stable",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: false,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		let spawns = 0;
		await expect(
			ensureDiscordDaemon(s, {
				pidAlive: pid => pid === 91,
				pidIncarnation: () => "stable",
				spawnReadyTimeoutMs: 1,
				sleep: async () => undefined,
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			}),
		).rejects.toThrow("unhealthy");
		expect(spawns).toBe(0);
	});

	test("does not replace a live daemon with a different identity", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.discord.botToken": "new-token",
				"notifications.discord.applicationId": "app",
				"notifications.discord.guildId": "guild",
				"notifications.discord.parentChannelId": "parent",
			}) as Settings,
			agentDir,
		);
		const oldIdentity = crypto
			.createHash("sha256")
			.update(["old-token", "app", "guild", "parent", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "discord",
				pid: 82,
				ownerId: "owner-a",
				identity: oldIdentity,
				incarnation: "stable",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration("discord"),
			}),
		);
		const signals: NodeJS.Signals[] = [];
		let spawns = 0;
		await expect(
			ensureDiscordDaemon(s, {
				pidAlive: pid => pid === 82,
				pidIncarnation: () => "stable",
				sendSignal: (_pid, signal) => signals.push(signal),
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			}),
		).rejects.toThrow("unauthorized");
		expect(signals).toEqual([]);
		expect(spawns).toBe(0);
	});

	test("does not signal after the owner changes before TERM", async () => {
		const agentDir = tempAgentDir();
		const s = setPrivateAgentDir(
			Settings.isolated({
				"notifications.enabled": true,
				"notifications.slack.botToken": "slack-token",
				"notifications.slack.appToken": "app-token",
				"notifications.slack.workspaceId": "workspace",
				"notifications.slack.channelId": "channel",
			}) as Settings,
			agentDir,
		);
		const identity = crypto
			.createHash("sha256")
			.update(["slack-token", "app-token", "workspace", "channel", "", "false", "lean"].join("\0"))
			.digest("hex")
			.slice(0, 16);
		const paths = chatDaemonPaths(agentDir, "slack");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "slack",
				pid: 78,
				ownerId: "owner-a",
				identity,
				incarnation: "stable",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration("slack"),
			}),
		);
		let reads = 0;
		const originalReadFile = fs.promises.readFile;
		fs.promises.readFile = (async (...args: Parameters<typeof fs.promises.readFile>) => {
			if (String(args[0]) === paths.state && ++reads === 2)
				return Buffer.from(
					JSON.stringify({
						version: 1,
						kind: "slack",
						pid: 78,
						ownerId: "owner-b",
						identity,
						incarnation: "stable",
						startedAt: Date.now(),
						heartbeatAt: Date.now(),
						transportHealthy: true,
					}),
				);
			return await originalReadFile(...args);
		}) as typeof fs.promises.readFile;
		try {
			const result = await new ChatDaemonController(s, "slack", {
				pidAlive: () => true,
				pidIncarnation: () => "stable",
				sendSignal: () => {
					throw new Error("must not signal");
				},
			}).stop();
			expect(result.ok).toBe(false);
			expect(result.message).toContain("ownership changed");
		} finally {
			fs.promises.readFile = originalReadFile;
		}
	});
	describe.each(["discord", "slack"] as const)("%s chat daemon generation", kind => {
		function configuredSettings(agentDir: string): Settings {
			return setPrivateAgentDir(
				Settings.isolated(
					kind === "discord"
						? {
								"notifications.enabled": true,
								"notifications.discord.botToken": "discord-token",
								"notifications.discord.applicationId": "app",
								"notifications.discord.guildId": "guild",
								"notifications.discord.parentChannelId": "parent",
							}
						: {
								"notifications.enabled": true,
								"notifications.slack.botToken": "slack-token",
								"notifications.slack.appToken": "app-token",
								"notifications.slack.workspaceId": "workspace",
								"notifications.slack.channelId": "channel",
							},
				) as Settings,
				agentDir,
			);
		}

		function identity(): string {
			const values =
				kind === "discord"
					? ["discord-token", "app", "guild", "parent", "false", "lean"]
					: ["slack-token", "app-token", "workspace", "channel", "", "false", "lean"];
			return crypto.createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 16);
		}

		test.each([
			["lower", chatDaemonGeneration(kind) - 1, "owner_spawned", "stale"],
			["equal", chatDaemonGeneration(kind), "attached", "running"],
			["legacy", undefined, "owner_spawned", "stale"],
			["newer", chatDaemonGeneration(kind) + 1, "attached", "running"],
		] as const)("%s generation replaces only compatible physical owners", async (_name, generation, expected, health) => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 91,
					ownerId: "owner-a",
					identity: identity(),
					incarnation: "stable",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
					transportHealthy: true,
					...(generation === undefined ? {} : { generation }),
				}),
			);
			const alive = new Set([91]);
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => alive.has(pid),
				pidIncarnation: () => "stable",
				sleep: async () => undefined,
				sendSignal: (_pid, signal) => {
					signals.push(signal);
					alive.delete(91);
				},
				spawn: (_command, args) => {
					spawns++;
					const ownerId = args[args.indexOf("--owner-id") + 1];
					alive.add(92);
					fs.writeFileSync(
						paths.state,
						JSON.stringify({
							version: 1,
							kind,
							pid: 92,
							ownerId,
							identity: identity(),
							incarnation: "stable",
							startedAt: Date.now(),
							heartbeatAt: Date.now(),
							transportHealthy: true,
							generation: chatDaemonGeneration(kind),
						}),
					);
					return { unref() {} };
				},
			});
			expect((await controller.status()).health).toBe(health);
			expect(await controller.ensure()).toBe(expected);
			expect(signals).toEqual(expected === "attached" ? [] : ["SIGTERM"]);
			expect(spawns).toBe(expected === "attached" ? 0 : 1);
		});

		test.each([
			["version", 2],
			["kind", "telegram"],
			["pid", 0],
			["ownerId", ""],
			["identity", ""],
			["incarnation", ""],
			["incarnation", "unavailable"],
			["startedAt", "now"],
			["heartbeatAt", Number.NaN],
			["transportHealthy", "true"],
			["generation", "1"],
			["stoppedAt", "truthy-nonnumeric"],
		] as const)("fails closed for malformed live state field: %s", async (field, value) => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			const state = {
				version: 1,
				kind,
				pid: 93,
				ownerId: "owner-a",
				identity: identity(),
				incarnation: "stable",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration(kind),
				[field]: value,
			};
			expect(hasSafeChatDaemonStateShape(state)).toBe(false);
			fs.writeFileSync(paths.state, JSON.stringify(state));
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => pid === 93,
				pidIncarnation: () => "stable",
				sendSignal: (_pid, signal) => signals.push(signal),
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			});
			expect((await controller.status()).health).toBe("stale");
			await expect(controller.ensure()).rejects.toThrow("unauthorized");
			expect((await controller.stop()).ok).toBe(false);
			expect((await controller.reload()).ok).toBe(false);
			expect(signals).toEqual([]);
			expect(spawns).toBe(0);
		});

		test("fails closed without signaling a malformed generation", async () => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 91,
					ownerId: "owner-a",
					identity: identity(),
					incarnation: "stable",
					startedAt: Date.now(),
					heartbeatAt: Date.now(),
					transportHealthy: true,
					generation: null,
				}),
			);
			const signals: NodeJS.Signals[] = [];
			await expect(
				new ChatDaemonController(configuredSettings(agentDir), kind, {
					pidAlive: () => true,
					pidIncarnation: () => "stable",
					sendSignal: (_pid, signal) => signals.push(signal),
				}).ensure(),
			).rejects.toThrow("unauthorized");
			expect(signals).toEqual([]);
		});

		test.each([
			["negative", -1, identity()],
			["non-safe", Number.MAX_SAFE_INTEGER + 1, identity()],
			["non-number", "1", identity()],
			["different identity", chatDaemonGeneration(kind), "other-identity"],
		] as const)("fails closed for every public operation: %s", async (_name, generation, stateIdentity) => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 94,
					ownerId: "owner-a",
					identity: stateIdentity,
					incarnation: "stable",
					startedAt: Date.now(),
					heartbeatAt: 1,
					transportHealthy: false,
					generation,
				}),
			);
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => pid === 94,
				pidIncarnation: () => "stable",
				sendSignal: (_pid, signal) => signals.push(signal),
				spawn: () => {
					spawns++;
					return { unref() {} };
				},
			});
			await expect(controller.ensure()).rejects.toThrow("unauthorized");
			expect((await controller.stop()).ok).toBe(false);
			expect((await controller.reload()).ok).toBe(false);
			expect(signals).toEqual([]);
			expect(spawns).toBe(0);
		});

		test.each([
			["ensure after dead valid state", "ensure", chatDaemonGeneration(kind), identity(), false],
			["reload after safely stopped state", "reload", chatDaemonGeneration(kind), identity(), true],
			["ensure after dead different identity", "ensure", chatDaemonGeneration(kind), "other-identity", false],
			["reload after stopped different identity", "reload", chatDaemonGeneration(kind), "other-identity", true],
		] as const)("spawns fresh for %s persisted state", async (_name, action, generation, stateIdentity, stopped) => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 96,
					ownerId: "dead-owner",
					identity: stateIdentity,
					incarnation: "dead-incarnation",
					startedAt: Date.now(),
					heartbeatAt: 1,
					transportHealthy: false,
					generation,
					...(stopped ? { stoppedAt: Date.now() } : {}),
				}),
			);
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => pid === 97,
				pidIncarnation: pid => (pid === 97 ? "fresh-incarnation" : undefined),
				sendSignal: (_pid, signal) => signals.push(signal),
				spawn: (_command, args) => {
					spawns++;
					fs.writeFileSync(
						paths.state,
						JSON.stringify({
							version: 1,
							kind,
							pid: 97,
							ownerId: args[args.indexOf("--owner-id") + 1],
							identity: identity(),
							incarnation: "fresh-incarnation",
							startedAt: Date.now(),
							heartbeatAt: Date.now(),
							transportHealthy: true,
							generation: chatDaemonGeneration(kind),
						}),
					);
					return { unref() {} };
				},
			});
			if (action === "ensure") expect(await controller.ensure()).toBe("owner_spawned");
			else expect((await controller.reload()).ok).toBe(true);
			expect(signals).toEqual([]);
			expect(spawns).toBe(1);
		});

		test.each([
			["lower", chatDaemonGeneration(kind) - 1, "stop"],
			["lower", chatDaemonGeneration(kind) - 1, "reload"],
		] as const)("signals matching unhealthy legacy owners for %s %s", async (_name, generation, action) => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			fs.writeFileSync(
				paths.state,
				JSON.stringify({
					version: 1,
					kind,
					pid: 94,
					ownerId: "owner-a",
					identity: identity(),
					incarnation: "stable",
					startedAt: Date.now(),
					heartbeatAt: 1,
					transportHealthy: false,
					...(generation === undefined ? {} : { generation }),
				}),
			);
			const alive = new Set([94]);
			const signals: NodeJS.Signals[] = [];
			let spawns = 0;
			const controller = new ChatDaemonController(configuredSettings(agentDir), kind, {
				pidAlive: pid => alive.has(pid),
				pidIncarnation: () => "stable",
				sleep: async () => undefined,
				sendSignal: (_pid, signal) => {
					signals.push(signal);
					alive.delete(94);
				},
				spawn: (_command, args) => {
					spawns++;
					alive.add(95);
					fs.writeFileSync(
						paths.state,
						JSON.stringify({
							version: 1,
							kind,
							pid: 95,
							ownerId: args[args.indexOf("--owner-id") + 1],
							identity: identity(),
							incarnation: "stable",
							startedAt: Date.now(),
							heartbeatAt: Date.now(),
							transportHealthy: true,
							generation: chatDaemonGeneration(kind),
						}),
					);
					return { unref() {} };
				},
			});
			const result = await controller[action]();
			expect(result.ok).toBe(true);
			expect(signals).toEqual(["SIGTERM"]);
			expect(spawns).toBe(action === "reload" ? 1 : 0);
		});

		test("refuses replacement when the captured generation changes before TERM", async () => {
			const agentDir = tempAgentDir();
			const paths = chatDaemonPaths(agentDir, kind);
			fs.mkdirSync(paths.dir, { recursive: true });
			const state = {
				version: 1,
				kind,
				pid: 92,
				ownerId: "owner-a",
				identity: identity(),
				incarnation: "stable",
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: true,
				generation: chatDaemonGeneration(kind),
			};
			fs.writeFileSync(paths.state, JSON.stringify(state));
			let reads = 0;
			const originalReadFile = fs.promises.readFile;
			fs.promises.readFile = (async (...args: Parameters<typeof fs.promises.readFile>) => {
				if (String(args[0]) === paths.state && ++reads === 3)
					return Buffer.from(JSON.stringify({ ...state, generation: chatDaemonGeneration(kind) + 1 }));
				return await originalReadFile(...args);
			}) as typeof fs.promises.readFile;
			try {
				const signals: NodeJS.Signals[] = [];
				const result = await new ChatDaemonController(configuredSettings(agentDir), kind, {
					pidAlive: pid => pid === 92,
					pidIncarnation: () => "stable",
					sendSignal: (_pid, signal) => signals.push(signal),
				}).stop();
				expect(result.ok).toBe(false);
				expect(result.message).toContain("ownership changed");
				expect(signals).toEqual([]);
			} finally {
				fs.promises.readFile = originalReadFile;
			}
		});
	});
});

describe("Chat daemon owner-lock publication", () => {
	test("does not reclaim a fresh empty owner lock before state publication", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const originalOpen = fs.promises.open;
		let paused = false;
		fs.promises.open = (async (...args: Parameters<typeof fs.promises.open>) => {
			const handle = await originalOpen(...args);
			if (!paused && args[0] === paths.lock && args[1] === "wx") {
				paused = true;
				entered.resolve();
				await release.promise;
			}
			return handle;
		}) as typeof fs.promises.open;
		try {
			const first = acquireChatDaemonOwnership({
				agentDir,
				kind: "discord",
				ownerId: "owner-a",
				pid: process.pid,
				identity: "identity",
				incarnation: "test",
			});
			await entered.promise;
			expect(
				await acquireChatDaemonOwnership({
					agentDir,
					kind: "discord",
					ownerId: "owner-b",
					pid: process.pid,
					identity: "identity",
					incarnation: "test",
				}),
			).toBe(false);
			release.resolve();
			expect(await first).toBe(true);
			expect(JSON.parse(fs.readFileSync(paths.state, "utf8")).ownerId).toBe("owner-a");
		} finally {
			fs.promises.open = originalOpen;
		}
	});

	test("fails closed without immutable process-incarnation authority", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		expect(
			await acquireChatDaemonOwnership({
				agentDir,
				kind: "discord",
				ownerId: "owner",
				pid: 91,
				identity: "identity",
				pidAlive: () => true,
				pidIncarnation: () => undefined,
			}),
		).toBe(false);
		expect(fs.existsSync(paths.lock)).toBe(false);
		expect(fs.existsSync(paths.state)).toBe(false);
	});

	test("recovers a dead recorded owner lock", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "slack");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(paths.lock, JSON.stringify({ pid: 2_147_483_647, incarnation: "old", createdAt: 1 }));
		fs.writeFileSync(
			paths.state,
			JSON.stringify({
				version: 1,
				kind: "slack",
				pid: 2_147_483_647,
				ownerId: "old",
				identity: "old",
				incarnation: "old",
				startedAt: 1,
				heartbeatAt: 1,
			}),
		);
		expect(
			await acquireChatDaemonOwnership({
				agentDir,
				kind: "slack",
				ownerId: "new",
				pid: process.pid,
				identity: "identity",
				incarnation: "test",
			}),
		).toBe(true);
		expect(JSON.parse(fs.readFileSync(paths.state, "utf8")).ownerId).toBe("new");
	});

	test("recovers a crashed reclaim owner with a reused PID incarnation", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "discord");
		fs.mkdirSync(paths.dir, { recursive: true });
		const crashedOwner = { pid: 91, incarnation: "previous-incarnation", createdAt: 1 };
		fs.writeFileSync(paths.lock, JSON.stringify(crashedOwner));
		fs.writeFileSync(`${paths.lock}.reclaim`, JSON.stringify(crashedOwner));
		const probe = {
			pidAlive: (pid: number) => pid === 91,
			pidIncarnation: (pid: number) => (pid === 91 ? "replacement-incarnation" : undefined),
		};

		expect(
			await acquireChatDaemonOwnership({
				agentDir,
				kind: "discord",
				ownerId: "new",
				pid: 92,
				identity: "identity",
				incarnation: "new-incarnation",
				...probe,
			}),
		).toBe(true);
		expect(JSON.parse(fs.readFileSync(paths.state, "utf8")).ownerId).toBe("new");
		expect(fs.existsSync(`${paths.lock}.reclaim`)).toBe(false);
	});

	test("does not steal a fresh reclaim lock owned by a live incarnation", async () => {
		const agentDir = tempAgentDir();
		const paths = chatDaemonPaths(agentDir, "slack");
		fs.mkdirSync(paths.dir, { recursive: true });
		fs.writeFileSync(paths.lock, JSON.stringify({ pid: 82, incarnation: "dead", createdAt: 1 }));
		const liveReclaim = `${JSON.stringify({ pid: 81, incarnation: "live-incarnation", createdAt: Date.now() })}\n`;
		fs.writeFileSync(`${paths.lock}.reclaim`, liveReclaim);
		const probe = {
			pidAlive: (pid: number) => pid === 81,
			pidIncarnation: (pid: number) => (pid === 81 ? "live-incarnation" : undefined),
		};

		expect(
			await acquireChatDaemonOwnership({
				agentDir,
				kind: "slack",
				ownerId: "new",
				pid: 83,
				identity: "identity",
				incarnation: "new-incarnation",
				...probe,
			}),
		).toBe(false);
		expect(fs.readFileSync(paths.lock, "utf8")).toContain("82");
		expect(fs.readFileSync(`${paths.lock}.reclaim`, "utf8")).toBe(liveReclaim);
	});
});

test("configured chat providers auto-start while incomplete providers do not", async () => {
	const agentDir = tempAgentDir();
	const configured = setPrivateAgentDir(
		Settings.isolated({
			"notifications.enabled": true,
			"notifications.discord.botToken": "discord-token",
			"notifications.discord.applicationId": "app",
			"notifications.discord.guildId": "guild",
			"notifications.discord.parentChannelId": "parent",
		}) as Settings,
		agentDir,
	);
	let spawns = 0;
	const paths = chatDaemonPaths(agentDir, "discord");
	expect(
		await ensureDiscordDaemon(configured, {
			pidIncarnation: () => "stable",
			spawn: (_command, args) => {
				spawns++;
				fs.mkdirSync(paths.dir, { recursive: true });
				fs.writeFileSync(
					paths.state,
					JSON.stringify({
						version: 1,
						kind: "discord",
						pid: process.pid,
						ownerId: args[args.indexOf("--owner-id") + 1],
						identity: crypto
							.createHash("sha256")
							.update(["discord-token", "app", "guild", "parent", "false", "lean"].join("\0"))
							.digest("hex")
							.slice(0, 16),
						incarnation: "stable",
						startedAt: Date.now(),
						heartbeatAt: Date.now(),
						transportHealthy: true,
						generation: chatDaemonGeneration("discord"),
					}),
				);
				return { unref() {} };
			},
		}),
	).toBe("owner_spawned");
	expect(spawns).toBe(1);
	const incomplete = setPrivateAgentDir(
		Settings.isolated({ "notifications.enabled": true, "notifications.slack.botToken": "bot" }) as Settings,
		tempAgentDir(),
	);
	expect(
		await ensureSlackDaemon(incomplete, {
			spawn: () => {
				throw new Error("must not spawn");
			},
		}),
	).toBe("disabled");
});

describe("runDaemonCommand", () => {
	function fakeController(status: DaemonStatus, result: DaemonOperationResult): BuiltInDaemonController {
		return {
			kind: "telegram",
			status: async () => status,
			stop: async () => result,
			reload: async () => result,
		};
	}

	test("status --json prints the controller status array", async () => {
		const status: DaemonStatus = {
			kind: "telegram",
			configured: true,
			health: "running",
			pid: 7,
			ownerId: "o1",
			rootCount: 2,
			runtime: { mode: "source", execPath: "/usr/bin/node", reloadPicksUpSourceEdits: true },
		};
		const out = await captureStdout(() =>
			runDaemonCommand(
				{ action: "status", kinds: ["telegram"], all: false, json: true, force: false },
				{ controllers: [fakeController(status, {} as DaemonOperationResult)] },
			),
		);
		const parsed = JSON.parse(out) as DaemonStatus[];
		expect(parsed[0].health).toBe("running");
		expect(parsed[0].ownerId).toBe("o1");
	});

	test("reload prints a human result line", async () => {
		const status: DaemonStatus = {
			kind: "telegram",
			configured: true,
			health: "running",
			runtime: { mode: "source", execPath: "/usr/bin/node", reloadPicksUpSourceEdits: true },
		};
		const result: DaemonOperationResult = {
			kind: "telegram",
			action: "reload",
			ok: true,
			warnings: [],
			message: "reloaded telegram daemon (owner_spawned)",
		};
		const out = await captureStdout(() =>
			runDaemonCommand(
				{ action: "reload", kinds: ["telegram"], all: false, json: false, force: false },
				{ controllers: [fakeController(status, result)] },
			),
		);
		expect(out).toContain("telegram reload: ok");
		expect(out).toContain("reloaded telegram daemon");
	});

	test("a refused reload surfaces recovery guidance and exits non-zero", async () => {
		const prevExit = process.exitCode;
		const status: DaemonStatus = {
			kind: "telegram",
			configured: true,
			health: "stopped",
			runtime: { mode: "source", execPath: "/usr/bin/node", reloadPicksUpSourceEdits: true },
		};
		const result: DaemonOperationResult = {
			kind: "telegram",
			action: "reload",
			ok: false,
			warnings: [],
			message: OWNERSHIP_MISMATCH_MESSAGE,
			recovery: ownershipMismatchRecovery(),
		};
		const out = await captureStdout(() =>
			runDaemonCommand(
				{ action: "reload", kinds: ["telegram"], all: false, json: false, force: false },
				{ controllers: [fakeController(status, result)] },
			),
		);
		expect(out).toContain("telegram reload: failed");
		expect(out).toContain("to recover:");
		expect(process.exitCode).toBe(1);
		// Reset so this expected non-zero exitCode does not leak into the runner's exit status.
		process.exitCode = typeof prevExit === "number" ? prevExit : 0;
	});
});

describe("cli registration", () => {
	test("gjc daemon is registered in the explicit command registry", () => {
		const cliSource = fs.readFileSync(path.join(import.meta.dir, "../src/cli.ts"), "utf8");
		expect(cliSource).toContain('{ name: "daemon"');
		expect(cliSource).toContain('import("./commands/daemon")');
	});
});

describe("topic registry reload persistence", () => {
	test("load() preserves identitySent and name so reload does not resend identity", () => {
		const registry = new TopicRegistry();
		registry.load({
			topics: {
				S1: { topicId: "100", identitySent: true, name: "repo/main - title", createdAt: 1 },
			},
		});
		// identitySent must survive so a reloaded daemon does not re-emit the header.
		expect(registry.needsIdentity("S1")).toBe(false);
		expect(registry.get("S1")?.name).toBe("repo/main - title");
		// topicId routing must also survive.
		expect(registry.sessionForTopic("100")).toBe("S1");
	});
});
