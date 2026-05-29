# Shared State Multi-Agent Web UI 前端实现计划

## 1. 前端目标

使用 React 构建一个可长期演进的前端，面向 Shared State multi-agent 协作场景，满足：

- 用户输入需求后，可以实时看到主 agent 的协调过程；
- 可以看到多个角色 agent 的当前状态与最近进展；
- 可以查看 Shared State 和 artifacts 的当前内容；
- 可以在 replay backend 和 live backend 两种模式下工作；
- 可以在刷新页面后重新 hydrate 当前状态。

前端不负责管理本地文件和本地进程，只消费 backend 暴露的统一 contract。

---

## 2. 页面结构

推荐布局：

```text
Top: agent cards row
Middle-left: Shared State / artifacts
Middle-right: main agent timeline
Bottom: input area
```

### 2.1 Agent cards

每个卡片展示：
- agent 名称
- 图标/头像
- 当前 phase
- activeTool
- 最近 progress 摘要
- 展开后的 recent events

### 2.2 Shared State / Artifacts 面板

展示：
- artifact 列表
- owner / version / updatedAt
- artifact 内容
- 选中的 artifact 详情

### 2.3 Main timeline

展示：
- 主 agent 回复内容
- 主 agent 的工具调用过程
- 主 agent 最终总结

### 2.4 Input area

最小功能：
- 输入框
- 发送按钮
- 停止按钮（可选）

---

## 3. 前端状态模型

建议至少分 4 个 store / slice。

### 3.1 `mainTimeline`
来源：SSE 流式事件

字段：
- main agent text chunks
- main assistant messages
- main tool events
- current turn status

### 3.2 `agentsById`
来源：`run_subagent` 的 `tool_execution_start/update/end`

字段：
- `agentId`
- `displayName`
- `avatar`
- `phase`
- `activeTool`
- `completedTools`
- `lastAssistantPreview`
- `eventCount`
- `recentEvents`
- `lastRunStatus`
- `sessionId`
- `sharedStateRoot`
- `collapsed`

### 3.3 `sharedState`
来源：后端 API

字段：
- `manifest[]`
- `artifactContentByPath`
- `selectedArtifactPath`
- `loading/error`

### 3.4 `uiSession`
字段：
- `backendMode` (`live | replay`)
- `connected`
- `reconnecting`
- `inputPending`
- `selectedAgentId`
- `selectedArtifactPath`
- `errorBanner`

---

## 4. 前端数据来源

### 4.1 通过 SSE 直接消费的
- 主 session 事件流
- `run_subagent` 的 progress summary
- 主 agent 文本流式更新

### 4.2 通过 HTTP 拉取的
- `GET /api/state`
- `GET /api/messages`
- `GET /api/agents`
- `GET /api/shared-state/manifest`
- `GET /api/shared-state/artifact?path=...`
- `GET /api/role-sessions`

前端不应该从 SSE 重建 Shared State 的完整内容，而应以 HTTP API 返回的 manifest/file 内容为准。

---

## 5. 与后端的契约对齐原则

前端只认统一 contract，不区分 live/replay 模式。后端必须保证：

- SSE 事件结构一致
- `state/messages/agents/shared-state` 返回 shape 一致
- replay backend 和 live backend 字段命名保持一致

前端禁止依赖：
- 本地路径拼接规则
- 直接读取 `.manifest.json`
- 直接解析本地 session file

---

## 6. 实现阶段

### Stage 1 — 基础壳子
目标：搭起页面结构与基础 store

实现：
- React app shell
- 页面布局
- 全局 store
- SSE client 封装
- 基础 HTTP client

### Stage 2 — Agent cards + main timeline
目标：让“过程感”先成立

实现：
- `mainTimeline` 面板
- agent cards row
- `run_subagent` progress summary 映射
- 折叠/展开 recent events

### Stage 3 — Shared State / artifacts 面板
目标：让“状态真相”成立

实现：
- manifest 列表
- artifact 内容查看
- 选中切换
- 写入后刷新策略

### Stage 4 — 输入与控制
目标：形成闭环

实现：
- prompt 输入
- stop/abort
- session start/stop
- replay/live 模式切换（如果后端支持）

### Stage 5 — 恢复与可用性增强
目标：进入真正可用状态

实现：
- 页面刷新后 hydrate
- reconnect / retry
- 错误态展示
- 空态 / 无数据态
- 大内容滚动与性能优化

---

## 7. 前端验收标准

### 功能验收
1. 输入 prompt 后，主 agent timeline 能流式更新。
2. `run_subagent` 发生时，对应 agent card 能更新 phase / activeTool / recentEvents。
3. Shared State / artifacts 面板能显示真实文件内容与 manifest metadata。
4. 在 replay/live 两种 backend 模式下，前端不需要改逻辑即可工作。
5. 页面刷新后能通过 hydrate API 恢复当前视图。

### 体验验收
1. 多 agent 并行时，用户能一眼看出谁在忙、谁完成了。
2. main timeline 和 Shared State 区域职责清晰，不互相混淆。
3. card 展开后 recent events 够用但不过吵。
4. artifact 查看切换流畅。

---

## 8. 当前不做

第一版前端明确不做：

- GUI 多 runtime tabs
- 复杂拖拽编排
- 内建 scheduler 视图
- 完整 trace replay 控件
- 直接编辑 shared-state 文件
- 角色直接对用户 ask_user
- 权限管理后台

---

## 9. 建议技术路线

React 即可，优先选轻量状态管理和基础组件库，不要一开始上太重的工程架构。

建议：
- React + TypeScript
- 一层全局 store（Zustand/Redux 任一）
- 原生 SSE + fetch 即可
- agent cards / manifest list / artifact viewer 先做简单可用版本

前端第一版重点不是“炫”，而是：
- 准确
- 稳定
- 易联调
- 易于替换 replay/live backend