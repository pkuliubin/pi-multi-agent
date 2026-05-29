import { memo } from "react";
import type { AgentCard as AgentCardModel } from "../../api/contracts.ts";
import { currentAgentActivity } from "./agent-activity.ts";

interface AgentCardProps {
	agent: AgentCardModel;
	selected: boolean;
	onSelect: (agentId: string) => void;
}

export const AgentCard = memo(function AgentCard({ agent, selected, onSelect }: AgentCardProps) {
	const currentActivity = currentAgentActivity(agent);
	const canSelect =
		agent.recentEvents.length > 0 || agent.completedTools.length > 0 || Boolean(agent.lastAssistantPreview);

	return (
		<article
			className={`agent-card phase-${agent.phase}${selected ? " is-selected" : ""}`}
			aria-label={`${agent.displayName} agent status`}
		>
			<div className="agent-card-header">
				<div className="agent-avatar" aria-hidden="true">
					{agent.avatar ?? initialsFor(agent.displayName)}
				</div>
				<div className="agent-title">
					<h2>{agent.displayName}</h2>
					<p>{roleLabel(agent.role)}</p>
				</div>
				<span className="phase-badge">{phaseLabel(agent.phase)}</span>
			</div>

			<div className={`agent-current-action ${currentActivity.status}`}>
				<strong>{currentActivity.label}</strong>
				{currentActivity.detail ? <span>{currentActivity.detail}</span> : null}
			</div>

			<div className="agent-card-footer">
				<div className="agent-meta-row">
					<span>{agent.completedTools.length} tools</span>
					<span>{agent.eventCount} events</span>
				</div>
				{canSelect ? (
					<button
						type="button"
						className="agent-details-button"
						onClick={() => onSelect(agent.agentId)}
						aria-pressed={selected}
					>
						{selected ? "Hide" : "Details"}
					</button>
				) : null}
			</div>
		</article>
	);
});

function initialsFor(name: string): string {
	return name
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase() ?? "")
		.join("");
}

function roleLabel(role: string | null): string {
	if (!role) return "Role agent";
	if (role === "pm") return "Product";
	if (role === "engineering") return "Engineering";
	if (role === "synthesis") return "Synthesis";
	return role;
}

function phaseLabel(phase: AgentCardModel["phase"]): string {
	switch (phase) {
		case "starting":
			return "Starting";
		case "running":
			return "Working";
		case "completed":
			return "Done";
		case "failed":
			return "Failed";
		case "aborted":
			return "Stopped";
		case "idle":
			return "Idle";
	}
}
