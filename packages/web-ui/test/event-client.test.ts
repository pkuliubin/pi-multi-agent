import { describe, expect, it, vi } from "vitest";
import { createEventClient, parseSseEnvelope } from "../src/api/event-client.ts";
import { agentCard } from "./fixtures.ts";

describe("parseSseEnvelope", () => {
	it("parses a valid envelope", () => {
		const envelope = parseSseEnvelope(
			JSON.stringify({
				eventId: "event-1",
				eventType: "agent.updated",
				mode: "replay",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 1,
				createdAt: "2026-05-28T10:00:00.000Z",
				payload: { agent: agentCard, changedFields: ["phase"] },
			}),
		);

		expect(envelope.eventType).toBe("agent.updated");
		expect(envelope.sequence).toBe(1);
	});

	it("rejects malformed event data", () => {
		expect(() => parseSseEnvelope(JSON.stringify({ eventType: "agent.updated" }))).toThrow(/expected envelope/);
	});
});

describe("createEventClient", () => {
	it("subscribes to named events and emits parsed envelopes", () => {
		const source = new FakeEventSource();
		const onEnvelope = vi.fn();
		const client = createEventClient({ eventSourceFactory: () => source, onEnvelope });

		client.connect();
		source.emit(
			"agent.updated",
			JSON.stringify({
				eventId: "event-1",
				eventType: "agent.updated",
				mode: "replay",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 1,
				createdAt: "2026-05-28T10:00:00.000Z",
				payload: { agent: agentCard, changedFields: ["phase"] },
			}),
		);

		expect(onEnvelope).toHaveBeenCalledWith(expect.objectContaining({ eventType: "agent.updated" }));
	});
});

class FakeEventSource {
	onopen: (() => void) | null = null;
	onerror: (() => void) | null = null;
	private readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();

	addEventListener(type: string, listener: (event: MessageEvent) => void) {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	close() {}

	emit(type: string, data: string) {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(new MessageEvent(type, { data }));
		}
	}
}
