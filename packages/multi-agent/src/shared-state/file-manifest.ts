import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MemorySharedStateManifest } from "./memory-manifest.ts";
import type {
	SharedStateArtifact,
	SharedStateCreateInput,
	SharedStateManifest,
	SharedStateUpdateInput,
} from "./types.ts";

const MANIFEST_VERSION = 1;

interface SharedStateManifestFile {
	version: number;
	artifacts: SharedStateArtifact[];
}

export class FileSharedStateManifest implements SharedStateManifest {
	private readonly manifestPath: string;
	private readonly memory: MemorySharedStateManifest;

	constructor(manifestPath: string) {
		this.manifestPath = resolve(manifestPath);
		this.memory = new MemorySharedStateManifest(this.loadArtifacts());
	}

	get path(): string {
		return this.manifestPath;
	}

	get(path: string): SharedStateArtifact | undefined {
		return this.memory.get(path);
	}

	create(input: SharedStateCreateInput): SharedStateArtifact {
		const artifact = this.memory.create(input);
		this.persist();
		return artifact;
	}

	update(input: SharedStateUpdateInput): SharedStateArtifact {
		const artifact = this.memory.update(input);
		this.persist();
		return artifact;
	}

	list(space?: string): SharedStateArtifact[] {
		return this.memory.list(space);
	}

	private loadArtifacts(): SharedStateArtifact[] {
		if (!existsSync(this.manifestPath)) return [];
		const raw = readFileSync(this.manifestPath, "utf-8").trim();
		if (!raw) return [];
		const parsed = JSON.parse(raw) as Partial<SharedStateManifestFile>;
		return Array.isArray(parsed.artifacts) ? parsed.artifacts.filter(isSharedStateArtifact) : [];
	}

	private persist(): void {
		const dir = dirname(this.manifestPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		const data: SharedStateManifestFile = { version: MANIFEST_VERSION, artifacts: this.memory.list() };
		writeFileAtomic(this.manifestPath, `${JSON.stringify(data, null, 2)}\n`);
	}
}

export function defaultSharedStateManifestPath(root: string): string {
	return resolve(root, ".manifest.json");
}

function isSharedStateArtifact(value: unknown): value is SharedStateArtifact {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.path === "string" &&
		typeof candidate.space === "string" &&
		typeof candidate.ownerAgentId === "string" &&
		typeof candidate.createdBy === "string" &&
		typeof candidate.updatedBy === "string" &&
		typeof candidate.version === "number" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string" &&
		(candidate.metadata === undefined || (typeof candidate.metadata === "object" && candidate.metadata !== null))
	);
}

function writeFileAtomic(filePath: string, data: string): void {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tempPath, data, "utf-8");
	renameSync(tempPath, filePath);
}
