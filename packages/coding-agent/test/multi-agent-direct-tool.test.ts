import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import type { SubAgentResult } from "@earendil-works/pi-multi-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createDirectRunSubAgentTool } from "../src/core/multi-agent/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getMessageText } from "./suite/harness.ts";

const createdDirs: string[] = [];
const cleanupCallbacks: Array<() => void> = [];
const tsxLoaderPath = resolve(__dirname, "../../../node_modules/tsx/dist/loader.mjs");
const cliPath = resolve(__dirname, "../src/cli.ts");

function createTempDir(): string {
	const dir = join(tmpdir(), `pi-multi-agent-direct-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	createdDirs.push(dir);
	return dir;
}

async function runCliWithEnv(
	args: string[],
	env: NodeJS.ProcessEnv & { TEST_CWD: string },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", tsxLoaderPath, cliPath, ...args], {
			cwd: env.TEST_CWD,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ stdout, stderr, code });
		});
	});
}

function isSubAgentResult(value: unknown): value is SubAgentResult {
	return (
		typeof value === "object" && value !== null && "agentId" in value && "status" in value && "finalText" in value
	);
}

afterEach(() => {
	while (cleanupCallbacks.length > 0) {
		cleanupCallbacks.pop()?.();
	}
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("direct multi-agent run_subagent tool", () => {
	it("runs an isolated sub-agent from a real main AgentSession loop", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
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
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
			noTools: "all",
			customTools: [createDirectRunSubAgentTool()],
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("run_subagent", { task: "return subagent-ok" }, { id: "call-sub" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("subagent-ok"),
			fauxAssistantMessage("main saw subagent-ok"),
		]);

		await session.prompt("delegate this task to a sub-agent");

		const toolResult = session.messages.find((message) => message.role === "toolResult");
		expect(toolResult?.toolName).toBe("run_subagent");
		expect(getMessageText(toolResult)).toContain("subagent-ok");
		expect(isSubAgentResult(toolResult?.details?.result) ? toolResult.details.result.status : undefined).toBe(
			"completed",
		);
		expect(session.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			"delegate this task to a sub-agent",
		]);
		expect(session.messages.filter((message) => message.role === "assistant").map(getMessageText)).toContain(
			"main saw subagent-ok",
		);
		expect(session.getActiveToolNames()).toEqual(["run_subagent"]);

		session.dispose();
	});

	it("exposes run_subagent in CLI print sessions when the env flag is enabled", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		const extensionPath = join(cwd, "faux-extension.ts");
		writeFileSync(
			extensionPath,
			`import { createAssistantMessageEventStream, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
function responseStream(message) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (let index = 0; index < message.content.length; index++) {
      const block = message.content[index];
      if (block.type === "text") {
        stream.push({ type: "text_start", contentIndex: index, partial: { ...message, content: [] } });
        stream.push({ type: "text_delta", contentIndex: index, delta: block.text, partial: message });
        stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: message });
      } else if (block.type === "toolCall") {
        stream.push({ type: "toolcall_start", contentIndex: index, partial: { ...message, content: [] } });
        stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(block.arguments), partial: message });
        stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
      }
    }
    stream.push({ type: "done", reason: message.stopReason, message });
    stream.end(message);
  });
  return stream;
}
export default function(pi) {
  let callCount = 0;
  pi.registerProvider("cli-faux", {
    baseUrl: "http://localhost:0",
    apiKey: "faux-key",
    api: "faux",
    streamSimple: () => {
      const current = callCount++;
      if (current === 0) {
        return responseStream(fauxAssistantMessage(fauxToolCall("run_subagent", { task: "return cli-subagent-ok" }, { id: "call-cli-sub" }), { stopReason: "toolUse" }));
      }
      if (current === 1) {
        return responseStream(fauxAssistantMessage("cli-subagent-ok"));
      }
      return responseStream(fauxAssistantMessage("main saw cli-subagent-ok"));
    },
    models: [{
      id: "cli-faux-1",
      name: "CLI Faux",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 4096,
    }],
  });
}
`,
			"utf-8",
		);

		const result = await runCliWithEnv(
			[
				"--extension",
				extensionPath,
				"--provider",
				"cli-faux",
				"--model",
				"cli-faux-1",
				"-p",
				"delegate via sub-agent",
			],
			{
				...process.env,
				[ENV_AGENT_DIR]: agentDir,
				PI_MULTI_AGENT_DIRECT_SUBAGENT: "1",
				TEST_CWD: cwd,
				TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
			},
		);

		expect(
			result,
			`${result.stderr}
STDOUT:
${result.stdout}`,
		).toMatchObject({ code: 0 });
		expect(result.stdout).toContain("main saw cli-subagent-ok");
		expect(result.stderr).not.toContain("Error:");
	});
});
