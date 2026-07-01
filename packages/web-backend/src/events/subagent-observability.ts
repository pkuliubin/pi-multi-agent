import type {
	AgentEventPayload,
	AgentHistoryItem,
	AgentObservabilityEvent,
	MessageDeltaPayload,
	ToolEventPayload,
} from "../contract.ts";

export interface AgentObservabilityExtraction {
	events: AgentObservabilityEvent[];
	historyItems: AgentHistoryItem[];
	broadcasts: Array<
		| { eventType: "agent.event"; payload: AgentEventPayload }
		| { eventType: "agent.message.delta"; payload: MessageDeltaPayload }
		| { eventType: "agent.tool.started" | "agent.tool.updated" | "agent.tool.completed"; payload: ToolEventPayload }
	>;
}

export function extractAgentObservabilityFromRunSubagentPayload(input: {
	partialResult?: unknown;
	result?: unknown;
	turnId: string | null;
}): AgentObservabilityExtraction {
	const events = observabilityEvents(input.partialResult, input.result);
	const historyItems = events
		.map((event) => historyItemFromObservabilityEvent(event, input.turnId))
		.filter(isHistoryItem);
	const broadcasts = events.flatMap((event) => broadcastsFromObservabilityEvent(event));
	return { events, historyItems, broadcasts };
}

export function observabilityEvents(partialResult?: unknown, result?: unknown): AgentObservabilityEvent[] {
	const candidates = [partialResult, result];
	const events: AgentObservabilityEvent[] = [];
	for (const candidate of candidates) {
		const batch = objectValue(objectValue(candidate)?.details)?.observability;
		const batchEvents = arrayValue(objectValue(batch)?.events);
		for (const event of batchEvents) {
			const normalized = normalizeObservabilityEvent(event);
			if (normalized) events.push(normalized);
		}
	}
	return events;
}

function broadcastsFromObservabilityEvent(event: AgentObservabilityEvent): AgentObservabilityExtraction["broadcasts"] {
	const payload: AgentEventPayload = { event };
	const broadcasts: AgentObservabilityExtraction["broadcasts"] = [{ eventType: "agent.event", payload }];
	if (event.type === "agent.message.delta") {
		broadcasts.push({
			eventType: "agent.message.delta",
			payload: {
				messageId: event.messageId,
				role: "assistant",
				source: "agent",
				agentId: event.agentId,
				delta: event.delta,
			} satisfies MessageDeltaPayload,
		});
	}
	if (
		event.type === "agent.tool.started" ||
		event.type === "agent.tool.updated" ||
		event.type === "agent.tool.completed"
	) {
		broadcasts.push({
			eventType: event.type,
			payload: {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				agentId: event.agentId,
				status: event.status,
				argsSummary: event.argsSummary ?? null,
				resultSummary: event.resultSummary ?? null,
			} satisfies ToolEventPayload,
		});
	}
	return broadcasts;
}

function historyItemFromObservabilityEvent(
	event: AgentObservabilityEvent,
	turnId: string | null,
): AgentHistoryItem | null {
	const invocationId = event.invocationId ?? "invocation";
	const base = {
		agentId: event.agentId,
		turnId,
		invocationId: event.invocationId,
		createdAt: event.timestamp,
	};
	if (event.type === "agent.message.delta") {
		return {
			...base,
			id: `${event.agentId}:${invocationId}:message:${event.messageId}`,
			type: "message",
			role: "assistant",
			content: event.delta,
		};
	}
	if (event.type === "agent.message.completed") {
		return {
			...base,
			id: `${event.agentId}:${invocationId}:message:${event.messageId}`,
			type: "message",
			role: "assistant",
			content: event.preview,
		};
	}
	if (
		event.type === "agent.tool.started" ||
		event.type === "agent.tool.updated" ||
		event.type === "agent.tool.completed"
	) {
		return {
			...base,
			id: `${event.agentId}:${invocationId}:tool:${event.toolCallId}`,
			type: "tool_call",
			toolName: event.toolName,
			toolCallId: event.toolCallId,
			status: event.status,
			args: event.argsSummary ?? null,
			result: event.resultSummary ?? null,
		};
	}
	return null;
}

function normalizeObservabilityEvent(value: unknown): AgentObservabilityEvent | null {
	const event = objectValue(value);
	const type = stringValue(event?.type);
	const base = normalizeBase(event);
	if (!type || !base) return null;
	if (type === "agent.started" || type === "agent.completed" || type === "agent.failed" || type === "agent.aborted") {
		return { ...base, type };
	}
	if (type === "agent.message.delta") {
		const messageId = stringValue(event?.messageId);
		const delta = stringValue(event?.delta);
		if (!messageId || delta === null) return null;
		return { ...base, type, messageId, delta, truncated: event?.truncated === true || undefined };
	}
	if (type === "agent.message.completed") {
		const messageId = stringValue(event?.messageId);
		const preview = stringValue(event?.preview);
		const fullTextRef = objectValue(event?.fullTextRef);
		if (!messageId || preview === null || fullTextRef?.kind !== "session_message") return null;
		const refSessionId = stringValue(fullTextRef.sessionId);
		const refMessageId = stringValue(fullTextRef.messageId);
		if (!refSessionId || !refMessageId) return null;
		return {
			...base,
			type,
			messageId,
			preview,
			fullTextRef: { kind: "session_message", sessionId: refSessionId, messageId: refMessageId },
		};
	}
	if (type === "agent.tool.started" || type === "agent.tool.updated" || type === "agent.tool.completed") {
		const toolName = stringValue(event?.toolName);
		const toolCallId = stringValue(event?.toolCallId);
		const status = stringValue(event?.status);
		if (!toolName || !toolCallId || !isToolStatus(status)) return null;
		return {
			...base,
			type,
			toolName,
			toolCallId,
			status,
			argsSummary: stringValue(event?.argsSummary) ?? undefined,
			resultSummary: stringValue(event?.resultSummary) ?? undefined,
		};
	}
	return null;
}

function normalizeBase(event: Record<string, unknown> | null): Omit<AgentObservabilityEvent, "type"> | null {
	const agentId = stringValue(event?.agentId);
	const sessionId = stringValue(event?.sessionId);
	const sequence = numberValue(event?.sequence);
	const timestamp = stringValue(event?.timestamp);
	if (!agentId || !sessionId || sequence === null || !timestamp) return null;
	return {
		agentId,
		sessionId,
		invocationId: stringValue(event?.invocationId),
		sequence,
		timestamp,
	} as Omit<AgentObservabilityEvent, "type">;
}

function isHistoryItem(value: AgentHistoryItem | null): value is AgentHistoryItem {
	return value !== null;
}

function isToolStatus(value: string | null): value is "running" | "completed" | "failed" | "aborted" {
	return value === "running" || value === "completed" || value === "failed" || value === "aborted";
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
