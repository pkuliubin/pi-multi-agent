import type {
	AbortRequest,
	AbortResponse,
	AgentHistoryResponse,
	AgentsResponse,
	MessagesResponse,
	PromptRequest,
	PromptResponse,
	ReplayResetRequest,
	ReplaySpeedRequest,
	RoleSessionsResponse,
	SessionSnapshot,
	SharedStateArtifactResponse,
	SharedStateManifestResponse,
	StartSessionRequest,
	StopSessionRequest,
} from "../contract.ts";

export interface BackendEngine {
	start(request: StartSessionRequest): Promise<SessionSnapshot>;
	stop(request: StopSessionRequest): Promise<SessionSnapshot>;
	prompt(request: PromptRequest): Promise<PromptResponse>;
	abort(request: AbortRequest): Promise<AbortResponse>;
	getState(): SessionSnapshot;
	getMessages(): MessagesResponse | Promise<MessagesResponse>;
	getAgents(): AgentsResponse | Promise<AgentsResponse>;
	getAgentHistory(agentId: string): AgentHistoryResponse | Promise<AgentHistoryResponse>;
	getRoleSessions(): Promise<RoleSessionsResponse>;
	getSharedStateManifest(): Promise<SharedStateManifestResponse>;
	getSharedStateArtifact(path: string): Promise<SharedStateArtifactResponse>;
	resetReplay?(request: ReplayResetRequest): Promise<SessionSnapshot>;
	setReplaySpeed?(request: ReplaySpeedRequest): Promise<SessionSnapshot>;
}
