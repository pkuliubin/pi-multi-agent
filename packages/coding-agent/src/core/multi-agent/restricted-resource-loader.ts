import { createExtensionRuntime } from "../extensions/loader.ts";
import type { LoadExtensionsResult } from "../extensions/types.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "../resource-loader.ts";
import type { Skill } from "../skills.ts";

export class RestrictedSubAgentResourceLoader implements ResourceLoader {
	private readonly extensionsResult: LoadExtensionsResult = {
		extensions: [],
		errors: [],
		runtime: createExtensionRuntime(),
	};
	private readonly systemPrompt: string | undefined;
	private readonly skills: Skill[];

	constructor(options: { systemPrompt?: string; skills?: Skill[] } = {}) {
		this.systemPrompt = options.systemPrompt;
		this.skills = options.skills ?? [];
	}

	getExtensions(): LoadExtensionsResult {
		return this.extensionsResult;
	}

	getSkills(): ReturnType<ResourceLoader["getSkills"]> {
		return { skills: this.skills, diagnostics: [] };
	}

	getPrompts(): ReturnType<ResourceLoader["getPrompts"]> {
		return { prompts: [], diagnostics: [] };
	}

	getThemes(): ReturnType<ResourceLoader["getThemes"]> {
		return { themes: [], diagnostics: [] };
	}

	getSubAgents(): ReturnType<ResourceLoader["getSubAgents"]> {
		return { agents: [], diagnostics: [] };
	}

	getAgentsFiles(): ReturnType<ResourceLoader["getAgentsFiles"]> {
		return { agentsFiles: [] };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return [];
	}

	extendResources(_paths: ResourceExtensionPaths): void {}

	async reload(): Promise<void> {}
}
