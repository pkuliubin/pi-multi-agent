import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { createEventClient } from "./api/event-client.ts";
import { ApiError, createApiClient } from "./api/http-client.ts";
import { AppShell } from "./components/layout/AppShell.tsx";
import { webUiReducer } from "./state/app-reducer.ts";
import { initialWebUiState } from "./state/app-state.ts";

export function App() {
	const [state, dispatch] = useReducer(webUiReducer, initialWebUiState);
	const apiClient = useMemo(() => createApiClient(), []);

	const hydrate = useCallback(async () => {
		dispatch({ type: "hydrate.started" });

		try {
			const [session, messages, agents, manifest] = await Promise.all([
				apiClient.getState(),
				apiClient.getMessages(),
				apiClient.getAgents(),
				apiClient.getSharedStateManifest(),
			]);
			dispatch({ type: "hydrate.completed", payload: { session, messages, agents, manifest } });
		} catch (error) {
			dispatch({ type: "hydrate.failed", message: messageForError(error) });
		}
	}, [apiClient]);

	useEffect(() => {
		void hydrate();
	}, [hydrate]);

	const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refreshView = useCallback(async () => {
		try {
			const [session, messages, agents, manifest] = await Promise.all([
				apiClient.getState(),
				apiClient.getMessages(),
				apiClient.getAgents(),
				apiClient.getSharedStateManifest(),
			]);
			dispatch({ type: "hydrate.completed", payload: { session, messages, agents, manifest } });
		} catch (error) {
			dispatch({ type: "hydrate.failed", message: messageForError(error) });
		}
	}, [apiClient]);

	const scheduleRefreshView = useCallback(() => {
		if (refreshTimerRef.current) return;
		refreshTimerRef.current = setTimeout(() => {
			refreshTimerRef.current = null;
			void refreshView();
		}, 100);
	}, [refreshView]);

	const loadAgentHistory = useCallback(
		async (agentId: string) => {
			dispatch({ type: "agent.history.started", agentId });

			try {
				const history = await apiClient.getAgentHistory(agentId);
				dispatch({ type: "agent.history.completed", history });
			} catch (error) {
				dispatch({ type: "agent.history.failed", agentId, message: messageForError(error) });
			}
		},
		[apiClient],
	);

	const loadArtifact = useCallback(
		async (path: string) => {
			dispatch({ type: "artifact.load.started", path });

			try {
				const artifact = await apiClient.getSharedStateArtifact(path);
				dispatch({ type: "artifact.load.completed", artifact });
			} catch (error) {
				dispatch({ type: "artifact.load.failed", path, message: messageForError(error) });
			}
		},
		[apiClient],
	);

	useEffect(() => {
		const eventClient = createEventClient({
			onOpen: () => dispatch({ type: "connection.opened" }),
			onEnvelope: (envelope) => {
				dispatch({ type: "sse.received", envelope });

				if (
					envelope.eventType === "shared_state.changed" ||
					envelope.eventType === "message.completed" ||
					envelope.eventType === "replay.completed" ||
					envelope.eventType === "session.stopped"
				) {
					scheduleRefreshView();
				}
			},
			onError: (error) => dispatch({ type: "hydrate.failed", message: error.message }),
			onConnectionError: () => {
				dispatch({ type: "connection.interrupted" });
				void hydrate();
			},
		});

		eventClient.connect();

		return () => {
			eventClient.close();
			if (refreshTimerRef.current) {
				clearTimeout(refreshTimerRef.current);
				refreshTimerRef.current = null;
			}
		};
	}, [hydrate, scheduleRefreshView]);

	useEffect(() => {
		const selectedPath = state.sharedState.selectedArtifactPath;
		if (!selectedPath || state.sharedState.loadingPath === selectedPath) {
			return;
		}

		if (!state.sharedState.artifactContentByPath[selectedPath]) {
			void loadArtifact(selectedPath);
		}
	}, [
		loadArtifact,
		state.sharedState.artifactContentByPath,
		state.sharedState.loadingPath,
		state.sharedState.selectedArtifactPath,
	]);

	const handleSelectArtifact = useCallback(
		async (path: string | null) => {
			dispatch({ type: "artifact.select", path });

			if (!path || state.sharedState.artifactContentByPath[path]) {
				return;
			}

			await loadArtifact(path);
		},
		[loadArtifact, state.sharedState.artifactContentByPath],
	);

	const handleSubmitPrompt = useCallback(
		async (text: string) => {
			dispatch({ type: "input.pending", pending: true });
			dispatch({ type: "input.notice", message: null });

			try {
				if (!state.session?.session.started) {
					await apiClient.startSession({ mode: "live" });
					await refreshView();
				}

				const response = await apiClient.sendPrompt(text);
				if (!response.accepted) {
					dispatch({ type: "input.notice", message: response.message });
				}
			} catch (error) {
				dispatch({ type: "input.notice", message: messageForError(error) });
			} finally {
				dispatch({ type: "input.pending", pending: false });
			}
		},
		[apiClient, refreshView, state.session?.session.started],
	);

	const handleAbort = useCallback(async () => {
		dispatch({ type: "input.pending", pending: true });

		try {
			const response = await apiClient.abortTurn("User requested abort from web UI");
			dispatch({
				type: "input.notice",
				message: response.message ?? (response.accepted ? "Abort requested." : "No active turn to abort."),
			});
		} catch (error) {
			dispatch({ type: "input.notice", message: messageForError(error) });
		} finally {
			dispatch({ type: "input.pending", pending: false });
		}
	}, [apiClient]);

	const handleStartLive = useCallback(async () => {
		dispatch({ type: "input.pending", pending: true });
		dispatch({ type: "input.notice", message: null });

		try {
			await apiClient.startSession({ mode: "live" });
			await refreshView();
		} catch (error) {
			dispatch({ type: "input.notice", message: messageForError(error) });
		} finally {
			dispatch({ type: "input.pending", pending: false });
		}
	}, [apiClient, refreshView]);

	const handleStartReplay = useCallback(async () => {
		dispatch({ type: "input.pending", pending: true });
		dispatch({ type: "input.notice", message: null });

		try {
			await apiClient.startSession({ mode: "replay", replay: { autoStart: true, speed: 4 } });
			await refreshView();
		} catch (error) {
			dispatch({ type: "input.notice", message: messageForError(error) });
		} finally {
			dispatch({ type: "input.pending", pending: false });
		}
	}, [apiClient, refreshView]);

	const handleStopSession = useCallback(async () => {
		dispatch({ type: "input.pending", pending: true });
		dispatch({ type: "input.notice", message: null });

		try {
			await apiClient.stopSession();
			dispatch({ type: "input.notice", message: "Session stopped." });
			await refreshView();
		} catch (error) {
			dispatch({ type: "input.notice", message: messageForError(error) });
		} finally {
			dispatch({ type: "input.pending", pending: false });
		}
	}, [apiClient, refreshView]);

	const handleResetReplay = useCallback(async () => {
		dispatch({ type: "input.pending", pending: true });
		dispatch({ type: "input.notice", message: null });

		try {
			await apiClient.resetReplay(true);
			dispatch({ type: "input.notice", message: "Replay reset." });
			await refreshView();
		} catch (error) {
			dispatch({ type: "input.notice", message: messageForError(error) });
		} finally {
			dispatch({ type: "input.pending", pending: false });
		}
	}, [apiClient, refreshView]);

	const handleSetReplaySpeed = useCallback(
		async (speed: number) => {
			dispatch({ type: "input.notice", message: null });

			try {
				await apiClient.setReplaySpeed(speed);
				dispatch({ type: "input.notice", message: `Replay speed set to ${speed}x.` });
				await refreshView();
			} catch (error) {
				dispatch({ type: "input.notice", message: messageForError(error) });
			}
		},
		[apiClient, refreshView],
	);

	return (
		<AppShell
			state={state}
			onDismissError={() => dispatch({ type: "error.dismiss" })}
			onSelectArtifact={handleSelectArtifact}
			onRefreshManifest={refreshView}
			onSubmitPrompt={handleSubmitPrompt}
			onAbort={handleAbort}
			onStartLive={handleStartLive}
			onStartReplay={handleStartReplay}
			onStopSession={handleStopSession}
			onResetReplay={handleResetReplay}
			onSetReplaySpeed={handleSetReplaySpeed}
			onLoadAgentHistory={loadAgentHistory}
		/>
	);
}

function messageForError(error: unknown): string {
	if (error instanceof ApiError) {
		return `${error.code}: ${error.message}`;
	}

	return error instanceof Error ? error.message : "Unexpected error";
}
