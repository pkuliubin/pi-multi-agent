import type { AgentCard, AgentRecentEvent, ToolSummary } from "../../api/contracts.ts";

export interface ReadableAgentActivity {
	label: string;
	detail: string | null;
	status: "running" | "completed" | "failed" | "aborted" | "idle";
}

export function currentAgentActivity(agent: AgentCard): ReadableAgentActivity {
	if (agent.activeTool) {
		return activityFromTool(agent.activeTool);
	}

	if (agent.phase === "completed") {
		const output = latestArtifactPath(agent) ?? artifactFromPreview(agent.lastAssistantPreview);
		return {
			label: output ? "Completed output" : "Completed work",
			detail: output ? `Updated ${output}` : agent.lastAssistantPreview,
			status: "completed",
		};
	}

	if (agent.phase === "failed" || agent.phase === "aborted") {
		return {
			label: agent.phase === "failed" ? "Needs attention" : "Stopped",
			detail: readableEvent(agent.recentEvents.at(-1))?.detail ?? agent.lastAssistantPreview,
			status: agent.phase,
		};
	}

	if (agent.phase === "starting") {
		return { label: "Starting work", detail: "Preparing the agent session.", status: "running" };
	}

	if (agent.phase === "running") {
		return {
			label: "Working",
			detail: agent.lastAssistantPreview ?? "The agent is making progress.",
			status: "running",
		};
	}

	return { label: "Waiting", detail: "No work has started yet.", status: "idle" };
}

export function readableEvent(event: AgentRecentEvent | undefined): ReadableAgentActivity | null {
	if (!event) return null;
	const summary = event.summary;
	const path = extractArtifactPath(summary);
	const lower = summary.toLowerCase();

	if (lower.includes("agent_start")) {
		return { label: "Started", detail: "Agent session started.", status: "running" };
	}

	if (lower.includes("agent_end")) {
		return { label: "Finished", detail: "Agent session finished.", status: "completed" };
	}

	if (lower.includes("shared_state_write") || lower.includes("successfully wrote")) {
		return {
			label: "Wrote artifact",
			detail: path ? `Updated ${path}` : "Updated shared state.",
			status: "completed",
		};
	}

	if (lower.includes("shared_state_read")) {
		return { label: "Read artifact", detail: path ? `Read ${path}` : "Read from shared state.", status: "completed" };
	}

	if (lower.includes("shared_state_list")) {
		return {
			label: "Checked shared state",
			detail: path ? `Looked at ${path}` : "Listed available artifacts.",
			status: "completed",
		};
	}

	if (lower.includes("path not found") || lower.includes("must be relative") || lower.includes("escapes")) {
		return {
			label: "Checked unavailable path",
			detail: "The agent recovered from a shared-state lookup miss.",
			status: "failed",
		};
	}

	if (lower.includes("message_end")) {
		return { label: "Reported progress", detail: cleanSummary(summary), status: "completed" };
	}

	return { label: humanizeEventType(event.type), detail: cleanSummary(summary), status: "completed" };
}

export function readableEvents(events: AgentRecentEvent[]): ReadableAgentActivity[] {
	return events.map(readableEvent).filter((event): event is ReadableAgentActivity => event !== null);
}

function activityFromTool(tool: ToolSummary): ReadableAgentActivity {
	const path = extractArtifactPath([tool.argsSummary, tool.resultSummary].filter(Boolean).join(" "));
	const name = tool.name.toLowerCase();

	if (name.includes("write") || name.includes("edit")) {
		return {
			label: "Writing artifact",
			detail: path ? `Updating ${path}` : "Updating shared state.",
			status: tool.status,
		};
	}

	if (name.includes("read")) {
		return {
			label: "Reading artifact",
			detail: path ? `Reading ${path}` : "Reading shared state.",
			status: tool.status,
		};
	}

	if (name.includes("list")) {
		return { label: "Checking shared state", detail: "Looking for available artifacts.", status: tool.status };
	}

	return { label: humanizeToolName(tool.name), detail: tool.argsSummary ?? tool.resultSummary, status: tool.status };
}

function latestArtifactPath(agent: AgentCard): string | null {
	for (const event of [...agent.recentEvents].reverse()) {
		const path = extractArtifactPath(event.summary);
		if (
			path &&
			(event.summary.includes("write") || event.summary.includes("wrote") || event.summary.includes("updated"))
		) {
			return path;
		}
	}
	return null;
}

function artifactFromPreview(value: string | null): string | null {
	return value ? extractArtifactPath(value) : null;
}

function extractArtifactPath(value: string | null): string | null {
	if (!value) return null;
	const match = value.match(/([\w.-]+\/[\w./-]+\.(?:md|json|txt|csv))/i);
	return match?.[1] ?? null;
}

function cleanSummary(value: string): string {
	return value
		.replace(/^\w+:\s*/i, "")
		.replace(/^tool_execution_\w+:\s*/i, "")
		.replace(/^message_end:\s*/i, "")
		.trim();
}

function humanizeToolName(value: string): string {
	return value.replaceAll("_", " ").replaceAll(".", " ");
}

function humanizeEventType(value: string): string {
	return value.replaceAll("_", " ");
}
