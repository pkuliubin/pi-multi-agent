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
	StartSessionRequest,
	StopSessionRequest,
} from "../contract.ts";
import { invalidMode } from "../errors.ts";
import type { SseBus } from "../events/sse-bus.ts";
import { type ReplayLogRecord, readReplayLog } from "../replay/jsonl-log-reader.ts";
import { ReplayStateReducer } from "../replay/replay-state-reducer.ts";
import { readRoleSessions } from "../role-sessions/role-session-reader.ts";
import { createEmptySessionSnapshot, type SessionStore } from "../session-store.ts";
import { readSharedStateArtifact } from "../shared-state/artifact-reader.ts";
import { locateSharedStateRoot } from "../shared-state/locator.ts";
import { readSharedStateManifest } from "../shared-state/manifest-reader.ts";
import type { BackendEngine } from "./engine.ts";

const DEFAULT_REPLAY_LOG = "data/sharedstate_multi_agent_cli_log.jsonl";
const DEFAULT_SPEED = 1;
const BASE_EVENT_DELAY_MS = 20;

export interface ReplayEngineOptions {
	defaultLogPath?: string;
}

export class ReplayEngine implements BackendEngine {
	private readonly store: SessionStore;
	private readonly sseBus: SseBus;
	private readonly defaultLogPath: string;
	private readonly reducer = new ReplayStateReducer();
	private records: ReplayLogRecord[] = [];
	private timer: NodeJS.Timeout | null = null;
	private cursor = 0;
	private logPath: string | null = null;
	private speed = DEFAULT_SPEED;
	private sessionId: string | null = null;
	private cwd: string | null = null;
	private explicitSharedStateRoot: string | null = null;

	constructor(store: SessionStore, sseBus: SseBus, options: ReplayEngineOptions = {}) {
		this.store = store;
		this.sseBus = sseBus;
		this.defaultLogPath = options.defaultLogPath ?? DEFAULT_REPLAY_LOG;
	}

	async start(request: StartSessionRequest): Promise<SessionSnapshot> {
		if (request.mode !== "replay") throw invalidMode("ReplayEngine only supports replay mode");
		this.stopTimer();
		this.reducer.reset();
		this.cursor = 0;
		this.logPath = resolveReplayLogPath(request.replay?.logPath ?? this.defaultLogPath, request.cwd ?? process.cwd());
		this.speed = request.replay?.speed ?? DEFAULT_SPEED;
		this.explicitSharedStateRoot = request.sharedStateRoot ?? null;
		this.records = await readReplayLog(this.logPath);
		const header = this.records.find((record) => record.type === "session");
		this.sessionId = typeof header?.id === "string" ? header.id : `replay-${Date.now()}`;
		this.cwd = typeof header?.cwd === "string" ? header.cwd : (request.cwd ?? process.cwd());
		const startedAt = typeof header?.timestamp === "string" ? header.timestamp : new Date().toISOString();
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
				totalEvents: this.records.length,
			},
		});
		this.broadcast("session.started", {});
		this.broadcast("replay.started", this.replayPayload());
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
		this.broadcast("session.stopped", {});
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
		this.reducer.reset();
		this.cursor = 0;
		const agentIds = this.store.getAgents().agents.map((agent) => agent.agentId);
		this.store.setMessages([]);
		this.store.setAgents([]);
		for (const agentId of agentIds) {
			this.store.setAgentHistory(agentId, []);
		}
		this.store.patchSnapshot((current) => ({
			...current,
			turn: {
				turnId: null,
				status: "idle",
				startedAt: null,
				updatedAt: null,
			},
			replay: current.replay
				? {
						...current.replay,
						running: false,
						ended: false,
						cursor: 0,
					}
				: null,
		}));
		if (request.autoStart !== false) this.startTimer();
		return this.store.getSnapshot();
	}

	async setReplaySpeed(request: ReplaySpeedRequest): Promise<SessionSnapshot> {
		this.speed = request.speed;
		this.patchReplay({ speed: this.speed });
		return this.store.getSnapshot();
	}

	private startTimer(): void {
		this.stopTimer();
		this.patchReplay({ running: true, ended: false });
		this.timer = setTimeout(() => this.tick(), 0);
	}

	private tick(): void {
		this.timer = null;
		if (this.cursor >= this.records.length) {
			this.patchReplay({ running: false, ended: true, cursor: this.cursor });
			this.broadcast("replay.completed", this.replayPayload());
			return;
		}

		const record = this.records[this.cursor];
		this.cursor += 1;
		const result = this.reducer.apply(record);
		this.store.setMessages(result.messages);
		this.store.setAgents(result.agents);
		for (const [agentId, items] of Object.entries(result.agentHistoryById)) {
			this.store.setAgentHistory(agentId, items);
		}
		const now = new Date().toISOString();
		this.store.patchSnapshot((current) => ({
			...current,
			turn: {
				turnId: result.turnStarted
					? (current.turn.turnId ?? `replay-turn-${this.sessionId ?? "session"}`)
					: current.turn.turnId,
				status: result.turnEnded ? "completed" : result.turnStarted ? "running" : current.turn.status,
				startedAt: result.turnStarted ? (current.turn.startedAt ?? now) : current.turn.startedAt,
				updatedAt: now,
			},
			sharedState: {
				...current.sharedState,
				root: result.sharedStateRoot ?? current.sharedState.root,
			},
			replay: current.replay
				? {
						...current.replay,
						cursor: this.cursor,
						speed: this.speed,
					}
				: null,
		}));

		for (const event of result.events) {
			this.broadcast(event.eventType, event.payload);
		}

		this.timer = setTimeout(() => this.tick(), Math.max(1, Math.round(BASE_EVENT_DELAY_MS / this.speed)));
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
			totalEvents: this.records.length,
			speed: this.speed,
		};
	}

	private getSharedStateRoot(): string | null {
		return locateSharedStateRoot({ explicitRoot: this.explicitSharedStateRoot, snapshot: this.store.getSnapshot() });
	}

	private broadcast(eventType: Parameters<SseBus["broadcast"]>[0], payload: unknown): void {
		const snapshot = this.store.getSnapshot();
		this.sseBus.broadcast(
			eventType,
			{
				mode: "replay",
				sessionId: snapshot.session.sessionId,
				turnId: snapshot.turn.turnId,
			},
			payload,
		);
	}
}

function resolveReplayLogPath(logPath: string, cwd: string): string {
	if (logPath.startsWith("/")) return logPath;
	const fromCwd = resolve(cwd, logPath);
	if (existsSync(fromCwd)) return fromCwd;
	const fromRepoRoot = resolve(cwd, "../..", logPath);
	if (existsSync(fromRepoRoot)) return fromRepoRoot;
	return fromCwd;
}
