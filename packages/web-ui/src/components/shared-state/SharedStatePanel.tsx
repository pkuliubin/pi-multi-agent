import type { SharedStateArtifactEntry, SharedStateArtifactResponse } from "../../api/contracts.ts";
import { ArtifactList } from "./ArtifactList.tsx";

interface SharedStatePanelProps {
	root: string | null;
	artifacts: SharedStateArtifactEntry[];
	selectedPath: string | null;
	selectedArtifact: SharedStateArtifactResponse | null;
	loadingPath: string | null;
	error: string | null;
	onSelectArtifact: (path: string | null) => void;
	onRefreshManifest: () => void;
}

export function SharedStatePanel({
	root,
	artifacts,
	selectedPath,
	selectedArtifact,
	loadingPath,
	error,
	onSelectArtifact,
	onRefreshManifest,
}: SharedStatePanelProps) {
	return (
		<section className="panel shared-state-panel" aria-label="Shared State artifacts">
			<header className="panel-header compact-panel-header">
				<p className="panel-line">
					<strong>Artifacts</strong>
					<span>{artifacts.length} files</span>
					<span className="root-path">{root ?? "No shared-state root"}</span>
				</p>
				<button type="button" className="ghost-button compact" onClick={onRefreshManifest}>
					Refresh
				</button>
			</header>
			<ArtifactList
				artifacts={artifacts}
				selectedPath={selectedPath}
				selectedArtifact={selectedArtifact}
				loadingPath={loadingPath}
				error={error}
				onSelect={onSelectArtifact}
			/>
		</section>
	);
}
