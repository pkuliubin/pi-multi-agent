import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { PiSubAgentInstance } from "@earendil-works/pi-multi-agent";
import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { CodingAgentSessionFactory } from "../src/core/multi-agent/session-factory.ts";

const runDeepSeekSmoke = process.env.PI_MULTI_AGENT_DEEPSEEK_SMOKE === "1";
const describeSmoke = runDeepSeekSmoke ? describe : describe.skip;

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

describeSmoke("multi-agent DeepSeek smoke", () => {
	it("runs a restricted sub-agent against deepseek-v4-flash", async () => {
		const apiKey = process.env.DEEPSEEK_API_KEY;
		if (!apiKey) {
			throw new Error("DEEPSEEK_API_KEY is required when PI_MULTI_AGENT_DEEPSEEK_SMOKE=1");
		}

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
		const session = await new CodingAgentSessionFactory({ modelRegistry }).create({
			definition: {
				id: "deepseek-smoke-worker",
				statePolicy: "session",
				systemPrompt: "You are a precise smoke-test assistant. Answer exactly as requested.",
			},
			cwd: join(tmpdir(), "pi-multi-agent-deepseek-smoke"),
			model: deepSeekModel,
			thinkingLevel: "off",
			sessionPolicy: "session",
		});
		const subAgent = new PiSubAgentInstance({ id: "deepseek-smoke-worker", statePolicy: "session" }, session);

		try {
			const result = await subAgent.invoke("Say exactly: pi-multi-agent-ok");

			if (result.status !== "completed") {
				throw new Error(`DeepSeek smoke failed: ${result.errorMessage ?? result.finalText}`);
			}
			expect(result.finalText).toContain("pi-multi-agent-ok");
		} finally {
			await subAgent.close();
		}
	}, 60_000);
});
