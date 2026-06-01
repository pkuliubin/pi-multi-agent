import { describe, expect, it } from "vitest";
import { createRunSubAgentTool, resolveRunSubAgentDefinitions } from "../src/core/multi-agent/index.ts";

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

	it("only injects fixed demo workflow guidance for demo definitions", () => {
		const demoDefinitions = resolveRunSubAgentDefinitions({ loadedDefinitions: [] }).definitions;
		const fileDefinitions = demoDefinitions.map((definition) => ({
			...definition,
			metadata: { sourcePath: `/tmp/${definition.id}.md` },
		}));

		const demoTool = createRunSubAgentTool({
			cwd: "/tmp/project",
			mainSessionId: "main",
			definitions: demoDefinitions,
		});
		const fileTool = createRunSubAgentTool({
			cwd: "/tmp/project",
			mainSessionId: "main",
			definitions: fileDefinitions,
		});

		expect(
			demoTool.promptGuidelines?.some((guideline) => guideline.includes("round 1 pm-agent writes prd/pm.md")),
		).toBe(true);
		expect(
			fileTool.promptGuidelines?.some((guideline) => guideline.includes("round 1 pm-agent writes prd/pm.md")),
		).toBe(false);
	});
});
