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
