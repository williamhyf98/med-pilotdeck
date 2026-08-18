# PilotDeck 框架调研与医疗项目特性接入设计

## 1. 文档说明

### 1.1 文档目的

本文用于支持以下工作：

1. 系统说明 PilotDeck 的定位、技术栈、运行架构、目录结构、核心模块和扩展机制。
2. 区分 PilotDeck 已实现能力、部分接线能力和仅声明能力，避免依据 README 或类型声明做错误判断。
3. 完整梳理远端医疗项目的用户功能、后端模块、数据和部署依赖。
4. 建立远端医疗功能与 PilotDeck 承载层之间的映射。
5. 形成后续分阶段开发、验证和验收的统一依据。

### 1.2 调研范围

- PilotDeck 本地仓库：`D:\projects\PilotDeck-main`
- 远端参考项目：`node12:/local_data/huojianfan/med-integration-offline-military`
- 调研日期：2026-08-05
- PilotDeck 版本：`0.1.0`
- Gateway 协议版本：`1.0`
- PilotDeck 许可证：AGPL-3.0

远端项目仅进行了目录列举、文本搜索和源码读取。未修改远端文件，未运行项目脚本、构建、测试或服务，未读取和输出秘密值。

### 1.3 状态标记

PilotDeck 能力使用以下状态：

- **已实现**：存在明确运行链路，相关模块已经接线。
- **部分接线**：存在实现，但入口、协议、UI、配置或测试尚不完整。
- **仅声明或示例**：存在类型、manifest 字段、配置项、README 描述或示例，但没有完整运行时消费链路。

远端医疗功能使用以下状态：

- **现有界面使用**：当前静态 bundle 确实调用，首期兼容必须覆盖。
- **后端存在但界面未使用**：接口或模块存在，但当前两个静态 bundle 没有调用。
- **占位或缺依赖**：存在入口或代码，但缺少语料、模型、数据、脚本或运行环境。

## 2. 核心结论

### 2.1 产品关系

目标系统应采用以下关系：

- **PilotDeck 是唯一主体和 Agent OS 运行时。**
- 远端医疗项目作为 `Medical Feature Pack` 接入 PilotDeck。
- Dialogue 与 Med-trauma 两套现有页面作为 PilotDeck 中的医疗应用入口保留。
- 医疗 RAG、附件解析、DICOM、ECG、表格、3D 和战创伤规则作为 MCP 工具或 Python sidecar 能力接入。
- 所有生成模型请求最终由 PilotDeck Gateway、AgentLoop 和 ModelRuntime 管理。
- 远端项目原有 Node Gateway、聊天会话运行时和模型直调链路不继续作为系统主体。

### 2.2 PilotDeck 成熟度判断

PilotDeck 已经具备垂直领域二次开发所需的主要底座：

- Gateway 与统一流式协议
- AgentSession、TurnRunner 和 AgentLoop
- 多模型 Provider 与 Smart Router
- 内置工具、MCP、权限和用户追问
- WorkSpace 级会话、扩展和记忆隔离
- Web、CLI、TUI 和多种 IM Channel
- JSONL transcript、文件产物和会话恢复
- Skill、Plugin、Command、Hook
- Background Task、Cron 和 Always-on

但当前仍处于 `0.1.0` 阶段，以下能力尚不完整：

- `plugin.json` 中的 `agents` 字段尚未真正加载。
- 每个 HTTP 请求或 Turn 动态选择 Agent Profile 的能力缺失。
- 每个 Turn 动态选择模型、完整采样参数和工具白名单的能力不完整。
- LSP、Marketplace、MCPB、品牌主题等能力主要停留在声明或示例阶段。
- 自定义 Memory Provider 尚未形成公开可插拔链路。
- 项目级 `pilotdeck.yaml` 合并路径存在代码基础，但当前主加载链路不能作为可靠能力依赖。
- UI 插件和 Agent 引擎插件是两套不同机制，且默认使用同名插件目录。
- 默认认证更适合本地单用户环境，不是完整多租户平台。

### 2.3 医疗项目迁移判断

远端医疗项目不是通用 Agent 系统，而是由以下部分组成的固定业务应用：

- Node 静态资源和反向代理 Gateway
- Dialogue 有状态医疗聊天后端
- Med-trauma 无状态战创伤研判后端
- 两套 React/Vite 编译产物
- SQLite、附件目录、JSONL RAG 语料和 NPY 向量矩阵
- 外部 OpenAI-compatible 生成模型
- 外部多模态 embedding 服务
- 可选 M3D、病例目录和 3D 数据集

因此不应将远端单体后端直接作为 PilotDeck 内核，而应保留其业务算法和浏览器契约，替换其会话、模型、权限和运行时边界。

## 3. PilotDeck 定位

### 3.1 框架定义

PilotDeck 是面向有状态 Agent 应用的运行平台。它负责统一管理：

- Agent 生命周期
- 模型请求与路由
- 工具和 MCP 调用
- 会话与上下文
- 权限与用户确认
- 记忆与压缩
- 多终端接入
- 后台任务与定时任务
- 扩展发现和热重载

它不是：

- 大模型本身
- 医疗知识库
- 单一工作流应用
- Python Agent 框架
- 完整的多租户 SaaS 平台
- 强隔离容器或虚拟机系统

### 3.2 适合承载的应用

PilotDeck 适合承载以下类型的应用：

- 需要多轮会话和持久化历史的 Agent
- 需要调用文件、命令、搜索、MCP 等工具的 Agent
- 需要根据任务选择模型或故障降级的 Agent
- 需要 Web、CLI、TUI、飞书等多入口共享会话的 Agent
- 需要定时或无人值守执行的 Agent
- 需要通过 Skill、Plugin 和 Hook 注入领域能力的应用

## 4. 技术栈与运行环境

### 4.1 核心技术栈

- 核心语言：TypeScript
- 运行环境：Node.js `>=22.13.0 <23`
- Web 前端：React 19
- 前端构建：Vite
- UI Server：Node.js + Express
- Gateway 通信：WebSocket
- 辅助接口：REST
- Agent 会话存储：JSONL
- UI 认证存储：SQLite
- Agent Memory：EdgeClaw Memory Core + SQLite
- MCP：`@modelcontextprotocol/sdk`
- 配置：YAML、JSON、环境变量
- Skill、Command、Profile 文本：Markdown
- 容器部署：Docker Compose

### 4.2 Python 的位置

Python 不是 PilotDeck 核心运行时的一部分，但可以通过以下方式接入：

- stdio MCP Server
- streamable HTTP MCP Server
- 仅监听 localhost 的 sidecar 服务
- UI Server 的受保护反向代理

医疗项目中的 PDF、DICOM、WFDB、NumPy、NIfTI 和图像处理适合保留在 Python sidecar，而 Agent 会话和模型循环仍由 PilotDeck 管理。

## 5. 运行架构

### 5.1 双进程主体

PilotDeck 的标准 Web 运行形态至少包含两个进程：

```text
浏览器、CLI、TUI、IM Channel
              │
              ▼
PilotDeck UI Server / Channel Adapter
              │
              │ WebSocket / InProcess Gateway
              ▼
PilotDeck Gateway
  ├─ ProjectRuntimeRegistry
  ├─ SessionRouter
  ├─ AgentSession
  ├─ TurnRunner
  ├─ AgentLoop
  ├─ RouterRuntime
  ├─ ModelRuntime
  ├─ ToolRuntime
  ├─ McpRuntime
  ├─ Memory
  ├─ Cron
  └─ Always-on
```

两个主要进程分别为：

1. **Gateway 进程**
   - 默认端口：`18789`
   - 入口：`src/cli/pilotdeck.ts`
   - 承载 Agent、模型、工具、会话、记忆、Cron 和 Always-on

2. **UI Server 进程**
   - 默认端口：`3001`
   - 入口：`ui/server/index.js`
   - 承载 React 静态资源、认证、REST API 和 Gateway bridge

`ui/server/pilotdeck-bridge.js` 明确要求 UI Server 不得创建第二套 Gateway，否则会产生会话 transcript 和权限状态分叉。

### 5.2 开发环境

- Gateway：默认 `18789`
- Express UI Server：默认 `3001`
- Vite 开发服务：通常为 `5173`

生产部署中，浏览器只应访问 UI Server。Gateway 默认绑定 localhost，由 UI Server 或本机 Channel 访问。

## 6. 核心概念模型

### 6.1 WorkSpace 与 Project

README 中的 WorkSpace 在代码中主要表现为：

- `projectRoot`
- `projectKey`
- Agent 的 `cwd`

WorkSpace 决定：

- Agent 工作目录
- 项目指令
- 项目 Plugin 和 Skill
- 项目 MCP 配置
- 会话存储归属
- 记忆隔离

WorkSpace 是逻辑和路径隔离，不等于容器级安全隔离。

### 6.2 Session、Turn 与 Run

- **Session**：一次持续对话，对应 `sessionKey` 和 `AgentSession`。
- **Turn**：用户提交一条消息到 Agent 完成回复的一轮，对应 `turnId`。
- **Run**：Gateway 侧一次流式执行，对应 `runId`。

当前 Gateway 将 `runId` 作为 Agent 层 `turnId` 使用。

每个 `sessionKey` 同一时间只允许一个 in-flight Turn。

### 6.3 Channel

Channel 是用户接入 PilotDeck 的入口，例如：

- Web
- CLI
- TUI
- 飞书
- 微信
- QQ
- 企业微信
- Telegram
- Discord
- Slack
- Webhook

不同 Channel 最终都转换为 Gateway `submit_turn`，从而复用同一 Agent 运行时。

### 6.4 Agent

PilotDeck 中的顶层 Agent 不是独立操作系统进程。它通常是 Gateway 进程内的 `AgentSession` 实例。

主要生命周期：

```text
SessionRouter.getOrCreate
  → AgentSession.submit
  → TurnRunner.run
  → AgentLoop.run
  → Model / Tool 多轮循环
  → Turn 完成
  → transcript 和 memory 维护
```

### 6.5 Tool 与 MCP

- Tool 是 Agent 可执行动作的统一抽象。
- 内置工具直接注册到 `ToolRegistry`。
- MCP Server 暴露的工具会转换为普通 PilotDeck Tool。
- 所有工具统一经过 `ToolRuntime`、权限检查和 Hook。

## 7. 一条消息的完整数据流

### 7.1 Web 消息链路

```text
用户输入
  → React UI
  → ui/server WebSocket
  → pilotdeck-bridge.runChatViaGateway
  → RemoteGateway.submitTurn
  → InProcessGateway.submitTurn
  → SessionRouter.getOrCreate
  → AgentSession.submit
  → TurnRunner.run
  → ContextRuntime 准备上下文
  → RouterRuntime 选择模型
  → AgentLoop 调用 ModelRuntime
  → 模型回复或发起 Tool Call
  → ToolRuntime 执行工具
  → 工具结果回到 AgentLoop
  → GatewayEvent 流回 UI
  → JSONL transcript 落盘
```

### 7.2 工具调用链路

```text
模型产生 tool_call
  → ToolRegistry 查找工具
  → PermissionRuntime 判断 allow / deny / ask
  → PreToolUse Hook
  → 输入 Schema 校验
  → Tool 执行
  → PostToolUse 或 PostToolUseFailure Hook
  → tool_result 写入 transcript
  → AgentLoop 继续推理
```

### 7.3 MCP 工具链路

```text
plugin.json 或 mcp.json
  → McpRuntime 读取配置
  → McpClient 建立 stdio 或 streamable HTTP 连接
  → 获取 MCP Tools Schema
  → 转换为 PilotDeck Tool
  → 注册到项目 ToolRegistry
  → AgentLoop 按普通工具调用
```

## 8. 仓库目录结构

### 8.1 根目录

- `src/`
  - PilotDeck Agent 引擎核心。
- `ui/`
  - React Web UI 和 Express bridge。
- `skills/`
  - 随仓库发布的 Skill 包。
- `products/`
  - 产品化定制模板。
- `tests/`
  - 引擎单元和集成测试。
- `scripts/`
  - 启动、配置 bootstrap、Node 版本检查等脚本。
- `docker-compose.yml`
  - 容器部署定义。
- `package.json`
  - Node 版本、workspace、构建、测试和 CLI 定义。

### 8.2 `src/` 模块

- `src/cli/`
  - CLI 入口、Gateway 装配、Server 启动。
- `src/gateway/`
  - Gateway 协议、WebSocket、会话路由和统一提交入口。
- `src/agent/`
  - AgentSession、TurnRunner、AgentLoop 和 Subagent。
- `src/model/`
  - 模型协议、Provider、流式响应和 thinking 适配。
- `src/router/`
  - TokenSaver、AutoOrchestrate、Fallback 和统计。
- `src/tool/`
  - ToolRegistry、ToolRuntime、内置工具。
- `src/mcp/`
  - MCP Client、Runtime 和 MCP 到 Tool 的桥接。
- `src/context/`
  - Prompt、上下文、附件、压缩、Token Budget 和 Memory。
- `src/session/`
  - transcript、metadata、会话恢复、分叉和文件历史。
- `src/extension/`
  - Plugin、Skill、Command、Hook 和贡献点。
- `src/pilot/`
  - `pilotdeck.yaml` 和路径约定。
- `src/permission/`
  - 工具权限决策。
- `src/lifecycle/`
  - 生命周期事件和 Hook 调度。
- `src/task/`
  - 会话内后台任务。
- `src/cron/`
  - 定时 Agent 任务。
- `src/always-on/`
  - 无人值守发现和执行循环。
- `src/adapters/`
  - CLI、TUI 和 IM Channel。
- `src/web/`
  - Gateway Web 客户端协议和会话消息投影。
- `src/telemetry/`
  - 可选遥测。

### 8.3 `ui/` 模块

- `ui/src/`
  - React 页面、状态管理、聊天组件、设置和工具展示。
- `ui/server/index.js`
  - Express 主入口、路由、静态文件、WebSocket 和进程生命周期。
- `ui/server/pilotdeck-bridge.js`
  - UI 与 Gateway 的唯一聊天执行桥。
- `ui/server/routes/`
  - 认证、项目、Skill、MCP、Plugin、Agent、Memory 等 API。
- `ui/server/database/`
  - 用户和 API Key 等 SQLite Schema。
- `ui/server/services/`
  - PilotDeck 配置和 Memory UI 服务。

### 8.4 `products/` 和 `skills/`

`products/_example` 提供产品定制示例：

- 产品 Plugin
- Hook
- Command
- 配置覆盖
- 品牌主题占位

`skills/` 提供随产品发布的标准 Skill。Skill 以 `SKILL.md` 为入口，可以包含辅助脚本和资源。

## 9. PilotDeck 功能全景

### 9.1 CLI 与 Server

状态：**已实现为主**

主要能力：

- `pilotdeck server`
- TUI
- 会话历史搜索
- Skill 迁移
- Gateway Channel 配置
- Cron 命令
- 更新命令
- 项目和会话管理
- 远程 Gateway 探测
- 全局网络代理

关键文件：

- `src/cli/pilotdeck.ts`
- `src/cli/createLocalGateway.ts`
- `src/cli/pilotdeckServer.ts`

### 9.2 Gateway

状态：**已实现**

主要能力：

- WebSocket 协议 `1.0`
- hello、request、event、notification 帧
- 流式 `submit_turn`
- abort、list、resume、new、close
- Cron、Skill、Always-on RPC
- 会话读取和分叉
- 单 Session Turn 互斥
- idle Session 驱逐
- 配置变化后的 dirty recreate
- Turn 超时
- Active Turn replay
- 权限总线
- 用户追问总线
- 附件转 Agent 输入

关键文件：

- `src/gateway/client/InProcessGateway.ts`
- `src/gateway/SessionRouter.ts`
- `src/gateway/server/GatewayServer.ts`
- `src/gateway/server/GatewayWsConnection.ts`
- `src/gateway/protocol/types.ts`

### 9.3 AgentSession、TurnRunner 与 AgentLoop

状态：**已实现**

主要能力：

- SessionStart、Setup、SessionEnd 生命周期
- 用户输入接收和 transcript 记录
- 模型和工具多轮循环
- Agent、Plan、Ask 三种运行模式
- 上下文溢出恢复
- 自动压缩
- Tool Call 修复
- 错误恢复和 circuit breaker
- 文件产物收集
- 自动会话标题
- 子 Agent
- 子 Agent 侧链 transcript

关键文件：

- `src/agent/session/AgentSession.ts`
- `src/agent/turn/TurnRunner.ts`
- `src/agent/loop/AgentLoop.ts`
- `src/agent/sub/SubAgentSession.ts`
- `src/agent/sub/builtinSubagentTypes.ts`

### 9.4 模型 Provider

状态：**已实现**

支持协议：

- OpenAI Chat Completions
- OpenAI Responses
- Anthropic Messages
- Google Gemini
- OpenAI-compatible Endpoint

主要能力：

- 流式输出
- 非流式完成
- 统一消息协议
- Tool Call
- 多模态消息
- 结构化输出
- Thinking/Reasoning
- 模型能力和 Token 上限目录
- Provider 错误归一化

关键文件：

- `src/model/ModelRuntime.ts`
- `src/model/protocol/canonical.ts`
- `src/model/providers/`
- `src/model/thinking/registry.ts`
- `src/model/catalog/`

当前限制：

- Canonical request 对远端医疗 UI 使用的全部采样参数支持不完整。
- 逐 Turn 模型选择未通过 Gateway 公开。

### 9.5 Smart Router

状态：**已实现**

主要能力：

- TokenSaver
- 任务难度判断
- 模型 Tier 选择
- AutoOrchestrate
- Fallback Chain
- Zero-usage Retry
- Cache-aware Switching
- Session Sticky
- Router Event JSONL
- Token 与成本统计
- 自定义 Router Contribution

关键文件：

- `src/router/RouterRuntime.ts`
- `src/router/tokenSaver/`
- `src/router/autoOrchestrate/`
- `src/router/fallback/`
- `src/router/config/schema.ts`

当前限制：

- 部分 Router UI 操作返回 501，配置仍需修改 YAML。
- 自定义 Router 主要面向程序化贡献，不是普通磁盘插件即可完成。

### 9.6 Thinking 与多模态

状态：**已实现**

主要能力：

- Thinking 开关和预算
- OpenAI、Anthropic、Google 不同 thinking 参数映射
- `reasoning_content` 解析
- `assistant_thinking_delta`
- 图片和附件进入 Turn
- 多模态能力检测
- 不支持目标模型时的媒体降级

### 9.7 Context 与 Prompt

状态：**已实现**

主要能力：

- 系统 Prompt 组装
- `PILOTDECK.md` 指令发现
- Plugin Command/Skill 列表注入
- 附件解析
- Token Budget
- Tool Result Budget
- Memory 上下文注入
- Context Overflow Recovery

关键文件：

- `src/context/DefaultContextRuntime.ts`
- `src/context/prompt/PromptAssembler.ts`
- `src/context/instructions/InstructionDiscovery.ts`
- `src/context/budget/`
- `src/context/attachment/`

### 9.8 Context Compaction

状态：**已实现**

主要能力：

- LLM 摘要压缩
- 自动压缩策略
- Micro Compaction
- Cached Micro Compaction
- Snip
- 压缩前后 Hook
- 压缩边界写入 transcript

关键文件：

- `src/context/compaction/CompactionEngine.ts`
- `src/context/compaction/MicroCompactionEngine.ts`
- `src/context/compaction/AutoCompactionPolicy.ts`

### 9.9 Memory

状态：**EdgeClaw 已实现，自定义 Provider 仅声明**

主要能力：

- 会话后记忆捕获
- 新 Turn 前记忆检索
- WorkSpace 级记忆隔离
- Dream、Index、Heartbeat 等维护
- Memory UI
- 导入、导出、回滚和管理

关键文件：

- `src/context/memory/EdgeClawMemoryProvider.ts`
- `src/context/memory/edgeclaw-memory-core/`
- `ui/server/routes/memory.js`

当前限制：

- 配置目前只接受 `edgeclaw`。
- 医疗场景不应默认开启跨会话长期记忆，必须先明确 PHI 保留策略。

### 9.10 内置工具

状态：**大部分已实现**

主要工具：

- 读取文件
- 写文件
- 编辑文件
- 搜索文件
- Glob
- Bash
- Execute Code
- Web Search
- Web Fetch
- 子 Agent
- Background Task
- Structured Output
- Ask User Question
- Enter/Exit Plan Mode
- Todo Write
- Read Skill
- Send Attachment
- Edit Notebook
- 获取时间
- 动态 MCP 工具
- Always-on 工具
- Cron 工具

部分能力依赖运行时注入，例如 Background Task、Read Skill、Agent、Always-on 和 Cron。

MCP Resource 的工具定义存在，但当前主 Gateway 装配链路未完整注册，视为**仅声明或部分接线**。

### 9.11 Tool Runtime、权限与用户追问

状态：**已实现**

主要能力：

- Tool Schema 校验
- 并发和串行 Tool Scheduler
- allow、deny、ask 权限规则
- default、plan、bypassPermissions 模式
- Session 级记忆授权
- Web 和 IM 权限确认
- `ask_user_question`
- Plan 完成确认
- Tool Audit
- 工具大结果 spill 到磁盘

关键文件：

- `src/tool/execution/ToolRuntime.ts`
- `src/tool/registry/`
- `src/permission/`
- `src/gateway/permission/`
- `src/gateway/elicitation/`

### 9.12 MCP

状态：**已实现**

支持：

- stdio
- streamable HTTP
- 多 Server 并发连接
- 项目级和全局配置
- Plugin 内声明
- per-session MCP
- 工具 Schema 自动注册
- UI MCP 管理

不支持或未完整接线：

- MCP SSE Transport
- MCP WebSocket Transport
- MCP Resources 在 Agent 内的完整工具入口

关键文件：

- `src/mcp/runtime/McpRuntime.ts`
- `src/mcp/client/McpClient.ts`
- `src/mcp/runtime/PluginToToolBridge.ts`

### 9.13 Engine Plugin

状态：**Hooks、Commands、Skills、MCP 已实现；部分字段未接线**

发现路径：

- `~/.pilotdeck/plugins/`
- `<project>/.pilotdeck/plugins/`
- 内置 Plugin

支持贡献：

- Commands
- Skills
- Hooks
- MCP Servers
- Router Contribution
- Permission Contribution

当前缺口：

- `agents` 字段已解析，但 `PluginLoader` 未加载。
- `outputStyles` 已加载和聚合，但没有明确消费方。
- `lspServers` 仅聚合，没有 LSP Runtime。
- Marketplace、git、zip、MCPB 安装返回 deferred 或未完成。

关键文件：

- `src/extension/plugins/protocol/manifest.ts`
- `src/extension/plugins/loading/PluginLoader.ts`
- `src/extension/plugins/runtime/PluginRuntime.ts`

### 9.14 Skill

状态：**已实现**

Skill 是带 YAML frontmatter 的 Markdown 能力说明。

运行方式：

1. Skill 被发现。
2. Prompt 中列出 Skill 名称和描述。
3. 模型调用 `read_skill`。
4. Skill 正文进入当前任务上下文。

Skill 适合承载：

- 业务操作规范
- 领域工作流
- 输出格式要求
- 工具选择指导
- 安全和合规规则

Skill 不适合承载重型可执行算法。此类能力应放入 MCP。

### 9.15 Command

状态：**已实现**

Command 以 Markdown 定义，通过 `/command` 触发。Command 正文不会无条件进入所有 Prompt，而是在用户触发时由 InputProcessor 转换为执行指令。

### 9.16 Hook

状态：**主要生命周期已实现，少数事件仅声明**

已实现的典型事件：

- SessionStart
- SessionEnd
- Setup
- UserPromptSubmit
- PreModelRequest
- PreToolUse
- PostToolUse
- PostToolUseFailure
- PermissionRequest
- PreCompact
- PostCompact
- ConfigChange
- WorktreeCreate
- WorktreeRemove
- Elicitation
- Subagent 生命周期

仅声明或待接线：

- Notification
- CwdChanged
- FileChanged

Hook 执行类型：

- command
- http
- callback
- agent
- prompt

### 9.17 UI Plugin

状态：**已实现**

UI Plugin 与 Engine Plugin 是两套机制。

UI Plugin 支持：

- React Tab
- 静态资源
- 可选 Node Server
- HTTP RPC Proxy
- WebSocket Proxy
- 进程启动和停止

注意事项：

- UI Plugin 使用另一套 manifest 字段。
- UI Plugin 和 Engine Plugin 默认位于同名目录，部署时必须区分。
- Python sidecar 不能直接复用当前只支持 Node 的 UI Plugin Process Manager，需要新增专用管理器或独立部署。

### 9.18 Channel Adapter

状态：**飞书、微信、QQ、企业微信较完整；其他通道需逐项验证**

一等启动支持：

- 飞书
- 微信
- QQ
- 企业微信

动态加载支持：

- Telegram
- Discord
- Slack
- Matrix
- Mattermost
- Signal
- WhatsApp
- BlueBubbles
- DingTalk
- Email
- SMS
- HomeAssistant
- Webhook
- API Server
- WeCom Callback

飞书具备专项权限、追问、实时回复和测试资产，适合作为企业 IM 首选入口。

### 9.19 Transcript、Artifact 与 File History

状态：**已实现**

主要能力：

- JSONL transcript
- Session Replay
- Session Resume
- Session Fork
- Compaction Boundary
- Subagent 侧链 transcript
- File Artifact 收集
- File History 备份
- Session Metadata
- Chat History 搜索
- Web 历史消息投影

默认目录：

```text
~/.pilotdeck/
  pilotdeck.yaml
  projects/<projectId>/
    .cwd
    chats/<sessionKey>.jsonl
    chats/<sessionKey>/subagents/
    tool-results/
    file-history/
  memory/
  plugins/
  skills/
  router/
  permissions.json
```

### 9.20 Background Task

状态：**已实现**

Background Task 用于当前会话内的长时间命令任务：

- task_create
- task_list
- task_output
- task_wait
- task_stop

它不同于 Cron 和 Always-on。

### 9.21 TaskMaster

状态：**部分接线**

TaskMaster 位于 UI 集成层：

- 检测 `.taskmaster`
- 检测 TaskMaster MCP
- 调用外部 `task-master` CLI
- WebSocket 广播

TaskMaster 不是 PilotDeck Agent 内核调度器。

### 9.22 Worktree

状态：**已实现**

主要能力：

- Git Worktree Provider
- Snapshot Copy Provider
- Workspace Provider Registry
- Worktree 创建和删除 Hook
- Always-on 任务工作区隔离

### 9.23 Always-on

状态：**已实现**

主要能力：

- 多项目运行
- Discovery Scheduler
- Busy、Cooldown、Budget、Dormant Gate
- Work Cycle
- Plan、Report、Workspace、Chat History 工具
- Session 专用权限和工具排除
- Apply 和 Rerun
- 运行历史和事件
- 配置热重载

### 9.24 Cron

状态：**已实现**

主要能力：

- 多项目 CronManager
- Gateway Cron RPC
- Agent Cron 工具
- IM 结果投递
- Cron Store

Cron Daemon 归 Gateway 进程所有，UI Server 不应启动第二套 Cron。

### 9.25 Web UI

状态：**主要功能已实现**

主要能力：

- 项目与 WorkSpace
- 会话和聊天
- 文件树
- Git 操作
- Shell/xterm
- 模型配置
- MCP 管理
- Skill 管理
- Plugin 管理
- Memory
- Permission
- Always-on
- TaskMaster
- Office/Spreadsheet 预览
- Router Stats

部分功能依赖外部软件，例如 LibreOffice、ClawHub CLI 和 TaskMaster CLI。

### 9.26 认证与 API

状态：**本地单用户场景已实现**

主要能力：

- SQLite 用户库
- 首次注册和登录
- JWT
- Token 自动刷新
- WebSocket Token
- External Agent API
- API Key
- SSE Agent API
- Gateway 独立 Token

当前限制：

- 默认本地认证可关闭。
- 注册流程偏单用户。
- 不具备完整多租户、组织、角色和资源所有权模型。

### 9.27 配置和热重载

状态：**主要能力已实现**

主要配置：

- `~/.pilotdeck/pilotdeck.yaml`
- 全局和项目 MCP
- 全局和项目 Plugin/Skill
- 环境变量

主要能力：

- Schema Version 1
- 文件监听
- Debounce
- Runtime Live Reload
- Next Request 生效
- Session Dirty Recreate
- Adapter 热重载
- Proxy 热重载

需要注意：

- 项目级 `pilotdeck.yaml` 不能作为已经稳定的覆盖机制依赖。
- 部分配置仍要求进程重启。

### 9.28 部署、可观测性和测试

状态：**基础能力已实现**

部署：

- install 脚本
- Docker Compose
- 数据卷
- Gateway 和 UI 双进程

可观测性：

- 可选 Telemetry
- Agent Loop Stage
- Error Event
- Router Event JSONL
- Router Stats
- Gateway Memory Diagnostics
- Channel Runtime Status
- UI `/health`

医疗和军用环境必须关闭默认外部 Telemetry，或将接收端替换为内网系统。

测试：

- 根目录约 58 个引擎 spec/test
- 覆盖 Agent、Gateway、Tool、Model、MCP、Context、Extension、Session 和部分 Channel
- UI 使用独立 Vitest
- 真实模型生命周期 E2E 需要显式环境变量

## 10. PilotDeck 二次开发层级

### 10.1 第一层：配置

适合：

- Provider
- 默认模型
- Router
- Memory
- Permission
- Channel
- Cron
- Always-on

风险最低。

### 10.2 第二层：Skill、Plugin、MCP、Hook

适合：

- 领域工作流
- 领域工具
- 审计
- 合规限制
- 外部服务连接

这是医疗功能接入的主要层。

### 10.3 第三层：UI 和 UI Server

适合：

- 独立业务页面
- 旧页面兼容
- REST/SSE 协议适配
- 静态资源
- 认证和 API Gateway

Dialogue 和 Med-trauma 现有页面应在此层接入。

### 10.4 第四层：PilotDeck 内核扩展

仅在以下情况下使用：

- Gateway 协议缺少通用能力
- Agent Profile 无法表达
- Model canonical request 缺少必要参数
- Transcript 缺少业务 metadata

应慎改：

- `src/agent/loop/AgentLoop.ts`
- `src/gateway/`
- `src/tool/execution/ToolRuntime.ts`
- `src/gateway/SessionRouter.ts`
- `src/model/providers/`
- `src/session/transcript/`
- `src/permission/`

## 11. 远端医疗项目总体架构

### 11.1 运行拓扑

```text
浏览器
  │
  ▼
Node Gateway :3080
  ├─ /dialogue/*             → Dialogue 静态页面
  ├─ /med-trauma/*           → Med-trauma 静态页面
  ├─ /api/dialogue/*         → Dialogue FastAPI :8010
  ├─ /api/med-trauma/*       → Trauma FastAPI :8011
  ├─ /data/*                 → Med-trauma 演示数据
  └─ /war_trauma/*           → Med-trauma 演示图片

Dialogue / Trauma
  ├─ 外部 OpenAI-compatible 生成模型
  ├─ 外部多模态 embedding
  └─ 可选 M3D :8200
```

### 11.2 技术栈

- Node.js 22.12
- Python 3.11
- FastAPI
- Uvicorn
- React 19 编译产物
- OpenAI Python SDK
- Requests
- NumPy
- PyMuPDF
- pydicom
- WFDB
- SQLite

### 11.3 交付边界

远端包中包含：

- 应用代码
- Python 和 Node 运行时
- 两套静态页面
- 战创伤 RAG 数据
- 部分演示数据

远端包中不完整包含：

- 生成模型权重
- vLLM GPU 运行时
- embedding 模型权重
- M3D 权重和完整依赖
- 外部病例目录
- 3D Gallery 数据根
- 前端源代码和 source map

因此其“离线”是应用离线交付，不等于完全不依赖外部推理服务。

## 12. Dialogue 功能设计

### 12.1 通用医疗聊天

状态：**现有界面使用**

能力：

- 文本聊天
- 多图片
- 多源附件
- 模型选择
- 采样参数
- Think 模式
- RAG
- Task Mode
- Volume 引用
- SSE 流式输出

当前问题：

- 模型调用、RAG、附件、数据库和流式响应集中在单个大型接口。
- 生成模型直接由 Python 后端调用。
- 上游错误可能直接暴露。

### 12.2 任务模式

状态：**现有界面使用**

现有模式：

- 健康问答
- 战创伤诊断
- 报告解读
- 药盒识别
- 深度搜索
- 表格电子化

多数模式主要通过 Prompt 差异实现，缺少独立输入输出 Schema 和工具权限定义。

### 12.3 会话与历史

状态：**现有界面使用**

能力：

- 浏览器生成 Session UUID
- 会话列表
- 历史消息
- 重命名
- 删除
- 图片缩略图和高清图两阶段加载

当前问题：

- 无用户所有权。
- SQLite 历史和进程内 `session_context` 是两套状态。
- 服务重启后历史仍可显示，但模型上下文不会完整恢复。

### 12.4 Think 与停止

状态：**现有界面使用**

- `reasoning_content` 被包装为 `<think>...</think>` 普通 token。
- `stop-think` 只停止向客户端转发 reasoning，模型仍继续运行。
- `stop-generation` 在下一个上游 chunk 到达时停止消费，并保存部分输出。

### 12.5 模型管理

状态：**现有界面使用**

能力：

- 模型列表
- 默认模型
- Think 能力
- 推荐采样参数
- 新增、修改、删除模型 Endpoint
- API Key 只写不回显
- 连通性测试
- 模型状态和加载入口

当前问题：

- 任意 API Base 可能形成 SSRF。
- 配置无完整 RBAC。
- Med-trauma 直接读取 Dialogue 模型注册文件。
- 打包版实际主要依赖外部模型，而不是本地加载。

### 12.6 System Prompt

状态：**现有界面使用**

能力：

- 基础 Prompt
- Task Mode Prompt
- 运行时修改

当前问题：

- 缺少版本、审批、发布和回滚。
- 部分覆盖仅存在于进程内。
- 全局 Prompt 修改可能影响其他用户和会话。

### 12.7 RAG

状态：**战创伤语料已使用；通用医学语料为占位**

战创伤 RAG：

- 约 16,540 个 chunk
- JSONL corpus
- NPY embedding matrix
- 多模态 embedding 请求
- NumPy 余弦相似度
- 默认 Top-K 3
- 最大 Top-K 8
- 默认阈值约 0.75
- 来源随回答返回并保存

当前问题：

- 语料和向量缺少强版本绑定。
- 没有向量数据库、重排器或混合检索。
- 语料授权、脱敏和更新流程不明确。
- 通用医学知识库只有占位注册。

### 12.8 多源附件

状态：**现有界面使用**

支持：

- TXT
- Markdown
- JSON
- XML
- CDA
- PDF
- PNG
- JPEG
- BMP
- DICOM
- aECG XML
- WFDB

处理能力：

- 批量上传
- 相对路径
- SHA-256
- Batch Manifest
- 原始文件和派生预览
- DICOM 多帧抽帧
- 文件、批次、目录深度和帧数预算
- 附件摘要
- 缓存查询和删除

当前问题：

- 附件含 PHI 的可能性高。
- GET 缓存接口存在删除副作用。
- Prompt Injection 主要依靠文本提醒。
- 部分普通图片不会作为视觉输入进入模型。

### 12.9 表格电子化

状态：**现有界面使用**

能力：

- 表格图片 OCR
- 模型输出 JSON、Markdown、HTML 容错解析
- 表格文档保存
- 在线编辑
- 删除
- CSV 导出

当前问题：

- 模型输出结构不稳定。
- 无用户所有权和并发版本。
- CSV 需防公式注入。

### 12.10 3D Gallery 和 Volume

状态：**界面调用，部分依赖外部数据**

Gallery：

- 数据集列表
- 病例列表
- 病例详情
- 切片

Volume：

- NIfTI/NPY 上传
- 归一化
- 切片预览
- Volume 列表和详情

当前问题：

- Gallery 默认依赖外部绝对路径。
- Volume 可能造成较大内存和磁盘压力。
- 缺少用户隔离和生命周期管理。

### 12.11 M3D

状态：**占位或缺依赖**

能力设计：

- Volume 上传后调用 M3D 服务
- 返回 3D 医学影像问答

缺失：

- 模型权重
- 完整 Torch/Transformers 运行环境
- GPU 资源
- 稳定取消和资源控制

## 13. Med-trauma 功能设计

### 13.1 业务流程

状态：**现有界面使用**

六个阶段：

- 伤员发生地
- 野战分类场
- 收容处置组
- 重伤救治组
- 手术组
- 洗消组

五类图像：

- 创面
- X 光
- 心电
- CT
- 其他

输出结构：

- 影像判读
- 阶段处置
- 特异处置
- 分类、伤标、后送和交接
- 安全禁忌

### 13.2 Prompt 模式

- `eval`：军用五段模板
- `plain`：民用急诊消融模板

当前静态 bundle 依赖默认 `eval`。

### 13.3 流式接口

状态：**现有界面使用**

输入：

- 场景
- 阶段
- 描述
- 模型
- 多张图片
- 图片 ID、标签和顺序

输出 SSE：

- `meta`
- `token`
- `done`
- `error`

当前问题：

- 浏览器依赖模型输出中的固定中文章节标题进行二次分段。
- 更换模型可能破坏页面结构。
- 无后端会话和持久化。
- Token 鉴权函数存在但未挂到路由。

### 13.4 演示与评测数据

状态：**现有界面使用**

包括：

- 内置伤情图片
- 演示案例索引
- 参考答案
- 多模型历史输出
- 评价维度

需要补充：

- 数据版权
- 病例来源
- 脱敏证明
- “历史静态评测”标识

## 14. 远端后端存在但当前界面未使用的能力

以下能力不应作为首期阻塞项：

### 14.1 Dialogue 内另一套战创伤分析

- 与 Med-trauma 后端能力重复。
- Prompt、阶段和事件格式存在漂移。
- 目标应合并为统一战创伤 Skill。

### 14.2 多源诊疗方案

- 汇总多源资料。
- 可选 RAG。
- 生成结构化诊疗方案。
- 医疗责任较高，需要证据绑定和人工确认。

### 14.3 外部病例目录

- 病例列表
- CDA 查看
- DICOM Source View
- 依赖外部绝对路径
- 可能包含真实 PHI

### 14.4 翻译

- 医学文本翻译
- 翻译缓存
- 当前 bundle 未调用

### 14.5 Eval、Compare 和 rerun-case

- 历史模型结果比较
- 评测案例
- 重跑
- 部分依赖脚本未随包交付

### 14.6 模型卸载和调试接口

- 当前 bundle 未调用。
- 对外部 API 模型意义有限。
- 应只保留在受保护管理端。

## 15. 远端项目数据与安全现状

### 15.1 存储

远端项目使用：

- SQLite 会话和消息
- 图片 Base64
- 附件目录
- Batch Manifest
- 表格文档
- Volume 数据
- JSON 模型注册表
- JSONL RAG Corpus
- NPY Embedding
- 普通日志文件

### 15.2 主要风险

- 缺少有效入口鉴权
- 缺少用户、租户和 RBAC
- Dialogue 实际绑定 `0.0.0.0`
- Trauma Token 校验未挂路由
- 模型 Endpoint 配置存在 SSRF 和数据外送面
- 医疗数据明文存储
- 文件和数据库权限偏宽
- 会话上下文重启丢失
- Think 内容可能持久化
- RAG 制品缺少签名和版本一致性校验
- 无 TLS、速率限制、统一请求体限制和安全响应头
- 日志无轮转和统一脱敏
- 无完整备份恢复和容量治理
- 外部模型、embedding 和 M3D 依赖未形成离线能力清单

## 16. PilotDeck 与医疗功能目标映射

### 16.1 静态页面与路由

远端现状：

- Node Gateway 托管 `/dialogue/` 和 `/med-trauma/`。
- 两套 bundle 使用固定 API 前缀。

PilotDeck 目标：

- 由 `ui/server/index.js` 托管两套静态页面。
- 保持 `/dialogue/`、`/med-trauma/`、`/data/`、`/war_trauma/`。
- 在 PilotDeck 主 SPA fallback 之前建立独立静态边界。

策略：

- 第一阶段不修改 minified bundle。
- 不运行远端 `gateway/gateway.mjs`。
- 用 PilotDeck UI Server 替代旧 Gateway。

验收：

- 两个旧页面可原样加载。
- 页面刷新和资源缓存正确。
- 缺失 JS/CSS 返回 404，不错误回落到 PilotDeck 主页面。

### 16.2 Dialogue 聊天

远端现状：

- FastAPI `/chat` 同时执行附件、RAG、模型和 SSE。

PilotDeck 目标：

- Gateway：管理 Session、Turn、Run、停止和 transcript。
- Agent Profile：定义医疗角色、模型、参数和工具范围。
- Skill：定义任务模式工作流。
- MCP/sidecar：提供 RAG 和附件能力。
- UI Adapter：保留旧 FormData 和 SSE 契约。

策略：

- 替换远端模型直调。
- 保留旧浏览器字段和响应。
- 将模型和工具执行纳入 AgentLoop。

验收：

- 所有生成请求均经过 PilotDeck Gateway。
- 浏览器仍接收 `token`、RAG metadata、`error` 和 `[DONE]`。
- 会话重启后可以从 transcript 恢复上下文。

### 16.3 会话与历史

远端现状：

- SQLite 历史加进程内 `session_context`。

PilotDeck 目标：

- JSONL transcript 为唯一聊天事实源。
- UI Adapter 将 transcript 投影为旧 `/sessions` 和 `/history` 响应。
- 领域数据只存附件、表格和 Volume metadata。

策略：

- 不继续双写旧聊天 SQLite。
- Session Key 加入用户和应用命名空间。
- RAG 来源、附件引用、模型和 Profile 写入 Turn Metadata。

验收：

- 会话列表、重命名、删除和双阶段图片历史保持兼容。
- 所有会话操作验证所有权。

### 16.4 Think 和停止

远端现状：

- Think 作为普通 token。
- stop-think 只停止展示。
- stop-generation 保存部分输出。

PilotDeck 目标：

- `assistant_thinking_delta` 转换为旧 `<think>` token。
- stop-think 只修改当前客户端流过滤状态。
- stop-generation 映射 Gateway abort。

验收：

- stop-think 后正式 answer 继续输出。
- stop-generation 按 `runId` 终止，不误伤同 Session 的其他执行。

### 16.5 模型管理

远端现状：

- 独立 JSON 注册表。
- 用户可输入任意 Endpoint。

PilotDeck 目标：

- PilotDeck Model Provider 为唯一生成模型配置源。
- Profile 只引用已发布模型。
- Secret 与公开模型配置分离。
- 普通用户只能选择模型，管理员才能修改 Endpoint。

策略：

- 兼容旧 `/models` 和 `/model-configs` 输出。
- 增加 Endpoint allowlist、DNS/IP 校验和审计。
- 补齐逐 Turn 模型和采样参数支持。

验收：

- Dialogue 和 Med-trauma 返回一致模型列表。
- API Key 永不回显。
- Endpoint 测试不能访问禁止网段。

### 16.6 System Prompt 和任务模式

远端现状：

- Prompt 可在 UI 中直接修改。
- Task Mode 主要是 Prompt 拼接。

PilotDeck 目标：

- 基础医疗约束进入可信 Agent Profile。
- 每个任务模式定义独立 Skill。
- Prompt 具备版本、发布、回滚和审计。
- 浏览器只传 `profileId` 或 `taskMode`，不能传任意高优先级 system prompt。

映射：

- 健康问答 → `medical-general` Skill
- 战创伤诊断 → `war-trauma-assessment` Skill
- 报告解读 → `medical-report-interpretation` Skill
- 药盒识别 → `medicine-package-recognition` Skill
- 深度搜索 → `medical-deep-search` Skill
- 表格电子化 → `table-digitization` Skill

### 16.7 RAG

远端现状：

- NumPy 本地检索加外部多模态 embedding。

PilotDeck 目标：

- `war-trauma-rag` MCP Server
- RAG Catalog
- 版本化知识库制品
- Agent Profile 控制默认语料和 Top-K
- RAG 来源作为结构化 Tool Result 和 Turn Metadata

策略：

- 首期可复用现有余弦检索算法。
- Corpus 和 NPY 作为独立部署制品，不提交源码仓库。
- 增加 corpus hash、embedding 模型、维度、时间和许可信息。

验收：

- 返回旧 UI 需要的 score、chunk、标题、章节、来源和 preview。
- 回答可追溯到明确语料版本。

### 16.8 附件、DICOM、ECG 和 PDF

远端现状：

- Python ingestion 模块已经具备较完整解析能力。

PilotDeck 目标：

- Python sidecar 承载医疗格式解析。
- MCP 暴露附件解析和上下文工具。
- UI Server 负责上传、认证和预览代理。
- PilotDeck Gateway 负责把受控文本和图片引用送入 Agent。

策略：

- 保留 parser 和路径校验算法。
- 重构存储、用户所有权和生命周期。
- DICOM Header 采用 PHI 脱敏策略。
- 解析任务设置资源预算和超时。

验收：

- 保持原 Batch Manifest 和预览字段。
- 文件、帧、像素、页数、大小和目录深度均有限制。
- XML 禁止外部实体和网络访问。

### 16.9 表格电子化

远端现状：

- 模型 OCR 加 Python 容错解析和 SQLite。

PilotDeck 目标：

- Skill 负责流程。
- PilotDeck ModelRuntime 负责视觉模型调用。
- MCP/sidecar 负责表格解析、规范化和 CSV。
- 独立 Storage 保存表格文档。

策略：

- 保留 `table_ocr.py` 解析算法。
- 替换 Python 内直接模型调用。
- 增加版本字段和乐观锁。

验收：

- 列、行、警告、原始输出和编辑结果可追溯。
- CSV 无公式注入风险。

### 16.10 3D Gallery、Volume 和 M3D

远端现状：

- Gallery 和 Volume 页面存在。
- 数据和 M3D 依赖不完整。

PilotDeck 目标：

- `medical-volume` MCP
- 受控对象存储
- 异步预处理任务
- 可选 M3D Profile 和 Sidecar

策略：

- Gallery 和 Volume 先完成兼容接口。
- M3D 作为独立 Feature Flag。
- 没有权重和 GPU 时返回明确 unavailable。

验收：

- Volume 有大小、维度、dtype、体素和并发限制。
- M3D 可健康检查、超时和取消。

### 16.11 Med-trauma

远端现状：

- 独立无状态 FastAPI。
- 固定 Prompt Builder。
- Typed SSE。

PilotDeck 目标：

- `war-trauma-assessment` Agent Profile
- 战创伤 Skill
- 单 Turn、受限工具的 Agent 执行
- UI Adapter 输出 `meta/token/done/error`
- Prompt Builder 规则进入版本化 Profile 或领域 sidecar

策略：

- 保留请求和 SSE Schema。
- 替换 `llm_client.py` 模型直调。
- 短期维持固定中文标题，长期增加结构化输出。

验收：

- 六阶段、五类图像和五段输出保持一致。
- 每张图片保留 ID、标签和顺序。

### 16.12 遗留能力

处理策略：

- Dialogue 内重复战创伤接口：合并并淘汰。
- 多源诊疗方案：后续独立 Skill，需临床评审。
- 外部病例目录：延期，先解决授权和 PHI。
- 通用医学知识库：保持禁用，待数据与索引齐备。
- 翻译：后续可选 Skill。
- Eval/Compare：独立评测系统，不进入生产 Agent Gateway。
- rerun-case：不暴露生产接口。
- M3D：按 Feature Flag 启用。

## 17. 目标融合架构

```text
浏览器
  ├─ /dialogue/
  └─ /med-trauma/
          │
          ▼
PilotDeck UI Server :3001
  ├─ PilotDeck 原生 UI
  ├─ Legacy Dialogue Adapter
  ├─ Legacy Med-trauma Adapter
  ├─ Auth / Ownership / Rate Limit
  ├─ Static Assets
  └─ Sidecar Proxy
          │
          ├──────────────────────┐
          ▼                      ▼
PilotDeck Gateway :18789    Medical Sidecar :localhost
  ├─ SessionRouter           ├─ RAG
  ├─ AgentSession            ├─ Attachment Ingestion
  ├─ TurnRunner              ├─ DICOM / ECG / PDF
  ├─ AgentLoop               ├─ Table Parser
  ├─ RouterRuntime           ├─ Gallery / Volume
  ├─ ModelRuntime            ├─ Trauma Rules
  ├─ ToolRuntime             ├─ Embedding Provider
  ├─ McpRuntime ────────────►└─ MCP Endpoint
  ├─ Transcript
  ├─ Permission
  └─ Audit Hook
          │
          ▼
内网生成模型服务
```

### 17.1 PilotDeck 保留职责

- 系统启动
- Gateway
- AgentLoop
- 模型和 Router
- Session、Turn、Run
- transcript
- MCP 调用
- 工具权限
- 用户追问
- 认证入口
- Cron 和 Always-on
- Channel

### 17.2 Medical Feature Pack 职责

- 两套医疗静态页面
- Legacy API 和 SSE 适配
- 医疗 Agent Profile
- 医疗 Skill
- 医疗 MCP
- Python sidecar
- RAG 制品
- 附件、表格和 Volume 数据
- 医疗审计规则

### 17.3 不保留为主体的远端组件

- 旧 Node Gateway
- Dialogue 自有聊天 Session Runtime
- Trauma 自有模型 Client
- Dialogue/Trauma 各自独立模型注册表
- 无鉴权的直接后端端口
- 聊天历史与 PilotDeck transcript 双写

## 18. 建议产品目录

```text
products/medical-integration/
  README.md
  config/
    pilotdeck.example.yaml
    medical.example.yaml
  static/
    dialogue/
    med-trauma/
  profiles/
    medical-general.md
    medical-report.md
    war-trauma.md
  skills/
    medical-general/
    medical-report-interpretation/
    medicine-package-recognition/
    medical-deep-search/
    table-digitization/
    war-trauma-assessment/
  plugins/
    medical-tools/
      plugin.json
      hooks/
      commands/
  sidecar/
    medical_sidecar/
      api/
      mcp/
      ingestion/
      rag/
      table/
      volume/
      trauma/
  tests/
    contracts/
    fixtures/
    integration/
```

该目录为目标结构设计，不代表当前已经创建。

## 19. PilotDeck 需要补齐的通用能力

### 19.1 Agent Profile

需要接通：

- `plugin.json.agents`
- Profile Markdown 加载
- Profile Registry
- Profile 的 system prompt、模型默认值和工具策略
- Gateway `profileId`
- Profile 热重载

### 19.2 逐 Turn 模型和采样参数

需要在以下链路增加可验证的 Turn Override：

```text
GatewaySubmitTurnInput
  → AgentSubmitOptions
  → TurnRunnerOptions
  → AgentLoopInput
  → CanonicalModelRequest
  → OpenAI Provider Request
```

需支持：

- provider/model
- max_tokens
- temperature
- top_p
- top_k
- min_p
- presence_penalty
- frequency_penalty
- repetition_penalty
- seed
- thinking

所有参数必须进行模型能力、范围和安全校验。

### 19.3 工具策略

需要支持每个 Profile 或 Turn 的：

- allowedTools
- deniedTools
- maxTurns
- canPrompt
- timeout

Med-trauma 应默认单 Turn，并禁止 shell、文件写入、Web 和子 Agent。

### 19.4 Trusted Context 与 Metadata

需要区分：

- 给模型看的受信系统上下文
- 不给模型看的业务 metadata
- transcript 中需要持久化的 RAG 和附件引用
- UI 需要恢复的兼容字段

浏览器不得直接提交任意 system prompt。

### 19.5 Legacy UI 认证

现有 bundle 不会主动给所有请求附加 PilotDeck Bearer Token，因此需要：

- 受保护的 Legacy App 启动入口
- HttpOnly、SameSite Cookie
- 用户和 Session 所有权
- 管理接口 RBAC

## 20. 安全、医疗和军用环境要求

### 20.1 网络

- Gateway 保持 localhost。
- Medical sidecar 只监听 localhost。
- 浏览器只访问 UI Server。
- 生成模型和 embedding 只允许内网 allowlist。
- 禁止任意 Endpoint、重定向和 DNS 重绑定。
- 禁用默认外部 Telemetry。

### 20.2 数据

- 会话、附件、CDA、DICOM、ECG、表格和 Volume 按用户归属。
- 医疗数据静态加密。
- 明确 PHI 分类和脱敏规则。
- 明确保留期限和可验证删除。
- 不默认开启跨会话长期 Memory。
- RAG 和模型制品记录 hash、版本和许可。

### 20.3 审计

应记录：

- 用户
- 时间
- Session 和 Run
- Agent Profile
- 模型与版本
- Prompt 版本
- RAG 版本和来源 ID
- 附件 Hash
- 工具调用
- 权限决策
- 操作结果

不应记录：

- 完整 PHI 正文
- API Key
- 完整 reasoning
- 未脱敏附件内容

### 20.4 医疗安全

- 所有输出标明辅助决策属性。
- 不以模型输出替代医生诊断。
- 高风险诊疗方案要求人工确认。
- RAG 引用必须可追溯。
- 故障时不得伪造成功结果。
- DICOM 预览不得宣称诊断级阅片。

### 20.5 离线等级

- **L0**：静态页面可访问。
- **L1**：连接内网生成模型，可以聊天。
- **L2**：具备本地 RAG 和 embedding。
- **L3**：具备 PDF、DICOM、WFDB 完整解析依赖。
- **L4**：具备 M3D 权重、GPU 和完整推理服务。

启动和健康检查必须明确展示当前达到的等级，不能静默降级。

## 21. 分阶段开发路线

### 21.1 Phase 0：框架与契约冻结

目标：

- 完成 PilotDeck 架构走读。
- 固化两套旧 bundle 使用的全部 API 契约。
- 固化目标职责边界。
- 生成远端选定源码和静态资产的只读清单与 Hash。
- 明确不复制的秘密、数据库和运行时文件。

退出条件：

- 能明确回答每项医疗能力应放在 Gateway、Profile、Skill、MCP、UI Adapter、Sidecar 或 Storage 的哪一层。
- 用户确认 PilotDeck 是唯一主体。
- 旧 bundle API 清单完成评审。

### 21.2 Phase 1：PilotDeck 主体与旧页面核心兼容

范围：

- 两套静态页面挂载
- Dialogue 会话和历史
- Dialogue 模型列表、任务模式和聊天 SSE
- stop-think 和 stop-generation
- Med-trauma 模型、探活和流式分析
- 基础 Profile
- Gateway transcript
- 基础认证、所有权和错误规范化

退出条件：

- 两个旧 bundle 无需修改即可完成核心演示。
- 所有生成请求均经过 PilotDeck Gateway。
- 旧 Node Gateway 和两个 Python 模型 Client 不再作为生成入口。

### 21.3 Phase 2：医疗 MCP 与 Sidecar

范围：

- RAG
- 附件
- CDA/XML
- PDF
- 图片
- DICOM
- ECG/WFDB
- 附件预览与缓存
- 表格电子化
- 3D Gallery
- Volume

退出条件：

- 每项工具都有独立 Schema、资源预算、权限和错误边界。
- 浏览器契约测试通过。
- 数据所有权和审计生效。

### 21.4 Phase 3：可选和遗留能力

范围：

- M3D
- 多源诊疗方案
- 外部病例仓库
- 通用医学知识库
- 翻译
- Eval/Compare

进入条件：

- 数据许可明确。
- 依赖完整。
- 临床安全评审完成。
- 不影响 Phase 1 和 Phase 2 的稳定链路。

### 21.5 Phase 4：多入口与后台能力

可选范围：

- 飞书医疗 Agent
- 企业微信
- Cron 随访或知识更新任务
- Always-on 数据检查
- 受控医疗报告生成

要求：

- 与 Web 共享 Gateway、权限和 transcript。
- 不绕过用户所有权和审计。

## 22. 验收体系

### 22.1 API 契约

- Dialogue 所有当前 bundle 调用端点通过。
- Med-trauma 所有当前 bundle 调用端点通过。
- JSON、FormData、二进制预览和 SSE 结构兼容。

### 22.2 Agent 链路

- 模型请求经过 PilotDeck ModelRuntime。
- Profile、模型、参数和工具策略可追溯。
- Tool Call 经过 Permission 和 Hook。
- transcript 可恢复。

### 22.3 数据

- Session、附件、表格和 Volume 有所有权。
- RAG 有版本。
- 无真实数据库和秘密被复制进源码。
- 删除和保留策略可验证。

### 22.4 安全

- 后端和 sidecar 不直接暴露。
- SSRF 测试通过。
- 路径穿越、压缩炸弹、XML 实体、超大图片和 Volume 测试通过。
- 普通用户不能修改模型 Endpoint 和系统 Prompt。

### 22.5 离线

- 断开互联网后达到声明的离线等级。
- 所有外部连接都有明确 allowlist。
- Telemetry 不外发。

### 22.6 浏览器

- 原 Dialogue bundle 完成聊天、RAG、附件、表格和 3D 基础流程。
- 原 Med-trauma bundle 完成模型选择、图片上传和六阶段分析。
- 不直接修改 minified bundle。

## 23. 关键文件索引

### 23.1 PilotDeck

- CLI：`src/cli/pilotdeck.ts`
- 系统装配：`src/cli/createLocalGateway.ts`
- Gateway：`src/gateway/client/InProcessGateway.ts`
- Session Router：`src/gateway/SessionRouter.ts`
- Gateway 协议：`src/gateway/protocol/types.ts`
- Agent Session：`src/agent/session/AgentSession.ts`
- Turn Runner：`src/agent/turn/TurnRunner.ts`
- Agent Loop：`src/agent/loop/AgentLoop.ts`
- Agent Config：`src/agent/runtime/AgentRuntimeConfig.ts`
- Model Runtime：`src/model/ModelRuntime.ts`
- Canonical Model：`src/model/protocol/canonical.ts`
- Router：`src/router/RouterRuntime.ts`
- Tool Runtime：`src/tool/execution/ToolRuntime.ts`
- MCP Runtime：`src/mcp/runtime/McpRuntime.ts`
- Plugin Manifest：`src/extension/plugins/protocol/manifest.ts`
- Plugin Loader：`src/extension/plugins/loading/PluginLoader.ts`
- Plugin Runtime：`src/extension/plugins/runtime/PluginRuntime.ts`
- Prompt：`src/context/prompt/PromptAssembler.ts`
- Memory：`src/context/memory/EdgeClawMemoryProvider.ts`
- Transcript：`src/session/transcript/`
- UI Server：`ui/server/index.js`
- UI Bridge：`ui/server/pilotdeck-bridge.js`
- UI Auth：`ui/server/middleware/auth.js`
- 产品示例：`products/_example/`

### 23.2 远端项目

根路径：

`node12:/local_data/huojianfan/med-integration-offline-military`

关键文件：

- 说明：`README.md`
- 版本：`VERSION`
- 旧 Gateway：`gateway/gateway.mjs`
- 启动：`scripts/start.sh`
- Dialogue：`app/dialogue-backend/serve_vllm.py`
- RAG：`app/dialogue-backend/war_trauma_rag.py`
- Ingestion：`app/dialogue-backend/ingestion/`
- 表格：`app/dialogue-backend/table_ocr.py`
- Gallery：`app/dialogue-backend/gallery3d.py`
- Volume：`app/dialogue-backend/volume3d.py`
- M3D：`app/dialogue-backend/m3d_service.py`
- Trauma API：`app/trauma-backend/main.py`
- Trauma Schema：`app/trauma-backend/schemas.py`
- Trauma Prompt：`app/trauma-backend/prompt_builder.py`
- Trauma LLM：`app/trauma-backend/llm_client.py`
- 共享模型注册：`shared/python/dialogue_model_registry.py`
- Dialogue 页面：`static/dialogue/`
- Med-trauma 页面：`static/med-trauma/`

## 24. 术语表

- **Agent OS**：统一运行和管理 Agent 应用的平台。
- **Gateway**：所有 Channel 进入 Agent Runtime 的统一入口。
- **WorkSpace**：项目文件、扩展、会话和记忆的逻辑边界。
- **Session**：持续对话。
- **Turn**：用户一次提交到 Agent 完成回复的一轮。
- **Run**：Gateway 侧一次可流式、可取消的执行。
- **AgentLoop**：模型和工具之间的循环执行器。
- **Profile**：可信 Agent 角色、模型默认值、系统 Prompt 和工具策略。
- **Skill**：模型按需读取的领域工作说明。
- **Plugin**：组合 Skill、Command、Hook 和 MCP 的扩展包。
- **MCP**：外部工具和数据服务接入协议。
- **Hook**：生命周期拦截和审计机制。
- **Transcript**：可恢复的会话事件记录。
- **Sidecar**：与主进程分离的领域服务。
- **RAG**：检索增强生成。
- **PHI**：受保护健康信息。

## 25. 最终结论

PilotDeck 已具备承载医疗 Agent 产品的核心运行时结构，但应把它视为早期、可扩展的 Agent OS，而不是功能全部完成的成熟平台。

后续开发必须遵循以下原则：

1. PilotDeck 始终是系统主体。
2. 远端项目只作为医疗 Feature Pack 和兼容参考。
3. 业务逻辑优先进入 Skill、MCP、Hook、UI Adapter 和 Sidecar。
4. Gateway、AgentLoop、ToolRuntime、Transcript 和 Permission 保持为稳定内核边界。
5. 只有逐 Turn Profile、模型参数和业务 Metadata 等确属通用缺口时，才扩展 PilotDeck 内核。
6. 首期以原静态页面无修改、核心流程跑通为目标。
7. RAG、附件、表格、3D 和 M3D 按依赖和风险分阶段接入。
8. 医疗数据、安全、审计和离线能力不能沿用远端演示系统的默认实现。
