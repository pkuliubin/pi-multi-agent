import type { SharedStateGrant } from "./shared-state/index.ts";
import type { AgentSessionFactory, AgentSessionLike, PiSubAgentDefinition, SubAgentResult } from "./types.ts";

export interface SharedStateSubAgentAccessSurfaceDefinition {
	type: "shared_state";
	grants: SharedStateGrant[];
}

export type SubAgentAccessSurfaceDefinition = SharedStateSubAgentAccessSurfaceDefinition;

export interface SubAgentCapabilities {
	tools?: unknown[];
}

export interface RunSubAgentInput {
	agentId: string;
	task: string;
	invocationId?: string;
	statePolicyOverride?: "ephemeral" | "session";
	timeoutMs?: number;
	model?: unknown;
	thinkingLevel?: unknown;
}

export interface RunSubAgentToolResult {
	result: SubAgentResult;
}

export interface CreateSubAgentInstanceInput {
	definition: PiSubAgentDefinition;
	sessionPolicy: "ephemeral" | "session";
	capabilities?: SubAgentCapabilities;
}

export interface SubAgentInstanceFactory {
	create(input: CreateSubAgentInstanceInput): Promise<AgentSessionLike>;
}

export type RunSubAgentSessionFactory = AgentSessionFactory | SubAgentInstanceFactory;

export interface RunSubAgentRunnerOptions {
	registry: { get(id: string): PiSubAgentDefinition | undefined };
	sessionFactory: RunSubAgentSessionFactory;
	cwd: string;
	agentDir?: string;
	model?: unknown;
	thinkingLevel?: unknown;
	maxConcurrentSubAgents?: number;
	createAccessSurfaceTools?: (input: {
		definition: PiSubAgentDefinition;
		accessSurface: SubAgentAccessSurfaceDefinition;
	}) => unknown[];
}
