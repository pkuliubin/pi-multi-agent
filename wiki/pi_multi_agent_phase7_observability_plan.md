# Phase 7 Plan：run_subagent 事件桥接式 Observability

## Summary

Phase 7 收敛为“事件桥接式 observability”：把 sub-agent 内部高价值事件通过 `run_subagent` 的现有 tool streaming update 暴露出来，让 TUI/CLI/RPC 复用当前工具流式展示能力。

这不是新的 event system、不是 Bus、不是 scheduler，也不是 sub-agent direct chat。

核心原则：

```text
- run_subagent streaming update 不是 source of truth。
- 完整 trace 仍以 sub-agent 自己的持久 session file 为准。
- bridge 是 best-effort observability only。
- observer / onUpdate 失败不能影响 runner correctness、ordering 或 final result。
- 不把 sub-agent 内部 events 混入主 agent timeline。
- 不改变主 session 存储语义。
```

## Design

### 1. 事件语义保持一致，只加 envelope

sub-agent 内部事件沿用现有 agent loop 事件，不新增一套 sub-agent 专用事件语义。桥接时只加 envelope：

```ts
interface SubAgentEventEnvelope {
  source: "subagent";
  agentId: string;
  sessionId: string;
  invocationId?: string;
  event: AgentSessionLikeEvent;
}
```

Phase 7 的事件桥接只用于 observability，不改变调度，不把 sub-agent 内部 messages 写入主 session。

### 2. 最小展示路径：复用 tool streaming update

`run_subagent` 本身就是主 agent 的一个 tool。第一版不改 TUI 主事件模型，而是把 sub-agent 进度映射成 `run_subagent` 的 streaming tool output：

```text
主 agent 调用 run_subagent
  -> tool_execution_start(run_subagent)
  -> sub-agent 内部事件
  -> run_subagent onUpdate(...)
  -> tool_execution_update(run_subagent)
  -> tool_execution_end(run_subagent)
```

TUI 现有 tool streaming 机制负责展示这些 update。后续如果需要更好的 UI，再为 `run_subagent` 增加 custom renderer。

### 3. 展示过滤策略

第一版只展示高价值事件：

```text
agent_start
tool_execution_start
tool_execution_end
message_end（assistant final text preview）
agent_end
```

不展示：

```text
message_update
thinking
token stream
大体积 tool result body
```

### 4. Compact progress summary

`run_subagent` update 每次发送完整“当前摘要快照”，不是无限追加日志。若连续事件投影后的 progress snapshot 无变化，不重复发送 update。

progress summary 固定形态：

```ts
interface RunSubAgentProgressSummary {
  currentPhase: "starting" | "running" | "completed" | "failed" | "aborted";
  activeTool?: { toolName: string; toolCallId: string };
  completedTools: Array<{ toolName: string; toolCallId: string; isError?: boolean }>;
  lastAssistantPreview?: string;
  eventCount: number;
  recentEvents: CompactSubAgentEvent[];
}
```

`recentEvents` 默认保留最近 8 条压缩事件，不保存原始 agent loop event。当前实现允许在压缩事件里保留受控的 tool 可观测字段，方便 TUI / Web UI 展开查看具体工具执行：

```ts
type CompactSubAgentEvent =
  | { type: "agent_start" | "agent_end"; timestamp: number }
  | {
      type: "tool_execution_start" | "tool_execution_end";
      toolName: string;
      toolCallId: string;
      timestamp: number;
      argsSummary?: string;
      resultSummary?: string;
      args?: unknown;
      result?: unknown;
      isError?: boolean;
    }
  | { type: "message_end"; preview: string; fullText?: string; timestamp: number };
```

说明：`args/result/fullText` 不是 source of truth，也不是完整审计日志；它们只是为了当前 UI 可观测性提供的受控投影。完整 trace 仍以 sub-agent 自己的持久 session file 为准。

`currentPhase` 状态规则：

```text
初始为 starting。
收到 agent_start 后保持 starting。
收到第一个 tool start/end 或 assistant message_end 后变为 running。
final SubAgentResult.status === completed 后为 completed。
final SubAgentResult.status === failed 后为 failed。
final SubAgentResult.status === aborted 后为 aborted。
```

`SUB_AGENT_BUSY` 这类未 acquire run 的路径不产生 sub-agent internal event，但 `run_subagent` tool 可以发送一次简短 progress snapshot，表示该调用在 acquire 前以 busy 结束。

## Implementation Plan

### RunSubAgentRunner

增加每次调用级别的 observer：

```ts
runner.run(input, {
  onEvent(envelope) {
    // best-effort observability only
  },
});
```

runner 在 invoke 前订阅 instance：

```ts
const unsubscribe = instance.subscribe((event) => {
  observeSubAgentEventBestEffort(onEvent, {
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

observer 调用必须被 `try/catch` 隔离；Promise reject 也必须被吞掉或隔离，不影响执行。

### run_subagent tool

`run_subagent` tool 使用 `onUpdate` 把 envelope 投影为 compact progress summary：

```text
onEvent(envelope)
  -> project high-value event
  -> update summary
  -> if snapshot changed: onUpdate({ content, details: { progress } })
```

final tool result 保持现有 `result/sharedStateRoot/definitionSource`，额外带 `progress` summary。完整 trace 不进入 details；details 中的 tool args/result 只作为 UI 展开的当前投影。

## Phase 7 实现结果

Phase 7 已完成第一版 `run_subagent` 事件桥接式 observability，重点不是引入新的事件系统，而是把 sub-agent 内部高价值事件投影为现有 tool streaming update：

```text
- runner 侧支持 RunSubAgentRunner.run(input, { onEvent })
- sub-agent session 事件被包装成 SubAgentEventEnvelope
- observer 调用是 best-effort：sync throw / async reject 都不会影响 runner correctness 或 final result
- invoke 完成、失败、timeout 路径都会 unsubscribe
- run_subagent tool 使用现有 onUpdate 发出 progress snapshot
```

### 当前 progress summary 结构

当前 `tool_execution_update.partialResult.details.progress` 包含：

```text
- currentPhase
- activeTool
- completedTools
- lastAssistantPreview
- eventCount
- recentEvents
```

其中 `recentEvents` 保存压缩后的高价值事件：

```text
agent_start / agent_end
tool_execution_start / tool_execution_end
message_end preview
```

并已补充轻量摘要字段：

```text
tool_execution_start:
  argsSummary

tool_execution_end:
  resultSummary (默认截断到前 100 个字符)
```

为了让用户能看到具体 sub-agent tool 执行，当前压缩事件也会保留 tool `args/result` 与 assistant `fullText` 的投影字段，供 Web UI agent detail 展开。这个选择是产品体验上的折中：优先保证可观测性，同时用 rolling window 控制事件数量。

### 当前展示语义

- TUI 中，`run_subagent` tool block 会在执行过程中持续刷新 progress snapshot。
- CLI `--mode json` 中，可以看到 `tool_execution_start / tool_execution_update / tool_execution_end`，其中 `partialResult.details.progress` 是 compact summary。
- 普通 CLI text mode 仍以最终输出为主，不保证像 TUI 一样逐步刷新展示。

### 边界与约束

```text
- progress update 不是 source of truth；完整 trace 仍以 sub-agent 自己的 session file 为准
- recentEvents 不保存原始 agent loop event 或 partialResult 大对象
- recentEvents 当前可包含 tool args/result 与 assistant fullText 的投影字段，用于 UI 可观测性；完整 trace 仍以 sub-agent session file 为准
- 相同 progress snapshot 不重复发送 update
- SUB_AGENT_BUSY 不产生 sub-agent internal event，但会生成 failed/busy progress summary
- 主 session 仍只保存 run_subagent tool result，不保存 sub-agent 内部完整 messages/tool results
```

### Web UI / Web Backend 现状

当前 Web 演示链路已接入 Phase 7 progress：

```text
sub-agent event
  -> run_subagent progress snapshot
  -> main session tool_execution_update
  -> web-backend reduceRunSubagentProgress()
  -> SSE agent.updated
  -> web-ui agent card / agent detail
```

`packages/web-backend` 会把 `run_subagent` progress 归约成 `AgentCard`、agent history 和 shared-state refresh signal。`packages/web-ui` 已能展示 agent card、active tool、completed tools、assistant preview，并在 detail panel 中展开工具 args/result。

这条 Web 链路是 demo / bridge 层，不是 multi-agent 底层必须依赖的正式 UI 形态。未来如果做替代 TUI 的桌面 GUI，可以直接接 Pi runtime / session API / role-session index，不一定复用当前 HTTP + SSE web-backend。

### 当前已知打磨项

这些不是 Phase 7 blocker：

```text
- Web backend 当前从 rolling recentEvents 生成 agent history；长任务下建议后续给 CompactSubAgentEvent 增加稳定 id，减少 history 去重依赖 timestamp / fallback sequence。
- progress snapshot 是完整快照，不是增量事件流；长任务下应继续关注单个 args/result/fullText 投影大小。
- activeTool 当前只表达一个工具；这与当前 sub-agent 串行 tool loop 匹配，未来若支持并行 tool 再扩展。
- shared_state.changed 对 run_subagent_completed 仍使用 paths: [] 全量刷新，简单可靠但不够精确。
```

## Test Plan

`packages/multi-agent/test/run-subagent.test.ts`：

```text
- observer 收到 agent_start / tool_execution_start / tool_execution_end / message_end / agent_end envelope。
- envelope 包含正确 agentId / sessionId / invocationId。
- observer 抛错不影响 SubAgentResult。
- observer async reject 不产生 unhandled failure，不影响 final result。
- invoke 结束后 unsubscribe，避免 listener 泄漏。
- 并发不同 agent 时事件归属正确。
- 同 agent busy 不误发 internal event。
```

`packages/coding-agent/test/multi-agent-run-subagent.test.ts`：

```text
- run_subagent 执行期间调用 onUpdate。
- update content 是 progress snapshot，包含 tool start/end 和 assistant preview。
- update details 是 compact summary，不包含完整原始 events 数组。
- recentEvents 只包含压缩后的高价值事件，不包含原始 agent loop event 或 partialResult 大对象。
- tool_execution_start / tool_execution_end 事件包含 argsSummary / resultSummary。
- resultSummary 默认截断到前 100 个字符。
- 相同 progress snapshot 不重复触发 update。
- SUB_AGENT_BUSY 路径产生 busy final/progress summary，但不产生 sub-agent internal event。
- final details 包含 progress，且现有 result/sharedStateRoot/definitionSource 不变。
```

回归：

```text
- 现有 Phase 5/6 targeted tests 保持通过。
- persistent/resume 测试确认恢复后的 sub-agent event envelope 使用恢复后的 sessionId。
- 主 session 隔离测试确认 sub-agent 内部 tool calls 仍不进入主 session messages。
```

验收命令：

```bash
cd packages/multi-agent
node ../../node_modules/vitest/dist/cli.js --run test/run-subagent.test.ts

cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run test/multi-agent-run-subagent.test.ts test/multi-agent-persistent-runtime.test.ts test/multi-agent-integration.test.ts test/multi-agent-shared-state-rounds.test.ts test/multi-agent-shared-state-tools.test.ts test/multi-agent-adapter.test.ts

cd ../..
npm run check
```

当前验证结果：

```text
- 7 targeted test files passed
- 62 tests passed
- npm run check passed
```

人工 smoke：

```text
- TUI 中已观察到 run_subagent 工具块出现流式 progress update
- TUI multi-subagent workflow 已验证可正常使用，能看到 run_subagent result 与 progress，并产出 shared-state artifact
- Web UI / Web Backend 演示链路已能从 run_subagent progress 更新 agent cards / details；前端可观察整体运行效果
- CLI --mode json 中已观察到 run_subagent 的 tool_execution_update，且 partialResult.details.progress 为 compact summary
- 子 agent 内部 shared_state 工具调用未混入主 session transcript
```

### Phase 7 当前结论

Phase 7 已进入收尾状态：底层事件桥接、TUI 展示、RPC/Web 演示链路都已跑通。后续若继续投入，优先级不应是重做 event system，而是围绕 UI 投影做小幅打磨：

```text
1. 为 CompactSubAgentEvent 增加稳定 id，降低 Web agent history 去重成本。
2. 为 args/result/fullText 投影补大小上限或更明确的展示策略。
3. 如果未来做正式桌面 GUI，直接基于 runtime/session/role-session API 设计多 runtime 视图，而不是把当前 web-backend 当成最终形态。
```

## Non-goals

```text
- 不做正式 SubAgent event bus。
- 不改主 agent event schema。
- 不把 sub-agent 内部 messages 写入主 session。
- 不做 GUI timeline。
- 不做 sub-agent direct chat / ask_user。
- 不做 scheduler / queue / Bus / activation signal。
```
