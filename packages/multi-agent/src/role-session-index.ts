import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { PiSubAgentDefinition, SubAgentPhase } from "./types.ts";

const INDEX_VERSION = 1;

export interface SubAgentDefinitionIdentity {
	source: "file" | "demo" | "custom";
	fingerprint: string;
	sourcePath?: string;
}

export interface RoleSessionBindingKey {
	mainSessionId: string;
	agentId: string;
	definitionIdentity: SubAgentDefinitionIdentity;
}

export interface RoleSessionBinding extends RoleSessionBindingKey {
	subAgentSessionId: string;
	subAgentSessionFile: string;
	state: Extract<SubAgentPhase, "idle" | "running" | "closed">;
	createdAt: string;
	updatedAt: string;
}

interface RoleSessionIndexFile {
	version: number;
	bindings: RoleSessionBinding[];
}

export interface UpsertRoleSessionBindingInput extends RoleSessionBindingKey {
	subAgentSessionId: string;
	subAgentSessionFile: string;
	state?: RoleSessionBinding["state"];
	now?: string;
}

export class FileRoleSessionIndex {
	private readonly indexPath: string;

	constructor(indexPath: string) {
		this.indexPath = resolve(indexPath);
	}

	get path(): string {
		return this.indexPath;
	}

	find(key: RoleSessionBindingKey): RoleSessionBinding | undefined {
		const data = this.read();
		const binding = data.bindings.find((candidate) => sameBindingKey(candidate, key));
		return binding ? cloneBinding(binding) : undefined;
	}

	list(mainSessionId?: string): RoleSessionBinding[] {
		const bindings = this.read().bindings;
		return bindings
			.filter((binding) => mainSessionId === undefined || binding.mainSessionId === mainSessionId)
			.map((binding) => cloneBinding(binding));
	}

	upsert(input: UpsertRoleSessionBindingInput): RoleSessionBinding {
		const now = input.now ?? new Date().toISOString();
		const data = this.read();
		const existingIndex = data.bindings.findIndex((binding) => sameBindingKey(binding, input));
		const current = existingIndex >= 0 ? data.bindings[existingIndex] : undefined;
		const next: RoleSessionBinding = {
			mainSessionId: input.mainSessionId,
			agentId: input.agentId,
			definitionIdentity: cloneDefinitionIdentity(input.definitionIdentity),
			subAgentSessionId: input.subAgentSessionId,
			subAgentSessionFile: input.subAgentSessionFile,
			state: input.state ?? current?.state ?? "idle",
			createdAt: current?.createdAt ?? now,
			updatedAt: now,
		};
		if (existingIndex >= 0) {
			data.bindings[existingIndex] = next;
		} else {
			data.bindings.push(next);
		}
		this.write(data);
		return cloneBinding(next);
	}

	updateState(key: RoleSessionBindingKey, state: RoleSessionBinding["state"], now = new Date().toISOString()): void {
		const data = this.read();
		const binding = data.bindings.find((candidate) => sameBindingKey(candidate, key));
		if (!binding) return;
		binding.state = state;
		binding.updatedAt = now;
		this.write(data);
	}

	private read(): RoleSessionIndexFile {
		if (!existsSync(this.indexPath)) return { version: INDEX_VERSION, bindings: [] };
		const raw = readFileSync(this.indexPath, "utf-8").trim();
		if (!raw) return { version: INDEX_VERSION, bindings: [] };
		const parsed = JSON.parse(raw) as Partial<RoleSessionIndexFile>;
		return {
			version: INDEX_VERSION,
			bindings: Array.isArray(parsed.bindings) ? parsed.bindings.filter(isRoleSessionBinding).map(cloneBinding) : [],
		};
	}

	private write(data: RoleSessionIndexFile): void {
		const dir = dirname(this.indexPath);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileAtomic(
			this.indexPath,
			`${JSON.stringify({ version: INDEX_VERSION, bindings: data.bindings }, null, 2)}\n`,
		);
	}
}

export function createDefinitionIdentity(
	definition: PiSubAgentDefinition,
	definitionSource: "file" | "demo" | "custom" = inferDefinitionSource(definition),
): SubAgentDefinitionIdentity {
	const sourcePath = typeof definition.metadata?.sourcePath === "string" ? definition.metadata.sourcePath : undefined;
	const fingerprint = hashJson({
		id: definition.id,
		statePolicy: definition.statePolicy,
		systemPrompt: definition.systemPrompt,
		accessSurfaces: definition.accessSurfaces,
		sourcePath,
	});
	return { source: definitionSource, fingerprint, sourcePath };
}

export function defaultRoleSessionIndexPath(cwd: string): string {
	return resolve(cwd, ".pi", "multi-agent", "role-sessions.json");
}

function inferDefinitionSource(definition: PiSubAgentDefinition): "file" | "demo" | "custom" {
	return typeof definition.metadata?.sourcePath === "string" ? "file" : "custom";
}

function sameBindingKey(a: RoleSessionBindingKey, b: RoleSessionBindingKey): boolean {
	return (
		a.mainSessionId === b.mainSessionId &&
		a.agentId === b.agentId &&
		a.definitionIdentity.source === b.definitionIdentity.source &&
		a.definitionIdentity.fingerprint === b.definitionIdentity.fingerprint &&
		(a.definitionIdentity.sourcePath ?? "") === (b.definitionIdentity.sourcePath ?? "")
	);
}

function hashJson(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cloneBinding(binding: RoleSessionBinding): RoleSessionBinding {
	return {
		...binding,
		definitionIdentity: cloneDefinitionIdentity(binding.definitionIdentity),
	};
}

function cloneDefinitionIdentity(identity: SubAgentDefinitionIdentity): SubAgentDefinitionIdentity {
	return { ...identity };
}

function isRoleSessionBinding(value: unknown): value is RoleSessionBinding {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.mainSessionId === "string" &&
		typeof candidate.agentId === "string" &&
		typeof candidate.subAgentSessionId === "string" &&
		typeof candidate.subAgentSessionFile === "string" &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string" &&
		(candidate.state === "idle" || candidate.state === "running" || candidate.state === "closed") &&
		isDefinitionIdentity(candidate.definitionIdentity)
	);
}

function isDefinitionIdentity(value: unknown): value is SubAgentDefinitionIdentity {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		(candidate.source === "file" || candidate.source === "demo" || candidate.source === "custom") &&
		typeof candidate.fingerprint === "string" &&
		(candidate.sourcePath === undefined || typeof candidate.sourcePath === "string")
	);
}

function writeFileAtomic(filePath: string, data: string): void {
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(tempPath, data, "utf-8");
	renameSync(tempPath, filePath);
}
