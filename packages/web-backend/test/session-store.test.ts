import { describe, expect, it } from "vitest";
import { createEmptySessionSnapshot, SessionStore } from "../src/session-store.ts";

describe("SessionStore", () => {
	it("creates the documented empty snapshot", () => {
		const snapshot = createEmptySessionSnapshot();

		expect(snapshot.backendMode).toBeNull();
		expect(snapshot.session.started).toBe(false);
		expect(snapshot.turn.status).toBe("idle");
		expect(snapshot.counts).toEqual({ messages: 0, agents: 0, artifacts: 0 });
		expect(snapshot.agents).toEqual([]);
		expect(snapshot.sharedState).toEqual({ root: null, artifacts: [], updatedAt: null });
	});

	it("keeps counts in sync with messages and agents", () => {
		const store = new SessionStore();
		store.setMessages([
			{
				id: "message-1",
				source: "main",
				agentId: null,
				role: "assistant",
				kind: "message",
				content: "hello",
				status: "completed",
				createdAt: "2026-05-28T00:00:00.000Z",
				updatedAt: "2026-05-28T00:00:00.000Z",
				rawType: null,
				toolName: null,
				toolCallId: null,
			},
		]);

		expect(store.getSnapshot().counts.messages).toBe(1);
	});

	it("clears derived session data when replacing the snapshot", () => {
		const store = new SessionStore();
		store.setAgents([
			{
				agentId: "pm-agent-v2",
				displayName: "PM Agent V2",
				role: "Product",
				avatar: "PA",
				phase: "failed",
				lastRunStatus: "failed",
				activeTool: null,
				completedTools: [],
				recentEvents: [],
				lastAssistantPreview: null,
				eventCount: 0,
				sessionId: null,
				sharedStateRoot: null,
				updatedAt: null,
			},
		]);

		store.setSnapshot(createEmptySessionSnapshot());

		expect(store.getAgents()).toEqual({ agents: [] });
		expect(store.getSnapshot().agents).toEqual([]);
		expect(store.getSnapshot().counts.agents).toBe(0);
	});
	it("merges agent history tool start and end records", () => {
		const store = new SessionStore();
		store.appendAgentHistory("pm-agent-v2", [
			{
				id: "pm-agent-v2:tool:call-1",
				agentId: "pm-agent-v2",
				turnId: "turn-1",
				invocationId: null,
				type: "tool_call",
				toolName: "shared_state.write",
				toolCallId: "call-1",
				status: "running",
				args: { path: "prd/pm.md" },
				result: null,
				createdAt: "2026-05-28T00:00:01.000Z",
			},
		]);
		store.appendAgentHistory("pm-agent-v2", [
			{
				id: "pm-agent-v2:tool:call-1",
				agentId: "pm-agent-v2",
				turnId: "turn-1",
				invocationId: null,
				type: "tool_call",
				toolName: "shared_state.write",
				toolCallId: "call-1",
				status: "completed",
				args: null,
				result: "wrote file",
				createdAt: "2026-05-28T00:00:02.000Z",
			},
		]);

		expect(store.getAgentHistory("pm-agent-v2").items).toEqual([
			expect.objectContaining({ status: "completed", args: { path: "prd/pm.md" }, result: "wrote file" }),
		]);
	});
});
