import type { AgentSessionFactory, CreateSubAgentSessionInput } from "@earendil-works/pi-multi-agent";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import { type AdaptedAgentSessionLike, adaptAgentSession } from "./agent-session-adapter.ts";
import { RestrictedSubAgentResourceLoader } from "./restricted-resource-loader.ts";

export interface CodingAgentSessionFactoryOptions {
	modelRegistry?: ModelRegistry;
}

function isToolDefinition(value: unknown): value is ToolDefinition {
	return (
		typeof value === "object" &&
		value !== null &&
		"name" in value &&
		"label" in value &&
		"description" in value &&
		"execute" in value &&
		typeof (value as { name: unknown }).name === "string" &&
		typeof (value as { label: unknown }).label === "string" &&
		typeof (value as { description: unknown }).description === "string" &&
		typeof (value as { execute: unknown }).execute === "function"
	);
}

function sanitizeOpenAiToolName(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function assertUniqueToolNames(tools: ToolDefinition[]): void {
	const seen = new Map<string, string>();
	for (const tool of tools) {
		const existing = seen.get(tool.name);
		if (existing) {
			throw new Error(`SubAgent capability tool name collision after sanitization: ${existing} and ${tool.name}`);
		}
		seen.set(tool.name, tool.name);
	}
}

function getCapabilityTools(input: CreateSubAgentSessionInput): ToolDefinition[] | undefined {
	const tools = input.capabilities?.tools;
	if (tools === undefined) {
		if (input.definition.accessSurfaces && input.definition.accessSurfaces.length > 0) {
			throw new Error("SubAgent accessSurfaces require runner-mounted capability tools");
		}
		return undefined;
	}
	if (!Array.isArray(tools)) {
		throw new Error("SubAgent capability tools must be an array of coding-agent ToolDefinition objects");
	}
	if (tools.length === 0) return undefined;
	if (!tools.every(isToolDefinition)) {
		throw new Error("SubAgent capability tools must be coding-agent ToolDefinition objects");
	}
	if (input.model?.api === "openai-completions") {
		const sanitizedTools = tools.map((tool) => {
			const sanitizedName = sanitizeOpenAiToolName(tool.name);
			return {
				...tool,
				name: sanitizedName,
				label: sanitizeOpenAiToolName(tool.label),
				description: `${tool.description} Use tool name ${sanitizedName} with OpenAI-compatible providers.`,
			};
		});
		assertUniqueToolNames(sanitizedTools);
		return sanitizedTools;
	}
	return tools;
}

export class CodingAgentSessionFactory implements AgentSessionFactory {
	private readonly modelRegistry?: ModelRegistry;

	constructor(options: CodingAgentSessionFactoryOptions = {}) {
		this.modelRegistry = options.modelRegistry;
	}

	async create(input: CreateSubAgentSessionInput): Promise<AdaptedAgentSessionLike> {
		assertNoUnsupportedDefinitionResources(input.definition.metadata);

		const customTools = getCapabilityTools(input);

		const { session } = await createAgentSession({
			cwd: input.cwd,
			agentDir: input.agentDir,
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			modelRegistry: this.modelRegistry,
			sessionManager: SessionManager.inMemory(input.cwd),
			resourceLoader: new RestrictedSubAgentResourceLoader({ systemPrompt: input.definition.systemPrompt }),
			customTools,
			noTools: "all",
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});

		return adaptAgentSession(session);
	}
}

function assertNoUnsupportedDefinitionResources(metadata: Record<string, unknown> | undefined): void {
	if (!metadata) return;
	const unsupportedKeys = ["tools", "skills", "mcp"];
	const present = unsupportedKeys.filter((key) => metadata[key] !== undefined);
	if (present.length > 0) {
		throw new Error(`SubAgent definition resources are not supported in this phase: ${present.join(", ")}`);
	}
}
