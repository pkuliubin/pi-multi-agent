import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
	SharedStateArtifact,
	SharedStateGrant,
	SharedStateManifest,
	SharedStatePermission,
} from "@earendil-works/pi-multi-agent";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "../extensions/types.ts";
import {
	createEditToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "../tools/index.ts";

const mutationLocks = new Map<string, Promise<void>>();

async function withSharedStateMutationLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
	const previous = mutationLocks.get(path) ?? Promise.resolve();
	let release = () => {};
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const chained = previous.then(() => current);
	mutationLocks.set(path, chained);
	await previous;
	try {
		return await fn();
	} finally {
		release();
		if (mutationLocks.get(path) === chained) mutationLocks.delete(path);
	}
}

function readExistingFile(path: string): string | undefined {
	return existsSync(path) ? readFileSync(path, "utf-8") : undefined;
}

function restoreFile(path: string, previous: string | undefined): void {
	if (previous === undefined) {
		if (existsSync(path)) rmSync(path, { force: true });
		return;
	}
	writeFileSync(path, previous, "utf-8");
}

const sharedStateListSchema = Type.Object({
	path: Type.Optional(
		Type.String({ description: "Shared state space or directory to list. Defaults to granted spaces." }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return." })),
});

const sharedStateReadSchema = Type.Object({
	path: Type.String({ description: "Shared state file path, e.g. prd/requirements.md" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read." })),
});

const sharedStateGrepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)." }),
	path: Type.Optional(Type.String({ description: "Shared state space, directory, or file to search." })),
	glob: Type.Optional(Type.String({ description: "Filter files by glob pattern." })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search." })),
	literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string." })),
	context: Type.Optional(Type.Number({ description: "Number of context lines around each match." })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches." })),
});

const sharedStateWriteSchema = Type.Object({
	path: Type.String({ description: "Shared state file path, e.g. prd/requirements.md" }),
	content: Type.String({ description: "Full file content to write." }),
	expectedVersion: Type.Optional(Type.Number({ description: "Expected current manifest version." })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

const sharedStateEditSchema = Type.Object({
	path: Type.String({ description: "Shared state file path, e.g. prd/requirements.md" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({ description: "Exact text to replace." }),
			newText: Type.String({ description: "Replacement text." }),
		}),
	),
	expectedVersion: Type.Optional(Type.Number({ description: "Expected current manifest version." })),
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

type SharedStateListInput = {
	path?: string;
	limit?: number;
};

type SharedStateReadInput = {
	path: string;
	offset?: number;
	limit?: number;
};

type SharedStateGrepInput = {
	pattern: string;
	path?: string;
	glob?: string;
	ignoreCase?: boolean;
	literal?: boolean;
	context?: number;
	limit?: number;
};

type SharedStateWriteInput = {
	path: string;
	content: string;
	expectedVersion?: number;
	metadata?: Record<string, unknown>;
};

type SharedStateEditInput = {
	path: string;
	edits: Array<{ oldText: string; newText: string }>;
	expectedVersion?: number;
	metadata?: Record<string, unknown>;
};

export interface CreateSharedStateToolsOptions {
	root: string;
	agentId: string;
	grants: SharedStateGrant[];
	manifest: SharedStateManifest;
}

interface NormalizedAccess {
	path: string;
	space: string;
	grant: SharedStateGrant;
}

function normalizeRoot(root: string): string {
	return path.resolve(root);
}

function normalizeSharedPath(inputPath: string | undefined, options?: { allowEmpty?: boolean }): string {
	const raw = inputPath ?? "";
	if (raw.length === 0 && options?.allowEmpty) return "";
	if (raw.length === 0) throw new Error("Shared state path is required");
	if (raw.startsWith("~")) throw new Error(`Shared state path must be relative: ${raw}`);
	if (path.isAbsolute(raw)) throw new Error(`Shared state path must be relative: ${raw}`);
	const normalized = path.posix.normalize(raw.replace(/\\/g, "/"));
	if (/^[A-Za-z]:\//.test(normalized)) throw new Error(`Shared state path must be relative: ${raw}`);
	if (normalized === "." && options?.allowEmpty) return "";
	if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
		throw new Error(`Shared state path escapes the workspace: ${raw}`);
	}
	return normalized;
}

function ensureInsideRoot(root: string, relativePath: string): string {
	const absolutePath = path.resolve(root, relativePath);
	const relative = path.relative(root, absolutePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Shared state path escapes the workspace: ${relativePath}`);
	}
	return absolutePath;
}

function getSpace(relativePath: string): string {
	const [space] = relativePath.split("/");
	if (!space) throw new Error("Shared state path must start with a space name");
	return space;
}

function findGrant(grants: SharedStateGrant[], space: string): SharedStateGrant | undefined {
	return grants.find((grant) => grant.space === space);
}

function hasPermission(grant: SharedStateGrant, permission: SharedStatePermission): boolean {
	return grant.permissions.includes(permission);
}

function assertPermission(
	grant: SharedStateGrant | undefined,
	permission: SharedStatePermission,
	space: string,
): SharedStateGrant {
	if (!grant || !hasPermission(grant, permission)) {
		throw new Error(`Shared state permission denied for ${permission} on space ${space}`);
	}
	return grant;
}

function normalizeAccess(
	root: string,
	grants: SharedStateGrant[],
	inputPath: string | undefined,
	permission: SharedStatePermission,
	options?: { allowEmpty?: boolean },
): NormalizedAccess {
	const relativePath = normalizeSharedPath(inputPath, options);
	if (!relativePath) throw new Error("Shared state path is required");
	const space = getSpace(relativePath);
	const grant = assertPermission(findGrant(grants, space), permission, space);
	ensureInsideRoot(root, relativePath);
	return { path: relativePath, space, grant };
}

function authorizedSpaces(grants: SharedStateGrant[], permission: SharedStatePermission): string[] {
	return grants.filter((grant) => hasPermission(grant, permission)).map((grant) => grant.space);
}

function assertCanOverwrite(agentId: string, grant: SharedStateGrant, artifact: SharedStateArtifact): void {
	if (!hasPermission(grant, "edit")) {
		throw new Error(`Shared state permission denied for edit on space ${artifact.space}`);
	}
	if (artifact.ownerAgentId !== agentId && !grant.canOverwrite) {
		throw new Error(`Shared state artifact is owned by ${artifact.ownerAgentId}: ${artifact.path}`);
	}
}

function assertCanEdit(agentId: string, grant: SharedStateGrant, artifact: SharedStateArtifact): void {
	if (!hasPermission(grant, "edit")) {
		throw new Error(`Shared state permission denied for edit on space ${artifact.space}`);
	}
	if (artifact.ownerAgentId !== agentId && !grant.canEditOthers) {
		throw new Error(`Shared state artifact is owned by ${artifact.ownerAgentId}: ${artifact.path}`);
	}
}

function formatArtifactList(artifacts: SharedStateArtifact[]): string {
	if (artifacts.length === 0) return "(empty)";
	return artifacts
		.map((artifact) =>
			[
				artifact.path,
				`owner=${artifact.ownerAgentId}`,
				`version=${artifact.version}`,
				`updatedBy=${artifact.updatedBy}`,
			].join("\t"),
		)
		.join("\n");
}

function getTextContent(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

function mergeGrepOutputs(outputs: string[], limit: number | undefined): string {
	const lines = outputs
		.filter((output) => output && output !== "No matches found")
		.flatMap((output) => output.split("\n"));
	if (lines.length === 0) return "No matches found";
	if (limit === undefined) return lines.join("\n");
	const effectiveLimit = Math.max(1, limit);
	return lines.slice(0, effectiveLimit).join("\n");
}

export function createSharedStateTools(options: CreateSharedStateToolsOptions): ToolDefinition[] {
	const root = normalizeRoot(options.root);
	mkdirSync(root, { recursive: true });

	const listTool = createLsToolDefinition(root);
	const readTool = createReadToolDefinition(root);
	const grepTool = createGrepToolDefinition(root);
	const writeTool = createWriteToolDefinition(root);
	const editTool = createEditToolDefinition(root);

	return [
		defineTool({
			...listTool,
			name: "shared_state.list",
			label: "shared_state.list",
			description: "List files or artifact metadata in the shared state workspace.",
			promptSnippet: "List authorized shared state spaces and files",
			parameters: sharedStateListSchema,
			async execute(toolCallId, params: SharedStateListInput, signal, onUpdate, ctx) {
				if (!params.path) {
					const spaces = authorizedSpaces(options.grants, "list");
					const artifacts = spaces.flatMap((space) => options.manifest.list(space));
					const limited = params.limit === undefined ? artifacts : artifacts.slice(0, Math.max(0, params.limit));
					return { content: [{ type: "text", text: formatArtifactList(limited) }], details: undefined };
				}
				const access = normalizeAccess(root, options.grants, params.path, "list");
				return listTool.execute(toolCallId, { path: access.path, limit: params.limit }, signal, onUpdate, ctx);
			},
		}),
		defineTool({
			...readTool,
			name: "shared_state.read",
			label: "shared_state.read",
			description: "Read a file from an authorized shared state space.",
			promptSnippet: "Read shared state files by path, with optional line ranges",
			parameters: sharedStateReadSchema,
			async execute(toolCallId, params: SharedStateReadInput, signal, onUpdate, ctx) {
				const access = normalizeAccess(root, options.grants, params.path, "read");
				return readTool.execute(
					toolCallId,
					{ path: access.path, offset: params.offset, limit: params.limit },
					signal,
					onUpdate,
					ctx,
				);
			},
		}),
		defineTool({
			...grepTool,
			name: "shared_state.grep",
			label: "shared_state.grep",
			description: "Search files in an authorized shared state space.",
			promptSnippet: "Search shared state files by text or regex",
			parameters: sharedStateGrepSchema,
			async execute(toolCallId, params: SharedStateGrepInput, signal, onUpdate, ctx) {
				if (!params.path) {
					const spaces = authorizedSpaces(options.grants, "grep");
					if (spaces.length === 0) throw new Error("Shared state permission denied for grep");
					const results = await Promise.allSettled(
						spaces.map((space) =>
							grepTool.execute(
								toolCallId,
								{
									...params,
									path: space,
									limit: params.limit === undefined ? undefined : Math.max(1, params.limit),
								},
								signal,
								onUpdate,
								ctx,
							),
						),
					);
					const outputs = results
						.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof grepTool.execute>>> => {
							return result.status === "fulfilled";
						})
						.map((result) => getTextContent(result.value));
					const failures = results.filter((result) => result.status === "rejected");
					if (outputs.length === 0 && failures.length > 0) {
						throw failures[0]?.reason;
					}
					return {
						content: [
							{
								type: "text",
								text: mergeGrepOutputs(outputs, params.limit),
							},
						],
						details: undefined,
					};
				}
				const access = normalizeAccess(root, options.grants, params.path, "grep");
				return grepTool.execute(toolCallId, { ...params, path: access.path }, signal, onUpdate, ctx);
			},
		}),
		defineTool({
			...writeTool,
			name: "shared_state.write",
			label: "shared_state.write",
			description: "Create or overwrite a file in an authorized shared state space.",
			promptSnippet: "Create or fully rewrite shared state files",
			parameters: sharedStateWriteSchema,
			async execute(toolCallId, params: SharedStateWriteInput, signal, onUpdate, ctx) {
				const access = normalizeAccess(root, options.grants, params.path, "write");
				const absolutePath = ensureInsideRoot(root, access.path);
				return withSharedStateMutationLock(absolutePath, async () => {
					const current = options.manifest.get(access.path);
					if (current) {
						assertCanOverwrite(options.agentId, access.grant, current);
						if (params.expectedVersion !== undefined && params.expectedVersion !== current.version) {
							throw new Error(
								`Shared state version mismatch for ${access.path}: expected ${params.expectedVersion}, got ${current.version}`,
							);
						}
					} else if (params.expectedVersion !== undefined) {
						throw new Error(`Shared state artifact not found for expectedVersion: ${access.path}`);
					}
					const previousContent = readExistingFile(absolutePath);
					const result = await writeTool.execute(
						toolCallId,
						{ path: access.path, content: params.content },
						signal,
						onUpdate,
						ctx,
					);
					try {
						if (current) {
							options.manifest.update({
								path: access.path,
								agentId: options.agentId,
								expectedVersion: params.expectedVersion,
								metadata: params.metadata,
							});
						} else {
							options.manifest.create({
								path: access.path,
								space: access.space,
								agentId: options.agentId,
								metadata: params.metadata,
							});
						}
					} catch (error) {
						restoreFile(absolutePath, previousContent);
						throw error;
					}
					return result;
				});
			},
		}),
		defineTool({
			...editTool,
			name: "shared_state.edit",
			label: "shared_state.edit",
			description: "Edit a file in an authorized shared state space using exact text replacement.",
			promptSnippet: "Make precise edits to shared state files",
			parameters: sharedStateEditSchema,
			async execute(toolCallId, params: SharedStateEditInput, signal, onUpdate, ctx) {
				const access = normalizeAccess(root, options.grants, params.path, "edit");
				const absolutePath = ensureInsideRoot(root, access.path);
				return withSharedStateMutationLock(absolutePath, async () => {
					const current = options.manifest.get(access.path);
					if (!current) throw new Error(`Shared state artifact not found: ${access.path}`);
					assertCanEdit(options.agentId, access.grant, current);
					if (params.expectedVersion !== undefined && params.expectedVersion !== current.version) {
						throw new Error(
							`Shared state version mismatch for ${access.path}: expected ${params.expectedVersion}, got ${current.version}`,
						);
					}
					const previousContent = readExistingFile(absolutePath);
					const result = await editTool.execute(
						toolCallId,
						{ path: access.path, edits: params.edits },
						signal,
						onUpdate,
						ctx,
					);
					try {
						options.manifest.update({
							path: access.path,
							agentId: options.agentId,
							expectedVersion: params.expectedVersion,
							metadata: params.metadata,
						});
					} catch (error) {
						restoreFile(absolutePath, previousContent);
						throw error;
					}
					return result;
				});
			},
		}),
	];
}
