import type {
	AbortRequest,
	AbortResponse,
	AgentHistoryResponse,
	AgentsResponse,
	MessagesResponse,
	PromptRequest,
	PromptResponse,
	RoleSessionsResponse,
	SessionSnapshot,
	SharedStateArtifactResponse,
	SharedStateManifestResponse,
	StartSessionRequest,
	StopSessionRequest,
} from "../contract.ts";
import { artifactNotFound, sessionNotStarted } from "../errors.ts";
import type { SessionStore } from "../session-store.ts";
import type { BackendEngine } from "./engine.ts";

export class EmptyEngine implements BackendEngine {
	private readonly store: SessionStore;

	constructor(store: SessionStore) {
		this.store = store;
	}

	async start(_request: StartSessionRequest): Promise<SessionSnapshot> {
		throw sessionNotStarted();
	}

	async stop(_request: StopSessionRequest): Promise<SessionSnapshot> {
		return this.store.getSnapshot();
	}

	async prompt(_request: PromptRequest): Promise<PromptResponse> {
		throw sessionNotStarted();
	}

	async abort(_request: AbortRequest): Promise<AbortResponse> {
		throw sessionNotStarted();
	}

	getState(): SessionSnapshot {
		return this.store.getSnapshot();
	}

	getMessages(): MessagesResponse {
		return this.store.getMessages();
	}

	getAgents(): AgentsResponse {
		return this.store.getAgents();
	}

	getAgentHistory(agentId: string): AgentHistoryResponse {
		return this.store.getAgentHistory(agentId);
	}

	async getRoleSessions(): Promise<RoleSessionsResponse> {
		return this.store.getRoleSessions();
	}

	async getSharedStateManifest(): Promise<SharedStateManifestResponse> {
		return this.store.getSharedStateManifest();
	}

	async getSharedStateArtifact(path: string): Promise<SharedStateArtifactResponse> {
		throw artifactNotFound(path);
	}
}
