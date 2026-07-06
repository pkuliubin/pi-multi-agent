import type {
	AgentEventPayload,
	AgentHistoryItem,
	AgentUpdatedPayload,
	MessageCompletedPayload,
	MessageDeltaPayload,
	SharedStateChangedPayload,
	SseEnvelope,
	TimelineMessage,
	ToolEventPayload,
} from "../contract.ts";
import { compareHistoryItems, mergeHistoryItem } from "../events/agent-history-merge.ts";
import type { SessionStore } from "../session-store.ts";

type AgentStatus = Extract<AgentHistoryItem, { type: "status" }>["status"];

export class SseEnvelopeReducer {
	private readonly store: SessionStore;

	constructor(store: SessionStore) {
		this.store = store;
	}

	apply(envelope: SseEnvelope): void {
		this.patchTurn(envelope);
		switch (envelope.eventType) {
			case "message.delta":
			case "agent.message.delta":
				this.applyMessageDelta(envelope.payload as MessageDeltaPayload, envelope.createdAt, envelope.eventType);
				break;
			case "message.completed":
				this.upsertMessage((envelope.payload as MessageCompletedPayload).message);
				break;
			case "tool.started":
			case "tool.updated":
			case "tool.completed":
			case "agent.tool.started":
			case "agent.tool.updated":
			case "agent.tool.completed":
				this.upsertToolEvent(envelope.payload as ToolEventPayload, envelope.createdAt);
				break;
			case "agent.updated":
				this.applyAgentUpdated(envelope.payload as AgentUpdatedPayload);
				break;
			case "agent.event":
				this.applyAgentEvent(envelope.payload as AgentEventPayload, envelope.turnId);
				break;
			case "shared_state.changed":
				this.applySharedStateChanged(envelope.payload as SharedStateChangedPayload, envelope.createdAt);
				break;
			case "session.started":
			case "session.stopped":
			case "replay.started":
			case "replay.completed":
			case "error":
				break;
		}
	}

	private patchTurn(envelope: SseEnvelope): void {
		this.store.patchSnapshot((current) => {
			if (envelope.eventType === "session.started") {
				return {
					...current,
					session: {
						...current.session,
						sessionId: envelope.sessionId ?? current.session.sessionId,
						startedAt: current.session.startedAt ?? envelope.createdAt,
					},
				};
			}

			if (envelope.eventType === "session.stopped") {
				return {
					...current,
					session: { ...current.session, stoppedAt: envelope.createdAt },
				};
			}

			const turnId = envelope.turnId ?? current.turn.turnId;
			const startedAt =
				envelope.turnId && current.turn.startedAt === null ? envelope.createdAt : current.turn.startedAt;
			const isCompletion = envelope.eventType === "message.completed" || envelope.eventType === "replay.completed";
			const status = current.turn.status === "idle" && envelope.turnId ? "running" : current.turn.status;
			return {
				...current,
				turn: {
					turnId,
					status: isCompletion ? current.turn.status : status,
					startedAt,
					updatedAt: envelope.createdAt,
				},
			};
		});
	}

	private applyMessageDelta(payload: MessageDeltaPayload, createdAt: string, rawType: string): void {
		const messages = this.store.getMessages().messages;
		const existing = messages.find((message) => message.id === payload.messageId);
		if (existing) {
			this.store.setMessages(
				messages.map((message) =>
					message.id === payload.messageId
						? {
								...message,
								content: `${message.content}${payload.delta}`,
								status: "streaming",
								updatedAt: createdAt,
							}
						: message,
				),
			);
			return;
		}

		this.store.setMessages([
			...messages,
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
				rawType,
				toolName: null,
				toolCallId: null,
			},
		]);
	}

	private upsertToolEvent(payload: ToolEventPayload, createdAt: string): void {
		this.upsertMessage({
			id: payload.toolCallId,
			source: (payload.agentId ?? agentIdFromToolSummary(payload)) ? "agent" : "main",
			agentId: payload.agentId ?? agentIdFromToolSummary(payload),
			role: "tool",
			kind: "tool_event",
			content: [payload.toolName, payload.argsSummary, payload.resultSummary].filter(Boolean).join(" · "),
			status: payload.status === "running" ? "streaming" : payload.status,
			createdAt,
			updatedAt: createdAt,
			rawType: payload.toolName,
			toolName: payload.toolName,
			toolCallId: payload.toolCallId,
		});
	}

	private upsertMessage(nextMessage: TimelineMessage): void {
		const messages = this.store.getMessages().messages;
		const exists = messages.some((message) => message.id === nextMessage.id);
		this.store.setMessages(
			exists
				? messages.map((message) => (message.id === nextMessage.id ? nextMessage : message))
				: [...messages, nextMessage],
		);
	}

	private applyAgentUpdated(payload: AgentUpdatedPayload): void {
		const agents = this.store.getAgents().agents;
		const exists = agents.some((agent) => agent.agentId === payload.agent.agentId);
		this.store.setAgents(
			exists
				? agents.map((agent) => (agent.agentId === payload.agent.agentId ? payload.agent : agent))
				: [...agents, payload.agent],
		);
		if (payload.agent.sharedStateRoot) {
			this.store.patchSnapshot((current) => ({
				...current,
				sharedState: { ...current.sharedState, root: current.sharedState.root ?? payload.agent.sharedStateRoot },
			}));
		}
	}

	private applyAgentEvent(payload: AgentEventPayload, turnId: string | null): void {
		const event = payload.event;
		if (event.type === "agent.message.delta") {
			this.appendAgentHistory(event.agentId, {
				id: `message-${event.agentId}-${event.invocationId ?? "none"}-${event.messageId}`,
				agentId: event.agentId,
				turnId,
				invocationId: event.invocationId,
				type: "message",
				role: "assistant",
				content: event.delta,
				createdAt: event.timestamp,
			});
			return;
		}

		if (event.type === "agent.message.completed") {
			this.appendAgentHistory(event.agentId, {
				id: `message-${event.agentId}-${event.invocationId ?? "none"}-${event.messageId}`,
				agentId: event.agentId,
				turnId,
				invocationId: event.invocationId,
				type: "message",
				role: "assistant",
				content: event.preview,
				createdAt: event.timestamp,
			});
			return;
		}

		if (
			event.type === "agent.tool.started" ||
			event.type === "agent.tool.updated" ||
			event.type === "agent.tool.completed"
		) {
			this.appendAgentHistory(event.agentId, {
				id: `tool-${event.agentId}-${event.invocationId ?? "none"}-${event.toolCallId}`,
				agentId: event.agentId,
				turnId,
				invocationId: event.invocationId,
				type: "tool_call",
				toolName: event.toolName,
				toolCallId: event.toolCallId,
				status: event.status,
				args: event.argsSummary ?? null,
				result: event.resultSummary ?? null,
				createdAt: event.timestamp,
			});
			return;
		}

		this.appendAgentHistory(event.agentId, {
			id: `status-${event.agentId}-${event.invocationId ?? "none"}-${event.sequence}-${event.type}`,
			agentId: event.agentId,
			turnId,
			invocationId: event.invocationId,
			type: "status",
			status: statusFromAgentEventType(event.type),
			content: event.type,
			createdAt: event.timestamp,
		});
	}

	private appendAgentHistory(agentId: string, item: AgentHistoryItem): void {
		const existing = this.store.getAgentHistory(agentId).items;
		const byId = new Map(existing.map((historyItem) => [historyItem.id, historyItem]));
		byId.set(item.id, mergeHistoryItem(byId.get(item.id), item));
		this.store.setAgentHistory(agentId, Array.from(byId.values()).sort(compareHistoryItems));
	}

	private applySharedStateChanged(_payload: SharedStateChangedPayload, createdAt: string): void {
		this.store.patchSnapshot((current) => ({
			...current,
			sharedState: { ...current.sharedState, updatedAt: createdAt },
		}));
	}
}

function statusFromAgentEventType(type: AgentEventPayload["event"]["type"]): AgentStatus {
	if (type === "agent.completed") return "completed";
	if (type === "agent.failed") return "failed";
	if (type === "agent.aborted") return "aborted";
	return "running";
}

function agentIdFromToolSummary(payload: ToolEventPayload): string | null {
	if (payload.toolName !== "run_subagent") return null;
	const match = /^agentId:\s*(.+)$/m.exec(payload.resultSummary ?? "");
	return match?.[1]?.trim() ?? null;
}
