import { defaultRoleSessionIndexPath, FileRoleSessionIndex } from "@earendil-works/pi-multi-agent";
import type { RoleSessionView } from "../contract.ts";

export async function readRoleSessions(cwd: string | null, mainSessionId?: string | null): Promise<RoleSessionView[]> {
	if (!cwd) return [];
	const index = new FileRoleSessionIndex(defaultRoleSessionIndexPath(cwd));
	return index.list(mainSessionId ?? undefined).map((binding) => ({
		role: roleFromAgentId(binding.agentId),
		agentId: binding.agentId,
		displayName: displayNameForAgent(binding.agentId),
		sessionId: binding.subAgentSessionId,
		status: binding.state,
		currentRunId: null,
		sharedStateRoot: null,
		createdAt: binding.createdAt,
		updatedAt: binding.updatedAt,
	}));
}

function roleFromAgentId(agentId: string): string {
	if (agentId.includes("pm")) return "pm";
	if (agentId.includes("engineering")) return "engineering";
	if (agentId.includes("data") || agentId.includes("analyst")) return "data";
	if (agentId.includes("synthesis")) return "synthesis";
	return agentId;
}

function displayNameForAgent(agentId: string): string {
	return agentId
		.split("-")
		.filter((part) => part.length > 0 && part !== "v2")
		.map((part) => part[0]?.toUpperCase() + part.slice(1))
		.join(" ");
}
