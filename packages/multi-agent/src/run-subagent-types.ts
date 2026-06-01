import type { SharedStateGrant } from "./shared-state/index.ts";
import type {
	AgentSessionFactory,
	AgentSessionLike,
	AgentSessionLikeEvent,
	PiSubAgentDefinition,
	SubAgentInspection,
	SubAgentResult,
} from "./types.ts";

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

export interface SubAgentEventEnvelope {
	source: "subagent";
	agentId: string;
	sessionId: string;
	invocationId?: string;
	event: AgentSessionLikeEvent;
}

export type SubAgentEventObserver = (envelope: SubAgentEventEnvelope) => void | Promise<void>;

export type CompactSubAgentEvent =
	| { type: "agent_start" | "agent_end"; timestamp: number }
	| {
			type: "tool_execution_start" | "tool_execution_end";
			toolName: string;
			toolCallId: string;
			timestamp: number;
			argsSummary?: string;
			resultSummary?: string;
			args?: unknown;
			result?: unknown;
			isError?: boolean;
	  }
	| { type: "message_end"; preview: string; fullText?: string; timestamp: number };

export interface RunSubAgentProgressSummary {
	currentPhase: "starting" | "running" | "completed" | "failed" | "aborted";
	activeTool?: { toolName: string; toolCallId: string };
	completedTools: Array<{ toolName: string; toolCallId: string; isError?: boolean }>;
	internalToolErrors?: number;
	lastToolError?: { toolName: string; toolCallId: string; message: string };
	lastAssistantPreview?: string;
	eventCount: number;
	recentEvents: CompactSubAgentEvent[];
}

export interface RunSubAgentInvocationOptions {
	onEvent?: SubAgentEventObserver;
}

export interface CreateSubAgentInstanceInput {
	definition: PiSubAgentDefinition;
	sessionPolicy: "ephemeral" | "session";
	capabilities?: SubAgentCapabilities;
	roleSession?: SubAgentRoleSessionBinding;
}

export interface SubAgentInstanceFactory {
	create(input: CreateSubAgentInstanceInput): Promise<AgentSessionLike>;
}

export type RunSubAgentSessionFactory = AgentSessionFactory | SubAgentInstanceFactory;

export interface SubAgentRoleSessionBinding {
	mainSessionId: string;
	definitionIdentity: {
		source: "file" | "demo" | "custom";
		fingerprint: string;
		sourcePath?: string;
	};
}

export interface SubAgentLifecycleStore {
	getOrCreate(input: {
		definition: PiSubAgentDefinition;
		roleSession: SubAgentRoleSessionBinding;
		create: () => Promise<AgentSessionLike>;
	}): Promise<AgentSessionLike>;
	markRunning?(input: {
		definition: PiSubAgentDefinition;
		roleSession: SubAgentRoleSessionBinding;
		session: AgentSessionLike;
	}): void;
	markIdle?(input: {
		definition: PiSubAgentDefinition;
		roleSession: SubAgentRoleSessionBinding;
		session: AgentSessionLike;
	}): void;
	markClosed?(input: {
		definition: PiSubAgentDefinition;
		roleSession: SubAgentRoleSessionBinding;
		session: AgentSessionLike;
	}): void;
	list?(mainSessionId?: string): SubAgentInspection[];
}

export interface RunSubAgentRunnerOptions {
	registry: { get(id: string): PiSubAgentDefinition | undefined };
	sessionFactory: RunSubAgentSessionFactory;
	cwd: string;
	agentDir?: string;
	model?: unknown;
	thinkingLevel?: unknown;
	maxConcurrentSubAgents?: number;
	mainSessionId?: string;
	definitionSource?: "file" | "demo" | "custom";
	lifecycleStore?: SubAgentLifecycleStore;
	createAccessSurfaceTools?: (input: {
		definition: PiSubAgentDefinition;
		accessSurface: SubAgentAccessSurfaceDefinition;
	}) => unknown[];
}
