import type { PiSubAgentDefinition } from "@earendil-works/pi-multi-agent";
import { createDemoSubAgentDefinitions } from "./run-subagent-tool.ts";

export type SubAgentDefinitionSource = "file" | "demo";

export interface ResolveRunSubAgentDefinitionsInput {
	loadedDefinitions: PiSubAgentDefinition[];
}

export interface ResolveRunSubAgentDefinitionsResult {
	definitions: PiSubAgentDefinition[];
	definitionSource: SubAgentDefinitionSource;
}

export function resolveRunSubAgentDefinitions(
	input: ResolveRunSubAgentDefinitionsInput,
): ResolveRunSubAgentDefinitionsResult {
	if (input.loadedDefinitions.length > 0) {
		return { definitions: input.loadedDefinitions, definitionSource: "file" };
	}
	return { definitions: createDemoSubAgentDefinitions(), definitionSource: "demo" };
}
