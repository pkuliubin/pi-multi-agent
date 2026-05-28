import { describe, expect, it } from "vitest";
import { MemorySharedStateManifest } from "../src/index.ts";

describe("MemorySharedStateManifest", () => {
	it("creates artifacts at version 1 with ownership provenance", () => {
		const manifest = new MemorySharedStateManifest();

		const artifact = manifest.create({ path: "prd/requirements.md", space: "prd", agentId: "planner", now: "t1" });

		expect(artifact).toMatchObject({
			path: "prd/requirements.md",
			space: "prd",
			ownerAgentId: "planner",
			createdBy: "planner",
			updatedBy: "planner",
			version: 1,
			createdAt: "t1",
			updatedAt: "t1",
		});
		expect(manifest.get("prd/requirements.md")).toStrictEqual(artifact);
		expect(manifest.get("prd/requirements.md")).not.toBe(artifact);
	});

	it("updates artifacts and increments version", () => {
		const manifest = new MemorySharedStateManifest();
		manifest.create({ path: "analysis/findings.md", space: "analysis", agentId: "analyst", now: "t1" });

		const updated = manifest.update({ path: "analysis/findings.md", agentId: "analyst", now: "t2" });

		expect(updated).toMatchObject({ version: 2, createdAt: "t1", updatedAt: "t2", updatedBy: "analyst" });
	});

	it("enforces expectedVersion when provided", () => {
		const manifest = new MemorySharedStateManifest();
		manifest.create({ path: "prd/requirements.md", space: "prd", agentId: "planner" });

		expect(() => manifest.update({ path: "prd/requirements.md", agentId: "planner", expectedVersion: 2 })).toThrow(
			"version mismatch",
		);
		expect(manifest.update({ path: "prd/requirements.md", agentId: "planner", expectedVersion: 1 }).version).toBe(2);
	});

	it("returns cloned artifacts so external mutation cannot corrupt manifest", () => {
		const manifest = new MemorySharedStateManifest();
		const artifact = manifest.create({
			path: "prd/a.md",
			space: "prd",
			agentId: "planner",
			metadata: { stage: "draft", nested: { tags: ["alpha"] } },
		});

		artifact.version = 99;
		if (artifact.metadata) artifact.metadata.stage = "mutated";
		(artifact.metadata?.nested as { tags: string[] }).tags.push("mutated");
		const listed = manifest.list("prd");
		listed[0].ownerAgentId = "other";

		expect(manifest.get("prd/a.md")).toMatchObject({
			version: 1,
			ownerAgentId: "planner",
			metadata: { stage: "draft", nested: { tags: ["alpha"] } },
		});
	});

	it("lists artifacts by space", () => {
		const manifest = new MemorySharedStateManifest();
		manifest.create({ path: "prd/a.md", space: "prd", agentId: "planner" });
		manifest.create({ path: "analysis/b.md", space: "analysis", agentId: "analyst" });

		expect(manifest.list("prd").map((artifact) => artifact.path)).toEqual(["prd/a.md"]);
		expect(
			manifest
				.list()
				.map((artifact) => artifact.path)
				.sort(),
		).toEqual(["analysis/b.md", "prd/a.md"]);
	});
});
