import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { MemorySharedStateManifest } from "@earendil-works/pi-multi-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
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

function createObservedRunSubAgentTool(
	tool: ToolDefinition,
	updates: Array<{ text: string; details: unknown }>,
): ToolDefinition {
	return {
		...tool,
		async execute(
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: ((partialResult: AgentToolResult<unknown>) => void) | undefined,
			ctx: Parameters<ToolDefinition["execute"]>[4],
		) {
			return await tool.execute(
				toolCallId,
				params,
				signal,
				(partialResult: AgentToolResult<unknown>) => {
					updates.push({
						text: partialResult.content
							.map((content) => (content.type === "text" ? content.text : ""))
							.join("\n"),
						details: partialResult.details,
					});
					onUpdate?.(partialResult);
				},
				ctx,
			);
		},
	};
}

afterEach(() => {
	while (cleanupCallbacks.length > 0) cleanupCallbacks.pop()?.();
	while (createdDirs.length > 0) rmSync(createdDirs.pop() ?? "", { recursive: true, force: true });
});

describe("formal run_subagent tool", () => {
	it("streams compact progress snapshots through onUpdate", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		const sharedStateRoot = join(cwd, "shared-state");
		const manifest = new MemorySharedStateManifest();
		const { faux, modelRegistry } = setupModelRegistry();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const updates: Array<{ text: string; details: unknown }> = [];
		const tool = createObservedRunSubAgentTool(
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
			updates,
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
			noTools: "all",
			customTools: [tool],
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

		expect(updates.length).toBeGreaterThan(0);
		expect(updates.some((update) => update.text.includes("phase: running"))).toBe(true);
		expect(updates.some((update) => update.text.includes("tool_execution_start: shared_state.write"))).toBe(true);
		const uniqueTexts = new Set(updates.map((update) => update.text));
		expect(uniqueTexts.size).toBe(updates.length);
		const lastDetails = updates[updates.length - 1]?.details as {
			progress?: { currentPhase?: string; recentEvents?: Array<Record<string, unknown>> };
		};
		expect(lastDetails.progress?.currentPhase).toBe("completed");
		expect(Array.isArray(lastDetails.progress?.recentEvents)).toBe(true);
		expect(JSON.stringify(lastDetails.progress?.recentEvents ?? [])).not.toContain("partialResult");
		expect(JSON.stringify(lastDetails.progress?.recentEvents ?? [])).not.toContain('"message":');
		for (const event of lastDetails.progress?.recentEvents ?? []) {
			if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
				expect(typeof event.toolName).toBe("string");
				expect(typeof event.toolCallId).toBe("string");
				if (event.type === "tool_execution_start") {
					expect(typeof event.argsSummary === "string" || event.argsSummary === undefined).toBe(true);
				}
				if (event.type === "tool_execution_end") {
					expect(typeof event.resultSummary === "string" || event.resultSummary === undefined).toBe(true);
					if (typeof event.resultSummary === "string") {
						expect(event.resultSummary.length).toBeLessThanOrEqual(100);
					}
				}
			}
		}
		session.dispose();
	});

	it("streams ordinary read-only filesystem tool events from sub-agents", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "sample.ts"), "export const marker = 'progress-readonly';\n", "utf-8");
		const { faux, modelRegistry } = setupModelRegistry();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const updates: Array<{ text: string; details: unknown }> = [];
		const tool = createObservedRunSubAgentTool(
			createRunSubAgentTool({
				cwd,
				agentDir,
				sharedStateRoot: join(cwd, "shared-state"),
				manifest: new MemorySharedStateManifest(),
				definitions: [
					{
						id: "reader",
						statePolicy: "session",
						systemPrompt: "Use read, grep, find, and ls to inspect src.",
					},
				],
			}),
			updates,
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
			noTools: "all",
			customTools: [tool],
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_subagent", { agentId: "reader", task: "inspect src" }, { id: "call-main" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[
					fauxToolCall("ls", { path: "src" }, { id: "sub-ls" }),
					fauxToolCall("read", { path: "src/sample.ts" }, { id: "sub-read" }),
					fauxToolCall("grep", { pattern: "progress-readonly", path: "src", literal: true }, { id: "sub-grep" }),
					fauxToolCall("find", { pattern: "*.ts", path: "src" }, { id: "sub-find" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("inspected src"),
			fauxAssistantMessage("main saw reader result"),
		]);

		await session.prompt("delegate to reader");

		for (const toolName of ["ls", "read", "grep", "find"]) {
			expect(updates.some((update) => update.text.includes(`tool_execution_start: ${toolName}`))).toBe(true);
			expect(updates.some((update) => update.text.includes(`tool_execution_end: ${toolName}`))).toBe(true);
		}
		const toolResult = session.messages.find((message) => isRunSubAgentToolResult(message));
		const completedToolNames = toolResult?.details?.progress?.completedTools.map(
			(tool: { toolName: string }) => tool.toolName,
		);
		expect(new Set(completedToolNames)).toEqual(new Set(["ls", "read", "grep", "find"]));
		expect(
			session.messages.filter((message) => message.role === "toolResult" && message.toolName !== "run_subagent"),
		).toEqual([]);
		session.dispose();
	});

	it("produces a failed progress summary for busy invocations without internal event history", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		const sharedStateRoot = join(cwd, "shared-state");
		const manifest = new MemorySharedStateManifest();
		const { faux, modelRegistry } = setupModelRegistry();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const tool = createRunSubAgentTool({
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
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
			noTools: "all",
			customTools: [tool],
		});
		faux.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("run_subagent", { agentId: "writer", task: "write first" }, { id: "call-1" }),
					fauxToolCall("run_subagent", { agentId: "writer", task: "write second" }, { id: "call-2" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("shared_state.write", { path: "prd/test.md", content: "writer ok" }, { id: "call-write" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("writer first done"),
			fauxAssistantMessage("main saw results"),
		]);

		await session.prompt("delegate twice to writer");

		const results = session.messages.filter((message) => isRunSubAgentToolResult(message));
		const failed = results.find((message) => message.details?.result?.errorCode === "SUB_AGENT_BUSY");
		expect(failed?.details?.progress?.currentPhase).toBe("failed");
		expect(failed?.details?.progress?.eventCount).toBe(0);
		expect(failed?.details?.progress?.recentEvents).toEqual([]);
		session.dispose();
	});

	it("surfaces internal sub-agent tool errors without changing final completion status", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		const sharedStateRoot = join(cwd, "shared-state");
		const manifest = new MemorySharedStateManifest();
		const { faux, modelRegistry } = setupModelRegistry();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const updates: Array<{ text: string; details: unknown }> = [];
		const tool = createObservedRunSubAgentTool(
			createRunSubAgentTool({
				cwd,
				agentDir,
				sharedStateRoot,
				manifest,
				definitions: [
					{
						id: "reader",
						statePolicy: "session",
						systemPrompt: "Read prd/missing.md, then report done.",
						accessSurfaces: [
							{
								type: "shared_state",
								grants: [{ space: "*", permissions: ["list", "read", "grep"] }],
							},
						],
					},
				],
			}),
			updates,
		);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
			noTools: "all",
			customTools: [tool],
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_subagent", { agentId: "reader", task: "read missing" }, { id: "call-main" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("shared_state.read", { path: "prd/missing.md" }, { id: "call-read" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done despite missing file"),
			fauxAssistantMessage("main saw reader result"),
		]);

		await session.prompt("delegate to reader");

		const toolResult = session.messages.find((message) => isRunSubAgentToolResult(message));
		expect(toolResult?.details?.result?.status).toBe("completed");
		expect(toolResult?.details?.progress).toMatchObject({
			currentPhase: "completed",
			internalToolErrors: 1,
			lastToolError: {
				toolName: "shared_state.read",
				toolCallId: "call-read",
			},
		});
		expect(toolResult?.details?.progress?.lastToolError?.message).toContain("ENOENT");
		expect(getMessageText(toolResult)).toContain("internalToolErrors: 1");
		expect(getMessageText(toolResult)).toContain("lastToolError: shared_state.read");
		expect(updates.some((update) => update.text.includes("internalToolErrors: 1"))).toBe(true);
		expect(updates.some((update) => update.text.includes("lastToolError: shared_state.read"))).toBe(true);
		expect(
			session.messages.filter((message) => message.role === "toolResult" && message.toolName !== "run_subagent"),
		).toEqual([]);
		session.dispose();
	});

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
		expect(toolResult?.details?.progress).toMatchObject({ currentPhase: "completed" });
		expect(Array.isArray(toolResult?.details?.progress?.recentEvents)).toBe(true);
		expect(manifest.get("prd/test.md")).toMatchObject({ ownerAgentId: "writer", version: 1 });
		expect(session.getActiveToolNames()).toEqual(["run_subagent"]);
		expect(session.messages.filter((message) => message.role === "user").map(getMessageText)).toEqual([
			"delegate to writer",
		]);
		session.dispose();
	});
});
