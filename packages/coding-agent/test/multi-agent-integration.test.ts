import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	const dir = join(tmpdir(), `pi-multi-agent-integration-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	}
});

describe("multi-agent integration", () => {
	it("loads file-based sub-agent definitions for run_subagent", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(
			join(cwd, ".pi", "agents", "file-agent.md"),
			`---
id: file-agent
description: Writes file-backed shared state artifacts
tools: shared_state.write
---
Use shared_state.write for notes/file.md and report the logical path only.
`,
			"utf-8",
		);
		const sharedStateRoot = join(cwd, "shared-state");
		const manifest = new MemorySharedStateManifest();
		const { faux, modelRegistry } = setupModelRegistry();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const definitions = resourceLoader.getSubAgents().agents.map((agent) => agent.definition);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
			noTools: "all",
			customTools: [createRunSubAgentTool({ cwd, agentDir, sharedStateRoot, manifest, definitions })],
		});

		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_subagent", { agentId: "file-agent", task: "write notes/file.md" }, { id: "file-run" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"shared_state.write",
					{ path: "notes/file.md", content: "from file agent" },
					{ id: "file-write" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("file-agent wrote notes/file.md"),
			fauxAssistantMessage("done"),
		]);

		await session.prompt("Use file-agent to write notes/file.md");

		expect(definitions.map((definition) => definition.id)).toEqual(["file-agent"]);
		expect(readFileSync(join(sharedStateRoot, "notes", "file.md"), "utf-8")).toBe("from file agent");
		const toolResult = session.messages.find((message) => isRunSubAgentToolResult(message));
		expect(getMessageText(toolResult)).toContain("definitionSource: file");
		expect(toolResult?.details).toMatchObject({ definitionSource: "file" });
		expect(session.getActiveToolNames()).toEqual(["run_subagent"]);
	});
	it("lets the main agent delegate shared-state work and continue with isolated sub-agent transcripts", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(cwd, "AGENTS.md"), "PROJECT INSTRUCTIONS SHOULD NOT LEAK", "utf-8");
		writeFileSync(join(cwd, "CLAUDE.md"), "CLAUDE INSTRUCTIONS SHOULD NOT LEAK", "utf-8");
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
							id: "writer-agent",
							statePolicy: "session",
							systemPrompt: "Use shared_state.write for prd/integration.md and report the logical path only.",
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
		let subAgentSystemPrompt = "";
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					"run_subagent",
					{ agentId: "writer-agent", task: "write prd/integration.md" },
					{ id: "main-run-subagent" },
				),
				{ stopReason: "toolUse" },
			),
			(context) => {
				subAgentSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage(
					fauxToolCall(
						"shared_state.write",
						{ path: "prd/integration.md", content: "integration artifact from sub-agent" },
						{ id: "sub-write" },
					),
					{ stopReason: "toolUse" },
				);
			},
			fauxAssistantMessage("writer-agent wrote prd/integration.md"),
			(context) => {
				const runResult = context.messages.find((message) => isRunSubAgentToolResult(message));
				return fauxAssistantMessage(`main summary saw ${runResult ? "run_subagent" : "missing"}`);
			},
		]);

		await session.prompt("delegate integration work");

		const runSubAgentResults = session.messages.filter((message) => isRunSubAgentToolResult(message));
		expect(runSubAgentResults).toHaveLength(1);
		expect(
			session.messages.some((message) => message.role === "toolResult" && message.toolName === "shared_state.write"),
		).toBe(false);
		expect(getMessageText(runSubAgentResults[0])).toContain("writer-agent wrote prd/integration.md");
		expect(getMessageText(runSubAgentResults[0])).toContain(`sharedStateRoot: ${sharedStateRoot}`);
		expect(session.messages[session.messages.length - 1]?.role).toBe("assistant");
		expect(getMessageText(session.messages[session.messages.length - 1])).toContain("main summary saw run_subagent");
		expect(subAgentSystemPrompt).not.toContain("PROJECT INSTRUCTIONS SHOULD NOT LEAK");
		expect(subAgentSystemPrompt).not.toContain("CLAUDE INSTRUCTIONS SHOULD NOT LEAK");
		expect(session.getActiveToolNames()).toEqual(["run_subagent"]);
		expect(manifest.get("prd/integration.md")).toMatchObject({ ownerAgentId: "writer-agent", version: 1 });
		expect(readFileSync(join(sharedStateRoot, "prd/integration.md"), "utf-8")).toBe(
			"integration artifact from sub-agent",
		);
		session.dispose();
	});

	it("executes different run_subagent calls in parallel with overlapping traces", async () => {
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
							id: "alpha-agent",
							statePolicy: "ephemeral",
							systemPrompt: "Write alpha artifact with shared_state.write.",
							accessSurfaces: [
								{
									type: "shared_state",
									grants: [{ space: "alpha", permissions: ["list", "read", "grep", "write", "edit"] }],
								},
							],
						},
						{
							id: "beta-agent",
							statePolicy: "ephemeral",
							systemPrompt: "Write beta artifact with shared_state.write.",
							accessSurfaces: [
								{
									type: "shared_state",
									grants: [{ space: "beta", permissions: ["list", "read", "grep", "write", "edit"] }],
								},
							],
						},
					],
				}),
			],
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("run_subagent", { agentId: "alpha-agent", task: "write alpha/a.md" }, { id: "run-alpha" }),
					fauxToolCall("run_subagent", { agentId: "beta-agent", task: "write beta/b.md" }, { id: "run-beta" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("shared_state.write", { path: "alpha/a.md", content: "alpha ok" }, { id: "alpha-write" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("shared_state.write", { path: "beta/b.md", content: "beta ok" }, { id: "beta-write" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("alpha wrote alpha/a.md"),
			fauxAssistantMessage("beta wrote beta/b.md"),
			(context) =>
				fauxAssistantMessage(
					`parallel results: ${context.messages.filter((message) => message.role === "toolResult").length}`,
				),
		]);

		await session.prompt("run alpha and beta in parallel");

		const toolResults = session.messages.filter((message) => isRunSubAgentToolResult(message));
		expect(toolResults).toHaveLength(2);
		const traces = toolResults.map((message) => message.details?.result).filter(Boolean);
		expect(traces).toHaveLength(2);
		expect(traces[0].startedAt).toBeLessThanOrEqual(traces[1].endedAt);
		expect(traces[1].startedAt).toBeLessThanOrEqual(traces[0].endedAt);
		expect(manifest.get("alpha/a.md")).toMatchObject({ ownerAgentId: "alpha-agent", version: 1 });
		expect(manifest.get("beta/b.md")).toMatchObject({ ownerAgentId: "beta-agent", version: 1 });
		expect(readFileSync(join(sharedStateRoot, "alpha/a.md"), "utf-8")).toBe("alpha ok");
		expect(readFileSync(join(sharedStateRoot, "beta/b.md"), "utf-8")).toBe("beta ok");
		session.dispose();
	});
});
