import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionSnapshot } from "../contract.ts";

export interface SharedStateLocatorInput {
	explicitRoot?: string | null;
	snapshot: SessionSnapshot;
}

export function locateSharedStateRoot(input: SharedStateLocatorInput): string | null {
	if (input.explicitRoot) return resolve(input.explicitRoot);
	const rootFromAgent = input.snapshot.agents.find((agent) => agent.sharedStateRoot)?.sharedStateRoot;
	if (rootFromAgent) return resolve(rootFromAgent);
	if (input.snapshot.sharedState.root) return resolve(input.snapshot.sharedState.root);
	const cwd = input.snapshot.session.cwd;
	if (!cwd) return null;
	const defaultRoot = resolve(cwd, ".pi", "multi-agent", "shared-state");
	return existsSync(defaultRoot) ? defaultRoot : null;
}
