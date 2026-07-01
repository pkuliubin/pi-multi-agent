import type {
	AgentCard,
	AgentHistoryItem,
	AgentHistoryResponse,
	BackendMode,
	MessagesResponse,
	RoleSessionsResponse,
	SessionSnapshot,
	SharedStateManifestResponse,
	SharedStateSummary,
	TimelineMessage,
} from "./contract.ts";

export interface SessionStoreState {
	snapshot: SessionSnapshot;
	messages: TimelineMessage[];
	agents: AgentCard[];
	agentHistoryById: Record<string, AgentHistoryItem[]>;
	roleSessions: RoleSessionsResponse;
	sharedStateManifest: SharedStateManifestResponse;
}

export function createEmptySharedStateSummary(): SharedStateSummary {
	return {
		root: null,
		artifacts: [],
		updatedAt: null,
	};
}

export function createEmptySessionSnapshot(): SessionSnapshot {
	return {
		backendMode: null,
		session: {
			started: false,
			sessionId: null,
			cwd: null,
			pid: null,
			startedAt: null,
			stoppedAt: null,
		},
		turn: {
			turnId: null,
			status: "idle",
			startedAt: null,
			updatedAt: null,
		},
		replay: null,
		counts: {
			messages: 0,
			agents: 0,
			artifacts: 0,
		},
		agents: [],
		sharedState: createEmptySharedStateSummary(),
	};
}

export class SessionStore {
	private state: SessionStoreState;

	constructor(initialState?: Partial<SessionStoreState>) {
		this.state = {
			snapshot: createEmptySessionSnapshot(),
			messages: [],
			agents: [],
			agentHistoryById: {},
			roleSessions: { roleSessions: [] },
			sharedStateManifest: { root: null, artifacts: [] },
			...initialState,
		};
		this.recount();
	}

	getSnapshot(): SessionSnapshot {
		return this.state.snapshot;
	}

	getMode(): BackendMode | null {
		return this.state.snapshot.backendMode;
	}

	isStarted(): boolean {
		return this.state.snapshot.session.started;
	}

	getMessages(): MessagesResponse {
		return { messages: this.state.messages };
	}

	getAgents(): { agents: AgentCard[] } {
		return { agents: this.state.agents };
	}

	getAgentHistory(agentId: string): AgentHistoryResponse {
		return { agentId, items: this.state.agentHistoryById[agentId] ?? [] };
	}

	getRoleSessions(): RoleSessionsResponse {
		return this.state.roleSessions;
	}

	getSharedStateManifest(): SharedStateManifestResponse {
		return this.state.sharedStateManifest;
	}

	setSnapshot(snapshot: SessionSnapshot): void {
		this.state.snapshot = snapshot;
		this.state.messages = [];
		this.state.agents = snapshot.agents;
		this.state.agentHistoryById = {};
		this.state.roleSessions = { roleSessions: [] };
		this.state.sharedStateManifest = {
			root: snapshot.sharedState.root,
			artifacts: snapshot.sharedState.artifacts,
		};
		this.recount();
	}

	patchSnapshot(patch: (snapshot: SessionSnapshot) => SessionSnapshot): SessionSnapshot {
		this.state.snapshot = patch(this.state.snapshot);
		this.recount();
		return this.state.snapshot;
	}

	setMessages(messages: TimelineMessage[]): void {
		this.state.messages = messages;
		this.recount();
	}

	setAgents(agents: AgentCard[]): void {
		this.state.agents = agents;
		this.state.snapshot.agents = agents;
		this.recount();
	}

	setRoleSessions(roleSessions: RoleSessionsResponse): void {
		this.state.roleSessions = roleSessions;
	}

	setAgentHistory(agentId: string, items: AgentHistoryItem[]): void {
		this.state.agentHistoryById = {
			...this.state.agentHistoryById,
			[agentId]: items,
		};
	}

	appendAgentHistory(agentId: string, items: AgentHistoryItem[]): void {
		if (items.length === 0) return;
		const existing = this.state.agentHistoryById[agentId] ?? [];
		const byId = new Map(existing.map((item) => [item.id, item]));
		for (const item of items) {
			byId.set(item.id, mergeHistoryItem(byId.get(item.id), item));
		}
		this.setAgentHistory(agentId, Array.from(byId.values()).sort(compareHistoryItems));
	}

	setSharedStateManifest(sharedStateManifest: SharedStateManifestResponse): void {
		this.state.sharedStateManifest = sharedStateManifest;
		this.state.snapshot.sharedState = {
			root: sharedStateManifest.root,
			artifacts: sharedStateManifest.artifacts,
			updatedAt: latestUpdatedAt(sharedStateManifest.artifacts.map((artifact) => artifact.updatedAt)),
		};
		this.recount();
	}

	reset(): void {
		this.state = {
			snapshot: createEmptySessionSnapshot(),
			messages: [],
			agents: [],
			agentHistoryById: {},
			roleSessions: { roleSessions: [] },
			sharedStateManifest: { root: null, artifacts: [] },
		};
	}

	private recount(): void {
		this.state.snapshot.counts = {
			messages: this.state.messages.length,
			agents: this.state.agents.length,
			artifacts: this.state.snapshot.sharedState.artifacts.length,
		};
		this.state.snapshot.agents = this.state.agents;
	}
}

function latestUpdatedAt(values: Array<string | null>): string | null {
	return (
		values
			.filter((value): value is string => value !== null)
			.sort()
			.at(-1) ?? null
	);
}

function compareHistoryItems(left: AgentHistoryItem, right: AgentHistoryItem): number {
	return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function mergeHistoryItem(existing: AgentHistoryItem | undefined, next: AgentHistoryItem): AgentHistoryItem {
	if (!existing) return next;
	if (existing.type === "tool_call" && next.type === "tool_call") {
		return {
			...existing,
			...next,
			createdAt: existing.createdAt <= next.createdAt ? existing.createdAt : next.createdAt,
			args: next.args ?? existing.args,
			result: next.result ?? existing.result,
		};
	}
	return next;
}
