import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
	AgentSessionLike,
	AgentSessionLikeEventListener,
	AgentSessionPromptOptions,
	PiSubAgentDefinition,
	SubAgentInspection,
	SubAgentPhase,
	SubAgentResult,
	SubAgentTask,
} from "./types.ts";

export class PiSubAgentInstance {
	readonly definition: PiSubAgentDefinition;
	readonly session: AgentSessionLike;
	private _phase: SubAgentPhase = "idle";

	constructor(definition: PiSubAgentDefinition, session: AgentSessionLike) {
		if (definition.statePolicy === "persistent") {
			throw new Error("SubAgent statePolicy 'persistent' is not supported in this phase");
		}
		this.definition = definition;
		this.session = session;
	}

	get phase(): SubAgentPhase {
		return this._phase;
	}

	async prompt(text: string, options?: AgentSessionPromptOptions): Promise<void> {
		this.assertCanStartRun();
		this._phase = "running";
		try {
			await this.session.prompt(text, options);
		} finally {
			this.restoreIdleIfOpen();
		}
	}

	async steer(text: string, images?: ImageContent[]): Promise<void> {
		this.assertOpen("steer");
		await this.session.steer(text, images);
	}

	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		this.assertOpen("followUp");
		await this.session.followUp(text, images);
	}

	async abort(): Promise<void> {
		this.assertOpen("abort");
		try {
			await this.session.abort();
			await this.session.waitForIdle();
		} finally {
			this.restoreIdleIfOpen();
		}
	}

	waitForIdle(): Promise<void> {
		return this.session.waitForIdle();
	}

	subscribe(listener: AgentSessionLikeEventListener): () => void {
		return this.session.subscribe(listener);
	}

	async invoke(task: SubAgentTask | string): Promise<SubAgentResult> {
		this.assertCanStartRun();
		const normalizedTask = typeof task === "string" ? { input: task } : task;
		const startedAt = Date.now();
		const messageCountBefore = this.session.state.messages.length;
		let errorMessage: string | undefined;

		try {
			await this.prompt(normalizedTask.input);
			await this.session.waitForIdle();
		} catch (error) {
			errorMessage = error instanceof Error ? error.message : String(error);
			this.restoreIdleIfOpen();
		}

		const messageCountAfter = this.session.state.messages.length;
		const assistant = findLastNewAssistant(this.session.state.messages, messageCountBefore);
		const status = errorMessage ? "failed" : statusFromAssistant(assistant);
		const finalText = assistant ? extractAssistantText(assistant) : "";

		return {
			agentId: this.definition.id,
			sessionId: this.session.sessionId,
			invocationId: normalizedTask.invocationId,
			status,
			finalText,
			errorMessage: errorMessage ?? assistant?.errorMessage,
			startedAt,
			endedAt: Date.now(),
			messageCountBefore,
			messageCountAfter,
		};
	}

	inspect(): SubAgentInspection {
		return {
			agentId: this.definition.id,
			phase: this.phase,
			statePolicy: this.definition.statePolicy,
			sessionId: this.session.sessionId,
			sessionFile: this.session.sessionFile,
			model: this.session.model,
			thinkingLevel: this.session.thinkingLevel,
			messageCount: this.session.state.messages.length,
		};
	}

	async close(): Promise<void> {
		if (this._phase === "closed") {
			return;
		}
		this._phase = "closed";
		await this.session.dispose();
	}

	private restoreIdleIfOpen(): void {
		if (this._phase !== "closed") {
			this._phase = "idle";
		}
	}

	private assertCanStartRun(): void {
		this.assertOpen("prompt");
		if (this._phase === "running") {
			throw new Error(`SubAgent is already running: ${this.definition.id}`);
		}
	}

	private assertOpen(operation: string): void {
		if (this._phase === "closed") {
			throw new Error(`Cannot ${operation} closed SubAgent: ${this.definition.id}`);
		}
	}
}

function findLastNewAssistant(messages: readonly AgentMessage[], startIndex: number): AssistantMessage | undefined {
	for (let index = messages.length - 1; index >= startIndex; index--) {
		const message = messages[index];
		if (message?.role === "assistant") {
			return message;
		}
	}
	return undefined;
}

function statusFromAssistant(assistant: AssistantMessage | undefined): SubAgentResult["status"] {
	if (assistant?.stopReason === "error") {
		return "failed";
	}
	if (assistant?.stopReason === "aborted") {
		return "aborted";
	}
	return "completed";
}

function extractAssistantText(message: AssistantMessage): string {
	return message.content
		.filter(isTextContent)
		.map((content) => content.text)
		.join("\n");
}

function isTextContent(content: AssistantMessage["content"][number]): content is TextContent {
	return content.type === "text";
}
