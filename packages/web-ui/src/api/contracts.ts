export type BackendMode = "live" | "replay";

export type AgentPhase = "idle" | "starting" | "running" | "completed" | "failed" | "aborted";

export type RunStatus = "idle" | "running" | "completed" | "failed" | "aborted";

export type TurnStatus = "idle" | "running" | "waiting_for_tool" | "completed" | "failed" | "aborted";

export type ApiErrorCode =
	| "SESSION_NOT_STARTED"
	| "SESSION_ALREADY_RUNNING"
	| "INVALID_MODE"
	| "INVALID_REQUEST"
	| "ARTIFACT_NOT_FOUND"
	| "PROCESS_EXITED"
	| "REPLAY_ENDED"
	| "UNSUPPORTED_IN_REPLAY"
	| "INTERNAL_ERROR";

export interface ApiErrorResponse {
	error: {
		code: ApiErrorCode;
		message: string;
		details?: unknown;
	};
}

export interface StartSessionRequest {
	mode: BackendMode;
	cwd?: string;
	sessionId?: string;
	resume?: boolean;
	replay?: {
		logPath?: string;
		speed?: number;
		autoStart?: boolean;
	};
	live?: {
		cliPath?: string;
		provider?: string;
		model?: string;
		args?: string[];
	};
	sharedStateRoot?: string;
}

export interface StopSessionRequest {
	force?: boolean;
	clearReplayState?: boolean;
}

export interface PromptRequest {
	text: string;
}

export interface PromptResponse {
	accepted: boolean;
	mode: BackendMode;
	turnId: string | null;
	message: string | null;
}

export interface AbortRequest {
	reason?: string;
}

export interface AbortResponse {
	accepted: boolean;
	mode: BackendMode;
	turnId: string | null;
	message: string | null;
}

export interface SessionSnapshot {
	backendMode: BackendMode | null;
	session: {
		started: boolean;
		sessionId: string | null;
		cwd: string | null;
		pid: number | null;
		startedAt: string | null;
		stoppedAt: string | null;
	};
	turn: {
		turnId: string | null;
		status: TurnStatus;
		startedAt: string | null;
		updatedAt: string | null;
	};
	replay: {
		loaded: boolean;
		running: boolean;
		ended: boolean;
		logPath: string | null;
		speed: number | null;
		cursor: number | null;
		totalEvents: number | null;
	} | null;
	counts: {
		messages: number;
		agents: number;
		artifacts: number;
	};
	agents: AgentCard[];
	sharedState: SharedStateSummary;
}

export interface MessagesResponse {
	messages: TimelineMessage[];
}

export interface TimelineMessage {
	id: string;
	source: "main" | "agent" | "system";
	agentId: string | null;
	role: "user" | "assistant" | "tool" | "system";
	kind: "message" | "tool_event" | "status";
	content: string;
	status: "streaming" | "completed" | "failed" | "aborted";
	createdAt: string;
	updatedAt: string;
	rawType: string | null;
	toolName: string | null;
	toolCallId: string | null;
}

export interface AgentsResponse {
	agents: AgentCard[];
}

export interface AgentCard {
	agentId: string;
	displayName: string;
	role: string | null;
	avatar: string | null;
	phase: AgentPhase;
	activeTool: ToolSummary | null;
	completedTools: ToolSummary[];
	lastAssistantPreview: string | null;
	eventCount: number;
	recentEvents: AgentRecentEvent[];
	sessionId: string | null;
	lastRunStatus: RunStatus;
	sharedStateRoot: string | null;
	updatedAt: string | null;
}

export interface ToolSummary {
	toolCallId: string | null;
	name: string;
	status: "running" | "completed" | "failed" | "aborted";
	argsSummary: string | null;
	resultSummary: string | null;
	startedAt: string | null;
	endedAt: string | null;
}

export interface AgentRecentEvent {
	id: string;
	type: string;
	summary: string;
	createdAt: string;
}

export interface AgentHistoryResponse {
	agentId: string;
	items: AgentHistoryItem[];
}

export type AgentHistoryItem =
	| {
			id: string;
			agentId: string;
			turnId: string | null;
			invocationId: string | null;
			type: "message";
			role: "assistant";
			content: string;
			createdAt: string;
	  }
	| {
			id: string;
			agentId: string;
			turnId: string | null;
			invocationId: string | null;
			type: "tool_call";
			toolName: string;
			toolCallId: string | null;
			status: "running" | "completed" | "failed" | "aborted";
			args: unknown;
			result: unknown;
			createdAt: string;
	  }
	| {
			id: string;
			agentId: string;
			turnId: string | null;
			invocationId: string | null;
			type: "status";
			status: "running" | "completed" | "failed" | "aborted";
			content: string;
			createdAt: string;
	  };

export interface RoleSessionsResponse {
	roleSessions: RoleSessionView[];
}

export interface RoleSessionView {
	role: string;
	agentId: string;
	displayName: string;
	sessionId: string | null;
	status: "idle" | "running" | "closed" | "unknown";
	currentRunId: string | null;
	sharedStateRoot: string | null;
	createdAt: string | null;
	updatedAt: string | null;
}

export interface SharedStateManifestResponse {
	root: string | null;
	artifacts: SharedStateArtifactEntry[];
}

export interface SharedStateSummary {
	root: string | null;
	artifacts: SharedStateArtifactEntry[];
	updatedAt: string | null;
}

export interface SharedStateArtifactEntry {
	path: string;
	space: string | null;
	ownerAgentId: string | null;
	version: number | string | null;
	createdBy: string | null;
	updatedBy: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	sizeBytes: number | null;
	mimeType: string | null;
	metadata: Record<string, unknown>;
}

export interface SharedStateArtifactResponse {
	path: string;
	artifact: SharedStateArtifactEntry | null;
	content: ArtifactContent;
}

export type ArtifactContent =
	| {
			kind: "text";
			text: string;
			sizeBytes: number;
			mimeType: string | null;
			truncated: boolean;
	  }
	| {
			kind: "json";
			json: unknown;
			text: string;
			sizeBytes: number;
			mimeType: string | null;
			truncated: boolean;
	  }
	| {
			kind: "binary-unsupported";
			sizeBytes: number;
			mimeType: string | null;
			truncated: false;
	  };

export interface SharedStateSearchResponse {
	query: string;
	results: Array<{
		path: string;
		preview: string;
		line: number | null;
		artifact: SharedStateArtifactEntry | null;
	}>;
}

export type SseEventType =
	| "session.started"
	| "session.stopped"
	| "message.delta"
	| "message.completed"
	| "tool.started"
	| "tool.updated"
	| "tool.completed"
	| "agent.updated"
	| "shared_state.changed"
	| "replay.started"
	| "replay.completed"
	| "error";

export interface SseEnvelope<TPayload = SsePayload> {
	eventId: string;
	eventType: SseEventType;
	mode: BackendMode;
	sessionId: string | null;
	turnId: string | null;
	sequence: number;
	createdAt: string;
	payload: TPayload;
}

export interface MessageDeltaPayload {
	messageId: string;
	role: "assistant" | "user" | "system";
	source: "main" | "agent" | "system";
	agentId: string | null;
	delta: string;
}

export interface MessageCompletedPayload {
	message: TimelineMessage;
}

export interface ToolEventPayload {
	toolCallId: string;
	toolName: string;
	agentId: string | null;
	status: "running" | "completed" | "failed" | "aborted";
	argsSummary: string | null;
	resultSummary: string | null;
}

export interface AgentUpdatedPayload {
	agent: AgentCard;
	changedFields: string[];
}

export interface SharedStateChangedPayload {
	paths: string[];
	reason: "run_subagent_completed" | "shared_state_write" | "shared_state_edit" | "manual_refresh" | "replay_event";
}

export interface ReplayPayload {
	logPath: string;
	cursor: number;
	totalEvents: number;
	speed: number;
}

export interface ErrorPayload {
	code: ApiErrorCode;
	message: string;
	details?: unknown;
}

export type SsePayload =
	| MessageDeltaPayload
	| MessageCompletedPayload
	| ToolEventPayload
	| AgentUpdatedPayload
	| SharedStateChangedPayload
	| ReplayPayload
	| ErrorPayload;

export interface ReplayResetRequest {
	autoStart?: boolean;
}

export interface ReplaySpeedRequest {
	speed: number;
}
