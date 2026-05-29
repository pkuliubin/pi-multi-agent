import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
	AbortRequest,
	PromptRequest,
	ReplayResetRequest,
	ReplaySpeedRequest,
	StartSessionRequest,
	StopSessionRequest,
} from "./contract.ts";
import { EmptyEngine } from "./engines/empty-engine.ts";
import type { BackendEngine } from "./engines/engine.ts";
import { LiveRpcEngine } from "./engines/live-rpc-engine.ts";
import { ReplayEngine } from "./engines/replay-engine.ts";
import { createApiErrorResponse, invalidMode, invalidRequest, sessionAlreadyRunning, toApiError } from "./errors.ts";
import { formatSseEnvelope, SseBus, type SseClient } from "./events/sse-bus.ts";
import { SessionStore } from "./session-store.ts";

export interface WebBackendDependencies {
	store?: SessionStore;
	sseBus?: SseBus;
	createReplayEngine?: (dependencies: EngineDependencies) => BackendEngine;
	createLiveEngine?: (dependencies: EngineDependencies) => BackendEngine;
}

export interface EngineDependencies {
	store: SessionStore;
	sseBus: SseBus;
}

export interface WebBackendApp {
	app: Hono;
	store: SessionStore;
	sseBus: SseBus;
}

interface EngineState {
	engine: BackendEngine;
	kind: "empty" | "live" | "replay";
}

export function createWebBackendApp(dependencies: WebBackendDependencies = {}): WebBackendApp {
	const app = new Hono();
	const store = dependencies.store ?? new SessionStore();
	const sseBus = dependencies.sseBus ?? new SseBus();
	const engineDependencies = { store, sseBus };
	const createReplayEngine =
		dependencies.createReplayEngine ?? ((deps: EngineDependencies) => new ReplayEngine(deps.store, deps.sseBus));
	const createLiveEngine =
		dependencies.createLiveEngine ?? ((deps: EngineDependencies) => new LiveRpcEngine(deps.store, deps.sseBus));
	const engineState: EngineState = {
		engine: new EmptyEngine(store),
		kind: "empty",
	};

	app.onError((error, c) => {
		const apiError = toApiError(error);
		return c.json(createApiErrorResponse(apiError), apiError.status as ContentfulStatusCode);
	});

	app.get("/api/state", (c) => c.json(engineState.engine.getState()));
	app.get("/api/messages", async (c) => c.json(await engineState.engine.getMessages()));
	app.get("/api/agents", async (c) => c.json(await engineState.engine.getAgents()));
	app.get("/api/agents/:agentId/history", async (c) =>
		c.json(await engineState.engine.getAgentHistory(c.req.param("agentId"))),
	);
	app.get("/api/role-sessions", async (c) => c.json(await engineState.engine.getRoleSessions()));
	app.get("/api/shared-state/manifest", async (c) => c.json(await engineState.engine.getSharedStateManifest()));
	app.get("/api/shared-state/artifact", async (c) => {
		const artifactPath = c.req.query("path");
		if (!artifactPath) throw invalidRequest("Missing artifact path");
		return c.json(await engineState.engine.getSharedStateArtifact(artifactPath));
	});

	app.get("/api/events", (_c) => createSseResponse(sseBus));

	app.post("/api/session/start", async (c) => {
		const request = await readJsonBody<StartSessionRequest>(c.req.raw);
		if (store.isStarted()) throw sessionAlreadyRunning();

		if (request.mode === "replay") {
			engineState.engine = createReplayEngine(engineDependencies);
			engineState.kind = "replay";
		} else if (request.mode === "live") {
			engineState.engine = createLiveEngine(engineDependencies);
			engineState.kind = "live";
		} else {
			throw invalidRequest("Invalid backend mode", request.mode);
		}

		try {
			return c.json(await engineState.engine.start(request));
		} catch (error) {
			engineState.engine = new EmptyEngine(store);
			engineState.kind = "empty";
			throw error;
		}
	});

	app.post("/api/session/stop", async (c) => {
		const request = await readJsonBody<StopSessionRequest>(c.req.raw, {});
		const snapshot = await engineState.engine.stop(request);
		engineState.engine = new EmptyEngine(store);
		engineState.kind = "empty";
		return c.json(snapshot);
	});

	app.post("/api/prompt", async (c) => {
		const request = await readJsonBody<PromptRequest>(c.req.raw);
		if (typeof request.text !== "string" || request.text.length === 0)
			throw invalidRequest("Prompt text is required");
		return c.json(await engineState.engine.prompt(request));
	});

	app.post("/api/abort", async (c) => {
		const request = await readJsonBody<AbortRequest>(c.req.raw, {});
		return c.json(await engineState.engine.abort(request));
	});

	app.post("/api/replay/reset", async (c) => {
		const request = await readJsonBody<ReplayResetRequest>(c.req.raw, {});
		if (engineState.kind !== "replay" || !engineState.engine.resetReplay) {
			throw invalidMode("Replay reset is only available in replay mode");
		}
		return c.json(await engineState.engine.resetReplay(request));
	});

	app.post("/api/replay/speed", async (c) => {
		const request = await readJsonBody<ReplaySpeedRequest>(c.req.raw);
		if (typeof request.speed !== "number" || !Number.isFinite(request.speed) || request.speed <= 0) {
			throw invalidRequest("Replay speed must be a positive number");
		}
		if (engineState.kind !== "replay" || !engineState.engine.setReplaySpeed) {
			throw invalidMode("Replay speed is only available in replay mode");
		}
		return c.json(await engineState.engine.setReplaySpeed(request));
	});

	return { app, store, sseBus };
}

async function readJsonBody<T>(request: Request, fallback?: T): Promise<T> {
	const text = await request.text();
	if (text.trim().length === 0) {
		if (fallback !== undefined) return fallback;
		throw invalidRequest("Request body must be JSON");
	}

	try {
		return JSON.parse(text) as T;
	} catch (error) {
		throw invalidRequest("Request body must be valid JSON", error instanceof Error ? error.message : error);
	}
}

function createSseResponse(sseBus: SseBus): Response {
	const encoder = new TextEncoder();
	let cleanup: (() => void) | null = null;
	let heartbeat: NodeJS.Timeout | null = null;

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const client: SseClient = {
				write(event) {
					controller.enqueue(encoder.encode(formatSseEnvelope(event)));
				},
				close() {
					controller.close();
				},
			};

			cleanup = sseBus.addClient(client);
			controller.enqueue(encoder.encode(": connected\n\n"));
			heartbeat = setInterval(() => {
				controller.enqueue(encoder.encode(": heartbeat\n\n"));
			}, 15000);
		},
		cancel() {
			cleanup?.();
			if (heartbeat) clearInterval(heartbeat);
		},
	});

	return new Response(body, {
		headers: {
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
}
