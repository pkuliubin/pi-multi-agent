# Phase 7 Plan：run_subagent Streaming Observability

## Summary

Phase 7 的目标是在不引入 scheduler、Bus、GUI 多 runtime 或 sub-agent 直接用户交互的前提下，让 `run_subagent` 可以把 sub-agent 内部进度作为 tool streaming update 暴露出来。

核心思路：sub-agent 本身仍然是独立 `AgentSession`，继续 emit 与主 agent loop 相同的事件；`RunSubAgentRunner` 只做事件 envelope 包装；`run_subagent` tool 把高价值事件转成现有 `tool_execution_update`，让 TUI/CLI/RPC 复用当前 tool streaming 机制展示进度。

## Design

### 1. 事件语义保持一致

sub-agent 内部事件沿用现有 agent loop 事件：

```text
agent_start
message_start
message_update
message_end
tool_execution_start
tool_execution_update
tool_execution_end
agent_end
```

不新增一套 sub-agent 专用事件语义。桥接时只加 envelope：

```ts
interface SubAgentEventEnvelope {
  source: "subagent";
  agentId: string;
  sessionId: string;
  invocationId?: string;
  parentToolCallId?: string;
  event: AgentSessionLikeEvent;
}
```

这保证未来 GUI / RPC / debug timeline 可以复用现有 agent event 模型。

### 2. 不把 sub-agent 事件混入主 agent timeline

主 agent 事件和 sub-agent 事件不能作为同级事件直接混流。sub-agent 事件必须带 namespace/envelope，否则 UI 无法区分：

```text
主 agent assistant message
sub-agent assistant message
主 agent tool call
sub-agent tool call
```

Phase 7 的事件桥接只用于 observability，不改变调度，不把 sub-agent 内部 messages 写入主 session。

### 3. 最小展示路径：复用 tool streaming update

`run_subagent` 本身就是主 agent 的一个 tool。第一版不改 TUI 主事件模型，而是把 sub-agent 进度映射成 `run_subagent` 的 streaming tool output：

```text
主 agent 调用 run_subagent
  -> tool_execution_start(run_subagent)
  -> sub-agent 内部事件
  -> run_subagent onUpdate(...)
  -> tool_execution_update(run_subagent)
  -> tool_execution_end(run_subagent)
```

TUI 现有 `ToolExecutionComponent` 已支持 tool update，因此第一版不需要新增 TUI 事件类型。

### 4. 展示过滤策略

第一版不直接展示所有 sub-agent token stream，避免输出过吵。建议展示高价值事件：

```text
agent_start
tool_execution_start
tool_execution_end
message_end（assistant final text preview）
agent_end
```

默认不展示或仅放入 details：

```text
message_update
thinking
大体积 tool_result
```

示例展示：

```text
pm-agent-v2 started
pm-agent-v2 shared_state.read started
pm-agent-v2 shared_state.read completed
pm-agent-v2 shared_state.write started
pm-agent-v2 shared_state.write completed
pm-agent-v2 completed
```

## Implementation Sketch

### RunSubAgentRunner

增加可选事件回调，不改变现有调度：

```ts
runner.run(input, {
  onEvent(envelope) {
    // receives namespaced sub-agent events
  }
})
```

或等价地在 `RunSubAgentInput` / runner options 中传入 callback。runner 在 invoke 前订阅 instance：

```ts
const unsubscribe = instance.subscribe((event) => {
  onEvent?.({
    source: "subagent",
    agentId: definition.id,
    sessionId: instance.session.sessionId,
    invocationId: input.invocationId,
    event,
  });
});
try {
  return await instance.invoke(task);
} finally {
  unsubscribe();
}
```

### run_subagent tool

使用现有 tool `onUpdate` 参数：

```ts
async execute(toolCallId, params, signal, onUpdate, ctx) {
  const events: SubAgentEventEnvelope[] = [];
  const result = await runner.run(params, {
    onEvent(event) {
      events.push(event);
      onUpdate?.({
        content: [{ type: "text", text: formatProgress(events) }],
        details: { events: compactEvents(events) },
      });
    },
  });
  return finalResult;
}
```

`details.events` 应使用 rolling buffer 或 compact form，避免无限增长。

### TUI / CLI

第一版不改 TUI。TUI 会把这些 update 当成 `run_subagent` tool 的流式输出。

后续如果需要更好的展示，再为 `run_subagent` 增加 custom renderer，例如按 agent/tool 分组显示。

## Test Plan

- `RunSubAgentRunner` 单元测试：sub-agent `message_end` / `tool_execution_start` / `tool_execution_end` 会被包装成 `SubAgentEventEnvelope`。
- `run_subagent` tool 测试：执行期间会调用 `onUpdate`，且 final tool result 不变。
- 并发测试：两个 sub-agent 并行时，各自 event envelope 包含正确 `agentId/sessionId/invocationId`。
- resume 测试：恢复的 sub-agent session 产生的 event envelope 使用原 sessionId。
- TUI 不需要专门改动；可用现有 tool streaming 行为做 smoke。

## Non-goals

```text
- 不做正式 SubAgent event bus
- 不改主 agent event schema
- 不把 sub-agent 内部 messages 写入主 session
- 不做 GUI timeline
- 不做 sub-agent direct chat / ask_user
- 不做 scheduler / queue / Bus / activation signal
```

## Acceptance Criteria

- `run_subagent` 执行时能看到 sub-agent 进度 streaming update。
- 主 agent session 仍只保存 `run_subagent` tool call/result，不保存 sub-agent 内部完整 messages。
- sub-agent 完整 trace 仍保存在自己的持久 session file。
- 结构化 details 中能区分不同 sub-agent 的事件来源。
- 现有 Phase 6 persistent/resume 行为不受影响。
