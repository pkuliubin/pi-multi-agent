import { readFile } from "node:fs/promises";

export interface ReplayLogRecord {
	type: string;
	[key: string]: unknown;
}

export async function readReplayLog(path: string): Promise<ReplayLogRecord[]> {
	const content = await readFile(path, "utf8");
	return parseReplayJsonl(content);
}

export function parseReplayJsonl(content: string): ReplayLogRecord[] {
	const records: ReplayLogRecord[] = [];
	const lines = content.split("\n");

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]?.endsWith("\r") ? lines[index].slice(0, -1) : lines[index];
		if (!line || line.trim().length === 0) continue;

		const parsed = JSON.parse(line) as unknown;
		if (!isReplayLogRecord(parsed)) {
			throw new Error(`Invalid replay record at line ${index + 1}`);
		}
		records.push(parsed);
	}

	return records;
}

function isReplayLogRecord(value: unknown): value is ReplayLogRecord {
	return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}
