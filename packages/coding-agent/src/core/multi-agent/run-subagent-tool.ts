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
	type SubAgentObservabilityBatch,
	type SubAgentObservabilityEvent,
	SubAgentRegistry,
} from "@earendil-works/pi-multi-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { defineTool, type ToolDefinition, type ToolRenderResultOptions } from "../extensions/types.ts";
import type { Skill } from "../skills.ts";
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
	timeoutMs: Type.Optional(
		Type.Number({
			description:
				"Optional sub-agent invocation timeout in milliseconds. Omit this for complex work; short positive values are raised to the runtime minimum.",
		}),
	),
});

type RunSubAgentToolInput = Static<typeof runSubAgentSchema>;

export interface CreateRunSubAgentToolOptions {
	cwd: string;
	agentDir?: string;
	definitions: PiSubAgentDefinition[];
	sharedStateRoot?: string;
	definitionSource?: "file" | "custom";
	manifest?: SharedStateManifest;
	mainSessionId?: string;
	sessionDir?: string;
	roleSessionIndexPath?: string;
	maxConcurrentSubAgents?: number;
	skills?: Skill[];
}

export interface RunSubAgentToolDetails extends RunSubAgentToolResult {}

interface RunSubAgentToolDetailsWithRoot extends RunSubAgentToolResult {
	sharedStateRoot: string;
	definitionSource: "file" | "custom";
	progress: RunSubAgentProgressSummary;
	artifactVerification: ArtifactVerificationSummary;
	observability?: SubAgentObservabilityBatch;
}

interface ObservabilityState {
	nextSequence: number;
}

interface ArtifactVerificationState {
	verifiedArtifacts: Set<string>;
	pendingMutationPaths: Map<string, string>;
}

interface ArtifactVerificationSummary {
	verifiedArtifacts: string[];
	unverifiedArtifactClaims: string[];
}

const MAX_DELTA_CHARS = 4096;
const MAX_PREVIEW_CHARS = 500;
const MIN_SUB_AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const SHARED_STATE_MUTATION_TOOLS = new Set([
	"shared_state.write",
	"shared_state.edit",
	"shared_state_write",
	"shared_state_edit",
]);

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

function sharedStatePathFromEvent(event: SubAgentEventEnvelope["event"]): string | undefined {
	if (event.type !== "tool_execution_start" && event.type !== "tool_execution_end") return undefined;
	if (!SHARED_STATE_MUTATION_TOOLS.has(String(event.toolName))) return undefined;
	const args = event.args;
	if (!args || typeof args !== "object") return undefined;
	const pathValue = (args as Record<string, unknown>).path;
	return typeof pathValue === "string" ? normalizeArtifactClaim(pathValue) : undefined;
}

function recordVerifiedArtifact(envelope: SubAgentEventEnvelope, state: ArtifactVerificationState): void {
	const event = envelope.event;
	if (event.type === "tool_execution_start") {
		const artifactPath = sharedStatePathFromEvent(event);
		if (artifactPath) state.pendingMutationPaths.set(String(event.toolCallId), artifactPath);
		return;
	}
	if (event.type !== "tool_execution_end") return;
	const toolCallId = String(event.toolCallId);
	const artifactPath = sharedStatePathFromEvent(event) ?? state.pendingMutationPaths.get(toolCallId);
	state.pendingMutationPaths.delete(toolCallId);
	if (!event.isError && artifactPath) state.verifiedArtifacts.add(artifactPath);
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
	artifactVerification?: ArtifactVerificationSummary,
): RunSubAgentProgressSummary {
	return {
		...progress,
		currentPhase: result.status,
		activeTool: undefined,
		lastAssistantPreview: result.finalText ? truncatePreview(result.finalText) : progress.lastAssistantPreview,
		verifiedArtifacts: artifactVerification?.verifiedArtifacts,
		unverifiedArtifactClaims: artifactVerification?.unverifiedArtifactClaims,
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

function normalizeRunSubAgentInput(params: RunSubAgentToolInput): RunSubAgentInput {
	const input = params as RunSubAgentInput;
	if (input.timeoutMs === undefined || input.timeoutMs <= 0) return input;
	return { ...input, timeoutMs: Math.max(input.timeoutMs, MIN_SUB_AGENT_TIMEOUT_MS) };
}

function createObservabilityBatch(events: SubAgentObservabilityEvent[]): SubAgentObservabilityBatch | undefined {
	if (events.length === 0) return undefined;
	return {
		sequenceStart: events[0]?.sequence ?? null,
		sequenceEnd: events.at(-1)?.sequence ?? null,
		events,
	};
}

function observabilityEventFromEnvelope(
	envelope: SubAgentEventEnvelope,
	state: ObservabilityState,
): SubAgentObservabilityEvent | undefined {
	const event = envelope.event;
	const base = {
		agentId: envelope.agentId,
		sessionId: envelope.sessionId,
		invocationId: envelope.invocationId ?? null,
		sequence: state.nextSequence++,
		timestamp: new Date().toISOString(),
	};
	if (event.type === "agent_start") return { ...base, type: "agent.started" };
	if (event.type === "agent_end") return undefined;
	if (event.type === "message_update") {
		const delta = textDeltaFromAssistantEvent(event.assistantMessageEvent);
		if (delta === null) return undefined;
		const bounded = delta.length > MAX_DELTA_CHARS ? delta.slice(0, MAX_DELTA_CHARS) : delta;
		return {
			...base,
			type: "agent.message.delta",
			messageId: messageIdFromMessage(event.message, base.sequence),
			delta: bounded,
			truncated: bounded.length < delta.length || undefined,
		};
	}
	if (event.type === "message_end") {
		const fullText = assistantTextFromEnvelope(envelope);
		if (!fullText) return undefined;
		const messageId = messageIdFromMessage(event.message, base.sequence);
		return {
			...base,
			type: "agent.message.completed",
			messageId,
			preview: truncateSummary(fullText, MAX_PREVIEW_CHARS),
			fullTextRef: { kind: "session_message", sessionId: envelope.sessionId, messageId },
		};
	}
	if (
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	) {
		const isEnd = event.type === "tool_execution_end";
		return {
			...base,
			type:
				event.type === "tool_execution_start"
					? "agent.tool.started"
					: event.type === "tool_execution_update"
						? "agent.tool.updated"
						: "agent.tool.completed",
			toolName: String(event.toolName),
			toolCallId: String(event.toolCallId),
			argsSummary: summarizeToolArgs(event),
			resultSummary: isEnd ? summarizeToolResult(event) : summarizePartialToolResult(event),
			status: isEnd ? (event.isError ? "failed" : "completed") : "running",
		};
	}
	return undefined;
}

function finalObservabilityEvent(
	result: RunSubAgentToolResult["result"],
	state: ObservabilityState,
): SubAgentObservabilityEvent {
	const type =
		result.status === "completed"
			? "agent.completed"
			: result.status === "aborted"
				? "agent.aborted"
				: "agent.failed";
	return {
		type,
		agentId: result.agentId,
		sessionId: result.sessionId,
		invocationId: result.invocationId ?? null,
		sequence: state.nextSequence++,
		timestamp: new Date(result.endedAt).toISOString(),
	};
}

function textDeltaFromAssistantEvent(event: unknown): string | null {
	if (typeof event !== "object" || event === null || !("type" in event)) return null;
	const record = event as Record<string, unknown>;
	if (record.type === "thinking_delta") return "";
	if (record.type !== "text_delta") return null;
	return typeof record.delta === "string" ? record.delta : null;
}

function messageIdFromMessage(message: unknown, fallbackSequence: number): string {
	if (typeof message === "object" && message !== null) {
		const record = message as Record<string, unknown>;
		if (typeof record.responseId === "string") return record.responseId;
		if (typeof record.toolCallId === "string") return record.toolCallId;
		if (typeof record.timestamp === "number") return `message-${record.timestamp}`;
	}
	return `message-${fallbackSequence}`;
}

function summarizePartialToolResult(event: SubAgentEventEnvelope["event"]): string | undefined {
	if (event.type !== "tool_execution_update") return undefined;
	const partialResult = event.partialResult as { content?: Array<{ type: string; text?: string }> } | undefined;
	const text = partialResult?.content
		?.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n")
		.trim();
	return text ? truncateSummary(text, 100) : undefined;
}

function normalizeArtifactClaim(value: string): string | undefined {
	const trimmed = value.trim().replace(/^`+|`+$/g, "");
	if (!trimmed || trimmed.startsWith("~") || path.isAbsolute(trimmed)) return undefined;
	const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || /^[A-Za-z]:\//.test(normalized)) {
		return undefined;
	}
	if (!normalized.includes("/")) return undefined;
	return normalized;
}

function extractArtifactClaims(text: string | undefined): string[] {
	if (!text) return [];
	const claims = new Set<string>();
	const artifactPattern =
		/(?:`([^`\s]+?\.(?:md|markdown|txt|json|jsonl|yaml|yml))`|([A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+?\.(?:md|markdown|txt|json|jsonl|yaml|yml)))/g;
	for (const match of text.matchAll(artifactPattern)) {
		const normalized = normalizeArtifactClaim(match[1] ?? match[2] ?? "");
		if (normalized) claims.add(normalized);
	}
	return Array.from(claims);
}

function summarizeArtifactVerification(
	result: RunSubAgentToolResult["result"],
	state: ArtifactVerificationState,
): ArtifactVerificationSummary {
	const verifiedArtifacts = Array.from(state.verifiedArtifacts).sort();
	const verified = new Set(verifiedArtifacts);
	const unverifiedArtifactClaims = extractArtifactClaims(result.finalText)
		.filter((claim) => !verified.has(claim))
		.sort();
	return { verifiedArtifacts, unverifiedArtifactClaims };
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
					skills: options.skills,
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
			const observabilityState: ObservabilityState = { nextSequence: 1 };
			const artifactVerificationState: ArtifactVerificationState = {
				verifiedArtifacts: new Set(),
				pendingMutationPaths: new Map(),
			};
			const emitProgress = (events: SubAgentObservabilityEvent[] = []) => {
				const observability = createObservabilityBatch(events);
				onUpdate?.({
					content: [{ type: "text", text: formatRunSubAgentProgress(progress) }],
					details: observability ? { progress, observability } : { progress },
				});
				lastEmitted = progress;
			};
			const result = await runner.run(
				{
					...normalizeRunSubAgentInput(params),
					model: ctx.model,
					thinkingLevel: ctx.model.reasoning ? undefined : "off",
				},
				{
					onEvent: (envelope) => {
						recordVerifiedArtifact(envelope, artifactVerificationState);
						const observabilityEvent = observabilityEventFromEnvelope(envelope, observabilityState);
						const next = reduceProgressSummary(progress, envelope);
						if (next === progress) {
							if (observabilityEvent) emitProgress([observabilityEvent]);
							return;
						}
						progress = next;
						if (progressSnapshotChanged(progress, lastEmitted) || observabilityEvent) {
							emitProgress(observabilityEvent ? [observabilityEvent] : []);
						}
					},
				},
			);
			const artifactVerification = summarizeArtifactVerification(result, artifactVerificationState);
			progress =
				result.errorCode === "SUB_AGENT_BUSY"
					? busyProgressSummary(result)
					: finalProgressSummary(progress, result, artifactVerification);
			const finalEvent = finalObservabilityEvent(result, observabilityState);
			if (progressSnapshotChanged(progress, lastEmitted) || finalEvent) emitProgress([finalEvent]);
			return {
				content: [
					{
						type: "text",
						text: formatResult(result, sharedStateRoot, definitionSource, progress, artifactVerification),
					},
				],
				details: {
					result,
					sharedStateRoot,
					definitionSource,
					progress,
					artifactVerification,
					observability: createObservabilityBatch([finalEvent]),
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

function inferDefinitionSource(definitions: PiSubAgentDefinition[]): "file" | "custom" {
	if (
		definitions.length > 0 &&
		definitions.every((definition) => typeof definition.metadata?.sourcePath === "string")
	) {
		return "file";
	}
	return "custom";
}

function buildPromptGuidelines(definitions: PiSubAgentDefinition[], _definitionSource: "file" | "custom"): string[] {
	const agentList = definitions
		.map((definition) => {
			const description = definition.description ? ` — ${definition.description}` : "";
			return `${definition.id}${description}`;
		})
		.join("; ");
	const accessList = formatAgentSharedStateAccess(definitions);
	return [
		`<multi_agent_coordination>
Use run_subagent when delegation to a registered role runtime adds clear value. Registered sub-agents: ${agentList || "none"}.
Choose sub-agents by their registered descriptions and the user's goal, not by hardcoded role names.
If a registered sub-agent's description clearly matches a meaningful part of the user's task, prefer delegating that part to the sub-agent instead of doing a weaker version in the main agent.
Do not use sub-agents for simple questions, tiny edits, or work the main agent can handle directly.
When invoking multiple sub-agents, first decide whether they need shared context. If yes, prepare a concise shared brief containing the user's goal, relevant repo paths or files, existing Shared State artifacts, known constraints, and expected outputs. Pass this same brief to each sub-agent to reduce duplicated context gathering and improve consistency.
Do not over-plan simple tasks. Only prepare a shared brief when it will materially reduce duplicated work or improve sub-agent output quality.
Run independent sub-agent calls in parallel when useful. If one call depends on another's Shared State artifact, run them in explicit rounds and wait for the dependency to exist before starting the dependent call.
Do not set timeoutMs for normal or complex sub-agent work. If a timeout is truly necessary, use a generous value; the runtime raises short positive timeouts to at least ${MIN_SUB_AGENT_TIMEOUT_MS}ms.
After sub-agent work finishes, use the returned status and Shared State artifacts to give the user a concise final synthesis.</multi_agent_coordination>`,
		`<shared_state_protocol>
Shared State is logical team memory for reusable multi-agent artifacts, not repository files and not a place for throwaway prose.
For collaborative work, ask sub-agents to inspect relevant existing Shared State, create or update compact reusable artifacts, and return concise status plus changed logical paths.
Sub-agent Shared State write spaces are: ${accessList}. When asking a sub-agent to write an artifact, choose a logical path under one of that sub-agent's writable spaces. Do not force every role into analysis/; use each role's declared write space.
Shared State logical paths must be accessed through shared_state.* tools inside sub-agents. Do not treat paths like prd/... or analysis/... as cwd-relative repo paths unless you explicitly combine them with the sharedStateRoot shown in a run_subagent result.
Prefer updating existing relevant artifacts over creating duplicates. Keep artifacts concise unless the user explicitly asks for a long document.</shared_state_protocol>`,
		`<sub_agent_tool_boundaries>
Sub-agents can use ordinary read, grep, find, and ls tools for read-only filesystem inspection using the same cwd and absolute path behavior as the main session.
Sub-agents do not have ordinary write, edit, or bash tools by default; ask them to write collaboration artifacts through their shared_state.* tools.
The run_subagent tool result is a status channel, not the primary artifact store. Avoid asking sub-agents to return long prose only in the tool result.</sub_agent_tool_boundaries>`,
	];
}

function formatAgentSharedStateAccess(definitions: PiSubAgentDefinition[]): string {
	if (definitions.length === 0) return "(none)";
	return definitions
		.map((definition) => {
			const writeSpaces = writableSharedStateSpaces(definition);
			const spaceList = writeSpaces.length > 0 ? writeSpaces.join(", ") : "(none)";
			return `${definition.id}: writableSpaces=[${spaceList}]`;
		})
		.join("; ");
}

function writableSharedStateSpaces(definition: PiSubAgentDefinition): string[] {
	const spaces = new Set<string>();
	for (const surface of definition.accessSurfaces ?? []) {
		if (surface.type !== "shared_state") continue;
		for (const grant of surface.grants) {
			if (grant.permissions.includes("write") || grant.permissions.includes("edit")) {
				spaces.add(grant.space);
			}
		}
	}
	return Array.from(spaces).sort();
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
	definitionSource: "file" | "custom",
	progress?: RunSubAgentProgressSummary,
	artifactVerification?: ArtifactVerificationSummary,
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
		...(artifactVerification && artifactVerification.verifiedArtifacts.length > 0
			? [`verifiedArtifacts: ${artifactVerification.verifiedArtifacts.join(", ")}`]
			: []),
		...(artifactVerification && artifactVerification.unverifiedArtifactClaims.length > 0
			? [
					`unverifiedArtifactClaims: ${artifactVerification.unverifiedArtifactClaims.join(", ")}`,
					"warning: sub-agent claimed Shared State artifacts without observed successful shared_state.write/edit",
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
