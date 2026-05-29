import type { AgentCard, SharedStateArtifactEntry } from "../api/contracts.ts";
import type { WebUiState } from "./app-state.ts";

export function selectAgents(state: WebUiState): AgentCard[] {
	return Object.values(state.agentsById).sort((left, right) => compareNullableDate(right.updatedAt, left.updatedAt));
}

export function selectArtifacts(state: WebUiState): SharedStateArtifactEntry[] {
	return [...state.sharedState.artifacts].sort((left, right) => compareNullableDate(right.updatedAt, left.updatedAt));
}

export function selectSelectedArtifact(state: WebUiState) {
	const selectedPath = state.sharedState.selectedArtifactPath;

	if (!selectedPath) {
		return null;
	}

	return state.sharedState.artifactContentByPath[selectedPath] ?? null;
}

function compareNullableDate(left: string | null, right: string | null): number {
	if (left === right) {
		return 0;
	}

	if (!left) {
		return 1;
	}

	if (!right) {
		return -1;
	}

	return Date.parse(left) - Date.parse(right);
}
