import type { TimelineMessage } from "../../api/contracts.ts";

interface TimelineMessageItemProps {
	message: TimelineMessage;
}

export function TimelineMessageItem({ message }: TimelineMessageItemProps) {
	return (
		<article
			className={`timeline-item ${message.role} ${message.status}`}
			aria-label={`${message.role} ${message.kind}`}
		>
			<header>
				<div>
					<span className="timeline-role">{message.role}</span>
					<span className="timeline-kind">{message.kind}</span>
				</div>
				<span className="timeline-status">{message.status}</span>
			</header>
			<pre>{message.content || "No content yet."}</pre>
			<footer>
				<span>{message.source}</span>
				{message.agentId ? <span>{message.agentId}</span> : null}
				<span>{formatTime(message.updatedAt)}</span>
			</footer>
		</article>
	);
}

function formatTime(value: string): string {
	const date = new Date(value);

	if (Number.isNaN(date.getTime())) {
		return value;
	}

	return date.toLocaleTimeString();
}
