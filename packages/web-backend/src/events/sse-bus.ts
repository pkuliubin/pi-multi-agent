import { randomUUID } from "node:crypto";
import type { BackendMode, SseEnvelope, SseEventType } from "../contract.ts";

export interface SseEventContext {
	mode: BackendMode;
	sessionId: string | null;
	turnId: string | null;
}

export interface SseClient {
	write(event: SseEnvelope): void;
	close(): void;
}

const DEFAULT_RECENT_EVENT_LIMIT = 1000;

export class SseBus {
	private clients = new Set<SseClient>();
	private sequence = 0;
	private recentEnvelopes: SseEnvelope[] = [];
	private readonly recentEventLimit: number;

	constructor(options: { recentEventLimit?: number } = {}) {
		this.recentEventLimit = options.recentEventLimit ?? DEFAULT_RECENT_EVENT_LIMIT;
	}

	addClient(client: SseClient): () => void {
		this.clients.add(client);
		return () => {
			this.clients.delete(client);
		};
	}

	getRecentEnvelopes(): SseEnvelope[] {
		return [...this.recentEnvelopes];
	}

	broadcast<TPayload>(eventType: SseEventType, context: SseEventContext, payload: TPayload): SseEnvelope<TPayload> {
		const envelope: SseEnvelope<TPayload> = {
			eventId: randomUUID(),
			eventType,
			mode: context.mode,
			sessionId: context.sessionId,
			turnId: context.turnId,
			sequence: ++this.sequence,
			createdAt: new Date().toISOString(),
			payload,
		};

		this.broadcastEnvelope(envelope);
		return envelope;
	}

	broadcastEnvelope(envelope: SseEnvelope): SseEnvelope {
		this.remember(envelope);
		for (const client of this.clients) {
			client.write(envelope);
		}

		return envelope;
	}

	closeAll(): void {
		for (const client of this.clients) {
			client.close();
		}
		this.clients.clear();
	}

	private remember(envelope: SseEnvelope): void {
		this.recentEnvelopes.push(envelope);
		if (this.recentEnvelopes.length > this.recentEventLimit) {
			this.recentEnvelopes.splice(0, this.recentEnvelopes.length - this.recentEventLimit);
		}
	}
}

export function formatSseEnvelope(envelope: SseEnvelope): string {
	return `event: ${envelope.eventType}\nid: ${envelope.eventId}\ndata: ${JSON.stringify(envelope)}\n\n`;
}
