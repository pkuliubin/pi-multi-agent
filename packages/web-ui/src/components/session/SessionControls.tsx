import type { BackendMode } from "../../api/contracts.ts";

interface SessionControlsProps {
	started: boolean;
	backendMode: BackendMode | null;
	pending: boolean;
	onStartLive: () => Promise<void>;
	onStartReplay: () => Promise<void>;
	onStopSession: () => Promise<void>;
	onResetReplay: () => Promise<void>;
	onSetReplaySpeed: (speed: number) => Promise<void>;
}

export function SessionControls({
	started,
	backendMode,
	pending,
	onStartLive,
	onStartReplay,
	onStopSession,
	onResetReplay,
	onSetReplaySpeed,
}: SessionControlsProps) {
	const replayActive = started && backendMode === "replay";

	return (
		<section className="session-controls" aria-label="Session controls">
			<button type="button" className="primary-button compact" disabled={pending || started} onClick={onStartLive}>
				Start live
			</button>
			<button type="button" className="ghost-button compact" disabled={pending || started} onClick={onStartReplay}>
				Start replay
			</button>
			<button type="button" className="ghost-button compact" disabled={pending || !started} onClick={onStopSession}>
				Stop session
			</button>
			<button
				type="button"
				className="ghost-button compact"
				disabled={pending || !replayActive}
				onClick={onResetReplay}
			>
				Reset replay
			</button>
			<label>
				Replay speed
				<select
					disabled={pending || !replayActive}
					defaultValue="4"
					onChange={(event) => {
						void onSetReplaySpeed(Number(event.currentTarget.value));
					}}
				>
					<option value="1">1x</option>
					<option value="4">4x</option>
					<option value="20">20x</option>
				</select>
			</label>
		</section>
	);
}
