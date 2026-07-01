import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultSharedStateManifestPath, FileSharedStateManifest } from "../src/index.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = join(tmpdir(), `pi-file-shared-state-manifest-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

describe("FileSharedStateManifest", () => {
	it("persists and restores artifact provenance", () => {
		const root = tempDir();
		const path = defaultSharedStateManifestPath(root);
		const manifest = new FileSharedStateManifest(path);
		manifest.create({ path: "prd/pm.md", space: "prd", agentId: "pm-agent", now: "t1" });
		manifest.update({ path: "prd/pm.md", agentId: "pm-agent", now: "t2", metadata: { stage: "review" } });

		const restored = new FileSharedStateManifest(path);

		expect(restored.get("prd/pm.md")).toMatchObject({
			ownerAgentId: "pm-agent",
			createdBy: "pm-agent",
			updatedBy: "pm-agent",
			version: 2,
			createdAt: "t1",
			updatedAt: "t2",
			metadata: { stage: "review" },
		});
	});
});
