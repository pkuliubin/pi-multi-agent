import { describe, expect, it } from "vitest";
import { PiSubAgentInstance } from "../src/index.ts";
import { createAssistantMessage, createUserMessage, MockAgentSession } from "./test-utils.ts";

function createSubAgent(session = new MockAgentSession()): PiSubAgentInstance {
	return new PiSubAgentInstance({ id: "worker", statePolicy: "session" }, session);
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("PiSubAgentInstance", () => {
	it("forwards prompt and restores phase after completion", async () => {
		const session = new MockAgentSession();
		const subAgent = createSubAgent(session);
		const deferred = createDeferred();
		session.promptHandler = async () => {
			expect(subAgent.phase).toBe("running");
			await deferred.promise;
		};

		const promptPromise = subAgent.prompt("hello");
		expect(subAgent.phase).toBe("running");
		deferred.resolve();
		await promptPromise;

		expect(session.promptCalls).toHaveLength(1);
		expect(session.promptCalls[0]?.text).toBe("hello");
		expect(subAgent.phase).toBe("idle");
	});

	it("invokes a task and returns final assistant text", async () => {
		const session = new MockAgentSession();
		const subAgent = createSubAgent(session);
		session.promptHandler = (text) => {
			session.state.messages = [createUserMessage(text), createAssistantMessage("done")];
		};

		const result = await subAgent.invoke("task");

		expect(session.promptCalls[0]?.text).toBe("task");
		expect(result).toMatchObject({
			agentId: "worker",
			sessionId: "session-1",
			status: "completed",
			finalText: "done",
			messageCountBefore: 0,
			messageCountAfter: 2,
		});
		expect(result.startedAt).toBeLessThanOrEqual(result.endedAt);
	});

	it("extracts final text only from newly added assistant messages", async () => {
		const session = new MockAgentSession();
		session.state.messages = [createAssistantMessage("old")];
		const subAgent = createSubAgent(session);
		session.promptHandler = () => {
			session.state.messages = [
				...session.state.messages,
				createUserMessage("task"),
				createAssistantMessage("first new"),
				createAssistantMessage("last new"),
			];
		};

		const result = await subAgent.invoke({ input: "task", invocationId: "invoke-1" });

		expect(result.invocationId).toBe("invoke-1");
		expect(result.finalText).toBe("last new");
		expect(result.messageCountBefore).toBe(1);
		expect(result.messageCountAfter).toBe(4);
	});

	it("joins text blocks from the final assistant message", async () => {
		const session = new MockAgentSession();
		const subAgent = createSubAgent(session);
		session.promptHandler = () => {
			const message = createAssistantMessage("first");
			message.content = [
				{ type: "text", text: "first" },
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "second" },
			];
			session.state.messages = [message];
		};

		const result = await subAgent.invoke("task");

		expect(result.finalText).toBe("first\nsecond");
	});

	it("returns failed result when final assistant has error stop reason", async () => {
		const session = new MockAgentSession();
		const subAgent = createSubAgent(session);
		session.promptHandler = () => {
			session.state.messages = [
				createAssistantMessage("", { stopReason: "error", errorMessage: "provider failed" }),
			];
		};

		const result = await subAgent.invoke("task");

		expect(result.status).toBe("failed");
		expect(result.errorMessage).toBe("provider failed");
	});

	it("returns aborted result when final assistant has aborted stop reason", async () => {
		const session = new MockAgentSession();
		const subAgent = createSubAgent(session);
		session.promptHandler = () => {
			session.state.messages = [createAssistantMessage("", { stopReason: "aborted", errorMessage: "aborted" })];
		};

		const result = await subAgent.invoke("task");

		expect(result.status).toBe("aborted");
		expect(result.errorMessage).toBe("aborted");
	});

	it("returns failed result and restores phase when prompt throws", async () => {
		const session = new MockAgentSession();
		const subAgent = createSubAgent(session);
		session.promptHandler = () => {
			throw new Error("boom");
		};

		const result = await subAgent.invoke("task");

		expect(result.status).toBe("failed");
		expect(result.errorMessage).toBe("boom");
		expect(result.finalText).toBe("");
		expect(subAgent.phase).toBe("idle");
	});

	it("rejects concurrent loop-starting calls", async () => {
		const session = new MockAgentSession();
		const subAgent = createSubAgent(session);
		const deferred = createDeferred();
		session.promptHandler = () => deferred.promise;

		const promptPromise = subAgent.prompt("first");
		await expect(subAgent.prompt("second")).rejects.toThrow("already running");
		deferred.resolve();
		await promptPromise;
	});

	it("forwards abort and restores idle phase", async () => {
		const session = new MockAgentSession();
		const subAgent = createSubAgent(session);
		const deferred = createDeferred();
		session.promptHandler = () => deferred.promise;

		const promptPromise = subAgent.prompt("task");
		expect(subAgent.phase).toBe("running");
		await subAgent.abort();
		expect(session.abortCalls).toBe(1);
		expect(session.waitForIdleCalls).toBe(1);
		expect(subAgent.phase).toBe("idle");
		deferred.resolve();
		await promptPromise;
	});

	it("closes the session and rejects later loop-starting calls", async () => {
		const session = new MockAgentSession();
		const subAgent = createSubAgent(session);

		await subAgent.close();

		expect(session.disposeCalls).toBe(1);
		expect(subAgent.phase).toBe("closed");
		await expect(subAgent.prompt("task")).rejects.toThrow("closed");
		await expect(subAgent.invoke("task")).rejects.toThrow("closed");
		await expect(subAgent.followUp("task")).rejects.toThrow("closed");
		await expect(subAgent.steer("task")).rejects.toThrow("closed");
	});

	it("returns the underlying unsubscribe from subscribe", () => {
		const session = new MockAgentSession();
		const subAgent = createSubAgent(session);
		const unsubscribe = subAgent.subscribe(() => {});

		expect(session.listenerCount()).toBe(1);
		unsubscribe();
		expect(session.listenerCount()).toBe(0);
	});

	it("inspects session and runtime state", () => {
		const session = new MockAgentSession();
		session.state.messages = [createUserMessage("hello")];
		const subAgent = createSubAgent(session);

		expect(subAgent.inspect()).toMatchObject({
			agentId: "worker",
			phase: "idle",
			statePolicy: "session",
			sessionId: "session-1",
			sessionFile: "/tmp/session.jsonl",
			thinkingLevel: "off",
			messageCount: 1,
		});
		expect(subAgent.inspect().model).toBe(session.model);
	});
});
