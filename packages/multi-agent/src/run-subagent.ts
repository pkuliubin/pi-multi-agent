import type {
	CreateSubAgentInstanceInput,
	RunSubAgentInput,
	RunSubAgentRunnerOptions,
	RunSubAgentSessionFactory,
	SubAgentAccessSurfaceDefinition,
	SubAgentCapabilities,
} from "./run-subagent-types.ts";
import { PiSubAgentInstance } from "./sub-agent.ts";
import type { PiSubAgentDefinition, SubAgentResult } from "./types.ts";

const DEFAULT_MAX_CONCURRENT_SUB_AGENTS = 8;

export class SubAgentInstancePool {
	private readonly instances = new Map<string, PiSubAgentInstance>();
	private readonly pendingInstances = new Map<string, Promise<PiSubAgentInstance>>();
	private readonly instanceKeys = new Map<string, string>();
	private readonly pendingKeys = new Map<string, string>();

	get(agentId: string): PiSubAgentInstance | undefined {
		return this.instances.get(agentId);
	}

	set(agentId: string, instance: PiSubAgentInstance, key = ""): void {
		this.instances.set(agentId, instance);
		this.instanceKeys.set(agentId, key);
	}

	async getOrCreate(
		agentId: string,
		key: string,
		create: () => Promise<PiSubAgentInstance>,
	): Promise<PiSubAgentInstance> {
		const existing = this.instances.get(agentId);
		if (existing) {
			if (this.instanceKeys.get(agentId) === key) return existing;
			if (existing.phase === "running") return existing;
			this.instances.delete(agentId);
			this.instanceKeys.delete(agentId);
			await existing.close();
		}
		const pending = this.pendingInstances.get(agentId);
		if (pending) {
			const instance = await pending;
			if (this.pendingKeys.get(agentId) === key || instance.phase === "running") return instance;
			this.instances.delete(agentId);
			this.instanceKeys.delete(agentId);
			await instance.close();
		}
		const next = create();
		this.pendingInstances.set(agentId, next);
		this.pendingKeys.set(agentId, key);
		try {
			const instance = await next;
			this.instances.set(agentId, instance);
			this.instanceKeys.set(agentId, key);
			return instance;
		} finally {
			if (this.pendingInstances.get(agentId) === next) {
				this.pendingInstances.delete(agentId);
				this.pendingKeys.delete(agentId);
			}
		}
	}

	async closeAll(): Promise<void> {
		const pending = [...this.pendingInstances.values()];
		this.pendingInstances.clear();
		this.pendingKeys.clear();
		const instances = [...this.instances.values()];
		this.instances.clear();
		this.instanceKeys.clear();
		const created = await Promise.allSettled(pending);
		const pendingInstances = created
			.filter((result): result is PromiseFulfilledResult<PiSubAgentInstance> => result.status === "fulfilled")
			.map((result) => result.value);
		await Promise.all([...instances, ...pendingInstances].map((instance) => instance.close()));
	}
}

export class RunSubAgentRunner {
	private readonly options: RunSubAgentRunnerOptions;
	private readonly pool = new SubAgentInstancePool();
	private activeRuns = 0;

	constructor(options: RunSubAgentRunnerOptions) {
		this.options = options;
	}

	async run(input: RunSubAgentInput): Promise<SubAgentResult> {
		const startedAt = Date.now();
		const definition = this.options.registry.get(input.agentId);
		if (!definition) {
			return failedResult(input, startedAt, `SubAgent definition not found: ${input.agentId}`);
		}
		if (definition.statePolicy === "persistent") {
			return failedResult(input, startedAt, "SubAgent statePolicy 'persistent' is not supported in this phase");
		}
		const sessionPolicy = input.statePolicyOverride ?? definition.statePolicy;
		const maxConcurrent = this.options.maxConcurrentSubAgents ?? DEFAULT_MAX_CONCURRENT_SUB_AGENTS;
		if (this.activeRuns >= maxConcurrent) {
			return failedResult(input, startedAt, `Too many active sub-agent runs: ${this.activeRuns}/${maxConcurrent}`);
		}

		this.activeRuns += 1;
		let ephemeralInstance: PiSubAgentInstance | undefined;
		try {
			const instance = await this.getInstance(definition, sessionPolicy, input.model, input.thinkingLevel);
			if (sessionPolicy === "ephemeral") ephemeralInstance = instance;
			if (instance.phase === "running") {
				return failedResult(input, startedAt, `SubAgent is already running: ${definition.id}`);
			}
			return await this.invokeWithOptionalTimeout(instance, input, startedAt);
		} catch (error) {
			return failedResult(input, startedAt, error instanceof Error ? error.message : String(error));
		} finally {
			this.activeRuns -= 1;
			if (ephemeralInstance) {
				await ephemeralInstance.close();
			}
		}
	}

	async close(): Promise<void> {
		await this.pool.closeAll();
	}

	private async getInstance(
		definition: PiSubAgentDefinition,
		sessionPolicy: "ephemeral" | "session",
		model: unknown,
		thinkingLevel: unknown,
	): Promise<PiSubAgentInstance> {
		if (sessionPolicy === "session") {
			const key = sessionReuseKey(model, thinkingLevel);
			return await this.pool.getOrCreate(definition.id, key, () =>
				this.createInstance(definition, sessionPolicy, model, thinkingLevel),
			);
		}
		return await this.createInstance(definition, sessionPolicy, model, thinkingLevel);
	}

	private async createInstance(
		definition: PiSubAgentDefinition,
		sessionPolicy: "ephemeral" | "session",
		model: unknown,
		thinkingLevel: unknown,
	): Promise<PiSubAgentInstance> {
		const capabilities = this.createCapabilities(definition);
		const session = await createSession(this.options.sessionFactory, {
			definition,
			sessionPolicy,
			capabilities,
			cwd: this.options.cwd,
			agentDir: this.options.agentDir,
			model,
			thinkingLevel,
		});
		return new PiSubAgentInstance(definition, session);
	}

	private createCapabilities(definition: PiSubAgentDefinition): SubAgentCapabilities | undefined {
		if (!definition.accessSurfaces?.length) return undefined;
		const tools = definition.accessSurfaces.flatMap((accessSurface) => {
			assertSupportedAccessSurface(accessSurface);
			return this.options.createAccessSurfaceTools?.({ definition, accessSurface }) ?? [];
		});
		return tools.length > 0 ? { tools } : undefined;
	}

	private async invokeWithOptionalTimeout(
		instance: PiSubAgentInstance,
		input: RunSubAgentInput,
		startedAt = Date.now(),
	): Promise<SubAgentResult> {
		const task = { input: input.task, invocationId: input.invocationId };
		const messageCountBefore = instance.session.state.messages.length;
		if (!input.timeoutMs || input.timeoutMs <= 0) {
			return await instance.invoke(task);
		}
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<SubAgentResult>((resolve) => {
			timeout = setTimeout(() => {
				void instance.abort().finally(() => {
					resolve({
						agentId: instance.definition.id,
						sessionId: instance.session.sessionId,
						invocationId: input.invocationId,
						status: "aborted",
						finalText: "",
						errorMessage: `SubAgent invocation timed out after ${input.timeoutMs}ms`,
						startedAt,
						endedAt: Date.now(),
						messageCountBefore,
						messageCountAfter: instance.session.state.messages.length,
					});
				});
			}, input.timeoutMs);
		});
		try {
			return await Promise.race([instance.invoke(task), timeoutPromise]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	}
}

function assertSupportedAccessSurface(accessSurface: SubAgentAccessSurfaceDefinition): void {
	if (accessSurface.type !== "shared_state") {
		throw new Error(`Unsupported SubAgent access surface: ${(accessSurface as { type: string }).type}`);
	}
}

function sessionReuseKey(model: unknown, thinkingLevel: unknown): string {
	const modelKey =
		model && typeof model === "object"
			? `${String((model as { provider?: unknown }).provider ?? "")}/${String((model as { id?: unknown }).id ?? "")}`
			: String(model ?? "");
	return `${modelKey}:${String(thinkingLevel ?? "")}`;
}

async function createSession(
	factory: RunSubAgentSessionFactory,
	input: CreateSubAgentInstanceInput & {
		cwd: string;
		agentDir?: string;
		model?: unknown;
		thinkingLevel?: unknown;
	},
) {
	return await factory.create(input as never);
}

function failedResult(input: RunSubAgentInput, startedAt: number, errorMessage: string): SubAgentResult {
	return {
		agentId: input.agentId,
		sessionId: "",
		invocationId: input.invocationId,
		status: "failed",
		finalText: "",
		errorMessage,
		startedAt,
		endedAt: Date.now(),
		messageCountBefore: 0,
		messageCountAfter: 0,
	};
}
