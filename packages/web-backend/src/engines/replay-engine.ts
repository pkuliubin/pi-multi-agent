import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
	AbortRequest,
	AbortResponse,
	AgentHistoryResponse,
	AgentsResponse,
	MessagesResponse,
	PromptRequest,
	PromptResponse,
	ReplayPayload,
	ReplayResetRequest,
	ReplaySpeedRequest,
	RoleSessionsResponse,
	SessionSnapshot,
	SharedStateArtifactResponse,
	SharedStateManifestResponse,
	SseEnvelope,
	SseEventType,
	StartSessionRequest,
	StopSessionRequest,
} from "../contract.ts";
import { ApiError, invalidMode } from "../errors.ts";
import type { SseBus } from "../events/sse-bus.ts";
import { readSseCaptureReplay, type SseReplayEvent, type SseReplayFile } from "../replay/sse-capture-reader.ts";
import { SseEnvelopeReducer } from "../replay/sse-envelope-reducer.ts";
import { readRoleSessions } from "../role-sessions/role-session-reader.ts";
import { createEmptySessionSnapshot, type SessionStore } from "../session-store.ts";
import { readSharedStateArtifact } from "../shared-state/artifact-reader.ts";
import { locateSharedStateRoot } from "../shared-state/locator.ts";
import { readSharedStateManifest } from "../shared-state/manifest-reader.ts";
import type { BackendEngine } from "./engine.ts";

const DEFAULT_REPLAY_LOG = "tmp/gui-sse-captures/2026-07-02T02-09-43-487Z-replay.json";
const DEFAULT_SPEED = 1;
const MAX_EVENTS_PER_TICK = 500;

export interface ReplayEngineOptions {
	defaultLogPath?: string;
	maxEventsPerTick?: number;
}

export class ReplayEngine implements BackendEngine {
	private readonly store: SessionStore;
	private readonly sseBus: SseBus;
	private readonly defaultLogPath: string;
	private readonly reducer: SseEnvelopeReducer;
	private readonly maxEventsPerTick: number;
	private replayFile: SseReplayFile | null = null;
	private timer: NodeJS.Timeout | null = null;
	private cursor = 0;
	private logPath: string | null = null;
	private speed = DEFAULT_SPEED;
	private sessionId: string | null = null;
	private cwd: string | null = null;
	private explicitSharedStateRoot: string | null = null;
	private generatedSequence = 0;

	constructor(store: SessionStore, sseBus: SseBus, options: ReplayEngineOptions = {}) {
		this.store = store;
		this.sseBus = sseBus;
		this.defaultLogPath = options.defaultLogPath ?? process.env.PI_WEB_BACKEND_REPLAY_LOG ?? DEFAULT_REPLAY_LOG;
		this.maxEventsPerTick = options.maxEventsPerTick ?? MAX_EVENTS_PER_TICK;
		this.reducer = new SseEnvelopeReducer(store);
	}

	async start(request: StartSessionRequest): Promise<SessionSnapshot> {
		if (request.mode !== "replay") throw invalidMode("ReplayEngine only supports replay mode");
		this.stopTimer();
		this.cursor = 0;
		this.logPath = resolveReplayLogPath(request.replay?.logPath ?? this.defaultLogPath, request.cwd ?? process.cwd());
		this.speed = request.replay?.speed ?? DEFAULT_SPEED;
		this.explicitSharedStateRoot = request.sharedStateRoot ?? null;
		this.replayFile = await readReplayFile(this.logPath);
		this.sessionId = this.firstEnvelope()?.sessionId ?? this.replayFile.runId;
		this.cwd = request.cwd ?? process.cwd();
		this.generatedSequence = replayStartedSequence(this.firstEnvelope());
		this.initializeStore(this.replayFile.timing.startedAt);
		this.broadcastLifecycle("replay.started", this.replayPayload(), this.generatedSequence);
		if (request.replay?.autoStart !== false) this.startTimer();
		return this.store.getSnapshot();
	}

	async stop(request: StopSessionRequest): Promise<SessionSnapshot> {
		this.stopTimer();
		const snapshot = this.store.patchSnapshot((current) => ({
			...current,
			session: {
				...current.session,
				started: false,
				stoppedAt: new Date().toISOString(),
			},
			replay: current.replay
				? {
						...current.replay,
						running: false,
					}
				: null,
		}));
		if (request.clearReplayState) {
			this.store.reset();
		}
		this.broadcastLifecycle("session.stopped", {}, this.nextGeneratedSequence());
		return request.clearReplayState ? this.store.getSnapshot() : snapshot;
	}

	async prompt(_request: PromptRequest): Promise<PromptResponse> {
		return {
			accepted: false,
			mode: "replay",
			turnId: this.store.getSnapshot().turn.turnId,
			message: "Prompt execution is disabled in replay mode.",
		};
	}

	async abort(_request: AbortRequest): Promise<AbortResponse> {
		this.stopTimer();
		this.patchReplay({ running: false });
		return {
			accepted: true,
			mode: "replay",
			turnId: this.store.getSnapshot().turn.turnId,
			message: "Replay stopped.",
		};
	}

	getState(): SessionSnapshot {
		return this.store.getSnapshot();
	}

	getMessages(): MessagesResponse {
		return this.store.getMessages();
	}

	getAgents(): AgentsResponse {
		return this.store.getAgents();
	}

	getAgentHistory(agentId: string): AgentHistoryResponse {
		return this.store.getAgentHistory(agentId);
	}

	async getRoleSessions(): Promise<RoleSessionsResponse> {
		const roleSessions = {
			roleSessions: await readRoleSessions(this.cwd, this.sessionId),
		};
		this.store.setRoleSessions(roleSessions);
		return roleSessions;
	}

	async getSharedStateManifest(): Promise<SharedStateManifestResponse> {
		const root = this.getSharedStateRoot();
		const manifest = await readSharedStateManifest(root);
		this.store.setSharedStateManifest(manifest);
		return manifest;
	}

	async getSharedStateArtifact(path: string): Promise<SharedStateArtifactResponse> {
		return readSharedStateArtifact(this.getSharedStateRoot(), path);
	}

	async resetReplay(request: ReplayResetRequest): Promise<SessionSnapshot> {
		this.stopTimer();
		this.cursor = 0;
		const startedAt = this.replayFile?.timing.startedAt ?? new Date().toISOString();
		this.generatedSequence = replayStartedSequence(this.firstEnvelope());
		this.initializeStore(startedAt);
		this.broadcastLifecycle("replay.started", this.replayPayload(), this.generatedSequence);
		if (request.autoStart !== false) this.startTimer();
		return this.store.getSnapshot();
	}

	async setReplaySpeed(request: ReplaySpeedRequest): Promise<SessionSnapshot> {
		this.speed = request.speed;
		this.patchReplay({ speed: this.speed });
		return this.store.getSnapshot();
	}

	private initializeStore(startedAt: string): void {
		this.store.setSnapshot({
			...createEmptySessionSnapshot(),
			backendMode: "replay",
			session: {
				started: true,
				sessionId: this.sessionId,
				cwd: this.cwd,
				pid: null,
				startedAt,
				stoppedAt: null,
			},
			replay: {
				loaded: true,
				running: false,
				ended: false,
				logPath: this.logPath,
				speed: this.speed,
				cursor: this.cursor,
				totalEvents: this.replayFile?.events.length ?? 0,
				source: "sse_capture",
			},
		});
	}

	private startTimer(): void {
		this.stopTimer();
		this.patchReplay({ running: true, ended: false });
		this.timer = setTimeout(() => this.tick(), 0);
	}

	private tick(): void {
		this.timer = null;
		const events = this.replayFile?.events ?? [];
		let delayMs = 0;
		let processed = 0;
		do {
			if (this.cursor >= events.length) {
				this.patchReplay({ running: false, ended: true, cursor: this.cursor });
				this.store.patchSnapshot((current) => ({
					...current,
					turn: {
						...current.turn,
						status: current.turn.turnId ? "completed" : current.turn.status,
						updatedAt: new Date().toISOString(),
					},
				}));
				this.broadcastLifecycle("replay.completed", this.replayPayload(), this.nextGeneratedSequence());
				return;
			}

			const event = events[this.cursor];
			this.cursor += 1;
			this.reducer.apply(event.envelope);
			this.patchReplay({ cursor: this.cursor, speed: this.speed });
			this.sseBus.broadcastEnvelope(toReplayEnvelope(event.envelope));

			const nextEvent = events[this.cursor];
			delayMs = nextEvent ? replayDelayMs(nextEvent, this.speed) : 0;
			processed += 1;
		} while (delayMs === 0 && processed < this.maxEventsPerTick);
		this.timer = setTimeout(() => this.tick(), delayMs);
	}

	private stopTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
	}

	private patchReplay(patch: Partial<NonNullable<SessionSnapshot["replay"]>>): void {
		this.store.patchSnapshot((current) => ({
			...current,
			replay: current.replay ? { ...current.replay, ...patch } : null,
		}));
	}

	private replayPayload(): ReplayPayload {
		return {
			logPath: this.logPath ?? this.defaultLogPath,
			cursor: this.cursor,
			totalEvents: this.replayFile?.events.length ?? 0,
			speed: this.speed,
		};
	}

	private getSharedStateRoot(): string | null {
		return locateSharedStateRoot({ explicitRoot: this.explicitSharedStateRoot, snapshot: this.store.getSnapshot() });
	}

	private firstEnvelope(): SseEnvelope | null {
		return this.replayFile?.events[0]?.envelope ?? null;
	}

	private broadcastLifecycle(eventType: SseEventType, payload: unknown, sequence: number): void {
		const snapshot = this.store.getSnapshot();
		this.sseBus.broadcastEnvelope({
			eventId: randomUUID(),
			eventType,
			mode: "replay",
			sessionId: snapshot.session.sessionId,
			turnId: snapshot.turn.turnId,
			sequence,
			createdAt: new Date().toISOString(),
			payload,
		});
	}

	private nextGeneratedSequence(): number {
		const previousCaptureSequence = this.replayFile?.events[this.cursor - 1]?.envelope.sequence ?? 0;
		this.generatedSequence = Math.max(this.generatedSequence, previousCaptureSequence) + 1;
		return this.generatedSequence;
	}
}

async function readReplayFile(path: string): Promise<SseReplayFile> {
	if (!existsSync(path)) throw new ApiError("REPLAY_FILE_NOT_FOUND", `Replay file not found: ${path}`, 404);
	try {
		return await readSseCaptureReplay(path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.startsWith("Invalid SSE replay JSON")) throw new ApiError("REPLAY_FILE_INVALID_JSON", message, 400);
		if (message.startsWith("Unsupported SSE replay kind"))
			throw new ApiError("REPLAY_KIND_UNSUPPORTED", message, 400);
		if (message.startsWith("Unsupported SSE replay schema version")) {
			throw new ApiError("REPLAY_SCHEMA_UNSUPPORTED", message, 400);
		}
		throw new ApiError("REPLAY_FILE_INVALID_JSON", message, 400);
	}
}

function toReplayEnvelope(envelope: SseEnvelope): SseEnvelope {
	return { ...envelope, mode: "replay" };
}

function replayDelayMs(event: SseReplayEvent, speed: number): number {
	return Math.max(0, Math.round(event.afterPreviousMs / speed));
}

function replayStartedSequence(firstEnvelope: SseEnvelope | null): number {
	return Math.min(0, (firstEnvelope?.sequence ?? 1) - 1);
}

function resolveReplayLogPath(logPath: string, cwd: string): string {
	if (logPath.startsWith("/")) return logPath;
	const fromCwd = resolve(cwd, logPath);
	if (existsSync(fromCwd)) return fromCwd;
	const fromRepoRoot = resolve(cwd, "../..", logPath);
	if (existsSync(fromRepoRoot)) return fromRepoRoot;
	return fromCwd;
}
