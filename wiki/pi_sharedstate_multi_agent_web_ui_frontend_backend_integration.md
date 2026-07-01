# Shared State Multi-Agent Web UI 前后端联调指南

## 1. 目标

本文档说明前端如何基于当前 `packages/web-backend` 开始联调。

当前后端已经支持：

- replay mode：读取 `data/sharedstate_multi_agent_cli_log.jsonl`，模拟真实多 agent 过程流。
- live mode：通过 `pi --mode rpc` 连接真实运行时，可调用真实 LLM，并已支持 run_subagent agent cards 与 shared-state 事件。
- mock engine 自动化测试：用于后端测试 HTTP contract，不是一个可直接启动的开发模式。

前端第一阶段建议优先使用 **replay mode** 联调，因为它：

- 不依赖真实 LLM；
- 不消耗 API token；
- 输出稳定；
- 能覆盖 main timeline、agent cards、SSE、hydrate、replay controls 等核心链路。

---

## 2. 模式说明

| 模式 | 是否可运行 | 是否可交互 prompt | 是否调用真实 LLM | 适合用途 |
|---|---:|---:|---:|---|
| replay mode | 是 | 否，`prompt` 返回 `accepted: false` | 否 | 前端过程流、agent cards、timeline、hydrate 联调 |
| live mode | 是 | 是 | 是 | 真实单轮/多轮验收 |
| test mock engine | 仅测试内 | 是 | 否 | 后端自动化 contract 测试 |
| dev mock mode | 暂无 | 未来应支持 | 否 | 前端输入框 deterministic 联调 |

注意：

- 本文说的“mock API 联调”，当前实际推荐使用 **replay mode**。
- 后端测试里的 mock engine 已验证 contract，但没有暴露为 `npm run mock` 之类的开发服务器。
- 如果前端需要“输入 prompt 后收到固定 mock assistant 回复”，需要后续补一个 dev mock mode。

---

## 3. 启动后端

从仓库根目录执行：

```bash
npm --prefix packages/web-backend run dev
```

如果要在 live mode 测真实多 agent / shared-state 链路，需要启用正式 `run_subagent` 工具：

```bash
PI_MULTI_AGENT_RUN_SUBAGENT=1 npm --prefix packages/web-backend run dev
```

默认地址：

```text
http://127.0.0.1:8787
```

可选环境变量：

```bash
PI_WEB_BACKEND_HOST=127.0.0.1
PI_WEB_BACKEND_PORT=8787
```

---

## 4. 前端初始化 hydrate 流程

页面首次加载或刷新时，前端应先通过 HTTP 拉取当前快照，再连接 SSE。

推荐请求：

```http
GET /api/state
GET /api/messages
GET /api/agents
GET /api/shared-state/manifest
GET /api/role-sessions
```

未启动 session 时，后端返回空态，而不是错误。

示例：

```json
{
  "backendMode": null,
  "session": {
    "started": false,
    "sessionId": null
  },
  "turn": {
    "turnId": null,
    "status": "idle"
  },
  "counts": {
    "messages": 0,
    "agents": 0,
    "artifacts": 0
  },
  "agents": [],
  "sharedState": {
    "root": null,
    "artifacts": [],
    "updatedAt": null
  }
}
```

前端 store 建议：

```ts
async function hydrate() {
  const [state, messages, agents, manifest, roleSessions] = await Promise.all([
    api.getState(),
    api.getMessages(),
    api.getAgents(),
    api.getSharedStateManifest(),
    api.getRoleSessions(),
  ]);

  store.setState({
    uiSession: {
      backendMode: state.backendMode,
      connected: false,
      inputPending: false,
      errorBanner: null,
    },
    mainTimeline: messages.messages,
    agentsById: indexByAgentId(agents.agents),
    sharedState: {
      manifest: manifest.artifacts,
      selectedArtifactPath: null,
      artifactContentByPath: {},
    },
    roleSessions: roleSessions.roleSessions,
  });
}
```

---

## 5. 启动 replay mode

### 5.1 curl 示例

```bash
curl -X POST http://127.0.0.1:8787/api/session/start \
  -H "content-type: application/json" \
  -d '{
    "mode": "replay",
    "replay": {
      "autoStart": true,
      "speed": 4
    }
  }'
```

默认 replay log：

```text
data/sharedstate_multi_agent_cli_log.jsonl
```

### 5.2 前端示例

```ts
await fetch("/api/session/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    mode: "replay",
    replay: {
      autoStart: true,
      speed: 4,
    },
  }),
});
```

启动后，前端可以继续调用：

```http
GET /api/state
GET /api/messages
GET /api/agents
```

也可以直接依赖 SSE 增量更新 UI。

---

## 6. SSE 连接与事件消费

SSE endpoint：

```http
GET /api/events
```

前端示例：

```ts
const source = new EventSource("/api/events");

source.addEventListener("message.delta", (event) => {
  const envelope = JSON.parse(event.data);
  store.appendMessageDelta(envelope.payload);
});

source.addEventListener("message.completed", (event) => {
  const envelope = JSON.parse(event.data);
  store.upsertTimelineMessage(envelope.payload.message);
});

source.addEventListener("agent.updated", (event) => {
  const envelope = JSON.parse(event.data);
  store.upsertAgent(envelope.payload.agent);
});

source.addEventListener("shared_state.changed", async () => {
  const manifest = await api.getSharedStateManifest();
  store.setSharedStateManifest(manifest.artifacts);
});

source.addEventListener("replay.completed", () => {
  store.setReplayEnded(true);
});

source.addEventListener("error", (event) => {
  const envelope = JSON.parse(event.data);
  store.setErrorBanner(envelope.payload.message);
});
```

SSE envelope 统一格式：

```ts
interface SseEnvelope<TPayload> {
  eventId: string;
  eventType:
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
  mode: "live" | "replay";
  sessionId: string | null;
  turnId: string | null;
  sequence: number;
  createdAt: string;
  payload: TPayload;
}
```

说明：

- `sequence` 在单个 backend 进程内递增。
- 第一版不要求 backend 根据 `Last-Event-ID` 补发历史事件。
- 前端重连后应先重新 hydrate，再继续消费新的 SSE。
- 前端收到 `shared_state.changed`、`message.completed`、`replay.completed`、`session.stopped` 后，建议做一次短延迟/节流的全量 refresh，重新拉取 `state/messages/agents/manifest`。
- `shared_state.changed.payload.paths.length === 0` 表示粗粒度变更，前端应清空本地 artifact content cache，并刷新 manifest。

### 6.1 TimelineMessage 结构化 tool 字段

`GET /api/messages` 和 `message.completed` 中的 `TimelineMessage` 现在包含结构化 tool 字段：

```ts
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
  toolName: string | null;
  toolCallId: string | null;
}
```

run_subagent 的 tool result 可直接这样判断，不再需要从 `content` 里猜：

```bash
curl -sS http://127.0.0.1:8787/api/messages \
  | jq '.messages[] | select(.kind=="tool_event" and .toolName=="run_subagent") | {toolName, toolCallId, agentId, status}'
```

预期：

- `toolName: "run_subagent"`
- `rawType: "run_subagent"`
- `toolCallId` 为真实 tool call id
- `agentId` 为 `pm-agent-v2` / `engineering-agent-v2` / `synthesis-agent-v2`
- `source: "agent"`

---

## 7. Replay 控制接口

### 7.1 修改速度

```bash
curl -X POST http://127.0.0.1:8787/api/replay/speed \
  -H "content-type: application/json" \
  -d '{"speed": 20}'
```

前端：

```ts
await fetch("/api/replay/speed", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ speed: 20 }),
});
```

### 7.2 重置 replay

```bash
curl -X POST http://127.0.0.1:8787/api/replay/reset \
  -H "content-type: application/json" \
  -d '{"autoStart": true}'
```

前端：

```ts
await fetch("/api/replay/reset", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ autoStart: true }),
});
```

### 7.3 停止 session

```bash
curl -X POST http://127.0.0.1:8787/api/session/stop \
  -H "content-type: application/json" \
  -d '{}'
```

---

## 8. Prompt 在 replay/live 下的差异

### replay mode

```http
POST /api/prompt
```

请求：

```json
{
  "text": "hello"
}
```

响应：

```json
{
  "accepted": false,
  "mode": "replay",
  "turnId": "...",
  "message": "Prompt execution is disabled in replay mode."
}
```

说明：

- replay mode 不真实执行用户输入。
- 前端可以把输入框接上，但 UI 应提示当前处于 replay，不会执行 prompt。

### live mode

live mode 会通过 `pi --mode rpc` 调真实 LLM。

请求：

```json
{
  "text": "请只回复：hello"
}
```

响应：

```json
{
  "accepted": true,
  "mode": "live",
  "turnId": "live-turn-...",
  "message": null
}
```

说明：

- `accepted: true` 只表示 RPC preflight 接受了 prompt。
- 最终回复通过 SSE 和 `/api/messages` 获取。
- turn 完成后，`GET /api/state` 中 `turn.status` 会变为 `completed`。

---

## 9. Live mode 启动示例

live mode 适合后端真实验收，不建议作为前端第一阶段默认联调模式。

启动后端时需要：

```bash
PI_MULTI_AGENT_RUN_SUBAGENT=1 npm --prefix packages/web-backend run dev
```

示例：

```bash
curl -X POST http://127.0.0.1:8787/api/session/start \
  -H "content-type: application/json" \
  -d '{
    "mode": "live",
    "cwd": "/Users/liubin/Projects/pi-multi-agent",
    "live": {
      "cliPath": "/Users/liubin/Projects/pi-multi-agent/packages/coding-agent/dist/cli.js",
      "provider": "deepseek",
      "model": "deepseek-v4-flash",
      "args": ["--no-session", "--thinking", "off"]
    }
  }'
```

前端若要支持 live mode，可以使用同一套 API client，不需要区分 response shape。

---

## 10. Shared State / artifacts 联调

### 10.1 拉取 manifest

```http
GET /api/shared-state/manifest
```

响应：

```ts
interface SharedStateManifestResponse {
  root: string | null;
  artifacts: SharedStateArtifactEntry[];
}
```

### 10.2 拉取 artifact 内容

```http
GET /api/shared-state/artifact?path=summary/final.md
```

响应：

```ts
interface SharedStateArtifactResponse {
  path: string;
  artifact: SharedStateArtifactEntry | null;
  content:
    | { kind: "text"; text: string; sizeBytes: number; mimeType: string | null; truncated: boolean }
    | { kind: "json"; json: unknown; text: string; sizeBytes: number; mimeType: string | null; truncated: boolean }
    | { kind: "binary-unsupported"; sizeBytes: number; mimeType: string | null; truncated: false };
}
```

安全规则：

- 前端只能传相对 artifact path。
- 不允许绝对路径。
- 不允许 `..` path traversal。
- live mode 下，`shared_state_write/edit` 会发 path-level `shared_state.changed`；`run_subagent` 完成会发 `paths: []` 的粗粒度刷新事件。

---

## 11. 前端 store 映射建议

建议至少分为 4 个 slice。

### 11.1 `mainTimeline`

来源：

- `GET /api/messages`
- SSE `message.delta`
- SSE `message.completed`
- SSE `tool.started/updated/completed`

### 11.2 `agentsById`

来源：

- `GET /api/agents`
- SSE `agent.updated`

### 11.3 `sharedState`

来源：

- `GET /api/shared-state/manifest`
- `GET /api/shared-state/artifact?path=...`
- SSE `shared_state.changed` 后主动刷新 manifest

### 11.4 `uiSession`

来源：

- `GET /api/state`
- SSE `session.started`
- SSE `session.stopped`
- SSE `replay.completed`
- SSE `error`

---

## 12. 当前已验证情况

### 12.1 自动化测试

已通过：

```bash
npx tsgo --noEmit
npm --prefix packages/web-backend run test
npm --prefix packages/web-ui run check
```

结果：

```text
Typecheck passed
web-backend: 6 test files passed, 16 tests passed
web-ui: build passed, 4 test files passed, 15 tests passed
```

覆盖：

- empty state
- prompt before start error
- mock live start/prompt/abort/stop
- mock messages/agents/role-sessions/manifest/artifact
- mock replay reset/speed
- path safety
- replay JSONL parser
- session store counts
- live run_subagent -> AgentCard / `agent.updated`
- live run_subagent -> `shared_state.changed`
- live shared_state_write/edit path-level change
- live agent_end failed/aborted/completed status mapping
- replay sample log regression
- run_subagent timeline message structured fields

### 12.2 replay smoke

已验证：

- replay start
- replay speed
- replay completed
- hydrate messages
- hydrate agent cards
- `agent.updated`
- `shared_state.changed`
- run_subagent timeline tool messages

样例 replay 完成后可得到：

```text
agents: 3
agentIds:
- pm-agent-v2
- engineering-agent-v2
- synthesis-agent-v2
```

### 12.3 live DeepSeek smoke

已验证：

- live session start
- DeepSeek `deepseek-v4-flash`
- 单轮 prompt
- 多轮 prompt
- `/api/messages`
- `/api/state.turn.status = completed`
- live 多 agent
- `/api/agents` 返回 3 个 completed agent cards
- `/api/shared-state/manifest` 返回真实 artifacts
- `/api/shared-state/artifact?path=...` 可读取真实内容

多轮测试中，同一个 session 能记住上一轮 token：

```text
pi-web-backend-memory-token
```

---

## 13. 当前限制与后续建议

### 当前限制

1. replay mode 不能真实执行 prompt。
2. dev mock mode 尚未实现。
3. SSE 第一版不支持 `Last-Event-ID` 历史补发。
4. live mode 会消耗真实 LLM token。
5. Shared State manifest/artifact 依赖后端能定位 shared-state root；无法定位时返回空 manifest。
6. live mode 的真实多 agent 链路依赖 `PI_MULTI_AGENT_RUN_SUBAGENT=1` 和可用 provider/model。

### 建议后续补充

建议增加一个真正的 dev mock mode：

```json
{
  "mode": "mock"
}
```

能力：

- `POST /api/prompt` 返回 `accepted: true`；
- backend 模拟 assistant streaming；
- backend 模拟 2-3 个 agent cards 更新；
- backend 提供固定 artifacts；
- 不依赖 replay log；
- 不调用真实 LLM。

这样前端可以完整联调输入框、pending 状态、timeline streaming、agent cards、artifact refresh，而无需真实 token。

---

## 14. 前端第一阶段推荐联调顺序

1. 接 HTTP client。
2. 实现页面初始化 hydrate。
3. 启动 replay mode。
4. 接 SSE。
5. 显示 main timeline。
6. 显示 agent cards。
7. 接 replay speed/reset。
8. 接 shared-state manifest/artifact。
9. 最后再接 live prompt。

推荐不要一开始就用 live mode 做 UI 联调；先用 replay mode 把状态流和布局打通，再用 live mode 做真实验收。
