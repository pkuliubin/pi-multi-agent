import path from "node:path";
import {
	type CompactSubAgentEvent,
	defaultRoleSessionIndexPath,
	defaultSharedStateManifestPath,
	FileRoleSessionIndex,
	FileSharedStateManifest,
	type PiSubAgentDefinition,
	type RunSubAgentInput,
	type RunSubAgentProgressSummary,
	RunSubAgentRunner,
	type RunSubAgentToolResult,
	type SharedStateManifest,
	type SubAgentAccessSurfaceDefinition,
	type SubAgentEventEnvelope,
	SubAgentRegistry,
} from "@earendil-works/pi-multi-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition, type ToolRenderResultOptions } from "../extensions/types.ts";
import { getTextOutput } from "../tools/render-utils.ts";
import { CodingSubAgentLifecycleStore } from "./role-session-store.ts";
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
	sharedStateRoot?: string;
	definitionSource?: "file" | "demo" | "custom";
	manifest?: SharedStateManifest;
	mainSessionId?: string;
	sessionDir?: string;
	roleSessionIndexPath?: string;
	maxConcurrentSubAgents?: number;
}

export interface RunSubAgentToolDetails extends RunSubAgentToolResult {}

interface RunSubAgentToolDetailsWithRoot extends RunSubAgentToolResult {
	sharedStateRoot: string;
	definitionSource: "file" | "demo" | "custom";
	progress: RunSubAgentProgressSummary;
}

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

function defaultSharedStateRootForTool(options: CreateRunSubAgentToolOptions): string {
	if (!options.mainSessionId) {
		throw new Error("sharedStateRoot is required when mainSessionId is not provided");
	}
	return defaultSharedStateRoot(options.cwd, options.mainSessionId);
}

function truncatePreview(text: string, maxLength = 160): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function isAssistantTextMessage(
	value: unknown,
): value is { role: "assistant"; content: Array<{ type: string; text?: string }> } {
	return (
		typeof value === "object" &&
		value !== null &&
		"role" in value &&
		(value as { role: unknown }).role === "assistant" &&
		"content" in value &&
		Array.isArray((value as { content: unknown }).content)
	);
}

function assistantTextFromEnvelope(envelope: SubAgentEventEnvelope): string | undefined {
	const event = envelope.event;
	if (event.type !== "message_end") return undefined;
	const message = event.message;
	if (!isAssistantTextMessage(message)) return undefined;
	const text = message.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n")
		.trim();
	return text || undefined;
}

function truncateSummary(text: string, maxLength: number): string {
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function summarizeToolArgs(event: SubAgentEventEnvelope["event"]): string | undefined {
	if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return undefined;
	const args = event.args;
	if (!args || typeof args !== "object") return undefined;
	const candidate = args as Record<string, unknown>;
	const parts: string[] = [];
	if (typeof candidate.path === "string") parts.push(`path=${candidate.path}`);
	if (typeof candidate.pattern === "string") parts.push(`pattern=${candidate.pattern}`);
	if (typeof candidate.content === "string") parts.push(`content=${candidate.content.length} chars`);
	if (Array.isArray(candidate.edits)) parts.push(`edits=${candidate.edits.length}`);
	if (typeof candidate.limit === "number") parts.push(`limit=${candidate.limit}`);
	if (parts.length === 0) return undefined;
	return truncateSummary(parts.join(" "), 100);
}

function summarizeToolResult(event: SubAgentEventEnvelope["event"]): string | undefined {
	if (event.type !== "tool_execution_end") return undefined;
	const result = event.result as { content?: Array<{ type: string; text?: string }> } | undefined;
	const text = result?.content
		?.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n")
		.trim();
	if (!text) return event.isError ? "error" : undefined;
	return truncateSummary(text, 100);
}

function toolErrorMessage(compact: CompactSubAgentEvent): string | undefined {
	if (compact.type !== "tool_execution_end" || !compact.isError) return undefined;
	return compact.resultSummary ?? "error";
}

function compactEventFromEnvelope(envelope: SubAgentEventEnvelope): CompactSubAgentEvent | undefined {
	const event = envelope.event;
	const timestamp = Date.now();
	if (event.type === "agent_start" || event.type === "agent_end") {
		return { type: event.type, timestamp };
	}
	if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
		return {
			type: event.type,
			toolName: String(event.toolName),
			toolCallId: String(event.toolCallId),
			timestamp,
			argsSummary: summarizeToolArgs(event),
			resultSummary: summarizeToolResult(event),
			args: "args" in event ? event.args : undefined,
			result: "result" in event ? event.result : undefined,
			isError: event.type === "tool_execution_end" ? Boolean(event.isError) || undefined : undefined,
		};
	}
	if (event.type === "message_end") {
		const fullText = assistantTextFromEnvelope(envelope);
		if (!fullText) return undefined;
		return { type: "message_end", preview: truncatePreview(fullText), fullText, timestamp };
	}
	return undefined;
}

function initialProgressSummary(): RunSubAgentProgressSummary {
	return {
		currentPhase: "starting",
		completedTools: [],
		eventCount: 0,
		recentEvents: [],
	};
}

function reduceProgressSummary(
	previous: RunSubAgentProgressSummary,
	envelope: SubAgentEventEnvelope,
): RunSubAgentProgressSummary {
	const compact = compactEventFromEnvelope(envelope);
	let currentPhase = previous.currentPhase;
	let activeTool = previous.activeTool;
	let completedTools = previous.completedTools;
	let internalToolErrors = previous.internalToolErrors;
	let lastToolError = previous.lastToolError;
	let lastAssistantPreview = previous.lastAssistantPreview;
	let eventCount = previous.eventCount;
	let recentEvents = previous.recentEvents;
	if (!compact) {
		return previous;
	}
	eventCount += 1;
	recentEvents = [...previous.recentEvents, compact].slice(-8);
	if (compact.type === "tool_execution_start") {
		currentPhase = "running";
		activeTool = { toolName: compact.toolName, toolCallId: compact.toolCallId };
	}
	if (compact.type === "tool_execution_end") {
		currentPhase = "running";
		completedTools = [
			...previous.completedTools,
			{ toolName: compact.toolName, toolCallId: compact.toolCallId, isError: compact.isError },
		];
		const errorMessage = toolErrorMessage(compact);
		if (errorMessage) {
			internalToolErrors = (previous.internalToolErrors ?? 0) + 1;
			lastToolError = { toolName: compact.toolName, toolCallId: compact.toolCallId, message: errorMessage };
		}
		if (activeTool?.toolCallId === compact.toolCallId) activeTool = undefined;
	}
	if (compact.type === "message_end") {
		currentPhase = "running";
		lastAssistantPreview = compact.preview;
	}
	return {
		currentPhase,
		activeTool,
		completedTools,
		internalToolErrors,
		lastToolError,
		lastAssistantPreview,
		eventCount,
		recentEvents,
	};
}

function finalProgressSummary(
	progress: RunSubAgentProgressSummary,
	result: RunSubAgentToolResult["result"],
): RunSubAgentProgressSummary {
	return {
		...progress,
		currentPhase: result.status,
		activeTool: undefined,
		lastAssistantPreview: result.finalText ? truncatePreview(result.finalText) : progress.lastAssistantPreview,
	};
}

function busyProgressSummary(result: RunSubAgentToolResult["result"]): RunSubAgentProgressSummary {
	return {
		currentPhase: "failed",
		completedTools: [],
		lastAssistantPreview: result.errorMessage ? truncatePreview(result.errorMessage) : undefined,
		eventCount: 0,
		recentEvents: [],
	};
}

function progressSnapshotChanged(a: RunSubAgentProgressSummary, b: RunSubAgentProgressSummary): boolean {
	return JSON.stringify(a) !== JSON.stringify(b);
}

export function createRunSubAgentTool(options: CreateRunSubAgentToolOptions): ToolDefinition {
	const sharedStateRoot = options.sharedStateRoot ?? defaultSharedStateRootForTool(options);
	const manifest = options.manifest ?? new FileSharedStateManifest(defaultSharedStateManifestPath(sharedStateRoot));
	const registry = new SubAgentRegistry();
	const definitionSource = options.definitionSource ?? inferDefinitionSource(options.definitions);
	for (const definition of options.definitions) registry.register(definition);
	let runner: RunSubAgentRunner | undefined;
	const lifecycleStore = options.mainSessionId
		? new CodingSubAgentLifecycleStore({
				index: new FileRoleSessionIndex(options.roleSessionIndexPath ?? defaultRoleSessionIndexPath(options.cwd)),
				cwd: options.cwd,
				sessionDir: options.sessionDir,
			})
		: undefined;

	return defineTool({
		name: "run_subagent",
		label: "run_subagent",
		description:
			"Run a registered Pi sub-agent. Sub-agents have isolated sessions, default read-only filesystem tools (read/grep/find/ls), and explicitly granted capabilities such as shared_state tools. For multi-round Shared State work, call sub-agents in explicit rounds and require them to write concise artifacts to their assigned paths.",
		promptSnippet:
			"Run registered sub-agents with isolated sessions, read-only filesystem tools, and explicit Shared State access",
		promptGuidelines: buildPromptGuidelines(options.definitions, definitionSource),
		parameters: runSubAgentSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params: RunSubAgentToolInput, signal, onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Sub-agent invocation aborted");
			if (!ctx.model) throw new Error("Cannot run sub-agent without an active model");
			runner ??= new RunSubAgentRunner({
				registry,
				sessionFactory: new CodingAgentSessionFactory({
					modelRegistry: ctx.modelRegistry,
					sessionDir: options.sessionDir,
					resolveRoleSessionBinding: (input) => lifecycleStore?.resolveBinding(input),
				}),
				cwd: options.cwd,
				agentDir: options.agentDir,
				maxConcurrentSubAgents: options.maxConcurrentSubAgents,
				mainSessionId: options.mainSessionId,
				definitionSource,
				lifecycleStore,
				createAccessSurfaceTools: ({ definition, accessSurface }) =>
					createToolsForAccessSurface(sharedStateRoot, manifest, definition, accessSurface),
			});
			let progress = initialProgressSummary();
			let lastEmitted = progress;
			const emitProgress = () => {
				onUpdate?.({
					content: [{ type: "text", text: formatRunSubAgentProgress(progress) }],
					details: { progress },
				});
				lastEmitted = progress;
			};
			const result = await runner.run(
				{
					...(params as RunSubAgentInput),
					model: ctx.model,
					thinkingLevel: ctx.model.reasoning ? undefined : "off",
				},
				{
					onEvent: (envelope) => {
						const next = reduceProgressSummary(progress, envelope);
						if (next === progress) return;
						progress = next;
						if (progressSnapshotChanged(progress, lastEmitted)) emitProgress();
					},
				},
			);
			progress =
				result.errorCode === "SUB_AGENT_BUSY"
					? busyProgressSummary(result)
					: finalProgressSummary(progress, result);
			if (progressSnapshotChanged(progress, lastEmitted)) emitProgress();
			return {
				content: [{ type: "text", text: formatResult(result, sharedStateRoot, definitionSource, progress) }],
				details: {
					result,
					sharedStateRoot,
					definitionSource,
					progress,
				} satisfies RunSubAgentToolDetailsWithRoot,
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

function inferDefinitionSource(definitions: PiSubAgentDefinition[]): "file" | "demo" | "custom" {
	if (
		definitions.length > 0 &&
		definitions.every((definition) => typeof definition.metadata?.sourcePath === "string")
	) {
		return "file";
	}
	const ids = new Set(definitions.map((definition) => definition.id));
	if (ids.size === 3 && ids.has("pm-agent") && ids.has("engineering-agent") && ids.has("synthesis-agent")) {
		return "demo";
	}
	return "custom";
}

function buildPromptGuidelines(
	definitions: PiSubAgentDefinition[],
	definitionSource: "file" | "demo" | "custom",
): string[] {
	const agentList = definitions
		.map((definition) => {
			const description = definition.description ? ` — ${definition.description}` : "";
			return `${definition.id}${description}`;
		})
		.join("; ");
	const hasDemoWorkflow = ["pm-agent", "engineering-agent", "synthesis-agent"].every((id) =>
		definitions.some((definition) => definition.id === id),
	);
	const guidelines = [
		`Use run_subagent when the user asks to delegate work to a registered sub-agent. Registered sub-agents: ${agentList || "none"}.`,
		"Sub-agents can use ordinary read, grep, find, and ls tools for read-only filesystem inspection using the same cwd and absolute path behavior as the main session.",
		"Sub-agents do not have ordinary write, edit, or bash tools by default; ask them to write collaboration artifacts through shared_state.* tools.",
		"For Shared State collaboration, do not ask sub-agents for long prose in the tool result; ask them to write concise artifacts and return the path they changed.",
		"Shared State paths such as prd/pm.md, analysis/engineering.md, and summary/final.md are logical artifact paths, not repository-relative paths. Do not use ordinary read/grep/find/ls tools on those logical paths unless you first combine them with the sharedStateRoot shown in the run_subagent result.",
		"Do not run a dependent sub-agent before the artifact it needs exists. If the user asks for multiple rounds, wait for each round's run_subagent results before starting the next dependent round.",
		"Always require concise artifacts, roughly 8-15 lines, unless the user explicitly asks for a long document.",
	];
	if (definitionSource === "demo" && hasDemoWorkflow) {
		guidelines.splice(
			3,
			0,
			"For the pm/engineering/synthesis workflow, use this order: round 1 pm-agent writes prd/pm.md and engineering-agent writes analysis/engineering.md; round 2 pm-agent reads analysis/engineering.md and updates prd/pm.md, then engineering-agent reads prd/pm.md and updates analysis/engineering.md; final synthesis-agent reads both and writes summary/final.md.",
		);
	}
	return guidelines;
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

function formatResult(
	result: RunSubAgentToolResult["result"],
	sharedStateRoot: string,
	definitionSource: "file" | "demo" | "custom",
	progress?: RunSubAgentProgressSummary,
): string {
	const durationMs = Math.max(0, result.endedAt - result.startedAt);
	const header = [
		`status: ${result.status}`,
		`agentId: ${result.agentId}`,
		`sessionId: ${result.sessionId}`,
		`sharedStateRoot: ${sharedStateRoot}`,
		`definitionSource: ${definitionSource}`,
		...(result.errorCode ? [`errorCode: ${result.errorCode}`] : []),
		`startedAt: ${formatTimestamp(result.startedAt)}`,
		`endedAt: ${formatTimestamp(result.endedAt)}`,
		`durationMs: ${durationMs}`,
		`messages: ${result.messageCountBefore}->${result.messageCountAfter}`,
		...(progress?.internalToolErrors ? [`internalToolErrors: ${progress.internalToolErrors}`] : []),
		...(progress?.lastToolError
			? [
					`lastToolError: ${progress.lastToolError.toolName} (${progress.lastToolError.toolCallId}) — ${progress.lastToolError.message}`,
				]
			: []),
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

function formatRunSubAgentProgress(progress: RunSubAgentProgressSummary): string {
	const lines = [
		`phase: ${progress.currentPhase}`,
		`events: ${progress.eventCount}`,
		`completedTools: ${progress.completedTools.length}`,
	];
	if (progress.activeTool) {
		lines.push(`activeTool: ${progress.activeTool.toolName} (${progress.activeTool.toolCallId})`);
	}
	if (progress.lastAssistantPreview) {
		lines.push(`assistant: ${progress.lastAssistantPreview}`);
	}
	if (progress.internalToolErrors) {
		lines.push(`internalToolErrors: ${progress.internalToolErrors}`);
	}
	if (progress.lastToolError) {
		lines.push(
			`lastToolError: ${progress.lastToolError.toolName} (${progress.lastToolError.toolCallId}) — ${progress.lastToolError.message}`,
		);
	}
	for (const event of progress.recentEvents) {
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
			let line = `${event.type}: ${event.toolName}`;
			if (event.argsSummary) line += ` — ${event.argsSummary}`;
			if (event.resultSummary) line += ` => ${event.resultSummary}`;
			if (event.isError) line += " error";
			lines.push(line);
		} else if (event.type === "message_end") {
			lines.push(`message_end: ${event.preview}`);
		} else {
			lines.push(event.type);
		}
	}
	return lines.join("\n");
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
