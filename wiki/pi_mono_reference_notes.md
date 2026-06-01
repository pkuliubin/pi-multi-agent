# Pi 核心数据结构与数据流

这份文档只整理核心结构和主链路，不覆盖每个 provider / tool 的细节。目标是回答：Pi 内部如何表示 message、model/provider、tool、skill、sub-agent、session，以及 agent loop 的事件如何流到 TUI。

## 1. 分层视图

```text
packages/coding-agent  CLI / TUI / session / extensions / coding tools
        |
        v
packages/agent         stateful Agent + agent loop + tool execution + session harness
        |
        v
packages/ai            LLM provider abstraction + canonical message/tool schema
        |
        v
provider SDK/API       OpenAI, Anthropic, Google, Bedrock, Mistral, OpenAI-compatible...
```

核心原则：

- `packages/ai` 定义 provider 无关的 canonical message / model / stream schema。
- `packages/agent` 持有运行时状态，执行 agent loop 和 tools，并 emit `AgentEvent`。
- `packages/coding-agent` 把事件持久化到 session、转给 extensions，并让 interactive / print / rpc mode 消费。
- TUI 不直接理解 provider；它主要消费 `AgentSessionEvent`。

## 2. Message schema

主要定义在 `packages/ai/src/types.ts`。

### Content block

```ts
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}

interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string;
}
```

`ToolCall` 是 Pi 内部的 tool-use 表示。它不是 Anthropic 原生的 `tool_use` 字段名，也不是 OpenAI 原生的 `tool_calls`，provider 层会再做转换。

### Message

```ts
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseModel?: string;
  responseId?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: "stop" | "length" | "toolUse" | "error" | "aborted";
  errorMessage?: string;
  timestamp: number;
}

interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}

type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

关系：

- assistant 产生 tool call：`AssistantMessage.content[]` 里出现 `{ type: "toolCall" }`。
- provider 停止原因是 `stopReason: "toolUse"`。
- agent 执行工具后，生成独立的 `ToolResultMessage`。
- `ToolResultMessage.toolCallId` 对应前面 `ToolCall.id`。

## 3. LLM provider / model schema

定义在 `packages/ai/src/types.ts` 和 `packages/ai/src/api-registry.ts`。

```ts
type Api = KnownApi | string;
type Provider = KnownProvider | string;

interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  baseUrl: string;
  reasoning: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ...;
}
```

`provider` 是产品/服务名，如 `openai`、`anthropic`、`deepseek`。`api` 是 Pi 内部选择 provider adapter 的协议名，如：

- `openai-responses`
- `openai-completions`
- `anthropic-messages`
- `google-generative-ai`
- `bedrock-converse-stream`

调用入口：

```ts
streamSimple(model, context, options)
  -> getApiProvider(model.api)
  -> provider.streamSimple(...)
```

也就是说，同一个 `provider` 可以复用现成 `api` adapter。例如 DeepSeek 当前是 `provider: "deepseek"`，但 `api: "openai-completions"`，通过 OpenAI-compatible adapter + `compat` 差异处理。

## 4. LLM stream event schema

provider 不直接返回完整 message，而是返回 `AssistantMessageEventStream`。

```ts
type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start" | "text_delta" | "text_end"; ... }
  | { type: "thinking_start" | "thinking_delta" | "thinking_end"; ... }
  | { type: "toolcall_start" | "toolcall_delta" | "toolcall_end"; ... }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
```

agent loop 会把这些低层流事件转换成更上层的 `AgentEvent.message_start / message_update / message_end`。

## 5. Tool schema

### LLM-visible tool

定义在 `packages/ai/src/types.ts`：

```ts
interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}
```

这个结构会被 provider adapter 转成各家 tool schema。

### Runtime tool

定义在 `packages/agent/src/types.ts`：

```ts
interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any>
  extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
}

interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];
  details: T;
  terminate?: boolean;
}
```

### Coding-agent tool definition

`packages/coding-agent/src/core/extensions/types.ts` 再包一层 `ToolDefinition`，用于 UI 渲染、prompt snippet、extension context：

```ts
interface ToolDefinition<TParams extends TSchema, TDetails, TState> {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: TParams;
  renderShell?: "default" | "self";
  prepareArguments?: ...;
  executionMode?: ToolExecutionMode;
  execute(..., ctx: ExtensionContext): Promise<AgentToolResult<TDetails>>;
  renderCall?: ...;
  renderResult?: ...;
}
```

`packages/coding-agent/src/core/tools/tool-definition-wrapper.ts` 负责把 `ToolDefinition` 包成 `AgentTool`。

内置 coding tools 主要在 `packages/coding-agent/src/core/tools/`：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`。

## 6. Agent runtime state

定义在 `packages/agent/src/types.ts`：

```ts
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}

type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

`Agent` 类在 `packages/agent/src/agent.ts` 持有这份状态，并提供：

- `prompt(...)`：从用户输入启动一次 run。
- `continue()`：从当前 transcript 继续。
- `steer(...)`：当前 turn 结束后插入 steering message。
- `followUp(...)`：agent 本来要停时插入 follow-up message。
- `subscribe(...)`：监听 `AgentEvent`。

## 7. Agent loop 数据流

核心在 `packages/agent/src/agent-loop.ts`。

简化流程：

```text
UserMessage
  -> Agent.prompt()
  -> runAgentLoop()
  -> emit message_start/message_end for user
  -> convertToLlm(AgentMessage[] -> Message[])
  -> streamSimple(model, Context)
  -> provider emits AssistantMessageEvent
  -> agent loop emits message_start/message_update/message_end
  -> if assistant has ToolCall[]:
       validate args
       emit tool_execution_start
       tool.execute(...)
       emit tool_execution_update? / tool_execution_end
       create ToolResultMessage
       emit message_start/message_end for toolResult
       continue next LLM turn
  -> emit turn_end
  -> maybe steering/followUp/next turn
  -> emit agent_end
```

关键事件定义在 `packages/agent/src/types.ts`：

```ts
type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

注意：`message_update` 只用于 assistant streaming；user / toolResult 通常只有 start/end。

## 8. Session state / 持久化 schema

`packages/coding-agent` 使用自己的 JSONL session manager，核心定义在 `packages/coding-agent/src/core/session-manager.ts`。

文件头：

```ts
interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}
```

entry：

```ts
type SessionEntry =
  | { type: "message"; message: AgentMessage; ... }
  | { type: "thinking_level_change"; thinkingLevel: string; ... }
  | { type: "model_change"; provider: string; modelId: string; ... }
  | { type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number; ... }
  | { type: "branch_summary"; fromId: string; summary: string; ... }
  | { type: "custom"; customType: string; data?: unknown; ... }
  | { type: "custom_message"; customType: string; content: ...; display: boolean; ... }
  | { type: "label"; targetId: string; label?: string; ... }
  | { type: "session_info"; name?: string; ... };
```

这些 entry 形成树：每条 entry 都有 `id` 和 `parentId`。fork / branch 不是复制整段 transcript，而是在树上选不同 path。

恢复上下文时会构建：

```ts
interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}
```

compaction 会影响恢复出的 `messages`：旧上下文被 summary message 替代，只保留 `firstKeptEntryId` 之后的消息。

## 9. AgentSession：事件中转、持久化、extensions

`packages/coding-agent/src/core/agent-session.ts` 是 coding-agent 的核心封装。

它做几件事：

- 持有 `Agent`、`SessionManager`、`SettingsManager`、`ResourceLoader`。
- 订阅底层 `AgentEvent`。
- 先转给 extension runner。
- 再转给 mode listeners，即 interactive / print / rpc。
- 在 `message_end` 时持久化 message 到 session。
- 管理 model / thinking level / tools / system prompt / compaction / retry。

事件类型 `AgentSessionEvent` 基本继承 `AgentEvent`，并扩展：

- `queue_update`
- `compaction_start`
- `compaction_end`
- `session_info_changed`
- `thinking_level_changed`
- `auto_retry_start`
- `auto_retry_end`

## 10. TUI 如何收到 agent loop 消息

interactive mode 在 `packages/coding-agent/src/modes/interactive/interactive-mode.ts` 中订阅：

```ts
this.unsubscribe = this.session.subscribe(async (event) => {
  await this.handleEvent(event);
});
```

事件到 UI 的映射大致是：

- `agent_start`：清空 pending tools，显示 working loader。
- `message_start:user`：加入 user message component。
- `message_start:assistant`：创建 `AssistantMessageComponent` 作为 streaming component。
- `message_update:assistant`：更新 streaming component；如果内容里有 `toolCall`，创建/更新 `ToolExecutionComponent`。
- `message_end:assistant`：收尾 streaming component；tool call 参数标记 complete。
- `tool_execution_start`：对应 tool component 标记开始执行。
- `tool_execution_update`：更新部分结果。
- `tool_execution_end`：更新最终结果并移出 pending map。
- `agent_end`：停止 loader，清空 pending 状态。

所以链路是：

```text
provider stream event
  -> agent-loop AssistantMessageEvent handling
  -> AgentEvent
  -> Agent.processEvents updates AgentState
  -> AgentSession._handleAgentEvent
  -> extension events + session listeners + session persistence
  -> InteractiveMode.handleEvent
  -> TUI components update
```

RPC mode 类似，但不是渲染组件，而是把 event 序列化写给 RPC client。

## 11. Skills

coding-agent 的 skill 类型在 `packages/coding-agent/src/core/skills.ts`：

```ts
interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  sourceInfo: SourceInfo;
  disableModelInvocation: boolean;
}
```

加载规则：

- skill 文件可以是 `SKILL.md`，也可以是特定目录下的根级 `.md`。
- frontmatter 里读取 `name`、`description`、`disable-model-invocation`。
- `description` 缺失则不加载。
- `name` 默认用父目录名。

给模型的不是完整 skill 内容，而是 system prompt 中的索引：

```xml
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

模型需要使用 skill 时，再通过 read tool 读取 `location`。显式 `/skill:name` 调用会把完整 skill block 作为用户消息注入。

## 12. MCP

当前 coding-agent core 没有内置 MCP runtime。README / docs 也明确把 MCP 放在 extension/package 层。

当前可见实现边界：

- `packages/coding-agent` 没有原生 MCP server/client 数据结构作为核心 schema。
- 可以通过 extension 注册 MCP adapter 暴露出来的 tools。
- 一旦进入 Pi agent loop，MCP tool 和普通 tool 一样，都需要落到 `ToolDefinition -> AgentTool -> ToolCall/ToolResultMessage` 这条 canonical tool 链路。
- sub-agent factory 当前也明确拒绝 definition metadata 中的 `mcp` 字段。

所以文档化时建议把 MCP 视为“外部 tool source / extension capability”，不是当前 core schema 的一等对象。

## 13. Sub-agent / multi-agent

multi-agent 类型在 `packages/multi-agent/src/`，coding-agent 的接入在 `packages/coding-agent/src/core/multi-agent/`。

### Definition

```ts
interface PiSubAgentDefinition {
  id: string;
  name?: string;
  description?: string;
  statePolicy: "ephemeral" | "session" | "persistent";
  systemPrompt?: string;
  accessSurfaces?: SubAgentAccessSurfaceDefinition[];
  metadata?: Record<string, unknown>;
}
```

coding-agent 从 agent definition markdown frontmatter 解析：

- `id` / `name`
- `description`
- `statePolicy`，默认 `session`
- `model`、`color` 进入 metadata
- `accessSurfaces` / `grants` / `tools: shared_state.*` 转成 Shared State grant
- body 是 sub-agent 的 `systemPrompt`

### Session-like adapter

```ts
interface AgentSessionLike {
  readonly state: AgentState;
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly model?: Model<Api>;
  readonly thinkingLevel: ThinkingLevel;
  prompt(text: string, options?: AgentSessionPromptOptions): Promise<void>;
  steer(...): Promise<void>;
  followUp(...): Promise<void>;
  abort(): Promise<void> | void;
  waitForIdle(): Promise<void>;
  subscribe(listener: AgentSessionLikeEventListener): () => void;
  dispose(): Promise<void> | void;
}
```

`PiSubAgentInstance` 不依赖 coding-agent 的完整类，只依赖这个 session-like 接口。

### run_subagent tool

`run_subagent` 是一个普通 tool definition，参数：

```ts
{
  agentId: string;
  task: string;
  invocationId?: string;
  statePolicyOverride?: "ephemeral" | "session";
  timeoutMs?: number;
}
```

返回：

```ts
interface SubAgentResult {
  agentId: string;
  sessionId: string;
  invocationId?: string;
  status: "completed" | "failed" | "aborted";
  finalText: string;
  errorMessage?: string;
  errorCode?: string;
  startedAt: number;
  endedAt: number;
  messageCountBefore: number;
  messageCountAfter: number;
}
```

sub-agent 的事件会被包成：

```ts
interface SubAgentEventEnvelope {
  source: "subagent";
  agentId: string;
  sessionId: string;
  invocationId?: string;
  event: AgentSessionLikeEvent;
}
```

`run_subagent` tool 会把这些 event 压缩成 progress summary，通过 `tool_execution_update` 反馈给主 agent/TUI。

### Shared State

Shared State 是当前 sub-agent 之间共享 artifact 的 access surface：

```ts
type SharedStatePermission = "list" | "read" | "grep" | "write" | "edit";

interface SharedStateGrant {
  space: string;
  permissions: SharedStatePermission[];
  canOverwrite?: boolean;
  canEditOthers?: boolean;
}

interface SharedStateArtifact {
  path: string;
  space: string;
  ownerAgentId: string;
  createdBy: string;
  updatedBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}
```

sub-agent access surface 会被转换成一组 `shared_state.*` tools 注入 sub-agent session。

当前 coding-agent sub-agent factory 的限制：

- sub-agent 不自动继承主 agent 的 tools / skills / MCP / context files。
- 当前 phase 对 definition metadata 中的 `tools`、`skills`、`mcp` 直接报错。
- 已支持的是 restricted resource loader + system prompt + explicit shared-state tools。

## 14. 一张总链路图

```text
User input
  -> InteractiveMode / PrintMode / RpcMode
  -> AgentSession.prompt()
  -> Agent.prompt()
  -> runAgentLoop()
  -> packages/ai streamSimple()
  -> provider adapter
  -> AssistantMessageEventStream
  -> AgentEvent
  -> AgentState reducer
  -> AgentSession event bridge
       -> extensions
       -> session JSONL persistence on message_end
       -> mode subscribers
  -> TUI / RPC / print output
```

Tool call 子链路：

```text
provider-native tool event
  -> provider adapter normalizes to ToolCall
  -> AssistantMessage.content[]
  -> AgentEvent.message_update
  -> TUI creates ToolExecutionComponent
  -> agent-loop executeToolCalls()
  -> AgentTool.execute()
  -> AgentToolResult
  -> ToolResultMessage
  -> next LLM request context
```

---

# 补充：System Prompt、Message Builder、Provider Stream 到 Runtime Event

本节专门补齐 coding-agent 的完整 system prompt 构造方式、messages / tools 如何进入 LLM context，以及 provider 原始流式返回如何被整理成 CLI/TUI 消费的 runtime events。

## 15. Coding-agent system prompt 的完整构造

入口是 `packages/coding-agent/src/core/system-prompt.ts` 的 `buildSystemPrompt()`。调用点在 `packages/coding-agent/src/core/agent-session.ts`：

```text
AgentSession._buildRuntime()
  -> createAllToolDefinitions()
  -> _refreshToolRegistry()
  -> setActiveToolsByName()
  -> _rebuildSystemPrompt(activeToolNames)
  -> buildSystemPrompt(BuildSystemPromptOptions)
  -> agent.state.systemPrompt = prompt
```

### 15.1 BuildSystemPromptOptions

`AgentSession._rebuildSystemPrompt()` 组装这些输入：

```ts
interface BuildSystemPromptOptions {
  customPrompt?: string;
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
  appendSystemPrompt?: string;
  cwd: string;
  contextFiles?: Array<{ path: string; content: string }>;
  skills?: Skill[];
}
```

来源：

- `customPrompt`：`ResourceLoader.getSystemPrompt()`，如果存在会替换默认 prompt 主体。
- `appendSystemPrompt`：`ResourceLoader.getAppendSystemPrompt()`，追加到 prompt 主体后。
- `contextFiles`：`ResourceLoader.getAgentsFiles().agentsFiles`，通常来自 AGENTS.md / CLAUDE.md。
- `skills`：`ResourceLoader.getSkills().skills`。
- `selectedTools`：当前 active tools。
- `toolSnippets`：每个 `ToolDefinition.promptSnippet` 的单行归一化结果。
- `promptGuidelines`：每个 active tool 的 `ToolDefinition.promptGuidelines`。
- `cwd`：当前工作目录，最后写入 prompt。

### 15.2 默认 system prompt 模板

当没有 `customPrompt` 时，默认主体结构是：

```text
You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
{toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
{guidelines}

Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: {readmePath}
- Additional docs: {docsPath}
- Examples: {examplesPath} (extensions, custom tools, SDK)
- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory
- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)
- When working on pi topics, read the docs and examples, and follow .md cross-references before implementing
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

{appendSystemPrompt?}

<project_context>

Project-specific instructions and guidelines:

<project_instructions path="...">
...
</project_instructions>

</project_context>

{skills index if read tool active}
Current date: YYYY-MM-DD
Current working directory: {cwd}
```

注意：`Available tools` 只展示有 `promptSnippet` 的 active tools；即使 custom tool 没有 snippet，它仍可能作为真实 LLM tool schema 暴露给 provider。

### 15.3 内置 tool snippets / guidelines

内置 tools 的 prompt snippet 来自各 `ToolDefinition`：

```text
read  -> Read file contents
bash  -> Execute bash commands (ls, grep, find, etc.)
edit  -> Make precise file edits with exact text replacement, including multiple disjoint edits in one call
write -> Create or overwrite files
grep  -> Search file contents for patterns (respects .gitignore)
find  -> Find files by glob pattern (respects .gitignore)
ls    -> List directory contents
```

内置通用 guidelines：

```text
- Be concise in your responses
- Show file paths clearly when working with files
```

根据 active tools 动态加入：

- 只有 bash，没有 grep/find/ls：`Use bash for file operations like ls, rg, find`
- bash 与 grep/find/ls 同时存在：`Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)`

各 tool 可追加自己的 guidelines，例如：

- `read`: `Use read to examine files instead of cat or sed.`
- `write`: `Use write only for new files or complete rewrites.`
- `edit`: 精确替换、多个 disjoint edits 合并到一次 edit call、`oldText` 必须基于原文件等。

#### Guidelines 的完整加入流程

`Guidelines` 不是独立 runtime contract，而是默认 system prompt 中动态生成的一段 bullet list。它只在没有 `customPrompt` 的默认 prompt 分支中生成。

生成位置：`packages/coding-agent/src/core/system-prompt.ts` 的 `buildSystemPrompt()`。

生成时先创建 list 和 set，用 set 去重、用 list 保持插入顺序：

```ts
const guidelinesList: string[] = [];
const guidelinesSet = new Set<string>();

const addGuideline = (guideline: string): void => {
  if (guidelinesSet.has(guideline)) return;
  guidelinesSet.add(guideline);
  guidelinesList.push(guideline);
};
```

输入来源有三层：

1. 根据 active tools 推导文件探索规则：

```ts
if (hasBash && !hasGrep && !hasFind && !hasLs) {
  addGuideline("Use bash for file operations like ls, rg, find");
} else if (hasBash && (hasGrep || hasFind || hasLs)) {
  addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
}
```

2. `AgentSession._rebuildSystemPrompt()` 收集 active tools 的 `ToolDefinition.promptGuidelines`，通过 `BuildSystemPromptOptions.promptGuidelines` 传入：

```ts
const toolGuidelines = this._toolPromptGuidelines.get(name);
if (toolGuidelines) {
  promptGuidelines.push(...toolGuidelines);
}
```

`buildSystemPrompt()` 对这些外部传入 guideline trim 后去重加入：

```ts
for (const guideline of promptGuidelines ?? []) {
  const normalized = guideline.trim();
  if (normalized.length > 0) {
    addGuideline(normalized);
  }
}
```

3. 最后总是加入两条全局默认规则：

```ts
addGuideline("Be concise in your responses");
addGuideline("Show file paths clearly when working with files");
```

最终拼接成 system prompt 的 `Guidelines:` 段：

```ts
const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
```

链路总结：

```text
active tools
  -> _toolPromptGuidelines map
  -> AgentSession._rebuildSystemPrompt() 收集 promptGuidelines
  -> buildSystemPrompt() 加工具组合规则
  -> 加 tool-specific guidelines
  -> 加全局默认 guidelines
  -> 去重后拼进默认 system prompt
```

### 15.4 customPrompt 分支

如果 `ResourceLoader.getSystemPrompt()` 返回了 custom prompt：

- 默认主体、默认工具列表、默认 pi docs 指引都不会生成。
- 仍然会追加 `appendSystemPrompt`。
- 仍然会追加 `<project_context>`。
- 如果 `read` 可用，仍然会追加 skills index。
- 最后仍然追加 `Current date` 和 `Current working directory`。

## 16. Messages 如何构造成 LLM context

message 构造跨三层：

```text
interactive/print/rpc input
  -> AgentSession.prompt()
  -> Agent.prompt()
  -> Agent.normalizePromptInput()
  -> AgentMessage[]
  -> runAgentLoop()
  -> transformContext?()
  -> convertToLlm()
  -> Context { systemPrompt, messages, tools }
  -> streamSimple(model, context, options)
```

### 16.1 用户输入变成 UserMessage

`Agent.normalizePromptInput()` 把字符串输入转成：

```ts
{
  role: "user",
  content: [
    { type: "text", text: input },
    ...images
  ],
  timestamp: Date.now(),
}
```

如果调用者直接传 `AgentMessage` 或 `AgentMessage[]`，则直接使用。

### 16.2 AgentMessage 到 LLM Message

`Agent` 默认的 `convertToLlm()`：

```ts
messages.filter(
  (message) =>
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "toolResult",
)
```

也就是说：

- LLM-visible: `user` / `assistant` / `toolResult`
- UI-only 或 extension custom messages 默认不会进 LLM context
- coding-agent 可通过 `transformContext` 做压缩、裁剪、注入 context

最终 LLM context：

```ts
interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
```

### 16.3 tools 不是放进 messages，而是 Context.tools

Pi 的 canonical context 里，tools 单独放在 `Context.tools`：

```ts
const llmContext: Context = {
  systemPrompt: context.systemPrompt,
  messages: llmMessages,
  tools: context.tools,
};
```

然后由 provider adapter 转换成原生请求字段：

- OpenAI Chat Completions: `params.tools = [{ type: "function", function: { name, description, parameters, strict } }]`
- Anthropic: `tools: [{ name, description, input_schema }]`
- Bedrock / Google / Mistral：各自 adapter 转换

`Available tools:` 只是 system prompt 的自然语言提示；真正可调用 tool schema 来自 `Context.tools`。

### 16.4 tool result 如何回填 messages

工具执行后，agent loop 创建：

```ts
{
  role: "toolResult",
  toolCallId: finalized.toolCall.id,
  toolName: finalized.toolCall.name,
  content: finalized.result.content,
  details: finalized.result.details,
  isError: finalized.isError,
  timestamp: Date.now(),
}
```

这个 `ToolResultMessage` 会：

1. emit `message_start` / `message_end` 给 runtime listeners。
2. push 到 `currentContext.messages`。
3. push 到 `newMessages`。
4. 在下一次 provider request 中被 adapter 转成 provider 原生 tool result。

OpenAI-compatible 转换方式：

```ts
{
  role: "tool",
  content: textResult || "(see attached image)",
  tool_call_id: toolMsg.toolCallId,
  name?: toolMsg.toolName // only when compat requires it
}
```

Anthropic 转换方式：

```ts
{
  type: "tool_result",
  tool_use_id: msg.toolCallId,
  content: ...,
  is_error?: msg.isError
}
```

所以内部永远是 `role: "toolResult"`，provider 层才变成 `role: "tool"` 或 `tool_result`。

## 17. Tool schema 暴露、校验、错误表示

### 17.1 注册链路

```text
createAllToolDefinitions(cwd)
  -> ToolDefinition registry
  -> wrapRegisteredTools()
  -> AgentTool registry
  -> setActiveToolsByName()
  -> agent.state.tools = AgentTool[]
  -> Context.tools
  -> provider native tool schema
```

extension / SDK custom tools 也走同一条 `ToolDefinition -> AgentTool` 链路。

### 17.2 ToolDefinition 和 AgentTool 的分工

`ToolDefinition` 是 coding-agent 层结构，包含 UI / prompt 信息：

- `name`, `label`, `description`
- `promptSnippet`, `promptGuidelines`
- `parameters` TypeBox schema
- `execute(...)`
- `renderCall`, `renderResult`

`AgentTool` 是 agent-core 运行时结构：

- `name`, `description`, `parameters`
- `label`
- `prepareArguments?`
- `execute(toolCallId, params, signal, onUpdate)`
- `executionMode?`

### 17.3 input validation

执行 tool 前，`prepareToolCall()` 做：

```text
find tool by toolCall.name
  -> tool.prepareArguments?()
  -> validateToolArguments(tool, preparedToolCall)
  -> beforeToolCall?()
  -> execute tool
```

`validateToolArguments()` 使用 TypeBox / JSON Schema：

- clone raw arguments
- `Value.Convert()` 做类型转换
- JSON Schema fallback coercion
- validator.Check()
- 失败时抛出包含 path、错误原因、收到参数 JSON 的 error

校验失败不会让 agent loop 崩掉，而是变成 error tool result。

### 17.4 tool error 的表示

错误统一通过 `ToolResultMessage.isError = true` 表示，content 是文本错误：

```ts
function createErrorToolResult(message: string): AgentToolResult<any> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}
```

错误来源包括：

- tool 不存在
- 参数校验失败
- `beforeToolCall` block
- abort
- tool.execute throw
- `afterToolCall` throw

事件仍然完整 emit：`tool_execution_start` -> `tool_execution_end(isError: true)` -> `ToolResultMessage(isError: true)`。

## 18. Provider 原始流如何 normalize 成 AssistantMessageEvent

Pi 的 provider adapter 不把 SDK 原始 chunk 直接暴露给 agent loop，而是统一成 `AssistantMessageEventStream`。

### 18.1 OpenAI-compatible / DeepSeek 路径

DeepSeek 当前走 `openai-completions` adapter：

```text
model.provider = "deepseek"
model.api = "openai-completions"
model.baseUrl = "https://api.deepseek.com"
model.compat.thinkingFormat = "deepseek"
```

请求构造：

```text
createClient(model.baseUrl)
  -> buildParams(model, context, options, compat)
  -> client.chat.completions.create(params, { stream: true })
```

`buildParams()` 做：

- `messages = convertMessages(model, context, compat)`
- `stream: true`
- `stream_options: { include_usage: true }`，如果 provider 支持
- `tools = convertTools(context.tools, compat)`
- `tool_choice`，如果 options 指定
- reasoning / thinking 字段：DeepSeek 使用 `thinking: { type: "enabled" | "disabled" }`，有 effort 时加 `reasoning_effort`

OpenAI-compatible raw stream normalize：

```text
ChatCompletionChunk
  -> chunk.choices[].delta.content        -> TextContent + text_delta
  -> reasoning fields / reasoning_content -> ThinkingContent + thinking_delta
  -> delta.tool_calls[].function.name     -> ToolCall.name
  -> delta.tool_calls[].id                -> ToolCall.id
  -> delta.tool_calls[].function.arguments fragments
       -> append partialArgs
       -> parseStreamingJson(partialArgs)
       -> ToolCall.arguments
       -> toolcall_delta
  -> finish_reason tool_calls/function_call -> stopReason "toolUse"
  -> finish_reason stop/end                -> stopReason "stop"
  -> finish_reason length                  -> stopReason "length"
  -> usage                                 -> Usage
```

内部 stream 事件：

```text
stream.push(start)
text_start / text_delta / text_end
thinking_start / thinking_delta / thinking_end
toolcall_start / toolcall_delta / toolcall_end
done or error
```

关键点：tool arguments 在 streaming 中是 JSON 字符串碎片，Pi 每次 delta 都尝试 `parseStreamingJson()`，因此 TUI 可以边流式展示逐渐完整的 args。

### 18.2 Anthropic 路径

Anthropic raw event normalize：

```text
content_block_start text       -> TextContent + text_start
content_block_start thinking   -> ThinkingContent + thinking_start
content_block_start tool_use   -> ToolCall + toolcall_start
content_block_delta text_delta -> append text + text_delta
content_block_delta thinking_delta -> append thinking + thinking_delta
content_block_delta input_json_delta
  -> append partialJson
  -> parseStreamingJson(partialJson)
  -> ToolCall.arguments
  -> toolcall_delta
content_block_stop -> *_end / toolcall_end
message_delta.stop_reason -> stopReason mapping
```

Anthropic 原生 `tool_use` / `tool_result` 只存在 adapter 边界；进入 agent-core 后都变成 `ToolCall` / `ToolResultMessage`。

### 18.3 provider adapter 的输出契约

所有 provider stream function 的契约：

- 返回 `AssistantMessageEventStream`
- request/model/runtime failure 不应直接 throw 给上层
- 失败应编码为 stream event，最终产生 `AssistantMessage.stopReason = "error" | "aborted"`
- `done/error` 后，`response.result()` 能拿到最终 `AssistantMessage`

## 19. AssistantMessageEvent 如何变成 AgentEvent

转换发生在 `packages/agent/src/agent-loop.ts` 的 `streamAssistantResponse()`。

### 19.1 start

provider emit：

```ts
{ type: "start", partial: AssistantMessage }
```

agent loop：

```text
partialMessage = event.partial
context.messages.push(partialMessage)
emit AgentEvent.message_start({ ...partialMessage })
```

### 19.2 delta / block events

provider emit：

```text
text_start/text_delta/text_end
thinking_start/thinking_delta/thinking_end
toolcall_start/toolcall_delta/toolcall_end
```

agent loop：

```text
partialMessage = event.partial
context.messages[last] = partialMessage
emit AgentEvent.message_update({
  message: { ...partialMessage },
  assistantMessageEvent: event,
})
```

`assistantMessageEvent` 保留低层 block event，供 UI 或 extension 做更细粒度响应。

### 19.3 done / error

provider emit：

```ts
{ type: "done", reason, message }
// or
{ type: "error", reason, error }
```

agent loop：

```text
finalMessage = await response.result()
context.messages[last] = finalMessage
if start 没来过，则补 emit message_start
emit message_end(finalMessage)
return finalMessage
```

随后 run loop 根据 final message：

- `stopReason = error/aborted`：emit `turn_end`，再 `agent_end`，结束。
- content 里有 `ToolCall[]`：执行 tools，生成 tool results，然后进入下一轮。
- 没有 tool call：看 steering/followUp，没有则 `agent_end`。

## 20. AgentEvent 如何变成 CLI/TUI 流式事件

### 20.1 Agent state reducer

`packages/agent/src/agent.ts` 的 `processEvents()` 先更新 `AgentState`：

- `message_start` / `message_update`：更新 `streamingMessage`
- `message_end`：清空 `streamingMessage`，把 message push 到 `state.messages`
- `tool_execution_start`：把 id 加入 `pendingToolCalls`
- `tool_execution_end`：把 id 移出 `pendingToolCalls`
- `turn_end`：记录 assistant error
- `agent_end`：清空 streaming state

然后按订阅顺序 await listeners。

### 20.2 AgentSession bridge

`AgentSession._handleAgentEvent()` 接到 `AgentEvent` 后：

```text
queue cleanup for user messages
  -> emit extension event first
  -> emit AgentSessionEvent to mode listeners
  -> on message_end persist to SessionManager
  -> track assistant message for retry/compaction
```

所以 extensions 先看到事件，并可在 `message_end` 替换 message；然后 TUI/RPC/print mode 收到事件；最后 message 被 session 持久化。

### 20.3 TUI event handling

interactive mode 订阅：

```ts
this.unsubscribe = this.session.subscribe(async (event) => {
  await this.handleEvent(event);
});
```

核心映射：

```text
agent_start
  -> 清 pendingTools，启动 working loader

message_start:user
  -> addMessageToChat(user)

message_start:assistant
  -> new AssistantMessageComponent()
  -> chatContainer.addChild(streamingComponent)

message_update:assistant
  -> streamingComponent.updateContent(message)
  -> 扫描 message.content 中的 ToolCall
  -> 若新 toolCall.id，创建 ToolExecutionComponent(toolName, id, args)
  -> 若已有，updateArgs(arguments)

message_end:assistant
  -> update final assistant content
  -> 如果 error/aborted，给 pending tool components 写入 error result
  -> 否则 setArgsComplete()
  -> 清 streamingComponent

tool_execution_start
  -> markExecutionStarted()

tool_execution_update
  -> component.updateResult(partialResult, true)

tool_execution_end
  -> component.updateResult(final result)
  -> pendingTools.delete(toolCallId)

agent_end
  -> 停止 loader，清 pending state
```

CLI print mode / RPC mode 也订阅同一批 `AgentSessionEvent`：

- print mode 将事件转成 stdout 输出。
- rpc mode 将事件序列化给 client。
- TUI 将事件转成 components 和 incremental render。

## 21. 消息事件定义的层级

Pi 现在有三层事件定义：

### 21.1 Provider stream event

`AssistantMessageEvent`，定义在 `packages/ai/src/types.ts`。粒度最细，包含 text/thinking/toolcall block start/delta/end。

用途：provider adapter -> agent loop。

### 21.2 Runtime event

`AgentEvent`，定义在 `packages/agent/src/types.ts`。面向 agent runtime：

- agent lifecycle
- turn lifecycle
- message lifecycle
- tool execution lifecycle

用途：agent loop -> Agent state -> AgentSession。

### 21.3 App/session event

`AgentSessionEvent`，定义在 `packages/coding-agent/src/core/agent-session.ts`。在 `AgentEvent` 基础上扩展：

- queue update
- compaction start/end
- retry start/end
- thinking level changed
- session info changed

用途：AgentSession -> interactive / print / rpc / extensions。

总结链路：

```text
raw provider chunks
  -> AssistantMessageEvent
  -> AgentEvent.message_update / tool_execution_*
  -> AgentSessionEvent
  -> TUI component update / RPC event / print output / session JSONL
```

## 22. DeepSeek V4 走 OpenAI Completions adapter 的完整请求与解析

本节以 `deepseek-v4-flash` / `deepseek-v4-pro` 为例，说明“用 OpenAI Chat Completions 代码请求 DeepSeek V4”时，Pi 具体如何构造请求、发送、流式解析、再转成 runtime event。

### 22.1 模型定义：provider 是 deepseek，api 是 openai-completions

模型定义源头在 `packages/ai/scripts/generate-models.ts`，生成到 `packages/ai/src/models.generated.ts`。

关键定义：

```ts
const deepseekCompat: OpenAICompletionsCompat = {
  requiresReasoningContentOnAssistantMessages: true,
  thinkingFormat: "deepseek",
};

const deepseekV4Models: Model<"openai-completions">[] = [
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    provider: "deepseek",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: deepseekCompat,
    // cost omitted here
  },
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    api: "openai-completions",
    baseUrl: "https://api.deepseek.com",
    provider: "deepseek",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 384000,
    compat: deepseekCompat,
  },
];
```

含义：

- `provider: "deepseek"`：认证、env key、展示层使用 DeepSeek provider 名字。
- `api: "openai-completions"`：请求实现复用 `packages/ai/src/providers/openai-completions.ts`。
- `baseUrl: "https://api.deepseek.com"`：OpenAI SDK client 的 `baseURL` 指向 DeepSeek。
- `thinkingFormat: "deepseek"`：构造请求时使用 DeepSeek 的 thinking 参数格式。
- `requiresReasoningContentOnAssistantMessages: true`：replay assistant 历史时，为 reasoning 模型补 `reasoning_content` 字段。

### 22.2 分发入口：streamSimple 根据 model.api 找 adapter

调用链：

```text
Agent loop
  -> streamFn(config.model, llmContext, options)
  -> streamSimple(model, context, options)
  -> getApiProvider(model.api)
  -> openai-completions provider
  -> streamOpenAICompletions(model, context, options)
```

`packages/ai/src/stream.ts`：

```ts
export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const provider = resolveApiProvider(model.api);
  return provider.streamSimple(model, context, options);
}
```

因为 DeepSeek V4 的 `model.api === "openai-completions"`，所以会进入 `streamOpenAICompletions()`。

### 22.3 创建 OpenAI SDK client，但 baseURL 指向 DeepSeek

`packages/ai/src/providers/openai-completions.ts` 的 `createClient()`：

```ts
function createClient(
  model: Model<"openai-completions">,
  context: Context,
  apiKey?: string,
  optionsHeaders?: Record<string, string>,
  sessionId?: string,
  compat: ResolvedOpenAICompletionsCompat = getCompat(model),
) {
  if (!apiKey) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass it as an argument.",
      );
    }
    apiKey = process.env.OPENAI_API_KEY;
  }

  const headers = { ...model.headers };
  if (optionsHeaders) {
    Object.assign(headers, optionsHeaders);
  }

  return new OpenAI({
    apiKey,
    baseURL: isCloudflareProvider(model.provider) ? resolveCloudflareBaseUrl(model) : model.baseUrl,
    dangerouslyAllowBrowser: true,
    defaultHeaders: headers,
  });
}
```

对 DeepSeek 来说：

```text
apiKey  = options.apiKey || getEnvApiKey("deepseek") || ""
baseURL = "https://api.deepseek.com"
```

所以代码用的是 OpenAI SDK 的 `chat.completions.create()`，但 HTTP 目标是 DeepSeek OpenAI-compatible endpoint。

### 22.4 buildParams：把 Pi Context 转成 Chat Completions request

`buildParams()` 核心结构：

```ts
function buildParams(
  model: Model<"openai-completions">,
  context: Context,
  options?: OpenAICompletionsOptions,
  compat: ResolvedOpenAICompletionsCompat = getCompat(model),
  cacheRetention: CacheRetention = resolveCacheRetention(options?.cacheRetention),
) {
  const messages = convertMessages(model, context, compat);

  const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming = {
    model: model.id,
    messages,
    stream: true,
    prompt_cache_key: ...,
    prompt_cache_retention: ...,
  };

  if (compat.supportsUsageInStreaming !== false) {
    (params as any).stream_options = { include_usage: true };
  }

  if (context.tools && context.tools.length > 0) {
    params.tools = convertTools(context.tools, compat);
  } else if (hasToolHistory(context.messages)) {
    params.tools = [];
  }

  if (options?.toolChoice) {
    params.tool_choice = options.toolChoice;
  }

  if (compat.thinkingFormat === "deepseek" && model.reasoning) {
    (params as any).thinking = { type: options?.reasoningEffort ? "enabled" : "disabled" };
    if (options?.reasoningEffort) {
      (params as any).reasoning_effort =
        model.thinkingLevelMap?.[options.reasoningEffort] ?? options.reasoningEffort;
    }
  }

  return params;
}
```

对 DeepSeek V4，最关键的是：

```ts
{
  model: "deepseek-v4-flash", // or deepseek-v4-pro
  messages: convertMessages(...),
  stream: true,
  stream_options: { include_usage: true },
  tools: [...],                 // 如果 context.tools 非空
  thinking: { type: "enabled" | "disabled" },
  reasoning_effort?: "low" | "medium" | "high" | ...
}
```

### 22.5 convertMessages：Pi Message 到 OpenAI Chat message

`convertMessages(model, context, compat)` 负责把 Pi canonical messages 转成 OpenAI Chat Completions `messages`。

#### system prompt

```ts
if (context.systemPrompt) {
  const useDeveloperRole = model.reasoning && compat.supportsDeveloperRole;
  const role = useDeveloperRole ? "developer" : "system";
  params.push({ role, content: sanitizeSurrogates(context.systemPrompt) });
}
```

DeepSeek 属于 OpenAI-compatible non-standard provider，`supportsDeveloperRole` 通常为 false，所以一般使用：

```ts
{ role: "system", content: systemPrompt }
```

#### user message

```ts
if (msg.role === "user") {
  if (typeof msg.content === "string") {
    params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
  } else {
    params.push({
      role: "user",
      content: msg.content.map((item) =>
        item.type === "text"
          ? { type: "text", text: sanitizeSurrogates(item.text) }
          : { type: "image_url", image_url: { url: `data:${item.mimeType};base64,${item.data}` } },
      ),
    });
  }
}
```

DeepSeek V4 模型定义 `input: ["text"]`，所以正常场景主要是 text。

#### assistant message replay

Pi assistant message 内部是 content blocks：text / thinking / toolCall。OpenAI Chat Completions replay 时会被压成 assistant message：

```ts
const assistantMsg: ChatCompletionAssistantMessageParam = {
  role: "assistant",
  content: null,
};

// text blocks -> plain string
assistantMsg.content = assistantText;

// toolCall blocks -> tool_calls
assistantMsg.tool_calls = toolCalls.map((tc) => ({
  id: tc.id,
  type: "function",
  function: {
    name: tc.name,
    arguments: JSON.stringify(tc.arguments),
  },
}));
```

DeepSeek 特殊处理：如果是 reasoning model 且历史 assistant message 没有 `reasoning_content`，补空字符串：

```ts
if (
  compat.requiresReasoningContentOnAssistantMessages &&
  model.reasoning &&
  (assistantMsg as { reasoning_content?: string }).reasoning_content === undefined
) {
  (assistantMsg as { reasoning_content?: string }).reasoning_content = "";
}
```

#### toolResult message replay

Pi 内部：

```ts
{
  role: "toolResult",
  toolCallId,
  toolName,
  content,
  isError,
}
```

OpenAI-compatible 请求里变成：

```ts
const toolResultMsg: ChatCompletionToolMessageParam = {
  role: "tool",
  content: sanitizeSurrogates(hasText ? textResult : "(see attached image)"),
  tool_call_id: toolMsg.toolCallId,
};

if (compat.requiresToolResultName && toolMsg.toolName) {
  (toolResultMsg as any).name = toolMsg.toolName;
}
```

### 22.6 convertTools：Pi Tool 到 OpenAI function tool

Pi 的 `Context.tools` 是：

```ts
interface Tool {
  name: string;
  description: string;
  parameters: TSchema;
}
```

OpenAI-compatible request 中变成：

```ts
function convertTools(
  tools: Tool[],
  compat: ResolvedOpenAICompletionsCompat,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as any,
      ...(compat.supportsStrictMode !== false && { strict: false }),
    },
  }));
}
```

因此 tools 不在 `messages` 里，而是在 Chat Completions request 顶层 `tools` 字段。

### 22.7 发起请求

`streamOpenAICompletions()` 里实际请求：

```ts
const client = createClient(model, context, apiKey, options?.headers, cacheSessionId, compat);
let params = buildParams(model, context, options, compat, cacheRetention);

const nextParams = await options?.onPayload?.(params, model);
if (nextParams !== undefined) {
  params = nextParams as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming;
}

const requestOptions = {
  ...(options?.signal ? { signal: options.signal } : {}),
  ...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  maxRetries: options?.maxRetries ?? 0,
};

const { data: openaiStream, response } = await client.chat.completions
  .create(params, requestOptions)
  .withResponse();

await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
stream.push({ type: "start", partial: output });
```

这里的 `openaiStream` 是 OpenAI SDK 暴露的 async iterable，每个元素是 `ChatCompletionChunk`。DeepSeek 返回只要兼容 OpenAI streaming 格式，就进入同一套解析逻辑。

### 22.8 流式解析：raw chunk 到 Pi content blocks

Pi 初始化一个空的 canonical assistant message：

```ts
const output: AssistantMessage = {
  role: "assistant",
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: emptyUsage,
  stopReason: "stop",
  timestamp: Date.now(),
};
```

然后逐 chunk 解析：

```ts
for await (const chunk of openaiStream) {
  output.responseId ||= chunk.id;
  if (chunk.model && chunk.model !== model.id) output.responseModel ||= chunk.model;
  if (chunk.usage) output.usage = parseChunkUsage(chunk.usage, model);

  const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
  if (!choice) continue;

  if (choice.finish_reason) {
    const finishReasonResult = mapStopReason(choice.finish_reason);
    output.stopReason = finishReasonResult.stopReason;
    output.errorMessage = finishReasonResult.errorMessage;
  }

  if (choice.delta?.content) {
    const block = ensureTextBlock();
    block.text += choice.delta.content;
    stream.push({ type: "text_delta", contentIndex, delta: choice.delta.content, partial: output });
  }

  // reasoning_content / reasoning / reasoning_text -> ThinkingContent
  // tool_calls -> ToolCall
}
```

#### text delta

Raw：

```ts
choice.delta.content = "hello"
```

Internal：

```ts
{ type: "text", text: "...hello" }
```

Event：

```ts
{ type: "text_delta", contentIndex, delta: "hello", partial: output }
```

#### reasoning delta

OpenAI-compatible endpoints 可能把 reasoning 放在不同字段：

```ts
const reasoningFields = ["reasoning_content", "reasoning", "reasoning_text"];
```

找到第一个非空字段后：

```ts
const block = ensureThinkingBlock(thinkingSignature);
block.thinking += delta;
stream.push({
  type: "thinking_delta",
  contentIndex: getContentIndex(block),
  delta,
  partial: output,
});
```

Internal：

```ts
{
  type: "thinking",
  thinking: "...",
  thinkingSignature: "reasoning_content" // or reasoning / reasoning_text
}
```

#### tool call delta

OpenAI-compatible raw：

```ts
choice.delta.tool_calls = [
  {
    index: 0,
    id: "call_xxx",
    type: "function",
    function: {
      name: "read",
      arguments: "{\"path\":"
    }
  }
]
```

Pi 内部处理：

```ts
const block = ensureToolCallBlock(toolCall);
if (!block.id && toolCall.id) block.id = toolCall.id;
if (!block.name && toolCall.function?.name) block.name = toolCall.function.name;

if (toolCall.function?.arguments) {
  block.partialArgs = (block.partialArgs ?? "") + toolCall.function.arguments;
  block.arguments = parseStreamingJson(block.partialArgs);
}

stream.push({
  type: "toolcall_delta",
  contentIndex: getContentIndex(block),
  delta: toolCall.function?.arguments ?? "",
  partial: output,
});
```

Internal block：

```ts
{
  type: "toolCall",
  id: "call_xxx",
  name: "read",
  arguments: { path: "..." }, // partial JSON 可逐步变完整
  partialArgs: "..."          // streaming scratch, finalize 后删除
}
```

streaming 结束后，所有 block 会 finalize：

```ts
for (const block of blocks) {
  finishBlock(block);
}
```

其中 tool call finalize：

```ts
block.arguments = parseStreamingJson(block.partialArgs);
delete block.partialArgs;
delete block.streamIndex;
stream.push({
  type: "toolcall_end",
  contentIndex,
  toolCall: block,
  partial: output,
});
```

### 22.9 finish_reason 到 stopReason

OpenAI-compatible finish reason 映射：

```ts
function mapStopReason(reason: ChatCompletionChunk.Choice["finish_reason"] | string) {
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    case "content_filter":
      return { stopReason: "error", errorMessage: "Provider finish_reason: content_filter" };
    default:
      return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
  }
}
```

所以 DeepSeek 如果返回 `finish_reason: "tool_calls"`，Pi 最终 assistant message 是：

```ts
{
  role: "assistant",
  content: [..., { type: "toolCall", ... }],
  stopReason: "toolUse",
  provider: "deepseek",
  api: "openai-completions",
  model: "deepseek-v4-flash",
}
```

agent loop 看到 `stopReason: "toolUse"` 并且 `content` 里有 `ToolCall`，就会执行 tool。

### 22.10 完成或错误

成功：

```ts
if (!hasFinishReason) {
  throw new Error("Stream ended without finish_reason");
}

stream.push({ type: "done", reason: output.stopReason, message: output });
stream.end();
```

失败：

```ts
output.stopReason = options?.signal?.aborted ? "aborted" : "error";
output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
stream.push({ type: "error", reason: output.stopReason, error: output });
stream.end();
```

### 22.11 DeepSeek V4 请求与解析总图

```text
Model(deepseek-v4-flash)
  provider = deepseek
  api = openai-completions
  baseUrl = https://api.deepseek.com
  compat.thinkingFormat = deepseek
        |
        v
streamSimple(model, Context)
        |
        v
streamOpenAICompletions()
  -> createClient(OpenAI SDK, baseURL=DeepSeek)
  -> buildParams()
       - model: deepseek-v4-flash
       - messages: convertMessages(Pi Message -> Chat messages)
       - tools: convertTools(Context.tools -> function tools)
       - stream: true
       - thinking: { type }
       - reasoning_effort?
  -> client.chat.completions.create(params).withResponse()
        |
        v
for await chunk of openaiStream
  -> delta.content -> TextContent + text_delta
  -> delta.reasoning_content/reasoning -> ThinkingContent + thinking_delta
  -> delta.tool_calls -> ToolCall + toolcall_delta
  -> finish_reason -> stopReason
  -> usage -> Usage
        |
        v
AssistantMessageEventStream
  -> start / *_delta / *_end / done|error
        |
        v
agent-loop streamAssistantResponse()
  -> AgentEvent.message_start/update/end
  -> if stopReason toolUse: execute tools
  -> ToolResultMessage
  -> next LLM request
```

## 23. 内置 tools 的实现要点与易错点

coding-agent 内置 tools 定义在 `packages/coding-agent/src/core/tools/`，统一由 `createAllToolDefinitions()` 汇总：

```ts
export type ToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions) {
  return {
    read: createReadToolDefinition(cwd, options?.read),
    bash: createBashToolDefinition(cwd, options?.bash),
    edit: createEditToolDefinition(cwd, options?.edit),
    write: createWriteToolDefinition(cwd, options?.write),
    grep: createGrepToolDefinition(cwd, options?.grep),
    find: createFindToolDefinition(cwd, options?.find),
    ls: createLsToolDefinition(cwd, options?.ls),
  };
}
```

默认 active tools 是 `read`、`bash`、`edit`、`write`；`grep/find/ls` 是内置但不一定默认启用。

### 23.1 共同实现模式

每个内置 tool 都是 `ToolDefinition`：

```ts
{
  name,
  label,
  description,
  promptSnippet?,
  promptGuidelines?,
  parameters,       // TypeBox schema
  execute(...),
  renderCall?,
  renderResult?,
}
```

共同注意点：

- 参数 schema 用 TypeBox，真正执行前由 agent loop 的 `validateToolArguments()` 统一校验。
- 路径都要通过 `resolveToCwd()` / `resolveReadPathAsync()` 处理，不直接信任模型给的 path。
- 长输出必须截断，并把截断信息放到 `details.truncation` 和文本 notice 里。
- abort 要清理 listener / child process / timer，避免 promise 重复 settle 或资源泄漏。
- 文件写入类 tool 要串行化同一文件的 mutation，避免并发写覆盖。
- `renderCall` / `renderResult` 是 TUI 展示逻辑，不影响回传给 LLM 的 canonical tool result。

### 23.2 read

文件：`packages/coding-agent/src/core/tools/read.ts`

schema：

```ts
{
  path: string;
  offset?: number; // 1-indexed
  limit?: number;
}
```

核心行为：

- `resolveReadPathAsync(path, cwd)` 解析路径，除普通路径外，还尝试 macOS 截图 AM/PM 窄空格、NFD Unicode、弯引号等变体。
- 先 `access()` 检查可读，再判断是否是支持的图片 MIME。
- 图片：读 buffer，必要时 resize，返回 `TextContent + ImageContent`；如果当前模型不支持 image，会追加提示文本。
- 文本：按 `offset` / `limit` 截取，再用 `truncateHead()` 做行数/字节限制。
- 如果首行本身超过 byte limit，会提示用 bash/sed/head-c 读取该行片段。

易错点：

- `offset` 是 1-indexed，内部要转换成 0-indexed；越界要报错。
- `limit` 是用户主动限制，不等于截断；如果后面还有内容，需要给 `Use offset=... to continue`。
- 图片返回给 LLM 时可能包含 base64，必须考虑模型是否支持 image 和 inline size limit。
- abort listener 里 reject 后，异步流程可能还在跑；代码用 `aborted` flag 防止后续 resolve/reject。
- 大文件不要一次无提示返回完整内容；必须保留 continuation notice。

### 23.3 bash

文件：`packages/coding-agent/src/core/tools/bash.ts`

schema：

```ts
{
  command: string;
  timeout?: number; // seconds
}
```

核心行为：

- `createLocalBashOperations()` 用配置的 shell 执行命令。
- stdout/stderr 都进入 `OutputAccumulator`。
- `onUpdate` 存在时，按 `BASH_UPDATE_THROTTLE_MS = 100` ms 节流发送 partial result。
- 输出截断时，保存完整输出到 temp file，并在 result details 中返回 `fullOutputPath`。
- exit code 非 0 会 throw，agent loop 会把它包装为 error tool result。

易错点：

- 不能只 kill 子进程，要 kill process tree；否则 detached children 可能继续跑。
- timeout 和 abort 都要走同一套清理：清 timer、移除 abort listener、untrack child pid。
- partial update 需要节流，否则大量 stdout 会刷爆 TUI/event loop。
- 命令失败时仍要保留 stdout/stderr，再追加 `Command exited with code N`。
- 截断输出时不能只丢内容；需要 full output temp path，便于用户继续读取。
- `commandPrefix` 会被拼到命令前，调试时要注意实际执行命令不是模型原始 command。

### 23.4 edit

文件：`packages/coding-agent/src/core/tools/edit.ts`

schema：

```ts
{
  path: string;
  edits: Array<{
    oldText: string;
    newText: string;
  }>;
}
```

核心行为：

- `prepareEditArguments()` 兼容模型把 `edits` 发成 JSON string 的情况，也兼容 legacy `oldText/newText` 顶层参数。
- 执行前要求 `edits` 非空。
- 用 `withFileMutationQueue(absolutePath, ...)` 串行化同一文件编辑。
- 读文件后先 strip BOM，检测原始换行符，内部统一 normalize 到 LF。
- `applyEditsToNormalizedContent()` 对原文件一次性匹配所有 `oldText`，不是一条条累积应用。
- 写回时恢复原文件换行符和 BOM。
- result details 包含 display diff、unified patch、firstChangedLine。
- TUI renderCall 会在 args complete 后异步 compute preview diff。

易错点：

- `oldText` 必须在原文件中唯一匹配；不能靠“第一个匹配”模糊替换。
- 多个 edits 是基于原文件并行匹配，不是前一个 edit 应用后的新文件。
- overlap / nested edits 必须拒绝或要求模型合并，否则结果不可预测。
- 不能因为 abort listener 提前 reject 就释放 mutation queue；代码选择在每个 await 后检查 `signal.aborted`，确保文件操作 settled 后才释放队列。
- 必须处理 BOM 和 CRLF，否则精确匹配和写回会破坏文件格式。
- 预览 diff 是 UI 辅助，不应作为真正执行结果的来源；最终以 execute 后重新计算的 diff 为准。

### 23.5 write

文件：`packages/coding-agent/src/core/tools/write.ts`

schema：

```ts
{
  path: string;
  content: string;
}
```

核心行为：

- `resolveToCwd(path, cwd)` 得到绝对路径。
- 自动 `mkdir(dirname(path), { recursive: true })`。
- 用 `withFileMutationQueue(absolutePath, ...)` 串行化同一文件写入。
- 写入成功返回 `Successfully wrote {content.length} bytes to {path}`。
- TUI renderCall 会对 content 做增量 syntax highlight，避免 streaming 大内容时反复全量 highlight。

易错点：

- 这是覆盖写；prompt guideline 明确要求只用于新文件或完整重写。
- 必须创建 parent dir，但不要吞掉 mkdir/write 的错误。
- 和 edit 一样，abort 不应提前释放 mutation queue；每个 await 后检查 signal。
- `content.length` 是 JS string length，不是严格 byte length；文案里叫 bytes 但实现按 length 计数，迁移时要注意是否要改成 `Buffer.byteLength()`。
- TUI 展示可能截断/折叠，不代表传给 LLM 的 tool result 包含完整文件内容；tool result 只返回成功信息。

### 23.6 grep

文件：`packages/coding-agent/src/core/tools/grep.ts`

schema：

```ts
{
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}
```

核心行为：

- 默认依赖 `rg`，通过 `ensureTool("rg", true)` 找到或下载。
- 使用 `rg --json --line-number --color=never --hidden`。
- `literal` 对应 `--fixed-strings`，`ignoreCase` 对应 `--ignore-case`，`glob` 对应 `--glob`。
- 使用 `--` 分隔 pattern 和 searchPath，避免 pattern 被当成 flag。
- 读取 rg JSON line，只收集 `event.type === "match"`。
- 到达 limit 后 kill child，并标记 `matchLimitReached`。
- 如果 `context > 0`，会再读文件内容补上下文行。
- 长行用 `truncateLine()`，整体输出再用 `truncateHead()`。

易错点：

- `rg` exit code 1 表示没匹配，不是错误；只有非 0/1 才是错误。
- 到达 limit 主动 kill child，不应被当成 rg 执行失败。
- context lines 需要重新读文件，可能失败；失败时返回 `(unable to read file)`，不要让整个 grep 崩掉。
- 输出路径在目录搜索时相对 search root；文件搜索时用 basename，这会影响调用者定位。
- `--hidden` 会搜 dotfiles，但仍尊重 `.gitignore`；迁移时不要误以为 hidden 等于 ignore disabled。
- regex/literal 模式要区分；用户输入普通字符串时如果没开 literal，可能被当 regex。

### 23.7 find

文件：`packages/coding-agent/src/core/tools/find.ts`

schema：

```ts
{
  pattern: string;
  path?: string;
  limit?: number;
}
```

核心行为：

- 默认依赖 `fd`，通过 `ensureTool("fd", true)` 找到或下载。
- 默认参数：`--glob --color=never --hidden --no-require-git --max-results N`。
- `--no-require-git` 用于让 fd 在非 git repo 下也应用层级 `.gitignore` 语义。
- 如果 pattern 包含 `/`，启用 `--full-path`，并给相对 pattern 自动补 `**/` 前缀。
- 输出路径相对 search root，并转成 posix slash。
- 支持 custom `operations.glob()`，用于远程/测试环境替代 fd。

易错点：

- fd `--glob` 默认只匹配 basename；包含路径的 pattern 必须启用 `--full-path`，否则 `src/**/*.ts` 可能匹配不到。
- `--full-path` 匹配绝对候选路径，相对 pattern 需要补 `**/`。
- limit 到达不一定代表真的还有更多，只能提示 “limit reached”。
- child abort 要 remove listener、kill child、防止重复 settle。
- 输出可能带 trailing slash，要保留目录标识。

### 23.8 ls

文件：`packages/coding-agent/src/core/tools/ls.ts`

schema：

```ts
{
  path?: string;
  limit?: number;
}
```

核心行为：

- 默认 path 是当前目录。
- `exists()` 后 `stat()` 确认是 directory。
- `readdir()` 后 case-insensitive 排序。
- 每个 entry 再 `stat()`，目录追加 `/`。
- stat 失败的 entry 会跳过。
- 输出按 entry count limit 和 byte limit 截断。

易错点：

- path 存在但不是目录要明确报 `Not a directory`。
- 给每个 entry stat 可能有 TOCTOU：目录变化时 stat 失败，当前实现选择跳过。
- 排序是 `toLowerCase().localeCompare()`，不是文件系统原始顺序。
- 空目录返回 `(empty directory)`。
- 和 find/grep 一样，显示层可能折叠结果；tool result 文本中仍会包含截断 notice。

### 23.9 文件 mutation queue

`edit` 和 `write` 都使用 `withFileMutationQueue()`，实现位置：`packages/coding-agent/src/core/tools/file-mutation-queue.ts`。

目的：同一文件的 mutation 串行执行，不同文件仍可并行。

关键点：

- queue key 优先用 `realpath(filePath)`，避免 symlink 指向同一文件时并发写。
- 文件不存在时用 resolved path 作为 key。
- 有一个 `registrationQueue`，避免两个调用同时注册同一 key 时竞态。
- `finally` 中释放 queue，并在当前 chained queue 仍是最新时删除 map entry。

迁移时易错点：

- 不要只按用户输入 path 做 key；相对路径、绝对路径、symlink 会绕过锁。
- abort 不能提前释放 queue，否则底层 fs write 仍可能完成并覆盖后续操作。
- 不要全局串行所有写操作；只需要同一文件串行。
