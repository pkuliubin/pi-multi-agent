import { readFile } from "node:fs/promises";
import type { SseEnvelope } from "../contract.ts";

export interface SseReplayFile {
	schemaVersion: 1;
	kind: "pi-web-backend-sse-replay";
	runId: string;
	timing: {
		startedAt: string;
		durationMs: number;
	};
	prompt: string;
	events: SseReplayEvent[];
}

export interface SseReplayEvent {
	atMs: number;
	afterPreviousMs: number;
	eventType: string;
	eventId: string | null;
	envelope: SseEnvelope;
}

export async function readSseCaptureReplay(path: string): Promise<SseReplayFile> {
	const content = await readFile(path, "utf8");
	return parseSseCaptureReplay(content);
}

export function parseSseCaptureReplay(content: string): SseReplayFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content) as unknown;
	} catch (error) {
		throw new Error(`Invalid SSE replay JSON: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (!isRecord(parsed)) throw new Error("Invalid SSE replay file: root must be an object");
	if (parsed.kind !== "pi-web-backend-sse-replay") {
		throw new Error(`Unsupported SSE replay kind: ${String(parsed.kind)}`);
	}
	if (parsed.schemaVersion !== 1) {
		throw new Error(`Unsupported SSE replay schema version: ${String(parsed.schemaVersion)}`);
	}
	if (typeof parsed.runId !== "string") throw new Error("Invalid SSE replay file: runId is required");
	if (!isTiming(parsed.timing)) throw new Error("Invalid SSE replay file: timing is invalid");
	if (typeof parsed.prompt !== "string") throw new Error("Invalid SSE replay file: prompt is required");
	if (!Array.isArray(parsed.events)) throw new Error("Invalid SSE replay file: events must be an array");

	const events = parsed.events.map((event, index) => parseReplayEvent(event, index));
	return {
		schemaVersion: 1,
		kind: "pi-web-backend-sse-replay",
		runId: parsed.runId,
		timing: parsed.timing,
		prompt: parsed.prompt,
		events,
	};
}

function parseReplayEvent(value: unknown, index: number): SseReplayEvent {
	if (!isRecord(value)) throw new Error(`Invalid SSE replay event at index ${index}: event must be an object`);
	if (!isFiniteNumber(value.atMs)) throw new Error(`Invalid SSE replay event at index ${index}: atMs is required`);
	if (!isFiniteNumber(value.afterPreviousMs)) {
		throw new Error(`Invalid SSE replay event at index ${index}: afterPreviousMs is required`);
	}
	if (typeof value.eventType !== "string") {
		throw new Error(`Invalid SSE replay event at index ${index}: eventType is required`);
	}
	if (value.eventId !== null && typeof value.eventId !== "string") {
		throw new Error(`Invalid SSE replay event at index ${index}: eventId must be a string or null`);
	}
	const envelope = parseEnvelope(value.envelope, index);
	if (envelope.eventType !== value.eventType) {
		throw new Error(`Invalid SSE replay event at index ${index}: eventType does not match envelope.eventType`);
	}
	if (value.eventId !== null && envelope.eventId !== value.eventId) {
		throw new Error(`Invalid SSE replay event at index ${index}: eventId does not match envelope.eventId`);
	}
	return {
		atMs: value.atMs,
		afterPreviousMs: value.afterPreviousMs,
		eventType: value.eventType,
		eventId: value.eventId,
		envelope,
	};
}

function parseEnvelope(value: unknown, index: number): SseEnvelope {
	if (!isRecord(value)) throw new Error(`Invalid SSE replay event at index ${index}: envelope must be an object`);
	if (typeof value.eventId !== "string")
		throw new Error(`Invalid SSE replay event at index ${index}: envelope.eventId is required`);
	if (typeof value.eventType !== "string") {
		throw new Error(`Invalid SSE replay event at index ${index}: envelope.eventType is required`);
	}
	if (value.mode !== "live" && value.mode !== "replay") {
		throw new Error(`Invalid SSE replay event at index ${index}: envelope.mode is invalid`);
	}
	if (value.sessionId !== null && typeof value.sessionId !== "string") {
		throw new Error(`Invalid SSE replay event at index ${index}: envelope.sessionId is invalid`);
	}
	if (value.turnId !== null && typeof value.turnId !== "string") {
		throw new Error(`Invalid SSE replay event at index ${index}: envelope.turnId is invalid`);
	}
	if (!Number.isInteger(value.sequence)) {
		throw new Error(`Invalid SSE replay event at index ${index}: envelope.sequence is required`);
	}
	if (typeof value.createdAt !== "string") {
		throw new Error(`Invalid SSE replay event at index ${index}: envelope.createdAt is required`);
	}
	return value as unknown as SseEnvelope;
}

function isTiming(value: unknown): value is SseReplayFile["timing"] {
	return isRecord(value) && typeof value.startedAt === "string" && isFiniteNumber(value.durationMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
