import { describe, expect, it } from "vitest";
import { parseReplayJsonl } from "../src/replay/legacy-jsonl/jsonl-log-reader.ts";

describe("parseReplayJsonl", () => {
	it("parses LF and CRLF JSONL records", () => {
		const records = parseReplayJsonl('{"type":"session","id":"a"}\r\n{"type":"turn_start"}\n');

		expect(records).toEqual([{ type: "session", id: "a" }, { type: "turn_start" }]);
	});

	it("rejects records without a type", () => {
		expect(() => parseReplayJsonl('{"id":"a"}\n')).toThrow("Invalid replay record");
	});
});
