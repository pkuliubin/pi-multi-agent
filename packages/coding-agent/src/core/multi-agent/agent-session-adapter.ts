import type { AgentSessionLike, AgentSessionLikeEventListener } from "@earendil-works/pi-multi-agent";
import type { AgentSession, AgentSessionEvent } from "../agent-session.ts";

export type AdaptedAgentSessionLike = AgentSessionLike & {
	readonly resourceLoader: AgentSession["resourceLoader"];
	getActiveToolNames(): string[];
	getAllTools(): ReturnType<AgentSession["getAllTools"]>;
};

export function adaptAgentSession(session: AgentSession): AdaptedAgentSessionLike {
	return {
		get state() {
			return session.state;
		},
		get sessionId() {
			return session.sessionId;
		},
		get sessionFile() {
			return session.sessionFile;
		},
		get model() {
			return session.model;
		},
		get thinkingLevel() {
			return session.thinkingLevel;
		},
		prompt: (text, options) => session.prompt(text, options),
		steer: (text, images) => session.steer(text, images),
		followUp: (text, images) => session.followUp(text, images),
		abort: () => session.abort(),
		waitForIdle: () => session.agent.waitForIdle(),
		subscribe: (listener: AgentSessionLikeEventListener) =>
			session.subscribe((event: AgentSessionEvent) => {
				void listener(event);
			}),
		dispose: () => session.dispose(),
		get resourceLoader() {
			return session.resourceLoader;
		},
		getActiveToolNames: () => session.getActiveToolNames(),
		getAllTools: () => session.getAllTools(),
	};
}
