import { describe, expect, it } from "vitest";
import { type PiSubAgentDefinition, PiSubAgentInstance, SubAgentRegistry } from "../src/index.ts";
import { MockAgentSession } from "./test-utils.ts";

function definition(id: string, statePolicy: PiSubAgentDefinition["statePolicy"] = "session"): PiSubAgentDefinition {
	return { id, statePolicy };
}

describe("SubAgentRegistry", () => {
	it("registers, gets, and lists definitions in registration order", () => {
		const registry = new SubAgentRegistry();
		const first = definition("first");
		const second = definition("second", "ephemeral");

		registry.register(first);
		registry.register(second);

		expect(registry.get("first")).toBe(first);
		expect(registry.get("missing")).toBeUndefined();
		expect(registry.list()).toEqual([first, second]);
	});

	it("rejects duplicate ids", () => {
		const registry = new SubAgentRegistry();
		registry.register(definition("worker"));

		expect(() => registry.register(definition("worker"))).toThrow("already registered");
	});

	it("returns a copy from list", () => {
		const registry = new SubAgentRegistry();
		const worker = definition("worker");
		registry.register(worker);

		const list = registry.list();
		list.pop();

		expect(registry.list()).toEqual([worker]);
	});

	it("allows persistent definitions in registry but rejects persistent instances", () => {
		const registry = new SubAgentRegistry();
		const persistent = definition("persistent", "persistent");
		registry.register(persistent);

		expect(registry.get("persistent")).toBe(persistent);
		expect(() => new PiSubAgentInstance(persistent, new MockAgentSession())).toThrow("persistent");
	});
});
