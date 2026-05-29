import { describe, expect, it } from "vitest";
import type { AgentsResponse, MessagesResponse, SseEnvelope } from "../src/contract.ts";
import { createWebBackendApp } from "../src/server.ts";

describe("replay regression", () => {
	it("hydrates agent cards and emits agent/shared-state events from the sample log", async () => {
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
				body: JSON.stringify({ mode: "replay", replay: { autoStart: true, speed: 1000 } }),
			});
			await waitFor(() => envelopes.some((event) => event.eventType === "replay.completed"), 5000);

			const agentsResponse = await app.request("/api/agents");
			const agents = ((await agentsResponse.json()) as AgentsResponse).agents;
			const agentIds = agents.map((agent) => agent.agentId).sort();
			const messagesResponse = await app.request("/api/messages");
			const messages = ((await messagesResponse.json()) as MessagesResponse).messages;
			const runSubagentMessages = messages.filter((message) => message.toolName === "run_subagent");
			const assistantMessages = messages.filter((message) => message.role === "assistant");

			expect(agentIds).toEqual(["engineering-agent-v2", "pm-agent-v2", "synthesis-agent-v2"]);
			expect(runSubagentMessages).toHaveLength(3);
			expect(runSubagentMessages.map((message) => message.agentId).sort()).toEqual([
				"engineering-agent-v2",
				"pm-agent-v2",
				"synthesis-agent-v2",
			]);
			expect(runSubagentMessages.every((message) => message.rawType === "run_subagent")).toBe(true);
			expect(runSubagentMessages.every((message) => message.content.includes("toolName: run_subagent"))).toBe(true);
			expect(assistantMessages.map((message) => message.id)).toEqual([
				"3a1088b6-2cb3-471f-86ef-e39ece6da64b",
				"6f14b6fc-91c4-478d-b5ad-f68abe6150ff",
				"8eddcef0-176e-423f-8ee8-6b3e409dcd24",
			]);
			expect(assistantMessages.every((message) => message.status === "completed")).toBe(true);
			expect(assistantMessages.every((message) => !message.content.includes("按照流程"))).toBe(true);
			expect(assistantMessages.some((message) => message.id === "message-3")).toBe(false);
			expect(envelopes.some((event) => event.eventType === "agent.updated")).toBe(true);
			expect(envelopes.some((event) => event.eventType === "shared_state.changed")).toBe(true);
			expect(agents.every((agent) => agent.phase === "completed")).toBe(true);
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
