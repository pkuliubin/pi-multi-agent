import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSubAgentDefinition } from "../src/core/multi-agent/sub-agent-definition-loader.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const createdDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-loader-"));
	createdDirs.push(dir);
	return dir;
}

afterEach(() => {
	while (createdDirs.length > 0) rmSync(createdDirs.pop()!, { recursive: true, force: true });
});

describe("sub-agent definition loader", () => {
	it("parses Claude-like markdown into a Pi sub-agent definition", () => {
		const result = parseSubAgentDefinition(
			`---
id: pm-agent
name: PM Agent
description: Writes product docs
statePolicy: session
model: inherit
color: blue
accessSurfaces:
  - type: shared_state
    grants:
      - space: prd
        permissions: [list, read, write]
---
You are pm-agent.
`,
			"/tmp/pm-agent.md",
		);

		expect(result.diagnostics).toEqual([]);
		expect(result.definition).toMatchObject({
			id: "pm-agent",
			name: "PM Agent",
			description: "Writes product docs",
			statePolicy: "session",
			systemPrompt: "You are pm-agent.",
			metadata: { model: "inherit", color: "blue", sourcePath: "/tmp/pm-agent.md" },
		});
		expect(result.definition?.accessSurfaces).toEqual([
			{ type: "shared_state", grants: [{ space: "prd", permissions: ["list", "read", "write"] }] },
		]);
	});

	it("uses name as id fallback and maps safe shared_state tools", () => {
		const result = parseSubAgentDefinition(
			`---
name: writer-agent
tools: shared_state.read, shared_state.write, Bash, WebSearch, mcp__x__y
---
Write shared state.
`,
			"/tmp/writer.md",
		);

		expect(result.definition?.id).toBe("writer-agent");
		expect(result.definition?.statePolicy).toBe("session");
		expect(result.definition?.accessSurfaces).toEqual([
			{
				type: "shared_state",
				grants: [{ space: "*", permissions: ["read", "write"], canOverwrite: true, canEditOthers: true }],
			},
		]);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
			"Unsupported agent tool skipped: Bash",
			"Unsupported agent tool skipped: WebSearch",
			"Unsupported agent tool skipped: mcp__x__y",
		]);
	});

	it("reports invalid definitions without throwing", () => {
		const result = parseSubAgentDefinition(
			`---
statePolicy: persistent
accessSurfaces:
  - type: shared_state
    grants:
      - space: prd
        permissions: [delete]
---
`,
			"/tmp/bad.md",
		);

		expect(result.definition).toBeUndefined();
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
			"Agent definition requires frontmatter id or name",
		);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
			"Agent definition body must not be empty",
		);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
			"Agent statePolicy must be ephemeral or session",
		);
		expect(result.diagnostics.map((diagnostic) => diagnostic.message)).toContain(
			"Unsupported Shared State permission skipped: delete",
		);
	});

	it("discovers project agents before user agents and reports id collisions", async () => {
		const cwd = tempDir();
		const agentDir = join(cwd, "user-agent-dir");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "agents", "pm.md"), "---\nid: pm-agent\n---\nProject PM", "utf-8");
		writeFileSync(join(agentDir, "agents", "pm.md"), "---\nid: pm-agent\n---\nUser PM", "utf-8");
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: SettingsManager.create(cwd, agentDir),
		});

		await loader.reload();

		const result = loader.getSubAgents();
		expect(result.agents).toHaveLength(1);
		expect(result.agents[0]?.definition.systemPrompt).toBe("Project PM");
		expect(result.diagnostics[0]?.collision).toMatchObject({
			resourceType: "agent",
			name: "pm-agent",
		});
	});
});
