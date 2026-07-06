import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentsResponse, MessagesResponse, SessionSnapshot, SseEnvelope, SseEventType } from "../src/contract.ts";
import { ReplayEngine } from "../src/engines/replay-engine.ts";
import { SseBus } from "../src/events/sse-bus.ts";
import { parseSseCaptureReplay } from "../src/replay/sse-capture-reader.ts";
import { createWebBackendApp } from "../src/server.ts";
import { SessionStore } from "../src/session-store.ts";

const STARTED_AT = "2026-07-02T00:00:00.000Z";
const SESSION_ID = "capture-session";
const TURN_ID = "capture-turn";

describe("SSE capture replay", () => {
	it("parses and validates the GUI replay fixture shape", () => {
		const replay = parseSseCaptureReplay(JSON.stringify(createReplayFile([messageCompletedEnvelope(1)])));

		expect(replay.kind).toBe("pi-web-backend-sse-replay");
		expect(replay.schemaVersion).toBe(1);
		expect(replay.events).toHaveLength(1);
		expect(replay.events[0]?.envelope.eventType).toBe("message.completed");
	});

	it("replays captured envelopes and drives snapshot APIs", async () => {
		const replayPath = await writeReplayFixture([
			messageCompletedEnvelope(1),
			messageDeltaEnvelope(2, "Hello "),
			messageDeltaEnvelope(3, "world"),
			agentUpdatedEnvelope(4),
			agentEventEnvelope(5),
			sharedStateChangedEnvelope(6),
		]);
		const { app, sseBus } = createWebBackendApp();
		const envelopes: SseEnvelope[] = [];
		const unsubscribe = sseBus.addClient({
			write: (event) => envelopes.push(event),
			close: () => undefined,
		});

		try {
			const start = await app.request("/api/session/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "replay", replay: { logPath: replayPath, autoStart: true, speed: 1000 } }),
			});
			expect(start.status).toBe(200);
			await waitFor(() => envelopes.some((event) => event.eventType === "replay.completed"), 2000);

			const state = (await (await app.request("/api/state")).json()) as SessionSnapshot;
			const messages = ((await (await app.request("/api/messages")).json()) as MessagesResponse).messages;
			const agents = ((await (await app.request("/api/agents")).json()) as AgentsResponse).agents;
			const history = await (await app.request("/api/agents/replay-agent/history")).json();

			expect(state.backendMode).toBe("replay");
			expect(state.replay).toMatchObject({
				loaded: true,
				ended: true,
				cursor: 6,
				totalEvents: 6,
				source: "sse_capture",
			});
			expect(messages.map((message) => [message.id, message.content, message.status])).toEqual([
				["user-message", "build a replay", "completed"],
				["assistant-message", "Hello world", "streaming"],
			]);
			expect(agents.map((agent) => agent.agentId)).toEqual(["replay-agent"]);
			expect(history).toMatchObject({ agentId: "replay-agent", items: [{ type: "status", status: "running" }] });
			expect(envelopes.map((event) => event.eventType)).toEqual([
				"replay.started",
				"message.completed",
				"message.delta",
				"message.delta",
				"agent.updated",
				"agent.event",
				"shared_state.changed",
				"replay.completed",
			]);
			expect(envelopes.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
			expect(envelopes.find((event) => event.eventId === "event-2")?.mode).toBe("replay");
			expect(envelopes.at(-1)?.payload).toMatchObject({ cursor: 6, totalEvents: 6, speed: 1000 });
		} finally {
			unsubscribe();
			await app.request("/api/session/stop", { method: "POST", body: "{}" });
		}
	});

	it("uses captured afterPreviousMs timing and updated speed for later events", async () => {
		const replayPath = await writeReplayFixture([
			messageDeltaEnvelope(1, "one"),
			messageDeltaEnvelope(2, "two"),
			messageDeltaEnvelope(3, "three"),
		]);
		const { app, sseBus } = createWebBackendApp();
		const receivedAt: number[] = [];
		const unsubscribe = sseBus.addClient({
			write: (event) => {
				if (event.eventType === "message.delta") receivedAt.push(Date.now());
			},
			close: () => undefined,
		});

		try {
			await app.request("/api/session/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ mode: "replay", replay: { logPath: replayPath, autoStart: false, speed: 1 } }),
			});
			void app.request("/api/replay/reset", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ autoStart: true }),
			});
			await waitFor(() => receivedAt.length === 1, 500);
			await app.request("/api/replay/speed", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ speed: 10 }),
			});
			await waitFor(() => receivedAt.length === 3, 1000);

			expect(receivedAt[1] - receivedAt[0]).toBeGreaterThanOrEqual(35);
			expect(receivedAt[2] - receivedAt[1]).toBeLessThan(35);
		} finally {
			unsubscribe();
			await app.request("/api/session/stop", { method: "POST", body: "{}" });
		}
	});

	it("yields between chunks when accelerated replay collapses event delays to zero", async () => {
		const envelopes = Array.from({ length: 1200 }, (_, index) => messageDeltaEnvelope(index + 1, "x"));
		const replayPath = await writeReplayFixture(envelopes);
		const store = new SessionStore();
		const sseBus = new SseBus();
		const engine = new ReplayEngine(store, sseBus, { maxEventsPerTick: 10 });
		let messageEvents = 0;
		const unsubscribe = sseBus.addClient({
			write: (event) => {
				if (event.eventType === "message.delta") messageEvents += 1;
			},
			close: () => undefined,
		});

		try {
			await engine.start({ mode: "replay", replay: { logPath: replayPath, autoStart: true, speed: 1000 } });
			await waitFor(() => messageEvents >= 10, 500);
			expect(messageEvents).toBeLessThan(1200);
			await waitFor(() => engine.getState().replay?.ended === true, 2000);
			expect(messageEvents).toBe(1200);
		} finally {
			unsubscribe();
			await engine.stop({});
		}
	});

	it("resets replay projection and respects autoStart false", async () => {
		const replayPath = await writeReplayFixture([messageDeltaEnvelope(1, "stale")]);
		const { app } = createWebBackendApp();

		await app.request("/api/session/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "replay", replay: { logPath: replayPath, autoStart: true, speed: 1000 } }),
		});
		await waitForState(app, (state) => state.replay?.ended === true, 2000);

		const reset = await app.request("/api/replay/reset", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ autoStart: false }),
		});
		expect(reset.status).toBe(200);
		const state = (await reset.json()) as SessionSnapshot;
		const messages = ((await (await app.request("/api/messages")).json()) as MessagesResponse).messages;

		expect(state.replay).toMatchObject({ cursor: 0, running: false, ended: false, source: "sse_capture" });
		expect(messages).toEqual([]);
	});

	it("returns replay-specific errors for missing and unsupported replay files", async () => {
		const { app } = createWebBackendApp();
		const missing = await app.request("/api/session/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "replay", replay: { logPath: "/tmp/does-not-exist-replay.json" } }),
		});
		const missingBody = await missing.json();
		expect(missing.status).toBe(404);
		expect(missingBody).toMatchObject({ error: { code: "REPLAY_FILE_NOT_FOUND" } });

		const invalidPath = await writeJsonFile({
			schemaVersion: 1,
			kind: "legacy-jsonl",
			runId: "bad",
			timing: {},
			prompt: "",
			events: [],
		});
		const unsupported = await app.request("/api/session/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode: "replay", replay: { logPath: invalidPath } }),
		});
		const unsupportedBody = await unsupported.json();
		expect(unsupported.status).toBe(400);
		expect(unsupportedBody).toMatchObject({ error: { code: "REPLAY_KIND_UNSUPPORTED" } });
	});
});

async function writeReplayFixture(envelopes: SseEnvelope[]): Promise<string> {
	return writeJsonFile(createReplayFile(envelopes));
}

async function writeJsonFile(value: unknown): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-sse-replay-"));
	const path = join(dir, "fixture-replay.json");
	await writeFile(path, JSON.stringify(value, null, 2));
	return path;
}

function createReplayFile(envelopes: SseEnvelope[]) {
	return {
		schemaVersion: 1,
		kind: "pi-web-backend-sse-replay",
		runId: SESSION_ID,
		timing: { startedAt: STARTED_AT, durationMs: 250 },
		prompt: "build a replay",
		events: envelopes.map((envelope, index) => ({
			atMs: index * 50,
			afterPreviousMs: index === 0 ? 0 : 50,
			eventType: envelope.eventType,
			eventId: envelope.eventId,
			envelope,
		})),
	};
}

function messageCompletedEnvelope(sequence: number): SseEnvelope {
	return envelope(sequence, "message.completed", {
		message: {
			id: "user-message",
			source: "main",
			agentId: null,
			role: "user",
			kind: "message",
			content: "build a replay",
			status: "completed",
			createdAt: STARTED_AT,
			updatedAt: STARTED_AT,
			rawType: "message_end",
			toolName: null,
			toolCallId: null,
		},
	});
}

function messageDeltaEnvelope(sequence: number, delta: string): SseEnvelope {
	return envelope(sequence, "message.delta", {
		messageId: "assistant-message",
		role: "assistant",
		source: "main",
		agentId: null,
		delta,
	});
}

function agentUpdatedEnvelope(sequence: number): SseEnvelope {
	return envelope(sequence, "agent.updated", {
		agent: {
			agentId: "replay-agent",
			displayName: "Replay Agent",
			role: "replay",
			avatar: null,
			phase: "running",
			activeTool: null,
			completedTools: [],
			lastAssistantPreview: null,
			eventCount: 1,
			recentEvents: [],
			sessionId: "sub-session",
			lastRunStatus: "running",
			sharedStateRoot: "/tmp/replay-shared-state",
			updatedAt: STARTED_AT,
		},
		changedFields: ["phase"],
	});
}

function agentEventEnvelope(sequence: number): SseEnvelope {
	return envelope(sequence, "agent.event", {
		event: {
			type: "agent.started",
			agentId: "replay-agent",
			sessionId: "sub-session",
			invocationId: "invoke-1",
			sequence: 1,
			timestamp: STARTED_AT,
		},
	});
}

function sharedStateChangedEnvelope(sequence: number): SseEnvelope {
	return envelope(sequence, "shared_state.changed", { paths: [], reason: "replay_event" });
}

function envelope(sequence: number, eventType: SseEventType, payload: unknown): SseEnvelope {
	return {
		eventId: `event-${sequence}`,
		eventType,
		mode: "live",
		sessionId: SESSION_ID,
		turnId: TURN_ID,
		sequence,
		createdAt: new Date(Date.parse(STARTED_AT) + sequence * 1000).toISOString(),
		payload,
	};
}

async function waitForState(
	app: ReturnType<typeof createWebBackendApp>["app"],
	predicate: (state: SessionSnapshot) => boolean,
	timeoutMs: number,
): Promise<void> {
	await waitFor(async () => predicate((await (await app.request("/api/state")).json()) as SessionSnapshot), timeoutMs);
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
	const startedAt = Date.now();
	while (!(await predicate())) {
		if (Date.now() - startedAt > timeoutMs) throw new Error("Timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
