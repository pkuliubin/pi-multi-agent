import type {
	SharedStateArtifact,
	SharedStateCreateInput,
	SharedStateManifest,
	SharedStateUpdateInput,
} from "./types.ts";

export class MemorySharedStateManifest implements SharedStateManifest {
	private readonly artifacts = new Map<string, SharedStateArtifact>();

	get(path: string): SharedStateArtifact | undefined {
		return this.artifacts.get(path);
	}

	create(input: SharedStateCreateInput): SharedStateArtifact {
		if (this.artifacts.has(input.path)) {
			throw new Error(`Shared state artifact already exists: ${input.path}`);
		}
		const now = input.now ?? new Date().toISOString();
		const artifact: SharedStateArtifact = {
			path: input.path,
			space: input.space,
			ownerAgentId: input.ownerAgentId ?? input.agentId,
			createdBy: input.agentId,
			updatedBy: input.agentId,
			version: 1,
			createdAt: now,
			updatedAt: now,
			metadata: input.metadata,
		};
		this.artifacts.set(input.path, artifact);
		return artifact;
	}

	update(input: SharedStateUpdateInput): SharedStateArtifact {
		const current = this.artifacts.get(input.path);
		if (!current) {
			throw new Error(`Shared state artifact not found: ${input.path}`);
		}
		if (input.expectedVersion !== undefined && input.expectedVersion !== current.version) {
			throw new Error(
				`Shared state version mismatch for ${input.path}: expected ${input.expectedVersion}, got ${current.version}`,
			);
		}
		const now = input.now ?? new Date().toISOString();
		const next: SharedStateArtifact = {
			...current,
			updatedBy: input.agentId,
			version: current.version + 1,
			updatedAt: now,
			metadata: input.metadata ?? current.metadata,
		};
		this.artifacts.set(input.path, next);
		return next;
	}

	list(space?: string): SharedStateArtifact[] {
		return Array.from(this.artifacts.values()).filter((artifact) => !space || artifact.space === space);
	}
}
