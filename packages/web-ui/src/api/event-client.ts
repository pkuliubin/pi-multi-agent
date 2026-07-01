import type { SseEnvelope, SseEventType } from "./contracts.ts";

export interface EventClientCallbacks {
	onOpen?: () => void;
	onEnvelope?: (envelope: SseEnvelope) => void;
	onError?: (error: EventClientError) => void;
	onConnectionError?: () => void;
}

export interface EventClient {
	connect(): void;
	close(): void;
}

export interface EventClientOptions extends EventClientCallbacks {
	baseUrl?: string;
	eventSourceFactory?: EventSourceFactory;
}

export interface EventClientError {
	message: string;
	rawEvent?: MessageEvent;
	cause?: unknown;
}

interface EventSourceLike {
	onopen: ((event: Event) => void) | null;
	onerror: ((event: Event) => void) | null;
	addEventListener(type: string, listener: (event: MessageEvent) => void): void;
	close(): void;
}

type EventSourceFactory = (url: string) => EventSourceLike;

export const sseEventTypes: SseEventType[] = [
	"session.started",
	"session.stopped",
	"message.delta",
	"message.completed",
	"tool.started",
	"tool.updated",
	"tool.completed",
	"agent.event",
	"agent.message.delta",
	"agent.tool.started",
	"agent.tool.updated",
	"agent.tool.completed",
	"agent.updated",
	"shared_state.changed",
	"replay.started",
	"replay.completed",
	"error",
];

const defaultBaseUrl = import.meta.env.VITE_PI_WEB_UI_API_BASE_URL ?? "";

export function createEventClient(options: EventClientOptions): EventClient {
	const baseUrl = normalizeBaseUrl(options.baseUrl ?? defaultBaseUrl);
	const eventSourceFactory = options.eventSourceFactory ?? ((url: string) => new EventSource(url) as EventSourceLike);
	let eventSource: EventSourceLike | null = null;

	return {
		connect() {
			if (eventSource) {
				return;
			}

			eventSource = eventSourceFactory(`${baseUrl}/api/events`);
			eventSource.onopen = () => options.onOpen?.();
			eventSource.onerror = () => options.onConnectionError?.();

			for (const eventType of sseEventTypes) {
				eventSource.addEventListener(eventType, (event) => {
					const messageEvent = event as MessageEvent;
					try {
						options.onEnvelope?.(parseSseEnvelope(messageEvent.data));
					} catch (error) {
						options.onError?.({
							message: error instanceof Error ? error.message : "Failed to parse SSE event",
							rawEvent: messageEvent,
							cause: error,
						});
					}
				});
			}
		},
		close() {
			eventSource?.close();
			eventSource = null;
		},
	};
}

export function parseSseEnvelope(data: string): SseEnvelope {
	const parsed = JSON.parse(data) as unknown;

	if (!isSseEnvelope(parsed)) {
		throw new Error("SSE event did not match the expected envelope shape");
	}

	return parsed;
}

function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function isSseEnvelope(value: unknown): value is SseEnvelope {
	return (
		typeof value === "object" &&
		value !== null &&
		"eventId" in value &&
		typeof value.eventId === "string" &&
		"eventType" in value &&
		typeof value.eventType === "string" &&
		sseEventTypes.includes(value.eventType as SseEventType) &&
		"mode" in value &&
		(value.mode === "live" || value.mode === "replay") &&
		"sequence" in value &&
		typeof value.sequence === "number" &&
		"createdAt" in value &&
		typeof value.createdAt === "string" &&
		"payload" in value
	);
}
