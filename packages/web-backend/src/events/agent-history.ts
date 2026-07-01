import type { AgentHistoryItem } from "../contract.ts";

export function agentHistoryItemsFromProgressEvents(input: {
	agentId: string;
	turnId: string | null;
	recentEvents: unknown[];
}): AgentHistoryItem[] {
	return input.recentEvents.map((event) => historyItemFromProgressEvent(input, event)).filter(isHistoryItem);
}

function historyItemFromProgressEvent(
	input: { agentId: string; turnId: string | null },
	value: unknown,
): AgentHistoryItem | null {
	const event = objectValue(value);
	const type = stringValue(event?.type);
	if (!type) return null;
	const toolCallId = stringValue(event?.toolCallId);
	const timestamp = timestampToIso(event?.timestamp) ?? new Date().toISOString();
	const base = {
		id: historyItemId(input.agentId, type, toolCallId, timestamp, stringValue(event?.invocationId)),
		agentId: input.agentId,
		turnId: input.turnId,
		invocationId: stringValue(event?.invocationId),
		createdAt: timestamp,
	};

	if (type === "message_end") {
		const content = stringValue(event?.fullText) ?? stringValue(event?.preview);
		if (!content) return null;
		return { ...base, type: "message", role: "assistant", content };
	}

	if (type === "tool_execution_start") {
		return {
			...base,
			type: "tool_call",
			toolName: stringValue(event?.toolName) ?? "tool",
			toolCallId,
			status: "running",
			args: event?.args ?? stringValue(event?.argsSummary) ?? null,
			result: null,
		};
	}

	if (type === "tool_execution_end") {
		return {
			...base,
			type: "tool_call",
			toolName: stringValue(event?.toolName) ?? "tool",
			toolCallId,
			status: event?.isError === true ? "failed" : "completed",
			args: event?.args ?? stringValue(event?.argsSummary) ?? null,
			result: event?.result ?? stringValue(event?.resultSummary) ?? null,
		};
	}

	if (type === "agent_start" || type === "agent_end") {
		return {
			...base,
			type: "status",
			status: type === "agent_start" ? "running" : "completed",
			content: type,
		};
	}

	return { ...base, type: "status", status: "completed", content: type };
}

function isHistoryItem(value: AgentHistoryItem | null): value is AgentHistoryItem {
	return value !== null;
}

function timestampToIso(value: unknown): string | null {
	if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
	return typeof value === "string" ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function historyItemId(
	agentId: string,
	type: string,
	toolCallId: string | null,
	timestamp: string,
	invocationId: string | null,
): string {
	if (type === "tool_execution_start" || type === "tool_execution_end") {
		return `${agentId}:tool:${toolCallId ?? timestamp}`;
	}
	if (type === "message_end") return `${agentId}:message:${timestamp}`;
	return `${agentId}:status:${type}:${invocationId ?? timestamp}`;
}
