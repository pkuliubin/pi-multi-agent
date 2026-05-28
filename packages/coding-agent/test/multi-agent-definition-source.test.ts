import { describe, expect, it } from "vitest";
import { resolveRunSubAgentDefinitions } from "../src/core/multi-agent/index.ts";

describe("run_subagent definition source selection", () => {
	it("uses file definitions without mixing demo agents when any file agent exists", () => {
		const result = resolveRunSubAgentDefinitions({
			loadedDefinitions: [
				{ id: "file-agent", statePolicy: "session", metadata: { sourcePath: "/tmp/file-agent.md" } },
			],
		});

		expect(result.definitionSource).toBe("file");
		expect(result.definitions.map((definition) => definition.id)).toEqual(["file-agent"]);
	});

	it("falls back to demo definitions when no file agents exist", () => {
		const result = resolveRunSubAgentDefinitions({ loadedDefinitions: [] });

		expect(result.definitionSource).toBe("demo");
		expect(result.definitions.map((definition) => definition.id).sort()).toEqual([
			"engineering-agent",
			"pm-agent",
			"synthesis-agent",
		]);
	});
});
