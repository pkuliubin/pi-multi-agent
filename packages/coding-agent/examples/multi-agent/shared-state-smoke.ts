import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { MemorySharedStateManifest } from "@earendil-works/pi-multi-agent";
import { createSharedStateTools } from "../../src/core/multi-agent/shared-state-tools.ts";

type SharedStateTool = ReturnType<typeof createSharedStateTools>[number];

interface ToolTextResult {
	content: Array<{ type: string; text?: string }>;
}

function textOf(result: ToolTextResult): string {
	return result.content
		.filter(
			(content): content is { type: "text"; text: string } =>
				content.type === "text" && typeof content.text === "string",
		)
		.map((content) => content.text)
		.join("\n");
}

function assertContains(name: string, text: string, expected: string): void {
	if (!text.includes(expected)) {
		throw new Error(`${name} expected output to contain ${JSON.stringify(expected)}, got:\n${text}`);
	}
}

function assertNotContains(name: string, text: string, unexpected: string): void {
	if (text.includes(unexpected)) {
		throw new Error(`${name} expected output not to contain ${JSON.stringify(unexpected)}, got:\n${text}`);
	}
}

function assertEqual(name: string, actual: unknown, expected: unknown): void {
	if (actual !== expected) {
		throw new Error(`${name} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

function readDisk(path: string): string {
	return readFileSync(path, "utf-8");
}

async function expectFailure(name: string, fn: () => Promise<unknown>, expected: string): Promise<void> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes(expected)) {
			throw new Error(`${name} expected error containing ${JSON.stringify(expected)}, got: ${message}`);
		}
		console.log(`[PASS] ${name}: ${message}`);
		return;
	}
	throw new Error(`${name} expected failure containing ${JSON.stringify(expected)}`);
}

async function execute(tool: SharedStateTool, params: unknown): Promise<ToolTextResult> {
	return (await tool.execute("manual-call", params, undefined, undefined, undefined as never)) as ToolTextResult;
}

function getTool(tools: SharedStateTool[], name: string): SharedStateTool {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`Tool not found: ${name}`);
	return tool;
}

async function main(): Promise<void> {
	const root = "/tmp/pi-shared-state-smoke";
	const prdPath = join(root, "prd/demo.md");
	const analysisPath = join(root, "analysis/findings.md");
	if (existsSync(root)) rmSync(root, { recursive: true, force: true });

	const manifest = new MemorySharedStateManifest();
	const ownerTools = createSharedStateTools({
		root,
		agentId: "owner-agent",
		manifest,
		grants: [
			{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"] },
			{ space: "analysis", permissions: ["list", "read", "grep", "write", "edit"] },
		],
	});
	const readerTools = createSharedStateTools({
		root,
		agentId: "reader-agent",
		manifest,
		grants: [{ space: "prd", permissions: ["list", "read", "grep"] }],
	});
	const editorTools = createSharedStateTools({
		root,
		agentId: "editor-agent",
		manifest,
		grants: [{ space: "prd", permissions: ["list", "read", "grep", "write", "edit"], canEditOthers: true }],
	});

	const ownerWrite = getTool(ownerTools, "shared_state.write");
	const ownerEdit = getTool(ownerTools, "shared_state.edit");
	const ownerRead = getTool(ownerTools, "shared_state.read");
	const ownerGrep = getTool(ownerTools, "shared_state.grep");
	const ownerList = getTool(ownerTools, "shared_state.list");
	const readerWrite = getTool(readerTools, "shared_state.write");
	const readerEdit = getTool(readerTools, "shared_state.edit");
	const readerRead = getTool(readerTools, "shared_state.read");
	const editorEdit = getTool(editorTools, "shared_state.edit");

	const initialPrd = "# Demo PRD\n\nStatus: draft\nOwner: owner-agent\n";
	const reviewedPrd = "# Demo PRD\n\nStatus: reviewed\nOwner: owner-agent\n";
	const finalPrd = "# Demo PRD\n\nStatus: edited-by-other\nOwner: owner-agent\n";
	const analysis = "# Findings\n\nMetric: 42\nConclusion: useful\n";

	await execute(ownerWrite, { path: "prd/demo.md", content: initialPrd });
	assertEqual("write prd disk content", readDisk(prdPath), initialPrd);
	assertEqual("write prd version", manifest.get("prd/demo.md")?.version, 1);

	await execute(ownerWrite, { path: "analysis/findings.md", content: analysis });
	assertEqual("write analysis disk content", readDisk(analysisPath), analysis);
	assertEqual("write analysis version", manifest.get("analysis/findings.md")?.version, 1);

	await execute(ownerEdit, {
		path: "prd/demo.md",
		expectedVersion: 1,
		edits: [{ oldText: "Status: draft", newText: "Status: reviewed" }],
	});
	assertEqual("edit prd disk content", readDisk(prdPath), reviewedPrd);
	assertEqual("edit prd version", manifest.get("prd/demo.md")?.version, 2);

	const readText = textOf(await execute(ownerRead, { path: "prd/demo.md", offset: 1, limit: 4 }));
	assertContains("read", readText, "Status: reviewed");
	assertNotContains("read range", readText, "edited-by-other");
	console.log(`\n[READ prd/demo.md offset=1 limit=4]\n${readText}`);

	const grepText = textOf(await execute(ownerGrep, { path: "analysis", pattern: "Metric", literal: true }));
	assertContains("grep", grepText, "findings.md:3: Metric: 42");
	assertNotContains("grep", grepText, "Demo PRD");
	console.log(`\n[GREP analysis Metric]\n${grepText}`);

	const listText = textOf(await execute(ownerList, {}));
	assertContains("list", listText, "prd/demo.md");
	assertContains("list", listText, "analysis/findings.md");
	assertContains("list", listText, "version=2");
	console.log(`\n[LIST authorized owner artifacts]\n${listText}`);

	const readerText = textOf(await execute(readerRead, { path: "prd/demo.md" }));
	assertEqual("reader read exact content", readerText, reviewedPrd);
	console.log(`\n[READER READ prd/demo.md]\n${readerText}`);

	await expectFailure(
		"reader cannot write without write permission",
		async () => {
			await execute(readerWrite, { path: "prd/reader.md", content: "nope" });
		},
		"permission denied",
	);
	assertEqual("failed reader write does not create file", existsSync(join(root, "prd/reader.md")), false);

	await expectFailure(
		"reader cannot edit owner artifact",
		async () => {
			await execute(readerEdit, {
				path: "prd/demo.md",
				edits: [{ oldText: "reviewed", newText: "reader-edit" }],
			});
		},
		"permission denied",
	);
	assertEqual("failed reader edit leaves prd unchanged", readDisk(prdPath), reviewedPrd);

	await expectFailure(
		"path escape is rejected",
		async () => {
			await execute(ownerWrite, { path: "../escape.md", content: "bad" });
		},
		"escapes",
	);
	assertEqual("path escape does not create file", existsSync(join(root, "../escape.md")), false);

	await expectFailure(
		"version mismatch is rejected",
		async () => {
			await execute(ownerEdit, {
				path: "prd/demo.md",
				expectedVersion: 1,
				edits: [{ oldText: "reviewed", newText: "stale" }],
			});
		},
		"version mismatch",
	);
	assertEqual("version mismatch leaves prd unchanged", readDisk(prdPath), reviewedPrd);
	assertEqual("version mismatch leaves version unchanged", manifest.get("prd/demo.md")?.version, 2);

	await execute(editorEdit, {
		path: "prd/demo.md",
		expectedVersion: 2,
		edits: [{ oldText: "Status: reviewed", newText: "Status: edited-by-other" }],
	});
	assertEqual("authorized other-agent edit content", readDisk(prdPath), finalPrd);
	assertEqual("authorized other-agent edit version", manifest.get("prd/demo.md")?.version, 3);
	assertEqual("authorized other-agent edit provenance", manifest.get("prd/demo.md")?.updatedBy, "editor-agent");

	const finalRead = textOf(await execute(ownerRead, { path: "prd/demo.md" }));
	assertEqual("final read exact content", finalRead, finalPrd);
	assertEqual("analysis file stays unchanged", readDisk(analysisPath), analysis);
	assertEqual("analysis version stays unchanged", manifest.get("analysis/findings.md")?.version, 1);

	console.log(`\n[FINAL READ prd/demo.md]\n${finalRead}`);
	console.log("\n[MANIFEST]");
	console.log(JSON.stringify(manifest.list(), null, 2));
	console.log(`\nFiles left at: ${root}`);
	console.log(`Try: cat ${join(root, "prd/demo.md")}`);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
