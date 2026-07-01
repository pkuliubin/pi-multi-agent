import type {
	SharedStateArtifact,
	SharedStateCreateInput,
	SharedStateManifest,
	SharedStateUpdateInput,
} from "./types.ts";

export class MemorySharedStateManifest implements SharedStateManifest {
	private readonly artifacts = new Map<string, SharedStateArtifact>();

	constructor(artifacts: SharedStateArtifact[] = []) {
		for (const artifact of artifacts) {
			this.artifacts.set(artifact.path, cloneArtifact(artifact));
		}
	}

	get(path: string): SharedStateArtifact | undefined {
		const artifact = this.artifacts.get(path);
		return artifact ? cloneArtifact(artifact) : undefined;
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
		return cloneArtifact(artifact);
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
		return cloneArtifact(next);
	}

	list(space?: string): SharedStateArtifact[] {
		return Array.from(this.artifacts.values())
			.filter((artifact) => !space || artifact.space === space)
			.map((artifact) => cloneArtifact(artifact));
	}
}

function cloneArtifact(artifact: SharedStateArtifact): SharedStateArtifact {
	return {
		...artifact,
		metadata: cloneMetadata(artifact.metadata),
	};
}

function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!metadata) return undefined;
	return cloneJsonValue(metadata) as Record<string, unknown>;
}

function cloneJsonValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => cloneJsonValue(item));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneJsonValue(item)]),
		);
	}
	return value;
}
