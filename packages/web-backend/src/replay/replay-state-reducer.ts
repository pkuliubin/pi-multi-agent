import type {
	AgentCard,
	AgentHistoryItem,
	MessageCompletedPayload,
	MessageDeltaPayload,
	SseEventType,
	TimelineMessage,
	ToolEventPayload,
} from "../contract.ts";
import { agentHistoryItemsFromProgressEvents } from "../events/agent-history.ts";
import { reduceRunSubagentProgress } from "../events/run-subagent-progress.ts";
import type { ReplayLogRecord } from "./jsonl-log-reader.ts";

export interface ReplayReductionResult {
	events: ReplayOutputEvent[];
	messages: TimelineMessage[];
	agents: AgentCard[];
	agentHistoryById: Record<string, AgentHistoryItem[]>;
	turnStarted: boolean;
	turnEnded: boolean;
	sharedStateRoot: string | null;
}

export interface ReplayOutputEvent {
	eventType: SseEventType;
	payload: unknown;
}

export class ReplayStateReducer {
	private readonly messages = new Map<string, TimelineMessage>();
	private readonly agents = new Map<string, AgentCard>();
	private readonly agentHistoryById = new Map<string, AgentHistoryItem[]>();
	private currentAssistantMessageId: string | null = null;
	private messageSequence = 0;
	private eventSequence = 0;
	private sharedStateRoot: string | null = null;
	private turnStarted = false;
	private turnEnded = false;

	apply(record: ReplayLogRecord): ReplayReductionResult {
		const events: ReplayOutputEvent[] = [];
		const timestamp = recordTimestamp(record) ?? new Date().toISOString();

		if (record.type === "turn_start") {
			this.turnStarted = true;
			this.turnEnded = false;
		}

		if (record.type === "turn_end") {
			this.turnEnded = true;
		}

		if (record.type === "message_start") {
			const message = recordMessage(record);
			if (message) {
				const role = normalizeRole(message.role);
				if (role !== "assistant" || typeof message.responseId === "string") {
					const timelineMessage = this.upsertMessageFromRaw(message, record.type, timestamp, "streaming");
					if (timelineMessage.source === "main" && timelineMessage.role === "assistant") {
						this.currentAssistantMessageId = timelineMessage.id;
					}
				}
			}
		}

		if (record.type === "message_update") {
			const message = recordMessage(record);
			const delta = messageDelta(record);
			const responseId = message ? stringValue(message.responseId) : null;
			const messageId = responseId ?? this.currentAssistantMessageId;
			if (delta && messageId) {
				const existing = this.messages.get(messageId);
				const updated: TimelineMessage = existing
					? {
							...existing,
							content: existing.content + delta,
							updatedAt: timestamp,
						}
					: createStreamingAssistantMessage(messageId, delta, timestamp, record.type);
				this.messages.set(updated.id, updated);
				this.currentAssistantMessageId = updated.id;
				events.push({
					eventType: "message.delta",
					payload: {
						messageId: updated.id,
						role: "assistant",
						source: "main",
						agentId: null,
						delta,
					} satisfies MessageDeltaPayload,
				});
			}
		}

		if (record.type === "message_end") {
			const message = recordMessage(record);
			if (message) {
				const timelineMessage = this.upsertMessageFromRaw(message, record.type, timestamp, "completed");
				events.push({
					eventType: "message.completed",
					payload: { message: timelineMessage } satisfies MessageCompletedPayload,
				});
			}
		}

		if (record.type === "tool_execution_start") {
			const payload = toolPayload(record, "running");
			if (payload) events.push({ eventType: "tool.started", payload });
		}

		if (record.type === "tool_execution_update") {
			const payload = toolPayload(record, "running");
			if (payload) events.push({ eventType: "tool.updated", payload });
			const agent = this.updateAgentFromRunSubagentRecord(record, timestamp);
			if (agent) {
				events.push({
					eventType: "agent.updated",
					payload: { agent, changedFields: ["phase", "activeTool", "completedTools", "recentEvents"] },
				});
			}
		}

		if (record.type === "tool_execution_end") {
			const payload = toolPayload(record, isErrorRecord(record) ? "failed" : "completed");
			if (payload) events.push({ eventType: "tool.completed", payload });
			const agent = this.updateAgentFromRunSubagentRecord(record, timestamp);
			if (agent) {
				events.push({
					eventType: "agent.updated",
					payload: { agent, changedFields: ["phase", "lastRunStatus", "lastAssistantPreview"] },
				});
			}
			if (payload?.toolName === "run_subagent") {
				events.push({
					eventType: "shared_state.changed",
					payload: { paths: [], reason: "run_subagent_completed" },
				});
			}
		}

		return {
			events,
			messages: Array.from(this.messages.values()),
			agents: Array.from(this.agents.values()),
			agentHistoryById: Object.fromEntries(this.agentHistoryById),
			turnStarted: this.turnStarted,
			turnEnded: this.turnEnded,
			sharedStateRoot: this.sharedStateRoot,
		};
	}

	reset(): void {
		this.messages.clear();
		this.agents.clear();
		this.agentHistoryById.clear();
		this.currentAssistantMessageId = null;
		this.messageSequence = 0;
		this.eventSequence = 0;
		this.sharedStateRoot = null;
		this.turnStarted = false;
		this.turnEnded = false;
	}

	private upsertMessageFromRaw(
		message: Record<string, unknown>,
		rawType: string,
		timestamp: string,
		status: TimelineMessage["status"],
	): TimelineMessage {
		const role = normalizeRole(message.role);
		const toolName = role === "tool" ? stringValue(message.toolName) : null;
		const toolCallId = role === "tool" ? stringValue(message.toolCallId) : null;
		const extractedContent = extractMessageText(message);
		const agentId = role === "tool" ? agentIdFromToolMessage(message, extractedContent) : null;
		const source = role === "tool" ? (agentId ? "agent" : "system") : "main";
		const id = this.messageIdFor(message, role);
		const existing = this.messages.get(id);
		const timelineMessage: TimelineMessage = {
			id,
			source,
			agentId,
			role,
			kind: role === "tool" ? "tool_event" : "message",
			content:
				role === "tool"
					? formatToolResultContent(toolName, extractedContent || existing?.content || "")
					: extractedContent || existing?.content || "",
			status,
			createdAt: existing?.createdAt ?? timestamp,
			updatedAt: timestamp,
			rawType: toolName ?? rawType,
			toolName,
			toolCallId,
		};
		this.messages.set(id, timelineMessage);
		return timelineMessage;
	}

	private messageIdFor(message: Record<string, unknown>, _role: TimelineMessage["role"]): string {
		if (typeof message.responseId === "string") return message.responseId;
		if (typeof message.toolCallId === "string") return `tool-${message.toolCallId}`;
		return `message-${++this.messageSequence}`;
	}

	private updateAgentFromRunSubagentRecord(record: ReplayLogRecord, timestamp: string): AgentCard | null {
		const result = reduceRunSubagentProgress({
			toolName: stringValue(record.toolName),
			args: record.args,
			partialResult: record.partialResult,
			result: record.result,
			timestamp,
			existing: stringValue(objectValue(record.args)?.agentId)
				? this.agents.get(stringValue(objectValue(record.args)?.agentId)!)
				: null,
			eventSequenceStart: this.eventSequence,
		});
		if (!result) return null;
		this.eventSequence = result.nextEventSequence;
		this.appendAgentHistory(
			result.agent.agentId,
			agentHistoryItemsFromProgressEvents({
				agentId: result.agent.agentId,
				turnId: null,
				recentEvents: recentProgressEvents(record),
			}),
		);
		if (result.sharedStateRoot) this.sharedStateRoot = result.sharedStateRoot;
		this.agents.set(result.agent.agentId, result.agent);
		return result.agent;
	}

	private appendAgentHistory(agentId: string, items: AgentHistoryItem[]): void {
		if (items.length === 0) return;
		const existing = this.agentHistoryById.get(agentId) ?? [];
		const byId = new Map(existing.map((item) => [item.id, item]));
		for (const item of items) byId.set(item.id, mergeHistoryItem(byId.get(item.id), item));
		this.agentHistoryById.set(agentId, Array.from(byId.values()).sort(compareHistoryItems));
	}
}

function recentProgressEvents(record: ReplayLogRecord): unknown[] {
	const progress =
		objectValue(objectValue(record.partialResult)?.details)?.progress ??
		objectValue(objectValue(record.result)?.details)?.progress;
	return arrayValue(objectValue(progress)?.recentEvents);
}

function compareHistoryItems(left: AgentHistoryItem, right: AgentHistoryItem): number {
	return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function mergeHistoryItem(existing: AgentHistoryItem | undefined, next: AgentHistoryItem): AgentHistoryItem {
	if (!existing) return next;
	if (existing.type === "tool_call" && next.type === "tool_call") {
		return {
			...existing,
			...next,
			createdAt: existing.createdAt <= next.createdAt ? existing.createdAt : next.createdAt,
			args: next.args ?? existing.args,
			result: next.result ?? existing.result,
		};
	}
	return next;
}

function createStreamingAssistantMessage(
	id: string,
	content: string,
	timestamp: string,
	rawType: string,
): TimelineMessage {
	return {
		id,
		source: "main",
		agentId: null,
		role: "assistant",
		kind: "message",
		content,
		status: "streaming",
		createdAt: timestamp,
		updatedAt: timestamp,
		rawType,
		toolName: null,
		toolCallId: null,
	};
}

function recordMessage(record: ReplayLogRecord): Record<string, unknown> | null {
	return objectValue(record.message);
}

function recordTimestamp(record: ReplayLogRecord): string | null {
	const direct = stringValue(record.timestamp);
	if (direct) return direct;
	const message = recordMessage(record);
	const messageTimestamp = numberValue(message?.timestamp);
	if (messageTimestamp) return new Date(messageTimestamp).toISOString();
	return null;
}

function messageDelta(record: ReplayLogRecord): string | null {
	const event = objectValue(record.assistantMessageEvent);
	if (event?.type === "thinking_delta") return "";
	if (event?.type !== "text_delta") return null;
	return stringValue(event.delta);
}

function normalizeRole(role: unknown): TimelineMessage["role"] {
	if (role === "user" || role === "assistant" || role === "system") return role;
	if (role === "tool" || role === "toolResult") return "tool";
	return "system";
}

function extractMessageText(message: Record<string, unknown>): string {
	const content = arrayValue(message.content);
	const parts: string[] = [];
	for (const part of content) {
		const item = objectValue(part);
		const text = stringValue(item?.text);
		if (text) parts.push(text);
	}
	return parts.join("");
}

function agentIdFromToolMessage(message: Record<string, unknown>, content: string): string | null {
	const details = objectValue(message.details);
	const result = objectValue(details?.result);
	const direct = stringValue(details?.agentId) ?? stringValue(result?.agentId);
	if (direct) return direct;
	return agentIdFromText(content);
}

function agentIdFromText(text: string): string | null {
	const match = /^agentId:\s*(.+)$/m.exec(text);
	return match?.[1]?.trim() ?? null;
}

function formatToolResultContent(toolName: string | null, content: string): string {
	if (!toolName || content.includes(`toolName: ${toolName}`)) return content;
	return content ? `toolName: ${toolName}\n${content}` : `toolName: ${toolName}`;
}

function toolPayload(record: ReplayLogRecord, status: ToolEventPayload["status"]): ToolEventPayload | null {
	const toolCallId = stringValue(record.toolCallId);
	const toolName = stringValue(record.toolName);
	if (!toolCallId || !toolName) return null;
	const args = objectValue(record.args);
	const result = objectValue(record.result);
	const partialResult = objectValue(record.partialResult);
	return {
		toolCallId,
		toolName,
		agentId: stringValue(args?.agentId),
		status,
		argsSummary: summarizeArgs(args),
		resultSummary: extractResultSummary(result) ?? extractResultSummary(partialResult),
	};
}

function summarizeArgs(args: Record<string, unknown> | null | undefined): string | null {
	if (!args) return null;
	if (typeof args.agentId === "string") return `agentId=${args.agentId}`;
	if (typeof args.path === "string") return `path=${args.path}`;
	return null;
}

function extractResultSummary(result: Record<string, unknown> | null | undefined): string | null {
	if (!result) return null;
	const content = arrayValue(result.content);
	const firstText = content
		.map(objectValue)
		.map((item) => stringValue(item?.text))
		.find((text) => text && text.length > 0);
	if (firstText) return truncate(firstText, 240);
	return null;
}

function isErrorRecord(record: ReplayLogRecord): boolean {
	return record.isError === true;
}

function truncate(value: string, maxLength: number): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
