# Shared State Multi-Agent Web UI 后端实现计划

## 1. 后端目标

实现一个 Node bridge backend，作为 Web UI 的统一后端适配层，负责：

- 管理真实 `pi --mode rpc` 进程（live mode）
- 管理日志回放引擎（replay mode）
- 暴露统一的 HTTP + SSE contract 给 React 前端
- 提供 Shared State / artifact / role-session 的读取能力

后端不是 scheduler，也不是新的 multi-agent runtime；它只是把现有 CLI / RPC / Shared State 基础组件组织成一个可被前端消费的产品层接口。

---

## 2. 为什么后端是必须的

浏览器不能直接：
- 启动和控制本地 `pi` 进程
- 读取本地 `.pi/multi-agent/...` 文件
- 读取 `.manifest.json` 和 role-session index
- 安全地恢复和管理 session 状态

因此必须有一个 Node backend 作为桥接层。

---

## 3. 双模式 backend：live + replay

## 3.1 live mode
来源：真实 `pi --mode rpc` 进程

职责：
- 启动 / 附着主 session
- 转发 prompt / abort / state / messages
- 把 RPC 事件转成 SSE
- 读取 Shared State manifest 和 artifact 内容

## 3.2 replay mode
来源：
- `data/sharedstate_multi_agent_cli_log.jsonl`
- 或类似的结构化日志

职责：
- 解析日志
- 以统一 SSE 事件格式回放
- 维护当前 session 快照
- 提供与 live mode 一致的 API 返回结构

### 核心要求
前端不应感知当前是：
- live mode
- replay mode

所以两种模式的 contract 必须一致。

---

## 4. 后端统一 contract

### 4.1 会话控制
- `POST /api/session/start`
- `POST /api/session/stop`
- `POST /api/prompt`
- `POST /api/abort`

说明：
- replay mode 下 `prompt` 可以不真正执行，但接口保留，必要时返回 mock acknowledgement 或不支持说明。

### 4.2 状态与历史
- `GET /api/state`
- `GET /api/messages`
- `GET /api/agents`
- `GET /api/role-sessions`
- `GET /api/events`（SSE）

### 4.3 Shared State / Artifacts
- `GET /api/shared-state/manifest`
- `GET /api/shared-state/artifact?path=...`
- 可选：`GET /api/shared-state/search?query=...`

---

## 5. Contract 详细定义

本节是前后端联调的第一版 source of truth。除特别说明外，live mode 和 replay mode 必须返回同一套字段；某个模式暂时无法提供的字段用 `null`、空数组或明确的错误码表达，不让前端通过字段名判断模式。

### 5.1 通用约定

- 所有 HTTP API 返回 `application/json; charset=utf-8`。
- 所有时间字段使用 ISO-8601 字符串，例如 `2026-05-28T10:20:30.000Z`。
- 所有 artifact path 使用相对 shared-state root 的 POSIX 风格路径，不允许绝对路径和 `..` 路径穿越。
- 缺失但合法的值使用 `null`；集合使用空数组，不省略字段。
- 第一版 backend 只维护一个 active backend session。已有 session 正在运行时，再用不同配置 start 应返回 `409 SESSION_ALREADY_RUNNING`。
- 成功响应直接返回领域对象；失败响应统一返回：

```ts
interface ApiErrorResponse {
  error: {
    code:
      | "SESSION_NOT_STARTED"
      | "SESSION_ALREADY_RUNNING"
      | "INVALID_MODE"
      | "INVALID_REQUEST"
      | "ARTIFACT_NOT_FOUND"
      | "PROCESS_EXITED"
      | "REPLAY_ENDED"
      | "UNSUPPORTED_IN_REPLAY"
      | "INTERNAL_ERROR";
    message: string;
    details?: unknown;
  };
}
```

通用枚举：

```ts
type BackendMode = "live" | "replay";

type AgentPhase =
  | "idle"
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

type RunStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

type TurnStatus =
  | "idle"
  | "running"
  | "waiting_for_tool"
  | "completed"
  | "failed"
  | "aborted";
```

### 5.2 Session control API

#### `POST /api/session/start`

启动或恢复一个 backend session。

请求：

```ts
interface StartSessionRequest {
  mode: BackendMode;
  cwd?: string;
  sessionId?: string;
  resume?: boolean;
  replay?: {
    logPath?: string;
    speed?: number;
    autoStart?: boolean;
  };
}
```

响应：`SessionSnapshot`。

语义：

- live mode：启动或附着一个 `pi --mode rpc` 进程。
- `resume: true` 且提供 `sessionId` 时，优先恢复已有 session；否则创建新 session。
- replay mode：加载 `replay.logPath`，默认使用 `data/sharedstate_multi_agent_cli_log.jsonl`。
- `replay.speed` 是播放倍率，默认 `1`，第一版建议支持 `0.25`、`0.5`、`1`、`2`、`4`。
- `replay.autoStart` 默认为 `true`；若为 `false`，只 hydrate 初始空状态，不开始 emit。

#### `POST /api/session/stop`

停止当前 backend session。

请求：

```ts
interface StopSessionRequest {
  force?: boolean;
  clearReplayState?: boolean;
}
```

响应：`SessionSnapshot`。

语义：

- live mode：停止 bridge 对 `pi --mode rpc` 的管理；`force: true` 时允许杀掉底层进程。
- replay mode：停止 replay timer；`clearReplayState: true` 时清空 replay hydrate 出来的 messages / agents。
- stop 不删除本地 session 文件、role-session index 或 shared-state artifact。

#### `POST /api/prompt`

向当前 session 发送用户输入。

请求：

```ts
interface PromptRequest {
  text: string;
}

interface PromptResponse {
  accepted: boolean;
  mode: BackendMode;
  turnId: string | null;
  message: string | null;
}
```

语义：

- live mode：转发给 `pi --mode rpc`，成功后返回 `accepted: true`。
- replay mode：第一版不真实执行 prompt，返回 `accepted: false`，`message` 说明当前处于 replay mode。HTTP 状态可用 `200`，避免前端把它当作网络错误。
- 未启动 session 时返回 `409 SESSION_NOT_STARTED`。

#### `POST /api/abort`

中止当前 turn。

请求：

```ts
interface AbortRequest {
  reason?: string;
}

interface AbortResponse {
  accepted: boolean;
  mode: BackendMode;
  turnId: string | null;
  message: string | null;
}
```

语义：

- live mode：转发 abort 给 RPC 进程。
- replay mode：停止当前 replay 播放，返回 `accepted: true`。
- 没有 active turn 时返回 `accepted: false`，但不视为系统错误。

### 5.3 State / messages / role sessions API

#### `GET /api/state`

返回页面刷新后 hydrate 所需的总快照。

```ts
interface SessionSnapshot {
  backendMode: BackendMode | null;
  session: {
    started: boolean;
    sessionId: string | null;
    cwd: string | null;
    pid: number | null;
    startedAt: string | null;
    stoppedAt: string | null;
  };
  turn: {
    turnId: string | null;
    status: TurnStatus;
    startedAt: string | null;
    updatedAt: string | null;
  };
  replay: {
    loaded: boolean;
    running: boolean;
    ended: boolean;
    logPath: string | null;
    speed: number | null;
    cursor: number | null;
    totalEvents: number | null;
  } | null;
  counts: {
    messages: number;
    agents: number;
    artifacts: number;
  };
  agents: AgentCard[];
  sharedState: SharedStateSummary;
}
```

未启动 session 时也返回 `200`，其中 `session.started = false`、`agents = []`、`counts = 0`。

#### `GET /api/messages`

返回主 timeline 当前可展示的消息和工具过程。

```ts
interface MessagesResponse {
  messages: TimelineMessage[];
}

interface TimelineMessage {
  id: string;
  source: "main" | "agent" | "system";
  agentId: string | null;
  role: "user" | "assistant" | "tool" | "system";
  kind: "message" | "tool_event" | "status";
  content: string;
  status: "streaming" | "completed" | "failed" | "aborted";
  createdAt: string;
  updatedAt: string;
  rawType: string | null;
}
```

说明：

- `messages` 面向 UI 展示，不要求等同底层 transcript shape。
- 需要调试时可以在开发环境额外带 `raw` 字段，但前端正式逻辑不应依赖 `raw`。

#### `GET /api/agents`

返回 agent cards 所需状态。

```ts
interface AgentsResponse {
  agents: AgentCard[];
}

interface AgentCard {
  agentId: string;
  displayName: string;
  role: string | null;
  avatar: string | null;
  phase: AgentPhase;
  activeTool: ToolSummary | null;
  completedTools: ToolSummary[];
  lastAssistantPreview: string | null;
  eventCount: number;
  recentEvents: AgentRecentEvent[];
  sessionId: string | null;
  lastRunStatus: RunStatus;
  sharedStateRoot: string | null;
  updatedAt: string | null;
}

interface ToolSummary {
  toolCallId: string | null;
  name: string;
  status: "running" | "completed" | "failed" | "aborted";
  argsSummary: string | null;
  resultSummary: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

interface AgentRecentEvent {
  id: string;
  type: string;
  summary: string;
  createdAt: string;
}
```

说明：

- `phase` 只使用 `AgentPhase` 枚举，前端不解析底层事件名。
- `activeTool` 使用对象而不是字符串，方便展示 tool 名、参数摘要和运行时间。
- `recentEvents` 默认保留最近 10 条；agent card 默认只展示前 1~3 条。
- `lastAssistantPreview` 来自该 agent 最近一次 assistant/result summary，backend 负责截断到适合卡片展示的长度。

#### `GET /api/role-sessions`

返回 role-session index 的 UI 友好视图。

```ts
interface RoleSessionsResponse {
  roleSessions: RoleSessionView[];
}

interface RoleSessionView {
  role: string;
  agentId: string;
  displayName: string;
  sessionId: string | null;
  status: "idle" | "running" | "closed" | "unknown";
  currentRunId: string | null;
  sharedStateRoot: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}
```

### 5.4 Shared State / artifact API

#### `GET /api/shared-state/manifest`

返回 shared-state manifest 的 UI 友好视图。

```ts
interface SharedStateManifestResponse {
  root: string | null;
  artifacts: SharedStateArtifactEntry[];
}

interface SharedStateSummary {
  root: string | null;
  artifacts: SharedStateArtifactEntry[];
  updatedAt: string | null;
}

interface SharedStateArtifactEntry {
  path: string;
  space: string | null;
  ownerAgentId: string | null;
  version: number | string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  sizeBytes: number | null;
  mimeType: string | null;
  metadata: Record<string, unknown>;
}
```

#### `GET /api/shared-state/artifact?path=...`

返回 artifact 内容和 manifest metadata。

```ts
interface SharedStateArtifactResponse {
  path: string;
  artifact: SharedStateArtifactEntry | null;
  content: ArtifactContent;
}

type ArtifactContent =
  | {
      kind: "text";
      text: string;
      sizeBytes: number;
      mimeType: string | null;
      truncated: boolean;
    }
  | {
      kind: "json";
      json: unknown;
      text: string;
      sizeBytes: number;
      mimeType: string | null;
      truncated: boolean;
    }
  | {
      kind: "binary-unsupported";
      sizeBytes: number;
      mimeType: string | null;
      truncated: false;
    };
```

说明：

- 第一版只需要稳定支持 text / json artifact。
- 内容过大时允许 `truncated: true`，但必须返回真实 `sizeBytes`。
- path 不存在时返回 `404 ARTIFACT_NOT_FOUND`。
- binary 文件不直接返回原始字节，避免浏览器误渲染或 SSE/JSON 体积失控。

#### `GET /api/shared-state/search?query=...`

可选接口，第一版可以不实现。若实现，返回：

```ts
interface SharedStateSearchResponse {
  query: string;
  results: Array<{
    path: string;
    preview: string;
    line: number | null;
    artifact: SharedStateArtifactEntry | null;
  }>;
}
```

### 5.5 SSE event contract

`GET /api/events` 使用原生 SSE。每条事件都必须使用统一 envelope：

```ts
type SseEventType =
  | "session.started"
  | "session.stopped"
  | "message.delta"
  | "message.completed"
  | "tool.started"
  | "tool.updated"
  | "tool.completed"
  | "agent.updated"
  | "shared_state.changed"
  | "replay.started"
  | "replay.completed"
  | "error";

interface SseEnvelope<TPayload> {
  eventId: string;
  eventType: SseEventType;
  mode: BackendMode;
  sessionId: string | null;
  turnId: string | null;
  sequence: number;
  createdAt: string;
  payload: TPayload;
}
```

发送格式：

```text
event: agent.updated
id: <eventId>
data: {"eventId":"...","eventType":"agent.updated",...}
```

主要 payload：

```ts
interface MessageDeltaPayload {
  messageId: string;
  role: "assistant" | "user" | "system";
  source: "main" | "agent" | "system";
  agentId: string | null;
  delta: string;
}

interface MessageCompletedPayload {
  message: TimelineMessage;
}

interface ToolEventPayload {
  toolCallId: string;
  toolName: string;
  agentId: string | null;
  status: "running" | "completed" | "failed" | "aborted";
  argsSummary: string | null;
  resultSummary: string | null;
}

interface AgentUpdatedPayload {
  agent: AgentCard;
  changedFields: string[];
}

interface SharedStateChangedPayload {
  paths: string[];
  reason:
    | "run_subagent_completed"
    | "shared_state_write"
    | "shared_state_edit"
    | "manual_refresh"
    | "replay_event";
}

interface ReplayPayload {
  logPath: string;
  cursor: number;
  totalEvents: number;
  speed: number;
}

interface ErrorPayload {
  code: ApiErrorResponse["error"]["code"];
  message: string;
  details?: unknown;
}
```

SSE 语义：

- `sequence` 在单个 backend session 内单调递增。
- 前端重连后应先调用 `GET /api/state` hydrate，再继续消费新的 SSE；第一版不要求 backend 根据 `Last-Event-ID` 补发历史事件。
- replay 播放到末尾时发送 `replay.completed`，并保持 `session.started = true`、`replay.ended = true`，直到用户 stop/reset。
- live/replay 都应尽量 emit `agent.updated`，让前端不必理解底层 `run_subagent` 事件细节。

### 5.6 Replay control API

普通前端闭环只需要使用 `/api/session/start` 和 `/api/session/stop`。如果要做 replay 控件，第一版补充两个 replay 专用接口：

#### `POST /api/replay/reset`

```ts
interface ReplayResetRequest {
  autoStart?: boolean;
}
```

响应：`SessionSnapshot`。

语义：重置 replay cursor、messages、agents，并按 `autoStart` 决定是否重新播放。

#### `POST /api/replay/speed`

```ts
interface ReplaySpeedRequest {
  speed: number;
}
```

响应：`SessionSnapshot`。

语义：修改后续 replay 事件 emit 速度。非 replay mode 调用返回 `409 INVALID_MODE`。

第一版暂不要求 pause / resume / seek / step-by-step；后续若增加，必须保持不影响普通 live UI contract。

### 5.7 空态和错误语义

- backend 刚启动、session 未 start：
  - `GET /api/state` 返回 `200` + 空快照。
  - `GET /api/messages` 返回 `200 { messages: [] }`。
  - `GET /api/agents` 返回 `200 { agents: [] }`。
  - `GET /api/shared-state/manifest` 在无法定位 root 时返回 `200 { root: null, artifacts: [] }`。
  - `POST /api/prompt` 返回 `409 SESSION_NOT_STARTED`。
- replay 已结束：
  - `GET /api/state` 返回 `replay.ended = true`。
  - 再次 `POST /api/prompt` 仍按 replay mode 语义返回 `accepted: false`。
  - 用户可调用 `/api/replay/reset` 重新播放。
- live 进程异常退出：
  - SSE 发送 `error`，code 为 `PROCESS_EXITED`。
  - `GET /api/state` 应反映 `turn.status = failed` 或 `aborted`，并保留已有 messages / agents 便于排查。

---

## 6. Shared State / role-session 读取策略

### Shared State source of truth
后端应直接读取：
- `FileSharedStateManifest`
- shared-state root 下的真实文件

不要只靠事件流重建当前共享状态。

### role-session source of truth
后端应直接读取：
- `FileRoleSessionIndex`

这样前端才能知道：
- 哪些 role 已存在
- 哪些 role 当前 idle / running / closed
- 它们对应哪个 sub-agent session

---

## 7. Replay backend 设计建议

### 为什么日志回放可行
`data/sharedstate_multi_agent_cli_log.jsonl` 已经包含：
- main message 流
- `tool_execution_start/update/end`
- `run_subagent` compact progress
- shared-state 相关路径级线索

足够驱动：
- main timeline
- agent cards
- 路径级 artifact awareness

### 但 replay backend 不能只是逐行 print
应实现一个轻量 replay engine：
- 读取 JSONL
- 解析事件
- 可控节奏 emit
- 对外暴露统一 SSE
- 维护当前 state/messages/agents 的 hydrate 快照

### replay backend 的第一版建议
至少支持：
- start replay
- stop replay
- reset replay
- fixed speed replay

如果后面需要，再补：
- pause / resume
- seek
- step-by-step

---

## 8. 实现阶段

### Stage 1 — backend skeleton
目标：先定义 contract，不急着做复杂逻辑

实现：
- HTTP server
- SSE endpoint
- session state 容器
- mode abstraction（live/replay）

### Stage 2 — replay backend first
目标：让前端能最快联调

实现：
- 加载 `data/sharedstate_multi_agent_cli_log.jsonl`
- emit SSE
- hydrate `state/messages/agents`
- 如有可能配套 static shared-state snapshot

### Stage 3 — live backend
目标：接入真实 pi runtime

实现：
- spawn / manage `pi --mode rpc`
- prompt / abort / get_state / get_messages
- RPC event -> SSE
- shared-state manifest + artifact read API

### Stage 4 — product hardening
目标：变成真正可用，而不是能跑而已

实现：
- reconnect / resume
- process lifecycle recovery
- error handling
- replay/live 模式切换一致性
- state hydration correctness

---

## 9. 验收标准

### 功能验收
1. live mode 能驱动前端完整工作流。
2. replay mode 能驱动前端完整联调。
3. `GET /api/shared-state/manifest` 和 artifact API 能稳定返回正确内容。
4. `GET /api/agents` 能稳定表达角色当前状态。
5. SSE 事件流在两种模式下 shape 一致。

### 工程验收
1. 前端无须区分 live/replay 模式。
2. Shared State 面板的数据来自 manifest/file，而不是前端事件重建。
3. role-session / lifecycle 信息可稳定读取。
4. backend 能处理会话启动、停止、刷新、异常退出等常见场景。

---

## 10. 当前不做

第一版后端明确不做：
- 新 scheduler
- 新 event bus
- 新 multi-agent runtime
- 强一致跨进程锁/merge
- 直接修改 shared-state 文件的写 API
- GUI 特定布局逻辑
- 权限系统后台

后端的职责是：
> 把现有多 agent 基础组件以产品方式暴露出去

而不是重写它们。