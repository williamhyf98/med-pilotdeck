# PilotDeck 医疗改造 — 代码改动清单

> 基于 PilotDeck v0.1.0 原始代码的完整改动记录
>
> 日期：2026-08-12

---

## 一、PilotDeck 引擎层改造（`src/`）—— 核心框架扩展

这是最关键的部分。PilotDeck 原始的 `plugin.json` 虽然有 `agents` 字段声明，但**完全没有接线**。本次从零构建了完整的 Agent Profile 系统。

### 新增文件（引擎层）

| 文件 | 说明 |
|------|------|
| `src/agent/profile/types.ts` | AgentProfile、AgentTurnOverrides、ResolvedAgentTurnExecution 类型定义 |
| `src/agent/profile/ProfileRegistry.ts` | Profile 注册表（project > global > builtin 优先级，`pluginName:id` 命名空间） |
| `src/agent/profile/validation.ts` | `resolveAgentTurnExecution()` — 合并 base + profile + turnOverrides，校验模型存在性、工具可用性、采样参数范围、metadata 安全 |
| `src/extension/plugins/loading/PluginAgentProfileLoader.ts` | 从 plugin manifest 的 `agents/` 目录加载 Markdown（YAML frontmatter + 正文），路径安全校验 |

### 修改文件（引擎层）

| 文件 | 改动内容 |
|------|----------|
| `src/agent/loop/AgentLoop.ts` | 集成 Profile 系统：解析 profile → 追加 systemContext → 应用模型/工具覆盖 → 记录 profileId |
| `src/extension/plugins/runtime/PluginRuntime.ts` | 插件加载时调用 ProfileLoader，注入 ProfileRegistry |
| `src/gateway/protocol/types.ts` | 新增 `profile` 和 `turnOverrides` 字段到 Gateway 协议 |
| `src/model/request/samplingParameterSupport.ts` | 新增 topK/minP/repetitionPenalty 等采样参数，送达各 Provider |

---

## 二、UI Server 层（`ui/server/`）—— 医疗 API 路由 + 安全护栏

### 新增文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `ui/server/routes/medical.js` | ~2500 | 医疗 API 路由 + SSE 管线 + 安全护栏 |
| `ui/server/routes/medicalResources.js` | ~2500 | 医疗资源 CRUD + 契约管线 |
| `ui/server/services/medicalCatalog.js` | ~350 | 服务端目录（Profile/Task/Stage/Prompt） |
| `ui/server/services/medicalStore.js` | ~650 | SQLite 存储 + PHI 审计 v2 |
| `ui/server/services/medicalPreset.js` | ~350 | Customer Preset 管线（YAML 解析 + Schema 校验） |
| `ui/server/services/medicalSafetyRails.js` | ~250 | n-gram 循环检测 + 弱答案重试 + thinking 强制中文 |
| `ui/server/services/medicalTraumaPipeline.js` | ~300 | 两阶段创伤 SSE 管线 |
| `ui/server/services/medicalSidecar.js` | ~500 | Sidecar HTTP 适配器（代理到 localhost:8765） |

---

## 三、UI 前端层（`ui/src/`）—— 医疗原生 React 组件

### 新增文件（40 个文件，整个 `features/medical/` 目录）

```
ui/src/features/medical/
├── dialogue/
│   ├── DialoguePage.tsx          # 608 行，全屏医学对话工作台
│   ├── DialoguePage.css          # 三套皮肤（军绿/战地/指挥台）
│   ├── DialoguePage.test.tsx
│   ├── dialogueApi.ts            # API 客户端 + 预设信息缓存
│   ├── dialogueApi.spec.ts
│   ├── AttachmentManager.tsx     # 附件管理（per-file 状态 + 重试）
│   ├── DialogueSettingsPanel.tsx
│   └── dialogueTypes.ts
├── trauma/
│   ├── MedTraumaPage.tsx         # 六阶段战创伤研判
│   ├── MedTraumaPage.test.tsx
│   ├── traumaApi.ts
│   └── traumaApi.test.ts
├── imaging/
│   ├── ImagingWorkbench.tsx
│   ├── GalleryPanel.tsx
│   ├── VolumePanel.tsx
│   ├── M3dPanel.tsx
│   ├── ImagingMetadataAdvanced.tsx
│   ├── imagingApi.ts
│   └── imagingApi.spec.ts
├── table/
│   ├── TableWorkbench.tsx
│   ├── TableWorkbench.test.tsx
│   ├── tableApi.ts
│   └── tableApi.spec.ts
├── translation/
│   └── TranslationPanel.tsx
├── eval/
│   └── EvalCompareWorkbench.tsx
└── shared/
    ├── constants.ts
    ├── medicalApi.ts
    ├── medicalApi.spec.ts
    ├── MedicalControls.tsx
    ├── MedicalSystemPanel.tsx
    └── useMedicalModels.ts
```

### 修改文件（UI 现有组件集成医疗入口）

| 文件 | 改动内容 |
|------|----------|
| `ui/src/components/app-shell/AppShellV2.tsx` | +40 行：医疗路由匹配、medical-dialogue/medical-trauma Tab 切换、URL 保持 |
| `ui/src/components/app-shell/MainAreaV2.tsx` | 新增 MEDICAL_TABS 常量、医疗 Tab 渲染逻辑 |
| `ui/src/components/main-content/view/MainContent.tsx` | 懒加载 DialoguePage / MedTraumaPage，路由分发 |
| `ui/src/components/chat-v2/ComposerV2.tsx` | 新增 `chromeMode: 'medical'` 支持 |
| `ui/src/components/chat/tools/configs/toolConfigs.ts` | 新增 8 个 medical MCP tool 的 `medicalToolConfig()` |
| `ui/src/components/chat/hooks/useChatComposerState.ts` | 新增 `medical_task_context` 注入逻辑 |
| `ui/src/components/chat/types/types.ts` | 新增 `composerChrome: 'medical'` 类型 |
| `ui/src/hooks/useProjectsState.ts` | 新增 `medical-dialogue` / `medical-trauma` 到持久化 Tab 列表 |
| `ui/src/types/app.ts` | 新增 `'medical-dialogue'` / `'medical-trauma'` 到 AppTab 联合类型 |

---

## 四、Dockerfile 修改

| 文件 | 改动 |
|------|------|
| `Dockerfile` | 从原始 PilotDeck Dockerfile 改为 4 阶段 Medical Docker 构建（deps → engine-build → ui-build → runtime），新增 `COPY products/`、entrypoint 脚本 |

---

## 五、测试文件（引擎层新增 Profile 测试）

### 新增/修改

| 文件 | 说明 |
|------|------|
| `tests/agent/profile/agent-loop-profile.spec.ts` | Profile 注入 AgentLoop 的端到端测试 |
| `tests/agent/profile/profile-registry.spec.ts` | ProfileRegistry 注册/查找/优先级测试 |
| `tests/agent/profile/router-explicit-profile.spec.ts` | Profile 模型路由决策测试 |
| `tests/agent/profile/turn-override-flow.spec.ts` | Turn 级别采样参数覆盖测试 |

---

## 六、项目级配置文件（新增）

| 文件 | 说明 |
|------|------|
| `.claude/settings.local.json` | Claude Code 本机权限配置（允许 tsc/npm test 等） |
| `.pilotdeck/plugins/medical-tools` | → 软链接到 `products/medical-integration/plugins/medical-tools` |
| `.pilotdeck/skills/medical-deep-search` | → 软链接 |
| `.pilotdeck/skills/medical-general` | → 软链接 |
| `.pilotdeck/skills/medical-report-interpretation` | → 软链接 |
| `.pilotdeck/skills/medicine-package-recognition` | → 软链接 |
| `.pilotdeck/skills/table-digitization` | → 软链接 |
| `.pilotdeck/skills/war-trauma-assessment` | → 软链接 |

---

## 七、文档（新增）

| 文件 | 说明 |
|------|------|
| `docs/PILOTDECK_MEDICAL_TRANSFORMATION_REPORT.md` | 完整的医疗改造技术报告（1062 行） |
| `docs/pilotdeck-medical-integration-research.md` | 框架调研与接入设计文档 |
| `docs/medical-native-ui-acceptance.md` | UI 复刻验收基线 |
| `products/medical-integration/README.md` | Medical Feature Pack 使用文档 |

---

## 八、Medical Feature Pack 完整新增（`products/medical-integration/`）

这是纯新增目录，**约 45 个文件，~7500+ 行代码**：

### Sidecar 源码（18 个文件）

```
products/medical-integration/sidecar/src/medical_sidecar/
├── __init__.py
├── config.py                  # ★ 720 行分层配置系统
├── capabilities.py
├── npy.py                     # NPY 懒加载
├── api/
│   ├── __init__.py
│   ├── __main__.py
│   └── app.py                 # ★ FastAPI 30+ 端点
├── mcp/
│   ├── __init__.py
│   ├── __main__.py
│   ├── server.py              # MCP HTTP Server
│   └── tools.py               # ★ 25+ MCP 工具实现
├── ingestion/
│   ├── __init__.py
│   ├── contracts.py           # 格式检测 + 安全路径
│   ├── parsers.py             # ★ 多格式附件解析器（900 行）
│   └── service.py             # 批量附件处理
├── rag/
│   ├── __init__.py
│   ├── contracts.py           # 检索契约
│   ├── artifacts.py           # ★ JSONL + NPY 制品加载
│   └── embedding.py           # embedding 客户端
├── clinical/
│   ├── __init__.py
│   └── workflows.py           # ★ 五类临床工作流
├── trauma/
│   ├── __init__.py
│   └── prompt_builder.py      # ★ 六阶段战创伤 Prompt
├── table/
│   ├── __init__.py
│   ├── contracts.py           # 表格规范化 + CSV 安全
│   └── ocr.py                 # 表格 OCR 契约
└── imaging/
    ├── __init__.py
    ├── contracts.py           # 影像元数据契约
    ├── gallery.py             # ★ Gallery 扫描器
    ├── volume.py              # Volume 数据处理
    ├── volume_store.py        # Volume 存储引擎
    └── m3d.py                 # M3D adapter
```

### Sidecar 测试（6 个文件，58 项 unittest）

| 文件 | 说明 |
|------|------|
| `sidecar/tests/__init__.py` | 测试包 |
| `sidecar/tests/fixtures.py` | 测试夹具（合成 NPY 生成器等） |
| `sidecar/tests/test_contracts.py` | 契约测试（附件/RAG/Embedding/表格/战创伤/影像/配置） |
| `sidecar/tests/test_parsers.py` | 解析器测试（文本/JSON/XML/PDF/DICOM/WFDB/图像） |
| `sidecar/tests/test_api.py` | FastAPI REST 端点测试 |
| `sidecar/tests/test_artifacts_volume.py` | RAG 制品 + Volume 存储测试 |
| `sidecar/tests/test_extended_features.py` | Gallery + Volume TTL + M3D + Prompt 契约测试 |

### Sidecar 样例数据

| 文件 | 说明 |
|------|------|
| `sidecar/sample_data/rag_records.jsonl` | 3 条合成 RAG 记录 |
| `sidecar/sample_data/table_model_output.md` | 合成表格输出 |
| `sidecar/sample_data/trauma_request.json` | 合成战创伤请求 |

### 插件（9 个文件）

| 文件 | 说明 |
|------|------|
| `plugins/medical-tools/plugin.json` | 插件注册清单（MCP + agents + commands） |
| `plugins/medical-tools/agents/medical-general.md` | 通用医学助手 Profile |
| `plugins/medical-tools/agents/medical-report.md` | 报告解读专家 Profile |
| `plugins/medical-tools/agents/medical-deep-search.md` | 深度检索专家 Profile |
| `plugins/medical-tools/agents/war-trauma-assessment.md` | 战创伤研判专家 Profile |
| `plugins/medical-tools/commands/medical-general.md` | Slash Command |
| `plugins/medical-tools/commands/medical-report.md` | Slash Command |
| `plugins/medical-tools/commands/medical-deep-search.md` | Slash Command |
| `plugins/medical-tools/commands/war-trauma.md` | Slash Command |

### 技能（7 个 SKILL.md）

| 文件 | 说明 |
|------|------|
| `skills/medical-general/SKILL.md` | 通用医学对话工作流 |
| `skills/medical-report-interpretation/SKILL.md` | 医学报告解读工作流 |
| `skills/medical-deep-search/SKILL.md` | 医学深度检索（含 VLM-describe-first 工作流） |
| `skills/medicine-package-recognition/SKILL.md` | 药品包装识别工作流 |
| `skills/table-digitization/SKILL.md` | 表格数字化工作流 |
| `skills/treatment-plan/SKILL.md` | 9 段诊疗方案生成工作流 |
| `skills/war-trauma-assessment/SKILL.md` | 六阶段战创伤研判工作流 |

### Profile 模板（4 个）

| 文件 | 说明 |
|------|------|
| `profiles/medical-general.md` | 通用医学助手模板 |
| `profiles/medical-report.md` | 报告解读专家模板 |
| `profiles/medical-deep-search.md` | 深度检索专家模板 |
| `profiles/war-trauma.md` | 战创伤研判专家模板 |

### 配置（3 个文件）

| 文件 | 说明 |
|------|------|
| `config/medical.yaml` | Sidecar 开发环境配置 |
| `config/medical.example.yaml` | 无秘密示例配置 |
| `config/pilotdeck.example.yaml` | PilotDeck 安全配置指南 |

### 客户预设（2 个文件）

| 文件 | 说明 |
|------|------|
| `customer-presets/offline-military/manifest.yaml` | 离线战创伤交付版预设 |
| `customer-presets/_template/manifest.yaml` | 通用模板预设 |

### 脚本与部署（2 个文件）

| 文件 | 说明 |
|------|------|
| `scripts/start-dev.ps1` | Windows 开发环境一键启动脚本 |
| `docker-compose.medical.yml` | Docker 三服务编排（pilotdeck + medical-api + medical-mcp） |

---

## 九、未修改的核心框架文件

以下 PilotDeck 核心目录**完全没有修改**（grep 确认不含 "medical" 或 "sidecar" 关键词）：

```
src/adapters/       # 所有 Channel 适配器（CLI/Web/飞书/钉钉/Discord/微信等）
src/always-on/      # Always-on 常驻执行
src/cli/            # CLI 入口
src/context/        # 上下文记忆系统
src/cron/           # 定时任务
src/mcp/            # MCP 协议实现
src/model/          # 模型路由与 Provider（除 samplingParameterSupport.ts）
src/network/        # 网络层
src/permission/     # 权限管理
src/pilot/          # 核心调度引擎
src/router/         # ClawXRouter 智能路由
src/session/        # 会话管理
src/status/         # 状态管理
src/task/           # 任务编排
src/telemetry/      # 遥测
src/web/            # Web 服务
```

---

## 十、统计总表

| 类别 | 新增文件 | 修改文件 | 新增代码行（估算） |
|------|----------|----------|-------------------|
| 引擎层（src/） | 4 | 4 | ~700 |
| UI Server（ui/server/） | 8 | 0 | ~6,400 |
| UI 前端（ui/src/） | 40 | 9 | ~3,000 |
| Sidecar 源码 | 18 | 0 | ~4,500 |
| Sidecar 测试 | 6 | 0 | ~1,500 |
| 插件/Skills/Profiles | 20 | 0 | ~400 |
| 配置/预设/脚本 | 6 | 0 | ~300 |
| 文档 | 3 | 0 | ~1,500 |
| Dockerfile | 0 | 1 | ~50 |
| 项目配置 | 3 文件 + 7 软链接 | 0 | ~10 |
| 引擎测试 | 4 | 0 | ~300 |
| **合计** | **~109** | **~14** | **~18,600+** |

---

## 关键设计原则

1. **`src/` 核心框架不引入医疗硬编码** — Profile 系统是通用的 Agent 扩展机制，医疗只是其第一个使用场景
2. **所有医疗业务逻辑独立隔离** — 在 `products/medical-integration/`（后端）和 `ui/src/features/medical/`（前端）中维护
3. **PilotDeck 是唯一生成入口** — Python Sidecar 不调模型、不持密钥，只构造 prompt 和校验输出
4. **客户差异不建源码分支** — 通过 customer-preset + feature flag + Profile + Plugin 组合管理
