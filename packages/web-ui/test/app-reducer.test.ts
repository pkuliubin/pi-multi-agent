import { describe, expect, it } from "vitest";
import { webUiReducer } from "../src/state/app-reducer.ts";
import { initialWebUiState } from "../src/state/app-state.ts";
import { agentCard, artifactEntry, sessionSnapshot, timelineMessage } from "./fixtures.ts";

describe("webUiReducer", () => {
	it("hydrates session, messages, agents, and manifest", () => {
		const state = webUiReducer(initialWebUiState, {
			type: "hydrate.completed",
			payload: {
				session: sessionSnapshot,
				messages: { messages: [timelineMessage] },
				agents: { agents: [agentCard] },
				manifest: { root: sessionSnapshot.sharedState.root, artifacts: [artifactEntry] },
			},
		});

		expect(state.session?.session.sessionId).toBe("session-1");
		expect(state.messages).toHaveLength(1);
		expect(state.agentsById.da).toEqual(agentCard);
		expect(state.sharedState.selectedArtifactPath).toBe(artifactEntry.path);
	});

	it("appends streaming message deltas", () => {
		const first = webUiReducer(initialWebUiState, {
			type: "sse.received",
			envelope: {
				eventId: "event-1",
				eventType: "message.delta",
				mode: "replay",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 1,
				createdAt: "2026-05-28T10:00:00.000Z",
				payload: {
					messageId: "stream-1",
					role: "assistant",
					source: "main",
					agentId: null,
					delta: "Hel",
				},
			},
		});
		const second = webUiReducer(first, {
			type: "sse.received",
			envelope: {
				eventId: "event-2",
				eventType: "message.delta",
				mode: "replay",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 2,
				createdAt: "2026-05-28T10:00:01.000Z",
				payload: {
					messageId: "stream-1",
					role: "assistant",
					source: "main",
					agentId: null,
					delta: "lo",
				},
			},
		});

		expect(second.messages[0]?.content).toBe("Hello");
		expect(second.messages[0]?.status).toBe("streaming");
	});

	it("upserts agent updates and ignores duplicate sequences", () => {
		const state = webUiReducer(initialWebUiState, {
			type: "sse.received",
			envelope: {
				eventId: "event-1",
				eventType: "agent.updated",
				mode: "replay",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 10,
				createdAt: "2026-05-28T10:00:00.000Z",
				payload: { agent: agentCard, changedFields: ["phase"] },
			},
		});
		const duplicate = webUiReducer(state, {
			type: "sse.received",
			envelope: {
				eventId: "event-duplicate",
				eventType: "agent.updated",
				mode: "replay",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 10,
				createdAt: "2026-05-28T10:00:00.000Z",
				payload: { agent: { ...agentCard, displayName: "Changed" }, changedFields: ["displayName"] },
			},
		});

		expect(state.agentsById.da?.displayName).toBe("Data Analyst");
		expect(duplicate.agentsById.da?.displayName).toBe("Data Analyst");
	});

	it("invalidates changed artifact content", () => {
		const loaded = webUiReducer(initialWebUiState, {
			type: "artifact.load.completed",
			artifact: {
				path: artifactEntry.path,
				artifact: artifactEntry,
				content: {
					kind: "json",
					json: { ok: true },
					text: '{"ok":true}',
					sizeBytes: 11,
					mimeType: "application/json",
					truncated: false,
				},
			},
		});
		const invalidated = webUiReducer(loaded, {
			type: "sse.received",
			envelope: {
				eventId: "event-1",
				eventType: "shared_state.changed",
				mode: "replay",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 1,
				createdAt: "2026-05-28T10:00:00.000Z",
				payload: { paths: [artifactEntry.path], reason: "shared_state_write" },
			},
		});

		expect(loaded.sharedState.artifactContentByPath[artifactEntry.path]).toBeDefined();
		expect(invalidated.sharedState.artifactContentByPath[artifactEntry.path]).toBeUndefined();
	});

	it("clears artifact content cache for coarse shared-state changes", () => {
		const loaded = webUiReducer(initialWebUiState, {
			type: "artifact.load.completed",
			artifact: {
				path: artifactEntry.path,
				artifact: artifactEntry,
				content: {
					kind: "text",
					text: "old content",
					sizeBytes: 11,
					mimeType: "text/markdown",
					truncated: false,
				},
			},
		});
		const invalidated = webUiReducer(loaded, {
			type: "sse.received",
			envelope: {
				eventId: "event-1",
				eventType: "shared_state.changed",
				mode: "replay",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 1,
				createdAt: "2026-05-28T10:00:00.000Z",
				payload: { paths: [], reason: "run_subagent_completed" },
			},
		});

		expect(loaded.sharedState.artifactContentByPath[artifactEntry.path]).toBeDefined();
		expect(invalidated.sharedState.artifactContentByPath).toEqual({});
	});

	it("resets sequence tracking when hydrate switches sessions", () => {
		const previousSession = webUiReducer(initialWebUiState, {
			type: "sse.received",
			envelope: {
				eventId: "event-1",
				eventType: "agent.updated",
				mode: "replay",
				sessionId: "session-1",
				turnId: "turn-1",
				sequence: 25,
				createdAt: "2026-05-28T10:00:00.000Z",
				payload: { agent: agentCard, changedFields: ["phase"] },
			},
		});
		const hydrated = webUiReducer(previousSession, {
			type: "hydrate.completed",
			payload: {
				session: {
					...sessionSnapshot,
					session: {
						...sessionSnapshot.session,
						sessionId: "session-2",
					},
				},
				messages: { messages: [] },
				agents: { agents: [] },
				manifest: { root: null, artifacts: [] },
			},
		});
		const nextEvent = webUiReducer(hydrated, {
			type: "sse.received",
			envelope: {
				eventId: "event-2",
				eventType: "agent.updated",
				mode: "replay",
				sessionId: "session-2",
				turnId: "turn-2",
				sequence: 1,
				createdAt: "2026-05-28T10:01:00.000Z",
				payload: { agent: { ...agentCard, displayName: "New Session Agent" }, changedFields: ["displayName"] },
			},
		});

		expect(hydrated.connection.lastSequence).toBeNull();
		expect(nextEvent.agentsById.da?.displayName).toBe("New Session Agent");
	});

	it("prunes cached artifact content that is no longer in the manifest", () => {
		const loaded = webUiReducer(initialWebUiState, {
			type: "artifact.load.completed",
			artifact: {
				path: artifactEntry.path,
				artifact: artifactEntry,
				content: {
					kind: "text",
					text: "old content",
					sizeBytes: 11,
					mimeType: "text/markdown",
					truncated: false,
				},
			},
		});
		const hydrated = webUiReducer(loaded, {
			type: "hydrate.completed",
			payload: {
				session: sessionSnapshot,
				messages: { messages: [] },
				agents: { agents: [] },
				manifest: { root: sessionSnapshot.sharedState.root, artifacts: [] },
			},
		});

		expect(hydrated.sharedState.artifactContentByPath[artifactEntry.path]).toBeUndefined();
		expect(hydrated.sharedState.selectedArtifactPath).toBeNull();
	});
});
