import { spawn as childProcessSpawn } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Settings } from "../../config/settings";
import type {
	BuiltInDaemonController,
	DaemonHealth,
	DaemonOperationOptions,
	DaemonOperationResult,
	DaemonRuntimeInfo,
	DaemonStatus,
} from "../../daemon/control-types";
import { resolveGjcRuntimeSpawnInfo } from "../../daemon/runtime";
import { processIncarnation } from "../broker/process-incarnation";
import { getNotificationConfig, isDiscordConfigured, isSlackConfigured } from "./config";

export type ChatDaemonKind = "discord" | "slack";
export type ChatDaemonAction = "stop" | "reload";

/**
 * Operational generations of the Discord/Slack daemon lifecycle contracts.
 * These are intentionally separate from per-session endpoint generations.
 */
export const CHAT_DAEMON_GENERATIONS: Readonly<Record<ChatDaemonKind, number>> = {
	discord: 3,
	slack: 3,
};

export function chatDaemonGeneration(kind: ChatDaemonKind): number {
	return CHAT_DAEMON_GENERATIONS[kind];
}

export interface ChatDaemonState {
	version: 1;
	kind: ChatDaemonKind;
	pid: number;
	ownerId: string;
	identity: string;
	incarnation: string;
	startedAt: number;
	heartbeatAt: number;
	transportHealthy: boolean;
	generation: number;
	stoppedAt?: number;
}

/**
 * State files are untrusted persisted input. A record must be completely valid
 * before its PID can be treated as an owner, stopped, or safe to replace.
 */
/** A legacy owner is recognized only when the sole missing field is generation. */
export function isRecognizedLegacyGeneration(value: unknown): value is undefined {
	return value === undefined;
}

function hasProcessIncarnationAuthority(incarnation: unknown): incarnation is string {
	return typeof incarnation === "string" && incarnation.length > 0 && incarnation !== "unavailable";
}

function hasSafeChatDaemonOwnerShape(
	value: unknown,
): value is Omit<ChatDaemonState, "generation"> & { generation?: unknown } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const state = value as Record<string, unknown>;
	return (
		state.version === 1 &&
		(state.kind === "discord" || state.kind === "slack") &&
		typeof state.pid === "number" &&
		Number.isSafeInteger(state.pid) &&
		state.pid > 0 &&
		typeof state.ownerId === "string" &&
		state.ownerId.length > 0 &&
		typeof state.identity === "string" &&
		state.identity.length > 0 &&
		hasProcessIncarnationAuthority(state.incarnation) &&
		typeof state.startedAt === "number" &&
		Number.isFinite(state.startedAt) &&
		typeof state.heartbeatAt === "number" &&
		Number.isFinite(state.heartbeatAt) &&
		typeof state.transportHealthy === "boolean" &&
		(state.stoppedAt === undefined || (typeof state.stoppedAt === "number" && Number.isFinite(state.stoppedAt)))
	);
}

export function hasSafeChatDaemonStateShape(value: unknown): value is ChatDaemonState {
	if (!hasSafeChatDaemonOwnerShape(value)) return false;
	const state = value as Record<string, unknown>;
	return typeof state.generation === "number" && Number.isSafeInteger(state.generation) && state.generation >= 0;
}

function hasChatDaemonStatePid(value: unknown): value is { pid: number } {
	return (
		!!value &&
		typeof value === "object" &&
		typeof (value as { pid?: unknown }).pid === "number" &&
		Number.isSafeInteger((value as { pid: number }).pid) &&
		(value as { pid: number }).pid > 0
	);
}

export interface ChatDaemonControlRequest {
	version: 1;
	requestId: string;
	action: ChatDaemonAction;
	ownerId: string;
	pid: number;
	createdAt: number;
	incarnation: string;
}

export interface ChatDaemonControlDeps {
	pidAlive?: (pid: number) => boolean;
	sendSignal?: (pid: number, signal: NodeJS.Signals) => void;
	spawn?: (command: string, args: string[], opts: { detached: boolean; stdio: "ignore" }) => { unref?: () => void };
	execPath?: string;
	ownerPid?: number;
	randomId?: () => string;
	pidIncarnation?: (pid: number) => string | undefined;
	sleep?: (ms: number) => Promise<void>;
	spawnReadyTimeoutMs?: number;
}

const HEARTBEAT_TTL_MS = 20_000;
const DEFAULT_GRACEFUL_TIMEOUT_MS = 8_000;
const DEFAULT_KILL_TIMEOUT_MS = 3_000;
const UNPUBLISHED_OWNER_LOCK_STALE_MS = HEARTBEAT_TTL_MS;
/** Covers Discord READY plus its first 5-second heartbeat; tests inject a smaller timeout. */
const DEFAULT_SPAWN_READY_TIMEOUT_MS = 8_000;

interface ChatDaemonOwnerLock {
	pid: number;
	incarnation: string;
	createdAt: number;
}

interface ChatDaemonOwnershipProbe {
	pidAlive(pid: number): boolean;
	pidIncarnation(pid: number): string | undefined;
}

export function chatDaemonPaths(
	agentDir: string,
	kind: ChatDaemonKind,
): { dir: string; lock: string; state: string; control: string } {
	const dir = path.join(agentDir, "sdk", "daemons", kind);
	return {
		dir,
		lock: path.join(dir, "owner.lock"),
		state: path.join(dir, "state.json"),
		control: path.join(dir, "control.json"),
	};
}

function identityFor(settings: Settings, kind: ChatDaemonKind): string | undefined {
	const cfg = getNotificationConfig(settings);
	if (kind === "discord") {
		if (!isDiscordConfigured(cfg)) return undefined;
		return fingerprint([
			cfg.discord.botToken,
			cfg.discord.applicationId,
			cfg.discord.guildId,
			cfg.discord.parentChannelId,
			String(cfg.redact),
			cfg.verbosity,
		]);
	}
	if (!isSlackConfigured(cfg)) return undefined;
	return fingerprint([
		cfg.slack.botToken,
		cfg.slack.appToken,
		cfg.slack.workspaceId,
		cfg.slack.channelId,
		cfg.slack.authorizedUserId ?? "",
		String(cfg.redact),
		cfg.verbosity,
	]);
}

function fingerprint(values: string[]): string {
	return crypto.createHash("sha256").update(values.join("\0")).digest("hex").slice(0, 16);
}
function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
function defaultSignal(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {}
}
/** Windows process ownership uses immutable StartTime/FileTime provenance through
 * the shared native/platform authority. Without authority, numeric PIDs are never trusted. */
function defaultPidIncarnation(pid: number): string | undefined {
	return processIncarnation(pid);
}
function runtimeInfo(execPath?: string): DaemonRuntimeInfo {
	const rt = resolveGjcRuntimeSpawnInfo(execPath ?? process.execPath);
	return {
		mode: rt.mode,
		execPath: rt.execPath,
		reloadPicksUpSourceEdits: rt.reloadPicksUpSourceEdits,
		warning: rt.warning,
	};
}

const stateWriteTails = new Map<string, Promise<void>>();

async function withStateWriteLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
	const previous = stateWriteTails.get(file) ?? Promise.resolve();
	const gate = Promise.withResolvers<void>();
	const tail = previous.then(() => gate.promise);
	stateWriteTails.set(file, tail);
	await previous;
	try {
		return await operation();
	} finally {
		gate.resolve();
		if (stateWriteTails.get(file) === tail) stateWriteTails.delete(file);
	}
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await fs.promises.readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}
async function writeJson(file: string, value: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
		await fs.promises.rename(tmp, file);
	} catch (error) {
		await fs.promises.unlink(tmp).catch(() => undefined);
		throw error;
	}
}

export async function readChatDaemonState(
	agentDir: string,
	kind: ChatDaemonKind,
): Promise<ChatDaemonState | undefined> {
	return await readJson(chatDaemonPaths(agentDir, kind).state);
}
export async function readChatDaemonControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
): Promise<ChatDaemonControlRequest | undefined> {
	return await readJson(chatDaemonPaths(agentDir, kind).control);
}
export async function writeChatDaemonControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
	request: ChatDaemonControlRequest,
): Promise<void> {
	await writeJson(chatDaemonPaths(agentDir, kind).control, request);
}
export async function clearChatDaemonControlRequest(
	agentDir: string,
	kind: ChatDaemonKind,
	requestId?: string,
): Promise<void> {
	const paths = chatDaemonPaths(agentDir, kind);
	if (requestId && (await readChatDaemonControlRequest(agentDir, kind))?.requestId !== requestId) return;
	await fs.promises.unlink(paths.control).catch(() => undefined);
}

export function buildChatDaemonSpawnArgs(input: {
	kind: ChatDaemonKind;
	ownerId: string;
	agentDir: string;
	execPath?: string;
}): { command: string; args: string[]; runtime: DaemonRuntimeInfo } {
	const rt = resolveGjcRuntimeSpawnInfo(input.execPath ?? process.execPath);
	return {
		command: rt.execPath,
		args: [
			...rt.argsPrefix,
			"daemon",
			`${input.kind}-internal`,
			"--owner-id",
			input.ownerId,
			"--agent-dir",
			input.agentDir,
		],
		runtime: runtimeInfo(input.execPath),
	};
}

type ChatDaemonStateClassification = "absent" | "replaceable" | "compatible" | "malformed" | "unauthorized" | "stopped";

export class ChatDaemonController implements BuiltInDaemonController {
	readonly kind: ChatDaemonKind;
	constructor(
		private readonly settings: Settings,
		kind: ChatDaemonKind,
		private readonly deps: ChatDaemonControlDeps = {},
	) {
		this.kind = kind;
	}
	private identity(): string | undefined {
		return identityFor(this.settings, this.kind);
	}
	private alive(pid: number): boolean {
		return (this.deps.pidAlive ?? defaultPidAlive)(pid);
	}
	async status(): Promise<DaemonStatus> {
		const runtime = runtimeInfo(this.deps.execPath);
		const identity = this.identity();
		const state = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		if (!identity) return { kind: this.kind, configured: false, health: "not_configured", runtime };
		const health: DaemonHealth = this.stateHealth(state, identity);
		return {
			kind: this.kind,
			configured: true,
			health,
			pid: state?.pid,
			ownerId: state?.ownerId,
			startedAt: state?.startedAt,
			heartbeatAt: state?.heartbeatAt,
			runtime,
		};
	}
	async stop(opts: DaemonOperationOptions = {}): Promise<DaemonOperationResult> {
		return await this.operate("stop", opts);
	}
	async reload(opts: DaemonOperationOptions = {}): Promise<DaemonOperationResult> {
		return await this.operate("reload", opts);
	}
	async ensure(): Promise<EnsureChatDaemonResult> {
		const identity = this.identity();
		if (!identity) return "disabled";
		const existing = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		const classification = this.classify(existing, identity);
		if (classification === "malformed" || classification === "unauthorized")
			throw new Error(`Unable to replace unauthorized ${this.kind} daemon owner`);
		if (existing && this.isSignalableMatchingOwner(existing)) {
			if (classification === "compatible") {
				// A compatible, physically-live owner may be mid-startup: a concurrent
				// ensure can have just acquired ownership and published transportHealthy:false
				// before its transport heartbeats healthy. Wait bounded for that owner to
				// become attachable instead of failing a racing startup outright.
				if (this.isHealthyFreshState(existing) || (await this.waitForOwnership(existing.ownerId, identity)))
					return "attached";
				throw new Error(`Unable to replace unhealthy ${this.kind} daemon owner`);
			}
			await this.stopForReplacement(existing);
		}
		const spawned = await this.spawn();
		if (spawned) return "owner_spawned";
		const replacement = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		if (replacement && this.isCurrentCompatibleState(replacement, identity)) return "attached";
		throw new Error(`Unable to attach or spawn ${this.kind} daemon owner`);
	}

	private async operate(action: ChatDaemonAction, opts: DaemonOperationOptions): Promise<DaemonOperationResult> {
		const before = await this.status();
		const warnings = before.runtime.warning ? [before.runtime.warning] : [];
		if (!before.configured)
			return this.result(action, false, `${this.kind} notifications are not configured`, before, before, warnings);
		const state = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		const classification = this.classify(state, this.identity());
		if (classification === "malformed" || classification === "unauthorized")
			return this.result(
				action,
				false,
				`${this.kind} daemon ownership changed; refusing to signal`,
				before,
				await this.status(),
				warnings,
			);
		if (!state || !this.isSignalableMatchingOwner(state)) {
			if (action === "stop") {
				if (state && this.isAmbiguouslyLiveState(state))
					return this.result(
						action,
						false,
						`${this.kind} daemon ownership changed; refusing to signal`,
						before,
						before,
						warnings,
					);
				return this.result(action, true, `no running ${this.kind} daemon`, before, before, warnings);
			}
			if (opts.spawnIfStopped === false)
				return this.result(action, true, `no running ${this.kind} daemon to reload`, before, before, warnings);
			const spawned = await this.spawn();
			return this.result(
				action,
				spawned,
				spawned
					? `spawned fresh ${this.kind} daemon`
					: `${this.kind} daemon did not publish ownership after spawning`,
				before,
				await this.status(),
				warnings,
			);
		}
		if (state.identity !== this.identity() || !this.ownsCapturedState(state, before))
			return this.result(
				action,
				false,
				`${this.kind} daemon ownership changed; refusing to signal`,
				before,
				await this.status(),
				warnings,
			);
		const requestId = this.deps.randomId?.() ?? crypto.randomUUID();
		await writeChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, {
			version: 1,
			requestId,
			action,
			ownerId: state.ownerId,
			pid: state.pid,
			incarnation: state.incarnation,
			createdAt: Date.now(),
		});
		if (!(await this.signalIfOwner(state, "SIGTERM"))) return this.ownerChanged(action, requestId, before, warnings);
		let dead = await this.waitForDeath(state.pid, opts.gracefulTimeoutMs ?? DEFAULT_GRACEFUL_TIMEOUT_MS);
		if (!dead && opts.force) {
			if (!(await this.signalIfOwner(state, "SIGKILL")))
				return this.ownerChanged(action, requestId, before, warnings);
			dead = await this.waitForDeath(state.pid, opts.killTimeoutMs ?? DEFAULT_KILL_TIMEOUT_MS);
		}
		if (!dead) {
			await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
			const after = await this.status();
			return this.result(
				action,
				false,
				opts.force ? "old daemon did not exit after SIGKILL" : "old daemon did not exit; rerun with --force",
				before,
				after,
				warnings,
			);
		}
		await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
		if (action === "stop")
			return this.result(action, true, `stopped ${this.kind} daemon`, before, await this.status(), warnings);
		const spawned = await this.spawn();
		return this.result(
			action,
			spawned,
			spawned ? `reloaded ${this.kind} daemon` : `a live ${this.kind} owner already exists`,
			before,
			await this.status(),
			warnings,
		);
	}
	private incarnation(pid: number): string | undefined {
		return (this.deps.pidIncarnation ?? defaultPidIncarnation)(pid);
	}
	private isDefinitelyStoppedState(state: ChatDaemonState | undefined): boolean {
		if (!state || !hasSafeChatDaemonOwnerShape(state)) return false;
		if (!this.alive(state.pid)) return true;
		// Proven PID reuse means this persisted owner is gone. The distinct live PID
		// remains nonsignalable because isSignalableMatchingOwner requires equality.
		const incarnation = this.incarnation(state.pid);
		return hasProcessIncarnationAuthority(incarnation) && incarnation !== state.incarnation;
	}
	private stateHealth(state: ChatDaemonState | undefined, identity: string): DaemonHealth {
		if (!state || this.isDefinitelyStoppedState(state)) return "stopped";
		if (this.isCurrentCompatibleState(state, identity)) return "running";
		// A PID that is live but cannot prove a matching current incarnation is
		// ambiguous: do not report it ready or overwrite it.
		return "stale";
	}
	private isSignalableMatchingOwner(state: ChatDaemonState): boolean {
		const incarnation = this.incarnation(state.pid);
		return (
			hasSafeChatDaemonOwnerShape(state) &&
			state.kind === this.kind &&
			state.stoppedAt === undefined &&
			this.alive(state.pid) &&
			hasProcessIncarnationAuthority(incarnation) &&
			incarnation === state.incarnation
		);
	}
	/** A live PID with an invalid ownership record is never safe to overwrite. */
	private isAmbiguouslyLiveState(state: ChatDaemonState): boolean {
		return !this.isDefinitelyStoppedState(state) && !this.isSignalableMatchingOwner(state);
	}

	private isHealthyFreshState(state: ChatDaemonState): boolean {
		return (
			hasSafeChatDaemonStateShape(state) &&
			state.transportHealthy &&
			Date.now() - state.heartbeatAt <= HEARTBEAT_TTL_MS
		);
	}
	private classify(state: ChatDaemonState | undefined, identity: string | undefined): ChatDaemonStateClassification {
		if (!state) return "absent";
		if (!hasSafeChatDaemonOwnerShape(state)) return "malformed";
		if (this.isDefinitelyStoppedState(state)) return "stopped";
		if (!identity || state.kind !== this.kind || state.identity !== identity) return "unauthorized";
		if (hasSafeChatDaemonStateShape(state))
			return state.generation < chatDaemonGeneration(this.kind) ? "replaceable" : "compatible";
		const generation = (state as { generation?: unknown }).generation;
		return isRecognizedLegacyGeneration(generation) ? "replaceable" : "malformed";
	}
	private isCurrentCompatibleState(state: ChatDaemonState, identity: string): boolean {
		return (
			this.isSignalableMatchingOwner(state) &&
			this.isHealthyFreshState(state) &&
			this.classify(state, identity) === "compatible"
		);
	}

	private async stopForReplacement(state: ChatDaemonState): Promise<void> {
		if (!this.isSignalableMatchingOwner(state)) return;

		const requestId = this.deps.randomId?.() ?? crypto.randomUUID();
		await writeChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, {
			version: 1,
			requestId,
			action: "reload",
			ownerId: state.ownerId,
			pid: state.pid,
			incarnation: state.incarnation,
			createdAt: Date.now(),
		});
		try {
			if (!(await this.signalIfOwner(state, "SIGTERM")))
				throw new Error(`${this.kind} daemon ownership changed; refusing replacement`);
			let dead = await this.waitForDeath(state.pid, DEFAULT_GRACEFUL_TIMEOUT_MS);
			if (!dead) {
				if (!(await this.signalIfOwner(state, "SIGKILL")))
					throw new Error(`${this.kind} daemon ownership changed; refusing replacement`);
				dead = await this.waitForDeath(state.pid, DEFAULT_KILL_TIMEOUT_MS);
			}
			if (!dead) throw new Error(`Old ${this.kind} daemon did not exit before replacement`);
		} finally {
			await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
		}
	}

	private ownsCapturedState(state: ChatDaemonState, before: DaemonStatus): boolean {
		return (
			state.ownerId === before.ownerId &&
			state.pid === before.pid &&
			Boolean(state.incarnation) &&
			this.isSignalableMatchingOwner(state)
		);
	}
	private async signalIfOwner(state: ChatDaemonState, signal: NodeJS.Signals): Promise<boolean> {
		const current = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		const identity = this.identity();
		const classification = this.classify(current, identity);
		if (
			!identity ||
			!current ||
			current.ownerId !== state.ownerId ||
			current.pid !== state.pid ||
			current.identity !== state.identity ||
			current.incarnation !== state.incarnation ||
			current.generation !== state.generation ||
			(classification !== "compatible" && classification !== "replaceable") ||
			!this.isSignalableMatchingOwner(current)
		)
			return false;
		(this.deps.sendSignal ?? defaultSignal)(state.pid, signal);
		return true;
	}
	private async ownerChanged(
		action: ChatDaemonAction,
		requestId: string,
		before: DaemonStatus,
		warnings: string[],
	): Promise<DaemonOperationResult> {
		await clearChatDaemonControlRequest(this.settings.getAgentDir(), this.kind, requestId);
		return this.result(
			action,
			false,
			`${this.kind} daemon ownership changed; refusing to signal`,
			before,
			await this.status(),
			warnings,
		);
	}
	private result(
		action: ChatDaemonAction,
		ok: boolean,
		message: string,
		before: DaemonStatus,
		after: DaemonStatus,
		warnings: string[],
	): DaemonOperationResult {
		return { kind: this.kind, action, ok, message, before, after, warnings };
	}
	private async waitForDeath(pid: number, timeout: number): Promise<boolean> {
		const until = Date.now() + timeout;
		while (this.alive(pid) && Date.now() < until) await this.sleep(25);
		return !this.alive(pid);
	}
	private sleep(ms: number): Promise<void> {
		return this.deps.sleep ? this.deps.sleep(ms) : new Promise(resolve => setTimeout(resolve, ms));
	}
	private async spawn(): Promise<boolean> {
		const identity = this.identity();
		if (!identity) return false;
		const paths = chatDaemonPaths(this.settings.getAgentDir(), this.kind);
		await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
		const existing = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
		const classification = this.classify(existing, identity);
		if (classification === "malformed" || classification === "unauthorized") return false;
		if (existing && (this.isSignalableMatchingOwner(existing) || this.isAmbiguouslyLiveState(existing))) return false;

		const ownerId = `${this.deps.ownerPid ?? process.ppid}-${this.deps.randomId?.() ?? crypto.randomUUID()}`;
		const { command, args } = buildChatDaemonSpawnArgs({
			kind: this.kind,
			ownerId,
			agentDir: this.settings.getAgentDir(),
			execPath: this.deps.execPath,
		});
		(this.deps.spawn ?? ((command, args, opts) => childProcessSpawn(command, args, opts)))(command, args, {
			detached: true,
			stdio: "ignore",
		}).unref?.();
		return await this.waitForOwnership(ownerId, identity);
	}
	private async waitForOwnership(ownerId: string, identity: string): Promise<boolean> {
		const timeoutMs = Math.max(this.deps.spawnReadyTimeoutMs ?? DEFAULT_SPAWN_READY_TIMEOUT_MS, 0);
		const until = Date.now() + timeoutMs;
		const maxPolls = Math.ceil(timeoutMs / 25);
		for (let poll = 0; poll <= maxPolls; poll++) {
			const state = await readChatDaemonState(this.settings.getAgentDir(), this.kind);
			if (
				state &&
				state.ownerId === ownerId &&
				this.classify(state, identity) === "compatible" &&
				this.isCurrentCompatibleState(state, identity)
			)
				return true;
			if (Date.now() >= until || poll === maxPolls) return false;
			await this.sleep(25);
		}
		return false;
	}
}

export type EnsureChatDaemonResult = "disabled" | "owner_spawned" | "attached";

async function ensureChatDaemon(
	kind: ChatDaemonKind,
	settings: Settings,
	deps: ChatDaemonControlDeps = {},
): Promise<EnsureChatDaemonResult> {
	return await new ChatDaemonController(settings, kind, deps).ensure();
}

export async function ensureDiscordDaemon(
	settings: Settings,
	deps: ChatDaemonControlDeps = {},
): Promise<EnsureChatDaemonResult> {
	return await ensureChatDaemon("discord", settings, deps);
}

export async function ensureSlackDaemon(
	settings: Settings,
	deps: ChatDaemonControlDeps = {},
): Promise<EnsureChatDaemonResult> {
	return await ensureChatDaemon("slack", settings, deps);
}

export async function acquireChatDaemonOwnership(input: {
	agentDir: string;
	kind: ChatDaemonKind;
	ownerId: string;
	pid?: number;
	identity: string;
	incarnation?: string;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}): Promise<boolean> {
	const paths = chatDaemonPaths(input.agentDir, input.kind);
	const pid = input.pid ?? process.pid;
	const probe: ChatDaemonOwnershipProbe = {
		pidAlive: input.pidAlive ?? defaultPidAlive,
		pidIncarnation: input.pidIncarnation ?? defaultPidIncarnation,
	};
	const incarnation = input.incarnation ?? probe.pidIncarnation(pid);
	if (!hasProcessIncarnationAuthority(incarnation)) return false;

	await fs.promises.mkdir(paths.dir, { recursive: true, mode: 0o700 });
	const existing = await readJson<unknown>(paths.state);
	// A live record remains fenced unless authoritative provenance proves the PID
	// was reused. This permits recovery without ever signaling that replacement.
	if (hasChatDaemonStatePid(existing) && probe.pidAlive(existing.pid)) {
		const current = probe.pidIncarnation(existing.pid);
		if (
			!hasSafeChatDaemonOwnerShape(existing) ||
			!hasProcessIncarnationAuthority(current) ||
			current === existing.incarnation
		)
			return false;
	}
	if (!(await createChatDaemonOwnerLock(paths.lock, { pid, incarnation, createdAt: Date.now() }))) {
		if (!(await reclaimChatDaemonOwnerLock(paths.lock, paths.state, probe))) return false;
		if (!(await createChatDaemonOwnerLock(paths.lock, { pid, incarnation, createdAt: Date.now() }))) return false;
	}

	await withStateWriteLock(
		paths.state,
		async () =>
			await writeJson(paths.state, {
				version: 1,
				kind: input.kind,
				pid,
				ownerId: input.ownerId,
				identity: input.identity,
				incarnation,
				startedAt: Date.now(),
				heartbeatAt: Date.now(),
				transportHealthy: false,
				generation: chatDaemonGeneration(input.kind),
			} satisfies ChatDaemonState),
	);
	return true;
}

async function createChatDaemonOwnerLock(lock: string, owner: ChatDaemonOwnerLock): Promise<boolean> {
	try {
		const handle = await fs.promises.open(lock, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		return true;
	} catch (error) {
		if (isAlreadyExists(error)) return false;
		throw error;
	}
}

async function reclaimChatDaemonOwnerLock(
	lock: string,
	stateFile: string,
	probe: ChatDaemonOwnershipProbe,
): Promise<boolean> {
	if (!(await canReclaimChatDaemonOwnerLock(lock, stateFile, probe))) return false;

	const reclaimFile = `${lock}.reclaim`;
	const reclaimLock = await acquireChatDaemonReclaimLock(reclaimFile, probe);

	if (!reclaimLock) return false;
	try {
		if (!(await canReclaimChatDaemonOwnerLock(lock, stateFile, probe))) return false;

		await fs.promises.unlink(lock).catch(() => undefined);
		return true;
	} finally {
		await reclaimLock.close().catch(() => undefined);
		await fs.promises.unlink(reclaimFile).catch(() => undefined);
	}
}

async function acquireChatDaemonReclaimLock(
	reclaimFile: string,
	probe: ChatDaemonOwnershipProbe,
): Promise<{ close(): Promise<void> } | undefined> {
	const owner: ChatDaemonOwnerLock = {
		pid: process.pid,
		incarnation: probe.pidIncarnation(process.pid) ?? "unavailable",
		createdAt: Date.now(),
	};
	if (await createChatDaemonOwnerLock(reclaimFile, owner)) return await fs.promises.open(reclaimFile, "r+");
	if (!(await isStaleChatDaemonLock(reclaimFile, probe))) return undefined;
	await fs.promises.unlink(reclaimFile).catch(() => undefined);
	if (!(await createChatDaemonOwnerLock(reclaimFile, owner))) return undefined;
	return await fs.promises.open(reclaimFile, "r+");
}

async function isStaleChatDaemonLock(lock: string, probe: ChatDaemonOwnershipProbe): Promise<boolean> {
	let owner: unknown;
	try {
		owner = JSON.parse(await fs.promises.readFile(lock, "utf8"));
	} catch {}
	if (isChatDaemonOwnerLock(owner)) {
		const currentIncarnation = probe.pidIncarnation(owner.pid);
		return (
			!probe.pidAlive(owner.pid) ||
			(currentIncarnation !== undefined &&
				owner.incarnation !== "unavailable" &&
				currentIncarnation !== owner.incarnation)
		);
	}
	const stat = await fs.promises.stat(lock).catch(() => undefined);
	return Boolean(stat && Date.now() - stat.mtimeMs >= UNPUBLISHED_OWNER_LOCK_STALE_MS);
}

async function canReclaimChatDaemonOwnerLock(
	lock: string,
	stateFile: string,
	probe: ChatDaemonOwnershipProbe,
): Promise<boolean> {
	const state = await readJson<unknown>(stateFile);
	if (hasChatDaemonStatePid(state) && probe.pidAlive(state.pid)) {
		const current = probe.pidIncarnation(state.pid);
		if (
			!hasSafeChatDaemonOwnerShape(state) ||
			!hasProcessIncarnationAuthority(current) ||
			current === state.incarnation
		)
			return false;
	}
	return await isStaleChatDaemonLock(lock, probe);
}

function isChatDaemonOwnerLock(value: unknown): value is ChatDaemonOwnerLock {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ChatDaemonOwnerLock).pid === "number" &&
		Number.isSafeInteger((value as ChatDaemonOwnerLock).pid) &&
		(value as ChatDaemonOwnerLock).pid > 0 &&
		typeof (value as ChatDaemonOwnerLock).incarnation === "string" &&
		typeof (value as ChatDaemonOwnerLock).createdAt === "number"
	);
}

function isAlreadyExists(error: unknown): error is NodeJS.ErrnoException {
	return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}
export async function renewChatDaemonHeartbeat(input: {
	agentDir: string;
	kind: ChatDaemonKind;
	ownerId: string;
	pid?: number;
	incarnation?: string;
	transportHealthy: boolean;
}): Promise<boolean> {
	const paths = chatDaemonPaths(input.agentDir, input.kind);
	return await withStateWriteLock(paths.state, async () => {
		const state = await readJson<unknown>(paths.state);
		if (!hasSafeChatDaemonStateShape(state)) return false;
		const pid = input.pid ?? state.pid;
		if (
			state.ownerId !== input.ownerId ||
			pid !== state.pid ||
			!input.incarnation ||
			state.incarnation !== input.incarnation
		)
			return false;
		await writeJson(paths.state, { ...state, heartbeatAt: Date.now(), transportHealthy: input.transportHealthy });
		return true;
	});
}
export async function releaseChatDaemonOwnership(input: {
	agentDir: string;
	kind: ChatDaemonKind;
	ownerId: string;
	pid: number;
	incarnation: string;
	pidAlive?: (pid: number) => boolean;
	pidIncarnation?: (pid: number) => string | undefined;
}): Promise<void> {
	const paths = chatDaemonPaths(input.agentDir, input.kind);
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const pidIncarnation = input.pidIncarnation ?? defaultPidIncarnation;
	await withStateWriteLock(paths.state, async () => {
		const state = await readJson<unknown>(paths.state);
		if (
			!hasSafeChatDaemonStateShape(state) ||
			state.ownerId !== input.ownerId ||
			state.pid !== input.pid ||
			state.incarnation !== input.incarnation ||
			!pidAlive(input.pid) ||
			pidIncarnation(input.pid) !== input.incarnation
		)
			return;
		await writeJson(paths.state, { ...state, stoppedAt: Date.now(), transportHealthy: false });
		const lock = await readJson<ChatDaemonOwnerLock>(paths.lock);
		if (lock?.pid === state.pid && lock.incarnation === state.incarnation)
			await fs.promises.unlink(paths.lock).catch(() => undefined);
	});
}
