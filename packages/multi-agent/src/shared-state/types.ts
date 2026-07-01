export type SharedStatePermission = "list" | "read" | "grep" | "write" | "edit";

export interface SharedStateGrant {
	space: string;
	permissions: SharedStatePermission[];
	canOverwrite?: boolean;
	canEditOthers?: boolean;
}

export interface SharedStateAccessSurfaceDefinition {
	root?: string;
	runId?: string;
	agentId: string;
	grants: SharedStateGrant[];
	metadata?: Record<string, unknown>;
}

export interface SharedStateArtifact {
	path: string;
	space: string;
	ownerAgentId: string;
	createdBy: string;
	updatedBy: string;
	version: number;
	createdAt: string;
	updatedAt: string;
	metadata?: Record<string, unknown>;
}

export interface SharedStateCreateInput {
	path: string;
	space: string;
	agentId: string;
	ownerAgentId?: string;
	metadata?: Record<string, unknown>;
	now?: string;
}

export interface SharedStateUpdateInput {
	path: string;
	agentId: string;
	expectedVersion?: number;
	metadata?: Record<string, unknown>;
	now?: string;
}

export interface SharedStateManifest {
	get(path: string): SharedStateArtifact | undefined;
	create(input: SharedStateCreateInput): SharedStateArtifact;
	update(input: SharedStateUpdateInput): SharedStateArtifact;
	list(space?: string): SharedStateArtifact[];
}
