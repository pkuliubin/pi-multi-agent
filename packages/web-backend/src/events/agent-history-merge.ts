import type { AgentHistoryItem } from "../contract.ts";

export function compareHistoryItems(left: AgentHistoryItem, right: AgentHistoryItem): number {
	return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function mergeHistoryItem(existing: AgentHistoryItem | undefined, next: AgentHistoryItem): AgentHistoryItem {
	if (!existing) return next;
	if (existing.type === "message" && next.type === "message") {
		return {
			...existing,
			...next,
			createdAt: existing.createdAt <= next.createdAt ? existing.createdAt : next.createdAt,
			content: mergeMessageContent(existing.content, next.content),
		};
	}
	if (existing.type === "tool_call" && next.type === "tool_call") {
		return {
			...existing,
			...next,
			createdAt: existing.createdAt <= next.createdAt ? existing.createdAt : next.createdAt,
			args: next.args ?? existing.args,
			result: next.result ?? existing.result,
		};
	}
	return next;
}

function mergeMessageContent(existing: string, next: string): string {
	if (!next) return existing;
	if (!existing) return next;
	if (existing === next || existing.includes(next)) return existing;
	if (next.includes(existing)) return next;
	return `${existing}${next}`;
}
