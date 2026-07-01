import type { TimelineMessage } from "../../api/contracts.ts";
import type { WebUiState } from "../../state/app-state.ts";
import { selectAgents, selectArtifacts, selectSelectedArtifact } from "../../state/selectors.ts";
import { AgentCardsRow } from "../agents/AgentCardsRow.tsx";
import { PromptInput } from "../prompt/PromptInput.tsx";
import { SessionControls } from "../session/SessionControls.tsx";
import { SharedStatePanel } from "../shared-state/SharedStatePanel.tsx";
import { ConnectionStatus } from "../status/ConnectionStatus.tsx";
import { MainTimeline } from "../timeline/MainTimeline.tsx";

interface AppShellProps {
	state: WebUiState;
	onDismissError: () => void;
	onSelectArtifact: (path: string | null) => void;
	onRefreshManifest: () => void;
	onSubmitPrompt: (text: string) => Promise<void>;
	onAbort: () => Promise<void>;
	onStartLive: () => Promise<void>;
	onStartReplay: () => Promise<void>;
	onStopSession: () => Promise<void>;
	onResetReplay: () => Promise<void>;
	onSetReplaySpeed: (speed: number) => Promise<void>;
	onLoadAgentHistory: (agentId: string) => Promise<void>;
}

export function AppShell({
	state,
	onDismissError,
	onSelectArtifact,
	onRefreshManifest,
	onSubmitPrompt,
	onAbort,
	onStartLive,
	onStartReplay,
	onStopSession,
	onResetReplay,
	onSetReplaySpeed,
	onLoadAgentHistory,
}: AppShellProps) {
	const agents = selectAgents(state);
	const artifacts = selectArtifacts(state);
	const selectedArtifact = selectSelectedArtifact(state);
	const messages = state.messages as TimelineMessage[];

	return (
		<main className="app-shell" aria-label="Pi multi-agent dashboard">
			<aside className="left-rail">
				<section className="control-strip" aria-label="Session status and controls">
					<ConnectionStatus
						connection={state.connection}
						session={state.session}
						onDismissError={onDismissError}
					/>
					<SessionControls
						started={state.session?.session.started ?? false}
						backendMode={state.session?.backendMode ?? null}
						pending={state.input.pending}
						onStartLive={onStartLive}
						onStartReplay={onStartReplay}
						onStopSession={onStopSession}
						onResetReplay={onResetReplay}
						onSetReplaySpeed={onSetReplaySpeed}
					/>
				</section>
				<AgentCardsRow
					agents={agents}
					historyByAgentId={state.agentHistory.byId}
					loadingByAgentId={state.agentHistory.loadingById}
					errorByAgentId={state.agentHistory.errorById}
					onLoadAgentHistory={onLoadAgentHistory}
				/>
				<SharedStatePanel
					root={state.sharedState.root}
					artifacts={artifacts}
					selectedPath={state.sharedState.selectedArtifactPath}
					selectedArtifact={selectedArtifact}
					loadingPath={state.sharedState.loadingPath}
					error={state.sharedState.error}
					onSelectArtifact={onSelectArtifact}
					onRefreshManifest={onRefreshManifest}
				/>
			</aside>
			<section className="right-workspace">
				<MainTimeline messages={messages} />
				<PromptInput
					pending={state.input.pending}
					notice={state.input.notice}
					onSubmit={onSubmitPrompt}
					onAbort={onAbort}
				/>
			</section>
		</main>
	);
}
