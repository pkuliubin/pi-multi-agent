import { describe, expect, it } from "vitest";
import type { AgentSessionFactory, CreateSubAgentSessionInput } from "../src/index.ts";
import { RunSubAgentRunner, SubAgentRegistry } from "../src/index.ts";
import { createAssistantMessage, MockAgentSession } from "./test-utils.ts";

class MockSessionFactory implements AgentSessionFactory {
	created: CreateSubAgentSessionInput[] = [];
	sessions: MockAgentSession[] = [];
	createHandler?: (input: CreateSubAgentSessionInput, session: MockAgentSession) => void;

	async create(input: CreateSubAgentSessionInput): Promise<MockAgentSession> {
		this.created.push(input);
		const session = new MockAgentSession();
		session.sessionId = `session-${this.created.length}`;
		this.createHandler?.(input, session);
		this.sessions.push(session);
		return session;
	}
}

function registryWith(...definitions: Parameters<SubAgentRegistry["register"]>[0][]): SubAgentRegistry {
	const registry = new SubAgentRegistry();
	for (const definition of definitions) registry.register(definition);
	return registry;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

describe("RunSubAgentRunner", () => {
	it("returns failed result when agentId is not registered", async () => {
		const runner = new RunSubAgentRunner({
			registry: new SubAgentRegistry(),
			sessionFactory: new MockSessionFactory(),
			cwd: "/tmp",
		});

		const result = await runner.run({ agentId: "missing", task: "hello" });

		expect(result).toMatchObject({
			agentId: "missing",
			status: "failed",
			errorMessage: "SubAgent definition not found: missing",
		});
	});

	it("rejects persistent definitions", async () => {
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "persistent" }),
			sessionFactory: new MockSessionFactory(),
			cwd: "/tmp",
		});

		const result = await runner.run({ agentId: "worker", task: "hello" });

		expect(result.status).toBe("failed");
		expect(result.errorMessage).toContain("persistent");
	});

	it("creates a new session for every ephemeral invocation", async () => {
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => {
				session.state.messages = [...session.state.messages, createAssistantMessage(session.sessionId)];
			};
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "ephemeral" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});

		const first = await runner.run({ agentId: "worker", task: "one" });
		const second = await runner.run({ agentId: "worker", task: "two" });

		expect(first.sessionId).toBe("session-1");
		expect(second.sessionId).toBe("session-2");
		expect(factory.sessions.map((session) => session.disposeCalls)).toEqual([1, 1]);
	});

	it("reuses session policy instances across invocations", async () => {
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = (text) => {
				session.state.messages = [...session.state.messages, createAssistantMessage(text)];
			};
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});

		const first = await runner.run({ agentId: "worker", task: "one" });
		const second = await runner.run({ agentId: "worker", task: "two" });

		expect(first.sessionId).toBe("session-1");
		expect(second.sessionId).toBe("session-1");
		expect(factory.created).toHaveLength(1);
		expect(second.messageCountBefore).toBeGreaterThan(first.messageCountBefore);
	});

	it("rejects concurrent calls to the same session instance", async () => {
		const deferred = createDeferred();
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => deferred.promise;
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});

		const first = runner.run({ agentId: "worker", task: "one" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = await runner.run({ agentId: "worker", task: "two" });
		deferred.resolve();
		await first;

		expect(second.status).toBe("failed");
		expect(second.errorMessage).toContain("already running");
	});

	it("does not create duplicate session instances for concurrent session invocations", async () => {
		const deferred = createDeferred();
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => deferred.promise;
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});

		const first = runner.run({ agentId: "worker", task: "one" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = await runner.run({ agentId: "worker", task: "two" });
		deferred.resolve();
		await first;

		expect(factory.created).toHaveLength(1);
		expect(second.status).toBe("failed");
		expect(second.errorMessage).toContain("already running");
	});

	it("rejects when maxConcurrentSubAgents is exceeded", async () => {
		const deferred = createDeferred();
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => deferred.promise;
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "ephemeral" }),
			sessionFactory: factory,
			cwd: "/tmp",
			maxConcurrentSubAgents: 1,
		});

		const first = runner.run({ agentId: "worker", task: "one" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = await runner.run({ agentId: "worker", task: "two" });
		deferred.resolve();
		await first;

		expect(second.status).toBe("failed");
		expect(second.errorMessage).toContain("Too many active");
	});

	it("aborts on timeout", async () => {
		const deferred = createDeferred();
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => deferred.promise;
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});

		const result = await runner.run({ agentId: "worker", task: "slow", timeoutMs: 1 });
		deferred.resolve();

		expect(result.status).toBe("aborted");
		expect(result.errorMessage).toContain("timed out");
		expect(factory.sessions[0]?.abortCalls).toBe(1);
		expect(result.startedAt).toBeLessThanOrEqual(result.endedAt);
		expect(result.messageCountBefore).toBe(0);
	});

	it("passes per-invocation model options to new ephemeral sessions", async () => {
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => {
				session.state.messages = [...session.state.messages, createAssistantMessage(session.sessionId)];
			};
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "ephemeral" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});

		await runner.run({ agentId: "worker", task: "one", model: { id: "model-a" }, thinkingLevel: "off" });
		await runner.run({ agentId: "worker", task: "two", model: { id: "model-b" }, thinkingLevel: "high" });

		expect(factory.created.map((input) => input.model)).toEqual([{ id: "model-a" }, { id: "model-b" }]);
		expect(factory.created.map((input) => input.thinkingLevel)).toEqual(["off", "high"]);
	});

	it("recreates session policy instances when model options change", async () => {
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => {
				session.state.messages = [...session.state.messages, createAssistantMessage(session.sessionId)];
			};
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});

		const first = await runner.run({ agentId: "worker", task: "one", model: { provider: "p", id: "model-a" } });
		const second = await runner.run({ agentId: "worker", task: "two", model: { provider: "p", id: "model-b" } });

		expect(first.sessionId).toBe("session-1");
		expect(second.sessionId).toBe("session-2");
		expect(factory.created).toHaveLength(2);
		expect(factory.sessions[0]?.disposeCalls).toBe(1);
	});

	it("passes Shared State access surface tools through capabilities", async () => {
		const factory = new MockSessionFactory();
		const tool = { name: "shared_state.list" };
		const runner = new RunSubAgentRunner({
			registry: registryWith({
				id: "worker",
				statePolicy: "session",
				accessSurfaces: [{ type: "shared_state", grants: [{ space: "prd", permissions: ["list"] }] }],
			}),
			sessionFactory: factory,
			cwd: "/tmp",
			createAccessSurfaceTools: () => [tool],
		});

		await runner.run({ agentId: "worker", task: "hello" });

		expect(factory.created[0]?.capabilities?.tools).toEqual([tool]);
	});
});
