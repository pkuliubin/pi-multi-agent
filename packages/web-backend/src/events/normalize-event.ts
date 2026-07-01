import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	MessageCompletedPayload,
	MessageDeltaPayload,
	ReplayPayload,
	SseEventType,
	TimelineMessage,
	ToolEventPayload,
} from "../contract.ts";

export interface NormalizedAgentEvent {
	eventType: SseEventType;
	payload: unknown;
}

export function normalizeAgentEvent(event: AgentEvent): NormalizedAgentEvent[] {
	if (event.type === "message_update") {
		const delta = textDeltaFromAssistantEvent(event.assistantMessageEvent);
		if (!delta) return [];
		return [
			{
				eventType: "message.delta",
				payload: {
					messageId: messageId(event.message),
					role: "assistant",
					source: "main",
					agentId: null,
					delta,
				} satisfies MessageDeltaPayload,
			},
		];
	}

	if (event.type === "message_end") {
		return [
			{
				eventType: "message.completed",
				payload: {
					message: timelineMessageFromAgentMessage(event.message, event.type, "completed"),
				} satisfies MessageCompletedPayload,
			},
		];
	}

	if (event.type === "tool_execution_start") {
		return [{ eventType: "tool.started", payload: toolPayload(event, "running") }];
	}

	if (event.type === "tool_execution_update") {
		return [{ eventType: "tool.updated", payload: toolPayload(event, "running") }];
	}

	if (event.type === "tool_execution_end") {
		return [{ eventType: "tool.completed", payload: toolPayload(event, event.isError ? "failed" : "completed") }];
	}

	return [];
}

export function timelineMessageFromAgentMessage(
	message: AgentMessage,
	rawType: string | null,
	status: TimelineMessage["status"],
): TimelineMessage {
	const role = normalizeRole((message as { role?: unknown }).role);
	const id = messageId(message);
	const toolName = role === "tool" ? toolNameFromMessage(message) : null;
	const toolCallId = role === "tool" ? toolCallIdFromMessage(message) : null;
	const agentId = role === "tool" ? agentIdFromToolMessage(message) : null;
	const content = extractMessageText(message);
	const now = new Date().toISOString();
	return {
		id,
		source: role === "tool" ? (agentId ? "agent" : "system") : "main",
		agentId,
		role,
		kind: role === "tool" ? "tool_event" : "message",
		content: role === "tool" ? formatToolResultContent(toolName, content) : content,
		status,
		createdAt: timestampFromMessage(message) ?? now,
		updatedAt: now,
		rawType: rawType ?? toolName,
		toolName,
		toolCallId,
	};
}

export function replayStartedPayload(
	logPath: string,
	cursor: number,
	totalEvents: number,
	speed: number,
): ReplayPayload {
	return { logPath, cursor, totalEvents, speed };
}

function toolPayload(
	event: Extract<AgentEvent, { type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }>,
	status: ToolEventPayload["status"],
): ToolEventPayload {
	const args = "args" in event ? objectValue(event.args) : null;
	return {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		agentId: stringValue(args?.agentId),
		status,
		argsSummary: summarizeArgs(args),
		resultSummary:
			"result" in event
				? summarizeResult(event.result)
				: "partialResult" in event
					? summarizeResult(event.partialResult)
					: null,
	};
}

function textDeltaFromAssistantEvent(event: unknown): string | null {
	const value = objectValue(event);
	if (value?.type === "thinking_delta") return "";
	if (value?.type !== "text_delta") return null;
	return stringValue(value.delta);
}

function messageId(message: AgentMessage): string {
	const record = message as unknown as Record<string, unknown>;
	return (
		stringValue(record.responseId) ??
		stringValue(record.toolCallId) ??
		`message-${timestampFromMessage(message) ?? Date.now()}`
	);
}

function toolNameFromMessage(message: AgentMessage): string | null {
	return stringValue((message as unknown as Record<string, unknown>).toolName);
}

function toolCallIdFromMessage(message: AgentMessage): string | null {
	return stringValue((message as unknown as Record<string, unknown>).toolCallId);
}

function agentIdFromToolMessage(message: AgentMessage): string | null {
	const record = message as unknown as Record<string, unknown>;
	const details = objectValue(record.details);
	const result = objectValue(details?.result);
	const direct = stringValue(details?.agentId) ?? stringValue(result?.agentId);
	if (direct) return direct;
	return agentIdFromText(extractMessageText(message));
}

function agentIdFromText(text: string): string | null {
	const match = /^agentId:\s*(.+)$/m.exec(text);
	return match?.[1]?.trim() ?? null;
}

function formatToolResultContent(toolName: string | null, content: string): string {
	if (!toolName || content.includes(`toolName: ${toolName}`)) return content;
	return content ? `toolName: ${toolName}\n${content}` : `toolName: ${toolName}`;
}

function normalizeRole(role: unknown): TimelineMessage["role"] {
	if (role === "user" || role === "assistant" || role === "system") return role;
	if (role === "tool" || role === "toolResult") return "tool";
	return "system";
}

function extractMessageText(message: AgentMessage): string {
	const content = arrayValue((message as { content?: unknown }).content);
	return content
		.map(objectValue)
		.map((item) => stringValue(item?.text))
		.filter((value): value is string => value !== null)
		.join("");
}

function timestampFromMessage(message: AgentMessage): string | null {
	const timestamp = (message as { timestamp?: unknown }).timestamp;
	if (typeof timestamp === "number") return new Date(timestamp).toISOString();
	return typeof timestamp === "string" ? timestamp : null;
}

function summarizeArgs(args: Record<string, unknown> | null): string | null {
	if (!args) return null;
	if (typeof args.agentId === "string") return `agentId=${args.agentId}`;
	if (typeof args.path === "string") return `path=${args.path}`;
	return null;
}

function summarizeResult(result: unknown): string | null {
	const value = objectValue(result);
	const content = arrayValue(value?.content);
	const text = content
		.map(objectValue)
		.map((item) => stringValue(item?.text))
		.find((item) => item !== null && item.length > 0);
	return text ? truncate(text, 240) : null;
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
