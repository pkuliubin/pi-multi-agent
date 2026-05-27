import type { AgentMessage, AgentState, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";

export type SubAgentStatePolicy = "ephemeral" | "session" | "persistent";
export type SubAgentPhase = "idle" | "listening" | "running" | "closed";
export type SubAgentResultStatus = "completed" | "failed" | "aborted";

export interface AgentSessionPromptOptions {
	expandPromptTemplates?: boolean;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	source?: "interactive" | "rpc" | "extension";
	preflightResult?: (success: boolean) => void;
}

export type AgentSessionLikeEvent =
	| { type: string; [key: string]: unknown }
	| { type: "message_end"; message: AgentMessage };

export type AgentSessionLikeEventListener = (event: AgentSessionLikeEvent) => void | Promise<void>;

export interface AgentSessionLike {
	readonly state: AgentState;
	readonly sessionId: string;
	readonly sessionFile?: string;
	readonly model?: Model<Api>;
	readonly thinkingLevel: ThinkingLevel;

	prompt(text: string, options?: AgentSessionPromptOptions): Promise<void>;
	steer(text: string, images?: ImageContent[]): Promise<void>;
	followUp(text: string, images?: ImageContent[]): Promise<void>;
	abort(): Promise<void> | void;
	waitForIdle(): Promise<void>;
	subscribe(listener: AgentSessionLikeEventListener): () => void;
	dispose(): Promise<void> | void;
}

export interface PiSubAgentDefinition {
	id: string;
	name?: string;
	description?: string;
	statePolicy: SubAgentStatePolicy;
	systemPrompt?: string;
	metadata?: Record<string, unknown>;
}

export interface CreateSubAgentSessionInput {
	definition: PiSubAgentDefinition;
	cwd: string;
	agentDir?: string;
	model?: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	sessionPolicy: Extract<SubAgentStatePolicy, "ephemeral" | "session">;
}

export interface AgentSessionFactory {
	create(input: CreateSubAgentSessionInput): Promise<AgentSessionLike>;
}

export interface SubAgentTask {
	input: string;
	invocationId?: string;
	metadata?: Record<string, unknown>;
}

export interface SubAgentResult {
	agentId: string;
	sessionId: string;
	invocationId?: string;
	status: SubAgentResultStatus;
	finalText: string;
	errorMessage?: string;
	startedAt: number;
	endedAt: number;
	messageCountBefore: number;
	messageCountAfter: number;
}

export interface SubAgentInspection {
	agentId: string;
	phase: SubAgentPhase;
	statePolicy: SubAgentStatePolicy;
	sessionId: string;
	sessionFile?: string;
	model?: Model<Api>;
	thinkingLevel: ThinkingLevel;
	messageCount: number;
}
