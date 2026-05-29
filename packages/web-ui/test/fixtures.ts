import type { AgentCard, SessionSnapshot, SharedStateArtifactEntry, TimelineMessage } from "../src/api/contracts.ts";

export const artifactEntry: SharedStateArtifactEntry = {
	path: "analysis/summary.json",
	space: "shared",
	ownerAgentId: "da",
	version: 2,
	createdBy: "da",
	updatedBy: "da",
	createdAt: "2026-05-28T10:00:00.000Z",
	updatedAt: "2026-05-28T10:05:00.000Z",
	sizeBytes: 128,
	mimeType: "application/json",
	metadata: {},
};

export const agentCard: AgentCard = {
	agentId: "da",
	displayName: "Data Analyst",
	role: "DA",
	avatar: null,
	phase: "running",
	activeTool: {
		toolCallId: "tool-1",
		name: "shared_state.read",
		status: "running",
		argsSummary: "analysis/summary.json",
		resultSummary: null,
		startedAt: "2026-05-28T10:06:00.000Z",
		endedAt: null,
	},
	completedTools: [],
	lastAssistantPreview: "Checking the latest artifact.",
	eventCount: 1,
	recentEvents: [
		{
			id: "event-1",
			type: "progress",
			summary: "Reading shared state",
			createdAt: "2026-05-28T10:06:00.000Z",
		},
	],
	sessionId: "agent-session",
	lastRunStatus: "running",
	sharedStateRoot: ".pi/multi-agent/shared-state",
	updatedAt: "2026-05-28T10:06:00.000Z",
};

export const timelineMessage: TimelineMessage = {
	id: "message-1",
	source: "main",
	agentId: null,
	role: "assistant",
	kind: "message",
	content: "Done",
	status: "completed",
	createdAt: "2026-05-28T10:06:00.000Z",
	updatedAt: "2026-05-28T10:06:00.000Z",
	rawType: null,
	toolName: null,
	toolCallId: null,
};

export const sessionSnapshot: SessionSnapshot = {
	backendMode: "replay",
	session: {
		started: true,
		sessionId: "session-1",
		cwd: "/tmp/project",
		pid: null,
		startedAt: "2026-05-28T10:00:00.000Z",
		stoppedAt: null,
	},
	turn: {
		turnId: "turn-1",
		status: "running",
		startedAt: "2026-05-28T10:01:00.000Z",
		updatedAt: "2026-05-28T10:06:00.000Z",
	},
	replay: {
		loaded: true,
		running: true,
		ended: false,
		logPath: "data/sharedstate_multi_agent_cli_log.jsonl",
		speed: 1,
		cursor: 10,
		totalEvents: 100,
	},
	counts: {
		messages: 1,
		agents: 1,
		artifacts: 1,
	},
	agents: [agentCard],
	sharedState: {
		root: ".pi/multi-agent/shared-state",
		artifacts: [artifactEntry],
		updatedAt: "2026-05-28T10:05:00.000Z",
	},
};
