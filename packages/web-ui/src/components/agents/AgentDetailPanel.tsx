import { useMemo, useState } from "react";
import type { AgentCard, AgentHistoryItem, AgentHistoryResponse, ToolSummary } from "../../api/contracts.ts";
import { MarkdownLite } from "../markdown/MarkdownLite.tsx";

interface AgentDetailPanelProps {
	agent: AgentCard;
	history: AgentHistoryResponse | null;
	loading: boolean;
	error: string | null;
}

interface AgentRound {
	id: string;
	index: number;
	status: AgentCard["phase"];
	startedAt: string | null;
	endedAt: string | null;
	messages: Array<Extract<AgentHistoryItem, { type: "message" }>>;
	tools: Array<Extract<AgentHistoryItem, { type: "tool_call" }>>;
}

export function AgentDetailPanel({ agent, history, loading, error }: AgentDetailPanelProps) {
	const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
	const [expandedRoundTools, setExpandedRoundTools] = useState<Set<string>>(() => new Set());
	const items = history?.items ?? [];
	const rounds = useMemo(() => groupHistoryIntoRounds(items, agent.phase), [items, agent.phase]);
	const toolCount = rounds.reduce((total, round) => total + round.tools.length, 0) || agent.completedTools.length;
	const eventCount = items.length || agent.eventCount;

	function toggleRoundTools(roundId: string) {
		setExpandedRoundTools((current) => {
			const next = new Set(current);
			if (next.has(roundId)) next.delete(roundId);
			else next.add(roundId);
			return next;
		});
	}

	return (
		<section className="agent-detail-panel" aria-label={`${agent.displayName} execution details`}>
			<header className="agent-detail-header">
				<div>
					<strong>{agent.displayName}</strong>
					<span>{agent.phase}</span>
				</div>
				<p>
					{rounds.length || 1} rounds · {toolCount} tools · {eventCount} events
				</p>
			</header>

			<div className="agent-detail-content">
				{loading ? <p className="agent-detail-note">Loading agent history...</p> : null}
				{error ? <p className="agent-detail-note error">{error}</p> : null}

				{rounds.length > 0 ? (
					<ol className="agent-round-list" aria-label="Agent execution rounds">
						{rounds.map((round) => {
							const toolsExpanded = expandedRoundTools.has(round.id);
							return (
								<li key={round.id} className="agent-round-card">
									<header className="agent-round-header">
										<div>
											<strong>Round {round.index}</strong>
											<span>{round.status}</span>
										</div>
										<p>{roundTimeLabel(round)}</p>
									</header>

									{round.messages.length > 0 ? (
										<RoundAssistantOutput messages={round.messages} />
									) : (
										<p className="agent-round-waiting">Waiting for assistant output.</p>
									)}

									{round.tools.length > 0 ? (
										<section className="agent-round-tools" aria-label={`Round ${round.index} tool calls`}>
											<button
												type="button"
												className="agent-tool-summary-row"
												onClick={() => toggleRoundTools(round.id)}
												aria-expanded={toolsExpanded}
											>
												<span>{roundToolSummary(round.tools)}</span>
												<strong>{toolsExpanded ? "Hide" : "Show"}</strong>
											</button>
											{toolsExpanded ? (
												<ol className="agent-tool-list">
													{round.tools.map((tool) => {
														const expanded = expandedToolId === tool.id;
														return (
															<li key={tool.id} className={tool.status}>
																<button
																	type="button"
																	className="agent-tool-row"
																	onClick={() => setExpandedToolId(expanded ? null : tool.id)}
																	aria-expanded={expanded}
																>
																	<span>{humanizeToolName(tool.toolName)}</span>
																	<strong>{tool.status}</strong>
																	<small>{toolSummary(tool)}</small>
																</button>
																{expanded ? <AgentToolDetail tool={tool} /> : null}
															</li>
														);
													})}
												</ol>
											) : null}
										</section>
									) : null}
								</li>
							);
						})}
					</ol>
				) : agent.lastAssistantPreview ? (
					<section className="agent-detail-section agent-message-section" aria-label="Latest agent message">
						<h3>Latest message</h3>
						<div className="agent-preview">
							<MarkdownLite markdown={agent.lastAssistantPreview} />
						</div>
					</section>
				) : agent.completedTools.length > 0 ? (
					<LegacyToolSection tools={agent.completedTools} />
				) : null}
			</div>
		</section>
	);
}

function RoundAssistantOutput({ messages }: { messages: Array<Extract<AgentHistoryItem, { type: "message" }>> }) {
	const assistantText = agentMessagesText(messages);
	if (!assistantText) return null;

	return (
		<section className="agent-assistant-output" aria-label="Round assistant output">
			<div className="markdown-output">
				<MarkdownLite markdown={assistantText} />
			</div>
		</section>
	);
}

function agentMessagesText(messages: Array<Extract<AgentHistoryItem, { type: "message" }>>): string {
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

function AgentToolDetail({ tool }: { tool: Extract<AgentHistoryItem, { type: "tool_call" }> }) {
	return (
		<div className="agent-tool-detail">
			{tool.toolCallId ? <p>id: {tool.toolCallId}</p> : null}
			<DetailBlock label="args" value={tool.args} />
			<DetailBlock label="result" value={tool.result} />
		</div>
	);
}

function DetailBlock({ label, value }: { label: string; value: unknown }) {
	if (value === null || value === undefined || value === "") return null;
	return (
		<div>
			<strong>{label}</strong>
			<pre>{formatValue(value)}</pre>
		</div>
	);
}

function LegacyToolSection({ tools }: { tools: ToolSummary[] }) {
	return (
		<section className="agent-detail-section" aria-label="Agent tool calls">
			<h3>Tool calls</h3>
			<ol className="agent-tool-list">
				{tools.map((tool, index) => (
					<li key={tool.toolCallId ?? `${tool.name}-${index}`} className={tool.status}>
						<div className="agent-tool-row static">
							<span>{humanizeToolName(tool.name)}</span>
							<strong>{tool.status}</strong>
							<small>{tool.argsSummary ?? tool.resultSummary ?? tool.toolCallId ?? "Tool call"}</small>
						</div>
					</li>
				))}
			</ol>
		</section>
	);
}

function groupHistoryIntoRounds(items: AgentHistoryItem[], fallbackStatus: AgentCard["phase"]): AgentRound[] {
	const rounds: AgentRound[] = [];
	let current: AgentRound | null = null;

	for (const item of items) {
		if (item.type === "status" && item.content === "agent_start") {
			current = createRound(rounds.length + 1, item.createdAt, fallbackStatus);
			rounds.push(current);
			continue;
		}

		if (!current) {
			current = createRound(rounds.length + 1, item.createdAt, fallbackStatus);
			rounds.push(current);
		}

		if (item.type === "status" && item.content === "agent_end") {
			current.endedAt = item.createdAt;
			if (current.status === "running" || current.status === "starting") current.status = "completed";
			current = null;
			continue;
		}

		if (item.type === "message") current.messages.push(item);
		if (item.type === "tool_call") current.tools.push(item);
	}

	if (rounds.length > 0) rounds[rounds.length - 1]!.status = fallbackStatus;
	return rounds;
}

function createRound(index: number, startedAt: string | null, status: AgentCard["phase"]): AgentRound {
	return {
		id: `round-${index}-${startedAt ?? "unknown"}`,
		index,
		status,
		startedAt,
		endedAt: null,
		messages: [],
		tools: [],
	};
}

function roundToolSummary(tools: Array<Extract<AgentHistoryItem, { type: "tool_call" }>>): string {
	const completed = tools.filter((tool) => tool.status === "completed").length;
	const failed = tools.filter((tool) => tool.status === "failed").length;
	const running = tools.filter((tool) => tool.status === "running").length;
	const parts = [`${tools.length} tool calls`];
	if (running > 0) parts.push(`${running} running`);
	if (completed > 0) parts.push(`${completed} completed`);
	if (failed > 0) parts.push(`${failed} failed`);
	return parts.join(" · ");
}

function roundTimeLabel(round: AgentRound): string {
	const start = round.startedAt ? formatTime(round.startedAt) : "unknown";
	const end = round.endedAt ? formatTime(round.endedAt) : null;
	return end ? `${start} - ${end}` : start;
}

function toolSummary(tool: Extract<AgentHistoryItem, { type: "tool_call" }>): string {
	const path = pathFromValue(tool.args) ?? pathFromValue(tool.result);
	if (path) return path;
	if (typeof tool.result === "string") return firstLine(tool.result);
	if (typeof tool.args === "string") return firstLine(tool.args);
	return tool.toolCallId ?? "Tool call";
}

function pathFromValue(value: unknown): string | null {
	if (typeof value === "string") return extractPath(value);
	if (typeof value !== "object" || value === null) return null;
	const path = (value as { path?: unknown }).path;
	if (typeof path === "string") return path;
	const text = JSON.stringify(value);
	return extractPath(text);
}

function extractPath(value: string): string | null {
	const match = value.match(/[\w./-]+\.(?:md|json|txt|csv)/);
	return match?.[0] ?? null;
}

function formatValue(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2);
}

function firstLine(value: string): string {
	return (
		value
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? "Tool call"
	);
}

function humanizeToolName(name: string): string {
	return name.replaceAll("_", " ").replaceAll(".", " ");
}

function formatTime(value: string): string {
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString();
}
