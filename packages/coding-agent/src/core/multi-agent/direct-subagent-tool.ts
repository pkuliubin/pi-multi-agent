import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { PiSubAgentInstance, type SubAgentResult } from "@earendil-works/pi-multi-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition, type ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput } from "../tools/render-utils.ts";
import { CodingAgentSessionFactory } from "./session-factory.ts";

const runSubAgentSchema = Type.Object({
	task: Type.String({ description: "Task to run in an isolated direct sub-agent session." }),
	systemPrompt: Type.Optional(Type.String({ description: "Optional system prompt for this sub-agent invocation." })),
});

type RunSubAgentInput = Static<typeof runSubAgentSchema>;

export interface DirectRunSubAgentToolDetails {
	result: SubAgentResult;
}

function formatResult(result: SubAgentResult): string {
	const header = [
		`status: ${result.status}`,
		`agentId: ${result.agentId}`,
		`sessionId: ${result.sessionId}`,
		`messages: ${result.messageCountBefore}->${result.messageCountAfter}`,
	];
	const body = result.finalText ? `\n\n${result.finalText}` : "";
	const error = result.errorMessage ? `\n\nerror: ${result.errorMessage}` : "";
	return `${header.join("\n")}${body}${error}`;
}

function formatRunSubAgentCall(args: RunSubAgentInput | undefined): string {
	const task = typeof args?.task === "string" ? args.task : "[invalid task]";
	const trimmed = task.length > 80 ? `${task.slice(0, 77)}...` : task;
	return `run_subagent ${trimmed}`;
}

function formatRunSubAgentResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions): string {
	const output = getTextOutput(result, false).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 24;
	const visible = lines.slice(0, maxLines).join("\n");
	const remaining = lines.length - maxLines;
	return remaining > 0 ? `${visible}\n... (${remaining} more lines)` : visible;
}

export function createDirectRunSubAgentTool(): ToolDefinition {
	return defineTool({
		name: "run_subagent",
		label: "run_subagent",
		description:
			"Run a direct isolated Pi sub-agent for one task. The sub-agent has no tools, no SharedMemory, and no automatic project resource discovery in this phase.",
		promptSnippet: "Run an isolated direct sub-agent with no tools or SharedMemory",
		promptGuidelines: [
			"Use run_subagent when the user explicitly asks to delegate work to a sub-agent or to test multi-agent behavior.",
			"Treat the result as the sub-agent's answer; summarize or return it to the user as appropriate.",
		],
		parameters: runSubAgentSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (signal?.aborted) {
				throw new Error("Sub-agent invocation aborted");
			}
			if (!ctx.model) {
				throw new Error("Cannot run sub-agent without an active model");
			}

			const definition = {
				id: "direct-worker",
				name: "Direct Worker",
				description: "Direct in-process sub-agent worker",
				statePolicy: "session" as const,
				systemPrompt: params.systemPrompt,
			};
			const session = await new CodingAgentSessionFactory({ modelRegistry: ctx.modelRegistry }).create({
				definition,
				cwd: ctx.cwd,
				model: ctx.model,
				thinkingLevel: ctx.model.reasoning ? undefined : "off",
				sessionPolicy: "session",
			});
			const subAgent = new PiSubAgentInstance(definition, session);
			let result: SubAgentResult;
			try {
				result = await subAgent.invoke({ input: params.task });
			} finally {
				await subAgent.close();
			}

			return {
				content: [{ type: "text", text: formatResult(result) }],
				details: { result },
			};
		},
		renderCall(args, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatRunSubAgentCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatRunSubAgentResult(result, options));
			return text;
		},
	});
}
