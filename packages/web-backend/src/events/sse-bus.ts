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

export class SseBus {
	private clients = new Set<SseClient>();
	private sequence = 0;

	addClient(client: SseClient): () => void {
		this.clients.add(client);
		return () => {
			this.clients.delete(client);
		};
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
}

export function formatSseEnvelope(envelope: SseEnvelope): string {
	return `event: ${envelope.eventType}\nid: ${envelope.eventId}\ndata: ${JSON.stringify(envelope)}\n\n`;
}
