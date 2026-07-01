import { describe, expect, it } from "vitest";
import type {
	AgentSessionFactory,
	AgentSessionLike,
	CreateSubAgentSessionInput,
	SubAgentLifecycleStore,
	SubAgentRoleSessionBinding,
} from "../src/index.ts";
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

class MockLifecycleStore implements SubAgentLifecycleStore {
	sessions = new Map<string, AgentSessionLike>();
	states: string[] = [];

	async getOrCreate(input: {
		definition: Parameters<SubAgentLifecycleStore["getOrCreate"]>[0]["definition"];
		roleSession: SubAgentRoleSessionBinding;
		create: () => Promise<AgentSessionLike>;
	}): Promise<AgentSessionLike> {
		const key = `${input.roleSession.mainSessionId}:${input.definition.id}:${input.roleSession.definitionIdentity.fingerprint}`;
		const existing = this.sessions.get(key);
		if (existing) return existing;
		const session = await input.create();
		this.sessions.set(key, session);
		return session;
	}

	markRunning(): void {
		this.states.push("running");
	}

	markIdle(): void {
		this.states.push("idle");
	}

	markClosed(): void {
		this.states.push("closed");
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
			errorCode: "SUB_AGENT_NOT_FOUND",
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
		expect(result.errorCode).toBe("SUB_AGENT_UNSUPPORTED_STATE_POLICY");
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
		expect(second.errorCode).toBe("SUB_AGENT_BUSY");
	});

	it("does not mark a busy persisted role idle before the active run finishes", async () => {
		const deferred = createDeferred();
		const lifecycleStore = new MockLifecycleStore();
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => deferred.promise;
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session", systemPrompt: "stable" }),
			sessionFactory: factory,
			cwd: "/tmp",
			mainSessionId: "main",
			lifecycleStore,
		});

		const first = runner.run({ agentId: "worker", task: "one" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		const second = await runner.run({ agentId: "worker", task: "two" });

		expect(second.errorCode).toBe("SUB_AGENT_BUSY");
		expect(lifecycleStore.states).toEqual(["running"]);

		deferred.resolve();
		await first;

		expect(lifecycleStore.states).toEqual(["running", "idle"]);
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
		expect(second.errorCode).toBe("SUB_AGENT_CONCURRENCY_LIMIT");
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

	it("restores session policy instances through a lifecycle store after runner restart", async () => {
		const lifecycleStore = new MockLifecycleStore();
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = (text) => {
				session.state.messages = [...session.state.messages, createAssistantMessage(text)];
			};
		};
		const definition = { id: "worker", statePolicy: "session" as const, systemPrompt: "stable" };
		const firstRunner = new RunSubAgentRunner({
			registry: registryWith(definition),
			sessionFactory: factory,
			cwd: "/tmp",
			mainSessionId: "main-1",
			definitionSource: "custom",
			lifecycleStore,
		});

		const first = await firstRunner.run({ agentId: "worker", task: "one" });
		const secondRunner = new RunSubAgentRunner({
			registry: registryWith(definition),
			sessionFactory: factory,
			cwd: "/tmp",
			mainSessionId: "main-1",
			definitionSource: "custom",
			lifecycleStore,
		});
		const second = await secondRunner.run({ agentId: "worker", task: "two" });

		expect(second.sessionId).toBe(first.sessionId);
		expect(factory.created).toHaveLength(1);
		expect(second.messageCountBefore).toBeGreaterThan(first.messageCountBefore);
		expect(lifecycleStore.states).toEqual(["running", "idle", "running", "idle"]);
	});

	it("marks persisted role sessions closed when runner instances are closed", async () => {
		const lifecycleStore = new MockLifecycleStore();
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = (text) => {
				session.state.messages = [...session.state.messages, createAssistantMessage(text)];
			};
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session", systemPrompt: "stable" }),
			sessionFactory: factory,
			cwd: "/tmp",
			mainSessionId: "main",
			lifecycleStore,
		});

		await runner.run({ agentId: "worker", task: "one" });
		await runner.close("worker");

		expect(lifecycleStore.states).toEqual(["running", "idle", "closed"]);
		expect(factory.sessions[0]?.disposeCalls).toBe(1);
	});

	it("marks all persisted role sessions closed when closing the runner", async () => {
		const lifecycleStore = new MockLifecycleStore();
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = (text) => {
				session.state.messages = [...session.state.messages, createAssistantMessage(text)];
			};
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith(
				{ id: "pm", statePolicy: "session", systemPrompt: "pm" },
				{ id: "eng", statePolicy: "session", systemPrompt: "eng" },
			),
			sessionFactory: factory,
			cwd: "/tmp",
			mainSessionId: "main",
			lifecycleStore,
		});

		await runner.run({ agentId: "pm", task: "one" });
		await runner.run({ agentId: "eng", task: "two" });
		await runner.close();

		expect(lifecycleStore.states).toEqual(["running", "idle", "running", "idle", "closed", "closed"]);
		expect(factory.sessions.map((session) => session.disposeCalls)).toEqual([1, 1]);
	});

	it("does not share lifecycle store sessions across main sessions", async () => {
		const lifecycleStore = new MockLifecycleStore();
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => {
				session.state.messages = [...session.state.messages, createAssistantMessage(session.sessionId)];
			};
		};
		const definition = { id: "worker", statePolicy: "session" as const, systemPrompt: "stable" };
		const firstRunner = new RunSubAgentRunner({
			registry: registryWith(definition),
			sessionFactory: factory,
			cwd: "/tmp",
			mainSessionId: "main-1",
			lifecycleStore,
		});
		const secondRunner = new RunSubAgentRunner({
			registry: registryWith(definition),
			sessionFactory: factory,
			cwd: "/tmp",
			mainSessionId: "main-2",
			lifecycleStore,
		});

		const first = await firstRunner.run({ agentId: "worker", task: "one" });
		const second = await secondRunner.run({ agentId: "worker", task: "two" });

		expect(first.sessionId).toBe("session-1");
		expect(second.sessionId).toBe("session-2");
		expect(factory.created).toHaveLength(2);
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

	it("forwards sub-agent events to observer envelopes", async () => {
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => {
				session.emit({ type: "agent_start" });
				session.emit({
					type: "tool_execution_start",
					toolName: "shared_state.read",
					toolCallId: "call-1",
					args: {},
				});
				session.emit({
					type: "tool_execution_end",
					toolName: "shared_state.read",
					toolCallId: "call-1",
					args: {},
					result: {},
					isError: false,
				});
				session.emit({ type: "message_end", message: createAssistantMessage("done") });
				session.emit({ type: "agent_end" });
				session.state.messages = [...session.state.messages, createAssistantMessage("done")];
			};
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});
		const events: Array<{ agentId: string; sessionId: string; invocationId?: string; type: string }> = [];

		await runner.run(
			{ agentId: "worker", task: "hello", invocationId: "inv-1" },
			{
				onEvent: (envelope) => {
					events.push({
						agentId: envelope.agentId,
						sessionId: envelope.sessionId,
						invocationId: envelope.invocationId,
						type: envelope.event.type,
					});
				},
			},
		);

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"tool_execution_start",
			"tool_execution_end",
			"message_end",
			"agent_end",
		]);
		expect(new Set(events.map((event) => event.agentId))).toEqual(new Set(["worker"]));
		expect(new Set(events.map((event) => event.sessionId))).toEqual(new Set(["session-1"]));
		expect(new Set(events.map((event) => event.invocationId))).toEqual(new Set(["inv-1"]));
	});

	it("isolates observer failures from final result", async () => {
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => {
				session.emit({ type: "agent_start" });
				session.state.messages = [...session.state.messages, createAssistantMessage("done")];
			};
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});

		const syncResult = await runner.run(
			{ agentId: "worker", task: "hello" },
			{
				onEvent: () => {
					throw new Error("observer failed");
				},
			},
		);
		expect(syncResult.status).toBe("completed");

		const asyncResult = await runner.run(
			{ agentId: "worker", task: "hello again" },
			{
				onEvent: async () => {
					throw new Error("observer async failed");
				},
			},
		);
		expect(asyncResult.status).toBe("completed");
	});

	it("does not emit internal events for a busy invocation", async () => {
		const deferred = createDeferred();
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			session.promptHandler = () => {
				session.emit({ type: "agent_start" });
				return deferred.promise;
			};
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});
		const firstEvents: string[] = [];
		const first = runner.run(
			{ agentId: "worker", task: "one" },
			{
				onEvent: (envelope) => {
					firstEvents.push(envelope.event.type);
				},
			},
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const busyEvents: string[] = [];
		const second = await runner.run(
			{ agentId: "worker", task: "two" },
			{
				onEvent: (envelope) => {
					busyEvents.push(envelope.event.type);
				},
			},
		);
		deferred.resolve();
		await first;

		expect(second.errorCode).toBe("SUB_AGENT_BUSY");
		expect(busyEvents).toEqual([]);
		expect(firstEvents).toContain("agent_start");
	});

	it("unsubscribes observer after invocation completes", async () => {
		let sessionRef: MockAgentSession | undefined;
		const factory = new MockSessionFactory();
		factory.createHandler = (_input, session) => {
			sessionRef = session;
			session.promptHandler = () => {
				session.emit({ type: "agent_start" });
				session.state.messages = [...session.state.messages, createAssistantMessage("done")];
			};
		};
		const runner = new RunSubAgentRunner({
			registry: registryWith({ id: "worker", statePolicy: "session" }),
			sessionFactory: factory,
			cwd: "/tmp",
		});
		const events: string[] = [];

		await runner.run(
			{ agentId: "worker", task: "hello" },
			{
				onEvent: (envelope) => {
					events.push(envelope.event.type);
				},
			},
		);
		expect(sessionRef?.listenerCount()).toBe(0);
		sessionRef?.emit({ type: "agent_start" });
		expect(events).toEqual(["agent_start"]);
	});
});
