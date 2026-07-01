# Shared State Multi-Agent Web UI 总体方案

## 1. 目标

在当前已经完成的 Shared State multi-agent 基础组件之上，设计并逐步实现一个**真正可用**的 Web UI，而不是只做演示性质的原型页面。

这个 Web UI 的核心目的不是单纯展示聊天内容，而是让用户能够同时看到：

1. 多个角色型 agent 当前分别在做什么；
2. Shared State 中的中间产物如何演化；
3. 主 agent 如何协调这些角色；
4. 最终 artifacts 如何逐步收敛。

当前预设角色可以先从 3 个开始：

- PM agent
- RD / Engineering agent
- DA / Data Analyst agent

后续角色数和角色定义可以扩展，但第一版应先把 3 角色协作链路做稳定。

---

## 2. 产品形态

推荐布局：

```text
Top:    agent cards row
Middle: left = shared state / artifacts, right = main agent timeline
Bottom: user input area
```

### 2.1 顶部 agent cards

每个 agent card 展示：

- agent 名称
- 头像 / 图标
- 当前 phase（idle / starting / running / completed / failed / aborted）
- 当前 activeTool
- 最近 1~3 条 compact progress
- 是否可展开更多 recent events

这部分主要由 `run_subagent` 的 progress summary 驱动。

### 2.2 中间 Shared State / Artifacts 面板

这一层不只展示“文件路径”，而应展示：

- 当前有哪些 shared state artifacts
- 每个 artifact 的 owner / version / updatedAt
- artifact 内容本身
- 可选的“最终交付区”与“中间共享区”分组

这部分的 source of truth 应该是：

- `.manifest.json`
- 真实 shared-state 文件内容

而不是单靠流式事件重建。

### 2.3 主 agent timeline / 回复区

展示：

- 主 agent 的流式回复
- 主 agent 触发的 `run_subagent` 工具调用
- 主 agent 对多 agent 结果的协调与总结

这一层本质上是用户与系统的主交互面。

### 2.4 用户输入区

保留普通聊天输入方式：

- 输入框
- 发送按钮
- 中止按钮（可选）

未来如需 advanced controls（角色筛选、工作模式切换、回放速度等），应作为增强项后置。

---

## 3. 为什么当前基础已经足够支撑这套 UI

当前系统已经具备：

### 3.1 角色运行时
- role-based sub-agent
- session-style create-or-resume
- role-session index
- single-active-run contract

### 3.2 Shared State 能力
- `shared_state.list/read/grep/write/edit`
- file-backed workspace
- file-backed manifest
- owner / version / provenance / grants

### 3.3 可观测性
- `run_subagent` progress summary
- TUI 中间态可视化
- CLI `--mode json` 中的 `tool_execution_update`
- compact summary + `argsSummary` / `resultSummary`

### 3.4 测试与 smoke
- targeted tests
- integration tests
- TUI / CLI smoke
- `npm run check`

因此，后续重点不再是补基础能力，而是把这些能力以产品化方式组织成 Web UI。

---

## 4. 核心设计原则

### 4.1 后端是必须的

浏览器不应直接：

- 启动 / 管理本地 `pi` 进程
- 读取本地 `.pi/multi-agent/...` 文件
- 直接重建 Shared State 真相

必须引入一个 **Node bridge backend**。

### 4.2 事件流负责“过程”，文件/manifest 负责“状态真相”

- **事件流**：驱动 agent cards 和 main timeline
- **manifest + 文件**：驱动 Shared State / artifacts 面板

不要让前端只靠事件流重建 shared state 全量状态。

### 4.3 replay/mock backend 与 live backend 要共享同一契约

为了支持前后端并行开发与联调，后端应支持两种模式：

- `live mode`：真实连接 `pi --mode rpc`
- `replay mode`：读取 `data/sharedstate_multi_agent_cli_log.jsonl` 等日志并回放

这两种模式必须对前端暴露**同一套 HTTP + SSE contract**。

这样前端不需要关心当前接的是“真实 agent loop”还是“回放引擎”。

### 4.4 这套 UI 不是 scheduler

UI 的职责是观察、消费和组织系统输出，不负责发明新的 scheduler / queue / bus。当前产品形态下：

- 主 agent 仍然负责协调
- sub-agent 仍然是后台角色 worker
- Shared State 仍然是协作 substrate

---

## 5. 总体架构

```text
React frontend
  <-> Node bridge backend
       <-> live mode: pi --mode rpc process
       <-> replay mode: sharedstate_multi_agent_cli_log.jsonl player

Node bridge backend also reads:
- shared-state manifest + files
- role-session index
- session state / message history
```

---

## 6. 数据流

### 6.1 实时路径

1. 用户输入 prompt
2. React 调 `POST /api/prompt`
3. backend 转发给 pi RPC 进程
4. pi 产生 JSONL / RPC 事件
5. backend 通过 SSE 推送给前端
6. 前端更新：
   - 主 timeline
   - agent cards
   - 触发 Shared State 面板刷新

### 6.2 Shared State 刷新路径

推荐在这些时机刷新：

- `run_subagent` 结束后
- 或针对 `shared_state.*` 写操作完成后

第一版可先粗粒度：
- 每次 `run_subagent` 完成后刷新 manifest

后续再做更细粒度 path-level refresh。

---

## 7. 后续拆分文档

为方便前后端并行开发，整体方案之外，另拆两份：

- 前端实现计划：`pi_sharedstate_multi_agent_web_ui_frontend_plan.md`
- 后端实现计划：`pi_sharedstate_multi_agent_web_ui_backend_plan.md`

前后端的共享契约以**后端 contract 文档**为准。

---

## 8. 成功标准

如果该系统能够稳定支持：

1. 顶部角色卡片实时展示 agent 过程；
2. Shared State / artifacts 区域稳定展示真实内容；
3. 主 agent 协调过程可追踪；
4. replay / live 两种 backend 模式下前端都能正常工作；
5. 页面刷新后可恢复当前会话视图；

则可以认为：

> 当前 Shared State multi-agent 基础组件已经足以支撑一个真正可用的 Web UI 产品第一版。