# PilotDeck 医疗改造技术报告

> **目标**：将 PilotDeck（开源 Agent OS）改造为"九格医学辅助平台"，把 `med-integration-offline-military` 项目的医疗特性以 **Agent OS 模式** 完整映射到 PilotDeck 架构上。
>
> **日期**：2026-08-12  
> **版本**：PilotDeck v0.1.0 + Medical Feature Pack v1  
> **源项目基线**：`b507f26`

---

## 目录

1. [背景与动机](#1-背景与动机)
2. [改造策略](#2-改造策略)
3. [架构对比](#3-架构对比)
4. [引擎层改造](#4-引擎层改造)
5. [Medical Feature Pack](#5-medical-feature-pack)
6. [UI 层改造](#6-ui-层改造)
7. [安全护栏](#7-安全护栏)
8. [核心模式映射](#8-核心模式映射)
9. [数据流全景](#9-数据流全景)
10. [部署与交付](#10-部署与交付)
11. [测试体系](#11-测试体系)
12. [成果统计](#12-成果统计)

---

## 1. 背景与动机

### 1.1 改造前的系统状况

改造前存在**两套独立系统**：

**系统 A — PilotDeck（目标宿主平台）**

一个开源通用 Agent OS（OpenBMB/THUNLP，AGPL-3.0，v0.1.0），具备成熟的 Agent 运行时：

- Gateway 统一入口（WebSocket 协议 1.0，端口 18789）
- AgentSession → TurnRunner → AgentLoop 多轮推理循环
- 多模型 Provider（OpenAI / Anthropic / Google）+ Smart Router
- 内置工具系统（读写文件、bash、搜索、子 Agent）+ MCP 协议
- 插件 / Skill / Command / Hook 扩展机制
- JSONL transcript 持久化、权限、定时任务、多 IM Channel

但作为 `0.1.0` 版本，存在明确的通用能力缺口：

| 缺口 | 影响 |
|------|------|
| Plugin 的 `agents` 字段未接线 | 无法通过插件定义 Agent 角色和行为 |
| 无逐 Turn 模型切换 | 同一会话只能用全局配置的模型 |
| 无采样参数逐 Turn 覆盖 | temperature/topP/maxTokens 等不可动态调整 |
| 无工具白名单/黑名单 | 无法限制特定场景的工具使用 |
| 无 Trusted Context 机制 | 浏览器可注入任意 system prompt |
| 品牌/主题未接线 | 所有 UI 硬编码 |

**系统 B — 源医疗项目（med-integration-offline-military）**

一个自包含的离线医疗 AI 部署包，面向军事战创伤救治场景：

```
med-integration-offline-military/
├── static/
│   ├── dialogue/          ← React SPA（混淆 minified bundle）
│   └── med-trauma/        ← React SPA（混淆 minified bundle）
├── app/
│   ├── dialogue-backend/  ← Python FastAPI（4299 行 serve_vllm.py）
│   └── trauma-backend/    ← Python FastAPI（独立战创伤研判）
├── gateway/
│   └── gateway.mjs        ← Node.js 反向代理（无认证）
├── data/rag/              ← 《中华战创伤学》11 卷语料
│   ├── output/corpus/     ← 16,540 chunks JSONL
│   └── embedding/         ← 135 MB NPY 向量矩阵
├── runtime/               ← 嵌入式 Python/Node 运行时（conda-pack）
├── scripts/               ← bash 编排脚本
└── config/config.env      ← 环境变量配置
```

功能上包含：
- **Dialogue**：有状态医疗聊天（RAG 检索、多模态附件解析、DICOM/ECG/PDF、表格 OCR、3D 影像）
- **Med-trauma**：无状态六阶段战创伤结构化研判（MARCH/START/ABCDE/围术期/洗消）
- **VLM-describe-first**：先用 VLM 描述伤情图片，再以描述驱动 RAG 检索
- **多源诊疗方案生成**：9 段结构化诊疗计划

但存在严重的架构问题：

| 问题 | 风险 |
|------|------|
| 两个 Python 后端各自直调模型 | API Key 分散，无统一管控 |
| Node Gateway 无认证 | 任何能访问端口的人都能调用 |
| 无审计日志 | 无法追溯谁在何时做了什么 |
| 前端为混淆 bundle | 不可维护、不可审计、不可定制 |
| 配置散落（env + 代码内硬编码） | 客户差异管理困难 |
| 无测试体系 | 变更风险不可控 |
| bash 脚本编排 | 不可移植，错误处理脆弱 |

### 1.2 为什么要改造

核心判断来自可行性研究文档（`pilotdeck-medical-integration-research.md`，2026-08-05）：

1. PilotDeck 已具备 Agent OS 的核心运行时（Gateway / AgentLoop / ModelRuntime / ToolRuntime / MCP / transcript / 权限）
2. 源项目是**固定业务应用**，不是通用 Agent 系统 — 不应作为独立系统继续演进
3. 两者的结合点清晰：PilotDeck 做运行时，医疗业务逻辑进入 Profile / Skill / MCP / Sidecar
4. 唯一需要扩展 PilotDeck 内核的是**逐 Turn Profile**和**采样参数覆盖**（确属通用缺口）

**改造目标**：一个统一架构的医学辅助平台，同时解决 PilotDeck 的通用能力缺口和源项目的架构债务。

---

## 2. 改造策略

### 2.1 核心原则

```
1. PilotDeck 是唯一主体和 Agent OS 运行时
2. 源项目退化为 Medical Feature Pack（不再作为独立系统）
3. 所有生成模型请求必须经过 PilotDeck Gateway
4. Python sidecar 不持有模型密钥、不直接调用模型
5. 医疗业务逻辑进入 Profile / Skill / MCP / Hook / UI Adapter / Sidecar
6. 旧 bundle 仅作视觉/契约参考，不进入生产运行
7. 客户差异通过 preset + feature flag + Profile + Plugin 组合，不建长期源码分支
```

### 2.2 分层映射策略

```
源项目组件                →  PilotDeck 承载层
─────────────────────────────────────────────────
Dialogue 聊天逻辑         →  AgentProfile + Skill + AgentLoop
Trauma 研判逻辑           →  AgentProfile + Skill + AgentLoop（单 Turn，禁用工具）
RAG 检索                  →  MCP Tool（sidecar）+ versioned artifacts
附件解析                  →  MCP Tool（sidecar）+ per-file degraded 状态
表格 OCR                  →  MCP Tool + ModelRuntime（视觉模型）
3D Gallery / Volume        →  MCP Tool + sidecar imaging 模块
M3D 推理                  →  Feature flag + MCP adapter
诊疗方案生成              →  clinical-workflows.v1 contract 管线
多源附件预处理            →  sidecar ingestion 模块
Prompt 模板               →  AgentProfile.systemContext（可信，不可篡改）
模型选择                  →  RouterRuntime + profile.turnOverrides
会话管理                  →  JSONL transcript（Session / Turn / Run）
权限控制                  →  PermissionRuntime + tool allow/deny
配置管理                  →  customer preset YAML（schema 校验 + 版本化）
```

### 2.3 分阶段实施

| Phase | 范围 | 状态 |
|-------|------|------|
| **Phase 0** | 框架调研、API 契约冻结、Hash 清单、职责边界确认 | ✅ 完成 |
| **Phase 1** | PilotDeck 内核扩展（Profile 系统）+ 原生 UI 复刻 + 基础认证 | ✅ 完成 |
| **Phase 2** | 医疗 MCP + Python sidecar（RAG/附件/表格/影像/创伤规则） | ✅ 完成 |
| **Phase 3** | 安全护栏 + 诊疗方案契约化 + 审计 v2 + RAG VLM 模式 + e2e | ✅ 完成 |
| **Phase 4** | IM Channel / Cron 随访 / Always-on / 离线打包 | 🔶 框架就绪 |

---

## 3. 架构对比

### 3.1 改造前 — 两套独立系统

```text
┌─────────────────────────────────────────────────────────┐
│                      浏览器                              │
│   /dialogue/ (React SPA)    /med-trauma/ (React SPA)    │
└────────────┬──────────────────────┬─────────────────────┘
             │                      │
    ┌────────▼────────┐    ┌───────▼────────┐
    │ Node Gateway    │    │ Node Gateway   │
    │ :4080           │    │ (静态文件)      │
    │ 反向代理 + 静态  │    │                │
    │ ❌ 无认证        │    └────────────────┘
    └──┬──────────┬───┘
       │          │
  ┌────▼─────┐ ┌──▼───────────┐
  │ Dialogue │ │ Med-Trauma   │
  │ Backend  │ │ Backend      │
  │ :8010    │ │ :8011        │
  │ FastAPI  │ │ FastAPI      │
  │          │ │              │
  │ ❌ 直调  │ │ ❌ 直调      │
  │   模型   │ │   模型       │
  └────┬─────┘ └──────┬───────┘
       │              │
  ┌────▼──────────────▼─────┐
  │ 外部 vLLM (G9-V-Med)     │
  │ qwen3-vl-embedding       │
  └──────────────────────────┘

问题：
• 两个后端各自持有 API Key，直调模型
• 无统一的会话管理和 transcript
• 无认证、无审计、无权限
• 前端为混淆 bundle，不可维护
• 配置散落在 env 文件和代码中
```

### 3.2 改造后 — 统一 Agent OS 架构

```text
┌──────────────────────────────────────────────────────────┐
│                       浏览器                              │
│  原生 React 组件（TypeScript + Vite HMR + Vitest）        │
│  DialoguePage / MedTraumaPage / ImagingWorkbench / ...    │
│  品牌名称动态读取 /api/medical/health（preset 切换）       │
└────────────────────────┬─────────────────────────────────┘
                         │ HTTPS + Bearer Token
                ┌────────▼──────────────────────────┐
                │   PilotDeck UI Server :3001        │
                │   Express + WebSocket               │
                │                                    │
                │  • /api/medical/*  (认证 + 审计)    │
                │  • /api/medical/health             │
                │  • /api/medical/dialogue/chat (SSE)│
                │  • /api/medical/med-trauma/analyze │
                │  • /api/medical/diagnosis/...      │
                │  • /api/medical/rag/corpora        │
                │  • /api/medical/sidecar/* (代理)   │
                │                                    │
                │  安全护栏：                          │
                │  • 重复循环检测 + 弱答案重试         │
                │  • Thinking 中文强制                │
                │  • PHI 审计 v2                      │
                └──┬───────────────┬──────────────────┘
                   │ WebSocket     │ HTTP (localhost only)
                   │ 协议 1.0      │
          ┌────────▼────────┐  ┌──▼──────────────────────┐
          │ PilotDeck       │  │ Medical Sidecar          │
          │ Gateway :18789  │  │ localhost :8765 / :8766  │
          │                 │  │                          │
          │ • SessionRouter │  │ FastAPI REST API +       │
          │ • AgentSession  │  │ FastMCP (streamable HTTP)│
          │ • TurnRunner    │  │                          │
          │ • AgentLoop     │  │ • RAG 检索 + 词法降级     │
          │ • ProfileReg.   │  │ • 附件解析 (degraded)     │
          │ • RouterRuntime │  │ • 表格 OCR / 影像处理     │
          │ • ModelRuntime  │  │ • 临床工作流 / 创伤规则   │
          │ • ToolRuntime   │  │ • ✅ 不调模型，不持密钥    │
          │ • McpRuntime ───┼──┤ • SHA-256 制品校验        │
          │ • Permission    │  │ • Embedding allowlist     │
          │ • Transcript    │  │                          │
          └────────┬───────┘  └──────────────────────────┘
                   │
          ┌────────▼────────┐
          │ 内网生成模型      │
          │ (OpenAI-compat)  │
          │ 经 PilotDeck     │
          │ ModelRuntime     │
          └─────────────────┘

关键改进：
• 唯一生成入口：PilotDeck Gateway
• 统一会话：JSONL transcript（Session / Turn / Run）
• 统一认证：Bearer Token + 会话所有权
• 完整审计：PHI-safe 8 列结构化日志
• 配置集中：customer preset YAML（schema 校验）
• 前端可维护：原生 TypeScript React
```

---

## 4. 引擎层改造

这是改造中最关键的部分 — PilotDeck 内核新增了完整的 **Agent Profile 系统**。

### 4.1 Agent Profile 系统

**问题**：改造前，PilotDeck 的 `plugin.json` 虽然有 `agents` 字段声明，但完全没有接线。每个 HTTP 请求或 Turn 无法动态选择 Agent 角色、模型、采样参数或工具策略。

**方案**：从零构建了完整的 Profile 加载 → 校验 → 合并 → 执行链路：

```text
plugin.json                     Gateway 请求                    Agent 运行时
─────────────                   ────────────                    ────────────
agents: "agents"                submit_turn {                   AgentSession.submit
  │                               profile: "medical-general",     │
  ▼                               turnOverrides: {                ▼
agents/                            temperature: 0.2             TurnRunner.run
  medical-general.md                 ...                          │
  war-trauma-assessment.md        }                               ▼
  ...                                                          AgentLoop
  │                                                              │
  ▼                                                              ▼
PluginAgentProfileLoader        GatewayProtocol.types         resolveAgentTurnExecution()
  │                                                            │
  ├─ 解析 YAML frontmatter                                    ├─ base config (pilotdeck.yaml)
  ├─ 提取 systemContext                                       ├─ + agent profile (plugin)
  ├─ 路径安全校验                                              ├─ + turn overrides (request)
  └─ 注册 Profile                                              └─ = 最终执行配置
       │
       ▼
ProfileRegistry
  project > global > builtin 优先级
  pluginName:id 命名空间
```

**文件链路**：

| 文件 | 职责 |
|------|------|
| `src/agent/profile/types.ts` | `AgentProfile`、`AgentTurnOverrides`、`ResolvedAgentTurnExecution` 类型定义 |
| `src/agent/profile/ProfileRegistry.ts` | Profile 注册表（按 id 或 `pluginName:id` 查找，project > global > builtin 优先级） |
| `src/agent/profile/validation.ts` | `resolveAgentTurnExecution()` — 合并 base + profile + turnOverrides，校验模型存在性、工具可用性、采样参数范围、metadata 安全 |
| `src/extension/plugins/loading/PluginAgentProfileLoader.ts` | 从 plugin manifest 的 `agents/` 目录加载 Markdown（YAML frontmatter + 正文） |
| `src/extension/plugins/runtime/PluginRuntime.ts` | 插件加载时调用 ProfileLoader，注入 ProfileRegistry |
| `src/gateway/protocol/types.ts` | `GatewaySubmitTurnInput.profile` 和 `turnOverrides` 字段 |
| `src/agent/loop/AgentLoop.ts` | 解析 profile → 追加 systemContext 到 system prompt → 应用模型/工具覆盖 → 记录 profileId |
| `src/model/request/samplingParameterSupport.ts` | 将 topK/minP/repetitionPenalty 等新参数送达各 Provider |

### 4.2 Profile 示例

**`war-trauma-assessment.md`**（战创伤研判 Profile）：

```markdown
---
name: war-trauma-assessment
displayName: 六阶段战创伤研判
description: 六阶段战创伤结构化研判，仅用于受控辅助决策。
maxOutputTokens: 4096
temperature: 0.2
allowedTools: []
deniedTools:
  - bash
  - write_file
  - web_search
  - agent
metadata:
  domain: medical
  workflow: war-trauma
  memoryPolicy: disabled
---

# 战创伤研判

- 仅接受伤员发生地、野战分类场、收容处置组、重伤救治组、手术组和洗消组之一。
- 当前专题接口已生成可信、版本化的五段任务提示；直接输出结果，不再调用工具或读取 Skill。
- 固定输出五段：图像/影像判读、阶段处置、特异处置、分类/伤标/后送/交接、安全禁忌。
- 思考过程必须使用中文；不得在 thinking 中使用英文、日文或其他非中文语言。
- 输出属于辅助研判，必须由现场指挥链和具备资质的医疗人员复核。
```

关键设计决策：
- `allowedTools: []` + `deniedTools: [bash, write_file, web_search, agent]` — 战创伤研判是纯推理任务
- `memoryPolicy: disabled` — 强制关闭跨会话记忆（不可被 Turn Override 逆转）
- `maxOutputTokens: 4096` — 上限约束
- systemContext 正文中的约束 — 注入 system prompt，浏览器不可见、不可篡改

### 4.3 逐 Turn 采样参数覆盖

改造后支持的完整采样参数（通过 `turnOverrides` 字段）：

```typescript
// src/gateway/protocol/types.ts
GatewaySubmitTurnInput.turnOverrides = {
  provider: "openai",           // 可选：切换 Provider
  model: "gpt-4.1",            // 可选：切换模型
  maxOutputTokens: 4096,       // 输出上限
  temperature: 0.2,            // 温度
  topP: 0.85,                  // nucleus sampling
  topK: 40,                    // top-k sampling
  minP: 0.05,                  // min-p sampling
  presencePenalty: 0.2,
  frequencyPenalty: 0.3,
  repetitionPenalty: 1.1,
  seed: 7,                     // 确定性种子
  thinking: {                  // thinking 控制
    enabled: true,
    mode: "low",
    budgetTokens: 512,
  },
  allowedTools: ["read_file"], // 工具白名单（只能收窄 Profile）
  deniedTools: ["bash"],       // 工具黑名单（只能扩展 Profile）
  metadata: {                  // 业务元数据（≤4KB）
    surface: "medical",
    task: "trauma-analysis",
    requestId: "uuid",
  },
};
```

所有参数经过 `resolveAgentTurnExecution()` 校验：
- 模型必须存在于配置中
- `allowedTools` 中的工具必须在 ToolRegistry 中注册
- `deniedTools` 与 Profile 取并集
- metadata 禁止 `apiKey`/`baseUrl`/`secret`/`token`/`password` 等敏感 key
- metadata 单个字符串值 ≤512 字符、总大小 ≤4KB
- `memoryPolicy: disabled` 不可逆（metadata 中的 `memoryPolicy: default` 会被忽略）

---

## 5. Medical Feature Pack

Feature Pack 位于 `products/medical-integration/`，是医疗业务逻辑的完整实现，按 PilotDeck 扩展机制组织：

### 5.1 目录结构

```
products/medical-integration/
├── README.md                          ← 完整使用文档
├── docker-compose.medical.yml         ← 单机离线部署
│
├── plugins/medical-tools/             ← PilotDeck 引擎插件
│   ├── plugin.json                    ← MCP 声明 + agents/commands 入口
│   ├── agents/                        ← 4 个 Agent Profile (md + YAML)
│   │   ├── medical-general.md
│   │   ├── medical-report.md
│   │   ├── medical-deep-search.md
│   │   └── war-trauma-assessment.md
│   └── commands/                      ← 4 个 slash 命令
│
├── skills/                            ← 7 个 Agent Skill (SKILL.md)
│   ├── medical-general/
│   ├── medical-report-interpretation/
│   ├── medicine-package-recognition/
│   ├── medical-deep-search/           ← 含 VLM-describe-first 工作流
│   ├── table-digitization/
│   ├── war-trauma-assessment/
│   └── treatment-plan/                ← 9 段诊疗方案 Skill
│
├── sidecar/                           ← Python 3.11 localhost-only 服务
│   ├── Dockerfile
│   ├── pyproject.toml
│   ├── src/medical_sidecar/
│   │   ├── api/app.py                 ← FastAPI :8765 (REST)
│   │   ├── mcp/server.py + tools.py   ← FastMCP :8766 (30+ tools)
│   │   ├── rag/                       ← 版本化检索
│   │   │   ├── artifacts.py           ← JSONL+NPY 懒加载 + SHA-256 校验
│   │   │   ├── contracts.py           ← RagQuery/RagResult/RagSource 契约
│   │   │   └── embedding.py           ← allowlist-only EmbeddingClient
│   │   ├── ingestion/                 ← 附件解析器
│   │   │   ├── parsers.py             ← TXT/MD/JSON/XML/CDA/PDF/DICOM/WFDB
│   │   │   ├── models.py              ← per-file degraded 状态
│   │   │   └── service.py             ← 批量解析 + manifest
│   │   ├── table/ocr.py               ← 表格 OCR 规范
│   │   ├── imaging/                   ← Gallery/Volume/M3D
│   │   ├── clinical/workflows.py      ← 诊疗方案/翻译/病例库/Eval/Compare
│   │   └── trauma/prompt_builder.py   ← 六阶段 prompt builder
│   └── tests/                         ← 58 项 unittest
│
├── config/
│   ├── medical.yaml                   ← sidecar 无秘密配置
│   └── pilotdeck.example.yaml         ← PilotDeck 安全配置指南
│
├── customer-presets/                  ← 客户差异化管理
│   ├── offline-military/manifest.yaml ← 军方预设
│   └── _template/manifest.yaml        ← 通用模板
│
├── data/
│   ├── asset-manifest.json            ← 制品 Hash 清单
│   ├── med-trauma/war_trauma/         ← 141 个经授权复制的去标识化影像
│   └── rag/                           ← RAG 语料 + 向量
│
├── reference-ui/                      ← 旧 bundle 基线（仅对照，不运行）
├── fixtures/                          ← 无 PHI 合成测试文件
└── scripts/start-dev.ps1              ← 开发环境一键启动
```

### 5.2 Python Sidecar 设计

Sidecar 是医疗数据处理层，设计原则：

1. **不调模型、不持密钥**：所有生成走 PilotDeck Gateway
2. **仅监听 localhost**：FastAPI + FastMCP 双服务均拒绝非回环地址
3. **显式降级**：缺少 PyMuPDF/pydicom/wfdb/numpy 等依赖时返回 `degraded` 而非崩溃
4. **制品完整性**：RAG 语料和向量矩阵启动时校验 SHA-256

**MCP 工具分类**：

| 类别 | 工具 | 功能 |
|------|------|------|
| RAG | `rag_contract` / `rag_status` / `rag_search` / `rag_query` | 版本化检索 + 词法降级 |
| 附件 | `attachments/prepare` | 批量解析 TXT/MD/JSON/XML/CDA/PDF/DICOM/WFDB |
| 表格 | `tables/prepare` / `tables/ocr/prompt` / `tables/ocr/parse` | OCR 提示构建 + 解析 |
| 影像 | `imaging/prepare` / `volume/*` / `gallery/*` | Volume 上传/切片 + Gallery 数据集 |
| M3D | `m3d/health` / `m3d/infer` | 3D 医学影像推理（feature flag） |
| 临床 | `clinical/prompt` / `clinical/parse` / `clinical/translate` | 诊疗方案/翻译契约管线 |

### 5.3 RAG 系统设计

```
浏览器                         Agent                          Sidecar
──────                        ───────                        ───────
开启 RAG 开关                  读取 Skill 指令                  RagArtifactLoader
选择语料 (war-trauma)          ↓                               │
设置 Top-K=3                   调用 MCP Tool:                  ├─ _ensure_loaded()
                              medical_sidecar_rag_query        │   ├─ SHA-256(corpus) ✅
                                ↓                              │   ├─ SHA-256(embedding) ✅
                              query_rag()                      │   ├─ rows == chunks ✅
                                │                              │   └─ 预算检查 ✅
                                ├─ embedding_client?           │
                                │   ├─ ✅: embed_texts()       ├─ search(query_vector)
                                │   │   → cosine 向量检索      │   → heapq top-k
                                │   └─ ❌: search_lexical()    │   → min_score 过滤
                                │       → 中文 bigram 词法     │   → RagResult
                                │       → 精确短语加分         │
                                │                              │
                                ▼                              ▼
                             返回来源 + 逐条引用               返回结构化 RagResult
                             回答末尾标注"参考来源"             generation_owner: pilotdeck
```

与源项目对比的改进：
- **SHA-256 完整性校验**：源项目直接 `np.load()` 无校验
- **词法降级**：源项目 embedding 不可用时直接报错；PilotDeck 自动降级为 bigram 词法匹配
- **MCP 工具化**：4 个 MCP tool（contract/status/search/query），Agent 通过 Skill 自主调用

### 5.4 Customer Preset 管线

解决"一套代码、多客户部署"问题：

```yaml
# customer-presets/offline-military/manifest.yaml
schemaVersion: 1

customer:
  id: "offline-military"
  displayName: "离线战创伤交付版"

branding:
  productName: "九格医学辅助平台"
  dialogueName: "九格医学对话助手"
  traumaName: "九格创伤救治助手"

features:
  dialogue: true
  medTrauma: true
  m3d: false              # ← M3D 默认关闭
  feishu: false           # ← 飞书默认关闭

profiles:
  defaultDialogue: "medical-general"
  trauma: "war-trauma-assessment"

knowledge:
  enabledCorpora: ["war-trauma"]
  defaultCorpus: "war-trauma"
  corpusVersion: "b507f26"

security:
  crossSessionMemory: false
  publicWebSearch: false
  externalTelemetry: false
  requireHumanReview: true
  phiStorage: "temporary-ttl"

deployment:
  offlineLevel: "L2"
```

消费链路：
```
PILOTDECK_MEDICAL_CUSTOMER_PRESET=offline-military
  → medicalPreset.js (YAML 解析 + schema 校验)
  → /api/medical/health (branding + features + security + deployment)
  → UI 动态读取（品牌名、功能开关、安全提示）
```

切换客户只需：`PILOTDECK_MEDICAL_CUSTOMER_PRESET=_template`

---

## 6. UI 层改造

### 6.1 从混淆 Bundle 到原生 TypeScript React

**改造前**：两个 minified React SPA — `static/dialogue/` 和 `static/med-trauma/` — 每个都是单个 `index-*.js` + CSS，完全不可维护。

**改造后**：原生 TypeScript React 组件，完整类型定义，Vitest 测试覆盖。

```
ui/src/features/medical/
├── dialogue/
│   ├── DialoguePage.tsx          ← 608 行（全屏医学对话工作台）
│   ├── DialoguePage.css          ← 三套皮肤（军绿/战地/指挥台）
│   ├── DialoguePage.test.tsx
│   ├── dialogueApi.ts            ← API 客户端 + 预设信息缓存
│   ├── AttachmentManager.tsx     ← 附件管理（per-file 状态 + 重试）
│   ├── DialogueSettingsPanel.tsx
│   └── dialogueTypes.ts
├── trauma/
│   ├── MedTraumaPage.tsx         ← 六阶段战创伤研判
│   ├── MedTraumaPage.css
│   ├── MedTraumaPage.test.tsx
│   └── traumaApi.ts              ← SSE 流式 API
├── imaging/
│   ├── ImagingWorkbench.tsx
│   ├── GalleryPanel.tsx
│   ├── VolumePanel.tsx
│   ├── M3dPanel.tsx
│   └── imagingApi.ts
├── table/
│   ├── TableWorkbench.tsx
│   └── tableApi.ts
├── translation/
│   └── TranslationPanel.tsx      ← 医学翻译面板
├── eval/
│   └── EvalCompareWorkbench.tsx  ← 历史静态评测工作台
└── shared/
    ├── types.ts                  ← 完整类型定义
    ├── constants.ts              ← UI 常量（服务端 catalog 为权威源）
    ├── medicalApi.ts             ← 通用 API 客户端
    ├── MedicalControls.tsx
    ├── MedicalSystemPanel.tsx
    └── useMedicalModels.ts
```

### 6.2 DialoguePage 功能矩阵

```
┌──────────────────────────────────────────────────────┐
│  侧栏                     │  主区域                    │
│                           │                           │
│  ┌──────────────────┐     │  ┌─────────────────────┐ │
│  │ 九格医学对话助手   │     │  │ 任务模式选择器       │ │
│  │ (动态 branding)   │     │  │ [战创伤][报告][药物] │ │
│  └──────────────────┘     │  │ ...                  │ │
│                           │  └─────────────────────┘ │
│  [+ 新对话]               │                           │
│                           │  ┌─────────────────────┐ │
│  会话列表                  │  │ ChatInterfaceV2     │ │
│  ├─ 会话 1               │  │ • 模型选择           │ │
│  ├─ 会话 2               │  │ • 采样参数           │ │
│  └─ ...                  │  │ • Thinking 开关      │ │
│                           │  │ • RAG 开关 + 语料    │ │
│  工作台入口               │  │ • 附件管理           │ │
│  ├─ 表格 OCR             │  │ • 欢迎/对话/错误     │ │
│  ├─ 影像 Gallery          │  └─────────────────────┘ │
│  └─ Volume 3D            │                           │
└──────────────────────────────────────────────────────┘
```

### 6.3 MedTraumaPage 两阶段 SSE 流程

```
用户选择阶段 + 上传图片 + 描述 → 点击"开始分析"
  │
  ▼
SSE 事件流:
  event: ready         → { type: "ready", sessionId, task }
  event: session       → { type: "session", sessionId }
  event: meta          → { type: "meta", stage, images[], generationOwner: "pilotdeck" }
  event: modality_start → { imageIndex: 0, category: "wound" }
  event: modality_done  → { imageIndex: 0, result: "..." }
  event: modality_start → { imageIndex: 1, category: "xray" }
  event: modality_done  → { imageIndex: 1, result: "..." }
  event: assessment_start → { modalityCount: 2 }
  event: token          → { text: "一、图像/影像判读\n...", scope: "assessment" }
  event: token          → { text: "二、阶段处置\n...", scope: "assessment" }
  ...                   → (五段输出逐 token 流式)
  event: done           → { reason: "stop", usage: {...} }
```

### 6.4 品牌动态化

品牌名称不再硬编码，统一从 `/api/medical/health` 读取：

```typescript
// DialoguePage.tsx — 改造前
<div className="medical-sidebar-title">九格医学对话助手</div>

// DialoguePage.tsx — 改造后
const [branding, setBranding] = useState<MedicalPresetInfo | null>(null);
useEffect(() => {
  fetchMedicalPresetInfo().then(setBranding);
}, []);

<div className="medical-sidebar-title">
  {branding?.branding?.dialogueName ?? '九格医学对话助手'}
</div>
```

切换 preset 后无需改代码，重启即生效。

---

## 7. 安全护栏

### 7.1 多层防护体系

```
Layer 1: Gateway 边界
  ├─ Bearer Token 认证
  ├─ 会话所有权校验（medical:s_<sha256(owner)>_ 前缀）
  ├─ 并发限制（全局 8 / 每用户 2）
  └─ 客户端 system prompt 拒绝

Layer 2: 生成安全（medicalSafetyRails）
  ├─ n-gram 循环检测（连续 6 次重复 → abort）
  ├─ 弱答案自动重试（< 80 字且非 JSON → 重试 1 次）
  └─ thinking 语言强制（Profile systemContext 中文约束）

Layer 3: 数据安全
  ├─ PHI 默认不持久化（temporary-ttl）
  ├─ DICOM burned-in PHI 门禁
  ├─ 图片安全重编码（剥离元数据）
  ├─ CSV 公式注入防护
  └─ Volume TTL 自动清理

Layer 4: 错误安全
  ├─ 错误脱敏（不泄漏路径/Endpoint/密钥/堆栈）
  ├─ SSRF 防护（embedding endpoint allowlist + redirect 拒绝）
  ├─ 路径穿越防护（resolve_under_root）
  └─ XML 外部实体禁止

Layer 5: 审计
  ├─ 8 列结构化审计（RAG 版本/附件 SHA-256/prompt 版本/profile/model/source_ids/retry_count）
  ├─ PHI 自动脱敏过滤
  └─ 90 天 TTL + 可验证删除
```

### 7.2 n-gram 循环检测

```javascript
// 原理：连续 N 次重复的 80-char 块 → 触发 abort
const REPETITION_NGRAM = 80;
const REPETITION_MAX = 6;

// 积累文本 ≥500 chars 后开始检测
// 每次取最后 80 chars 的 n-gram
// 连续 6 次相同 → emit MEDICAL_REPETITION_LOOP + abort

// 效果：检测到模型陷入重复循环后立即终止，不浪费 token
```

### 7.3 弱答案重试

```javascript
const WEAK_ANSWER_MIN_CHARS = 80;
const MAX_RETRIES = 1;

// 检测条件：
// 1. 输出 < 80 字
// 2. 不是有效的结构化 JSON
// 满足 → 以增强 prompt 重试 1 次
// 重试仍弱 → 诚实返回 + warning，不伪造成功
```

---

## 8. 核心模式映射

### 8.1 源项目 → PilotDeck 完整对照

| # | 源项目模式 | 源项目实现 | PilotDeck 实现 | 改进 |
|---|-----------|-----------|---------------|------|
| 1 | 模型调用 | 两个后端各自 `client.chat.completions.create()` | `AgentLoop` → `RouterRuntime` → `ModelRuntime`（统一入口） | 单一路由、故障降级、Token Saver |
| 2 | 会话管理 | Dialogue 自有 SQLite，Trauma 无状态 | JSONL transcript（Session / Turn / Run） | 可恢复、可审计、跨入口共享 |
| 3 | 任务模式 Prompt | `TASK_MODE_PROMPTS` 字典 + `PUT /system-prompt` | `AgentProfile.systemContext`（可信）+ Skill 指令 | 不可篡改、版本化、Profile 级别 |
| 4 | RAG 检索 | `WarTraumaRAG.retrieve()` numpy 直接加载 | `RagArtifactLoader` → MCP tools | SHA-256 校验、词法降级、契约化 |
| 5 | VLM-describe-first | `RAG_DESCRIBE_PROMPT` + `rag_describe_first` form | Skill 工作流 + Agent Profile 指令 | Agent 自主决策调用时机 |
| 6 | 附件解析 | `ingestion/parsers.py` 直接调用 | Sidecar MCP tools（per-file `degraded`） | 可选依赖、显式降级、批量 manifest |
| 7 | 表格 OCR | Python 内调模型 + `table_ocr.py` | MCP 构建 prompt → ModelRuntime 生成 → MCP 解析 | 三阶段契约、模型统一管理 |
| 8 | 创伤 SSE 协议 | `meta/modality_start/token/done` typed events | `runTraumaPipeline` 两阶段管线 | 向后兼容 + `assessment_start` 新增 |
| 9 | 诊疗方案 | 原始文本 prompt + JSON 返回 | `clinical-workflows.v1` 契约（sidecar 构建 → Gateway 生成 → sidecar 校验） | 9 段 schema、source_ids 绑定、humanReviewRequired |
| 10 | 模型注册表 | `runtime_model_registry.json` + env 合并 | PilotDeck `model.providers.*` YAML | 统一配置、per-model samplingPresets |
| 11 | 认证 | ❌ 无（空 API Key） | Bearer Token + 会话所有权 + RBAC | 完整认证链 |
| 12 | 配置管理 | `config.env` + 代码内硬编码 | `customer-presets/*/manifest.yaml` | schema 校验、版本化、可切换 |
| 13 | 离线部署 | bash 脚本 + conda-pack | Docker Compose + 嵌入式 runtime | 可移植、完整性校验 |
| 14 | 安全护栏 | 0320 模型弱答案重试 | n-gram 循环检测 + 弱答案重试 + thinking 强制 | 模型无关、可配置 |
| 15 | 前端 | 混淆 minified bundle | 原生 TypeScript React + Vitest | 可维护、可测试、可审计 |

### 8.2 两阶段创伤分析管线（重点模式）

这是最具代表性的模式映射——源项目的 typed SSE 协议被完整映射到 PilotDeck 但架构完全不同：

**源项目**（Python 单体）：
```python
# serve_vllm.py — 一个函数内完成
async def war_trauma_analyze():
    for modality in images:
        yield modality_start   # → SSE
        response = client.chat.completions.create(...)  # 直调模型
        yield modality_done    # → SSE
    yield assessment_start    # → SSE
    response = client.chat.completions.create(...)      # 再次直调
    yield token(...)          # → SSE
```

**PilotDeck**（Agent OS 原生）：
```javascript
// medicalTraumaPipeline.js — 两阶段通过 Gateway 的两次 Turn 完成
async function runTraumaPipeline({ prompt, images, runChat, ... }) {
  // Phase A: 感知阶段
  for (const image of images) {
    emit('modality_start', { imageIndex });
    // 每张图片作为独立 Turn 经 Gateway 生成影像判读
    await runChat(perceptionPrompt, { profile: 'war-trauma-modality-perception' }, writer);
    emit('modality_done', { imageIndex, result });
  }

  // Phase B: 评估阶段
  emit('assessment_start');
  // 汇总感知结果 + RAG 上下文 → 统一 Turn 生成五段输出
  await runChat(assessmentPrompt, { profile: 'war-trauma-assessment', images }, writer);
  emit('done');
}
```

**关键差异**：
- 源项目在 Python 后端内直接调模型 → PilotDeck 全部经 Gateway
- 源项目手动管理 SSE → PilotDeck 用 AgentLoop 自动管理流式事件
- 源项目硬编码两阶段逻辑 → PilotDeck 通过 Profile 切换实现（可配置、可复用）

---

## 9. 数据流全景

### 9.1 医疗对话完整数据流

```text
1. 用户输入
   浏览器 DialoguePage
     │
     ├─ 任务模式: 战创伤诊断
     ├─ 模型选择: G9-V-Med
     ├─ RAG: 开启, war-trauma 语料, Top-K=3
     ├─ Thinking: 开启
     ├─ 附件: 2 张 DICOM + 1 张 JPEG
     └─ 文本: "请分析伤情"

2. UI Server — 预处理
   POST /api/medical/sidecar/attachments/prepare
     → Python sidecar ingestion
     → DICOM: burned-in PHI 门禁 ✅ → 脱敏帧提取
     → JPEG: 安全重编码 ✅ → 剥离元数据
     → 返回 manifest + 预览 URL
     → UI 缓存附件解析结果

3. UI Server — 发起对话
   POST /api/medical/dialogue/chat (SSE)
     → buildDialoguePrompt(profile, taskMode, conversation)
     → BEGIN_UNTRUSTED_CLINICAL_DATA ... END_UNTRUSTED_CLINICAL_DATA
     → createTrustedGatewayTurnOptions({
         profile: "medical-general",
         disableTools: true,
         maxTurns: 1,
         turnOverrides: { metadata: { surface: "medical" } }
       })

4. Gateway — Agent 运行时
   InProcessGateway.submitTurn
     → SessionRouter.getOrCreate("medical:s_<hash>")
     → AgentSession.submit
     → TurnRunner.run
       → TurnInputProcessor (解析附件/图片)
       → ContextRuntime.prepareForModel
       → ProfileRegistry.get("medical-general")
       → resolveAgentTurnExecution(base + profile + turnOverrides)
         → provider: openai, model: G9-V-Med
         → temperature: 0.2, maxOutputTokens: 2048
         → allowedTools: [], deniedTools: [bash, write_file, web_search]
         → systemContext: "..." (可信, 浏览器不可见)
       → RouterRuntime.decide (Smart Router)

5. 模型推理
   ModelRuntime → OpenAI-compatible Provider
     → POST /v1/chat/completions
     → stream: true
     → messages: [system prompt + user prompt + images]
     → 流式返回

6. 安全护栏（inline）
   n-gram 重复检测 → safe ✅
   弱答案检测 → 不触发 (输出 > 80 字)
   thinking delta → SSE <think> 标签透传

7. SSE 返回
   event: ready
   event: session
   event: thinking  → data: { text: "<think>" }
   event: thinking  → data: { text: "伤口分析..." }
   event: thinking  → data: { text: "</think>" }
   event: delta     → data: { text: "一、图像判读\n..." }
   event: delta     → data: { text: "..." }
   event: status    → data: { phase: "context" }
   event: done      → data: { reason: "stop", usage: {...} }

8. 持久化
   JSONL transcript 落盘 (.pilotdeck/sessions/)
   medical_audit 写入 (owner_hash, profile_id, model_id, ...)
   附件缓存 TTL 管理
```

### 9.2 关键边界

```
                     ┌─ 浏览器可控制 ─┐   ┌─── 服务端可信 ───┐
                     │                 │   │                    │
model selection      ✅ (从 /models 列表选择)  ✅ (路由层最终决定)
sampling params      ✅ (UI 滑块)               ✅ (Profile 上限约束)
system prompt        ❌ (明确拒绝)              ✅ (Profile systemContext)
tool allow/deny      ❌                         ✅ (Profile + Turn Override)
API Key / Endpoint   ❌ (不可见)                ✅ (服务端配置)
PHI data             ✅ (用户上传)              ✅ (TTL 存储 + 脱敏审计)
```

---

## 10. 部署与交付

### 10.1 开发模式

```powershell
# 一键启动（Windows PowerShell）
powershell -ExecutionPolicy Bypass `
  -File .\products\medical-integration\scripts\start-dev.ps1 `
  -Config .\products\medical-integration\config\medical.yaml
```

自动启动：
- Python sidecar API（端口 8765）
- Python sidecar MCP（端口 8766）
- PilotDeck Gateway（端口 18789）
- UI Server（端口 3001）
- Vite Dev Server（端口 5173）

`Ctrl+C` 后自动清理所有进程。

### 10.2 Docker 离线交付

```bash
docker compose -f products/medical-integration/docker-compose.medical.yml up --build
```

```
┌─────────────────────────────────────────┐
│ Docker Compose                           │
│                                          │
│  ┌──────────────────────────────────┐   │
│  │ pilotdeck (主容器)                │   │
│  │  • Gateway :18789                │   │
│  │  • UI Server :3001               │   │
│  │  • 持久卷: pilotdeck-home        │   │
│  └──────┬───────────────────────────┘   │
│         │ network_mode: service:pilotdeck │
│  ┌──────▼──────────┐ ┌────────────────┐ │
│  │ medical-api      │ │ medical-mcp    │ │
│  │ :8765            │ │ :8766          │ │
│  │ (REST, health)   │ │ (MCP tools)    │ │
│  └──────────────────┘ └────────────────┘ │
│                                          │
│  数据挂载 (只读):                         │
│  • ./data → /app/products/.../data       │
│  • ./plugins → ~/.pilotdeck/plugins      │
└──────────────────────────────────────────┘
```

Sidecar 通过 `network_mode: service:pilotdeck` 共享网络命名空间，仅监听 127.0.0.1，**不会向宿主机或容器网络暴露医疗内部端口**。

---

## 11. 测试体系

### 11.1 三层门禁

```
每次提交后必须通过：

┌─────────────────────────────────────────────┐
│ Gate 1: 引擎测试                              │
│ npm run build && npm test                    │
│ → TypeScript 编译 + 209 项 node:test          │
│ → 覆盖: Profile/Thinking/Streaming/Agent/... │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ Gate 2: UI/Server 测试                        │
│ cd ui && npx vitest run                      │
│ → 110 项 Vitest                               │
│ → 覆盖: medical routes/services/SSE/安全      │
└─────────────────────────────────────────────┘
                    ↓
┌─────────────────────────────────────────────┐
│ Gate 3: Sidecar 测试                          │
│ cd sidecar && python -m unittest discover    │
│ → 58 项 unittest                              │
│ → 覆盖: RAG/附件/表格/影像/临床/配置          │
└─────────────────────────────────────────────┘
```

### 11.2 测试覆盖矩阵

| 测试类别 | 数量 | 覆盖内容 |
|---------|------|---------|
| 引擎单元测试 | 209 项 | Profile 解析/校验/合并、AgentLoop 执行、Gateway 协议、Model/Router/Tool、Compaction |
| UI/Server 测试 | 110 项 | medical.js 路由、medicalResources.js CRUD、SSE 事件规范、错误脱敏、安全护栏 |
| Sidecar 测试 | 58 项 | RAG 检索/词法降级、附件解析/degraded、表格 OCR 契约、Volume/Gallery 边界、配置校验 |
| e2e 测试 | 3 份 spec (15+ 用例) | Dialogue 聊天流程、Trauma 两阶段 SSE、降级态（sidecar 停止/M3D 关闭）、未认证 401 |

---

## 12. 成果统计

### 12.1 代码变更

| 类别 | 数量 |
|------|------|
| 新建文件 | ~30 个 |
| 修改文件 | ~15 个 |
| 恢复测试文件 | 62 个 |
| 新增代码行 | ~8,000 行 |
| Agent Profile | 4 个 |
| Medical Skills | 7 个 |
| MCP Tools | 30+ 个 |
| UI 组件 | 10+ 个 |
| 测试用例 | 377+ 项 |

### 12.2 架构改善

| 指标 | 改造前 | 改造后 |
|------|--------|--------|
| 生成入口 | 3 个（Dialogue/Trauma/Gateway） | 1 个（PilotDeck Gateway） |
| 模型调用 | Python 直调 | ModelRuntime 统一管理 |
| 会话存储 | 分散 SQLite + 无状态 | 统一 JSONL transcript |
| 认证 | 无 | Bearer Token + 所有权 |
| 审计 | 无 | PHI-safe 8 列结构化日志 |
| 前端 | 混淆 bundle | 原生 TypeScript React |
| 配置 | env + 硬编码 | Preset YAML（schema 校验） |
| 部署 | bash 脚本 | Docker Compose |
| 测试 | 0 项 | 377+ 项 |
| 离线等级 | L2（功能可用） | L2（Hash 校验 + 词法降级） |

### 12.3 关键文件索引

| 文件 | 职责 | 行数 |
|------|------|------|
| `src/agent/profile/types.ts` | Agent Profile 类型系统 | ~120 |
| `src/agent/profile/ProfileRegistry.ts` | Profile 注册表 | ~80 |
| `src/agent/profile/validation.ts` | Profile 校验与合并 | ~200 |
| `src/agent/loop/AgentLoop.ts` | Agent 主循环（Profile 集成点） | ~3400 |
| `ui/server/routes/medical.js` | 医疗 API 路由 + SSE 管线 + 安全护栏 | ~2500 |
| `ui/server/routes/medicalResources.js` | 医疗资源 CRUD + 契约管线 | ~2500 |
| `ui/server/services/medicalCatalog.js` | 服务端目录（Profile/Task/Stage/Prompt） | ~350 |
| `ui/server/services/medicalStore.js` | SQLite 存储 + 审计 v2 | ~650 |
| `ui/server/services/medicalPreset.js` | Customer Preset 管线 | ~350 |
| `ui/server/services/medicalSafetyRails.js` | 安全护栏 | ~250 |
| `ui/server/services/medicalTraumaPipeline.js` | 两阶段创伤管线 | ~300 |
| `ui/server/services/medicalSidecar.js` | Sidecar HTTP 适配器 | ~500 |
| `sidecar/src/medical_sidecar/rag/artifacts.py` | RAG 制品加载器 | ~350 |
| `sidecar/src/medical_sidecar/rag/contracts.py` | RAG 契约定义 | ~200 |
| `sidecar/src/medical_sidecar/config.py` | Sidecar 配置 schema | ~750 |
| `sidecar/src/medical_sidecar/mcp/tools.py` | MCP 工具实现 | ~250 |
| `sidecar/src/medical_sidecar/clinical/workflows.py` | 临床工作流契约 | ~200 |

---

## 附录：术语表

| 术语 | 定义 |
|------|------|
| **Agent OS** | 统一运行和管理 Agent 应用的平台 |
| **Gateway** | 所有 Channel 进入 Agent Runtime 的统一入口 |
| **AgentLoop** | 模型和工具之间的循环执行器 |
| **Profile** | 可信 Agent 角色、模型默认值、系统 Prompt 和工具策略 |
| **Skill** | 模型按需读取的领域工作说明（Markdown） |
| **Plugin** | 组合 Skill、Command、Hook 和 MCP 的扩展包 |
| **MCP** | Model Context Protocol — 外部工具和数据服务接入协议 |
| **Sidecar** | 与主进程分离的领域服务（仅 localhost） |
| **RAG** | Retrieval-Augmented Generation — 检索增强生成 |
| **PHI** | Protected Health Information — 受保护健康信息 |
| **Preset** | 客户差异化的版本化配置清单 |
| **Transcript** | 可恢复的会话事件记录（JSONL） |
| **Two-Phase Pipeline** | 感知阶段（per-modality 影像判读）→ 评估阶段（汇总 + RAG → 结构化输出） |
