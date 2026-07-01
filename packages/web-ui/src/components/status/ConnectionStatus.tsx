import type { SessionSnapshot } from "../../api/contracts.ts";
import type { WebUiState } from "../../state/app-state.ts";

interface ConnectionStatusProps {
	connection: WebUiState["connection"];
	session: SessionSnapshot | null;
	onDismissError: () => void;
}

export function ConnectionStatus({ connection, session, onDismissError }: ConnectionStatusProps) {
	const statusLabel = connection.connected ? "Connected" : connection.reconnecting ? "Reconnecting" : "Disconnected";
	const sessionLabel = session?.session.started ? (session.backendMode ?? "started") : "not started";

	return (
		<header className="topbar">
			<div className="status-cluster">
				<span className={`status-pill ${connection.connected ? "is-ok" : "is-warn"}`}>{statusLabel}</span>
				<span className="status-pill">Session: {sessionLabel}</span>
				{session?.turn.status ? <span className="status-pill">Turn: {session.turn.status}</span> : null}
			</div>
			{connection.errorBanner ? (
				<div className="error-banner" role="alert">
					<span>{connection.errorBanner}</span>
					<button type="button" className="ghost-button compact" onClick={onDismissError}>
						Dismiss
					</button>
				</div>
			) : null}
		</header>
	);
}
