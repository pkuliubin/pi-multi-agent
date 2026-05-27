import type { AgentSessionFactory, CreateSubAgentSessionInput } from "@earendil-works/pi-multi-agent";
import type { ModelRegistry } from "../model-registry.ts";
import { createAgentSession } from "../sdk.ts";
import { SessionManager } from "../session-manager.ts";
import { type AdaptedAgentSessionLike, adaptAgentSession } from "./agent-session-adapter.ts";
import { RestrictedSubAgentResourceLoader } from "./restricted-resource-loader.ts";

export interface CodingAgentSessionFactoryOptions {
	modelRegistry?: ModelRegistry;
}

export class CodingAgentSessionFactory implements AgentSessionFactory {
	private readonly modelRegistry?: ModelRegistry;

	constructor(options: CodingAgentSessionFactoryOptions = {}) {
		this.modelRegistry = options.modelRegistry;
	}

	async create(input: CreateSubAgentSessionInput): Promise<AdaptedAgentSessionLike> {
		assertNoUnsupportedDefinitionResources(input.definition.metadata);

		const { session } = await createAgentSession({
			cwd: input.cwd,
			agentDir: input.agentDir,
			model: input.model,
			thinkingLevel: input.thinkingLevel,
			modelRegistry: this.modelRegistry,
			sessionManager: SessionManager.inMemory(input.cwd),
			resourceLoader: new RestrictedSubAgentResourceLoader({ systemPrompt: input.definition.systemPrompt }),
			noTools: "all",
			sessionStartEvent: { type: "session_start", reason: "startup" },
		});

		return adaptAgentSession(session);
	}
}

function assertNoUnsupportedDefinitionResources(metadata: Record<string, unknown> | undefined): void {
	if (!metadata) return;
	const unsupportedKeys = ["tools", "skills", "mcp", "accessSurfaces"];
	const present = unsupportedKeys.filter((key) => metadata[key] !== undefined);
	if (present.length > 0) {
		throw new Error(`SubAgent definition resources are not supported in this phase: ${present.join(", ")}`);
	}
}
