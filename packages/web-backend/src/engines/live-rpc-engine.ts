import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { RpcClient, type RpcClientOptions } from "@earendil-works/pi-coding-agent";
import type {
	AbortRequest,
	AbortResponse,
	AgentCard,
	AgentHistoryItem,
	AgentHistoryResponse,
	AgentsResponse,
	MessagesResponse,
	PromptRequest,
	PromptResponse,
	RoleSessionsResponse,
	SessionSnapshot,
	SharedStateArtifactResponse,
	SharedStateManifestResponse,
	StartSessionRequest,
	StopSessionRequest,
} from "../contract.ts";
import { invalidMode } from "../errors.ts";
import { agentHistoryItemsFromProgressEvents } from "../events/agent-history.ts";
import { normalizeAgentEvent, timelineMessageFromAgentMessage } from "../events/normalize-event.ts";
import { reduceRunSubagentProgress } from "../events/run-subagent-progress.ts";
import type { SseBus } from "../events/sse-bus.ts";
import {
	extractAgentObservabilityFromRunSubagentPayload,
	observabilityEvents,
} from "../events/subagent-observability.ts";
import { readRoleSessions } from "../role-sessions/role-session-reader.ts";
import { createEmptySessionSnapshot, type SessionStore } from "../session-store.ts";
import { readSharedStateArtifact } from "../shared-state/artifact-reader.ts";
import { locateSharedStateRoot } from "../shared-state/locator.ts";
import { readSharedStateManifest } from "../shared-state/manifest-reader.ts";
import type { BackendEngine } from "./engine.ts";

export interface LiveRpcClientLike {
	start(): Promise<void>;
	stop(): Promise<void>;
	prompt(message: string): Promise<void>;
	abort(): Promise<void>;
	getState(): Promise<{
		sessionId: string;
		sessionFile?: string;
		isStreaming: boolean;
		isCompacting: boolean;
		messageCount: number;
		pendingMessageCount: number;
	}>;
	getMessages(): Promise<AgentMessage[]>;
	onEvent(listener: Parameters<RpcClient["onEvent"]>[0]): () => void;
	getStderr?(): string;
}

export interface LiveRpcEngineOptions {
	createClient?: (options: RpcClientOptions) => LiveRpcClientLike;
	defaultProvider?: string;
	defaultModel?: string;
	defaultRunSubagentEnabled?: boolean;
}

export class LiveRpcEngine implements BackendEngine {
	private readonly store: SessionStore;
	private readonly sseBus: SseBus;
	private readonly createClient: (options: RpcClientOptions) => LiveRpcClientLike;
	private client: LiveRpcClientLike | null = null;
	private unsubscribe: (() => void) | null = null;
	private cwd: string | null = null;
	private explicitSharedStateRoot: string | null = null;
	private eventSequence = 0;
	private readonly toolArgsByCallId = new Map<string, unknown>();
	private readonly defaultProvider: string;
	private readonly defaultModel: string;
	private readonly defaultRunSubagentEnabled: boolean;

	constructor(store: SessionStore, sseBus: SseBus, options: LiveRpcEngineOptions = {}) {
		this.store = store;
		this.sseBus = sseBus;
		this.createClient = options.createClient ?? ((clientOptions) => new RpcClient(clientOptions));
		this.defaultProvider = options.defaultProvider ?? process.env.PI_WEB_BACKEND_DEFAULT_PROVIDER ?? "deepseek";
		this.defaultModel = options.defaultModel ?? process.env.PI_WEB_BACKEND_DEFAULT_MODEL ?? "deepseek-v4-flash";
		this.defaultRunSubagentEnabled =
			options.defaultRunSubagentEnabled ?? process.env.PI_WEB_BACKEND_RUN_SUBAGENT !== "0";
	}

	async start(request: StartSessionRequest): Promise<SessionSnapshot> {
		if (request.mode !== "live") throw invalidMode("LiveRpcEngine only supports live mode");
		this.cwd = request.cwd ?? defaultLiveCwd();
		this.explicitSharedStateRoot = request.sharedStateRoot ?? null;
		const client = this.createClient({
			cliPath: request.live?.cliPath ?? defaultCodingAgentCliPath(),
			cwd: this.cwd,
			env: this.clientEnv(),
			provider: request.live?.provider ?? this.defaultProvider,
			model: request.live?.model ?? this.defaultModel,
			args: request.live?.args,
		});
		this.client = client;
		this.eventSequence = 0;
		this.toolArgsByCallId.clear();
		this.unsubscribe = client.onEvent((event) => {
			if ("args" in event) {
				this.toolArgsByCallId.set(event.toolCallId, event.args);
			}

			if (event.type === "agent_end") {
				this.store.patchSnapshot((current) => ({
					...current,
					turn: {
						...current.turn,
						status: turnStatusFromAgentEnd(event),
						updatedAt: new Date().toISOString(),
					},
				}));
			}

			const agent = this.updateAgentFromRunSubagentEvent(event);
			if (agent) {
				this.broadcast("agent.updated", {
					agent,
					changedFields: ["phase", "activeTool", "completedTools", "recentEvents", "lastAssistantPreview"],
				});
			}
			this.broadcastRunSubagentObservability(event);

			const sharedStateChange = sharedStateChangeFromToolEvent(
				event,
				event.type === "tool_execution_end" ? this.toolArgsByCallId.get(event.toolCallId) : undefined,
			);
			if (sharedStateChange) {
				this.broadcast("shared_state.changed", sharedStateChange);
			}
			if (event.type === "tool_execution_end") {
				this.toolArgsByCallId.delete(event.toolCallId);
			}

			for (const normalized of normalizeAgentEvent(event)) {
				this.broadcast(normalized.eventType, normalized.payload);
			}
		});
		await client.start();
		const state = await client.getState();
		const now = new Date().toISOString();
		this.store.setSnapshot({
			...createEmptySessionSnapshot(),
			backendMode: "live",
			session: {
				started: true,
				sessionId: state.sessionId,
				cwd: this.cwd,
				pid: null,
				startedAt: now,
				stoppedAt: null,
			},
			turn: {
				turnId: null,
				status: state.isStreaming || state.isCompacting ? "running" : "idle",
				startedAt: null,
				updatedAt: now,
			},
		});
		this.broadcast("session.started", {});
		return this.store.getSnapshot();
	}

	private clientEnv(): Record<string, string> {
		const env: Record<string, string> = {};
		if (this.defaultRunSubagentEnabled && !process.env.PI_MULTI_AGENT_RUN_SUBAGENT) {
			env.PI_MULTI_AGENT_RUN_SUBAGENT = "1";
		}
		if (this.explicitSharedStateRoot) {
			env.PI_MULTI_AGENT_SHARED_STATE_ROOT = this.explicitSharedStateRoot;
		}
		return env;
	}

	async stop(_request: StopSessionRequest): Promise<SessionSnapshot> {
		this.unsubscribe?.();
		this.unsubscribe = null;
		await this.client?.stop();
		this.client = null;
		this.toolArgsByCallId.clear();
		const snapshot = this.store.patchSnapshot((current) => ({
			...current,
			session: {
				...current.session,
				started: false,
				stoppedAt: new Date().toISOString(),
			},
			turn: {
				...current.turn,
				status: current.turn.status === "running" ? "aborted" : current.turn.status,
				updatedAt: new Date().toISOString(),
			},
		}));
		this.broadcast("session.stopped", {});
		return snapshot;
	}

	async prompt(request: PromptRequest): Promise<PromptResponse> {
		const client = this.requireClient();
		await client.prompt(request.text);
		const turnId = `live-turn-${Date.now()}`;
		this.store.patchSnapshot((current) => ({
			...current,
			turn: {
				turnId,
				status: "running",
				startedAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		}));
		return { accepted: true, mode: "live", turnId, message: null };
	}

	async abort(_request: AbortRequest): Promise<AbortResponse> {
		const client = this.requireClient();
		await client.abort();
		this.store.patchSnapshot((current) => ({
			...current,
			turn: {
				...current.turn,
				status: "aborted",
				updatedAt: new Date().toISOString(),
			},
		}));
		return { accepted: true, mode: "live", turnId: this.store.getSnapshot().turn.turnId, message: null };
	}

	getState(): SessionSnapshot {
		return this.store.getSnapshot();
	}

	async getMessages(): Promise<MessagesResponse> {
		const client = this.client;
		if (!client) return this.store.getMessages();
		const messages = (await client.getMessages()).map((message) =>
			timelineMessageFromAgentMessage(message, null, "completed"),
		);
		this.store.setMessages(messages);
		return { messages };
	}

	getAgents(): AgentsResponse {
		return this.store.getAgents();
	}

	getAgentHistory(agentId: string): AgentHistoryResponse {
		return this.store.getAgentHistory(agentId);
	}

	async getRoleSessions(): Promise<RoleSessionsResponse> {
		const roleSessions = {
			roleSessions: await readRoleSessions(this.cwd, this.store.getSnapshot().session.sessionId),
		};
		this.store.setRoleSessions(roleSessions);
		return roleSessions;
	}

	async getSharedStateManifest(): Promise<SharedStateManifestResponse> {
		const manifest = await readSharedStateManifest(this.getSharedStateRoot());
		this.store.setSharedStateManifest(manifest);
		return manifest;
	}

	async getSharedStateArtifact(path: string): Promise<SharedStateArtifactResponse> {
		return readSharedStateArtifact(this.getSharedStateRoot(), path);
	}

	private requireClient(): LiveRpcClientLike {
		if (!this.client) throw invalidMode("Live RPC client is not started");
		return this.client;
	}

	private getSharedStateRoot(): string | null {
		return locateSharedStateRoot({ explicitRoot: this.explicitSharedStateRoot, snapshot: this.store.getSnapshot() });
	}

	private updateAgentFromRunSubagentEvent(
		event: Parameters<Parameters<LiveRpcClientLike["onEvent"]>[0]>[0],
	): AgentCard | null {
		if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return null;
		const args = "args" in event ? event.args : this.toolArgsByCallId.get(event.toolCallId);
		const result = "result" in event ? event.result : undefined;
		const partialResult = "partialResult" in event ? event.partialResult : undefined;
		const candidateAgentId =
			typeof args === "object" && args !== null && "agentId" in args ? String(args.agentId) : null;
		const existing = candidateAgentId
			? this.store.getAgents().agents.find((agent) => agent.agentId === candidateAgentId)
			: null;
		const reduced = reduceRunSubagentProgress({
			toolName: event.toolName,
			args,
			partialResult,
			result,
			timestamp: new Date().toISOString(),
			existing,
			eventSequenceStart: this.eventSequence,
		});
		if (!reduced) return null;
		this.eventSequence = reduced.nextEventSequence;
		const progress = progressFromRunSubagentEvent(partialResult, result);
		if (observabilityEvents(partialResult, result).length === 0) {
			this.store.appendAgentHistory(
				reduced.agent.agentId,
				agentHistoryItemsFromProgressEvents({
					agentId: reduced.agent.agentId,
					turnId: this.store.getSnapshot().turn.turnId,
					recentEvents: arrayField(progress, "recentEvents"),
				}),
			);
		}
		const nextAgents = upsertAgent(this.store.getAgents().agents, reduced.agent);
		this.store.setAgents(nextAgents);
		if (reduced.sharedStateRoot) {
			this.store.patchSnapshot((current) => ({
				...current,
				sharedState: {
					...current.sharedState,
					root: reduced.sharedStateRoot,
				},
			}));
		}
		return reduced.agent;
	}

	private broadcastRunSubagentObservability(event: Parameters<Parameters<LiveRpcClientLike["onEvent"]>[0]>[0]): void {
		if (event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return;
		if (event.toolName !== "run_subagent") return;
		const result = "result" in event ? event.result : undefined;
		const partialResult = "partialResult" in event ? event.partialResult : undefined;
		const extracted = extractAgentObservabilityFromRunSubagentPayload({
			partialResult,
			result,
			turnId: this.store.getSnapshot().turn.turnId,
		});
		for (const [agentId, items] of groupHistoryItemsByAgent(extracted.historyItems)) {
			this.store.appendAgentHistory(agentId, items);
		}
		for (const eventToBroadcast of extracted.broadcasts) {
			this.broadcast(eventToBroadcast.eventType, eventToBroadcast.payload);
		}
	}

	private broadcast(eventType: Parameters<SseBus["broadcast"]>[0], payload: unknown): void {
		const snapshot = this.store.getSnapshot();
		this.sseBus.broadcast(
			eventType,
			{
				mode: "live",
				sessionId: snapshot.session.sessionId,
				turnId: snapshot.turn.turnId,
			},
			payload,
		);
	}
}

function progressFromRunSubagentEvent(partialResult: unknown, result: unknown): Record<string, unknown> | null {
	return (
		objectField(objectField(partialResult, "details"), "progress") ??
		objectField(objectField(result, "details"), "progress") ??
		null
	);
}

function arrayField(value: unknown, key: string): unknown[] {
	const field = unknownField(value, key);
	return Array.isArray(field) ? field : [];
}

function turnStatusFromAgentEnd(
	event: Extract<Parameters<Parameters<LiveRpcClientLike["onEvent"]>[0]>[0], { type: "agent_end" }>,
): "completed" | "failed" | "aborted" {
	const finalAssistant = [...event.messages]
		.reverse()
		.find((message) => unknownField(message, "role") === "assistant");
	const stopReason = unknownField(finalAssistant, "stopReason");
	if (stopReason === "aborted") return "aborted";
	if (stopReason === "error") return "failed";
	return "completed";
}

function objectField(value: unknown, key: string): Record<string, unknown> | undefined {
	const field =
		typeof value === "object" && value !== null && key in value ? (value as Record<string, unknown>)[key] : undefined;
	return typeof field === "object" && field !== null ? (field as Record<string, unknown>) : undefined;
}

function unknownField(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && key in value
		? (value as Record<string, unknown>)[key]
		: undefined;
}

function upsertAgent(agents: AgentCard[], nextAgent: AgentCard): AgentCard[] {
	const exists = agents.some((agent) => agent.agentId === nextAgent.agentId);
	return exists
		? agents.map((agent) => (agent.agentId === nextAgent.agentId ? nextAgent : agent))
		: [...agents, nextAgent];
}

function groupHistoryItemsByAgent(items: AgentHistoryItem[]): Map<string, AgentHistoryItem[]> {
	const grouped = new Map<string, AgentHistoryItem[]>();
	for (const item of items) {
		const existing = grouped.get(item.agentId) ?? [];
		existing.push(item);
		grouped.set(item.agentId, existing);
	}
	return grouped;
}

function sharedStateChangeFromToolEvent(
	event: Parameters<Parameters<LiveRpcClientLike["onEvent"]>[0]>[0],
	args: unknown,
): {
	paths: string[];
	reason: "run_subagent_completed" | "shared_state_write" | "shared_state_edit";
} | null {
	if (event.type !== "tool_execution_end") return null;
	if (event.toolName === "run_subagent") return { paths: [], reason: "run_subagent_completed" };
	if (
		event.toolName !== "shared_state.write" &&
		event.toolName !== "shared_state_write" &&
		event.toolName !== "shared_state.edit" &&
		event.toolName !== "shared_state_edit"
	) {
		return null;
	}
	const path =
		typeof args === "object" && args !== null && "path" in args && typeof args.path === "string" ? args.path : null;
	return {
		paths: path ? [path] : [],
		reason: event.toolName.endsWith("edit") ? "shared_state_edit" : "shared_state_write",
	};
}

function defaultCodingAgentCliPath(): string {
	const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../coding-agent/dist/cli.js");
	if (!existsSync(cliPath)) {
		throw new Error(
			`Coding agent CLI not found at ${cliPath}. Run npm --prefix packages/coding-agent run build first.`,
		);
	}
	return cliPath;
}

function defaultLiveCwd(): string {
	return process.env.PI_WEB_BACKEND_AGENT_CWD ?? findProjectRootWithAgents(process.cwd()) ?? process.cwd();
}

function findProjectRootWithAgents(startDir: string): string | null {
	let current = resolve(startDir);
	while (true) {
		if (existsSync(resolve(current, ".pi", "agents"))) return current;
		const parent = dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
