import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { MemorySharedStateManifest, RunSubAgentRunner, SubAgentRegistry } from "@earendil-works/pi-multi-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import {
	CodingAgentSessionFactory,
	createDemoSubAgentDefinitions,
	createSharedStateTools,
} from "../src/core/multi-agent/index.ts";

const createdDirs: string[] = [];
const cleanupCallbacks: Array<() => void> = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `pi-shared-state-rounds-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	createdDirs.push(dir);
	return dir;
}

function setupModelRegistry() {
	const faux = registerFauxProvider();
	cleanupCallbacks.push(() => faux.unregister());
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(faux.getModel().provider, {
		baseUrl: faux.getModel().baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			baseUrl: model.baseUrl,
		})),
	});
	return { faux, modelRegistry };
}

function read(root: string, path: string): string {
	return readFileSync(join(root, path), "utf-8");
}

afterEach(() => {
	while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

describe("multi-agent Shared State rounds", () => {
	it("supports multi-round collaboration through shared state artifacts", async () => {
		const cwd = createTempDir();
		const sharedStateRoot = join(cwd, "shared-state");
		const manifest = new MemorySharedStateManifest();
		const registry = new SubAgentRegistry();
		for (const definition of createDemoSubAgentDefinitions()) registry.register(definition);
		const { faux, modelRegistry } = setupModelRegistry();
		const runner = new RunSubAgentRunner({
			registry,
			sessionFactory: new CodingAgentSessionFactory({ modelRegistry }),
			cwd,
			model: faux.getModel(),
			thinkingLevel: "off",
			createAccessSurfaceTools: ({ definition, accessSurface }) =>
				accessSurface.type === "shared_state"
					? createSharedStateTools({
							root: sharedStateRoot,
							agentId: definition.id,
							grants: accessSurface.grants,
							manifest,
						})
					: [],
		});

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"shared_state.write",
					{ path: "prd/pm.md", content: "PM draft: user onboarding" },
					{ id: "pm-r1" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("pm wrote prd/pm.md"),
			fauxAssistantMessage(
				fauxToolCall(
					"shared_state.write",
					{ path: "analysis/engineering.md", content: "Engineering draft: API required" },
					{ id: "eng-r1" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("engineering wrote analysis/engineering.md"),
			fauxAssistantMessage(
				fauxToolCall("shared_state.read", { path: "analysis/engineering.md" }, { id: "pm-read-r2" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"shared_state.edit",
					{
						path: "prd/pm.md",
						edits: [
							{
								oldText: "PM draft: user onboarding",
								newText: "PM draft: user onboarding\nEngineering input: API required",
							},
						],
					},
					{ id: "pm-edit-r2" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("pm updated prd/pm.md with engineering input"),
			fauxAssistantMessage(fauxToolCall("shared_state.read", { path: "prd/pm.md" }, { id: "eng-read-r2" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall(
					"shared_state.edit",
					{
						path: "analysis/engineering.md",
						edits: [
							{
								oldText: "Engineering draft: API required",
								newText: "Engineering draft: API required\nPM input: user onboarding",
							},
						],
					},
					{ id: "eng-edit-r2" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("engineering updated analysis/engineering.md with PM input"),
			fauxAssistantMessage(fauxToolCall("shared_state.read", { path: "prd/pm.md" }, { id: "syn-read-pm" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(
				fauxToolCall("shared_state.read", { path: "analysis/engineering.md" }, { id: "syn-read-eng" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"shared_state.write",
					{ path: "summary/final.md", content: "Summary: user onboarding requires API support" },
					{ id: "syn-write" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("synthesis wrote summary/final.md"),
		]);

		const pmRound1 = await runner.run({ agentId: "pm-agent", task: "write PM draft" });
		const engRound1 = await runner.run({ agentId: "engineering-agent", task: "write engineering analysis" });
		expect(pmRound1.status).toBe("completed");
		expect(engRound1.status).toBe("completed");
		expect(manifest.get("prd/pm.md")).toMatchObject({ ownerAgentId: "pm-agent", version: 1 });
		expect(manifest.get("analysis/engineering.md")).toMatchObject({ ownerAgentId: "engineering-agent", version: 1 });

		const pmRound2 = await runner.run({ agentId: "pm-agent", task: "read engineering and update PM draft" });
		const engRound2 = await runner.run({
			agentId: "engineering-agent",
			task: "read PM and update engineering analysis",
		});
		expect(pmRound2.status).toBe("completed");
		expect(engRound2.status).toBe("completed");
		expect(manifest.get("prd/pm.md")).toMatchObject({ ownerAgentId: "pm-agent", updatedBy: "pm-agent", version: 2 });
		expect(manifest.get("analysis/engineering.md")).toMatchObject({
			ownerAgentId: "engineering-agent",
			updatedBy: "engineering-agent",
			version: 2,
		});
		expect(read(sharedStateRoot, "prd/pm.md")).toContain("Engineering input: API required");
		expect(read(sharedStateRoot, "analysis/engineering.md")).toContain("PM input: user onboarding");

		const synthesis = await runner.run({ agentId: "synthesis-agent", task: "write final summary" });
		expect(synthesis.status).toBe("completed");
		expect(manifest.get("summary/final.md")).toMatchObject({ ownerAgentId: "synthesis-agent", version: 1 });
		expect(read(sharedStateRoot, "summary/final.md")).toContain("user onboarding");
		expect(read(sharedStateRoot, "summary/final.md")).toContain("API support");
	});
});
