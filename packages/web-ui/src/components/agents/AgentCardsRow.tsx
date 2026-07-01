import { useEffect, useMemo, useState } from "react";
import type { AgentCard as AgentCardModel, AgentHistoryResponse } from "../../api/contracts.ts";
import { AgentCard } from "./AgentCard.tsx";
import { AgentDetailPanel } from "./AgentDetailPanel.tsx";

interface AgentCardsRowProps {
	agents: AgentCardModel[];
	historyByAgentId?: Record<string, AgentHistoryResponse>;
	loadingByAgentId?: Record<string, boolean>;
	errorByAgentId?: Record<string, string | null>;
	onLoadAgentHistory?: (agentId: string) => Promise<void>;
}

export function AgentCardsRow({
	agents,
	historyByAgentId = {},
	loadingByAgentId = {},
	errorByAgentId = {},
	onLoadAgentHistory,
}: AgentCardsRowProps) {
	const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
	const selectedAgent = useMemo(
		() => agents.find((agent) => agent.agentId === selectedAgentId) ?? null,
		[agents, selectedAgentId],
	);

	useEffect(() => {
		if (selectedAgentId && !agents.some((agent) => agent.agentId === selectedAgentId)) {
			setSelectedAgentId(null);
		}
	}, [agents, selectedAgentId]);

	function handleSelectAgent(agentId: string) {
		setSelectedAgentId((currentAgentId) => {
			if (currentAgentId === agentId) return null;
			void onLoadAgentHistory?.(agentId);
			return agentId;
		});
	}

	useEffect(() => {
		if (!selectedAgent) return;
		void onLoadAgentHistory?.(selectedAgent.agentId);
	}, [onLoadAgentHistory, selectedAgent]);

	if (agents.length === 0) {
		return (
			<section className="agent-workbench empty-panel" aria-label="Agent cards">
				<p className="empty-title">No role agents yet</p>
				<p>Start a session or wait for replay events to see PM, engineering, and data analyst agents here.</p>
			</section>
		);
	}

	return (
		<section className={selectedAgent ? "agent-workbench has-detail" : "agent-workbench"} aria-label="Agent cards">
			<div className="agent-row">
				{agents.map((agent) => (
					<AgentCard
						key={agent.agentId}
						agent={agent}
						selected={selectedAgent?.agentId === agent.agentId}
						onSelect={handleSelectAgent}
					/>
				))}
			</div>
			{selectedAgent ? (
				<AgentDetailPanel
					agent={selectedAgent}
					history={historyByAgentId[selectedAgent.agentId] ?? null}
					loading={loadingByAgentId[selectedAgent.agentId] ?? false}
					error={errorByAgentId[selectedAgent.agentId] ?? null}
				/>
			) : null}
		</section>
	);
}
