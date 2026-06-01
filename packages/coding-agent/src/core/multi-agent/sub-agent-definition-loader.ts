import { readFileSync } from "node:fs";
import type {
	PiSubAgentDefinition,
	SharedStateGrant,
	SharedStatePermission,
	SubAgentAccessSurfaceDefinition,
	SubAgentStatePolicy,
} from "@earendil-works/pi-multi-agent";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import type { SourceInfo } from "../source-info.ts";

const SHARED_STATE_PERMISSIONS: SharedStatePermission[] = ["list", "read", "grep", "write", "edit"];
const SHARED_STATE_TOOL_PREFIX = "shared_state.";
const SUPPORTED_STATE_POLICIES: SubAgentStatePolicy[] = ["ephemeral", "session"];

interface AgentFrontmatter extends Record<string, unknown> {
	id?: unknown;
	name?: unknown;
	description?: unknown;
	statePolicy?: unknown;
	model?: unknown;
	color?: unknown;
	tools?: unknown;
	accessSurfaces?: unknown;
	grants?: unknown;
	sharedState?: unknown;
}

export interface SubAgentDefinitionResource {
	definition: PiSubAgentDefinition;
	filePath: string;
	sourceInfo?: SourceInfo;
}

export interface LoadSubAgentDefinitionsResult {
	agents: SubAgentDefinitionResource[];
	diagnostics: ResourceDiagnostic[];
}

export function loadSubAgentDefinitionsFromPaths(
	paths: string[],
	sourceInfoByPath?: Map<string, SourceInfo>,
): LoadSubAgentDefinitionsResult {
	const agents: SubAgentDefinitionResource[] = [];
	const diagnostics: ResourceDiagnostic[] = [];

	for (const filePath of paths) {
		try {
			const loaded = parseSubAgentDefinition(readFileSync(filePath, "utf-8"), filePath);
			diagnostics.push(...loaded.diagnostics);
			if (loaded.definition) {
				agents.push({ definition: loaded.definition, filePath, sourceInfo: sourceInfoByPath?.get(filePath) });
			}
		} catch (error) {
			diagnostics.push({
				type: "error",
				message: error instanceof Error ? error.message : "failed to load agent definition",
				path: filePath,
			});
		}
	}

	return dedupeSubAgentDefinitions(agents, diagnostics);
}

export function parseSubAgentDefinition(
	content: string,
	filePath: string,
): { definition?: PiSubAgentDefinition; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	let parsed: ReturnType<typeof parseFrontmatter<AgentFrontmatter>>;
	try {
		parsed = parseFrontmatter<AgentFrontmatter>(content);
	} catch (error) {
		return {
			diagnostics: [
				{
					type: "error",
					message: error instanceof Error ? error.message : "invalid agent frontmatter",
					path: filePath,
				},
			],
		};
	}

	const id = readNonEmptyString(parsed.frontmatter.id) ?? readNonEmptyString(parsed.frontmatter.name);
	if (!id) {
		diagnostics.push({ type: "error", message: "Agent definition requires frontmatter id or name", path: filePath });
	}

	const systemPrompt = parsed.body.trim();
	if (!systemPrompt) {
		diagnostics.push({ type: "error", message: "Agent definition body must not be empty", path: filePath });
	}

	const statePolicy = parseStatePolicy(parsed.frontmatter.statePolicy, filePath, diagnostics);
	const accessSurfaces = parseAccessSurfaces(parsed.frontmatter, filePath, diagnostics);

	if (!id || !systemPrompt || !statePolicy) return { diagnostics };

	const metadata: Record<string, unknown> = { sourcePath: filePath };
	if (typeof parsed.frontmatter.model === "string") metadata.model = parsed.frontmatter.model;
	if (typeof parsed.frontmatter.color === "string") metadata.color = parsed.frontmatter.color;

	return {
		definition: {
			id,
			name: readNonEmptyString(parsed.frontmatter.name),
			description: readNonEmptyString(parsed.frontmatter.description),
			statePolicy,
			systemPrompt,
			accessSurfaces,
			metadata,
		},
		diagnostics,
	};
}

function parseStatePolicy(
	value: unknown,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): Extract<SubAgentStatePolicy, "ephemeral" | "session"> | undefined {
	if (value === undefined || value === null) return "session";
	if (typeof value !== "string" || !SUPPORTED_STATE_POLICIES.includes(value as SubAgentStatePolicy)) {
		diagnostics.push({
			type: "error",
			message: "Agent statePolicy must be ephemeral or session",
			path: filePath,
		});
		return undefined;
	}
	return value as Extract<SubAgentStatePolicy, "ephemeral" | "session">;
}

function parseAccessSurfaces(
	frontmatter: AgentFrontmatter,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): SubAgentAccessSurfaceDefinition[] | undefined {
	const surfaces: SubAgentAccessSurfaceDefinition[] = [];
	const explicit = parseExplicitAccessSurfaces(frontmatter.accessSurfaces, filePath, diagnostics);
	if (explicit.length > 0) surfaces.push(...explicit);

	const sharedStateShortcut = parseSharedStateShortcut(frontmatter.sharedState, filePath, diagnostics);
	if (sharedStateShortcut) surfaces.push(sharedStateShortcut);

	const topLevelGrants = parseSharedStateGrants(frontmatter.grants, filePath, diagnostics);
	if (topLevelGrants.length > 0) surfaces.push({ type: "shared_state", grants: topLevelGrants });

	const toolsGrant = parseToolsGrant(frontmatter.tools, filePath, diagnostics);
	if (toolsGrant) surfaces.push({ type: "shared_state", grants: [toolsGrant] });

	return mergeSharedStateSurfaces(surfaces);
}

function parseExplicitAccessSurfaces(
	value: unknown,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): SubAgentAccessSurfaceDefinition[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		diagnostics.push({ type: "warning", message: "accessSurfaces must be an array", path: filePath });
		return [];
	}
	const surfaces: SubAgentAccessSurfaceDefinition[] = [];
	for (const item of value) {
		if (!isRecord(item) || item.type !== "shared_state") {
			diagnostics.push({ type: "warning", message: "Unsupported agent access surface skipped", path: filePath });
			continue;
		}
		const grants = parseSharedStateGrants(item.grants, filePath, diagnostics);
		if (grants.length > 0) surfaces.push({ type: "shared_state", grants });
	}
	return surfaces;
}

function parseSharedStateShortcut(
	value: unknown,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): SubAgentAccessSurfaceDefinition | undefined {
	if (value === undefined || value === null) return undefined;
	if (!isRecord(value)) {
		diagnostics.push({ type: "warning", message: "sharedState must be an object", path: filePath });
		return undefined;
	}
	if (value.writableSpaces === undefined || value.writableSpaces === null) return undefined;
	if (!Array.isArray(value.writableSpaces)) {
		diagnostics.push({ type: "warning", message: "sharedState.writableSpaces must be an array", path: filePath });
		return undefined;
	}
	const writableSpaces: string[] = [];
	for (const space of value.writableSpaces) {
		if (typeof space !== "string" || space.trim().length === 0) {
			diagnostics.push({
				type: "warning",
				message: `Invalid sharedState writable space skipped: ${String(space)}`,
				path: filePath,
			});
			continue;
		}
		writableSpaces.push(space.trim());
	}
	if (writableSpaces.length === 0) return undefined;
	return {
		type: "shared_state",
		grants: [
			{ space: "*", permissions: ["list", "read", "grep"] },
			...Array.from(new Set(writableSpaces)).map((space) => ({
				space,
				permissions: ["write", "edit"] satisfies SharedStatePermission[],
			})),
		],
	};
}

function parseSharedStateGrants(
	value: unknown,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): SharedStateGrant[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		diagnostics.push({ type: "warning", message: "Shared State grants must be an array", path: filePath });
		return [];
	}
	const grants: SharedStateGrant[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.space !== "string" || item.space.trim().length === 0) {
			diagnostics.push({
				type: "warning",
				message: "Shared State grant requires a non-empty space",
				path: filePath,
			});
			continue;
		}
		if (!Array.isArray(item.permissions)) {
			diagnostics.push({
				type: "warning",
				message: "Shared State grant permissions must be an array",
				path: filePath,
			});
			continue;
		}
		const permissions = item.permissions.filter((permission): permission is SharedStatePermission => {
			const valid =
				typeof permission === "string" && SHARED_STATE_PERMISSIONS.includes(permission as SharedStatePermission);
			if (!valid) {
				diagnostics.push({
					type: "warning",
					message: `Unsupported Shared State permission skipped: ${String(permission)}`,
					path: filePath,
				});
			}
			return valid;
		});
		if (permissions.length === 0) continue;
		grants.push({
			space: item.space.trim(),
			permissions: Array.from(new Set(permissions)),
			canOverwrite: typeof item.canOverwrite === "boolean" ? item.canOverwrite : undefined,
			canEditOthers: typeof item.canEditOthers === "boolean" ? item.canEditOthers : undefined,
		});
	}
	return grants;
}

function parseToolsGrant(
	value: unknown,
	filePath: string,
	diagnostics: ResourceDiagnostic[],
): SharedStateGrant | undefined {
	const tools = normalizeTools(value);
	if (tools.length === 0) return undefined;
	const permissions = new Set<SharedStatePermission>();
	for (const tool of tools) {
		if (tool.startsWith(SHARED_STATE_TOOL_PREFIX)) {
			const permission = tool.slice(SHARED_STATE_TOOL_PREFIX.length);
			if (SHARED_STATE_PERMISSIONS.includes(permission as SharedStatePermission)) {
				permissions.add(permission as SharedStatePermission);
			} else {
				diagnostics.push({
					type: "warning",
					message: `Unsupported shared_state tool skipped: ${tool}`,
					path: filePath,
				});
			}
			continue;
		}
		diagnostics.push({ type: "warning", message: `Unsupported agent tool skipped: ${tool}`, path: filePath });
	}
	if (permissions.size === 0) return undefined;
	return { space: "*", permissions: Array.from(permissions), canOverwrite: true, canEditOthers: true };
}

function normalizeTools(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string")
		return value
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);
	if (Array.isArray(value))
		return value
			.filter((tool): tool is string => typeof tool === "string")
			.map((tool) => tool.trim())
			.filter(Boolean);
	return [];
}

function mergeSharedStateSurfaces(
	surfaces: SubAgentAccessSurfaceDefinition[],
): SubAgentAccessSurfaceDefinition[] | undefined {
	const grantsBySpace = new Map<string, SharedStateGrant>();
	for (const surface of surfaces) {
		for (const grant of surface.grants) {
			const existing = grantsBySpace.get(grant.space);
			if (!existing) {
				grantsBySpace.set(grant.space, { ...grant, permissions: [...grant.permissions] });
				continue;
			}
			existing.permissions = Array.from(new Set([...existing.permissions, ...grant.permissions]));
			existing.canOverwrite = Boolean(existing.canOverwrite || grant.canOverwrite) || undefined;
			existing.canEditOthers = Boolean(existing.canEditOthers || grant.canEditOthers) || undefined;
		}
	}
	if (grantsBySpace.size === 0) return undefined;
	return [{ type: "shared_state", grants: Array.from(grantsBySpace.values()) }];
}

function dedupeSubAgentDefinitions(
	agents: SubAgentDefinitionResource[],
	diagnostics: ResourceDiagnostic[],
): LoadSubAgentDefinitionsResult {
	const seen = new Map<string, SubAgentDefinitionResource>();
	for (const agent of agents) {
		const existing = seen.get(agent.definition.id);
		if (existing) {
			diagnostics.push({
				type: "collision",
				message: `agent "${agent.definition.id}" collision`,
				path: agent.filePath,
				collision: {
					resourceType: "agent",
					name: agent.definition.id,
					winnerPath: existing.filePath,
					loserPath: agent.filePath,
				},
			});
			continue;
		}
		seen.set(agent.definition.id, agent);
	}
	return { agents: Array.from(seen.values()), diagnostics };
}

function readNonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
