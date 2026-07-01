import type {
	AgentSessionFactory,
	CreateSubAgentSessionInput,
	RoleSessionBinding,
} from "@earendil-works/pi-multi-agent";
import type { ToolDefinition } from "../extensions/types.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import type { Skill } from "../skills.ts";
import { createReadOnlyToolDefinitions } from "../tools/index.ts";
import { type AdaptedAgentSessionLike, adaptAgentSession } from "./agent-session-adapter.ts";
import { RestrictedSubAgentResourceLoader } from "./restricted-resource-loader.ts";

export interface CodingAgentSessionFactoryOptions {
	modelRegistry?: ModelRegistry;
	skills?: Skill[];
	sessionDir?: string;
	resolveSessionManager?: (input: CreateSubAgentSessionInput) => SessionManager;
	resolveRoleSessionBinding?: (input: CreateSubAgentSessionInput) => RoleSessionBinding | undefined;
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
	return tools;
}

function getSubAgentCustomTools(input: CreateSubAgentSessionInput): ToolDefinition[] {
	const readOnlyTools = createReadOnlyToolDefinitions(input.cwd);
	const capabilityTools = getCapabilityTools(input) ?? [];
	const tools = [...readOnlyTools, ...capabilityTools];
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
	assertUniqueToolNames(tools);
	return tools;
}

function getDefinitionSkillNames(definition: CreateSubAgentSessionInput["definition"]): string[] {
	const value = definition.metadata?.skills;
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

function selectSkillsForDefinition(skills: Skill[], definition: CreateSubAgentSessionInput["definition"]): Skill[] {
	const skillNames = getDefinitionSkillNames(definition);
	if (skillNames.length === 0) return [];
	const allowed = new Set(skillNames);
	return skills.filter((skill) => allowed.has(skill.name));
}

export class CodingAgentSessionFactory implements AgentSessionFactory {
	private readonly modelRegistry?: ModelRegistry;
	private readonly skills: Skill[];
	private readonly sessionDir?: string;
	private readonly resolveSessionManager?: (input: CreateSubAgentSessionInput) => SessionManager;
	private readonly resolveRoleSessionBinding?: (input: CreateSubAgentSessionInput) => RoleSessionBinding | undefined;

	constructor(options: CodingAgentSessionFactoryOptions = {}) {
		this.modelRegistry = options.modelRegistry;
		this.skills = options.skills ?? [];
		this.sessionDir = options.sessionDir;
		this.resolveSessionManager = options.resolveSessionManager;
		this.resolveRoleSessionBinding = options.resolveRoleSessionBinding;
	}

	async create(input: CreateSubAgentSessionInput): Promise<AdaptedAgentSessionLike> {
		assertNoUnsupportedDefinitionResources(input.definition.metadata);

		const customTools = getSubAgentCustomTools(input);

		const { session } = await createAgentSession({
			cwd: input.cwd,
			agentDir: input.agentDir,
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			modelRegistry: this.modelRegistry,
			sessionManager: this.createSessionManager(input),
			resourceLoader: new RestrictedSubAgentResourceLoader({
				systemPrompt: input.definition.systemPrompt,
				skills: selectSkillsForDefinition(this.skills, input.definition),
			}),
			customTools,
			noTools: "all",
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});

		return adaptAgentSession(session);
	}

	private createSessionManager(input: CreateSubAgentSessionInput): SessionManager {
		if (this.resolveSessionManager) return this.resolveSessionManager(input);
		if (input.sessionPolicy === "session" && input.roleSession?.mainSessionId) {
			const binding = this.resolveRoleSessionBinding?.(input);
			if (binding) return SessionManager.open(binding.subAgentSessionFile, this.sessionDir, input.cwd);
			return SessionManager.create(input.cwd, this.sessionDir);
		}
		return SessionManager.inMemory(input.cwd);
	}
}

function assertNoUnsupportedDefinitionResources(metadata: Record<string, unknown> | undefined): void {
	if (!metadata) return;
	const unsupportedKeys = ["tools", "mcp"];
	const present = unsupportedKeys.filter((key) => metadata[key] !== undefined);
	if (present.length > 0) {
		throw new Error(`SubAgent definition resources are not supported in this phase: ${present.join(", ")}`);
	}
}
