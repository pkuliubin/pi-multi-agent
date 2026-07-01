import type {
	AgentHistoryResponse,
	AgentUpdatedPayload,
	ErrorPayload,
	MessageCompletedPayload,
	MessageDeltaPayload,
	SharedStateArtifactResponse,
	SharedStateChangedPayload,
	SseEnvelope,
	TimelineMessage,
	ToolEventPayload,
} from "../api/contracts.ts";
import type { HydratePayload, WebUiState } from "./app-state.ts";

export type WebUiAction =
	| { type: "hydrate.started" }
	| { type: "hydrate.completed"; payload: HydratePayload }
	| { type: "hydrate.failed"; message: string }
	| { type: "connection.opened" }
	| { type: "connection.interrupted" }
	| { type: "sse.received"; envelope: SseEnvelope }
	| { type: "agent.history.started"; agentId: string }
	| { type: "agent.history.completed"; history: AgentHistoryResponse }
	| { type: "agent.history.failed"; agentId: string; message: string }
	| { type: "artifact.select"; path: string | null }
	| { type: "artifact.load.started"; path: string }
	| { type: "artifact.load.completed"; artifact: SharedStateArtifactResponse }
	| { type: "artifact.load.failed"; path: string; message: string }
	| { type: "input.pending"; pending: boolean }
	| { type: "input.notice"; message: string | null }
	| { type: "error.dismiss" };

export function webUiReducer(state: WebUiState, action: WebUiAction): WebUiState {
	switch (action.type) {
		case "hydrate.started":
			return {
				...state,
				connection: {
					...state.connection,
					reconnecting: true,
				},
			};
		case "hydrate.completed":
			return hydrateState(state, action.payload);
		case "hydrate.failed":
			return {
				...state,
				connection: {
					...state.connection,
					reconnecting: false,
					errorBanner: action.message,
				},
			};
		case "connection.opened":
			return {
				...state,
				connection: {
					...state.connection,
					connected: true,
					reconnecting: false,
					errorBanner: null,
				},
			};
		case "connection.interrupted":
			return {
				...state,
				connection: {
					...state.connection,
					connected: false,
					reconnecting: true,
					errorBanner: "Connection interrupted. Rehydrating when the backend is reachable.",
				},
			};
		case "sse.received":
			return applySseEnvelope(state, action.envelope);
		case "agent.history.started":
			return {
				...state,
				agentHistory: {
					...state.agentHistory,
					loadingById: { ...state.agentHistory.loadingById, [action.agentId]: true },
					errorById: { ...state.agentHistory.errorById, [action.agentId]: null },
				},
			};
		case "agent.history.completed":
			return {
				...state,
				agentHistory: {
					...state.agentHistory,
					byId: { ...state.agentHistory.byId, [action.history.agentId]: action.history },
					loadingById: { ...state.agentHistory.loadingById, [action.history.agentId]: false },
					errorById: { ...state.agentHistory.errorById, [action.history.agentId]: null },
				},
			};
		case "agent.history.failed":
			return {
				...state,
				agentHistory: {
					...state.agentHistory,
					loadingById: { ...state.agentHistory.loadingById, [action.agentId]: false },
					errorById: { ...state.agentHistory.errorById, [action.agentId]: action.message },
				},
			};
		case "artifact.select":
			return {
				...state,
				sharedState: {
					...state.sharedState,
					selectedArtifactPath: action.path,
					error: null,
				},
			};
		case "artifact.load.started":
			return {
				...state,
				sharedState: {
					...state.sharedState,
					loadingPath: action.path,
					error: null,
				},
			};
		case "artifact.load.completed":
			return {
				...state,
				sharedState: {
					...state.sharedState,
					loadingPath:
						state.sharedState.loadingPath === action.artifact.path ? null : state.sharedState.loadingPath,
					artifactContentByPath: {
						...state.sharedState.artifactContentByPath,
						[action.artifact.path]: action.artifact,
					},
					error: null,
				},
			};
		case "artifact.load.failed":
			return {
				...state,
				sharedState: {
					...state.sharedState,
					loadingPath: state.sharedState.loadingPath === action.path ? null : state.sharedState.loadingPath,
					error: action.message,
				},
			};
		case "input.pending":
			return {
				...state,
				input: {
					...state.input,
					pending: action.pending,
				},
			};
		case "input.notice":
			return {
				...state,
				input: {
					...state.input,
					notice: action.message,
				},
			};
		case "error.dismiss":
			return {
				...state,
				connection: {
					...state.connection,
					errorBanner: null,
				},
				sharedState: {
					...state.sharedState,
					error: null,
				},
				input: {
					...state.input,
					notice: null,
				},
			};
	}
}

function hydrateState(state: WebUiState, payload: HydratePayload): WebUiState {
	const nextArtifactPaths = new Set(payload.manifest.artifacts.map((artifact) => artifact.path));
	const sameSession =
		state.session?.session.sessionId === payload.session.session.sessionId &&
		state.session?.backendMode === payload.session.backendMode;

	return {
		...state,
		session: payload.session,
		messages: payload.messages.messages,
		agentsById: Object.fromEntries(payload.agents.agents.map((agent) => [agent.agentId, agent])),
		sharedState: {
			...state.sharedState,
			root: payload.manifest.root,
			artifacts: payload.manifest.artifacts,
			selectedArtifactPath: keepSelectedPath(
				state.sharedState.selectedArtifactPath,
				payload.manifest.artifacts.map((artifact) => artifact.path),
			),
			artifactContentByPath: pruneArtifactCache(state.sharedState.artifactContentByPath, nextArtifactPaths),
			error: null,
		},
		connection: {
			...state.connection,
			lastSequence: sameSession ? state.connection.lastSequence : null,
			reconnecting: false,
			errorBanner: null,
		},
	};
}

function applySseEnvelope(state: WebUiState, envelope: SseEnvelope): WebUiState {
	if (state.connection.lastSequence !== null && envelope.sequence <= state.connection.lastSequence) {
		return state;
	}

	const baseState = {
		...state,
		connection: {
			...state.connection,
			lastSequence: envelope.sequence,
		},
	};

	switch (envelope.eventType) {
		case "message.delta":
		case "agent.message.delta":
			return applyMessageDelta(baseState, envelope.payload as MessageDeltaPayload, envelope.createdAt);
		case "message.completed":
			return upsertMessage(baseState, (envelope.payload as MessageCompletedPayload).message);
		case "tool.started":
		case "tool.updated":
		case "tool.completed":
		case "agent.tool.started":
		case "agent.tool.updated":
		case "agent.tool.completed":
			return upsertToolEvent(baseState, envelope.payload as ToolEventPayload, envelope.createdAt);
		case "agent.event":
			return baseState;
		case "agent.updated":
			return upsertAgent(baseState, envelope.payload as AgentUpdatedPayload);
		case "shared_state.changed":
			return invalidateArtifacts(baseState, envelope.payload as SharedStateChangedPayload);
		case "error":
			return applyBackendError(baseState, envelope.payload as ErrorPayload);
		case "session.started":
		case "session.stopped":
		case "replay.started":
		case "replay.completed":
			return baseState;
	}
}

function applyMessageDelta(state: WebUiState, payload: MessageDeltaPayload, createdAt: string): WebUiState {
	const existing = state.messages.find((message) => message.id === payload.messageId);

	if (existing) {
		return {
			...state,
			messages: state.messages.map((message) =>
				message.id === payload.messageId
					? {
							...message,
							content: `${message.content}${payload.delta}`,
							status: "streaming",
							updatedAt: createdAt,
						}
					: message,
			),
		};
	}

	return {
		...state,
		messages: [
			...state.messages,
			{
				id: payload.messageId,
				source: payload.source,
				agentId: payload.agentId,
				role: payload.role,
				kind: "message",
				content: payload.delta,
				status: "streaming",
				createdAt,
				updatedAt: createdAt,
				rawType: "message.delta",
				toolName: null,
				toolCallId: null,
			},
		],
	};
}

function upsertMessage(state: WebUiState, nextMessage: TimelineMessage): WebUiState {
	const exists = state.messages.some((message) => message.id === nextMessage.id);

	return {
		...state,
		messages: exists
			? state.messages.map((message) => (message.id === nextMessage.id ? nextMessage : message))
			: [...state.messages, nextMessage],
	};
}

function upsertToolEvent(state: WebUiState, payload: ToolEventPayload, createdAt: string): WebUiState {
	const toolMessage: TimelineMessage = {
		id: payload.toolCallId,
		source: payload.agentId ? "agent" : "main",
		agentId: payload.agentId,
		role: "tool",
		kind: "tool_event",
		content: formatToolEventContent(payload),
		status: payload.status === "running" ? "streaming" : payload.status,
		createdAt,
		updatedAt: createdAt,
		rawType: payload.toolName,
		toolName: payload.toolName,
		toolCallId: payload.toolCallId,
	};

	return upsertMessage(state, toolMessage);
}

function upsertAgent(state: WebUiState, payload: AgentUpdatedPayload): WebUiState {
	return {
		...state,
		agentsById: {
			...state.agentsById,
			[payload.agent.agentId]: payload.agent,
		},
	};
}

function invalidateArtifacts(state: WebUiState, payload: SharedStateChangedPayload): WebUiState {
	if (payload.paths.length === 0) {
		return {
			...state,
			sharedState: {
				...state.sharedState,
				artifactContentByPath: {},
			},
		};
	}

	const nextContent = { ...state.sharedState.artifactContentByPath };

	for (const path of payload.paths) {
		delete nextContent[path];
	}

	return {
		...state,
		sharedState: {
			...state.sharedState,
			artifactContentByPath: nextContent,
		},
	};
}

function applyBackendError(state: WebUiState, payload: ErrorPayload): WebUiState {
	return {
		...state,
		connection: {
			...state.connection,
			errorBanner: `${payload.code}: ${payload.message}`,
		},
	};
}

function keepSelectedPath(selectedPath: string | null, paths: string[]): string | null {
	if (selectedPath && paths.includes(selectedPath)) {
		return selectedPath;
	}

	return paths[0] ?? null;
}

function pruneArtifactCache(
	cache: WebUiState["sharedState"]["artifactContentByPath"],
	manifestPaths: Set<string>,
): WebUiState["sharedState"]["artifactContentByPath"] {
	const nextCache: WebUiState["sharedState"]["artifactContentByPath"] = {};

	for (const [path, artifact] of Object.entries(cache)) {
		if (manifestPaths.has(path)) {
			nextCache[path] = artifact;
		}
	}

	return nextCache;
}

function formatToolEventContent(payload: ToolEventPayload): string {
	return [payload.toolName, payload.argsSummary, payload.resultSummary].filter(Boolean).join(" · ");
}
