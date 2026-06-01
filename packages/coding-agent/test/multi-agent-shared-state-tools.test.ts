import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySharedStateManifest, type SharedStateGrant } from "@earendil-works/pi-multi-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createSharedStateTools } from "../src/core/multi-agent/index.ts";

const createdDirs: string[] = [];

function createTempRoot(): string {
	const dir = join(tmpdir(), `pi-shared-state-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	createdDirs.push(dir);
	return dir;
}

function toolSet(
	options: { root?: string; agentId?: string; grants?: SharedStateGrant[]; manifest?: MemorySharedStateManifest } = {},
) {
	const manifest = options.manifest ?? new MemorySharedStateManifest();
	const tools = createSharedStateTools({
		root: options.root ?? createTempRoot(),
		agentId: options.agentId ?? "agent-a",
		grants: options.grants ?? [
			{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"] },
			{ space: "analysis", permissions: ["list", "read", "grep"] },
		],
		manifest,
	});
	return { manifest, tools: Object.fromEntries(tools.map((tool) => [tool.name, tool])) };
}

type ExecutableTool = {
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: never,
	): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

async function executeTool(tool: ExecutableTool, params: unknown) {
	return await tool.execute("call", params, undefined, undefined, undefined as never);
}

afterEach(() => {
	while (createdDirs.length > 0) {
		const dir = createdDirs.pop();
		if (dir && existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
});

describe("shared_state tools", () => {
	it("creates files with shared_state.write and records manifest provenance", async () => {
		const { manifest, tools } = toolSet();

		await executeTool(tools["shared_state.write"], { path: "prd/requirements.md", content: "hello" });

		expect(manifest.get("prd/requirements.md")).toMatchObject({
			path: "prd/requirements.md",
			space: "prd",
			ownerAgentId: "agent-a",
			createdBy: "agent-a",
			updatedBy: "agent-a",
			version: 1,
		});
	});

	it("reads line ranges from authorized files", async () => {
		const { tools } = toolSet();
		await executeTool(tools["shared_state.write"], { path: "prd/requirements.md", content: "one\ntwo\nthree" });

		const result = await executeTool(tools["shared_state.read"], {
			path: "prd/requirements.md",
			offset: 2,
			limit: 1,
		});

		expect(result.content[0].text).toContain("two");
		expect(result.content[0].text).not.toContain("one");
	});

	it("greps authorized shared state files", async () => {
		const { tools } = toolSet();
		await executeTool(tools["shared_state.write"], { path: "prd/requirements.md", content: "alpha\nbeta" });

		const result = await executeTool(tools["shared_state.grep"], { path: "prd", pattern: "beta", literal: true });

		expect(result.content[0].text).toContain("requirements.md");
		expect(result.content[0].text).toContain("beta");
	});

	it("edits authorized owner files and increments version", async () => {
		const { manifest, tools } = toolSet();
		await executeTool(tools["shared_state.write"], { path: "prd/requirements.md", content: "old text" });

		await executeTool(tools["shared_state.edit"], {
			path: "prd/requirements.md",
			edits: [{ oldText: "old", newText: "new" }],
			expectedVersion: 1,
		});
		const result = await executeTool(tools["shared_state.read"], { path: "prd/requirements.md" });

		expect(result.content[0].text).toContain("new text");
		expect(manifest.get("prd/requirements.md")?.version).toBe(2);
	});

	it("stores metadata on create, preserves it on update without metadata, and replaces it when provided", async () => {
		const { manifest, tools } = toolSet();
		await executeTool(tools["shared_state.write"], {
			path: "prd/requirements.md",
			content: "draft",
			metadata: { stage: "draft", tags: ["alpha"] },
		});

		expect(manifest.get("prd/requirements.md")?.metadata).toEqual({ stage: "draft", tags: ["alpha"] });

		await executeTool(tools["shared_state.edit"], {
			path: "prd/requirements.md",
			edits: [{ oldText: "draft", newText: "reviewed" }],
			expectedVersion: 1,
		});
		expect(manifest.get("prd/requirements.md")?.metadata).toEqual({ stage: "draft", tags: ["alpha"] });

		await executeTool(tools["shared_state.edit"], {
			path: "prd/requirements.md",
			edits: [{ oldText: "reviewed", newText: "approved" }],
			expectedVersion: 2,
			metadata: { stage: "approved", reviewedBy: "agent-a" },
		});

		expect(manifest.get("prd/requirements.md")).toMatchObject({
			version: 3,
			metadata: { stage: "approved", reviewedBy: "agent-a" },
		});
	});

	it("lists explicit authorized directories through the shared state root", async () => {
		const { tools } = toolSet();
		await executeTool(tools["shared_state.write"], { path: "prd/a.md", content: "a" });
		await executeTool(tools["shared_state.write"], { path: "prd/nested/b.md", content: "b" });

		const result = await executeTool(tools["shared_state.list"], { path: "prd" });

		expect(result.content[0].text).toContain("a.md");
		expect(result.content[0].text).toContain("nested/");
		expect(result.content[0].text).not.toContain("prd/a.md");
	});

	it("lists manifest artifacts with limit when path is omitted", async () => {
		const { tools } = toolSet();
		await executeTool(tools["shared_state.write"], { path: "prd/a.md", content: "a" });
		await executeTool(tools["shared_state.write"], { path: "prd/b.md", content: "b" });

		const result = await executeTool(tools["shared_state.list"], { limit: 1 });

		expect(result.content[0].text?.split("\n")).toHaveLength(1);
	});

	it("greps every authorized space when path is omitted", async () => {
		const { tools } = toolSet({
			grants: [
				{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"] },
				{ space: "analysis", permissions: ["list", "read", "grep", "write", "edit"] },
			],
		});
		await executeTool(tools["shared_state.write"], { path: "prd/a.md", content: "needle in prd" });
		await executeTool(tools["shared_state.write"], { path: "analysis/b.md", content: "needle in analysis" });

		const result = await executeTool(tools["shared_state.grep"], { pattern: "needle", literal: true });

		expect(result.content[0].text).toContain("a.md");
		expect(result.content[0].text).toContain("b.md");
	});

	it("lists only authorized manifest artifacts by default", async () => {
		const manifest = new MemorySharedStateManifest();
		const owner = toolSet({ manifest, agentId: "owner" });
		await executeTool(owner.tools["shared_state.write"], { path: "prd/a.md", content: "a" });
		await executeTool(owner.tools["shared_state.write"], { path: "secret/b.md", content: "b" }).catch(
			() => undefined,
		);
		manifest.create({ path: "secret/b.md", space: "secret", agentId: "owner" });
		const reader = toolSet({ manifest, agentId: "reader", grants: [{ space: "prd", permissions: ["list"] }] });

		const result = await executeTool(reader.tools["shared_state.list"], {});

		expect(result.content[0].text).toContain("prd/a.md");
		expect(result.content[0].text).not.toContain("secret/b.md");
	});

	it("lists all manifest artifacts by default with wildcard list grant", async () => {
		const root = createTempRoot();
		const manifest = new MemorySharedStateManifest();
		const owner = toolSet({
			root,
			manifest,
			agentId: "owner",
			grants: [
				{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"] },
				{ space: "analysis", permissions: ["list", "read", "grep", "write", "edit"] },
			],
		});
		await executeTool(owner.tools["shared_state.write"], { path: "prd/a.md", content: "a" });
		await executeTool(owner.tools["shared_state.write"], { path: "analysis/b.md", content: "b" });
		const reader = toolSet({
			root,
			manifest,
			agentId: "reader",
			grants: [{ space: "*", permissions: ["list"] }],
		});

		const result = await executeTool(reader.tools["shared_state.list"], {});

		expect(result.content[0].text).toContain("prd/a.md");
		expect(result.content[0].text).toContain("analysis/b.md");
	});

	it("uses wildcard read grants when owned-space grants only allow write and edit", async () => {
		const root = createTempRoot();
		const manifest = new MemorySharedStateManifest();
		const owner = toolSet({
			root,
			manifest,
			agentId: "owner",
			grants: [{ space: "analysis", permissions: ["list", "read", "grep", "write", "edit"] }],
		});
		await executeTool(owner.tools["shared_state.write"], { path: "analysis/b.md", content: "analysis" });
		const readerWriter = toolSet({
			root,
			manifest,
			agentId: "reader-writer",
			grants: [
				{ space: "*", permissions: ["list", "read", "grep"] },
				{ space: "analysis", permissions: ["write", "edit"] },
			],
		});

		const result = await executeTool(readerWriter.tools["shared_state.read"], { path: "analysis/b.md" });

		expect(result.content[0].text).toContain("analysis");
	});

	it("greps manifest spaces by default with wildcard grep grant", async () => {
		const root = createTempRoot();
		const manifest = new MemorySharedStateManifest();
		const owner = toolSet({
			root,
			manifest,
			agentId: "owner",
			grants: [
				{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"] },
				{ space: "analysis", permissions: ["list", "read", "grep", "write", "edit"] },
			],
		});
		await executeTool(owner.tools["shared_state.write"], { path: "prd/a.md", content: "needle in prd" });
		await executeTool(owner.tools["shared_state.write"], { path: "analysis/b.md", content: "needle in analysis" });
		const reader = toolSet({
			root,
			manifest,
			agentId: "reader",
			grants: [{ space: "*", permissions: ["grep"] }],
		});

		const result = await executeTool(reader.tools["shared_state.grep"], { pattern: "needle", literal: true });

		expect(result.content[0].text).toContain("a.md");
		expect(result.content[0].text).toContain("b.md");
	});

	it("rejects unauthorized spaces and path escapes", async () => {
		const { tools } = toolSet({ grants: [{ space: "prd", permissions: ["read", "write"] }] });

		await expect(executeTool(tools["shared_state.write"], { path: "analysis/a.md", content: "x" })).rejects.toThrow(
			"permission denied",
		);
		await expect(executeTool(tools["shared_state.write"], { path: "../prd/a.md", content: "x" })).rejects.toThrow(
			"escapes",
		);
		await expect(executeTool(tools["shared_state.write"], { path: "/tmp/a.md", content: "x" })).rejects.toThrow(
			"relative",
		);
		await expect(executeTool(tools["shared_state.write"], { path: "~/a.md", content: "x" })).rejects.toThrow(
			"relative",
		);
	});

	it("prevents non-owner overwrite and edit by default", async () => {
		const manifest = new MemorySharedStateManifest();
		const owner = toolSet({ manifest, agentId: "owner" });
		await executeTool(owner.tools["shared_state.write"], { path: "prd/a.md", content: "owner" });
		const other = toolSet({
			manifest,
			agentId: "other",
			grants: [{ space: "prd", permissions: ["read", "write", "edit"] }],
		});

		await expect(
			executeTool(other.tools["shared_state.write"], { path: "prd/a.md", content: "other" }),
		).rejects.toThrow("owned by owner");
		await expect(
			executeTool(other.tools["shared_state.edit"], {
				path: "prd/a.md",
				edits: [{ oldText: "owner", newText: "other" }],
			}),
		).rejects.toThrow("owned by owner");
	});

	it("allows explicit canOverwrite and canEditOthers", async () => {
		const manifest = new MemorySharedStateManifest();
		const owner = toolSet({ manifest, agentId: "owner" });
		await executeTool(owner.tools["shared_state.write"], { path: "prd/a.md", content: "first" });
		const overwriter = toolSet({
			manifest,
			agentId: "other",
			grants: [{ space: "prd", permissions: ["read", "write", "edit"], canOverwrite: true, canEditOthers: true }],
		});

		await executeTool(overwriter.tools["shared_state.write"], { path: "prd/a.md", content: "second" });
		await executeTool(overwriter.tools["shared_state.edit"], {
			path: "prd/a.md",
			edits: [{ oldText: "second", newText: "third" }],
		});
		const result = await executeTool(overwriter.tools["shared_state.read"], { path: "prd/a.md" });

		expect(result.content[0].text).toContain("third");
		expect(manifest.get("prd/a.md")?.version).toBe(3);
	});

	it("rejects expectedVersion mismatch on write and edit", async () => {
		const { tools } = toolSet();
		await executeTool(tools["shared_state.write"], { path: "prd/a.md", content: "first" });

		await expect(
			executeTool(tools["shared_state.write"], { path: "prd/a.md", content: "second", expectedVersion: 2 }),
		).rejects.toThrow("version mismatch");
		await expect(
			executeTool(tools["shared_state.edit"], {
				path: "prd/a.md",
				edits: [{ oldText: "first", newText: "second" }],
				expectedVersion: 2,
			}),
		).rejects.toThrow("version mismatch");
	});

	it("rejects write with expectedVersion when artifact does not exist", async () => {
		const { tools } = toolSet();

		await expect(
			executeTool(tools["shared_state.write"], {
				path: "prd/missing.md",
				content: "first",
				expectedVersion: 1,
			}),
		).rejects.toThrow("artifact not found for expectedVersion");
	});

	it("greps all authorized spaces by default when path is omitted", async () => {
		const { tools } = toolSet({
			grants: [
				{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"] },
				{ space: "analysis", permissions: ["list", "read", "grep", "write"] },
			],
		});
		await executeTool(tools["shared_state.write"], { path: "prd/requirements.md", content: "alpha\nneedle" });
		await executeTool(tools["shared_state.write"], { path: "analysis/summary.md", content: "needle\nbeta" });

		const result = await executeTool(tools["shared_state.grep"], { pattern: "needle", literal: true });

		expect(result.content[0].text).toContain("requirements.md:2: needle");
		expect(result.content[0].text).toContain("summary.md:1: needle");
	});

	it("applies grep limit globally when path is omitted", async () => {
		const { tools } = toolSet({
			grants: [
				{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"] },
				{ space: "analysis", permissions: ["list", "read", "grep", "write", "edit"] },
			],
		});
		await executeTool(tools["shared_state.write"], { path: "prd/a.md", content: "needle in prd" });
		await executeTool(tools["shared_state.write"], { path: "analysis/b.md", content: "needle in analysis" });

		const result = await executeTool(tools["shared_state.grep"], { pattern: "needle", literal: true, limit: 1 });

		expect(result.content[0].text?.split("\n")).toHaveLength(1);
	});

	it("exposes only shared_state tool names", () => {
		const { tools } = toolSet();

		expect(Object.keys(tools).sort()).toEqual([
			"shared_state.edit",
			"shared_state.grep",
			"shared_state.list",
			"shared_state.read",
			"shared_state.write",
		]);
	});
});
