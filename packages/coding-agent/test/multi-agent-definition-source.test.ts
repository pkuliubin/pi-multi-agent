import { describe, expect, it } from "vitest";
import { resolveRunSubAgentDefinitions } from "../src/core/multi-agent/index.ts";

describe("run_subagent definition source selection", () => {
	it("uses file definitions without adding built-in agents", () => {
		const result = resolveRunSubAgentDefinitions({
			loadedDefinitions: [
				{ id: "file-agent", statePolicy: "session", metadata: { sourcePath: "/tmp/file-agent.md" } },
			],
		});

		expect(result.definitionSource).toBe("file");
		expect(result.definitions.map((definition) => definition.id)).toEqual(["file-agent"]);
	});

	it("returns no definitions when no file agents exist", () => {
		const result = resolveRunSubAgentDefinitions({ loadedDefinitions: [] });

		expect(result.definitionSource).toBe("file");
		expect(result.definitions).toEqual([]);
	});
});
