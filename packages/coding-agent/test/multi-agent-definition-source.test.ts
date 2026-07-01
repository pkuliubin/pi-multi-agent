import { describe, expect, it } from "vitest";
import { createRunSubAgentTool, resolveRunSubAgentDefinitions } from "../src/core/multi-agent/index.ts";

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

	it("injects generic multi-agent coordination guidance based on registered descriptions", () => {
		const tool = createRunSubAgentTool({
			cwd: "/tmp/project",
			mainSessionId: "main",
			definitions: [
				{
					id: "research-agent",
					description: "Investigates ambiguous product and technical questions",
					statePolicy: "session",
				},
			],
		});
		const guidelines = tool.promptGuidelines?.join("\n") ?? "";

		expect(guidelines).toContain("<multi_agent_coordination>");
		expect(guidelines).toContain("<shared_state_protocol>");
		expect(guidelines).toContain("<sub_agent_tool_boundaries>");
		expect(guidelines).toContain("research-agent — Investigates ambiguous product and technical questions");
		expect(guidelines).toContain("Choose sub-agents by their registered descriptions");
		expect(guidelines).toContain("Shared State is logical team memory");
		expect(guidelines).not.toContain("pm-agent");
		expect(guidelines).not.toContain("engineering-agent");
		expect(guidelines).not.toContain("synthesis-agent");
	});
});
