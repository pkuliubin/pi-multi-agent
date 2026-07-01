import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDefinitionIdentity, defaultRoleSessionIndexPath, FileRoleSessionIndex } from "../src/index.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = join(tmpdir(), `pi-role-session-index-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	while (dirs.length > 0) rmSync(dirs.pop() ?? "", { recursive: true, force: true });
});

describe("FileRoleSessionIndex", () => {
	it("binds a role session by main session, agent, and definition identity", () => {
		const cwd = tempDir();
		const index = new FileRoleSessionIndex(defaultRoleSessionIndexPath(cwd));
		const identity = createDefinitionIdentity(
			{ id: "pm-agent", statePolicy: "session", systemPrompt: "a" },
			"custom",
		);

		const binding = index.upsert({
			mainSessionId: "main-1",
			agentId: "pm-agent",
			definitionIdentity: identity,
			subAgentSessionId: "sub-1",
			subAgentSessionFile: "/tmp/sub-1.jsonl",
			state: "idle",
			now: "t1",
		});

		expect(index.find({ mainSessionId: "main-1", agentId: "pm-agent", definitionIdentity: identity })).toEqual(
			binding,
		);
		expect(
			index.find({ mainSessionId: "main-2", agentId: "pm-agent", definitionIdentity: identity }),
		).toBeUndefined();
	});

	it("does not reuse a binding when the definition fingerprint changes", () => {
		const cwd = tempDir();
		const index = new FileRoleSessionIndex(defaultRoleSessionIndexPath(cwd));
		const first = createDefinitionIdentity({ id: "pm-agent", statePolicy: "session", systemPrompt: "a" }, "custom");
		const second = createDefinitionIdentity({ id: "pm-agent", statePolicy: "session", systemPrompt: "b" }, "custom");

		index.upsert({
			mainSessionId: "main-1",
			agentId: "pm-agent",
			definitionIdentity: first,
			subAgentSessionId: "sub-1",
			subAgentSessionFile: "/tmp/sub-1.jsonl",
		});

		expect(index.find({ mainSessionId: "main-1", agentId: "pm-agent", definitionIdentity: second })).toBeUndefined();
	});

	it("includes file source path in definition identity", () => {
		const cwd = tempDir();
		const sourcePath = join(cwd, ".pi", "agents", "pm-agent.md");
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(sourcePath, "agent", "utf-8");

		const identity = createDefinitionIdentity(
			{ id: "pm-agent", statePolicy: "session", systemPrompt: "a", metadata: { sourcePath } },
			"file",
		);

		expect(identity).toMatchObject({ source: "file", sourcePath });
		expect(identity.fingerprint).toHaveLength(64);
	});

	it("updates lifecycle state without deleting bindings", () => {
		const cwd = tempDir();
		const index = new FileRoleSessionIndex(defaultRoleSessionIndexPath(cwd));
		const identity = createDefinitionIdentity({ id: "worker", statePolicy: "session" }, "custom");
		const key = { mainSessionId: "main", agentId: "worker", definitionIdentity: identity };

		index.upsert({
			...key,
			subAgentSessionId: "sub",
			subAgentSessionFile: "/tmp/sub.jsonl",
			state: "idle",
			now: "t1",
		});
		index.updateState(key, "running", "t2");

		expect(index.find(key)).toMatchObject({ state: "running", createdAt: "t1", updatedAt: "t2" });
	});
});
