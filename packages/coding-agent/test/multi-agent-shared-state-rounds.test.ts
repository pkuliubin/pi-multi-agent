import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
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

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role === "user") {
			if (typeof message.content === "string") return message.content;
			return message.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("\n");
		}
	}
	return "";
}

function toolResultCount(context: Context): number {
	return context.messages.filter((message) => message.role === "toolResult").length;
}

function hasTrailingToolResult(context: Context): boolean {
	return context.messages[context.messages.length - 1]?.role === "toolResult";
}

function roundResponse(context: Context) {
	const task = lastUserText(context);
	if (hasTrailingToolResult(context)) {
		if (
			(task.includes("write PM draft") || task.includes("write once") || task.includes("write concurrently")) &&
			toolResultCount(context) >= 1
		) {
			return fauxAssistantMessage("pm wrote prd/pm.md");
		}
		if (task.includes("write engineering analysis") && toolResultCount(context) >= 1) {
			return fauxAssistantMessage("engineering wrote analysis/engineering.md");
		}
		if (task.includes("read engineering")) {
			const readCount = toolResultCount(context);
			return readCount <= 2
				? fauxAssistantMessage(
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
					)
				: fauxAssistantMessage("pm updated prd/pm.md with engineering input");
		}
		if (task.includes("read PM")) {
			const readCount = toolResultCount(context);
			return readCount <= 2
				? fauxAssistantMessage(
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
					)
				: fauxAssistantMessage("engineering updated analysis/engineering.md with PM input");
		}
		if (task.includes("final summary")) {
			const resultCount = toolResultCount(context);
			if (resultCount <= 2) {
				return fauxAssistantMessage(
					fauxToolCall("shared_state.read", { path: "analysis/engineering.md" }, { id: "syn-read-eng" }),
					{ stopReason: "toolUse" },
				);
			}
			if (resultCount === 3) {
				return fauxAssistantMessage(
					fauxToolCall(
						"shared_state.write",
						{ path: "summary/final.md", content: "Summary: user onboarding requires API support" },
						{ id: "syn-write" },
					),
					{ stopReason: "toolUse" },
				);
			}
			return fauxAssistantMessage("synthesis wrote summary/final.md");
		}
	}
	if (task.includes("write PM draft") || task.includes("write once") || task.includes("write concurrently")) {
		const content =
			task.includes("write once") || task.includes("write concurrently")
				? "PM single-session draft"
				: "PM draft: user onboarding";
		return fauxAssistantMessage(fauxToolCall("shared_state.write", { path: "prd/pm.md", content }, { id: "pm-r1" }), {
			stopReason: "toolUse",
		});
	}
	if (task.includes("write engineering analysis")) {
		return fauxAssistantMessage(
			fauxToolCall(
				"shared_state.write",
				{ path: "analysis/engineering.md", content: "Engineering draft: API required" },
				{ id: "eng-r1" },
			),
			{ stopReason: "toolUse" },
		);
	}
	if (task.includes("read engineering")) {
		return fauxAssistantMessage(
			fauxToolCall("shared_state.read", { path: "analysis/engineering.md" }, { id: "pm-read-r2" }),
			{ stopReason: "toolUse" },
		);
	}
	if (task.includes("read PM")) {
		return fauxAssistantMessage(fauxToolCall("shared_state.read", { path: "prd/pm.md" }, { id: "eng-read-r2" }), {
			stopReason: "toolUse",
		});
	}
	if (task.includes("final summary")) {
		return fauxAssistantMessage(fauxToolCall("shared_state.read", { path: "prd/pm.md" }, { id: "syn-read-pm" }), {
			stopReason: "toolUse",
		});
	}
	return fauxAssistantMessage("unexpected task");
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

		faux.setResponses(Array.from({ length: 20 }, () => roundResponse));

		const [pmRound1, engRound1] = await Promise.all([
			runner.run({ agentId: "pm-agent", task: "write PM draft" }),
			runner.run({ agentId: "engineering-agent", task: "write engineering analysis" }),
		]);
		expect(pmRound1, pmRound1.errorMessage ?? pmRound1.finalText).toMatchObject({ status: "completed" });
		expect(engRound1, engRound1.errorMessage ?? engRound1.finalText).toMatchObject({ status: "completed" });
		expect(pmRound1.startedAt).toBeLessThanOrEqual(engRound1.endedAt);
		expect(engRound1.startedAt).toBeLessThanOrEqual(pmRound1.endedAt);
		expect(manifest.get("prd/pm.md")).toMatchObject({ ownerAgentId: "pm-agent", version: 1 });
		expect(manifest.get("analysis/engineering.md")).toMatchObject({ ownerAgentId: "engineering-agent", version: 1 });

		const [pmRound2, engRound2] = await Promise.all([
			runner.run({ agentId: "pm-agent", task: "read engineering and update PM draft" }),
			runner.run({
				agentId: "engineering-agent",
				task: "read PM and update engineering analysis",
			}),
		]);
		expect(pmRound2, pmRound2.errorMessage ?? pmRound2.finalText).toMatchObject({ status: "completed" });
		expect(engRound2, engRound2.errorMessage ?? engRound2.finalText).toMatchObject({ status: "completed" });
		expect(manifest.get("prd/pm.md")).toMatchObject({ ownerAgentId: "pm-agent", updatedBy: "pm-agent", version: 2 });
		expect(manifest.get("analysis/engineering.md")).toMatchObject({
			ownerAgentId: "engineering-agent",
			updatedBy: "engineering-agent",
			version: 2,
		});
		expect(read(sharedStateRoot, "prd/pm.md")).toContain("Engineering input: API required");
		expect(read(sharedStateRoot, "analysis/engineering.md")).toContain("PM input: user onboarding");

		const synthesis = await runner.run({ agentId: "synthesis-agent", task: "write final summary" });
		expect(synthesis, synthesis.errorMessage ?? synthesis.finalText).toMatchObject({ status: "completed" });
		expect(manifest.get("summary/final.md")).toMatchObject({ ownerAgentId: "synthesis-agent", version: 1 });
		expect(read(sharedStateRoot, "summary/final.md")).toContain("user onboarding");
		expect(read(sharedStateRoot, "summary/final.md")).toContain("API support");
	});

	it("rejects concurrent calls to the same session agent without creating duplicate artifacts", async () => {
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
		faux.setResponses(Array.from({ length: 8 }, () => roundResponse));

		const [first, second] = await Promise.all([
			runner.run({ agentId: "pm-agent", task: "write once" }),
			runner.run({ agentId: "pm-agent", task: "write concurrently" }),
		]);
		const results = [first, second];

		expect(results.filter((result) => result.status === "completed")).toHaveLength(1);
		expect(results.filter((result) => result.status === "failed")).toHaveLength(1);
		expect(results.find((result) => result.status === "failed")?.errorMessage).toContain("already running");
		expect(manifest.get("prd/pm.md")).toMatchObject({ ownerAgentId: "pm-agent", version: 1 });
		expect(read(sharedStateRoot, "prd/pm.md")).toContain("PM single-session draft");
	});
});
