import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { MemorySharedStateManifest } from "@earendil-works/pi-multi-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createRunSubAgentTool } from "../src/core/multi-agent/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getMessageText } from "./suite/harness.ts";

const createdDirs: string[] = [];
const cleanupCallbacks: Array<() => void> = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `pi-run-subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

function isRunSubAgentToolResult(message: unknown): message is ToolResultMessage {
	return (
		typeof message === "object" &&
		message !== null &&
		"role" in message &&
		(message as { role: unknown }).role === "toolResult" &&
		"toolName" in message &&
		(message as { toolName: unknown }).toolName === "run_subagent"
	);
}

afterEach(() => {
	while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
	while (createdDirs.length > 0) rmSync(createdDirs.pop() ?? "", { recursive: true, force: true });
});

describe("formal run_subagent tool", () => {
	it("runs a registered sub-agent with explicit shared_state tools and isolated transcript", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		const sharedStateRoot = join(cwd, "shared-state");
		const manifest = new MemorySharedStateManifest();
		const { faux, modelRegistry } = setupModelRegistry();
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
			customTools: [
				createRunSubAgentTool({
					cwd,
					agentDir,
					sharedStateRoot,
					manifest,
					definitions: [
						{
							id: "writer",
							statePolicy: "session",
							systemPrompt: "Use shared_state.write to write prd/test.md.",
							accessSurfaces: [
								{
									type: "shared_state",
									grants: [{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"] }],
								},
							],
						},
					],
				}),
			],
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_subagent", { agentId: "writer", task: "write prd/test.md" }, { id: "call-main" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("shared_state.write", { path: "prd/test.md", content: "writer ok" }, { id: "call-write" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("wrote prd/test.md"),
			fauxAssistantMessage("main saw writer result"),
		]);

		await session.prompt("delegate to writer");

		const toolResult = session.messages.find((message) => isRunSubAgentToolResult(message));
		expect(getMessageText(toolResult)).toContain("wrote prd/test.md");
		expect(getMessageText(toolResult)).toContain(`sharedStateRoot: ${sharedStateRoot}`);
		expect(getMessageText(toolResult)).toContain("definitionSource: custom");
		expect(getMessageText(toolResult)).toMatch(/startedAt: \d{4}-\d{2}-\d{2}T/);
		expect(getMessageText(toolResult)).toMatch(/endedAt: \d{4}-\d{2}-\d{2}T/);
		expect(getMessageText(toolResult)).toMatch(/durationMs: \d+/);
		expect(toolResult?.details).toMatchObject({ sharedStateRoot, definitionSource: "custom" });
		expect(manifest.get("prd/test.md")).toMatchObject({ ownerAgentId: "writer", version: 1 });
		expect(session.getActiveToolNames()).toEqual(["run_subagent"]);
		expect(session.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			"delegate to writer",
		]);
		session.dispose();
	});
});
