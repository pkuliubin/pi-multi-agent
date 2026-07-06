import { describe, expect, it } from "vitest";
import type {
	AgentHistoryResponse,
	AgentsResponse,
	MessagesResponse,
	SessionSnapshot,
	SseEnvelope,
} from "../src/contract.ts";
import { createWebBackendApp } from "../src/server.ts";

const SAMPLE_REPLAY_LOG = "tmp/gui-sse-captures/2026-07-02T02-09-43-487Z-replay.json";

describe("replay regression", () => {
	it("hydrates agent cards and emits captured agent/shared-state events from the SSE replay fixture", async () => {
		const { app, sseBus } = createWebBackendApp();
		const envelopes: SseEnvelope[] = [];
		const unsubscribe = sseBus.addClient({
			write: (event) => envelopes.push(event),
			close: () => undefined,
		});

		try {
			await app.request("/api/session/start", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					mode: "replay",
					replay: { logPath: SAMPLE_REPLAY_LOG, autoStart: true, speed: 1000 },
				}),
			});
			await waitFor(() => envelopes.some((event) => event.eventType === "replay.completed"), 5000);

			const state = (await (await app.request("/api/state")).json()) as SessionSnapshot;
			const agentsResponse = await app.request("/api/agents");
			const agents = ((await agentsResponse.json()) as AgentsResponse).agents;
			const agentIds = agents.map((agent) => agent.agentId).sort();
			const messagesResponse = await app.request("/api/messages");
			const messages = ((await messagesResponse.json()) as MessagesResponse).messages;
			const runSubagentMessages = messages.filter((message) => message.toolName === "run_subagent");
			const assistantMessages = messages.filter((message) => message.role === "assistant");
			const pmHistory = (await (await app.request("/api/agents/pm-agent/history")).json()) as AgentHistoryResponse;

			expect(state.replay).toMatchObject({ source: "sse_capture", ended: true, cursor: 27549, totalEvents: 27549 });
			expect(agentIds).toEqual(["design-agent", "engineering-agent", "pm-agent"]);
			expect(runSubagentMessages).toHaveLength(3);
			expect(runSubagentMessages.map((message) => message.agentId).sort()).toEqual([
				"design-agent",
				"engineering-agent",
				"pm-agent",
			]);
			expect(runSubagentMessages.every((message) => message.rawType === "message_end")).toBe(true);
			expect(assistantMessages.at(-1)?.id).toBe("24c2a3c6-6366-44c1-be2a-ddfb160da01b");
			expect(assistantMessages.at(-1)?.content).toContain("三方分析总结");
			expect(envelopes.some((event) => event.eventType === "agent.updated")).toBe(true);
			expect(envelopes.some((event) => event.eventType === "agent.event")).toBe(true);
			expect(envelopes.some((event) => event.eventType === "agent.message.delta")).toBe(true);
			expect(envelopes.some((event) => event.eventType === "shared_state.changed")).toBe(true);
			expect(agents.every((agent) => agent.phase === "completed")).toBe(true);
			expect(pmHistory).toMatchObject({ agentId: "pm-agent" });
			expect(pmHistory.items.length).toBeGreaterThan(0);
		} finally {
			unsubscribe();
			await app.request("/api/session/stop", { method: "POST", body: "{}" });
		}
	});
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const startedAt = Date.now();
	while (!predicate()) {
		if (Date.now() - startedAt > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
