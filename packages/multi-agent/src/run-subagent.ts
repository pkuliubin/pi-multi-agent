import { createDefinitionIdentity } from "./role-session-index.ts";
import type {
	CreateSubAgentInstanceInput,
	RunSubAgentInput,
	RunSubAgentRunnerOptions,
	RunSubAgentSessionFactory,
	SubAgentAccessSurfaceDefinition,
	SubAgentCapabilities,
	SubAgentRoleSessionBinding,
} from "./run-subagent-types.ts";
import { PiSubAgentInstance } from "./sub-agent.ts";
import type { PiSubAgentDefinition, SubAgentInspection, SubAgentResult } from "./types.ts";

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

	list(): PiSubAgentInstance[] {
		return [...this.instances.values()];
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
			if (this.pendingKeys.get(agentId) === key) return await pending;
			const instance = await pending;
			if (instance.phase === "running") return instance;
			return await this.replaceInstance(agentId, instance, key, create);
		}
		return await this.createAndStore(agentId, key, create);
	}

	async replaceInstance(
		agentId: string,
		instance: PiSubAgentInstance,
		key: string,
		create: () => Promise<PiSubAgentInstance>,
	): Promise<PiSubAgentInstance> {
		this.instances.delete(agentId);
		this.instanceKeys.delete(agentId);
		await instance.close();
		return await this.createAndStore(agentId, key, create);
	}

	private async createAndStore(
		agentId: string,
		key: string,
		create: () => Promise<PiSubAgentInstance>,
	): Promise<PiSubAgentInstance> {
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

	async close(agentId: string): Promise<void> {
		const instance = this.instances.get(agentId);
		this.instances.delete(agentId);
		this.instanceKeys.delete(agentId);
		if (instance) await instance.close();
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
	private readonly roleSessions = new Map<string, SubAgentRoleSessionBinding>();
	private activeRuns = 0;

	constructor(options: RunSubAgentRunnerOptions) {
		this.options = options;
	}

	async run(input: RunSubAgentInput): Promise<SubAgentResult> {
		const startedAt = Date.now();
		const definition = this.options.registry.get(input.agentId);
		if (!definition) {
			return failedResult(
				input,
				startedAt,
				`SubAgent definition not found: ${input.agentId}`,
				"SUB_AGENT_NOT_FOUND",
			);
		}
		if (definition.statePolicy === "persistent") {
			return failedResult(
				input,
				startedAt,
				"SubAgent statePolicy 'persistent' is not supported in this phase",
				"SUB_AGENT_UNSUPPORTED_STATE_POLICY",
			);
		}
		const sessionPolicy = input.statePolicyOverride ?? definition.statePolicy;
		const maxConcurrent = this.options.maxConcurrentSubAgents ?? DEFAULT_MAX_CONCURRENT_SUB_AGENTS;
		if (this.activeRuns >= maxConcurrent) {
			return failedResult(
				input,
				startedAt,
				`Too many active sub-agent runs: ${this.activeRuns}/${maxConcurrent}`,
				"SUB_AGENT_CONCURRENCY_LIMIT",
			);
		}

		this.activeRuns += 1;
		let ephemeralInstance: PiSubAgentInstance | undefined;
		let roleSession: SubAgentRoleSessionBinding | undefined;
		let instance: PiSubAgentInstance | undefined;
		let acquiredRun = false;
		try {
			const model = input.model ?? this.options.model;
			const thinkingLevel = input.thinkingLevel ?? this.options.thinkingLevel;
			roleSession = this.createRoleSessionBinding(definition, sessionPolicy);
			instance = await this.getInstance(definition, sessionPolicy, model, thinkingLevel, roleSession);
			this.rememberRoleSession(definition, roleSession);
			if (sessionPolicy === "ephemeral") ephemeralInstance = instance;
			if (instance.phase === "running") {
				return failedResult(input, startedAt, `SubAgent is already running: ${definition.id}`, "SUB_AGENT_BUSY");
			}
			this.markRunning(definition, roleSession, instance);
			acquiredRun = true;
			return await this.invokeWithOptionalTimeout(instance, input, startedAt);
		} catch (error) {
			return failedResult(
				input,
				startedAt,
				error instanceof Error ? error.message : String(error),
				"SUB_AGENT_ERROR",
			);
		} finally {
			this.activeRuns -= 1;
			if (acquiredRun && instance && instance.phase !== "closed" && roleSession) {
				this.markIdle(definition, roleSession, instance);
			}
			if (ephemeralInstance) {
				await ephemeralInstance.close();
			}
		}
	}

	inspect(agentId?: string): SubAgentInspection[] {
		const active = this.pool
			.list()
			.filter((instance) => agentId === undefined || instance.definition.id === agentId)
			.map((instance) => instance.inspect());
		const mainSessionId = this.options.mainSessionId;
		const persisted = this.options.lifecycleStore?.list?.(mainSessionId) ?? [];
		const activeKeys = new Set(active.map((inspection) => `${inspection.agentId}:${inspection.sessionId}`));
		return [
			...active,
			...persisted.filter((inspection) => !activeKeys.has(`${inspection.agentId}:${inspection.sessionId}`)),
		];
	}

	async close(agentId?: string): Promise<void> {
		if (!agentId) {
			for (const instance of this.pool.list()) {
				this.markClosed(instance.definition, this.roleSessions.get(instance.definition.id), instance);
			}
			await this.pool.closeAll();
			this.roleSessions.clear();
			return;
		}
		const instance = this.pool.get(agentId);
		if (instance) this.markClosed(instance.definition, this.roleSessions.get(agentId), instance);
		await this.pool.close(agentId);
		this.roleSessions.delete(agentId);
	}

	private async getInstance(
		definition: PiSubAgentDefinition,
		sessionPolicy: "ephemeral" | "session",
		model: unknown,
		thinkingLevel: unknown,
		roleSession: SubAgentRoleSessionBinding | undefined,
	): Promise<PiSubAgentInstance> {
		if (sessionPolicy === "session") {
			const key = sessionReuseKey(model, thinkingLevel, roleSession);
			return await this.pool.getOrCreate(definition.id, key, async () => {
				if (roleSession && this.options.lifecycleStore) {
					const session = await this.options.lifecycleStore.getOrCreate({
						definition,
						roleSession,
						create: () => this.createSession(definition, sessionPolicy, model, thinkingLevel, roleSession),
					});
					return new PiSubAgentInstance(definition, session);
				}
				return await this.createInstance(definition, sessionPolicy, model, thinkingLevel, roleSession);
			});
		}
		return await this.createInstance(definition, sessionPolicy, model, thinkingLevel, undefined);
	}

	private async createInstance(
		definition: PiSubAgentDefinition,
		sessionPolicy: "ephemeral" | "session",
		model: unknown,
		thinkingLevel: unknown,
		roleSession: SubAgentRoleSessionBinding | undefined,
	): Promise<PiSubAgentInstance> {
		const session = await this.createSession(definition, sessionPolicy, model, thinkingLevel, roleSession);
		return new PiSubAgentInstance(definition, session);
	}

	private async createSession(
		definition: PiSubAgentDefinition,
		sessionPolicy: "ephemeral" | "session",
		model: unknown,
		thinkingLevel: unknown,
		roleSession: SubAgentRoleSessionBinding | undefined,
	) {
		const capabilities = this.createCapabilities(definition);
		return await createSession(this.options.sessionFactory, {
			definition,
			sessionPolicy,
			capabilities,
			roleSession,
			cwd: this.options.cwd,
			agentDir: this.options.agentDir,
			model,
			thinkingLevel,
		});
	}

	private createCapabilities(definition: PiSubAgentDefinition): SubAgentCapabilities | undefined {
		if (!definition.accessSurfaces?.length) return undefined;
		const tools = definition.accessSurfaces.flatMap((accessSurface) => {
			assertSupportedAccessSurface(accessSurface);
			return this.options.createAccessSurfaceTools?.({ definition, accessSurface }) ?? [];
		});
		return tools.length > 0 ? { tools } : undefined;
	}

	private createRoleSessionBinding(
		definition: PiSubAgentDefinition,
		sessionPolicy: "ephemeral" | "session",
	): SubAgentRoleSessionBinding | undefined {
		if (sessionPolicy !== "session" || !this.options.mainSessionId) return undefined;
		return {
			mainSessionId: this.options.mainSessionId,
			definitionIdentity: createDefinitionIdentity(definition, this.options.definitionSource),
		};
	}

	private markRunning(
		definition: PiSubAgentDefinition,
		roleSession: SubAgentRoleSessionBinding | undefined,
		instance: PiSubAgentInstance,
	): void {
		if (roleSession)
			this.options.lifecycleStore?.markRunning?.({ definition, roleSession, session: instance.session });
	}

	private markIdle(
		definition: PiSubAgentDefinition,
		roleSession: SubAgentRoleSessionBinding | undefined,
		instance: PiSubAgentInstance,
	): void {
		if (roleSession) this.options.lifecycleStore?.markIdle?.({ definition, roleSession, session: instance.session });
	}

	private markClosed(
		definition: PiSubAgentDefinition,
		roleSession: SubAgentRoleSessionBinding | undefined,
		instance: PiSubAgentInstance,
	): void {
		if (roleSession)
			this.options.lifecycleStore?.markClosed?.({ definition, roleSession, session: instance.session });
	}

	private rememberRoleSession(
		definition: PiSubAgentDefinition,
		roleSession: SubAgentRoleSessionBinding | undefined,
	): void {
		if (roleSession) this.roleSessions.set(definition.id, roleSession);
		else this.roleSessions.delete(definition.id);
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

function sessionReuseKey(
	model: unknown,
	thinkingLevel: unknown,
	roleSession: SubAgentRoleSessionBinding | undefined,
): string {
	const modelKey =
		model && typeof model === "object"
			? `${String((model as { provider?: unknown }).provider ?? "")}/${String((model as { id?: unknown }).id ?? "")}`
			: String(model ?? "");
	const roleKey = roleSession
		? `${roleSession.mainSessionId}:${roleSession.definitionIdentity.source}:${roleSession.definitionIdentity.fingerprint}:${roleSession.definitionIdentity.sourcePath ?? ""}`
		: "";
	return `${roleKey}:${modelKey}:${String(thinkingLevel ?? "")}`;
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

function failedResult(
	input: RunSubAgentInput,
	startedAt: number,
	errorMessage: string,
	errorCode: string,
): SubAgentResult {
	return {
		agentId: input.agentId,
		sessionId: "",
		invocationId: input.invocationId,
		status: "failed",
		finalText: "",
		errorMessage,
		errorCode,
		startedAt,
		endedAt: Date.now(),
		messageCountBefore: 0,
		messageCountAfter: 0,
	};
}
