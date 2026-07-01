import type { TimelineMessage } from "../../api/contracts.ts";
import { TimelineTurns } from "./TimelineTurn.tsx";

interface MainTimelineProps {
	messages: TimelineMessage[];
}

export function MainTimeline({ messages }: MainTimelineProps) {
	return (
		<section className="panel timeline-panel" aria-label="Main agent timeline">
			<header className="panel-header compact-panel-header">
				<p className="panel-line">
					<strong>Timeline</strong>
					<span>{messages.length} events</span>
				</p>
			</header>
			<div className="timeline-list">
				{messages.length === 0 ? (
					<div className="empty-panel compact-empty">
						<p className="empty-title">No timeline yet</p>
						<p>Prompt activity, tool calls, and summaries will stream here.</p>
					</div>
				) : (
					<TimelineTurns messages={messages} />
				)}
			</div>
		</section>
	);
}
