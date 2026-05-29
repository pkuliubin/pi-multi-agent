import { stat } from "node:fs/promises";
import { join } from "node:path";
import {
	defaultSharedStateManifestPath,
	FileSharedStateManifest,
	type SharedStateArtifact,
} from "@earendil-works/pi-multi-agent";
import type { SharedStateArtifactEntry, SharedStateManifestResponse } from "../contract.ts";

export async function readSharedStateManifest(root: string | null): Promise<SharedStateManifestResponse> {
	if (!root) return { root: null, artifacts: [] };
	const manifest = new FileSharedStateManifest(defaultSharedStateManifestPath(root));
	const artifacts = await Promise.all(manifest.list().map((artifact) => toArtifactEntry(root, artifact)));
	return { root, artifacts };
}

export async function toArtifactEntry(root: string, artifact: SharedStateArtifact): Promise<SharedStateArtifactEntry> {
	const filePath = join(root, artifact.path);
	const stats = await stat(filePath).catch(() => null);
	return {
		path: artifact.path,
		space: artifact.space,
		ownerAgentId: artifact.ownerAgentId,
		version: artifact.version,
		createdBy: artifact.createdBy,
		updatedBy: artifact.updatedBy,
		createdAt: artifact.createdAt,
		updatedAt: artifact.updatedAt,
		sizeBytes: stats?.size ?? null,
		mimeType: mimeTypeForPath(artifact.path),
		metadata: artifact.metadata ?? {},
	};
}

export function mimeTypeForPath(path: string): string | null {
	if (path.endsWith(".json")) return "application/json";
	if (path.endsWith(".md")) return "text/markdown";
	if (path.endsWith(".txt")) return "text/plain";
	if (path.endsWith(".html")) return "text/html";
	if (path.endsWith(".csv")) return "text/csv";
	return null;
}
