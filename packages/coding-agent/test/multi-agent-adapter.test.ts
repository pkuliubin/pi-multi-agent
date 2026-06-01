import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { type PiSubAgentDefinition, PiSubAgentInstance } from "@earendil-works/pi-multi-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { adaptAgentSession } from "../src/core/multi-agent/agent-session-adapter.ts";
import { RestrictedSubAgentResourceLoader } from "../src/core/multi-agent/restricted-resource-loader.ts";
import { CodingAgentSessionFactory } from "../src/core/multi-agent/session-factory.ts";
import { createHarness, getMessageText } from "./suite/harness.ts";

const createdDirs: string[] = [];
const cleanupCallbacks: Array<() => void> = [];

function createTempDir(): string {
	const dir = join(tmpdir(), `pi-multi-agent-adapter-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	createdDirs.push(dir);
	return dir;
}

function baseDefinition(overrides: Partial<PiSubAgentDefinition> = {}): PiSubAgentDefinition {
	return {
		id: "worker",
		statePolicy: "session",
		...overrides,
	};
}

async function createFauxSubAgent(definition: PiSubAgentDefinition = baseDefinition()) {
	const cwd = createTempDir();
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
	const sessionFactory = new CodingAgentSessionFactory({ modelRegistry });
	const session = await sessionFactory.create({
		definition,
		cwd,
		model: faux.getModel(),
		sessionPolicy: definition.statePolicy === "ephemeral" ? "ephemeral" : "session",
	});
	return { cwd, faux, session, subAgent: new PiSubAgentInstance(definition, session) };
}

function toolResult(messages: unknown[], toolName: string): ToolResultMessage | undefined {
	return messages.find(
		(message): message is ToolResultMessage =>
			typeof message === "object" &&
			message !== null &&
			"role" in message &&
			(message as { role: unknown }).role === "toolResult" &&
			"toolName" in message &&
			(message as { toolName: unknown }).toolName === toolName,
	);
}

afterEach(() => {
	while (cleanupCallbacks.length > 0) {
		cleanupCallbacks.pop()?.();
	}
	while (createdDirs.length > 0) {
		rmSync(createdDirs.pop()!, { recursive: true, force: true });
	}
});

describe("coding-agent multi-agent adapter", () => {
	it("adapts AgentSession identity, state, model, and thinking level", async () => {
		const harness = await createHarness();
		cleanupCallbacks.push(harness.cleanup);

		const adapted = adaptAgentSession(harness.session);

		expect(adapted.sessionId).toBe(harness.session.sessionId);
		expect(adapted.sessionFile).toBe(harness.session.sessionFile);
		expect(adapted.state).toBe(harness.session.state);
		expect(adapted.model).toBe(harness.session.model);
		expect(adapted.thinkingLevel).toBe(harness.session.thinkingLevel);
	});

	it("invokes a real AgentSession loop through PiSubAgentInstance", async () => {
		const { faux, subAgent, session } = await createFauxSubAgent();
		faux.setResponses([fauxAssistantMessage("sub-agent done")]);

		const result = await subAgent.invoke("do work");

		expect(result).toMatchObject({ status: "completed", finalText: "sub-agent done" });
		expect(session.state.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
	});

	it("keeps sub-agent transcript isolated from the main session", async () => {
		const mainHarness = await createHarness();
		cleanupCallbacks.push(mainHarness.cleanup);
		const { faux, subAgent } = await createFauxSubAgent();
		faux.setResponses([fauxAssistantMessage("isolated")]);

		await subAgent.invoke("sub task");

		expect(mainHarness.session.messages).toEqual([]);
	});

	it("starts with read-only filesystem tools and no discovered resources", async () => {
		const { session } = await createFauxSubAgent();

		expect(session.getActiveToolNames()).toEqual(["read", "grep", "find", "ls"]);
		expect(session.resourceLoader).toBeInstanceOf(RestrictedSubAgentResourceLoader);
		expect(session.resourceLoader.getSkills().skills).toEqual([]);
		expect(session.resourceLoader.getPrompts().prompts).toEqual([]);
		expect(session.resourceLoader.getThemes().themes).toEqual([]);
		expect(session.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
		expect(session.resourceLoader.getExtensions().extensions).toEqual([]);
	});

	it("can use read-only filesystem tools but not write, edit, or bash", async () => {
		const definition = baseDefinition({
			systemPrompt: "Use read, grep, find, and ls when asked. Never summarize without tools.",
		});
		const { cwd, faux, session, subAgent } = await createFauxSubAgent(definition);
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(join(cwd, "src", "sample.ts"), "export const marker = 'sub-agent-readonly';\n", "utf-8");
		const absolutePath = join(cwd, "src", "sample.ts");
		faux.setResponses([
			fauxAssistantMessage(
				[
					{ type: "toolCall", id: "sub-ls", name: "ls", arguments: { path: "src" } },
					{ type: "toolCall", id: "sub-read", name: "read", arguments: { path: absolutePath } },
					{
						type: "toolCall",
						id: "sub-grep",
						name: "grep",
						arguments: { pattern: "sub-agent-readonly", path: "src", literal: true },
					},
					{ type: "toolCall", id: "sub-find", name: "find", arguments: { pattern: "*.ts", path: "src" } },
					{
						type: "toolCall",
						id: "sub-write",
						name: "write",
						arguments: { path: "src/created.ts", content: "nope" },
					},
					{ type: "toolCall", id: "sub-edit", name: "edit", arguments: { path: "src/sample.ts", edits: [] } },
					{ type: "toolCall", id: "sub-bash", name: "bash", arguments: { command: "echo nope" } },
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("readonly tools checked"),
		]);

		const result = await subAgent.invoke("inspect src");

		expect(result.status).toBe("completed");
		const toolResults = session.state.messages.filter((message) => message.role === "toolResult");
		expect(getMessageText(toolResult(toolResults, "ls"))).toContain("sample.ts");
		expect(getMessageText(toolResult(toolResults, "read"))).toContain("sub-agent-readonly");
		expect(getMessageText(toolResult(toolResults, "grep"))).toContain("sub-agent-readonly");
		expect(getMessageText(toolResult(toolResults, "find"))).toContain("sample.ts");
		expect(getMessageText(toolResult(toolResults, "write"))).toContain("Tool write not found");
		expect(getMessageText(toolResult(toolResults, "edit"))).toContain("Tool edit not found");
		expect(getMessageText(toolResult(toolResults, "bash"))).toContain("Tool bash not found");
	});

	it("does not load AGENTS.md or CLAUDE.md from cwd", async () => {
		const cwd = createTempDir();
		writeFileSync(join(cwd, "AGENTS.md"), "PROJECT AGENTS SHOULD NOT LOAD", "utf-8");
		writeFileSync(join(cwd, "CLAUDE.md"), "CLAUDE SHOULD NOT LOAD", "utf-8");
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
		const session = await new CodingAgentSessionFactory({ modelRegistry }).create({
			definition: baseDefinition({ systemPrompt: "sub prompt only" }),
			cwd,
			model: faux.getModel(),
			sessionPolicy: "session",
		});

		expect(session.state.systemPrompt).toContain("sub prompt only");
		expect(session.state.systemPrompt).not.toContain("PROJECT AGENTS SHOULD NOT LOAD");
		expect(session.state.systemPrompt).not.toContain("CLAUDE SHOULD NOT LOAD");
	});

	it("rejects accessSurfaces without runner-mounted capability tools", async () => {
		const cwd = createTempDir();
		const faux = registerFauxProvider();
		cleanupCallbacks.push(() => faux.unregister());
		const factory = new CodingAgentSessionFactory();
		await expect(
			factory.create({
				definition: {
					id: "worker",
					statePolicy: "session",
					accessSurfaces: [{ type: "shared_state", grants: [{ space: "prd", permissions: ["list"] }] }],
				},
				cwd,
				model: faux.getModel(),
				thinkingLevel: "off",
				sessionPolicy: "session",
			}),
		).rejects.toThrow("runner-mounted capability tools");
	});

	it("rejects non-array capability tools with a clear error", async () => {
		const cwd = createTempDir();
		const faux = registerFauxProvider();
		cleanupCallbacks.push(() => faux.unregister());
		const factory = new CodingAgentSessionFactory();
		await expect(
			factory.create({
				definition: { id: "worker", statePolicy: "session" },
				cwd,
				model: faux.getModel(),
				thinkingLevel: "off",
				sessionPolicy: "session",
				capabilities: { tools: "bad" as unknown as unknown[] },
			}),
		).rejects.toThrow("must be an array");
	});

	it("rejects malformed capability tools before accessing optional fields", async () => {
		const cwd = createTempDir();
		const faux = registerFauxProvider();
		cleanupCallbacks.push(() => faux.unregister());
		const factory = new CodingAgentSessionFactory();
		await expect(
			factory.create({
				definition: { id: "worker", statePolicy: "session" },
				cwd,
				model: faux.getModel(),
				thinkingLevel: "off",
				sessionPolicy: "session",
				capabilities: { tools: [{ name: "broken", execute: () => Promise.resolve() }] },
			}),
		).rejects.toThrow("ToolDefinition objects");
	});

	it("rejects OpenAI-compatible capability tool name collisions after sanitization", async () => {
		const cwd = createTempDir();
		const faux = registerFauxProvider();
		cleanupCallbacks.push(() => faux.unregister());
		const model: Model<"openai-completions"> = {
			...faux.getModel(),
			api: "openai-completions",
		};
		const tool = (name: string): ToolDefinition => ({
			name,
			label: name,
			description: name,
			parameters: {} as ToolDefinition["parameters"],
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		});
		await expect(
			new CodingAgentSessionFactory().create({
				definition: { id: "worker", statePolicy: "session" },
				cwd,
				model,
				thinkingLevel: "off",
				sessionPolicy: "session",
				capabilities: { tools: [tool("db.query"), tool("db/query")] },
			}),
		).rejects.toThrow("tool name collision");
	});

	it("rejects unsupported definition resource metadata", async () => {
		const cwd = createTempDir();
		await expect(
			new CodingAgentSessionFactory().create({
				definition: baseDefinition({ metadata: { tools: ["read"] } }),
				cwd,
				sessionPolicy: "session",
			}),
		).rejects.toThrow("not supported");
	});

	it("forwards prompt, followUp, steer, subscribe, abort, waitForIdle, and dispose", async () => {
		const { faux, subAgent, session } = await createFauxSubAgent();
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		let eventCount = 0;
		const unsubscribe = subAgent.subscribe(() => {
			eventCount += 1;
		});

		await subAgent.prompt("hello");
		await subAgent.followUp("next");
		await subAgent.waitForIdle();
		await subAgent.steer("queued steer");
		await subAgent.abort();
		unsubscribe();
		await subAgent.close();

		expect(session.state.messages.length).toBeGreaterThanOrEqual(2);
		expect(eventCount).toBeGreaterThan(0);
		expect(subAgent.phase).toBe("closed");
	});

	it("supports ephemeral session policy creation", async () => {
		const { session } = await createFauxSubAgent(baseDefinition({ statePolicy: "ephemeral" }));

		expect(session.sessionId).toBeTruthy();
	});
});
