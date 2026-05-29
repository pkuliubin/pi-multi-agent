import type { SharedStateArtifactResponse } from "../../api/contracts.ts";

interface ArtifactViewerProps {
	artifact: SharedStateArtifactResponse | null;
	loadingPath: string | null;
	selectedPath: string | null;
	error: string | null;
}

export function ArtifactViewer({ artifact, loadingPath, selectedPath, error }: ArtifactViewerProps) {
	if (!selectedPath) {
		return (
			<div className="artifact-viewer empty-panel">
				<p className="empty-title">Select an artifact</p>
				<p>Choose a Shared State file to inspect the current source-of-truth content.</p>
			</div>
		);
	}

	if (loadingPath === selectedPath) {
		return (
			<div className="artifact-viewer empty-panel" aria-busy="true">
				<p className="empty-title">Loading artifact</p>
				<p>{selectedPath}</p>
			</div>
		);
	}

	if (error) {
		return (
			<div className="artifact-viewer empty-panel error-panel" role="alert">
				<p className="empty-title">Artifact load failed</p>
				<p>{error}</p>
			</div>
		);
	}

	if (!artifact) {
		return (
			<div className="artifact-viewer empty-panel">
				<p className="empty-title">Artifact not loaded</p>
				<p>Content will be fetched on selection.</p>
			</div>
		);
	}

	return (
		<section className="artifact-viewer" aria-label={`Artifact ${artifact.path}`}>
			<header className="panel-subheader">
				<div>
					<p className="eyebrow">Artifact</p>
					<h3>{artifact.path}</h3>
				</div>
				<span className="status-pill">{artifact.content.kind}</span>
			</header>
			{artifact.content.kind === "binary-unsupported" ? (
				<div className="empty-panel compact-empty">
					<p className="empty-title">Binary preview unavailable</p>
					<p>
						{formatSize(artifact.content.sizeBytes)} · {artifact.content.mimeType ?? "unknown type"}
					</p>
				</div>
			) : (
				<>
					{artifact.content.truncated ? (
						<p className="warning-line">
							Content is truncated. Full size: {formatSize(artifact.content.sizeBytes)}.
						</p>
					) : null}
					<pre className="artifact-code">
						{artifact.content.kind === "json"
							? formatJson(artifact.content.json, artifact.content.text)
							: artifact.content.text}
					</pre>
				</>
			)}
		</section>
	);
}

function formatJson(json: unknown, fallbackText: string): string {
	try {
		return JSON.stringify(json, null, 2);
	} catch {
		return fallbackText;
	}
}

function formatSize(sizeBytes: number): string {
	if (sizeBytes < 1024) {
		return `${sizeBytes} B`;
	}

	return `${(sizeBytes / 1024).toFixed(1)} KB`;
}
