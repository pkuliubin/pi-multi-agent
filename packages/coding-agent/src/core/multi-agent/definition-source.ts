import type { PiSubAgentDefinition } from "@earendil-works/pi-multi-agent";

export type SubAgentDefinitionSource = "file";

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
	return { definitions: input.loadedDefinitions, definitionSource: "file" };
}
