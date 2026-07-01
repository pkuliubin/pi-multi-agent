import { posix } from "node:path";
import { invalidRequest } from "../errors.ts";

export function normalizeArtifactPath(path: string): string {
	const trimmed = path.trim();
	if (!trimmed) throw invalidRequest("Artifact path must not be empty");
	if (trimmed.startsWith("/") || /^[A-Za-z]:/.test(trimmed)) {
		throw invalidRequest("Artifact path must be relative");
	}
	const normalized = posix.normalize(trimmed.replaceAll("\\", "/"));
	if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw invalidRequest("Artifact path escapes shared-state root");
	}
	return normalized;
}
