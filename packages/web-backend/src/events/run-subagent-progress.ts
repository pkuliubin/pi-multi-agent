import type { AgentCard, AgentPhase, AgentRecentEvent, ToolSummary } from "../contract.ts";

export interface RunSubagentProgressInput {
	toolName: string | null;
	args: unknown;
	partialResult?: unknown;
	result?: unknown;
	timestamp: string;
	existing?: AgentCard | null;
	eventSequenceStart?: number;
}

export interface RunSubagentProgressResult {
	agent: AgentCard;
	sharedStateRoot: string | null;
	nextEventSequence: number;
}

export function reduceRunSubagentProgress(input: RunSubagentProgressInput): RunSubagentProgressResult | null {
	if (input.toolName !== "run_subagent") return null;
	const args = objectValue(input.args);
	const partialResult = objectValue(input.partialResult);
	const result = objectValue(input.result);
	const progress =
		objectValue(objectValue(partialResult?.details)?.progress) ?? objectValue(objectValue(result?.details)?.progress);
	const resultDetails = objectValue(objectValue(result?.details)?.result);
	const agentId = stringValue(args?.agentId) ?? stringValue(resultDetails?.agentId);
	if (!agentId) return null;

	let eventSequence = input.eventSequenceStart ?? 0;
	const existing = input.existing ?? null;
	const phase = normalizeAgentPhase(stringValue(progress?.currentPhase) ?? stringValue(resultDetails?.status));
	const completedTools = arrayValue(progress?.completedTools).map((tool) => normalizeToolSummary(tool, "completed"));
	const activeTool = progress?.activeTool ? normalizeToolSummary(progress.activeTool, "running") : null;
	const recentEvents = arrayValue(progress?.recentEvents).map((event) => normalizeRecentEvent(event, ++eventSequence));
	const sessionId = stringValue(resultDetails?.sessionId) ?? existing?.sessionId ?? null;
	const sharedStateRoot =
		stringValue(objectValue(result?.details)?.sharedStateRoot) ?? existing?.sharedStateRoot ?? null;
	const lastAssistantPreview =
		stringValue(progress?.lastAssistantPreview) ??
		stringValue(resultDetails?.finalText) ??
		existing?.lastAssistantPreview ??
		null;
	const agent: AgentCard = {
		agentId,
		displayName: displayNameForAgent(agentId),
		role: agentRole(agentId),
		avatar: null,
		phase,
		activeTool,
		completedTools,
		lastAssistantPreview,
		eventCount: numberValue(progress?.eventCount) ?? existing?.eventCount ?? recentEvents.length,
		recentEvents,
		sessionId,
		lastRunStatus: phase === "starting" ? "running" : phase,
		sharedStateRoot,
		updatedAt: input.timestamp,
	};
	return { agent, sharedStateRoot, nextEventSequence: eventSequence };
}

export function normalizeAgentPhase(value: string | null | undefined): AgentPhase {
	if (
		value === "starting" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "aborted"
	) {
		return value;
	}
	return "idle";
}

function normalizeToolSummary(value: unknown, fallbackStatus: ToolSummary["status"]): ToolSummary {
	const tool = objectValue(value);
	const isError = tool?.isError === true;
	return {
		toolCallId: stringValue(tool?.toolCallId),
		name: stringValue(tool?.toolName) ?? stringValue(tool?.name) ?? "unknown",
		status: isError ? "failed" : fallbackStatus,
		argsSummary: stringValue(tool?.argsSummary),
		resultSummary: stringValue(tool?.resultSummary),
		startedAt: timestampToIso(tool?.startedAt ?? tool?.timestamp),
		endedAt: fallbackStatus === "completed" ? timestampToIso(tool?.endedAt ?? tool?.timestamp) : null,
	};
}

function normalizeRecentEvent(value: unknown, fallbackSequence: number): AgentRecentEvent {
	const event = objectValue(value);
	const type = stringValue(event?.type) ?? "event";
	const toolName = stringValue(event?.toolName);
	const argsSummary = stringValue(event?.argsSummary);
	const resultSummary = stringValue(event?.resultSummary);
	const preview = stringValue(event?.preview);
	const summaryParts = [type, toolName, argsSummary ?? resultSummary ?? preview].filter(Boolean);
	return {
		id: `${type}-${stringValue(event?.toolCallId) ?? fallbackSequence}`,
		type,
		summary: summaryParts.join(": "),
		createdAt: timestampToIso(event?.timestamp) ?? new Date().toISOString(),
	};
}

function timestampToIso(value: unknown): string | null {
	const timestamp = numberValue(value);
	if (timestamp) return new Date(timestamp).toISOString();
	return stringValue(value);
}

function displayNameForAgent(agentId: string): string {
	return agentId
		.split("-")
		.filter((part) => part.length > 0 && part !== "v2")
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(" ");
}

function agentRole(agentId: string): string | null {
	if (agentId.includes("pm")) return "pm";
	if (agentId.includes("engineering")) return "engineering";
	if (agentId.includes("data") || agentId.includes("analyst")) return "data";
	if (agentId.includes("synthesis")) return "synthesis";
	return null;
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
