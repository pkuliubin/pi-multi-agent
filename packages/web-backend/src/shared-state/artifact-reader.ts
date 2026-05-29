import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defaultSharedStateManifestPath, FileSharedStateManifest } from "@earendil-works/pi-multi-agent";
import type { ArtifactContent, SharedStateArtifactResponse } from "../contract.ts";
import { artifactNotFound } from "../errors.ts";
import { mimeTypeForPath, toArtifactEntry } from "./manifest-reader.ts";
import { normalizeArtifactPath } from "./path-safety.ts";

const MAX_TEXT_BYTES = 512 * 1024;

export async function readSharedStateArtifact(
	root: string | null,
	requestedPath: string,
): Promise<SharedStateArtifactResponse> {
	if (!root) throw artifactNotFound(requestedPath);
	const artifactPath = normalizeArtifactPath(requestedPath);
	const manifest = new FileSharedStateManifest(defaultSharedStateManifestPath(root));
	const artifact = manifest.get(artifactPath);
	if (!artifact) throw artifactNotFound(artifactPath);
	const filePath = join(root, artifactPath);
	const stats = await stat(filePath).catch(() => null);
	if (!stats?.isFile()) throw artifactNotFound(artifactPath);
	const mimeType = mimeTypeForPath(artifactPath);
	const content = await readArtifactContent(filePath, stats.size, mimeType);
	return {
		path: artifactPath,
		artifact: await toArtifactEntry(root, artifact),
		content,
	};
}

async function readArtifactContent(
	filePath: string,
	sizeBytes: number,
	mimeType: string | null,
): Promise<ArtifactContent> {
	if (!isTextMimeType(mimeType) && !filePath.endsWith(".json")) {
		return { kind: "binary-unsupported", sizeBytes, mimeType, truncated: false };
	}
	const buffer = await readFile(filePath);
	const truncated = buffer.byteLength > MAX_TEXT_BYTES;
	const text = buffer.subarray(0, MAX_TEXT_BYTES).toString("utf8");
	if (mimeType === "application/json" || filePath.endsWith(".json")) {
		try {
			return { kind: "json", json: JSON.parse(text) as unknown, text, sizeBytes, mimeType, truncated };
		} catch {
			return { kind: "text", text, sizeBytes, mimeType, truncated };
		}
	}
	return { kind: "text", text, sizeBytes, mimeType, truncated };
}

function isTextMimeType(mimeType: string | null): boolean {
	return mimeType !== null && (mimeType.startsWith("text/") || mimeType === "application/json");
}
