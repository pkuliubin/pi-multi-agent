import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { MemorySharedStateManifest, RunSubAgentRunner, SubAgentRegistry } from "@earendil-works/pi-multi-agent";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { CodingAgentSessionFactory, createSharedStateTools } from "../src/core/multi-agent/index.ts";

const runSmoke = process.env.PI_MULTI_AGENT_ROUNDS_SMOKE === "1";
const describeSmoke = runSmoke ? describe : describe.skip;

const deepSeekModel: Model<"openai-completions"> = {
	id: "deepseek-v4-flash",
	name: "DeepSeek V4 Flash",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 64_000,
	maxTokens: 8192,
};

describeSmoke("multi-agent Shared State rounds DeepSeek smoke", () => {
	it("runs PM, engineering, and synthesis agents through shared_state tools", async () => {
		const apiKey = process.env.DEEPSEEK_API_KEY;
		if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required when PI_MULTI_AGENT_ROUNDS_SMOKE=1");
		const root = join(tmpdir(), `pi-rounds-smoke-${Date.now()}`);
		mkdirSync(root, { recursive: true });
		const manifest = new MemorySharedStateManifest();
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("deepseek", apiKey);
		const modelRegistry = ModelRegistry.inMemory(authStorage);
		modelRegistry.registerProvider("deepseek", {
			baseUrl: deepSeekModel.baseUrl,
			apiKey,
			api: deepSeekModel.api,
			authHeader: true,
			models: [deepSeekModel],
		});
		const registry = new SubAgentRegistry();
		registry.register({
			id: "pm-agent",
			statePolicy: "ephemeral",
			systemPrompt: "Use shared_state.write. Write concise content exactly where requested.",
			accessSurfaces: [
				{
					type: "shared_state",
					grants: [{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"] }],
				},
			],
		});
		registry.register({
			id: "engineering-agent",
			statePolicy: "ephemeral",
			systemPrompt: "Use shared_state.read and shared_state.write. Write concise content exactly where requested.",
			accessSurfaces: [
				{
					type: "shared_state",
					grants: [
						{ space: "prd", permissions: ["list", "read", "grep"] },
						{ space: "analysis", permissions: ["list", "read", "grep", "write", "edit"] },
					],
				},
			],
		});
		registry.register({
			id: "synthesis-agent",
			statePolicy: "ephemeral",
			systemPrompt: "Use shared_state.read and shared_state.write. Write concise content exactly where requested.",
			accessSurfaces: [
				{
					type: "shared_state",
					grants: [
						{ space: "prd", permissions: ["list", "read", "grep"] },
						{ space: "analysis", permissions: ["list", "read", "grep"] },
						{ space: "summary", permissions: ["list", "read", "grep", "write", "edit"] },
					],
				},
			],
		});
		const runner = new RunSubAgentRunner({
			registry,
			sessionFactory: new CodingAgentSessionFactory({ modelRegistry }),
			cwd: root,
			model: deepSeekModel,
			thinkingLevel: "off",
			createAccessSurfaceTools: ({ definition, accessSurface }) =>
				accessSurface.type === "shared_state"
					? createSharedStateTools({ root, agentId: definition.id, grants: accessSurface.grants, manifest })
					: [],
		});
		try {
			const pm = await runner.run({
				agentId: "pm-agent",
				task: "Write exactly this content to shared_state path prd/pm.md: PM smoke product draft.",
			});
			const engineering = await runner.run({
				agentId: "engineering-agent",
				task: "Read prd/pm.md, then write exactly this content to analysis/engineering.md: Engineering smoke analysis uses PM smoke product draft.",
			});
			const synthesis = await runner.run({
				agentId: "synthesis-agent",
				task: "Read prd/pm.md and analysis/engineering.md, then write exactly this content to summary/final.md: pi-multi-agent-rounds-ok.",
			});
			expect(pm, pm.errorMessage ?? pm.finalText).toMatchObject({ status: "completed" });
			expect(engineering, engineering.errorMessage ?? engineering.finalText).toMatchObject({ status: "completed" });
			expect(synthesis, synthesis.errorMessage ?? synthesis.finalText).toMatchObject({ status: "completed" });
			expect(readFileSync(join(root, "summary/final.md"), "utf-8")).toContain("pi-multi-agent-rounds-ok");
		} finally {
			await runner.close();
			if (existsSync(root)) rmSync(root, { recursive: true, force: true });
		}
	}, 120_000);
});
