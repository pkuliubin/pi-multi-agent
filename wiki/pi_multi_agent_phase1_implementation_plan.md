# Pi Multi-Agent Phase 1 实施与测试计划

## 1. 目标

基于当前 pi-mono 架构，实现第一阶段 multi-agent 能力：

```text
PiSubAgent + Shared State AccessSurface + run_subagent tool
```

第一阶段只做 Direct / Shared State 型 SubAgent，不实现完整 Bus 和 Agent Team。

核心目标：

- 不修改 `packages/agent/src/agent.ts` 和 `packages/agent/src/agent-loop.ts`。
- 新建 `packages/multi-agent`，承载 SubAgent 抽象、Shared State、run_subagent 执行器。
- 通过 `AgentSessionLike / AgentSessionFactory` 兼容接入 `packages/coding-agent` 的现有 `AgentSession`。
- SubAgent 不隐式继承主 agent 的 tools / skills / MCP / access surfaces。
- SubAgent session 不走普通 CLI session 的默认资源自动发现路径；skills / MCP 只允许显式声明并由 factory 注入。
- 主 agent 默认只看到 `SubAgentResult`，SubAgent 内部事件保留在自己的 session / trace 中。

---

## 2. 当前代码接入点

### 2.1 现有 agent / session 层

当前关键结构：

```text
packages/agent/src/agent.ts
  Agent：单 agentic loop wrapper

packages/agent/src/agent-loop.ts
  runAgentLoop / runAgentLoopContinue：底层 loop

packages/coding-agent/src/core/agent-session.ts
  AgentSession：产品级 session wrapper，处理 tools、skills、extensions、retry、compaction、session persistence

packages/coding-agent/src/core/session-manager.ts
  SessionManager：jsonl / in-memory session 持久化和 buildSessionContext

packages/coding-agent/src/core/sdk.ts
  createAgentSession：创建 Agent + AgentSession
```

Phase 1 不改 `Agent` / `agent-loop`，只在其上层接入。

### 2.2 现有工具装配层

关键文件：

```text
packages/coding-agent/src/core/tools/index.ts
  createReadTool / createGrepTool / createAllTools 等内建工具

packages/coding-agent/src/core/tools/tool-definition-wrapper.ts
  ToolDefinition <-> AgentTool wrapper

packages/coding-agent/src/core/agent-session.ts
  baseToolsOverride / customTools / _buildRuntime / _toolRegistry
```

`run_subagent` 应作为 coding-agent 的可注册工具接入，但其 executor 来自 `packages/multi-agent`。

### 2.3 测试基础

可复用测试设施：

```text
packages/coding-agent/test/suite/harness.ts
  createHarness：基于 faux provider 创建 AgentSession 测试环境

packages/agent/test/agent.test.ts
packages/agent/test/agent-loop.test.ts
  Agent 和 agent-loop 单元测试模式
```

Phase 1 新增测试优先使用 faux provider，不使用真实模型或外部 API。

---

## 3. 阶段划分总览

```text
Phase 0：包骨架与类型边界
Phase 1：PiSubAgent core
Phase 2：coding-agent adapter 接入与兼容性验证
Phase 3：Shared State AccessSurface
Phase 4：run_subagent tool executor
Phase 5：集成测试与回归验证
Phase 6：文档、示例与后续预留接口
```

每个阶段都应有明确验收标准。

---

## Phase 0：包骨架与类型边界

### 目标

建立 `packages/multi-agent`，确保 workspace、tsconfig、exports、基础类型能被 root `tsgo` 和 `npm run check` 识别。

### 实现内容

新增：

```text
packages/multi-agent/package.json
packages/multi-agent/tsconfig.build.json
packages/multi-agent/src/index.ts
packages/multi-agent/src/types.ts
packages/multi-agent/test/
```

更新：

```text
package.json workspaces 已包含 packages/*，无需额外新增 workspace pattern
root tsconfig paths 新增 @earendil-works/pi-multi-agent
root build script 需加入 packages/multi-agent 的 build 顺序
```

建议包名：

```text
@earendil-works/pi-multi-agent
```

依赖方向：

```text
packages/multi-agent -> packages/agent
packages/multi-agent -> packages/ai
packages/coding-agent -> packages/multi-agent
```

禁止：

```text
packages/multi-agent -> packages/coding-agent
```

### 核心类型

第一批类型：

```ts
type SubAgentStatePolicy = "ephemeral" | "session" | "persistent";
type SubAgentPhase = "idle" | "listening" | "running" | "closed";

interface AgentSessionLike { ... }
interface AgentSessionFactory { ... }
interface PiSubAgentDefinition { ... }
interface SubAgentResult { ... }
```

说明：

- `persistent` 第一阶段只保留类型，不作为可靠能力实现。
- 如果第一阶段接收到 `persistent`，实现必须明确 reject 或降级到 `session`。

### 单元测试

新增：

```text
packages/multi-agent/test/types.test.ts
```

测试内容：

- package 可 import。
- `SubAgentRegistry` 空实现可初始化。
- `AgentSessionLike` mock 能满足 `PiSubAgentInstance` 构造。

### 验收方式

```text
npm --prefix packages/multi-agent run test
npm --prefix packages/multi-agent run build
npm run check
```

注意：代码变更后最终必须跑 root `npm run check`。

---

## Phase 1：PiSubAgent core

### 目标

实现不带 Shared State 的 Direct SubAgent。此时如果不配置 access surfaces，SubAgent 应退化成普通 AgentSession-like 执行单元。

### 实现内容

新增：

```text
packages/multi-agent/src/sub-agent.ts
packages/multi-agent/src/registry.ts
packages/multi-agent/src/session-like.ts
```

核心类：

```ts
class PiSubAgentInstance {
  readonly definition: PiSubAgentDefinition;
  readonly session: AgentSessionLike;
  phase: SubAgentPhase;

  prompt(...): Promise<void>;
  steer(...): Promise<void>;
  followUp(...): Promise<void>;
  abort(): Promise<void>;
  waitForIdle(): Promise<void>;
  subscribe(...): () => void;

  invoke(task: SubAgentTask): Promise<SubAgentResult>;
  inspect(): SubAgentInspection;
  close(): Promise<void>;
}
```

`AgentSessionLike` 建议包含 `dispose(): Promise<void> | void`，以便 `close()` 释放底层 session/runtime 资源，而不只是修改 phase。

语义边界：

- `abort()`：只停止当前 active run，实例仍可继续复用。
- `close()`：关闭实例并禁止后续再次 `invoke()`。
- `dispose()`：由 `close()` 调用，用于释放底层 session/runtime 资源；不等于删除 session 文件。

`invoke(task)` 行为：

```text
phase idle -> running
session.prompt(formatted task)
waitForIdle
extract final assistant text
phase running -> idle / closed
return SubAgentResult
```

`finalText` 提取规则：

```text
取本次 invocation 完成后新增的最后一条 assistant message 中的文本内容
若最终状态为 failed / aborted，则 finalText 为空，错误通过 status + errorMessage 表达
若 completed 但没有 assistant 文本输出，则 finalText 为空字符串
```

`prompt()` 语义必须保持：立即触发一次 agentic loop。

### SubAgentRegistry

```ts
class SubAgentRegistry {
  register(definition: PiSubAgentDefinition): void;
  get(id: string): PiSubAgentDefinition | undefined;
  list(): PiSubAgentDefinition[];
}
```

后续可扩展 active instance 管理，但 Phase 1 只需要 definition registry。

### 单元测试

新增：

```text
packages/multi-agent/test/sub-agent.test.ts
packages/multi-agent/test/registry.test.ts
```

使用 mock `AgentSessionLike`。

测试内容：

- `prompt()` 转发到 session。
- `invoke()` 调用 `session.prompt()` 并返回 final text。
- `invoke()` 期间 phase 为 `running`，结束后回到 `idle`。
- `abort()` 转发。
- `close()` 进入 `closed`，closed 后不允许再次 invoke。
- `SubAgentRegistry` 防止重复 id 或按设计覆盖，行为明确。

### 验收方式

```text
npm --prefix packages/multi-agent run test
npm --prefix packages/multi-agent run build
```

### 当前实现结果（已完成）

已落地内容：

```text
packages/multi-agent/package.json
packages/multi-agent/tsconfig.build.json
packages/multi-agent/src/index.ts
packages/multi-agent/src/types.ts
packages/multi-agent/src/session-like.ts
packages/multi-agent/src/sub-agent.ts
packages/multi-agent/src/registry.ts
packages/multi-agent/test/registry.test.ts
packages/multi-agent/test/sub-agent.test.ts
packages/multi-agent/test/test-utils.ts
```

实现要点：

- `packages/multi-agent` 已作为独立 workspace package 接入，包名为 `@earendil-works/pi-multi-agent`。
- `package.json` root build 顺序已调整为 `tui -> ai -> agent -> multi-agent -> coding-agent`。
- root `tsconfig.json` 已新增 `@earendil-works/pi-multi-agent` path mapping。
- `PiSubAgentInstance` 已实现 `prompt / steer / followUp / abort / waitForIdle / subscribe / invoke / inspect / close`。
- `persistent` state policy 在 instance 构造阶段明确 reject；registry 仍允许保存 definition。
- `SubAgentRegistry` 已实现 `register / get / list`，重复 id 会 reject，`list()` 返回拷贝。

当前行为验证：

- mock 单测覆盖 registry 注册、查询、重复 id、list 拷贝、persistent instance reject。
- mock 单测覆盖 `PiSubAgentInstance` phase 流转、prompt 转发、invoke finalText 提取、error/aborted 状态、并发拒绝、abort、close、subscribe、inspect。
- `invoke()` 只从本次新增 assistant messages 中提取最后一条 assistant 文本，并拼接 text blocks。
- `close()` 会调用 `session.dispose()`，closed 后 `prompt / invoke / followUp / steer` 都会 reject。

已执行验收：

```text
npm --prefix packages/multi-agent run test
# 2 files passed, 16 tests passed

npm --prefix packages/multi-agent run build
# passed during validation

npm run check
# passed
```

验证边界：

- 这些验证只能证明第一阶段 core 的 mock 单元行为和 monorepo typecheck 通过。
- 还不能证明它与真实 `packages/coding-agent` `AgentSession` 完全兼容。
- 真实 `prompt / followUp / waitForIdle / abort` 语义、session 复用、resource isolation，需要 Phase 2 adapter 接入后验证。
- Shared State、`run_subagent`、bus 均未在本阶段实现或验证。

---

## Phase 2：接入 coding-agent 并验证 PiSubAgent 兼容性

### 目标

先验证 `PiSubAgent` 能通过 adapter 包装现有 `AgentSession`，在不配置 access surfaces、不引入 `run_subagent` tool 的情况下，行为可作为当前 AgentSession 的兼容超集。
同时确认不形成依赖成环，并通过 sub-agent 专用资源装配策略，避免自动继承普通 CLI session 的项目级 context、skills、extensions 和 MCP。

### 实现内容

新增或修改：

```text
packages/coding-agent/src/core/multi-agent/agent-session-adapter.ts
packages/coding-agent/src/core/multi-agent/session-factory.ts
packages/coding-agent/src/core/multi-agent/resource-loader.ts（可选，也可并入 session-factory.ts）
packages/coding-agent/src/core/sdk.ts 或 AgentSession runtime 构建点
```

Adapter：

```ts
function adaptAgentSession(session: AgentSession): AgentSessionLike;
```

Factory：

```ts
class CodingAgentSessionFactory implements AgentSessionFactory {
  create(input: CreateSubAgentSessionInput): Promise<AgentSessionLike>;
}
```

Factory 内部复用现有能力：

```text
Agent
AgentSession
SessionManager
SettingsManager
ModelRegistry
ResourceLoader
baseToolsOverride / customTools
```

但必须按 SubAgentDefinition 创建受限能力集合。

### SubAgent 专用资源装配策略

Factory 不能直接复用普通 CLI session 的默认 `DefaultResourceLoader` 自动发现行为。Phase 2 应使用受限资源装配策略：

```text
默认关闭：
- context files 自动发现
- skills 自动扫描
- prompt templates 自动扫描
- themes 自动扫描
- extensions 自动加载

只允许：
- SubAgentDefinition 显式声明的 tools
- access surface 生成的 tools
- SubAgentDefinition 显式声明并由 factory 注入的 skills / MCP
- factory 显式设置的 system prompt / append prompt
```

这意味着：

- SubAgent 可以拥有 skills 和 MCP，但不能来自项目默认自动发现。
- `AgentSessionFactory.create()` 是资源支持性的最终校验点；若 definition 声明了当前阶段不支持的 skills / MCP 注入方式，应在这里返回结构化错误。
- SubAgent 的 system prompt 仅由 `initialState.systemPrompt` 与 factory 显式追加的 prompt 构成，不自动拼入项目级 context files。
- session 文件落盘位置由 `coding-agent` 内部策略决定，不在 `packages/multi-agent` 中固化路径协议。

### 兼容性验证范围

这一阶段不接入 Shared State，也不注册 `run_subagent`。重点验证：

```text
prompt / followUp / steer 会触发同等 agentic loop
sessionId / sessionFile / messages / state 语义一致
model / thinkingLevel / abort / waitForIdle / close / subscribe 行为一致
未配置 access surfaces 时，不注入额外 tools / resources
SubAgent 内部事件和 session 仍保持隔离
```

### Phase 2 支持矩阵

| 能力 | Phase 2 默认 | Phase 2 支持方式 |
|---|---|---|
| tools | 支持 | definition 显式声明 |
| access surfaces | 不启用 | 本阶段只验证无 access surfaces 的兼容性 |
| skills | 预留/可选 | 仅显式注入；未支持则 factory 报错 |
| MCP | 预留/可选 | 仅显式注入；未支持则 factory 报错 |
| project auto-discovery | 不支持 | 禁止 |

### 接入测试

新增：

```text
packages/coding-agent/test/multi-agent-adapter.test.ts
```

使用 `packages/coding-agent/test/suite/harness.ts` 或同等 faux provider harness。

测试内容：

- coding-agent 可以创建 SubAgent session。
- SubAgent 不继承主 agent tools。
- SubAgent 只拿 definition 声明的 tools。
- SubAgent 默认不自动加载项目级 context files / skills / extensions / MCP。
- skills / MCP 若被支持，必须来自 definition 显式声明与 factory 注入。
- 若 definition 声明了当前阶段未支持的 skills / MCP 注入方式，factory 返回明确错误。
- 不配置 access surfaces 时，PiSubAgent 行为等价于受限资源装配下的 AgentSession。
- SubAgent 内部 messages 不进入主 session。
- SubAgent session 独立保存或在 in-memory 模式独立存在。

### 验收方式

运行针对性测试：

```text
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-adapter.test.ts
```

最终仍需：

```text
npm run check
```

### Phase 2-1：CLI / TUI 主流程接入验证

目标：

在 Shared State 之前，先把当前 direct `PiSubAgent` 接入主流程，证明它能从普通 CLI / TUI session 中被主 agent 调用。此阶段仍然保持 Shared State、bus、agent-team 为空。

设计边界：

- 通过环境变量 `PI_MULTI_AGENT_DIRECT_SUBAGENT=1` 开启，默认不改变现有 CLI / TUI 行为。
- 注册一个临时 direct `run_subagent` custom tool 到主 session。
- sub-agent 由 `CodingAgentSessionFactory` 创建，继续使用 restricted resource loader。
- sub-agent 默认无 tools、无 Shared State、无自动 context files / skills / extensions。
- 主 session 只收到 `run_subagent` 的 tool result；sub-agent 内部 transcript 不写入主 session。
- 该 tool 是 Phase 4 正式 `run_subagent` executor 之前的主流程验证桥，不引入 worker registry、Shared State workspace、并发策略或超时策略。

实现内容：

```text
packages/coding-agent/src/core/multi-agent/direct-subagent-tool.ts
packages/coding-agent/src/main.ts
packages/coding-agent/src/core/sdk.ts
packages/coding-agent/test/multi-agent-direct-tool.test.ts
```

主流程接入点：

- `main.ts` 在 `buildSessionOptions()` 中检测 `PI_MULTI_AGENT_DIRECT_SUBAGENT`。
- 开启后追加 `createDirectRunSubAgentTool()` 到 `customTools`。
- `sdk.ts` 调整 `noTools: "all"` 语义：禁用 built-in tools，但保留显式传入的 `customTools`，这样可用 `--no-tools` / `noTools` 做最小工具面验证。

自动化验证：

```text
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-direct-tool.test.ts
```

测试覆盖：

- 真实 `AgentSession` 中 `run_subagent` 可以触发 direct sub-agent agentic loop。
- sub-agent 结果通过 tool result 回到主 agent。
- 主 session transcript 不包含 sub-agent 的 user prompt，只包含主 prompt、tool result 和主 agent 后续回答。
- CLI print mode 在 `PI_MULTI_AGENT_DIRECT_SUBAGENT=1` 下能加载该 tool 并完成一轮调用。

TUI 手动验证方式：

```bash
cd /Users/liubin/Projects/pi-multi-agent
PI_MULTI_AGENT_DIRECT_SUBAGENT=1 ./pi-test.sh --provider deepseek --model deepseek-v4-flash
```

进入 TUI 后输入：

```text
请使用 run_subagent 工具，让 sub-agent 回答：Say exactly: subagent-tui-ok。然后把 sub-agent 的结果原样告诉我。
```

期望现象：

- TUI 中出现 `run_subagent` 工具调用。
- 工具结果包含 `status: completed` 和 `subagent-tui-ok`。
- 主 agent 最终回复中包含 `subagent-tui-ok`。

如果模型没有主动调用工具，可把提示改得更强：

```text
必须调用 run_subagent，不要自己回答。task 参数填写：Say exactly: subagent-tui-ok。
```

### Phase 2 完成状态（已完成）

Phase 2 / Phase 2-1 已完成，可以作为 Shared State 前的兼容性基线。

已实现文件：

```text
packages/coding-agent/src/core/multi-agent/agent-session-adapter.ts
packages/coding-agent/src/core/multi-agent/session-factory.ts
packages/coding-agent/src/core/multi-agent/restricted-resource-loader.ts
packages/coding-agent/src/core/multi-agent/direct-subagent-tool.ts
packages/coding-agent/src/main.ts
packages/coding-agent/src/core/sdk.ts
packages/coding-agent/test/multi-agent-adapter.test.ts
packages/coding-agent/test/multi-agent-deepseek-smoke.test.ts
packages/coding-agent/test/multi-agent-direct-tool.test.ts
```

实现说明：

- `packages/multi-agent` 仍不依赖 `packages/coding-agent`，只暴露 `AgentSessionLike` / `AgentSessionFactory` 等接口。
- `adaptAgentSession()` 是薄 adapter，直接转发 `prompt / steer / followUp / abort / waitForIdle / subscribe / dispose`。
- `CodingAgentSessionFactory` 复用真实 `createAgentSession()`，但默认使用 in-memory session manager 和 restricted resource loader。
- restricted sub-agent 默认不加载 AGENTS/CLAUDE context files、skills、prompt templates、themes、extensions。
- Phase 2 不支持 definition metadata 声明 `tools / skills / mcp / accessSurfaces`，出现时 factory 明确抛错。
- Phase 2-1 提供 `PI_MULTI_AGENT_DIRECT_SUBAGENT=1` 临时开关，把 direct `run_subagent` 注册进 CLI/TUI 主流程。
- `run_subagent` 当前只创建 direct isolated sub-agent；无 Shared State、无 worker registry、无 bus、无并发策略、无 timeout policy。
- `sdk.ts` 调整了 `noTools: "all"` 语义：禁用 built-in tools，但保留显式 custom tools，保证 Phase 2-1 可在最小工具面下验证。

自动化验证方式与结果：

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-adapter.test.ts test/multi-agent-direct-tool.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       10 passed (10)
```

```bash
npm --prefix packages/multi-agent run test
```

结果：

```text
Test Files  2 passed (2)
Tests       16 passed (16)
```

```bash
npm run check
```

结果：

```text
passed
```

真实 provider smoke：

```bash
cd packages/coding-agent
PI_MULTI_AGENT_DEEPSEEK_SMOKE=1 DEEPSEEK_API_KEY=<real-key> \
  node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-deepseek-smoke.test.ts
```

结果：

```text
Test Files  1 passed (1)
Tests       1 passed (1)
```

TUI 手动验证结果：

- 使用 `PI_MULTI_AGENT_DIRECT_SUBAGENT=1` 启动 TUI。
- 提示主 agent 必须调用 `run_subagent`，task 为 `Say exactly: subagent-tui-ok`。
- TUI 中成功出现 `run_subagent` tool call。
- tool result 返回 `status: completed`、`agentId: direct-worker`、`messages: 0->2`、`subagent-tui-ok`。
- 主 agent 最终回复包含 `subagent-tui-ok`。

补充验证：

- 如果用户没有要求调用 `run_subagent`，主 agent 会直接回答。
- 这说明 Phase 2-1 只是把 sub-agent 作为普通 tool 接入主流程，不会强制改写默认 agentic loop。
- 后续若需要默认 worker 模式，应在 orchestration policy 层实现，而不是在 SubAgent core 层实现。

Phase 2 结论：

- `PiSubAgentInstance` 可以包装真实 `coding-agent AgentSession`。
- 在无 Shared State、无额外 access surface 时，sub-agent 能退化为一个受限资源装配下的普通 AgentSession。
- CLI/TUI 主流程可以调用 direct sub-agent。
- Phase 3 可以在此基础上开始实现 Shared State AccessSurface。

---

## Phase 3：Shared State AccessSurface

### 目标

实现 Shared State 作为第一个 access surface。它不进入 agent loop 内核，只生成可挂载给 SubAgent 的 tools。

本阶段已从早期的内存 KV 型 SharedMemory 收敛为 file-backed Shared State：

- 正文内容落盘到 shared state root。
- provenance / owner / version / permission 等治理信息保存在内存 manifest。
- `path` 第一段作为 `space`，例如 `prd/demo.md`、`analysis/findings.md`。
- 不预定义 PRD、decision log、analysis report 等业务类型，上层通过 prompt 和工具约定组织内容。
- Phase 3 只实现工具和 manifest，不把 Shared State 挂载到真实 `run_subagent`。

### 实现内容

新增：

```text
packages/multi-agent/src/shared-state/types.ts
packages/multi-agent/src/shared-state/memory-manifest.ts
packages/multi-agent/src/shared-state/index.ts

packages/coding-agent/src/core/multi-agent/shared-state-tools.ts
packages/coding-agent/examples/multi-agent/shared-state-smoke.ts
```

核心类型：

```ts
type SharedStatePermission = "list" | "read" | "grep" | "write" | "edit";

interface SharedStateArtifact { ... }
interface SharedStateManifest { ... }
interface SharedStateGrant { ... }
interface SharedStateAccessSurfaceDefinition { ... }
```

Manifest：

```text
MemorySharedStateManifest
```

Tools：

```text
shared_state.list
shared_state.read
shared_state.grep
shared_state.write
shared_state.edit
```

默认 root 约定：

```text
.pi/multi-agent/shared-state/<runId>/
```

Phase 3 API 支持显式传入 root；测试和 smoke 使用 temp/root 路径。默认 root 在后续 orchestration 接入时启用。

### 行为约束

- tool input 的 `path` 必须是相对路径。
- path 不能包含 escape：`..`、绝对路径、home path、Windows drive path 等。
- path 第一段是授权 `space`。
- agent 只能访问 grant 中允许的 spaces。
- `list/read/grep` 需要对应权限。
- `write` 创建新文件需要 `write` 权限。
- `write` 覆盖已有文件需要 `edit` 权限，并且当前 agent 是 owner，除非 grant 显式 `canOverwrite: true`。
- `edit` 需要 `edit` 权限，并且当前 agent 是 owner，除非 grant 显式 `canEditOthers: true`。
- 新文件默认 `ownerAgentId = currentAgentId`。
- 所有 write/edit 成功后更新 manifest version、updatedBy、updatedAt。
- `expectedVersion` 可选；传入时必须匹配 manifest 当前 version，否则 reject。
- `shared_state.edit` 使用现有 exact replacement 语义，不新增 patch DSL。
- `shared_state.grep` 第一版是文件级 grep，不做 semantic search / embedding。

### 单元测试

新增：

```text
packages/multi-agent/test/shared-state-manifest.test.ts
packages/coding-agent/test/multi-agent-shared-state-tools.test.ts
```

测试内容：

- manifest create 后 version 从 1 开始。
- manifest update 后 version 递增。
- owner / createdBy / updatedBy 正确记录。
- expectedVersion 匹配时成功，不匹配时失败。
- manifest list by space 正常工作。
- `shared_state.write` 能在授权 space 创建文件并写入 manifest。
- `shared_state.read` 能读取授权文件，支持 offset / limit。
- `shared_state.grep` 能搜索授权 space 内文件。
- `shared_state.edit` 能局部修改文件并递增 manifest version。
- `shared_state.list` 只列出授权 space 的内容。
- 未授权 space 访问失败。
- path escape 被拒绝：绝对路径、`../`、home path。
- 非 owner 默认不能 overwrite/edit 其他 agent artifact。
- `canOverwrite` / `canEditOthers` 开启后允许对应操作。
- expectedVersion mismatch 时 write/edit 失败。
- tool 名称只暴露 `shared_state.*`，不暴露原始 `read/write/edit/grep/ls`。

### Smoke 测试

新增：

```text
packages/coding-agent/examples/multi-agent/shared-state-smoke.ts
```

该脚本用于手动验证真实文件行为，会创建：

```text
/tmp/pi-shared-state-smoke/prd/demo.md
/tmp/pi-shared-state-smoke/analysis/findings.md
```

验证流程：

- owner-agent 创建 PRD 和 analysis 文件。
- assert `write` 后磁盘内容与 manifest version 正确。
- owner-agent 使用 `edit` 将 PRD 状态从 `draft` 改为 `reviewed`。
- assert `read` 返回目标内容，且不会包含尚未发生的后续编辑内容。
- assert `grep` 只在目标 space 内返回匹配内容。
- assert `list` 返回授权 artifacts 和版本信息。
- reader-agent 只有 `list/read/grep` 权限，可以读取但不能写入或编辑。
- 权限失败、path escape、version mismatch 后，assert 文件内容和 manifest version 均未被污染。
- editor-agent 在 `canEditOthers: true` 下可以编辑 owner artifact，并更新 `updatedBy`。
- 最终 assert PRD 文件、analysis 文件和 manifest 版本均符合预期。

### 验收方式

```bash
npm --prefix packages/multi-agent run test
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-shared-state-tools.test.ts
cd ../..
node --import ./node_modules/tsx/dist/loader.mjs packages/coding-agent/examples/multi-agent/shared-state-smoke.ts
npm run check
```

当前验证结果：

- `npm --prefix packages/multi-agent run test` 通过。
- `packages/coding-agent/test/multi-agent-shared-state-tools.test.ts` 通过。
- `packages/coding-agent/examples/multi-agent/shared-state-smoke.ts` 通过。
- `npm run check` 通过。

### 当前实现边界

- Phase 3 不接入 direct `run_subagent`；把 Shared State mount 到 sub-agent session 放到 Phase 4。
- Phase 3 不做 file manifest persistence；manifest 丢失后程序不会自动从文件恢复。
- Phase 3 不做 lock、merge、semantic search、bus、agent-team。
- `shared_state` 是对外概念名；文件 root 是实现细节。

---

## Phase 4：run_subagent tool executor

### 目标

实现 Orchestrator–Workers 的最小执行入口：主 agent 通过 `run_subagent` tool 调用 Direct SubAgent。

### 实现内容

已新增：

```text
packages/multi-agent/src/run-subagent.ts
packages/multi-agent/src/run-subagent-types.ts
packages/coding-agent/src/core/multi-agent/run-subagent-tool.ts
packages/coding-agent/test/multi-agent-run-subagent.test.ts
packages/coding-agent/test/multi-agent-shared-state-rounds.test.ts
packages/coding-agent/test/multi-agent-shared-state-rounds-smoke.test.ts
```

核心输入：

```ts
interface RunSubAgentInput {
  agentId: string;
  task: string;
  invocationId?: string;
  statePolicyOverride?: "ephemeral" | "session";
  timeoutMs?: number;
  model?: unknown;
  thinkingLevel?: unknown;
}
```

覆盖规则：

```text
statePolicyOverride 只允许在 ephemeral 与 session 之间覆盖 definition 默认值
不允许通过 override 提升到 persistent
若 definition 或调用路径请求 persistent，第一阶段必须 reject 或显式降级到 session
```

Runner 依赖：

```ts
interface RunSubAgentRunnerOptions {
  registry: SubAgentRegistry;
  sessionFactory: AgentSessionFactory;
  cwd: string;
  agentDir?: string;
  maxConcurrentSubAgents?: number;
  createAccessSurfaceTools?: (...args) => unknown[];
}
```

执行流程：

```text
resolve definition
resolve statePolicy
create/get PiSubAgentInstance
mount access surface tools
invoke(task)
extract SubAgentResult
return tool result
```

### 并发策略

Phase 4 只做轻量策略：

```text
session/persistent instance：同一时间只允许一个 active run
maxConcurrentSubAgents：单个 RunSubAgentRunner 实例内的并发上限
running 冲突：第一版直接返回 error；后续再做 queue
```


Phase 4 已补充的可靠性策略：

```text
session 首次并发创建：通过 pending instance map 去重，避免同 agent 分叉成两个 session。
模型一致性：run_subagent 每次执行使用当前 ctx.model / thinkingLevel；session worker 在模型配置变化后重建 session。
timeout trace：timeout result 使用调用开始时快照，避免 startedAt / messageCountBefore 失真。
事件监听：sub-agent adapter 捕获异步 listener rejection，记录错误但不把整个进程打崩。
```


### coding-agent 工具注册方式

`packages/multi-agent` 提供 `createRunSubAgentTool(...)` 或 ToolDefinition factory。

`packages/coding-agent` 负责：

```text
构造 registry
构造 sessionFactory
构造 sharedMemory store/access surface
把 run_subagent 注册到主 agent 可用工具集合
```

第一版可先不暴露给所有用户，放在内部或 behind flag：

```text
PI_MULTI_AGENT_RUN_SUBAGENT=1
PI_MULTI_AGENT_SHARED_STATE_ROOT=/tmp/pi-phase4-cli-state
```

`pi-test.sh` 已支持从 repo root `.env` 加载本地变量，可把 `DEEPSEEK_API_KEY`、`PI_MULTI_AGENT_RUN_SUBAGENT`、`PI_MULTI_AGENT_SHARED_STATE_ROOT` 放入 `.env`，避免每次手输。

### 单元测试与验证

新增/更新：

```text
packages/multi-agent/test/run-subagent.test.ts
packages/multi-agent/test/shared-state-manifest.test.ts
packages/coding-agent/test/multi-agent-run-subagent.test.ts
packages/coding-agent/test/multi-agent-adapter.test.ts
packages/coding-agent/test/multi-agent-shared-state-tools.test.ts
packages/coding-agent/test/multi-agent-shared-state-rounds.test.ts
packages/coding-agent/test/multi-agent-shared-state-rounds-smoke.test.ts
```

覆盖内容：

- 找不到 agentId 返回 error result。
- persistent definition 被拒绝。
- ephemeral 每次调用创建新 session。
- session policy 多次调用复用 instance/session。
- session 首次并发调用不会创建重复 session。
- session instance running 时第二次调用被拒绝。
- model / thinkingLevel 变化时 session worker 重建 session。
- timeout 触发 abort，trace 统计使用真实调用起点。
- Shared State capability tools 正确挂载到 sub-agent。
- OpenAI-compatible provider 下 dotted tool name 清洗并检测撞名。
- tool result 展示 startedAt / endedAt / durationMs。

已验证：

```text
npm --prefix packages/multi-agent run test
node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-shared-state-tools.test.ts test/multi-agent-adapter.test.ts test/multi-agent-run-subagent.test.ts
npm run check
```

---

### Phase 4 手动 CLI / TUI 验证结果

已用 DeepSeek 手动验证多轮 Shared State 协作：

```bash
PI_MULTI_AGENT_RUN_SUBAGENT=1 PI_MULTI_AGENT_SHARED_STATE_ROOT=/tmp/pi-phase4-cli-state ./pi-test.sh --provider deepseek --model deepseek-v4-flash -p '请使用 pm-agent 和 engineering-agent 做两轮协作...'
```

产物：

```text
/tmp/pi-phase4-cli-state/prd/pm.md
/tmp/pi-phase4-cli-state/analysis/engineering.md
/tmp/pi-phase4-cli-state/summary/final.md
```

TUI 中 `run_subagent` result 已显示：

```text
startedAt: 2026-05-28T02:25:44.107Z
endedAt: ...
durationMs: ...
```

同轮 `pm-agent` 与 `engineering-agent` 的 `startedAt` 相同，执行区间重叠，确认并行调用生效。

### Phase 4 可靠性补丁汇总

```text
1. async listener rejection 不再导致 uncaughtException。
2. session worker 首次并发创建去重。
3. run_subagent 使用每次调用的当前模型配置。
4. mutationLocks 正确清理。
5. shared_state.grep 单 space 失败不拖垮全部成功结果。
6. shared_state.grep limit 改为全局 limit。
7. timeout trace 使用真实调用起点。
8. manifest metadata 深拷贝。
9. OpenAI-compatible tool name 清洗检测撞名。
10. capability tool 校验 label / description。
```

当前边界：

```text
- 仍不是完整 CoordinationPolicy / scheduler；多轮顺序由主 agent prompt 驱动。
- Shared State manifest 仍是内存态，文件内容持久，manifest 不持久。
- Shared State logical path 与物理 root 需要在主 agent guidance / tool result 中继续明确，避免主 agent 误用 repo-relative read。
- persistent sub-agent 仍未实现。
```

---

## Phase 5：整体行为测试与最小调度约束收敛

### 目标

把 Phase 4 从“手动跑通”固化为“可自动回归、可证明、可复用”。本阶段不做完整 scheduler / CoordinationPolicy，不引入 Bus、persistent runtime 或 UI；重点验证主 agent 到 sub-agent 的真实 agentic loop、Shared State 读写、并发 trace 和隔离边界。

### 实现内容

新增/更新：

```text
packages/coding-agent/test/multi-agent-integration.test.ts
packages/coding-agent/test/multi-agent-shared-state-rounds.test.ts
packages/coding-agent/test/multi-agent-run-subagent.test.ts
packages/coding-agent/src/core/multi-agent/run-subagent-tool.ts
```

行为收敛：

```text
run_subagent result 增加 sharedStateRoot，和 startedAt / endedAt / durationMs 一起用于调试。
promptGuidelines 明确 prd/pm.md 等是 Shared State logical path，不是 repo cwd 相对路径。
logical path 仍是 sub-agent 协作协议；physical root 只用于主 agent 或人工调试读取真实文件。
```

### 测试矩阵

1. **主流程集成**
   - 主 agent 调用 `run_subagent`。
   - sub-agent 真实进入 agentic loop 并调用 `shared_state.write`。
   - 主 agent 收到 tool result 后继续回答。

2. **Shared State read/write**
   - sub-agent 写入 logical path。
   - manifest owner/version 正确。
   - physical root 下文件内容正确。

3. **多轮协作**
   - Round 1：`pm-agent` 与 `engineering-agent` 并行写入。
   - Round 2：双方互读互改。
   - Final：`synthesis-agent` 写 `summary/final.md`。
   - 三个 artifact 均存在、非空、version/owner 正确。

4. **并发 trace**
   - 两个不同 agent 同轮调用的 `startedAt/endedAt` 区间重叠。
   - 同一个 session agent 并发调用时只允许一个完成，另一个返回 already running。

5. **隔离边界**
   - sub-agent 内部 `shared_state.*` tool result 不进入主 session messages。
   - 主 session 只看到 `run_subagent` tool result。
   - sub-agent 不继承项目 `AGENTS.md` / `CLAUDE.md`、skills、prompts、themes、extensions 或主 agent 普通 tools。

### 自动回归命令

```text
npm --prefix packages/multi-agent run test
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-integration.test.ts test/multi-agent-shared-state-rounds.test.ts test/multi-agent-run-subagent.test.ts test/multi-agent-adapter.test.ts test/multi-agent-shared-state-tools.test.ts
npm run check
```

非 e2e 总体验证：

```text
./test.sh
```

注意：根据项目规则，不直接跑 full vitest suite；非 e2e 总体验证用 `./test.sh`。

### 人工 smoke

DeepSeek real smoke 是可选人工验收，不进入默认 CI。需要 `.env` 或环境变量中有 `DEEPSEEK_API_KEY`。

CLI print mode：

```bash
rm -rf /tmp/pi-phase5-cli-state
PI_MULTI_AGENT_RUN_SUBAGENT=1 PI_MULTI_AGENT_SHARED_STATE_ROOT=/tmp/pi-phase5-cli-state ./pi-test.sh --provider deepseek --model deepseek-v4-flash -p '请使用 pm-agent 和 engineering-agent 做两轮协作...'
```

TUI mode：同样用 DeepSeek，观察 `run_subagent` result 的 `startedAt / endedAt / durationMs / sharedStateRoot`，确认并行区间重叠且最终文件位于 `/tmp/pi-phase5-cli-state`。

当前边界：

```text
- 仍不是完整 CoordinationPolicy / scheduler；多轮顺序由主 agent prompt 驱动。
- 不实现 persistent sub-agent。
- 不持久化 manifest；Shared State 文件持久，manifest 仍是 runner 生命周期内的内存态。
```

---

## Phase 6：文档、示例与后续 roadmap 重排

### 目标

让后续开发者不仅理解如何定义 SubAgent、如何接入 Shared State、如何使用 `run_subagent`，还要明确后续阶段的正确优先级：先做 **persistent / resumable SubAgent 角色运行时**，再做 Shared State 团队协作语义，最后才考虑更通用的 orchestration / scheduler。

### 当前共识（作为后续 roadmap 基线）

```text
后续阶段的演进重点：
- persistent identity
- resumable session/context
- shared-state-based multi-round collaboration
- one logical role -> one session-style instance
- busy/conflict 由 runtime 暴露，由 main agent 协调
```

关键判断：

1. Shared State 多轮协作的真实产品形态，更接近 `Shared State + Agent Teams`，而不是固定 workflow scheduler。
2. `pm-agent`、`engineering-agent`、`ui-agent` 这类 SubAgent 是持续角色，不是一次性 worker。
3. persistent 的目标不是必须保持进程级常驻，而是保证 **persistent identity + resumable context**。
4. 上层 orchestration 可以是 workflow，也可以是主 agent 的 agentic loop；底层 SubAgent runtime 不应过早写死 queue / replace / inbox policy。

### 后续 phases 的建议顺序

```text
下一阶段（runtime-first）：
- session-style SubAgent 的持久化与恢复
- SubAgent identity / resume 语义
- busy/conflict 的结构化暴露
- 主 agent 如何在下一轮继续调度已存在的角色

再下一阶段（coordination semantics）：
- shared-state 多轮协作下的角色边界
- stop condition / no-progress detection
- 如何避免重复劳动
- 如何避免反应式循环
- 新角色加入时如何消费既有 shared state

更后面的阶段（activation / orchestration）：
- Bus / activation signal
- OrchestratorWorkersPolicy / BusPolicy / AgentTeamPolicy / SharedStatePolicy
```

### 下一阶段（Persistent / Resumable Runtime）的最小实现范围

建议把下一阶段收敛成一个很小但闭环的目标：先把角色恢复能力做稳定，不把 scheduler / queue / bus 一起带进来。

必须做：

```text
- session-style SubAgent 的 create-or-resume
- logical role identity 与 session 绑定规则
- 同一 role 单 active run 的正式 contract
- inspect / list-active / close / resume 的最小生命周期接口
```

建议一起做：

```text
- Shared State manifest persistence
```

如果本阶段不做 manifest persistence，必须在文档里明确：恢复保证只覆盖 SubAgent session/context，不保证 Shared State owner/version/provenance 完整恢复。

这一阶段明确不做：

```text
- queue / replace / inbox
- 固定 workflow scheduler / DAG engine
- bus-driven autonomous activation
- stop condition engine
- complex conflict resolution / semantic merge
```

### Phase 6 实现结果

Phase 6 已完成 Persistent / Resumable SubAgent Runtime 的最小闭环：session-style sub-agent 不再只是进程内 worker，而是可以绑定到主会话作用域内的 role session，并复用 Pi 现有 JSONL session 持久化能力。

已完成：

```text
- role session identity：mainSessionId + agentId + definitionIdentity
- 项目本地 role-session index：.pi/multi-agent/role-sessions.json
- session-style sub-agent create-or-resume；ephemeral agent 仍保持 in-memory
- 内部 inspect / close / lifecycle store 能力，不新增 LLM tool 或 CLI 命令
- 同一 role single-active-run：并发重复调用返回 SUB_AGENT_BUSY，不静默排队
- close(agentId) / close() 会把持久 role lifecycle 标记为 closed
- Shared State manifest 持久化：sharedStateRoot/.manifest.json
- 默认 sharedStateRoot 基于 main session id，而不是 process pid
- wildcard Shared State grant 支持 omitted-path list / grep
```

实现边界：

```text
- 主 agent session 只保存 run_subagent 摘要
- sub-agent 完整 transcript 保存在自己的 session file 中
- close runtime 只释放内存 instance，不删除 session file 或 index binding
- 不做 ask_user、GUI、多 runtime 交互、scheduler、Bus 或 queue/retry policy
- role-session index 与 shared-state manifest 使用 atomic rename 写入，避免半写 JSON；尚未实现跨进程 merge lock
```

验证结果：

```text
cd packages/multi-agent
node ../../node_modules/vitest/dist/cli.js --run test/role-session-index.test.ts test/file-shared-state-manifest.test.ts test/run-subagent.test.ts

cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-integration.test.ts test/multi-agent-shared-state-rounds.test.ts test/multi-agent-run-subagent.test.ts test/multi-agent-adapter.test.ts test/multi-agent-shared-state-tools.test.ts test/multi-agent-persistent-runtime.test.ts

npm run check
```

覆盖点：

```text
- 同一 session-style role 连续调用复用同一个 sub-agent sessionId，messages 递增
- 重建 runner 后仍通过 role-session index 恢复同一个 sub-agent session
- 不同 main session 下同名 agent 不共享 role session
- definition fingerprint 改变时不会误复用旧 session
- 同一 role 并发调用返回 SUB_AGENT_BUSY，且 busy 分支不会把持久状态误写为 idle
- close(agentId) / close() 会写入 closed lifecycle 状态
- ephemeral synthesis-agent 不进入 role-session index
- persistent manifest 能保存并恢复 owner/version/provenance
- wildcard grant 下 omitted-path shared_state.list / shared_state.grep 可正常使用
- sub-agent 持久化后仍不继承主 agent 普通 tools/resources
```

### 下一阶段的推荐验收标准

```text
- 同一 role 再次调用时能 resume，而不是创建全新 session
- 重启后仍能恢复 role 上下文
- 同一 role 不会并发跑两个 active run
- 不同 role 仍可并行
- main agent 能知道当前有哪些角色、谁在忙、谁可继续调度
```

### 运行时不变量

```text
- 对 session-style SubAgent，一个 logical role 只对应一个 session-style instance
- 同一个 session instance 在同一时刻只允许一个 active run
- 并发重复 invoke 同一个 agentId 时，runtime 返回 structured busy/conflict
- main agent 负责决定是否下一轮重试，而不是由底层静默排队
```

说明：这不是产品层“同一个 SubAgent 永远只能有一个任务意图”的强约束；它只是底层 transcript / phase / tool trace 一致性的保护。

### 实现内容

更新：

```text
wiki/pi_multi_agent_subagent_design.md
wiki/pi_multi_agent_phase1_implementation_plan.md
```

可新增示例：

```text
packages/coding-agent/examples/multi-agent/simple-orchestrator.ts
```

示例内容：

```text
orchestrator
  run_subagent(product-reviewer)
  run_subagent(engineering-reviewer)
  shared_state.read/write
```

Bus 预留接口但不实现：

```text
listen(subscription)
BusMessage
Subscription
SubAgentPhase.listening
```

### 验收方式

- 文档与实际导出 API 名称一致。
- 文档中的后续 roadmap 与当前实现边界不冲突。
- 示例能 typecheck（若示例被加入）。
- `npm run check` 通过。

---

## 4. 补充：第一阶段文件结构建议

```text
packages/multi-agent/
  package.json
  tsconfig.build.json
  src/
    index.ts
    types.ts
    session-like.ts
    sub-agent.ts
    registry.ts
    access-surface.ts
    shared-memory/
      types.ts
      memory-store.ts
      file-store.ts
      tools.ts
    run-subagent/
      types.ts
      runner.ts
      tool.ts
  test/
    registry.test.ts
    sub-agent.test.ts
    shared-memory-store.test.ts
    shared-memory-tools.test.ts
    run-subagent.test.ts

packages/coding-agent/src/core/multi-agent/
  agent-session-adapter.ts
  session-factory.ts
  resource-loader.ts
  tools.ts                    （Phase 4 注册 run_subagent 时新增）

packages/coding-agent/test/
  multi-agent-adapter.test.ts
  run-subagent-tool.test.ts   （Phase 4/5 注册 run_subagent 后新增）
  multi-agent-integration.test.ts
```

---

## 5. 补充：验收矩阵

| 阶段 | 目标 | 验收 |
|---|---|---|
| Phase 0 | 包骨架和类型边界 | `npm --prefix packages/multi-agent run build/test` |
| Phase 1 | PiSubAgent core | mock AgentSessionLike 单测通过 |
| Phase 2 | coding-agent adapter 兼容验证 | PiSubAgent 可包装现有 AgentSession，且无额外 access surfaces 时行为一致 |
| Phase 3 | Shared State access surface | file-backed workspace + manifest + tools/smoke 验证通过 |
| Phase 4 | run_subagent executor | runner 单测覆盖 success/error/timeout/concurrency |
| Phase 5 | 整体行为测试 | faux provider integration 通过 |
| Phase 6 | Persistent / Resumable SubAgent Runtime | role-session resume、persistent manifest、busy/close lifecycle、targeted tests 和 `npm run check` 通过 |
| Phase 7 | run_subagent 事件桥接式 observability | TUI 可见 progress snapshot，RPC/Web demo 链路可展示 agent card/detail，targeted tests 和 `npm run check` 通过 |

---

## 6. 补充：不做事项

第一阶段明确不做：

```text
修改 packages/agent/src/agent.ts
修改 packages/agent/src/agent-loop.ts
完整 CoordinationPolicy 框架（在 persistent/resume 与 shared-state team coordination 稳定后再做）
完整 Message Bus runtime（不是 Phase 6 下一步的第一优先级）
固定 workflow scheduler / DAG engine
LLM semantic routing
sibling direct invocation
复杂 shared memory merge/conflict resolution
真实 provider / 外部 API 测试
```

---

## 7. 补充：总体验收命令

代码变更后，根据项目规则：

```text
npm run check
```

如果新增或修改测试文件，先运行对应测试：

```text
npm --prefix packages/multi-agent run test
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/<specific>.test.ts
```

整体非 e2e 测试：

```text
./test.sh
```

不要直接运行 full vitest suite；`./test.sh` 会清理真实 API key 环境，避免误触 e2e / paid provider。

---

## Phase 5.1：文件化 Sub-Agent Definitions

### 目标

把 Phase 4/5 中代码内置的 demo sub-agents 升级为产品级资源：从 Pi 配置目录自动发现、解析并注册，格式采用 Claude-like Markdown + YAML frontmatter，但运行时继续使用 Pi 的隔离 session 与显式 access surface 权限模型。

### 实现内容

新增/更新：

```text
packages/coding-agent/src/core/multi-agent/sub-agent-definition-loader.ts
packages/coding-agent/src/core/package-manager.ts
packages/coding-agent/src/core/resource-loader.ts
packages/coding-agent/src/core/settings-manager.ts
packages/coding-agent/src/core/multi-agent/run-subagent-tool.ts
.pi/agents/pm-agent.md
.pi/agents/engineering-agent.md
.pi/agents/synthesis-agent.md
```

发现路径：

```text
project: .pi/agents/*.md
user:    ~/.pi/agent/agents/*.md
settings: agents 与 skills/prompts/extensions/themes 同级
```

文件格式：

```md
---
id: pm-agent
name: PM Agent
description: Product manager sub-agent
statePolicy: session
model: inherit
color: blue
sharedState:
  writableSpaces: [prd]
---
System prompt body here.
```

行为规则：

```text
id 优先；没有 id 时用 name；缺 id/name 产生 error diagnostic。
Markdown body 是 systemPrompt；空 body 产生 error diagnostic。
statePolicy 默认 session；第一版支持 ephemeral/session，不启用 persistent。
model: inherit 第一版只记录到 metadata，不改变当前 run_subagent 使用主 session 当前 model/thinkingLevel 的行为。
有文件化 agents 时，run_subagent 只注册文件化 agents；没有文件化 agents 时 fallback 到 createDemoSubAgentDefinitions()。
run_subagent promptGuidelines 根据实际 registry 生成可用 agent 列表，并保留 Shared State logical path guidance。
```

权限策略：

```text
推荐产品写法：sharedState.writableSpaces。
sharedState.writableSpaces 会自动授予所有 Shared State spaces 的 list/read/grep，并只对声明的 writable spaces 授予 write/edit。
高级写法：accessSurfaces + grants，适合更严格或非默认权限。
迁移兼容：tools 可写 shared_state.list/read/grep/write/edit。
Claude-like 高风险或未知 tools（Bash、WebSearch、WebFetch、Read/Grep/Glob、MCP tools 等）加载时 warning + skip。
普通文件工具不会自动映射为 repo 文件系统权限。
tools 映射出的 shared_state grant 使用 wildcard space，用于允许显式 logical path 下的 shared_state 调用。
```

### 测试与回归

新增/扩展：

```text
packages/coding-agent/test/multi-agent-definition-loader.test.ts
packages/coding-agent/test/multi-agent-integration.test.ts
```

覆盖内容：

- 解析合法 agent markdown，body 进入 `systemPrompt`。
- `id` 优先，`name` 可作为 id fallback。
- `accessSurfaces` 与 `tools: shared_state.*` 正确转换为 `PiSubAgentDefinition`。
- 高风险/未知 tools warning + skip，不阻断 agent 加载。
- invalid `statePolicy`、缺 id/name、空 body、非法 permissions 产生 diagnostics。
- `.pi/agents` 优先于 user agents；同 id collision 记录 diagnostics。
- file-based agent 可通过 `run_subagent` 进入真实 sub-agent agentic loop 并写 Shared State logical path。

回归命令：

```text
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-definition-loader.test.ts test/multi-agent-integration.test.ts test/multi-agent-shared-state-rounds.test.ts test/multi-agent-run-subagent.test.ts test/multi-agent-adapter.test.ts test/multi-agent-shared-state-tools.test.ts
npm --prefix packages/multi-agent run test
npm run check
```

### 边界

```text
第一版不自动扫描 ~/.claude/agents。
第一版不开放 Bash/Web/MCP delegation。
第一版不实现 filesystem Read/Grep/Glob grants。
第一版不实现完整 scheduler、persistent sub-agent、MCP delegation 或 Bus。
文件化 agents 是正式产品形态；demo definitions 只保留为无文件化 agents 时的 fallback 和测试便利。
```

### Phase 5.1 完成总结

当前 Phase 5.1 已收口，结论是：**文件化 Sub-Agent Definitions 已成为正式产品形态，demo definitions 仅作为 fallback**。

已完成能力：

```text
- `.pi/agents/*.md` project agents 自动发现。
- `~/.pi/agent/agents/*.md` user agents 自动发现。
- `settings.agents` 与 skills/prompts/extensions/themes 同级接入。
- `DefaultResourceLoader.getSubAgents()` 暴露 loaded definitions 与 diagnostics。
- TUI startup 展示 `[Agents]` 与 `[Agent issues]`。
- `run_subagent` 优先使用文件化 agents；无文件化 agents 时 fallback demo agents。
- `run_subagent` result 保留 sharedStateRoot / startedAt / endedAt / durationMs trace。
```

已验证：

```text
- npm --prefix packages/multi-agent run test
- cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-definition-loader.test.ts test/multi-agent-integration.test.ts test/multi-agent-shared-state-rounds.test.ts test/multi-agent-run-subagent.test.ts test/multi-agent-adapter.test.ts test/multi-agent-shared-state-tools.test.ts
- npm run check
- DeepSeek print-mode smoke
- DeepSeek TUI smoke
- TUI 文件化 agent 发现 smoke
- TUI demo fallback smoke
- TUI unsupported tools warning smoke
```

人工 smoke 结果：

```text
文件化 agents 被 TUI startup 识别：engineering-agent, pm-agent, synthesis-agent。
多轮 pm/engineering/synthesis 协作可写出：
  /tmp/pi-phase51-*/prd/pm.md
  /tmp/pi-phase51-*/analysis/engineering.md
  /tmp/pi-phase51-*/summary/final.md
unsupported tools 会 warning + skip，不阻断 agent 加载。
移除 .pi/agents 后，不展示 [Agents] resource section，但 run_subagent 仍可 fallback 到 demo definitions。
```

当前产品边界：

```text
Sub-agent 仍是后台受限 worker，不是直接面向用户的对话 runtime。
Sub-agent 可以在 finalText 中请求澄清，但 TUI 不会把用户输入直接路由给该 sub-agent。
如需继续交互，只能由主 agent 转述，再次调用同一个 session-style sub-agent。
未来理想形态应是 GUI 中的多 Agent Runtime Session，而不是在 TUI 内强行支持多 runtime 交互。
```

---

## Phase 5.2：Sub-Agent Runtime Contract 与可观测性收敛

### 目标

Phase 5.2 不做 GUI、多 runtime 交互、scheduler、Bus 或 persistent runtime。目标是把 Phase 5.1 暴露出的运行时语义进一步收紧：让 `run_subagent` 的状态、busy/conflict、fallback、可用 agent 列表和测试 smoke 都更可证明、更不依赖人工观察。

### 建议实现范围

必须做：

```text
- 明确 documented contract：Phase 5.x sub-agent 是后台 worker，不支持直接用户交互。
- `run_subagent` 增强可观测信息：result 中标明 definitionSource（file/demo）或 registry source summary。
- fallback 行为测试化：有文件化 agents 时不混入 demo；无文件化 agents 时 fallback demo。
- unsupported tools warning 行为测试化：warning + skip，agent 仍加载。
- TUI `[Agents]` 只展示 resource-loaded agents；demo fallback 不伪装成文件资源。
- busy/conflict 文案与 status 进一步稳定，避免同 agent 并发失败看起来像普通模型失败。
```

建议做：

```text
- 增加一个轻量 `pi agents list` 或内部 list helper 的设计稿/最小实现，用于非 TUI 环境确认当前加载的 agents。
- 把 DeepSeek smoke 改成可选脚本或文档化命令，避免每次靠手工 prompt 复制。
- 文档补充：如何从 Claude Code agent 迁移到 Pi agent，哪些 tools 会被跳过。
```

明确不做：

```text
- 不让 sub-agent 直接向用户提问或抢占输入流。
- 不做 TUI runtime tabs。
- 不做 GUI。
- 不做 persistent/resumable runtime。
- 不做 queue / replace / inbox / scheduler。
- 不开放 Bash/Web/MCP/普通文件工具 delegation。
```

### 验收标准

```text
- 自动测试能证明文件化 agent、fallback、warning、隔离和 shared_state 写读行为。
- 用户从 TUI startup 能清楚知道文件化 agents 是否被加载。
- 用户从 run_subagent result 能判断当前调用来自 file agent 还是 demo fallback。
- 当 sub-agent 请求澄清时，文档明确说明这是普通 finalText，不是 first-class user-input routing。
- npm run check 通过。
```

### Phase 5.2 与后续 Phase 6 的边界

Phase 5.2 是运行时 contract / observability cleanup；Phase 6 才适合进入更大的 runtime-first 方向：persistent identity、resumable session/context、role lifecycle 和未来 GUI 多 runtime session。

### Phase 5.2 实现结果

Phase 5.2 已完成最小运行时 contract 与可观测性收敛。本阶段没有引入 scheduler、GUI、多 runtime 交互或 persistent runtime，只把现有 file/demo/custom registry 选择与失败状态变得可测试、可解释。

新增/更新：

```text
packages/coding-agent/src/core/multi-agent/definition-source.ts
packages/coding-agent/src/core/multi-agent/run-subagent-tool.ts
packages/multi-agent/src/run-subagent.ts
packages/multi-agent/src/types.ts
packages/coding-agent/test/multi-agent-definition-source.test.ts
packages/coding-agent/test/multi-agent-integration.test.ts
packages/coding-agent/test/multi-agent-run-subagent.test.ts
packages/multi-agent/test/run-subagent.test.ts
```

运行时可观测性：

```text
run_subagent result text 新增 definitionSource: file | demo | custom。
run_subagent details 新增 definitionSource。
run_subagent details 继续包含 sharedStateRoot。
failed SubAgentResult 新增 errorCode。
```

当前 errorCode：

```text
SUB_AGENT_NOT_FOUND
SUB_AGENT_UNSUPPORTED_STATE_POLICY
SUB_AGENT_CONCURRENCY_LIMIT
SUB_AGENT_BUSY
SUB_AGENT_ERROR
```

registry source 规则已测试化：

```text
loaded file definitions 非空：definitionSource=file，只注册文件化 agents，不混入 demo。
loaded file definitions 为空：definitionSource=demo，fallback createDemoSubAgentDefinitions()。
手动传入 custom definitions：definitionSource=custom。
```

### Phase 5.2 验证结果

已通过：

```text
cd packages/coding-agent && node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-definition-source.test.ts test/multi-agent-definition-loader.test.ts test/multi-agent-integration.test.ts test/multi-agent-run-subagent.test.ts
npm --prefix packages/multi-agent run test
npm run check
```

覆盖点：

```text
- file definitions 不混 demo definitions。
- 无 file definitions 时 fallback demo definitions。
- file agent 调用结果显示 definitionSource: file。
- custom definitions 调用结果显示 definitionSource: custom。
- run_subagent details 暴露 definitionSource。
- same session agent 并发失败返回 SUB_AGENT_BUSY。
- maxConcurrentSubAgents 触发 SUB_AGENT_CONCURRENCY_LIMIT。
- missing agent 返回 SUB_AGENT_NOT_FOUND。
- persistent statePolicy 返回 SUB_AGENT_UNSUPPORTED_STATE_POLICY。
```

仍不做：

```text
- sub-agent 直接用户交互。
- TUI runtime tabs。
- GUI runtime session switching。
- persistent/resumable runtime。
- scheduler / queue / bus。
- Bash/Web/MCP/普通文件工具 delegation。
```

## Phase 7：run_subagent 事件桥接式 Observability

Phase 7 已完成第一版事件桥接式 observability。目标不是新增 Bus、scheduler 或 sub-agent direct chat，而是把 sub-agent 内部高价值事件投影到现有 `run_subagent` tool streaming update，让 TUI / RPC / Web demo 复用已有展示通道。

已完成：

```text
- RunSubAgentRunner.run(input, { onEvent }) 支持每次调用级 observer
- sub-agent session events 被包装为 SubAgentEventEnvelope
- observer sync throw / async reject 都不会影响 runner final result
- invoke 完成、失败、timeout 后会 unsubscribe
- run_subagent tool 把事件归约为 progress snapshot
- progress 包含 currentPhase / activeTool / completedTools / lastAssistantPreview / eventCount / recentEvents
- recentEvents 使用 rolling window，默认保留最近 8 条高价值事件
- tool start/end 展示 argsSummary / resultSummary，并保留受控 args/result 投影供 UI 展开
- final result 保留 result/sharedStateRoot/definitionSource，并附带 progress
```

TUI 验收：

```text
- TUI multi-subagent workflow 已验证正常使用
- run_subagent tool block 能显示 startedAt / endedAt / durationMs / messages / sharedStateRoot
- progress update 能显示 phase、activeTool、tool_execution_start/end、assistant preview
- pm-agent / engineering-agent / synthesis-agent 可完成 shared-state 多轮协作并产出最终 artifact
```

Web demo 现状：

```text
sub-agent event
  -> run_subagent progress
  -> main tool_execution_update
  -> web-backend reduceRunSubagentProgress()
  -> SSE agent.updated
  -> web-ui agent card / detail panel
```

`packages/web-backend` 与 `packages/web-ui` 已能展示 agent card、active tool、completed tools、assistant preview 和工具 args/result detail。该 Web 链路是演示/桥接层，不是未来正式 GUI 的必选架构；如果未来做桌面 app 或替代 TUI 的 GUI，可以直接接 Pi runtime / session / role-session API。

已知非阻塞打磨项：

```text
- Web backend 当前从 rolling recentEvents 生成 agent history；长任务下后续可给 CompactSubAgentEvent 增加稳定 id。
- progress snapshot 是完整快照，不是增量流；长任务下需要关注单个 args/result/fullText 投影大小。
- activeTool 当前只表达一个工具；当前 sub-agent 串行 tool loop 下可接受。
- run_subagent_completed 触发 shared_state.changed paths: [] 全量刷新，简单可靠但不够精确。
```

当前结论：

```text
Phase 7 主链路已跑通并通过 TUI 人工验收。后续不建议重做 event system；若继续投入，优先做稳定 event id、投影大小上限，以及面向正式 GUI 的 runtime/session API 设计。
```
