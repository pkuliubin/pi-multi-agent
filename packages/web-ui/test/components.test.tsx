import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCard } from "../src/components/agents/AgentCard.tsx";
import { AgentCardsRow } from "../src/components/agents/AgentCardsRow.tsx";
import { PromptInput } from "../src/components/prompt/PromptInput.tsx";
import { SessionControls } from "../src/components/session/SessionControls.tsx";
import { ArtifactList } from "../src/components/shared-state/ArtifactList.tsx";
import { ArtifactViewer } from "../src/components/shared-state/ArtifactViewer.tsx";
import { MainTimeline } from "../src/components/timeline/MainTimeline.tsx";
import { agentCard, artifactEntry } from "./fixtures.ts";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
	act(() => {
		root?.unmount();
	});
	container?.remove();
	root = null;
	container = null;
});

describe("dashboard components", () => {
	it("renders an agent card with phase and active tool", () => {
		render(<AgentCard agent={agentCard} selected={false} onSelect={vi.fn()} />);

		expect(document.body.textContent).toContain("Data Analyst");
		expect(document.body.textContent).toContain("Reading artifact");
	});

	it("toggles selected agent details in the agent workbench", () => {
		render(
			<AgentCardsRow
				historyByAgentId={{
					da: {
						agentId: "da",
						items: [
							{
								id: "status-start-1",
								agentId: "da",
								turnId: "turn-1",
								invocationId: null,
								type: "status",
								status: "running",
								content: "agent_start",
								createdAt: "2026-05-28T10:06:00.000Z",
							},
							{
								id: "message-history-1",
								agentId: "da",
								turnId: "turn-1",
								invocationId: null,
								type: "message",
								role: "assistant",
								content: "## Full agent message\n\nFinal agent message from history.",
								createdAt: "2026-05-28T10:08:00.000Z",
							},
							{
								id: "tool-history-1",
								agentId: "da",
								turnId: "turn-1",
								invocationId: null,
								type: "tool_call",
								toolName: "shared_state.write",
								toolCallId: "tool-done",
								status: "completed",
								args: { path: "analysis/summary.json" },
								result: { ok: true },
								createdAt: "2026-05-28T10:07:00.000Z",
							},
						],
					},
				}}
				agents={[
					{
						...agentCard,
						completedTools: [
							{
								toolCallId: "tool-done",
								name: "shared_state.write",
								status: "completed",
								argsSummary: "analysis/summary.json",
								resultSummary: "wrote summary",
								startedAt: "2026-05-28T10:06:00.000Z",
								endedAt: "2026-05-28T10:07:00.000Z",
							},
						],
						lastAssistantPreview: "I read the source and wrote the summary.",
						recentEvents: [
							{
								id: "event-2",
								type: "tool_execution_completed",
								summary: "shared_state_write path=analysis/summary.json",
								createdAt: "2026-05-28T10:07:00.000Z",
							},
							{
								id: "event-3",
								type: "message_end",
								summary: "message_end: Final agent message from recent events.",
								createdAt: "2026-05-28T10:08:00.000Z",
							},
						],
					},
				]}
			/>,
		);

		expect(document.body.textContent).not.toContain("Latest message");

		clickButton("Details");
		expect(document.body.textContent).toContain("Round 1");
		expect(document.body.textContent).not.toContain("Latest message");
		expect(document.body.textContent).toContain("Full agent message");
		expect(document.body.textContent).toContain("Final agent message from history.");
		expect(document.body.textContent).toContain("1 tool calls");
		expect(document.body.textContent).not.toContain("shared state write");
		expect(document.body.textContent).not.toContain('"ok": true');

		clickButton("1 tool calls");
		expect(document.body.textContent).toContain("shared state write");
		expect(document.body.textContent).toContain("analysis/summary.json");
		clickButton("shared state write");
		expect(document.body.textContent).toContain('"ok": true');

		clickButton("Hide");
		expect(document.body.textContent).not.toContain("Latest message");
	});

	it("renders timeline as a turn with collapsed tools", () => {
		render(
			<MainTimeline
				messages={[
					{
						id: "user-1",
						source: "main",
						agentId: null,
						role: "user",
						kind: "message",
						content: "Please coordinate agents.",
						status: "completed",
						createdAt: "2026-05-28T10:00:00.000Z",
						updatedAt: "2026-05-28T10:00:00.000Z",
						rawType: null,
						toolName: null,
						toolCallId: null,
					},
					{
						id: "assistant-1",
						source: "main",
						agentId: null,
						role: "assistant",
						kind: "message",
						content: "## Plan\n\nI will delegate the work.",
						status: "completed",
						createdAt: "2026-05-28T10:00:01.000Z",
						updatedAt: "2026-05-28T10:00:01.000Z",
						rawType: null,
						toolName: null,
						toolCallId: null,
					},
					{
						id: "tool-1",
						source: "agent",
						agentId: "pm-agent-v2",
						role: "tool",
						kind: "tool_event",
						content: "Status: updated prd/live-smoke.md",
						status: "completed",
						createdAt: "2026-05-28T10:00:02.000Z",
						updatedAt: "2026-05-28T10:00:02.000Z",
						rawType: "run_subagent",
						toolName: "run_subagent",
						toolCallId: "tool-1",
					},
				]}
			/>,
		);

		expect(document.body.textContent).toContain("Assistant");
		expect(document.body.textContent).toContain("I will delegate the work.");
		expect(document.body.textContent).toContain("1 tools");
		expect(document.body.textContent).not.toContain("Status: updated prd/live-smoke.md");
	});

	it("renders markdown tables in assistant output", () => {
		render(
			<MainTimeline
				messages={[
					{
						id: "user-table",
						source: "main",
						agentId: null,
						role: "user",
						kind: "message",
						content: "Summarize.",
						status: "completed",
						createdAt: "2026-05-28T10:00:00.000Z",
						updatedAt: "2026-05-28T10:00:00.000Z",
						rawType: null,
						toolName: null,
						toolCallId: null,
					},
					{
						id: "assistant-table",
						source: "main",
						agentId: null,
						role: "assistant",
						kind: "message",
						content: "| Agent | Artifact |\n|---|---|\n| pm-agent-v2 | `prd/pm.md` |",
						status: "completed",
						createdAt: "2026-05-28T10:00:01.000Z",
						updatedAt: "2026-05-28T10:00:01.000Z",
						rawType: null,
						toolName: null,
						toolCallId: null,
					},
				]}
			/>,
		);

		expect(document.querySelector("table.markdown-table")).toBeDefined();
		expect(document.querySelector("th")?.textContent).toBe("Agent");
		expect(document.querySelector("td")?.textContent).toBe("pm-agent-v2");
	});

	it("deduplicates assistant message revisions in one turn", () => {
		render(
			<MainTimeline
				messages={[
					{
						id: "user-1",
						source: "main",
						agentId: null,
						role: "user",
						kind: "message",
						content: "Coordinate agents.",
						status: "completed",
						createdAt: "2026-05-28T10:00:00.000Z",
						updatedAt: "2026-05-28T10:00:00.000Z",
						rawType: null,
						toolName: null,
						toolCallId: null,
					},
					{
						id: "assistant-stream",
						source: "main",
						agentId: null,
						role: "assistant",
						kind: "message",
						content: "Draft progress",
						status: "streaming",
						createdAt: "2026-05-28T10:00:01.000Z",
						updatedAt: "2026-05-28T10:00:01.000Z",
						rawType: "message.delta",
						toolName: null,
						toolCallId: null,
					},
					{
						id: "assistant-final",
						source: "main",
						agentId: null,
						role: "assistant",
						kind: "message",
						content: "Draft progress plus final answer.",
						status: "completed",
						createdAt: "2026-05-28T10:00:02.000Z",
						updatedAt: "2026-05-28T10:00:02.000Z",
						rawType: "message_end",
						toolName: null,
						toolCallId: null,
					},
				]}
			/>,
		);

		expect(document.body.textContent).toContain("Draft progress plus final answer.");
		expect(document.body.textContent).not.toContain("Draft progressDraft progress");
	});

	it("toggles an expanded artifact row", () => {
		const onSelect = vi.fn();
		render(
			<ArtifactList
				artifacts={[artifactEntry]}
				selectedPath={artifactEntry.path}
				selectedArtifact={null}
				loadingPath={null}
				error={null}
				onSelect={onSelect}
			/>,
		);

		clickButton(artifactEntry.path);

		expect(onSelect).toHaveBeenCalledWith(null);
	});

	it("renders JSON artifact content", () => {
		render(
			<ArtifactViewer
				artifact={{
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
				}}
				loadingPath={null}
				selectedPath={artifactEntry.path}
				error={null}
			/>,
		);

		expect(document.body.textContent).toContain("analysis/summary.json");
		expect(document.body.textContent).toContain('"ok": true');
	});

	it("renders prompt notice and disabled send state", () => {
		render(
			<PromptInput
				pending={true}
				notice="Replay mode does not accept prompts"
				onSubmit={vi.fn()}
				onAbort={vi.fn()}
			/>,
		);

		expect(document.body.textContent).toContain("Replay mode does not accept prompts");
		expect(document.querySelector("button[aria-label='Stop']")).toBeDefined();
	});

	it("submits with Enter and keeps Shift+Enter or IME composition for editing", () => {
		const onSubmit = vi.fn().mockResolvedValue(undefined);
		render(<PromptInput pending={false} notice={null} onSubmit={onSubmit} onAbort={vi.fn()} />);
		const textarea = document.querySelector("textarea");
		expect(textarea).toBeDefined();

		setTextareaValue(textarea, "hello");
		act(() => {
			textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }));
			textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
		});
		expect(onSubmit).not.toHaveBeenCalled();

		act(() => {
			textarea?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		});
		expect(onSubmit).toHaveBeenCalledWith("hello");
	});

	it("renders replay session controls", () => {
		render(
			<SessionControls
				started={false}
				backendMode={null}
				pending={false}
				onStartLive={vi.fn()}
				onStartReplay={vi.fn()}
				onStopSession={vi.fn()}
				onResetReplay={vi.fn()}
				onSetReplaySpeed={vi.fn()}
			/>,
		);

		expect(document.body.textContent).toContain("Start live");
		expect(document.body.textContent).toContain("Start replay");
		expect(document.body.textContent).toContain("Replay speed");
		expect(document.querySelector("button.primary-button")?.getAttribute("disabled")).toBeNull();
	});
});

function render(element: ReactNode) {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root?.render(element);
	});
}

function clickButton(name: string) {
	const button = Array.from(document.querySelectorAll("button")).find((element) =>
		element.textContent?.includes(name),
	);
	expect(button).toBeDefined();
	act(() => {
		button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
}

function setTextareaValue(textarea: HTMLTextAreaElement | null, value: string): void {
	expect(textarea).toBeDefined();
	act(() => {
		const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
		setter?.call(textarea, value);
		textarea?.dispatchEvent(new Event("input", { bubbles: true }));
	});
}
