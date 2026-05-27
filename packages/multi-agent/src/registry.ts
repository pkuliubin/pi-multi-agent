import type { PiSubAgentDefinition } from "./types.ts";

export class SubAgentRegistry {
	private readonly definitions = new Map<string, PiSubAgentDefinition>();

	register(definition: PiSubAgentDefinition): void {
		if (this.definitions.has(definition.id)) {
			throw new Error(`SubAgent definition already registered: ${definition.id}`);
		}
		this.definitions.set(definition.id, definition);
	}

	get(id: string): PiSubAgentDefinition | undefined {
		return this.definitions.get(id);
	}

	list(): PiSubAgentDefinition[] {
		return [...this.definitions.values()];
	}
}
