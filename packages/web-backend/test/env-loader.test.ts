import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadDotEnv } from "../src/env-loader.ts";

const touchedKeys = ["PI_ENV_LOADER_ROOT_VALUE", "PI_ENV_LOADER_CHILD_VALUE", "PI_ENV_LOADER_EXISTING"];

afterEach(() => {
	for (const key of touchedKeys) {
		delete process.env[key];
	}
});

describe("loadDotEnv", () => {
	it("loads .env files from cwd ancestors without overriding existing env", () => {
		const root = mkdtempSync(join(tmpdir(), "pi-web-backend-env-"));
		const child = join(root, "packages", "web-backend");
		mkdirSync(child, { recursive: true });
		writeFileSync(
			join(root, ".env"),
			["PI_ENV_LOADER_ROOT_VALUE=from-root", "PI_ENV_LOADER_EXISTING=from-root", "# ignored comment"].join("\n"),
		);
		writeFileSync(join(child, ".env"), "PI_ENV_LOADER_CHILD_VALUE='from-child'\n");
		process.env.PI_ENV_LOADER_EXISTING = "already-set";

		loadDotEnv(child);

		expect(process.env.PI_ENV_LOADER_ROOT_VALUE).toBe("from-root");
		expect(process.env.PI_ENV_LOADER_CHILD_VALUE).toBe("from-child");
		expect(process.env.PI_ENV_LOADER_EXISTING).toBe("already-set");
	});
});
