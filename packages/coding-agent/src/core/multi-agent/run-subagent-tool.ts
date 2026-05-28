import path from "node:path";
import {
	MemorySharedStateManifest,
	type PiSubAgentDefinition,
	type RunSubAgentInput,
	RunSubAgentRunner,
	type RunSubAgentToolResult,
	type SharedStateManifest,
	type SubAgentAccessSurfaceDefinition,
	SubAgentRegistry,
} from "@earendil-works/pi-multi-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition, type ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput } from "../tools/render-utils.ts";
import { CodingAgentSessionFactory } from "./session-factory.ts";
import { createSharedStateTools } from "./shared-state-tools.ts";

const runSubAgentSchema = Type.Object({
	agentId: Type.String({ description: "Registered sub-agent id to invoke." }),
	task: Type.String({ description: "Task to run in the sub-agent." }),
	invocationId: Type.Optional(Type.String({ description: "Optional caller-provided invocation id." })),
	statePolicyOverride: Type.Optional(
		Type.Union([Type.Literal("ephemeral"), Type.Literal("session")], {
			description: "Optional state policy override for this invocation.",
		}),
	),
	timeoutMs: Type.Optional(Type.Number({ description: "Optional sub-agent invocation timeout in milliseconds." })),
});

type RunSubAgentToolInput = Static<typeof runSubAgentSchema>;

export interface CreateRunSubAgentToolOptions {
	cwd: string;
	agentDir?: string;
	definitions: PiSubAgentDefinition[];
	sharedStateRoot: string;
	manifest?: SharedStateManifest;
	maxConcurrentSubAgents?: number;
}

export interface RunSubAgentToolDetails extends RunSubAgentToolResult {}

export function createDemoSubAgentDefinitions(): PiSubAgentDefinition[] {
	return [
		{
			id: "pm-agent",
			name: "PM Agent",
			description: "Product manager sub-agent that maintains the PM PRD draft.",
			statePolicy: "session",
			systemPrompt:
				"You are pm-agent in a Shared State multi-agent workflow. Always use shared_state tools when asked to create, read, or update artifacts. Your owned artifact is exactly prd/pm.md. Keep it concise: 8-15 lines, not a full long PRD. When creating round 1 content, call shared_state.write for prd/pm.md. When updating round 2 content, first call shared_state.read for analysis/engineering.md, then call shared_state.edit or shared_state.write for prd/pm.md. Do not edit analysis/engineering.md or summary/final.md. End your reply with the exact path you wrote.",
			accessSurfaces: [
				{
					type: "shared_state",
					grants: [
						{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"] },
						{ space: "analysis", permissions: ["list", "read", "grep"] },
						{ space: "summary", permissions: ["list", "read", "grep"] },
					],
				},
			],
		},
		{
			id: "engineering-agent",
			name: "Engineering Agent",
			description: "Engineering sub-agent that maintains implementation analysis.",
			statePolicy: "session",
			systemPrompt:
				"You are engineering-agent in a Shared State multi-agent workflow. Always use shared_state tools when asked to create, read, or update artifacts. Your owned artifact is exactly analysis/engineering.md. Keep it concise: 8-15 lines, focused on implementation feasibility, risks, and dependencies. When creating round 1 content, call shared_state.write for analysis/engineering.md. When updating round 2 content, first call shared_state.read for prd/pm.md, then call shared_state.edit or shared_state.write for analysis/engineering.md. Do not edit prd/pm.md or summary/final.md. End your reply with the exact path you wrote.",
			accessSurfaces: [
				{
					type: "shared_state",
					grants: [
						{ space: "prd", permissions: ["list", "read", "grep"] },
						{ space: "analysis", permissions: ["list", "read", "grep", "write", "edit"] },
						{ space: "summary", permissions: ["list", "read", "grep"] },
					],
				},
			],
		},
		{
			id: "synthesis-agent",
			name: "Synthesis Agent",
			description: "Synthesis sub-agent that reads shared artifacts and writes the final summary.",
			statePolicy: "ephemeral",
			systemPrompt:
				"You are synthesis-agent in a Shared State multi-agent workflow. Always read prd/pm.md and analysis/engineering.md with shared_state.read before writing. Then call shared_state.write for exactly summary/final.md. Keep summary/final.md concise: 8-15 lines with final decision, product summary, engineering constraints, and next steps. Do not edit prd/pm.md or analysis/engineering.md. End your reply with the exact path summary/final.md.",
			accessSurfaces: [
				{
					type: "shared_state",
					grants: [
						{ space: "prd", permissions: ["list", "read", "grep"] },
						{ space: "analysis", permissions: ["list", "read", "grep"] },
						{ space: "summary", permissions: ["list", "read", "grep", "write", "edit"] },
					],
				},
			],
		},
	];
}

export function defaultSharedStateRoot(cwd: string, sessionId: string): string {
	return path.join(cwd, ".pi", "multi-agent", "shared-state", sessionId);
}

export function createRunSubAgentTool(options: CreateRunSubAgentToolOptions): ToolDefinition {
	const manifest = options.manifest ?? new MemorySharedStateManifest();
	const registry = new SubAgentRegistry();
	for (const definition of options.definitions) registry.register(definition);
	let runner: RunSubAgentRunner | undefined;

	return defineTool({
		name: "run_subagent",
		label: "run_subagent",
		description:
			"Run a registered Pi sub-agent. Sub-agents have isolated sessions and only explicitly granted capabilities such as shared_state tools. For multi-round Shared State work, call sub-agents in explicit rounds and require them to write concise artifacts to their assigned paths.",
		promptSnippet: "Run registered sub-agents with isolated sessions and explicit Shared State access",
		promptGuidelines: [
			"Use run_subagent when the user asks to delegate work to pm-agent, engineering-agent, synthesis-agent, or another registered sub-agent.",
			"For Shared State collaboration, do not ask sub-agents for long prose in the tool result; ask them to write concise artifacts and return the path they changed.",
			"For the demo agents, use this order: round 1 pm-agent writes prd/pm.md and engineering-agent writes analysis/engineering.md; round 2 pm-agent reads analysis/engineering.md and updates prd/pm.md, then engineering-agent reads prd/pm.md and updates analysis/engineering.md; final synthesis-agent reads both and writes summary/final.md.",
			"Do not run a dependent sub-agent before the artifact it needs exists. If the user asks for multiple rounds, wait for each round's run_subagent results before starting the next dependent round.",
			"Always require concise artifacts, roughly 8-15 lines, unless the user explicitly asks for a long document.",
		],
		parameters: runSubAgentSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params: RunSubAgentToolInput, signal, _onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Sub-agent invocation aborted");
			if (!ctx.model) throw new Error("Cannot run sub-agent without an active model");
			runner ??= new RunSubAgentRunner({
				registry,
				sessionFactory: new CodingAgentSessionFactory({ modelRegistry: ctx.modelRegistry }),
				cwd: options.cwd,
				agentDir: options.agentDir,
				maxConcurrentSubAgents: options.maxConcurrentSubAgents,
				createAccessSurfaceTools: ({ definition, accessSurface }) =>
					createToolsForAccessSurface(options.sharedStateRoot, manifest, definition, accessSurface),
			});
			const result = await runner.run({
				...(params as RunSubAgentInput),
				model: ctx.model,
				thinkingLevel: ctx.model.reasoning ? undefined : "off",
			});
			return { content: [{ type: "text", text: formatResult(result) }], details: { result } };
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

function createToolsForAccessSurface(
	root: string,
	manifest: SharedStateManifest,
	definition: PiSubAgentDefinition,
	accessSurface: SubAgentAccessSurfaceDefinition,
): ToolDefinition[] {
	if (accessSurface.type !== "shared_state") {
		throw new Error(`Unsupported SubAgent access surface: ${(accessSurface as { type: string }).type}`);
	}
	return createSharedStateTools({ root, agentId: definition.id, grants: accessSurface.grants, manifest });
}

function formatResult(result: RunSubAgentToolResult["result"]): string {
	const durationMs = Math.max(0, result.endedAt - result.startedAt);
	const header = [
		`status: ${result.status}`,
		`agentId: ${result.agentId}`,
		`sessionId: ${result.sessionId}`,
		`startedAt: ${formatTimestamp(result.startedAt)}`,
		`endedAt: ${formatTimestamp(result.endedAt)}`,
		`durationMs: ${durationMs}`,
		`messages: ${result.messageCountBefore}->${result.messageCountAfter}`,
	];
	const body = result.finalText ? `\n\n${result.finalText}` : "";
	const error = result.errorMessage ? `\n\nerror: ${result.errorMessage}` : "";
	return `${header.join("\n")}${body}${error}`;
}

function formatTimestamp(timestampMs: number): string {
	return new Date(timestampMs).toISOString();
}

function formatRunSubAgentCall(args: RunSubAgentToolInput | undefined): string {
	const agentId = typeof args?.agentId === "string" ? args.agentId : "[invalid agent]";
	const task = typeof args?.task === "string" ? args.task : "[invalid task]";
	const trimmed = task.length > 72 ? `${task.slice(0, 69)}...` : task;
	return `run_subagent ${agentId}: ${trimmed}`;
}

function formatRunSubAgentResult(
	result: { content: Array<{ type: string; text?: string }> },
	options: ToolRenderResultOptions,
): string {
	const output = getTextOutput(result, false).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : 24;
	const visible = lines.slice(0, maxLines).join("\n");
	const remaining = lines.length - maxLines;
	return remaining > 0 ? `${visible}\n... (${remaining} more lines)` : visible;
}
