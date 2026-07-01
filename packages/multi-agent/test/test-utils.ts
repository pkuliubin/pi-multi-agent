import type { AgentMessage, AgentState, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { AgentSessionLike, AgentSessionLikeEventListener, AgentSessionPromptOptions } from "../src/index.ts";

const usage: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const model: Model<Api> = {
	id: "mock-model",
	name: "Mock Model",
	api: "openai-responses",
	provider: "mock",
	baseUrl: "",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

export function createAssistantMessage(
	text: string,
	options: { stopReason?: AssistantMessage["stopReason"]; errorMessage?: string } = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "mock",
		model: "mock-model",
		usage,
		stopReason: options.stopReason ?? "stop",
		errorMessage: options.errorMessage,
		timestamp: Date.now(),
	};
}

export function createUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}

class MockAgentState implements AgentState {
	systemPrompt = "";
	model = model;
	thinkingLevel: ThinkingLevel = "off";
	isStreaming = false;
	streamingMessage?: AgentMessage;
	pendingToolCalls = new Set<string>();
	errorMessage?: string;
	private _tools: AgentTool[] = [];
	private _messages: AgentMessage[] = [];

	get tools(): AgentTool[] {
		return this._tools;
	}

	set tools(tools: AgentTool[]) {
		this._tools = tools;
	}

	get messages(): AgentMessage[] {
		return this._messages;
	}

	set messages(messages: AgentMessage[]) {
		this._messages = messages;
	}
}

export class MockAgentSession implements AgentSessionLike {
	readonly state = new MockAgentState();
	sessionId = "session-1";
	sessionFile = "/tmp/session.jsonl";
	model = model;
	thinkingLevel: ThinkingLevel = "off";
	promptCalls: Array<{ text: string; options?: AgentSessionPromptOptions }> = [];
	steerCalls: string[] = [];
	followUpCalls: string[] = [];
	abortCalls = 0;
	waitForIdleCalls = 0;
	disposeCalls = 0;
	promptHandler?: (text: string) => Promise<void> | void;
	waitForIdleHandler?: () => Promise<void> | void;
	private listeners: AgentSessionLikeEventListener[] = [];

	async prompt(text: string, options?: AgentSessionPromptOptions): Promise<void> {
		this.promptCalls.push({ text, options });
		await this.promptHandler?.(text);
	}

	async steer(text: string): Promise<void> {
		this.steerCalls.push(text);
	}

	async followUp(text: string): Promise<void> {
		this.followUpCalls.push(text);
	}

	async abort(): Promise<void> {
		this.abortCalls += 1;
	}

	async waitForIdle(): Promise<void> {
		this.waitForIdleCalls += 1;
		await this.waitForIdleHandler?.();
	}

	subscribe(listener: AgentSessionLikeEventListener): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((candidate) => candidate !== listener);
		};
	}

	emit(event: Parameters<AgentSessionLikeEventListener>[0]): void {
		for (const listener of this.listeners) {
			void listener(event);
		}
	}

	async dispose(): Promise<void> {
		this.disposeCalls += 1;
	}

	listenerCount(): number {
		return this.listeners.length;
	}
}
