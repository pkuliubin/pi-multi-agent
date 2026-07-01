import { describe, expect, it } from "vitest";
import type {
	AbortRequest,
	AbortResponse,
	AgentCard,
	AgentHistoryResponse,
	AgentsResponse,
	MessagesResponse,
	PromptRequest,
	PromptResponse,
	ReplayResetRequest,
	ReplaySpeedRequest,
	RoleSessionsResponse,
	SessionSnapshot,
	SharedStateArtifactResponse,
	SharedStateManifestResponse,
	StartSessionRequest,
	StopSessionRequest,
	TimelineMessage,
} from "../src/contract.ts";
import type { BackendEngine } from "../src/engines/engine.ts";
import { createWebBackendApp } from "../src/server.ts";
import { createEmptySessionSnapshot } from "../src/session-store.ts";

const MOCK_AGENT: AgentCard = {
	agentId: "mock-agent",
	displayName: "Mock Agent",
	role: "mock",
	avatar: null,
	phase: "running",
	activeTool: {
		toolCallId: "tool-1",
		name: "mock_tool",
		status: "running",
		argsSummary: "input=hello",
		resultSummary: null,
		startedAt: "2026-05-28T00:00:01.000Z",
		endedAt: null,
	},
	completedTools: [],
	lastAssistantPreview: "Working on mock task",
	eventCount: 1,
	recentEvents: [{ id: "event-1", type: "mock", summary: "mock progress", createdAt: "2026-05-28T00:00:01.000Z" }],
	sessionId: "mock-sub-session",
	lastRunStatus: "running",
	sharedStateRoot: "/tmp/mock-shared-state",
	updatedAt: "2026-05-28T00:00:01.000Z",
};

const MOCK_MESSAGE: TimelineMessage = {
	id: "message-1",
	source: "main",
	agentId: null,
	role: "assistant",
	kind: "message",
	content: "Mock response",
	status: "completed",
	createdAt: "2026-05-28T00:00:02.000Z",
	updatedAt: "2026-05-28T00:00:02.000Z",
	rawType: "mock",
	toolName: null,
	toolCallId: null,
};

describe("web-backend mock API contract", () => {
	it("returns documented empty shapes before session start", async () => {
		const { app } = createWebBackendApp();

		const state = await json<SessionSnapshot>(await app.request("/api/state"));
		const messages = await json<MessagesResponse>(await app.request("/api/messages"));
		const agents = await json<AgentsResponse>(await app.request("/api/agents"));
		const manifest = await json<SharedStateManifestResponse>(await app.request("/api/shared-state/manifest"));

		expect(state.session.started).toBe(false);
		expect(state.backendMode).toBeNull();
		expect(messages).toEqual({ messages: [] });
		expect(agents).toEqual({ agents: [] });
		expect(manifest).toEqual({ root: null, artifacts: [] });
	});

	it("allows local web-ui origins for browser API requests", async () => {
		const { app } = createWebBackendApp();

		const response = await app.request("/api/state", {
			headers: { origin: "http://localhost:5173" },
		});
		const preflight = await app.request("/api/state", {
			method: "OPTIONS",
			headers: {
				origin: "http://localhost:5173",
				"access-control-request-method": "GET",
				"access-control-request-headers": "content-type",
			},
		});

		expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
		expect(preflight.status).toBe(204);
		expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
		expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
		expect(preflight.headers.get("access-control-allow-headers")).toBe("content-type");
	});

	it("does not allow arbitrary browser origins", async () => {
		const { app } = createWebBackendApp();

		const response = await app.request("/api/state", {
			headers: { origin: "https://example.com" },
		});

		expect(response.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("returns SESSION_NOT_STARTED for prompt before start", async () => {
		const { app } = createWebBackendApp();

		const response = await app.request("/api/prompt", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "hello" }),
		});
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ error: { code: "SESSION_NOT_STARTED" } });
	});

	it("routes live mode through a mock engine with stable response shapes", async () => {
		const engine = new MockEngine("live");
		const { app } = createWebBackendApp({ createLiveEngine: () => engine });

		const started = await json<SessionSnapshot>(
			await app.request("/api/session/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "live", cwd: "/tmp/mock" }),
			}),
		);
		expect(started.backendMode).toBe("live");
		expect(started.session.started).toBe(true);

		const prompt = await json<PromptResponse>(
			await app.request("/api/prompt", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ text: "build a dashboard" }),
			}),
		);
		expect(prompt).toEqual({ accepted: true, mode: "live", turnId: "mock-turn", message: null });

		const messages = await json<MessagesResponse>(await app.request("/api/messages"));
		const agents = await json<AgentsResponse>(await app.request("/api/agents"));
		const history = await json<AgentHistoryResponse>(await app.request("/api/agents/mock-agent/history"));
		const roleSessions = await json<RoleSessionsResponse>(await app.request("/api/role-sessions"));
		const manifest = await json<SharedStateManifestResponse>(await app.request("/api/shared-state/manifest"));
		const artifact = await json<SharedStateArtifactResponse>(
			await app.request("/api/shared-state/artifact?path=summary/final.md"),
		);

		expect(messages.messages).toEqual([MOCK_MESSAGE]);
		expect(agents.agents).toEqual([MOCK_AGENT]);
		expect(history.items[0]).toMatchObject({ type: "message", content: "Full mock agent message" });
		expect(roleSessions.roleSessions).toHaveLength(1);
		expect(manifest.artifacts[0]?.path).toBe("summary/final.md");
		expect(artifact.content).toMatchObject({ kind: "text", text: "Mock artifact" });

		const abort = await json<AbortResponse>(
			await app.request("/api/abort", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(abort.accepted).toBe(true);

		const stopped = await json<SessionSnapshot>(
			await app.request("/api/session/stop", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(stopped.session.started).toBe(false);
	});

	it("routes replay controls through a mock replay engine", async () => {
		const engine = new MockEngine("replay");
		const { app } = createWebBackendApp({ createReplayEngine: () => engine });

		await app.request("/api/session/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "replay", replay: { autoStart: false } }),
		});

		const reset = await json<SessionSnapshot>(
			await app.request("/api/replay/reset", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ autoStart: true }),
			}),
		);
		const speed = await json<SessionSnapshot>(
			await app.request("/api/replay/speed", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ speed: 4 }),
			}),
		);

		expect(reset.replay?.cursor).toBe(0);
		expect(speed.replay?.speed).toBe(4);
	});

	it("rejects replay controls outside replay mode", async () => {
		const engine = new MockEngine("live");
		const { app } = createWebBackendApp({ createLiveEngine: () => engine });

		await app.request("/api/session/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "live" }),
		});
		const response = await app.request("/api/replay/reset", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body).toMatchObject({ error: { code: "INVALID_MODE" } });
	});
});

class MockEngine implements BackendEngine {
	private readonly mode: "live" | "replay";
	private snapshot: SessionSnapshot;

	constructor(mode: "live" | "replay") {
		this.mode = mode;
		this.snapshot = createEmptySessionSnapshot();
	}

	async start(request: StartSessionRequest): Promise<SessionSnapshot> {
		this.snapshot = {
			...createEmptySessionSnapshot(),
			backendMode: request.mode,
			session: {
				started: true,
				sessionId: "mock-session",
				cwd: request.cwd ?? null,
				pid: 123,
				startedAt: "2026-05-28T00:00:00.000Z",
				stoppedAt: null,
			},
			replay:
				request.mode === "replay"
					? {
							loaded: true,
							running: request.replay?.autoStart !== false,
							ended: false,
							logPath: "mock.jsonl",
							speed: request.replay?.speed ?? 1,
							cursor: 0,
							totalEvents: 2,
						}
					: null,
		};
		return this.snapshot;
	}

	async stop(_request: StopSessionRequest): Promise<SessionSnapshot> {
		this.snapshot = {
			...this.snapshot,
			session: { ...this.snapshot.session, started: false, stoppedAt: "2026-05-28T00:00:03.000Z" },
		};
		return this.snapshot;
	}

	async prompt(_request: PromptRequest): Promise<PromptResponse> {
		this.snapshot = {
			...this.snapshot,
			turn: {
				turnId: "mock-turn",
				status: "running",
				startedAt: "2026-05-28T00:00:01.000Z",
				updatedAt: "2026-05-28T00:00:01.000Z",
			},
		};
		return { accepted: true, mode: this.mode, turnId: "mock-turn", message: null };
	}

	async abort(_request: AbortRequest): Promise<AbortResponse> {
		return { accepted: true, mode: this.mode, turnId: this.snapshot.turn.turnId, message: null };
	}

	getState(): SessionSnapshot {
		return this.snapshot;
	}

	getMessages(): MessagesResponse {
		return { messages: [MOCK_MESSAGE] };
	}

	getAgents(): AgentsResponse {
		return { agents: [MOCK_AGENT] };
	}

	getAgentHistory(agentId: string): AgentHistoryResponse {
		return {
			agentId,
			items: [
				{
					id: "history-message-1",
					agentId,
					turnId: "mock-turn",
					invocationId: null,
					type: "message",
					role: "assistant",
					content: "Full mock agent message",
					createdAt: "2026-05-28T00:00:02.000Z",
				},
			],
		};
	}

	async getRoleSessions(): Promise<RoleSessionsResponse> {
		return {
			roleSessions: [
				{
					role: "mock",
					agentId: "mock-agent",
					displayName: "Mock Agent",
					sessionId: "mock-sub-session",
					status: "running",
					currentRunId: "mock-run",
					sharedStateRoot: "/tmp/mock-shared-state",
					createdAt: "2026-05-28T00:00:00.000Z",
					updatedAt: "2026-05-28T00:00:01.000Z",
				},
			],
		};
	}

	async getSharedStateManifest(): Promise<SharedStateManifestResponse> {
		return {
			root: "/tmp/mock-shared-state",
			artifacts: [
				{
					path: "summary/final.md",
					space: "summary",
					ownerAgentId: "mock-agent",
					version: 1,
					createdBy: "mock-agent",
					updatedBy: "mock-agent",
					createdAt: "2026-05-28T00:00:00.000Z",
					updatedAt: "2026-05-28T00:00:01.000Z",
					sizeBytes: 13,
					mimeType: "text/markdown",
					metadata: {},
				},
			],
		};
	}

	async getSharedStateArtifact(path: string): Promise<SharedStateArtifactResponse> {
		return {
			path,
			artifact: (await this.getSharedStateManifest()).artifacts[0] ?? null,
			content: { kind: "text", text: "Mock artifact", sizeBytes: 13, mimeType: "text/markdown", truncated: false },
		};
	}

	async resetReplay(_request: ReplayResetRequest): Promise<SessionSnapshot> {
		this.snapshot = {
			...this.snapshot,
			replay: this.snapshot.replay ? { ...this.snapshot.replay, cursor: 0, running: true, ended: false } : null,
		};
		return this.snapshot;
	}

	async setReplaySpeed(request: ReplaySpeedRequest): Promise<SessionSnapshot> {
		this.snapshot = {
			...this.snapshot,
			replay: this.snapshot.replay ? { ...this.snapshot.replay, speed: request.speed } : null,
		};
		return this.snapshot;
	}
}

async function json<T>(response: Response): Promise<T> {
	expect(response.status).toBeGreaterThanOrEqual(200);
	expect(response.status).toBeLessThan(300);
	return (await response.json()) as T;
}
