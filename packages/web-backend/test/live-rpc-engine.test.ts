import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentsResponse, MessagesResponse, SseEnvelope } from "../src/contract.ts";
import { type LiveRpcClientLike, LiveRpcEngine } from "../src/engines/live-rpc-engine.ts";
import { SseBus } from "../src/events/sse-bus.ts";
import { createWebBackendApp } from "../src/server.ts";
import { SessionStore } from "../src/session-store.ts";

describe("LiveRpcEngine", () => {
	afterEach(() => {
		delete process.env.PI_WEB_BACKEND_DEFAULT_PROVIDER;
		delete process.env.PI_WEB_BACKEND_DEFAULT_MODEL;
		delete process.env.PI_WEB_BACKEND_RUN_SUBAGENT;
		delete process.env.PI_WEB_BACKEND_AGENT_CWD;
	});

	it("uses live defaults for provider, model, and run_subagent", async () => {
		let clientOptions: unknown = null;
		const store = new SessionStore();
		const sseBus = new SseBus();
		const engine = new LiveRpcEngine(store, sseBus, {
			createClient: (options) => {
				clientOptions = options;
				return new FakeLiveRpcClient();
			},
		});

		await engine.start({ mode: "live" });

		expect(clientOptions).toMatchObject({
			cliPath: expect.stringContaining("packages/coding-agent/dist/cli.js"),
			provider: "deepseek",
			model: "deepseek-v4-flash",
			env: { PI_MULTI_AGENT_RUN_SUBAGENT: "1" },
		});
	});

	it("uses the nearest project root with .pi agents as the default live cwd", async () => {
		const projectRoot = mkdtempSync(join(tmpdir(), "pi-web-backend-project-"));
		const backendCwd = join(projectRoot, "packages", "web-backend");
		mkdirSync(join(projectRoot, ".pi", "agents"), { recursive: true });
		mkdirSync(backendCwd, { recursive: true });
		const previousCwd = process.cwd();
		let clientOptions: unknown = null;
		try {
			process.chdir(backendCwd);
			const store = new SessionStore();
			const sseBus = new SseBus();
			const engine = new LiveRpcEngine(store, sseBus, {
				createClient: (options) => {
					clientOptions = options;
					return new FakeLiveRpcClient();
				},
			});

			await engine.start({ mode: "live" });

			expect(clientOptions).toMatchObject({ cwd: realpathSync(projectRoot) });
			expect(store.getSnapshot().session.cwd).toBe(realpathSync(projectRoot));
		} finally {
			process.chdir(previousCwd);
		}
	});

	it("allows environment overrides for live defaults", async () => {
		process.env.PI_WEB_BACKEND_DEFAULT_PROVIDER = "openai";
		process.env.PI_WEB_BACKEND_DEFAULT_MODEL = "gpt-5";
		process.env.PI_WEB_BACKEND_RUN_SUBAGENT = "0";
		let clientOptions: unknown = null;
		const store = new SessionStore();
		const sseBus = new SseBus();
		const engine = new LiveRpcEngine(store, sseBus, {
			createClient: (options) => {
				clientOptions = options;
				return new FakeLiveRpcClient();
			},
		});

		await engine.start({ mode: "live" });

		expect(clientOptions).toMatchObject({
			provider: "openai",
			model: "gpt-5",
			env: {},
		});
	});

	it("reduces run_subagent progress into agent cards and SSE events", async () => {
		const fakeClient = new FakeLiveRpcClient();
		const store = new SessionStore();
		const sseBus = new SseBus();
		const envelopes: SseEnvelope[] = [];
		const unsubscribeSse = sseBus.addClient({ write: (event) => envelopes.push(event), close: () => undefined });
		const { app } = createWebBackendApp({
			store,
			sseBus,
			createLiveEngine: (dependencies) =>
				new LiveRpcEngine(dependencies.store, dependencies.sseBus, { createClient: () => fakeClient }),
		});

		try {
			await app.request("/api/session/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "live" }),
			});
			await app.request("/api/prompt", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "run workers" }),
			});

			fakeClient.emit({
				type: "tool_execution_update",
				toolCallId: "run-1",
				toolName: "run_subagent",
				args: { agentId: "pm-agent-v2", invocationId: "pm-1" },
				partialResult: {
					details: {
						progress: {
							currentPhase: "running",
							activeTool: { toolName: "shared_state_write", toolCallId: "write-1" },
							completedTools: [],
							eventCount: 2,
							recentEvents: [
								{ type: "agent_start", timestamp: 1779964874672 },
								{
									type: "tool_execution_start",
									toolName: "shared_state_write",
									toolCallId: "write-1",
									timestamp: 1779964875000,
									argsSummary: "path=prd/pm.md",
								},
							],
						},
					},
				},
			});
			fakeClient.emit({
				type: "tool_execution_end",
				toolCallId: "run-1",
				toolName: "run_subagent",
				isError: false,
				result: {
					details: {
						sharedStateRoot: "/tmp/shared-state",
						result: {
							agentId: "pm-agent-v2",
							sessionId: "sub-session-1",
							status: "completed",
							finalText: "PM done",
						},
						progress: {
							currentPhase: "completed",
							completedTools: [{ toolName: "shared_state_write", toolCallId: "write-1" }],
							lastAssistantPreview: "PM done",
							eventCount: 3,
							recentEvents: [{ type: "agent_end", timestamp: 1779964876000 }],
						},
					},
				},
			});

			const agentsResponse = await app.request("/api/agents");
			const agents = ((await agentsResponse.json()) as AgentsResponse).agents;

			expect(agents).toHaveLength(1);
			expect(agents[0]).toMatchObject({
				agentId: "pm-agent-v2",
				phase: "completed",
				lastRunStatus: "completed",
				sessionId: "sub-session-1",
				sharedStateRoot: "/tmp/shared-state",
				lastAssistantPreview: "PM done",
			});
			expect(envelopes.some((event) => event.eventType === "agent.updated")).toBe(true);
			expect(envelopes.some((event) => event.eventType === "shared_state.changed")).toBe(true);
			expect(envelopes.find((event) => event.eventType === "shared_state.changed")?.payload).toEqual({
				paths: [],
				reason: "run_subagent_completed",
			});
		} finally {
			unsubscribeSse();
		}
	});

	it("emits path-level shared-state changes for direct write and edit tools", async () => {
		const fakeClient = new FakeLiveRpcClient();
		const store = new SessionStore();
		const sseBus = new SseBus();
		const envelopes: SseEnvelope[] = [];
		const unsubscribeSse = sseBus.addClient({ write: (event) => envelopes.push(event), close: () => undefined });
		const { app } = createWebBackendApp({
			store,
			sseBus,
			createLiveEngine: (dependencies) =>
				new LiveRpcEngine(dependencies.store, dependencies.sseBus, { createClient: () => fakeClient }),
		});

		try {
			await app.request("/api/session/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "live" }),
			});
			fakeClient.emit({
				type: "tool_execution_start",
				toolCallId: "write-1",
				toolName: "shared_state_write",
				args: { path: "prd/pm.md" },
			});
			fakeClient.emit({
				type: "tool_execution_end",
				toolCallId: "write-1",
				toolName: "shared_state_write",
				isError: false,
				result: { content: [{ type: "text", text: "Successfully wrote prd/pm.md" }] },
			});
			fakeClient.emit({
				type: "tool_execution_start",
				toolCallId: "edit-1",
				toolName: "shared_state_edit",
				args: { path: "analysis/engineering.md" },
			});
			fakeClient.emit({
				type: "tool_execution_end",
				toolCallId: "edit-1",
				toolName: "shared_state_edit",
				isError: false,
				result: { content: [{ type: "text", text: "Successfully edited analysis/engineering.md" }] },
			});

			const changes = envelopes
				.filter((event) => event.eventType === "shared_state.changed")
				.map((event) => event.payload);

			expect(changes).toEqual([
				{ paths: ["prd/pm.md"], reason: "shared_state_write" },
				{ paths: ["analysis/engineering.md"], reason: "shared_state_edit" },
			]);
		} finally {
			unsubscribeSse();
		}
	});

	it("exposes run_subagent tool results as structured timeline messages", async () => {
		const fakeClient = new FakeLiveRpcClient();
		const { app } = createWebBackendApp({
			createLiveEngine: (dependencies) =>
				new LiveRpcEngine(dependencies.store, dependencies.sseBus, { createClient: () => fakeClient }),
		});

		fakeClient.messages = [
			{
				role: "toolResult",
				toolCallId: "run-1",
				toolName: "run_subagent",
				content: [
					{
						type: "text",
						text: "status: completed\nagentId: pm-agent-v2\n\nPM done",
					},
				],
				details: {
					result: {
						agentId: "pm-agent-v2",
					},
				},
				isError: false,
				timestamp: 1779964876000,
			} as AgentMessage,
		];

		await app.request("/api/session/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "live" }),
		});

		const response = await app.request("/api/messages");
		const messages = ((await response.json()) as MessagesResponse).messages;

		expect(messages[0]).toMatchObject({
			agentId: "pm-agent-v2",
			source: "agent",
			kind: "tool_event",
			rawType: "run_subagent",
			toolName: "run_subagent",
			toolCallId: "run-1",
		});
		expect(messages[0]?.content).toContain("toolName: run_subagent");
	});

	it("does not expose assistant thinking as timeline message content", async () => {
		const fakeClient = new FakeLiveRpcClient();
		const { app } = createWebBackendApp({
			createLiveEngine: (dependencies) =>
				new LiveRpcEngine(dependencies.store, dependencies.sseBus, { createClient: () => fakeClient }),
		});

		fakeClient.messages = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "hidden reasoning" },
					{ type: "text", text: "visible answer" },
				],
				timestamp: 1779964876000,
				responseId: "assistant-with-thinking",
			} as AgentMessage,
		];

		await app.request("/api/session/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "live" }),
		});

		const response = await app.request("/api/messages");
		const messages = ((await response.json()) as MessagesResponse).messages;

		expect(messages[0]?.content).toBe("visible answer");
	});

	it("maps agent_end assistant stop reasons into turn status", async () => {
		const failed = await runAgentEndStatusCase("error");
		const aborted = await runAgentEndStatusCase("aborted");
		const completed = await runAgentEndStatusCase("stop");

		expect(failed).toBe("failed");
		expect(aborted).toBe("aborted");
		expect(completed).toBe("completed");
	});
});

async function runAgentEndStatusCase(stopReason: string): Promise<string> {
	const fakeClient = new FakeLiveRpcClient();
	const { app } = createWebBackendApp({
		createLiveEngine: (dependencies) =>
			new LiveRpcEngine(dependencies.store, dependencies.sseBus, { createClient: () => fakeClient }),
	});
	await app.request("/api/session/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ mode: "live" }),
	});
	await app.request("/api/prompt", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: "run" }),
	});
	fakeClient.emit({
		type: "agent_end",
		messages: [
			{
				role: "assistant",
				content: [],
				stopReason,
				timestamp: Date.now(),
			} as unknown as AgentMessage,
		],
	});
	const response = await app.request("/api/state");
	const snapshot = (await response.json()) as { turn: { status: string } };
	return snapshot.turn.status;
}

class FakeLiveRpcClient implements LiveRpcClientLike {
	private listeners: Array<(event: AgentEvent) => void> = [];
	messages: AgentMessage[] = [];

	async start(): Promise<void> {
		return undefined;
	}

	async stop(): Promise<void> {
		return undefined;
	}

	async prompt(_message: string): Promise<void> {
		return undefined;
	}

	async abort(): Promise<void> {
		return undefined;
	}

	async getState(): Promise<{
		sessionId: string;
		isStreaming: boolean;
		isCompacting: boolean;
		messageCount: number;
		pendingMessageCount: number;
	}> {
		return {
			sessionId: "live-session-1",
			isStreaming: false,
			isCompacting: false,
			messageCount: 0,
			pendingMessageCount: 0,
		};
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.messages;
	}

	onEvent(listener: (event: AgentEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((candidate) => candidate !== listener);
		};
	}

	emit(event: AgentEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}
