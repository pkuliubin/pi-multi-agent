import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.ts";
import { normalizeArtifactPath } from "../src/shared-state/path-safety.ts";

describe("normalizeArtifactPath", () => {
	it("normalizes relative artifact paths", () => {
		expect(normalizeArtifactPath("prd/../analysis/report.md")).toBe("analysis/report.md");
		expect(normalizeArtifactPath("foo\\bar.txt")).toBe("foo/bar.txt");
	});

	it("rejects path traversal", () => {
		expect(() => normalizeArtifactPath("../secret.txt")).toThrow(ApiError);
		expect(() => normalizeArtifactPath("/tmp/secret.txt")).toThrow(ApiError);
	});
});
