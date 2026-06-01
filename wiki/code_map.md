# 代码地图

这份文档用于快速定位仓库中的主要模块、入口文件和职责边界。它不是逐行实现说明，而是后续深入理解代码时的导航索引。

## 1. 仓库总览

当前仓库是一个 monorepo，核心包包括：

```text
packages/ai
packages/agent
packages/multi-agent
packages/tui
packages/coding-agent
packages/web-backend
packages/web-ui
```

主要依赖关系可以粗略理解为：

```text
packages/ai
  ↑
packages/agent
  ↑
packages/multi-agent
  ↑
packages/coding-agent
  ↑
packages/web-backend
  ↑
packages/web-ui

packages/coding-agent also depends on packages/tui
```

职责分层：

- `packages/ai`：统一 LLM / 图像 / OAuth / provider 抽象
- `packages/agent`：通用 agent loop、tool call、session/harness 基础能力
- `packages/multi-agent`：sub-agent、role session、shared state 等多智能体原语
- `packages/tui`：终端 UI 组件库
- `packages/coding-agent`：面向用户的 Pi CLI、SDK、工具、扩展、session 管理
- `packages/web-backend`：Web UI 后端桥接层，连接 live RPC / replay / shared state
- `packages/web-ui`：React Web UI，展示 session、timeline、agents、shared state

---

## 2. 根目录

### `package.json`

仓库级 workspace 和脚本入口。

- `workspaces` 覆盖 `packages/*` 以及若干 extension examples
- `build` 按顺序构建 `tui -> ai -> agent -> multi-agent -> coding-agent -> web-backend -> web-ui`
- `check` 包含 Biome、依赖 pin、TS import、shrinkwrap、TypeScript、web-ui check、browser smoke
- `release:*`、`publish:*`、`release:local` 是发布相关入口

### `tsconfig.base.json`

仓库共享 TypeScript 约束。

- `module` / `moduleResolution` 使用 `Node16`
- 开启 `strict`
- 开启 `erasableSyntaxOnly`
- 所有 package 的 build tsconfig 基本继承这里

### `scripts/`

仓库级检查、发布和统计脚本。

- `check-pinned-deps.mjs`：校验直接依赖 pin 版本
- `check-ts-relative-imports.mjs`：校验 TS 相对导入规则
- `generate-coding-agent-shrinkwrap.mjs`：生成/检查 coding-agent shrinkwrap
- `local-release.mjs`：本地 release smoke test
- `release.mjs`：正式 release 编排
- `profile-coding-agent-node.mjs`：TUI/RPC profiling
- `check-browser-smoke.mjs` / `browser-smoke-entry.ts`：浏览器 smoke check

### `wiki/`

面向开发者的分析和架构沉淀。

- `code_map.md`：当前代码地图
- 其他 wiki 文件用于专题分析，不一定和源码同步

---

## 3. `packages/ai`

统一 LLM API 层。它定义 provider、model、message、tool、stream、image、OAuth 等底层抽象。

### 核心入口

- `src/index.ts`：包对外总出口
- `src/stream.ts`：`stream` / `complete` / `streamSimple` / `completeSimple`
- `src/types.ts`：LLM message、model、tool、usage、transport、image 等基础类型
- `src/api-registry.ts`：文本 provider 注册中心
- `src/images-api-registry.ts`：图像 provider 注册中心
- `src/models.ts` / `src/models.generated.ts`：模型元数据入口和生成数据
- `src/image-models.ts` / `src/image-models.generated.ts`：图像模型元数据
- `src/env-api-keys.ts`：环境变量 API key 解析
- `src/session-resources.ts`：session 级资源清理
- `src/oauth.ts`：OAuth 对外入口
- `src/cli.ts`：`pi-ai` OAuth 登录 CLI

### `src/providers/`

具体 LLM provider 实现。

- `register-builtins.ts`：注册内建 provider，是 `stream.ts` 的隐式依赖
- `openai-responses.ts`：OpenAI Responses 实现
- `openai-completions.ts`：OpenAI-compatible completions 实现
- `openai-codex-responses.ts`：OpenAI Codex / subscription provider
- `azure-openai-responses.ts`：Azure Responses 适配
- `anthropic.ts`：Anthropic Messages 适配
- `google.ts`：Google Generative AI 适配
- `google-vertex.ts`：Vertex AI 适配
- `google-shared.ts`：Google / Vertex 共享转换逻辑
- `amazon-bedrock.ts`：Bedrock Converse Stream 适配
- `mistral.ts`：Mistral Conversations 适配
- `cloudflare.ts`：Cloudflare Workers AI / Gateway 适配
- `transform-messages.ts`：跨 provider message 转换
- `openai-responses-shared.ts`：Responses 系共享逻辑
- `openai-prompt-cache.ts`：OpenAI prompt cache 辅助
- `simple-options.ts`：统一简化 stream options
- `github-copilot-headers.ts`：Copilot 头部辅助
- `faux.ts`：测试用 provider
- `images/`：图像生成 provider

### `src/utils/`

底层工具。

- `event-stream.ts`：`AssistantMessageEventStream` 实现
- `json-parse.ts`：partial JSON / streaming JSON 处理
- `validation.ts`：tool argument 校验
- `overflow.ts`：context overflow 判断
- `diagnostics.ts`：assistant message diagnostics
- `headers.ts`：HTTP headers 辅助
- `node-http-proxy.ts`：Node proxy 支持
- `sanitize-unicode.ts`：Unicode 清理
- `oauth/`：OAuth provider、PKCE、device code、provider-specific login

### 测试与生成

- `scripts/generate-models.ts`：生成 `models.generated.ts`
- `scripts/generate-image-models.ts`：生成 `image-models.generated.ts`
- `test/`：provider 协议、streaming、tool call、OAuth、cache、thinking、image 等测试

---

## 4. `packages/agent`

通用 agent 运行时。它不关心 Pi CLI 形态，重点是 agent loop、消息、tool call、session/harness。

### 核心入口

- `src/index.ts`：对外总出口
- `src/agent.ts`：`Agent` 类，封装 state、prompt、continue、queue、event subscription
- `src/agent-loop.ts`：低层 loop，负责 turn、LLM streaming、tool execution、follow-up
- `src/types.ts`：agent loop、tool hook、queue、event、state 等类型
- `src/proxy.ts`：代理/转发 stream 的辅助
- `src/node.ts`：Node 环境入口

### `src/agent.ts`

上层 agent 运行时对象。

- 持有 `AgentState`
- 管理 `steeringQueue` / `followUpQueue`
- 把 `AgentLoopConfig`、stream function、hook 等组装成一次运行
- 对外提供 `prompt()`、`continue()`、`steer()`、`followUp()`、`abort()`、`waitForIdle()`

### `src/agent-loop.ts`

核心循环引擎。

- `runAgentLoop()` / `runAgentLoopContinue()`：外层入口
- `runLoop()`：主循环，处理多 turn 和 follow-up
- `streamAssistantResponse()`：把 `AgentMessage[]` 转成 LLM `Message[]` 并消费 provider stream
- `executeToolCalls()`：选择 sequential / parallel 工具执行模式
- `prepareToolCall()` / `finalizeExecutedToolCall()`：tool 参数校验和 hook 收口

### `src/types.ts`

运行时协议和扩展点。

- `AgentLoopConfig`
- `BeforeToolCallContext` / `AfterToolCallContext`
- `BeforeToolCallResult` / `AfterToolCallResult`
- `ToolExecutionMode`
- `QueueMode`
- `ShouldStopAfterTurnContext`
- `AgentLoopTurnUpdate`

### `src/harness/`

测试/嵌入式 harness 能力。

- `agent-harness.ts`：可控 agent harness，适合测试和嵌入式运行
- `messages.ts`：agent/harness message 转换
- `prompt-templates.ts`：prompt template 调用格式
- `skills.ts`：skill 加载与格式化
- `system-prompt.ts`：system prompt 构造
- `types.ts`：harness 事件、资源、session、env 类型
- `env/nodejs.ts`：Node execution env

### `src/harness/session/`

session 持久化抽象。

- `session.ts`：session 树和 `buildSessionContext()`
- `jsonl-storage.ts` / `jsonl-repo.ts`：JSONL 持久化实现
- `memory-storage.ts` / `memory-repo.ts`：内存实现
- `repo-utils.ts`：repo 辅助
- `uuid.ts`：UUID v7

### `src/harness/compaction/`

上下文压缩与分支摘要。

- `compaction.ts`：token 估算、cut point、summary 生成、compact
- `branch-summarization.ts`：branch summary 准备和生成
- `utils.ts`：压缩相关工具

### 文档与测试

- `docs/agent-harness.md`：harness 使用说明
- `docs/durable-harness.md`：持久化 harness
- `docs/hooks.md`：hook 说明
- `docs/observability.md`：可观测性说明
- `test/`：agent loop、Agent class、harness、session、compaction 测试

---

## 5. `packages/multi-agent`

多智能体原语包。它只定义 sub-agent、role session、shared state 等通用能力，不直接绑定 coding-agent UI。

### 核心入口

- `src/index.ts`：对外总出口
- `src/types.ts`：sub-agent 定义、session-like、result、inspection 等类型
- `src/session-like.ts`：抽象 `AgentSessionLike`
- `src/sub-agent.ts`：`PiSubAgentInstance`
- `src/registry.ts`：`SubAgentRegistry`
- `src/run-subagent.ts`：`RunSubAgentRunner` 和 `SubAgentInstancePool`
- `src/run-subagent-types.ts`：run_subagent 协议、capabilities、event observer 类型
- `src/role-session-index.ts`：role session 绑定索引

### `src/sub-agent.ts`

单个 sub-agent 实例封装。

- 持有 sub-agent definition 和 `AgentSessionLike`
- 提供 `prompt()`、`steer()`、`followUp()`、`abort()`、`invoke()`、`inspect()`、`close()`
- 管理 `idle` / `running` / `closed` phase
- 从 session message 中提取最终 assistant 文本和 status

### `src/run-subagent.ts`

多智能体运行器。

- `SubAgentInstancePool`：按 agent id 和 reuse key 缓存/替换实例
- `RunSubAgentRunner`：按 `agentId` 找 definition、创建 session、控制并发、执行 invocation
- 支持 `ephemeral` / `session` state policy
- 支持 role session lifecycle store
- 支持 progress/event observer

### `src/registry.ts`

sub-agent definition 注册表。

- `register()`
- `get()`
- `list()`

### `src/role-session-index.ts`

主 session 与 sub-agent role session 的绑定索引。

- `FileRoleSessionIndex`
- `createDefinitionIdentity()`
- `defaultRoleSessionIndexPath()`

### `src/shared-state/`

共享状态 manifest 原语。

- `types.ts`：`SharedStateGrant`、`SharedStateArtifact`、`SharedStateManifest` 等类型
- `memory-manifest.ts`：内存 manifest
- `file-manifest.ts`：文件 manifest
- `index.ts`：shared-state 对外导出

---

## 6. `packages/tui`

终端 UI 组件库。它负责输入、渲染、layout、overlay、终端图片、按键处理。

### 核心入口

- `src/index.ts`：对外总出口
- `src/tui.ts`：`TUI`、`Container`、overlay、focus、differential rendering
- `src/terminal.ts`：`Terminal` 抽象和 `ProcessTerminal`
- `src/keys.ts`：键盘解析、Kitty key protocol、`matchesKey`
- `src/keybindings.ts`：keybindings 管理
- `src/autocomplete.ts`：autocomplete provider 和组合逻辑
- `src/utils.ts`：宽度、ANSI、wrap、truncate 工具
- `src/terminal-image.ts`：Kitty / iTerm2 图片协议
- `src/stdin-buffer.ts`：stdin 分片和粘贴处理
- `src/kill-ring.ts` / `src/undo-stack.ts`：编辑器行为辅助

### `src/components/`

基础组件。

- `editor.ts`：多行编辑器
- `input.ts`：单行输入
- `select-list.ts`：选择器列表
- `settings-list.ts`：设置列表
- `markdown.ts`：Markdown 渲染
- `text.ts`：文本组件
- `truncated-text.ts`：截断文本
- `loader.ts` / `cancellable-loader.ts`：加载状态
- `image.ts`：终端图片组件
- `box.ts`：容器背景/边距
- `spacer.ts`：空白占位

### Native / 测试

- `native/`：darwin modifier、win32 console mode 原生模块和预编译产物
- `test/`：输入、渲染、宽度、overlay、image、editor、markdown、keybinding 等测试

---

## 7. `packages/coding-agent`

面向用户的 Pi CLI 和 SDK。它把 `ai`、`agent`、`multi-agent`、`tui` 组合成完整 coding agent。

### 顶层入口

- `src/cli.ts`：bin 入口，设置进程标题、dispatcher，然后调用 `main()`
- `src/main.ts`：CLI 总编排，解析参数、选择 mode、创建 session/runtime、挂载 multi-agent tool
- `src/index.ts`：SDK/库对外出口
- `src/config.ts`：路径、版本、agent dir、docs/share URL 等配置
- `src/migrations.ts`：配置和认证迁移
- `src/package-manager-cli.ts`：package/config 相关 CLI 子命令

### `src/cli/`

CLI 参数和启动输入处理。

- `args.ts`：命令行参数解析
- `initial-message.ts`：初始消息构造
- `file-processor.ts`：`@file` / 文件参数处理
- `list-models.ts`：模型列表输出
- `session-picker.ts`：resume session 选择
- `config-selector.ts`：配置选择

### `src/core/agent-session.ts`

coding-agent 的核心业务对象。

- 连接 `Agent`、`SessionManager`、`SettingsManager`、`ResourceLoader`、`ModelRegistry`
- 管理 prompt、steer、follow-up、abort、compaction、tree、fork、session info
- 订阅 agent events 并写入 session
- 维护 active tools、custom tools、extension runner
- 构造 system prompt 和 LLM context

### `src/core/agent-session-runtime.ts`

session/runtime 替换层。

- `AgentSessionRuntime` 持有当前 session 和 cwd-bound services
- 负责 `switchSession()`、`newSession()`、`fork()` 等场景
- session 替换时执行 extension shutdown、UI rebind、service recreation

### `src/core/agent-session-services.ts`

cwd-bound 服务构造。

- 创建 `AuthStorage`
- 创建 `SettingsManager`
- 创建 `ModelRegistry`
- 创建 `DefaultResourceLoader`
- 应用 extension flags
- 注册 extension pending provider

### `src/core/sdk.ts`

程序化使用入口。

- `createAgentSession()`
- `createAgentSessionServices()`
- tool factory re-export
- extension / prompt / skill 相关类型导出

### `src/core/session-manager.ts`

coding-agent session 文件管理。

- JSONL session header / entry 类型
- v1 -> v2 -> v3 migration
- session tree、branch、leaf、label
- `buildSessionContext()`
- fork、clone、continue、list、listAll

### `src/core/model-registry.ts`

模型和 provider 配置中心。

- 合并 built-in models、custom models、provider overrides
- 读取 `models.json`
- 处理 API key / OAuth credentials
- 注册 custom provider
- 解析 provider headers、compat、thinking level map

### `src/core/settings-manager.ts`

设置系统。

- 全局设置：`~/.pi/agent/settings.json`
- 项目设置：`.pi/settings.json`
- deep merge global/project
- 管理 theme、transport、retry、compaction、packages、skills、prompts、images、terminal、sessionDir 等
- 使用 lockfile 保护写入

### `src/core/resource-loader.ts`

资源加载中心。

- 加载 `AGENTS.md` / `CLAUDE.md`
- 加载 extensions、skills、prompts、themes
- 加载 sub-agent definitions
- 处理 package sources
- 提供 `getExtensions()`、`getSkills()`、`getPrompts()`、`getThemes()`、`getSubAgents()`

### `src/core/multi-agent/`

coding-agent 与 `packages/multi-agent` 的适配层。

- `agent-session-adapter.ts`：把 `AgentSession` 适配成 `AgentSessionLike`
- `session-factory.ts`：为 sub-agent 创建隔离的 coding-agent session
- `restricted-resource-loader.ts`：sub-agent 受限资源加载器，默认不加载外部 tools/skills/extensions
- `run-subagent-tool.ts`：正式 `run_subagent` tool，支持 registered sub-agents、shared state、role session
- `direct-subagent-tool.ts`：简化 direct `run_subagent` tool，主要用于早期/测试场景
- `shared-state-tools.ts`：`shared_state.list/read/grep/write/edit` 工具实现
- `sub-agent-definition-loader.ts`：从 frontmatter 文件解析 sub-agent definition
- `role-session-store.ts`：coding-agent session 与 sub-agent role session lifecycle store
- `definition-source.ts`：文件定义和 demo definitions 的选择逻辑
- `index.ts`：multi-agent 适配层总出口

相关启动点：

- `src/main.ts` 会读取 `PI_MULTI_AGENT_RUN_SUBAGENT`
- 开启后从 `resourceLoader.getSubAgents()` 获取定义
- 无文件定义时回退到 demo definitions
- 注入 `createRunSubAgentTool()` 到 `sessionOptions.customTools`
- `PI_MULTI_AGENT_SHARED_STATE_ROOT` 可指定 shared state root

### `src/core/tools/`

内建工具。

- `index.ts`：工具工厂总入口，创建 read/bash/edit/write/grep/find/ls
- `read.ts`：文件读取
- `write.ts`：文件写入
- `edit.ts`：文本编辑工具
- `edit-diff.ts`：diff 辅助
- `bash.ts`：shell 执行工具
- `grep.ts`：内容搜索
- `find.ts`：路径搜索
- `ls.ts`：目录列表
- `file-mutation-queue.ts`：文件修改串行化
- `tool-definition-wrapper.ts`：把 tool definition 包装成 agent tool
- `render-utils.ts`：tool 输出渲染辅助
- `truncate.ts`：输出裁剪

### `src/core/extensions/`

扩展系统。

- `types.ts`：扩展 API、事件、tool、command、UI context 类型
- `loader.ts`：使用 jiti 加载扩展，处理 aliases / virtual modules
- `runner.ts`：扩展事件分发、生命周期、UI/session/model 绑定
- `wrapper.ts`：extension tool wrapper
- `index.ts`：扩展系统对外出口

### `src/core/compaction/`

coding-agent 侧 compaction。

- `compaction.ts`：上下文压缩
- `branch-summarization.ts`：分支摘要
- `utils.ts`：压缩辅助
- `index.ts`：对外出口

### `src/core/export-html/`

session 导出 HTML。

- `index.ts`：导出主流程
- `template.html` / `template.css` / `template.js`：导出页模板
- `ansi-to-html.ts`：ANSI 转 HTML
- `tool-renderer.ts`：工具结果渲染
- `vendor/`：导出页依赖的静态 vendor

### 其他 `src/core/` 文件

- `auth-storage.ts`：API key / OAuth credential 存储
- `auth-guidance.ts`：认证错误提示文案
- `bash-executor.ts`：用户 bash / tool bash 执行支持
- `event-bus.ts`：内部事件总线
- `footer-data-provider.ts`：footer 数据
- `http-dispatcher.ts`：undici dispatcher / timeout 配置
- `keybindings.ts`：应用级 keybindings
- `messages.ts`：custom / bash / compaction / branch summary message 构造
- `model-resolver.ts`：CLI model pattern / scoped model 解析
- `output-guard.ts`：print/json 模式 stdout guard
- `package-manager.ts`：Pi package 资源加载
- `prompt-templates.ts`：prompt templates
- `provider-display-names.ts`：provider 显示名
- `resolve-config-value.ts`：配置值和 headers 解析
- `session-cwd.ts`：session cwd 丢失处理
- `skills.ts`：skill 加载
- `slash-commands.ts`：内建 slash commands
- `source-info.ts`：资源来源信息
- `system-prompt.ts`：system prompt 构造
- `telemetry.ts`：安装/版本 telemetry
- `timings.ts`：启动耗时记录
- `diagnostics.ts`：resource diagnostics 类型

### `src/modes/`

运行模式。

- `interactive/interactive-mode.ts`：TUI 交互模式总控制器
- `print-mode.ts`：文本/JSON 非交互模式
- `rpc/rpc-mode.ts`：RPC server mode
- `rpc/rpc-client.ts`：RPC client
- `rpc/jsonl.ts`：JSONL RPC 协议辅助
- `rpc/rpc-types.ts`：RPC 类型
- `index.ts`：mode 总出口

### `src/modes/interactive/components/`

交互模式 UI 组件。

- `assistant-message.ts` / `user-message.ts`：消息渲染
- `tool-execution.ts` / `bash-execution.ts`：工具和 bash 展示
- `footer.ts`：底部状态栏
- `custom-editor.ts` / `extension-editor.ts`：编辑器
- `model-selector.ts` / `scoped-models-selector.ts`：模型选择
- `session-selector.ts` / `tree-selector.ts` / `user-message-selector.ts`：session/tree/fork 选择
- `settings-selector.ts` / `theme-selector.ts` / `thinking-selector.ts`：设置面板
- `extension-selector.ts` / `extension-input.ts`：extension UI
- `login-dialog.ts` / `oauth-selector.ts`：登录与 OAuth UI
- `custom-message.ts` / `skill-invocation-message.ts` / `branch-summary-message.ts` / `compaction-summary-message.ts`：特殊消息

### `src/utils/`

CLI 通用工具。

- `paths.ts`：路径解析和规范化
- `shell.ts` / `child-process.ts`：进程和 shell
- `git.ts`：Git URL/状态辅助
- `clipboard.ts` / `clipboard-native.ts` / `clipboard-image.ts`：剪贴板
- `image-resize.ts` / `image-convert.ts` / `photon.ts`：图片处理
- `frontmatter.ts`：frontmatter 解析
- `syntax-highlight.ts`：代码高亮
- `version-check.ts`：版本检查
- `windows-self-update.ts`：Windows self-update quarantine 清理
- `tools-manager.ts`：外部工具查找

### `src/bun/`

Bun binary 相关入口。

- `cli.ts`：Bun binary CLI
- `register-bedrock.ts`：Bedrock 注册
- `restore-sandbox-env.ts`：sandbox env 恢复

### 文档、示例、测试

- `docs/`：用户文档，覆盖 settings、models、extensions、skills、sessions、rpc、sdk 等
- `examples/sdk/`：SDK 示例
- `examples/extensions/`：extension 示例
- `test/`：CLI、core、tools、extensions、session、RPC、multi-agent、UI 组件等测试

---

## 8. `packages/web-backend`

Web UI 的 Node 后端桥接层。它提供 HTTP API + SSE，把 Web UI 和 live/replay Pi session 连接起来。

### 核心入口

- `src/index.ts`：对外导出 contract、errors、server、session store
- `src/cli.ts`：`pi-web-backend` bin，读取 env 后启动 Hono server
- `src/server.ts`：HTTP API 和 SSE endpoint
- `src/contract.ts`：前后端共享 API contract 类型
- `src/session-store.ts`：后端当前 session snapshot 状态
- `src/errors.ts`：API error 类型和响应
- `src/env-loader.ts`：`.env` 加载

### `src/server.ts`

Hono app 主入口。

- `GET /api/state`
- `GET /api/messages`
- `GET /api/agents`
- `GET /api/agents/:agentId/history`
- `GET /api/role-sessions`
- `GET /api/shared-state/manifest`
- `GET /api/shared-state/artifact`
- `GET /api/events`
- `POST /api/session/start`
- `POST /api/session/stop`
- `POST /api/prompt`
- `POST /api/abort`
- `POST /api/replay/reset`
- `POST /api/replay/speed`

### `src/engines/`

后端运行模式抽象。

- `engine.ts`：`BackendEngine` interface
- `empty-engine.ts`：未启动状态
- `live-rpc-engine.ts`：通过 `RpcClient` 启动/控制真实 coding-agent RPC session
- `replay-engine.ts`：读取 JSONL replay log 并按速度回放

### `src/events/`

事件归一化和 SSE。

- `sse-bus.ts`：SSE client 管理和 event envelope 格式化
- `normalize-event.ts`：agent events -> Web timeline events
- `run-subagent-progress.ts`：run_subagent progress 汇总成 agent card 状态
- `agent-history.ts`：sub-agent history 构造

### `src/shared-state/`

Web backend 读取 shared state。

- `locator.ts`：定位 shared state root
- `manifest-reader.ts`：读取 manifest
- `artifact-reader.ts`：读取 artifact 内容
- `path-safety.ts`：路径安全校验

### `src/replay/`

Replay 支持。

- `jsonl-log-reader.ts`：读取 JSONL event log
- `replay-state-reducer.ts`：根据事件还原 replay state

### `src/role-sessions/`

role session 读取。

- `role-session-reader.ts`：读取 `.pi/multi-agent/role-sessions.json`

### 测试

- `test/server-mock-api.test.ts`
- `test/live-rpc-engine.test.ts`
- `test/replay-regression.test.ts`
- `test/session-store.test.ts`
- `test/path-safety.test.ts`
- `test/jsonl-log-reader.test.ts`
- `test/env-loader.test.ts`

---

## 9. `packages/web-ui`

React + Vite Web UI。用于观察和控制 web-backend 暴露的 live/replay session。

### 核心入口

- `src/main.tsx`：React root
- `src/App.tsx`：应用总编排，hydrate、SSE 连接、prompt/abort/start/stop/replay 控制
- `src/styles.css`：全局样式
- `index.html`：Vite HTML 入口
- `vite.config.ts` / `vitest.config.ts`：构建和测试配置

### `src/api/`

前后端通信。

- `contracts.ts`：复制/对齐后端 contract 类型
- `http-client.ts`：REST API client
- `event-client.ts`：SSE client，监听 `session.started`、`message.delta`、`agent.updated`、`shared_state.changed` 等

### `src/state/`

前端状态管理。

- `app-state.ts`：`WebUiState` 和初始状态
- `app-reducer.ts`：hydrate、SSE、agent history、artifact load、input 状态 reducer
- `selectors.ts`：派生数据选择器

### `src/components/layout/`

页面骨架。

- `AppShell.tsx`：整页布局，组合 session controls、timeline、agent cards、shared state panel

### `src/components/session/`

session 控制。

- `SessionControls.tsx`：start live、start replay、stop、reset、speed、abort 等 UI

### `src/components/prompt/`

用户输入。

- `PromptInput.tsx`：prompt 输入和发送

### `src/components/timeline/`

主消息时间线。

- `MainTimeline.tsx`
- `TimelineTurn.tsx`
- `TimelineMessageItem.tsx`

### `src/components/agents/`

多智能体状态展示。

- `AgentCardsRow.tsx`
- `AgentCard.tsx`
- `AgentDetailPanel.tsx`
- `agent-activity.ts`

### `src/components/shared-state/`

shared state artifact 展示。

- `SharedStatePanel.tsx`
- `ArtifactList.tsx`
- `ArtifactViewer.tsx`

### 其他组件

- `components/status/ConnectionStatus.tsx`：连接状态
- `components/markdown/MarkdownLite.tsx`：轻量 markdown 渲染

### 测试

- `test/app-reducer.test.ts`
- `test/components.test.tsx`
- `test/event-client.test.ts`
- `test/http-client.test.ts`
- `test/fixtures.ts`

---

## 10. 推荐阅读路径

### 理解 CLI 主链路

1. `packages/coding-agent/src/cli.ts`
2. `packages/coding-agent/src/main.ts`
3. `packages/coding-agent/src/core/agent-session-services.ts`
4. `packages/coding-agent/src/core/sdk.ts`
5. `packages/coding-agent/src/core/agent-session.ts`
6. `packages/agent/src/agent.ts`
7. `packages/agent/src/agent-loop.ts`
8. `packages/ai/src/stream.ts`

### 理解工具执行

1. `packages/coding-agent/src/core/tools/index.ts`
2. `packages/coding-agent/src/core/tools/read.ts`
3. `packages/coding-agent/src/core/tools/bash.ts`
4. `packages/coding-agent/src/core/tools/edit.ts`
5. `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`
6. `packages/agent/src/agent-loop.ts`

### 理解扩展系统

1. `packages/coding-agent/src/core/extensions/types.ts`
2. `packages/coding-agent/src/core/extensions/loader.ts`
3. `packages/coding-agent/src/core/extensions/runner.ts`
4. `packages/coding-agent/examples/extensions/README.md`
5. `packages/coding-agent/examples/extensions/`

### 理解多智能体

1. `packages/multi-agent/src/types.ts`
2. `packages/multi-agent/src/sub-agent.ts`
3. `packages/multi-agent/src/run-subagent.ts`
4. `packages/multi-agent/src/shared-state/types.ts`
5. `packages/coding-agent/src/core/multi-agent/session-factory.ts`
6. `packages/coding-agent/src/core/multi-agent/run-subagent-tool.ts`
7. `packages/coding-agent/src/core/multi-agent/shared-state-tools.ts`
8. `packages/coding-agent/src/main.ts`

### 理解 Web UI

1. `packages/web-backend/src/server.ts`
2. `packages/web-backend/src/engines/live-rpc-engine.ts`
3. `packages/web-backend/src/events/normalize-event.ts`
4. `packages/web-ui/src/App.tsx`
5. `packages/web-ui/src/state/app-reducer.ts`
6. `packages/web-ui/src/components/layout/AppShell.tsx`

### 定位测试

- agent loop：`packages/agent/test/agent-loop.test.ts`
- coding-agent session/tool/extension：`packages/coding-agent/test/`
- multi-agent：`packages/coding-agent/test/multi-agent-*.test.ts`
- web backend：`packages/web-backend/test/`
- web UI：`packages/web-ui/test/`
