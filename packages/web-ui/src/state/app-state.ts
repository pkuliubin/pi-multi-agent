import type {
	AgentCard,
	AgentHistoryResponse,
	AgentsResponse,
	MessagesResponse,
	SessionSnapshot,
	SharedStateArtifactEntry,
	SharedStateArtifactResponse,
	SharedStateManifestResponse,
	TimelineMessage,
} from "../api/contracts.ts";

export interface WebUiState {
	session: SessionSnapshot | null;
	messages: TimelineMessage[];
	agentsById: Record<string, AgentCard>;
	agentHistory: {
		byId: Record<string, AgentHistoryResponse>;
		loadingById: Record<string, boolean>;
		errorById: Record<string, string | null>;
	};
	sharedState: {
		root: string | null;
		artifacts: SharedStateArtifactEntry[];
		selectedArtifactPath: string | null;
		artifactContentByPath: Record<string, SharedStateArtifactResponse>;
		loadingPath: string | null;
		error: string | null;
	};
	connection: {
		connected: boolean;
		reconnecting: boolean;
		lastSequence: number | null;
		errorBanner: string | null;
	};
	input: {
		pending: boolean;
		notice: string | null;
	};
}

export interface HydratePayload {
	session: SessionSnapshot;
	messages: MessagesResponse;
	agents: AgentsResponse;
	manifest: SharedStateManifestResponse;
}

export const initialWebUiState: WebUiState = {
	session: null,
	messages: [],
	agentsById: {},
	agentHistory: {
		byId: {},
		loadingById: {},
		errorById: {},
	},
	sharedState: {
		root: null,
		artifacts: [],
		selectedArtifactPath: null,
		artifactContentByPath: {},
		loadingPath: null,
		error: null,
	},
	connection: {
		connected: false,
		reconnecting: false,
		lastSequence: null,
		errorBanner: null,
	},
	input: {
		pending: false,
		notice: null,
	},
};
