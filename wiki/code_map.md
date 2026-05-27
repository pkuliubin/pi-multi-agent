# 代码地图

这份文档的目标不是逐行解释实现，而是先给出一张可导航的仓库地图，方便后续快速定位代码和理解模块边界。

## 1. 仓库总览

仓库是一个 monorepo，核心依赖链大致是：

```text
packages/coding-agent -> packages/agent -> packages/ai
packages/coding-agent -> packages/tui
packages/agent -> packages/ai
```

职责拆分上可以粗略理解为：

- `packages/ai`：统一 LLM / 图像能力层，负责 provider、stream、model、oauth、tool 相关基础能力
- `packages/agent`：通用 agent 运行时，负责消息循环、tool 调用、会话/持久化/压缩等能力
- `packages/tui`：终端 UI 组件库，负责输入、渲染、选项列表、编辑器、图片和键盘行为
- `packages/coding-agent`：面向用户的完整 CLI，负责交互模式、session 管理、扩展系统、工具层封装和导出能力

---

## 2. 根目录

### `package.json`

仓库级脚本入口和 workspace 定义。

- 定义所有 package 的 workspace
- 提供 `build` / `check` / `test` / `release:*` 等总入口
- 维护根级版本和发布流程

### `tsconfig.base.json`

整个仓库共享的 TypeScript 编译约束。

- 统一 `Node16` 模块策略
- 开启 `erasableSyntaxOnly`
- 约束所有包的类型和输出风格

### `scripts/`

仓库级运维脚本目录，偏构建、检查、发布和统计。

- `check-*`：质量检查
- `generate-*`：生成 shrinkwrap / 模型数据等
- `release.mjs`：发布流程编排
- `local-release.mjs`：本地 release smoke test
- `profile-*`：性能/行为分析

### `wiki/`

用于沉淀架构理解、研究笔记和代码地图。

- 当前这类文档放这里最合适
- 适合作为后续深入分析的索引页

---

## 3. `packages/ai`

统一 LLM API 层。这个包是最底层的 provider 抽象，其他包会直接或间接依赖它。

### `packages/ai/src/index.ts`

对外总出口。

- 汇总导出 models、providers、stream、types、oauth、images 等能力
- 是上层包最常用的 `pi-ai` 入口

### `packages/ai/src/stream.ts`

最核心的流式调用入口。

- `stream` / `complete`
- `streamSimple` / `completeSimple`
- 在注册表里按 `model.api` 分发到具体 provider

### `packages/ai/src/api-registry.ts`

provider 注册中心。

- 注册 / 查询 / 清理 API provider
- 做 `api` 与具体 stream 函数的绑定
- 是 provider 插件化的基础

### `packages/ai/src/types.ts`

所有 LLM 相关通用类型定义。

- `Model` / `Context` / `Message`
- `Provider` / `Api`
- `ToolCall` / `ThinkingLevel` / `Transport`
- 图像、usage、stream options 等基础协议

### `packages/ai/src/models.ts`、`packages/ai/src/models.generated.ts`

模型定义和模型注册数据。

- 负责 provider/model 元数据
- `models.generated.ts` 是生成物，不应手工改

### `packages/ai/src/image-models.ts`、`packages/ai/src/image-models.generated.ts`

图像模型能力数据。

- 用于区分哪些模型支持图片输入或图片生成
- 同样有生成文件

### `packages/ai/src/images.ts`、`packages/ai/src/images-api-registry.ts`

图像输入/生成相关入口。

- 图像 API 的统一抽象
- 图像 provider 注册和调用

### `packages/ai/src/oauth.ts`

OAuth 登录与 token 相关统一入口。

- 对上层暴露 provider 登录能力
- 供 CLI 或自动化认证流程使用

### `packages/ai/src/providers/`

具体 provider 实现目录。

- `openai-responses.ts`：OpenAI Responses API
- `openai-completions.ts`：传统 completions/compat 层
- `openai-codex-responses.ts`：OpenAI Codex 相关响应层
- `anthropic.ts`：Anthropic 消息流
- `google.ts` / `google-vertex.ts`：Google / Vertex 适配
- `mistral.ts`：Mistral 适配
- `amazon-bedrock.ts`：Bedrock 适配
- `azure-openai-responses.ts`：Azure OpenAI Responses 适配
- `cloudflare.ts`：Cloudflare 相关 provider
- `faux.ts`：测试/本地假 provider
- `register-builtins.ts`：注册默认 provider
- `transform-messages.ts`：跨 provider message 变换
- `openai-prompt-cache.ts`：OpenAI prompt cache 相关辅助
- `simple-options.ts`：简化选项整理
- `github-copilot-headers.ts`：Copilot 请求头辅助

#### 关键文件补充

- `providers/register-builtins.ts`：把内建 provider 注册进全局 registry，通常是应用启动时的隐式入口
- `providers/openai-responses.ts`：OpenAI Responses 主要实现，理解 provider 兼容层时优先看这里
- `providers/openai-completions.ts`：旧式 OpenAI 兼容实现，很多 provider shim 会参考它
- `providers/anthropic.ts`：Anthropic 专用流式实现和兼容逻辑
- `providers/google.ts`：Google Generative AI 的主实现
- `providers/google-shared.ts`：Google / Vertex 共享的消息和 thinking 逻辑
- `providers/google-vertex.ts`：Vertex AI 适配层
- `providers/amazon-bedrock.ts`：Bedrock 适配与签名/传输差异处理
- `providers/openai-codex-responses.ts`：Codex 订阅/OAuth 相关 provider 逻辑
- `providers/faux.ts`：测试用假 provider，适合理解接口最小实现

### `packages/ai/src/utils/`

provider 和流式协议的基础工具层。

- `event-stream.ts`：事件流封装
- `json-parse.ts`：流式 JSON 解析
- `validation.ts`：工具/参数校验
- `overflow.ts`：上下文溢出处理
- `hash.ts`：缓存或标识哈希
- `headers.ts`：请求头处理
- `sanitize-unicode.ts`：Unicode 清理
- `node-http-proxy.ts`：Node HTTP 代理支持
- `oauth/`：OAuth PKCE、device code、provider-specific login 流程

#### 关键文件补充

- `utils/event-stream.ts`：流式事件协议的底层封装，理解 `stream()` 的返回值时先看这里
- `utils/validation.ts`：tool/schema 参数校验的基础设施
- `utils/oauth/index.ts`：OAuth provider 总入口，CLI 登录流程通常从这里起步
- `utils/oauth/device-code.ts`：device code 登录流程
- `utils/oauth/pkce.ts`：PKCE 相关认证辅助

### `packages/ai/scripts/`

生成模型/图像模型数据和测试辅助脚本。

- `generate-models.ts`
- `generate-image-models.ts`
- `generate-test-image.ts`

### `packages/ai/test/`

主要验证 provider 协议、兼容层和边界条件。

- 覆盖不同 provider 的转接逻辑
- 覆盖 streaming、tool call、oauth、cache、thinking 等行为

---

## 4. `packages/tui`

终端 UI 组件库。这个包不关心模型和 session，只关心“如何在终端上稳定地画出来并接收输入”。

### `packages/tui/src/index.ts`

对外总出口。

- 导出 `TUI`、`Terminal`
- 导出组件、键盘、图片、自动补全、工具函数

### `packages/tui/src/tui.ts`

核心 UI 容器和渲染器。

- 负责 differential rendering
- 管理 focus、overlay、输入分发
- 是整个 TUI 的主控类

### `packages/tui/src/terminal.ts`

终端抽象与进程终端实现。

- 统一不同终端输入输出接口
- 作为 `TUI` 的底层依赖

### `packages/tui/src/terminal-image.ts`

终端图片支持。

- 处理 Kitty / iTerm2 图片协议
- 负责图片尺寸、占位和回退

### `packages/tui/src/keys.ts`

键盘输入解析与匹配。

- 负责按键编码解析
- 支持 Kitty key protocol

### `packages/tui/src/keybindings.ts`

键位绑定与冲突管理。

- 统一默认快捷键
- 支持运行时变更和查询

### `packages/tui/src/autocomplete.ts`

输入联想与路径/命令补全。

- 给编辑器和输入框提供候选项

### `packages/tui/src/components/`

所有基础 UI 组件。

- `text.ts`：文本渲染
- `truncated-text.ts`：截断文本
- `input.ts`：单行输入
- `editor.ts`：多行编辑器
- `markdown.ts`：markdown 渲染
- `select-list.ts`：选择列表
- `settings-list.ts`：设置项列表
- `loader.ts` / `cancellable-loader.ts`：加载状态
- `image.ts`：图片渲染
- `box.ts`：容器和背景
- `spacer.ts`：空白占位

#### 关键文件补充

- `components/editor.ts`：最重要的输入组件之一，理解 pi 的编辑体验优先看这里
- `components/input.ts`：单行输入基础，很多交互控件会复用
- `components/select-list.ts`：模型、session、设置等选择器的底层组件
- `components/markdown.ts`：消息渲染和说明文本的基础
- `components/image.ts`：终端图片显示入口
- `components/settings-list.ts`：设置面板的核心列表逻辑

### `packages/tui/src/utils.ts`

底层文本和宽度处理工具。

- 负责可见宽度、wrap、ANSI 处理
- 是大多数组件的基础依赖

#### 关键文件补充

- `utils.ts`：宽度计算和 ANSI 处理的公共基建，很多 layout bug 会回到这里排查
- `stdin-buffer.ts`：处理批量输入和粘贴分片，和大段输入/粘贴行为相关
- `terminal-image.ts`：和图片协议、终端能力检测直接相关
- `tui.ts`：虽然前面单独列过，但它仍然是整个包最核心的单点入口

### `packages/tui/src/kill-ring.ts`、`undo-stack.ts`、`stdin-buffer.ts`

编辑器/输入行为基础设施。

- 剪切环、撤销栈、stdin 分片
- 主要服务于 `input.ts` / `editor.ts`

### `packages/tui/test/`

覆盖渲染、输入、宽度、光标、选择器、图片等行为。

- 这部分很适合反向理解各组件设计边界

---

## 5. `packages/agent`

通用 agent 运行时。它比 `ai` 高一层，负责“怎么跑 agent loop、怎么组织消息、怎么把 context 和 tool 调起来”。

### `packages/agent/src/index.ts`

对外总出口。

- 导出 `Agent`
- 导出低层 loop、harness、session 工具、proxy、types

### `packages/agent/src/agent.ts`

`Agent` 类本体，属于上层运行时对象。

- 持有当前 `AgentState`
- 维护 `steeringQueue` / `followUpQueue`
- 负责把 `AgentLoopConfig` 组装成一次完整运行
- 提供 `subscribe()`、`prompt()`、`continue()` 等对外动作

#### 关键点

- 这是“业务对象”，不是纯 loop
- 状态、事件、工具执行、消息队列都在这里汇总
- 如果要理解一次 agent 交互的生命周期，优先看这里

### `packages/agent/src/agent-loop.ts`

低层循环引擎，负责真正的 turn 处理。

- `runAgentLoop()` / `runAgentLoopContinue()`：外层入口
- `runLoop()`：主循环
- `streamAssistantResponse()`：把 `AgentMessage[]` 转成 LLM `Message[]` 并拉流
- `executeToolCalls()`：分发工具执行
- `executeToolCallsSequential()` / `executeToolCallsParallel()`：两种 tool 执行模式

#### 关键点

- 这里定义了 agent 的 turn 语义
- `turn_start` / `turn_end` / `agent_end` 的边界要先看这里
- tool call 的预处理、执行、收口都在这里完成

### `packages/agent/src/types.ts`

运行时协议层类型定义。

- `AgentLoopConfig`：低层 loop 依赖的完整配置
- `BeforeToolCallContext` / `AfterToolCallContext`
- `BeforeToolCallResult` / `AfterToolCallResult`
- `ToolExecutionMode` / `QueueMode`
- `AgentLoopTurnUpdate` / `ShouldStopAfterTurnContext`

#### 关键点

- 这是理解扩展点最直接的入口
- 读完这个文件，基本就能知道 loop 支持哪些钩子
- 许多高阶行为实际上是通过这些 hook 注入的

### `packages/agent/src/agent.ts`

`Agent` 类本体。

- 维护当前 agent state
- 管理消息队列、follow-up、steering
- 调用低层 loop 并处理生命周期事件

### `packages/agent/src/agent-loop.ts`

最底层的 agent 循环。

- 负责 prompt -> LLM -> tool call -> follow-up 的循环
- 处理 `turn_start` / `turn_end` / `agent_end`
- 是理解 agent 行为的关键入口

### `packages/agent/src/types.ts`

agent 运行时类型系统。

- tool call、before/after hook、queue mode、loop config 等
- 这里能快速看出 loop 支持哪些扩展点

### `packages/agent/src/harness/`

测试/仿真层。

- `agent-harness.ts`：可控环境下的 agent harness
- `session/`：session 存储和回放
- `compaction/`：压缩与摘要
- `messages.ts`：消息转换
- `prompt-templates.ts`：提示模板
- `skills.ts`：技能发现和加载
- `system-prompt.ts`：系统提示构造

#### 关键文件补充

- `harness/agent-harness.ts`：测试和仿真最重要的入口，适合理解 agent 行为的可控版本
- `harness/compaction/compaction.ts`：上下文压缩主逻辑
- `harness/compaction/branch-summarization.ts`：分支摘要生成逻辑
- `harness/session/session.ts`：session 树和消息回放的核心抽象

### `packages/agent/src/harness/session/session.ts`

session 抽象和树状上下文构建。

- `buildSessionContext()`：把树状 session entries 转成 LLM 可用上下文
- `Session`：持久化 session 的高层封装
- `appendMessage()` / `appendCompaction()` / `appendCustomEntry()`：把不同 entry 写回存储
- `moveTo()`：切换叶子节点/分支

#### 关键点

- 这是 session 树和消息流之间的转换层
- 对理解“分支”“压缩”“回放”尤其重要

### `packages/agent/src/harness/agent-harness.ts`

可控测试环境下的 agent runtime。

- 用于把 `agent-loop` 放进可测的仿真环境
- 管理 session、资源、工具和事件订阅
- 适合看 agent 行为在测试里是怎么被驱动的

### `packages/agent/src/harness/compaction/compaction.ts`

上下文压缩主逻辑。

- 计算 token
- 判断是否需要压缩
- 生成压缩摘要
- 决定切点和保留范围

### `packages/agent/src/harness/compaction/branch-summarization.ts`

分支摘要生成。

- 把 branch 结构整理成摘要输入
- 主要服务于 session 分支导航和上下文压缩

### `packages/agent/src/proxy.ts`

代理/转发相关能力。

- 用于把流式调用或运行环境转成另一种 transport

### `packages/agent/src/node.ts`

Node 环境入口。

- 适合 Node 专用场景的适配层

### `packages/agent/src/harness/session/`

session 持久化与结构化树管理。

- `session.ts`：session 抽象
- `jsonl-storage.ts` / `jsonl-repo.ts`：JSONL 持久化
- `memory-storage.ts` / `memory-repo.ts`：内存实现
- `repo-utils.ts`：仓储辅助
- `uuid.ts`：id 生成

### `packages/agent/test/`

主要验证 loop、harness、session、compaction 和集成行为。

- 这部分适合用来理解设计意图和边界条件

---

## 6. `packages/coding-agent`

仓库里的最终用户产品层，也是最复杂的一层。它把 `ai`、`agent` 和 `tui` 组合成一个完整 CLI。

### `packages/coding-agent/src/index.ts`

对外 SDK/库入口。

- 导出 session、runtime、tools、extensions、settings、model registry 等核心能力
- 既可作为 CLI 核心，也可作为嵌入式 SDK

#### 关键点

- 这是上层“SDK 入口”
- 如果要给外部程序嵌入 pi，通常先看这里

### `packages/coding-agent/src/cli.ts`

真正的命令行入口。

- 初始化进程环境
- 配置 HTTP dispatcher
- 调用 `main()`

#### 关键点

- 这里很薄，几乎不做业务
- 主要是 Node 进程启动和环境准备

### `packages/coding-agent/src/main.ts`

CLI 主控制流。

- 解析参数
- 选择 mode（interactive / print / json / rpc）
- 组装 session / settings / model / extension / UI
- 是理解整个产品运行链路的第一入口

#### 关键点

- 这是 CLI 的总编排器
- 参数解析、session 选择、mode 分发、服务装配都从这里开始
- 如果想看“启动时到底先做什么”，先看这里

### `packages/coding-agent/src/config.ts`

路径和版本相关配置。

- 管理 agent dir、session dir、包目录、版本信息
- 是大量模块共享的基础配置源

#### 关键点

- 路径约定、版本和安装位置都在这里统一
- 许多“全局目录”问题会回到这里

### `packages/coding-agent/src/core/`

最重要的核心业务层。

- `agent-session.ts`：核心 session 生命周期与消息流
- `agent-session-runtime.ts`：runtime 抽象
- `agent-session-services.ts`：服务构建与依赖装配
- `sdk.ts`：程序化使用入口
- `model-registry.ts`：模型与 provider 配置加载
- `settings-manager.ts`：全局/项目设置
- `session-manager.ts`：session 结构化树和持久化
- `resource-loader.ts`：skills/prompts/themes/context files 加载
- `extensions/`：扩展系统
- `tools/`：内建工具定义和文件操作
- `export-html/`：会话导出 HTML
- `auth-storage.ts` / `auth-guidance.ts`：认证和提示
- `compaction/`：上下文压缩
- `messages.ts`：session/agent 消息转换
- `slash-commands.ts`：命令系统
- `prompt-templates.ts` / `skills.ts` / `system-prompt.ts`

#### 关键文件补充

- `core/agent-session.ts`：整个 CLI 的业务心脏，负责把 session、tool、event、compaction 串起来
- `core/agent-session-runtime.ts`：把 runtime 服务组合成可执行上下文
- `core/agent-session-services.ts`：组装 auth/model/session/settings/resource 等服务
- `core/model-registry.ts`：模型发现、配置、OAuth 与 provider registration 的中心
- `core/session-manager.ts`：session 文件结构、树、分支、回放和持久化
- `core/settings-manager.ts`：全局/项目设置读取、合并、写回和锁控制
- `core/resource-loader.ts`：加载 skills、prompts、themes、context files
- `core/sdk.ts`：给外部程序调用的主 SDK 接口
- `core/slash-commands.ts`：`/login`、`/model`、`/settings` 等命令定义
- `core/tools/index.ts`：内建工具工厂和总装配
- `core/extensions/loader.ts`：扩展加载入口
- `core/extensions/runner.ts`：扩展运行时与事件派发入口
- `core/export-html/index.ts`：会话导出 HTML 的主入口

### `packages/coding-agent/src/core/agent-session.ts`

最核心的业务文件之一。

- 管理单个 session 的生命周期
- 把 `Agent`、`SessionManager`、`SettingsManager`、`ResourceLoader` 串起来
- 负责 prompt、事件、tool 执行、compaction、branch、fork、tree、resume 等行为

#### 关键点

- 这是 CLI 真正“会做事”的地方
- 交互模式、print 模式、RPC 模式最终都依赖它
- 若要理解一次消息如何进 session、如何触发工具、如何落盘，先看这里

### `packages/coding-agent/src/core/agent-session-runtime.ts`

运行时重绑定层。

- 在 cwd / session 切换时重建服务
- 负责 runtime teardown / re-create / rebind
- 处理 `new`、`resume`、`fork` 一类切换场景

#### 关键点

- 这里解决的是“当前会话上下文变了，怎么安全替换 runtime”
- 和 UI 解绑/重绑的时机关系很大

### `packages/coding-agent/src/core/agent-session-services.ts`

服务组装层。

- 创建 `AuthStorage`、`SettingsManager`、`ModelRegistry`、`ResourceLoader`
- 处理 extension flags 和 provider registrations
- 输出一组 cwd-bound services，供 session 创建使用

#### 关键点

- 这是把外部依赖装进 runtime 的入口
- 如果要看“为什么某些资源在切 cwd 后重新加载”，从这里开始

### `packages/coding-agent/src/core/model-registry.ts`

模型和 provider 配置中心。

- 读取 built-in 和 custom models
- 处理 `models.json`
- 处理 provider overrides、compat、headers、auth
- 注册 API provider 和 OAuth provider

#### 关键点

- 这是模型发现和 provider 兼容层的核心
- `auth.json` / `models.json` 相关行为大多经由这里

### `packages/coding-agent/src/core/settings-manager.ts`

全局和项目设置管理。

- 读取、合并、锁定、写回 settings
- 区分 global / project scope
- 处理 compaction、retry、theme、terminal、images、sessionDir 等设置

#### 关键点

- 这是配置系统的事实来源
- 当行为看起来“被配置影响了”，先查这里

### `packages/coding-agent/src/core/resource-loader.ts`

资源发现和加载。

- 加载 skills、prompt templates、themes、agents files、system prompt
- 合并 global / project / package / extension 资源
- 向 session/runtime 提供统一资源视图

#### 关键点

- 这是“可扩展内容”入口
- AGENTS.md、skills、prompts、themes 都会经过这里

### `packages/coding-agent/src/core/slash-commands.ts`

内建 slash command 索引。

- 定义 `/settings`、`/model`、`/session`、`/tree`、`/login` 等命令
- 和扩展/skills 提供的命令一起构成命令系统

#### 关键点

- 这是命令体系的目录页
- 先看这里能快速知道 CLI 支持哪些标准动作

### `packages/coding-agent/src/modes/`

不同运行模式。

- `interactive/interactive-mode.ts`：主交互 UI
- `print-mode.ts`：文本/JSON 打印模式
- `rpc/`：进程集成模式

### `packages/coding-agent/src/modes/print-mode.ts`

非交互输出模式。

- 把 session/消息流转成纯文本或 JSON 输出
- 适合脚本化调用

### `packages/coding-agent/src/modes/rpc/`

RPC 进程协作模式。

- `rpc-mode.ts`：RPC 主流程
- `rpc-client.ts`：RPC 客户端
- `jsonl.ts`：JSONL 协议
- `rpc-types.ts`：RPC 协议类型

### `packages/coding-agent/src/modes/interactive/components/`

交互 UI 的组件集合。

- model / session / settings / theme / extension / thinking / footer / message render 相关组件
- 这里基本覆盖了 CLI 界面的大部分视觉和交互逻辑

#### 关键文件补充

- `modes/interactive/interactive-mode.ts`：交互模式主流程，理解 UI 如何和 session 联动优先看这里
- `modes/interactive/components/assistant-message.ts`：assistant 消息渲染
- `modes/interactive/components/user-message.ts`：用户消息渲染
- `modes/interactive/components/tool-execution.ts`：tool 执行展示
- `modes/interactive/components/footer.ts`：底部状态栏
- `modes/interactive/components/model-selector.ts`：模型选择器
- `modes/interactive/components/session-selector.ts`：session 选择器
- `modes/interactive/components/settings-selector.ts`：设置面板入口
- `modes/interactive/components/extension-selector.ts`：扩展管理入口

### `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

交互 UI 总编排。

- 负责 TUI 的整体布局、输入、状态栏、消息区、编辑器
- 把 `AgentSessionRuntime` 的状态映射到界面
- 连接 slash commands、selector、overlay、footer、autocomplete 等组件

#### 关键点

- 这是用户真正看到的主界面控制器
- 如果是 UI 行为问题，优先看这里和其组件

### `packages/coding-agent/src/core/tools/`

内建工具实现。

- `read.ts` / `write.ts` / `edit.ts` / `bash.ts`
- `find.ts` / `grep.ts` / `ls.ts`
- `file-mutation-queue.ts`：文件变更串行化
- `tool-definition-wrapper.ts`：把工具定义包装成 session/runtime 可用形式

#### 关键文件补充

- `core/tools/bash.ts`：shell 执行工具，权限和输出处理通常从这里看
- `core/tools/edit.ts`：文本编辑工具
- `core/tools/edit-diff.ts`：diff 驱动的编辑辅助
- `core/tools/read.ts`：文件读取工具
- `core/tools/write.ts`：文件写入工具
- `core/tools/find.ts` / `grep.ts` / `ls.ts`：检索类工具
- `core/tools/file-mutation-queue.ts`：避免并发文件修改冲突

### `packages/coding-agent/src/core/tools/bash.ts`

Shell 工具实现。

- 执行命令
- 处理 spawn、环境、输出和错误
- 常和权限、平台差异一起出现问题

### `packages/coding-agent/src/core/tools/edit.ts`

编辑工具实现。

- 面向 LLM 的文本编辑入口
- 和 diff、write、file mutation queue 密切相关

### `packages/coding-agent/src/core/tools/read.ts`

文件读取工具。

- 处理文件读取、裁剪和返回结果格式

### `packages/coding-agent/src/core/tools/write.ts`

文件写入工具。

- 负责写文件和返回确认结果

### `packages/coding-agent/src/core/tools/find.ts`、`grep.ts`、`ls.ts`

检索工具组。

- `find.ts`：路径/文件查找
- `grep.ts`：内容搜索
- `ls.ts`：目录枚举

### `packages/coding-agent/src/core/tools/tool-definition-wrapper.ts`

工具定义包装层。

- 把 `AgentTool` 和 session/runtime 工具定义对接起来
- 统一工具元信息和运行时行为

### `packages/coding-agent/src/core/extensions/`

扩展系统核心。

- `loader.ts`：发现和加载扩展
- `runner.ts`：扩展执行和生命周期
- `wrapper.ts`：工具/命令封装
- `types.ts`：扩展 API 和事件类型

#### 关键文件补充

- `core/extensions/loader.ts`：扩展发现、读取和注册
- `core/extensions/runner.ts`：扩展事件分发、生命周期和错误处理
- `core/extensions/wrapper.ts`：把 tool / command 包成运行时可消费的形式
- `core/extensions/types.ts`：理解扩展系统契约的最重要入口

### `packages/coding-agent/src/core/extensions/loader.ts`

扩展加载总入口。

- 负责发现、加载、虚拟模块注入和 alias 处理
- Bun binary / Node 开发模式都依赖它

### `packages/coding-agent/src/core/extensions/runner.ts`

扩展运行时和事件调度核心。

- 负责扩展生命周期
- 负责事件 emit / handler 调用 / shortcut 冲突控制
- 连接 UI、session、model registry、command 系统

### `packages/coding-agent/src/core/extensions/types.ts`

扩展系统契约定义。

- 定义 extension、runtime、command、tool、event、UI API 的类型
- 读这个文件基本能知道扩展系统有哪些能力

### `packages/coding-agent/src/core/export-html/`

session 导出 HTML 的实现。

- `index.ts`：导出入口
- `template.html` / `template.css` / `template.js`：静态模板
- `ansi-to-html.ts`：ANSI 转 HTML
- `tool-renderer.ts`：工具输出渲染

#### 关键文件补充

- `core/export-html/index.ts`：HTML 导出主流程，负责把 session 渲染成可分享页面
- `core/export-html/template.html`：导出页骨架
- `core/export-html/template.css`：导出页样式
- `core/export-html/template.js`：导出页交互脚本
- `core/export-html/ansi-to-html.ts`：将终端 ANSI 输出转为 HTML

### `packages/coding-agent/src/core/messages.ts`

session 消息和自定义消息构造。

- 负责把各种内部状态转成可写入 session 的消息
- 和导出、回放、扩展消息渲染都有关

### `packages/coding-agent/src/core/session-manager.ts`

session 树和持久化的中心。

- 管理 JSONL session 文件
- 支持 fork / tree / branch / label / compaction / migrate
- 构建 session context

#### 关键点

- 如果要理解“会话历史如何保存和回放”，这里是主文件
- 很多 UI 和 command 行为都最终落到这里

### `packages/coding-agent/src/utils/`

通用底层工具。

- 文件系统、路径、shell、git、clipboard、image、highlight、frontmatter、version check 等
- 很多 CLI 能力都在这里落地

#### 关键文件补充

- `utils/paths.ts`：路径规范化和解析，很多跨平台问题都绕不开
- `utils/git.ts`：git 相关辅助
- `utils/shell.ts`：shell 命令封装
- `utils/clipboard.ts` / `clipboard-native.ts` / `clipboard-image.ts`：剪贴板能力
- `utils/image-resize.ts` / `image-convert.ts`：图片预处理
- `utils/frontmatter.ts`：prompt/skill/frontmatter 解析
- `utils/version-check.ts`：版本检查与更新相关逻辑
- `utils/tools-manager.ts`：工具管理辅助

### `packages/coding-agent/examples/`

扩展示例和 SDK 示例。

- `examples/sdk/`：SDK 用法示例
- `examples/extensions/`：扩展示例集合
- 适合用来理解扩展系统预期形态

### `packages/coding-agent/docs/`

用户文档与能力说明。

- `quickstart`、`usage`、`extensions`、`skills`、`settings`、`rpc`、`themes`、`models` 等
- 是理解产品面向用户暴露能力的好入口

### `packages/coding-agent/test/`

覆盖 CLI、session、runtime、extension、tools、export HTML、RPC、interactive mode 的大量回归测试。

- 如果后续要定位行为变化，这里通常能最快找到相关场景

---

## 7. 推荐的阅读顺序

如果后面要继续深入理解代码，建议按这个顺序看：

1. `packages/coding-agent/src/main.ts`
2. `packages/coding-agent/src/core/agent-session.ts`
3. `packages/agent/src/agent.ts`
4. `packages/agent/src/agent-loop.ts`
5. `packages/ai/src/stream.ts`
6. `packages/ai/src/api-registry.ts`
7. 再回头看 `packages/coding-agent/src/core/extensions/` 和 `packages/coding-agent/src/core/tools/`

这样能先把“产品入口 -> 会话运行时 -> agent loop -> provider 层”的链路串起来，再看扩展和工具细节会更容易。
