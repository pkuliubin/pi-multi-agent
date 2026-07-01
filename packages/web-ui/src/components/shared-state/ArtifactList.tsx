import type { SharedStateArtifactEntry, SharedStateArtifactResponse } from "../../api/contracts.ts";
import { ArtifactViewer } from "./ArtifactViewer.tsx";

interface ArtifactListProps {
	artifacts: SharedStateArtifactEntry[];
	selectedPath: string | null;
	selectedArtifact: SharedStateArtifactResponse | null;
	loadingPath: string | null;
	error: string | null;
	onSelect: (path: string | null) => void;
}

export function ArtifactList({
	artifacts,
	selectedPath,
	selectedArtifact,
	loadingPath,
	error,
	onSelect,
}: ArtifactListProps) {
	if (artifacts.length === 0) {
		return (
			<div className="empty-panel compact-empty">
				<p className="empty-title">No artifacts</p>
				<p>Shared State artifacts will appear after an agent writes or updates files.</p>
			</div>
		);
	}

	return (
		<ul className="artifact-list" aria-label="Shared State artifacts">
			{artifacts.map((artifact) => {
				const selected = artifact.path === selectedPath;
				return (
					<li key={artifact.path} className={selected ? "artifact-row is-selected" : "artifact-row"}>
						<button
							type="button"
							className="artifact-item"
							onClick={() => onSelect(selected ? null : artifact.path)}
						>
							<span className="artifact-path">{artifact.path}</span>
							<span className="artifact-meta">{artifact.ownerAgentId ?? "unowned"}</span>
							<span className="artifact-meta">v{artifact.version ?? "?"}</span>
							<span className="artifact-meta">{formatSize(artifact.sizeBytes)}</span>
						</button>
						{selected ? (
							<ArtifactViewer
								artifact={selectedArtifact}
								loadingPath={loadingPath}
								selectedPath={selectedPath}
								error={error}
							/>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

function formatSize(sizeBytes: number | null): string {
	if (sizeBytes === null) {
		return "unknown";
	}

	if (sizeBytes < 1024) {
		return `${sizeBytes} B`;
	}

	return `${(sizeBytes / 1024).toFixed(1)} KB`;
}
