import { useMemo, useState } from "react";
import type { TimelineMessage } from "../../api/contracts.ts";
import { MarkdownLite } from "../markdown/MarkdownLite.tsx";

interface TimelineTurnProps {
	messages: TimelineMessage[];
}

interface TimelineTurn {
	id: string;
	user: TimelineMessage | null;
	assistantSegments: TimelineMessage[];
	toolCalls: TimelineMessage[];
	status: TimelineMessage["status"];
	updatedAt: string;
}

export function TimelineTurns({ messages }: TimelineTurnProps) {
	const turns = useMemo(() => groupMessagesIntoTurns(messages), [messages]);

	return (
		<>
			{turns.map((turn) => (
				<TimelineTurnItem key={turn.id} turn={turn} />
			))}
		</>
	);
}

function TimelineTurnItem({ turn }: { turn: TimelineTurn }) {
	const [toolsExpanded, setToolsExpanded] = useState(false);
	const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
	const assistantText = assistantSegmentsText(turn.assistantSegments);
	const toolSummary = summarizeTools(turn.toolCalls);

	return (
		<article className={`timeline-turn ${turn.status}`} aria-label="Assistant turn">
			{turn.user ? (
				<section className="turn-user-query" aria-label="User query">
					<div className="turn-row-header">
						<span>User</span>
						<span>{formatTime(turn.user.updatedAt)}</span>
					</div>
					<p>{turn.user.content}</p>
				</section>
			) : null}

			<section className="turn-assistant-output" aria-label="Assistant response">
				<div className="turn-row-header">
					<span>Assistant</span>
					<span>{turn.status}</span>
				</div>
				<div className="markdown-output">
					{assistantText ? (
						<MarkdownLite markdown={assistantText} />
					) : (
						<p className="muted">Waiting for assistant output.</p>
					)}
				</div>

				{turn.toolCalls.length > 0 ? (
					<section className="turn-tools" aria-label="Tool activity">
						<button
							type="button"
							className="tool-summary-row"
							onClick={() => setToolsExpanded((value) => !value)}
							aria-expanded={toolsExpanded}
						>
							<span>{toolSummary}</span>
							<span>{toolsExpanded ? "Hide" : "Show"}</span>
						</button>
						{toolsExpanded ? (
							<ul className="tool-detail-list">
								{turn.toolCalls.map((tool) => {
									const expanded = expandedToolId === tool.id;
									return (
										<li key={tool.id} className={tool.status}>
											<button
												type="button"
												className="tool-detail-row"
												onClick={() => setExpandedToolId(expanded ? null : tool.id)}
												aria-expanded={expanded}
											>
												<span>{toolLabel(tool)}</span>
												<strong>{tool.status}</strong>
												<small>{toolDetail(tool)}</small>
											</button>
											{expanded ? <ToolRawDetails tool={tool} /> : null}
										</li>
									);
								})}
							</ul>
						) : null}
					</section>
				) : null}
			</section>
		</article>
	);
}

function assistantSegmentsText(messages: TimelineMessage[]): string {
	const segments: string[] = [];

	for (const message of messages) {
		const content = message.content.trim();
		if (!content) continue;
		appendAssistantSegment(segments, content);
	}

	return segments.join("\n\n");
}

function appendAssistantSegment(segments: string[], next: string): void {
	const last = segments.at(-1);
	if (last && (next === last || last.includes(next))) return;
	if (last && next.includes(last)) {
		segments[segments.length - 1] = next;
		return;
	}

	segments.push(next);
}

function ToolRawDetails({ tool }: { tool: TimelineMessage }) {
	return (
		<dl className="tool-raw-details">
			<div>
				<dt>tool</dt>
				<dd>{tool.toolName ?? tool.rawType ?? "tool"}</dd>
			</div>
			{tool.agentId ? (
				<div>
					<dt>agent</dt>
					<dd>{tool.agentId}</dd>
				</div>
			) : null}
			<div>
				<dt>call id</dt>
				<dd>{tool.toolCallId ?? tool.id}</dd>
			</div>
			<div>
				<dt>type</dt>
				<dd>{tool.rawType ?? tool.kind}</dd>
			</div>
			<div>
				<dt>content</dt>
				<dd>{tool.content || "No tool content."}</dd>
			</div>
		</dl>
	);
}

function groupMessagesIntoTurns(messages: TimelineMessage[]): TimelineTurn[] {
	const turns: TimelineTurn[] = [];
	let current: TimelineTurn | null = null;

	for (const message of messages) {
		if (message.role === "user") {
			current = {
				id: message.id,
				user: message,
				assistantSegments: [],
				toolCalls: [],
				status: message.status,
				updatedAt: message.updatedAt,
			};
			turns.push(current);
			continue;
		}

		if (message.kind === "tool_event" || message.role === "tool") {
			if (!current) current = createImplicitTurn(turns, message);
			upsertToolCall(current, message);
		} else if (message.role === "assistant") {
			if (!current) current = createImplicitTurn(turns, message);
			upsertAssistantSegment(current, message);
		} else {
			continue;
		}

		current.updatedAt = message.updatedAt;
		if (message.status === "streaming" || message.status === "failed" || message.status === "aborted") {
			current.status = message.status;
		} else if (current.status !== "streaming" && current.status !== "failed" && current.status !== "aborted") {
			current.status = message.status;
		}
	}

	return mergeConsecutiveUserTurns(turns);
}

function createImplicitTurn(turns: TimelineTurn[], message: TimelineMessage): TimelineTurn {
	const turn = {
		id: `turn-${turns.length + 1}`,
		user: null,
		assistantSegments: [],
		toolCalls: [],
		status: message.status,
		updatedAt: message.updatedAt,
	};
	turns.push(turn);
	return turn;
}

function upsertAssistantSegment(turn: TimelineTurn, message: TimelineMessage): void {
	const index = turn.assistantSegments.findIndex((segment) => segment.id === message.id);
	if (index === -1) {
		turn.assistantSegments.push(message);
		return;
	}
	turn.assistantSegments[index] = message;
}

function upsertToolCall(turn: TimelineTurn, message: TimelineMessage): void {
	const key = message.toolCallId ?? message.id;
	const index = turn.toolCalls.findIndex((tool) => (tool.toolCallId ?? tool.id) === key);
	if (index === -1) {
		turn.toolCalls.push(message);
		return;
	}
	turn.toolCalls[index] = mergeToolCall(turn.toolCalls[index]!, message);
}

function mergeToolCall(existing: TimelineMessage, next: TimelineMessage): TimelineMessage {
	return {
		...existing,
		...next,
		id: existing.id,
		createdAt: existing.createdAt <= next.createdAt ? existing.createdAt : next.createdAt,
		updatedAt: next.updatedAt >= existing.updatedAt ? next.updatedAt : existing.updatedAt,
		content: longerText(existing.content, next.content),
		agentId: next.agentId ?? existing.agentId,
		toolCallId: next.toolCallId ?? existing.toolCallId,
		toolName: next.toolName ?? existing.toolName,
		rawType: next.rawType ?? existing.rawType,
	};
}

function longerText(left: string, right: string): string {
	return right.length >= left.length ? right : left;
}

function mergeConsecutiveUserTurns(turns: TimelineTurn[]): TimelineTurn[] {
	const merged: TimelineTurn[] = [];

	for (const turn of turns) {
		const previous = merged.at(-1);
		if (previous && previous.user?.content === turn.user?.content && previous.status === "streaming") {
			for (const segment of turn.assistantSegments) upsertAssistantSegment(previous, segment);
			for (const tool of turn.toolCalls) upsertToolCall(previous, tool);
			previous.status = turn.status;
			previous.updatedAt = turn.updatedAt;
			continue;
		}
		merged.push(turn);
	}

	return merged;
}

function summarizeTools(tools: TimelineMessage[]): string {
	const running = tools.filter((tool) => tool.status === "streaming").length;
	const failed = tools.filter((tool) => tool.status === "failed").length;
	const completed = tools.filter((tool) => tool.status === "completed").length;
	const agents = new Set(tools.map((tool) => tool.agentId).filter(Boolean));
	const parts = [`${tools.length} tools`];
	if (agents.size > 0) parts.push(`${agents.size} agents`);
	if (running > 0) parts.push(`${running} running`);
	if (completed > 0) parts.push(`${completed} completed`);
	if (failed > 0) parts.push(`${failed} failed`);
	return parts.join(" · ");
}

function toolLabel(tool: TimelineMessage): string {
	if (tool.toolName === "run_subagent") {
		return `Delegate to ${tool.agentId ?? "agent"}`;
	}

	return humanizeToolName(tool.toolName ?? tool.rawType ?? "tool");
}

function toolDetail(tool: TimelineMessage): string {
	const artifactPath = extractArtifactPath(tool.content);
	if (artifactPath) {
		if (tool.content.toLowerCase().includes("write") || tool.content.toLowerCase().includes("updated")) {
			return `Updated ${artifactPath}`;
		}
		return `Used ${artifactPath}`;
	}

	return firstLine(tool.content) || "Tool activity updated.";
}

function extractArtifactPath(value: string): string | null {
	const match = value.match(/(?:path=|updated |wrote |read )([\w./-]+\.(?:md|json|txt|csv))/i);
	return match?.[1] ?? null;
}

function humanizeToolName(name: string): string {
	return name.replaceAll("_", " ").replaceAll(".", " ");
}

function firstLine(value: string): string {
	return (
		value
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? ""
	);
}

function formatTime(value: string): string {
	const date = new Date(value);

	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return date.toLocaleTimeString();
}
