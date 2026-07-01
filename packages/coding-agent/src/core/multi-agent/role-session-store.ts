import type {
	AgentSessionLike,
	CreateSubAgentSessionInput,
	FileRoleSessionIndex,
	PiSubAgentDefinition,
	SubAgentInspection,
	SubAgentLifecycleStore,
	SubAgentRoleSessionBinding,
} from "@earendil-works/pi-multi-agent";
import { SessionManager } from "../session-manager.ts";

export interface CodingSubAgentLifecycleStoreOptions {
	index: FileRoleSessionIndex;
	cwd: string;
	sessionDir?: string;
}

export class CodingSubAgentLifecycleStore implements SubAgentLifecycleStore {
	private readonly index: FileRoleSessionIndex;
	private readonly cwd: string;
	private readonly sessionDir?: string;

	constructor(options: CodingSubAgentLifecycleStoreOptions) {
		this.index = options.index;
		this.cwd = options.cwd;
		this.sessionDir = options.sessionDir;
	}

	resolveBinding(input: CreateSubAgentSessionInput): ReturnType<FileRoleSessionIndex["find"]> {
		if (!input.roleSession) return undefined;
		return this.index.find({
			mainSessionId: input.roleSession.mainSessionId,
			agentId: input.definition.id,
			definitionIdentity: input.roleSession.definitionIdentity,
		});
	}

	async getOrCreate(input: {
		definition: PiSubAgentDefinition;
		roleSession: SubAgentRoleSessionBinding;
		create: () => Promise<AgentSessionLike>;
	}): Promise<AgentSessionLike> {
		const session = await input.create();
		this.index.upsert({
			mainSessionId: input.roleSession.mainSessionId,
			agentId: input.definition.id,
			definitionIdentity: input.roleSession.definitionIdentity,
			subAgentSessionId: session.sessionId,
			subAgentSessionFile: requiredSessionFile(session),
			state: "idle",
		});
		return session;
	}

	markRunning(input: {
		definition: PiSubAgentDefinition;
		roleSession: SubAgentRoleSessionBinding;
		session: AgentSessionLike;
	}): void {
		this.upsertState(input, "running");
	}

	markIdle(input: {
		definition: PiSubAgentDefinition;
		roleSession: SubAgentRoleSessionBinding;
		session: AgentSessionLike;
	}): void {
		this.upsertState(input, "idle");
	}

	markClosed(input: {
		definition: PiSubAgentDefinition;
		roleSession: SubAgentRoleSessionBinding;
		session: AgentSessionLike;
	}): void {
		this.upsertState(input, "closed");
	}

	list(mainSessionId?: string): SubAgentInspection[] {
		return this.index.list(mainSessionId).map((binding) => {
			const sessionManager = SessionManager.open(binding.subAgentSessionFile, this.sessionDir, this.cwd);
			return {
				agentId: binding.agentId,
				phase: binding.state,
				statePolicy: "session",
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				thinkingLevel: "off",
				messageCount: sessionManager.buildSessionContext().messages.length,
			};
		});
	}

	private upsertState(
		input: {
			definition: PiSubAgentDefinition;
			roleSession: SubAgentRoleSessionBinding;
			session: AgentSessionLike;
		},
		state: "idle" | "running" | "closed",
	): void {
		this.index.upsert({
			mainSessionId: input.roleSession.mainSessionId,
			agentId: input.definition.id,
			definitionIdentity: input.roleSession.definitionIdentity,
			subAgentSessionId: input.session.sessionId,
			subAgentSessionFile: requiredSessionFile(input.session),
			state,
		});
	}
}

function requiredSessionFile(session: AgentSessionLike): string {
	if (!session.sessionFile) {
		throw new Error("Persistent sub-agent session did not create a session file");
	}
	return session.sessionFile;
}
