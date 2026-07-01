import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import {
	defaultSharedStateManifestPath,
	FileRoleSessionIndex,
	FileSharedStateManifest,
	type PiSubAgentDefinition,
} from "@earendil-works/pi-multi-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createRunSubAgentTool, defaultSharedStateRoot } from "../src/core/multi-agent/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { getMessageText } from "./suite/harness.ts";

const createdDirs: string[] = [];
const cleanupCallbacks: Array<() => void> = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `pi-persistent-subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe("persistent sub-agent runtime", () => {
	it("resumes a session-style sub-agent across runner recreation", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		const sessionDir = join(cwd, "sessions");
		const sharedStateRoot = join(cwd, "shared-state");
		const roleSessionIndexPath = join(cwd, ".pi", "multi-agent", "role-sessions.json");
		mkdirSync(agentDir, { recursive: true });
		const { faux, modelRegistry } = setupModelRegistry();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const definitions: PiSubAgentDefinition[] = [
			{
				id: "writer",
				statePolicy: "session" as const,
				systemPrompt: "Use shared_state.write to write prd/persist.md.",
				accessSurfaces: [
					{ type: "shared_state" as const, grants: [{ space: "prd", permissions: ["list", "read", "write"] }] },
				],
			},
		];
		const createTool = () =>
			createRunSubAgentTool({
				cwd,
				agentDir,
				definitions,
				sharedStateRoot,
				mainSessionId: "main-session",
				sessionDir,
				roleSessionIndexPath,
			});
		const first = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
			noTools: "all",
			customTools: [createTool()],
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_subagent", { agentId: "writer", task: "write first" }, { id: "run-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("shared_state.write", { path: "prd/persist.md", content: "first" }, { id: "write-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("writer first"),
			fauxAssistantMessage("main first"),
		]);

		await first.session.prompt("first delegation");
		first.session.dispose();
		const binding = new FileRoleSessionIndex(roleSessionIndexPath).list("main-session")[0];
		expect(binding?.subAgentSessionFile).toBeTruthy();
		expect(existsSync(binding!.subAgentSessionFile)).toBe(true);
		const second = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRegistry,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			resourceLoader,
			noTools: "all",
			customTools: [createTool()],
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_subagent", { agentId: "writer", task: "write second" }, { id: "run-2" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("shared_state.write", { path: "prd/persist.md", content: "second" }, { id: "write-2" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("writer second"),
			fauxAssistantMessage("main second"),
		]);

		await second.session.prompt("second delegation");

		const toolResults = second.session.messages.filter((message) => isRunSubAgentToolResult(message));
		const text = getMessageText(toolResults[0]);
		expect(text).toContain(`sessionId: ${binding!.subAgentSessionId}`);
		expect(text).toContain("messages: 4->");
		expect(new FileRoleSessionIndex(roleSessionIndexPath).list("main-session")).toHaveLength(1);
		second.session.dispose();
	});

	it("keeps the default shared-state root stable when resuming the same main session", async () => {
		const cwd = createTempDir();
		const agentDir = join(cwd, "agent");
		const sessionDir = join(cwd, "sessions");
		mkdirSync(agentDir, { recursive: true });
		const { faux, modelRegistry } = setupModelRegistry();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const definitions: PiSubAgentDefinition[] = [
			{
				id: "writer",
				statePolicy: "session",
				systemPrompt: "Use shared_state.write to maintain prd/default-root.md.",
				accessSurfaces: [
					{
						type: "shared_state",
						grants: [{ space: "prd", permissions: ["list", "read", "write", "edit"] }],
					},
				],
			},
		];
		const createTool = (mainSessionId: string) =>
			createRunSubAgentTool({
				cwd,
				agentDir,
				definitions,
				mainSessionId,
				sessionDir,
			});
		const firstMainSession = SessionManager.create(cwd, sessionDir);
		const expectedSharedStateRoot = defaultSharedStateRoot(cwd, firstMainSession.getSessionId());
		const first = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRegistry,
			settingsManager,
			sessionManager: firstMainSession,
			resourceLoader,
			noTools: "all",
			customTools: [createTool(firstMainSession.getSessionId())],
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_subagent", { agentId: "writer", task: "write initial artifact" }, { id: "run-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("shared_state.write", { path: "prd/default-root.md", content: "first" }, { id: "write-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("writer first"),
			fauxAssistantMessage("main first"),
		]);

		await first.session.prompt("first delegation");
		const firstToolResult = first.session.messages.find((message) => isRunSubAgentToolResult(message));
		expect(firstToolResult?.details).toMatchObject({ sharedStateRoot: expectedSharedStateRoot });
		expect(readFileSync(join(expectedSharedStateRoot, "prd", "default-root.md"), "utf-8")).toBe("first");
		const mainSessionFile = firstMainSession.getSessionFile();
		expect(mainSessionFile).toBeTruthy();
		first.session.dispose();

		const resumedMainSession = SessionManager.open(mainSessionFile!, sessionDir, cwd);
		expect(resumedMainSession.getSessionId()).toBe(firstMainSession.getSessionId());
		const second = await createAgentSession({
			cwd,
			agentDir,
			model: faux.getModel(),
			modelRegistry,
			settingsManager,
			sessionManager: resumedMainSession,
			resourceLoader,
			noTools: "all",
			customTools: [createTool(resumedMainSession.getSessionId())],
		});
		faux.setResponses([
			fauxAssistantMessage(
				fauxToolCall("run_subagent", { agentId: "writer", task: "update existing artifact" }, { id: "run-2" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall(
					"shared_state.write",
					{ path: "prd/default-root.md", content: "second", expectedVersion: 1 },
					{ id: "write-2" },
				),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("writer second"),
			fauxAssistantMessage("main second"),
		]);

		await second.session.prompt("second delegation");

		const secondToolResults = second.session.messages.filter((message) => isRunSubAgentToolResult(message));
		const secondToolResult = secondToolResults[secondToolResults.length - 1];
		expect(secondToolResult?.details).toMatchObject({ sharedStateRoot: expectedSharedStateRoot });
		expect(readFileSync(join(expectedSharedStateRoot, "prd", "default-root.md"), "utf-8")).toBe("second");
		const restoredManifest = new FileSharedStateManifest(defaultSharedStateManifestPath(expectedSharedStateRoot));
		expect(restoredManifest.get("prd/default-root.md")).toMatchObject({ version: 2, ownerAgentId: "writer" });
		second.session.dispose();
	});

	it("persists shared state manifest across tool recreation", async () => {
		const cwd = createTempDir();
		const sharedStateRoot = join(cwd, "shared-state");
		const manifestPath = defaultSharedStateManifestPath(sharedStateRoot);
		const first = new FileSharedStateManifest(manifestPath);
		first.create({ path: "prd/manifest.md", space: "prd", agentId: "writer", now: "t1" });
		const second = new FileSharedStateManifest(manifestPath);
		second.update({ path: "prd/manifest.md", agentId: "writer", expectedVersion: 1, now: "t2" });
		const restored = new FileSharedStateManifest(manifestPath);

		expect(restored.get("prd/manifest.md")).toMatchObject({
			path: "prd/manifest.md",
			ownerAgentId: "writer",
			version: 2,
			createdAt: "t1",
			updatedAt: "t2",
		});
	});
});
