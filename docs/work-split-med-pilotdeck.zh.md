# med-pilotdeck 协作工作清单与实现说明

> **2026-08-19 更新：** 已物理删除 `products/medical-integration` 与专用医疗 UI / `/api/medical`。现行医疗路径为 `plugins/med-tools`。离线化后续步骤见 [`offline-deployment-plan.md`](./offline-deployment-plan.md)。

> 文档版本：2026-08-14（修订：已拍板 Q1–Q5）  
> 适用分支建议：功能各自开 `feat/*`，避免互相污染；合入前在 `feat/add-new-skill` 或约定主开发分支上集成。

本文用于**分工、对齐实现方式与验收标准**。§9 待确认项已于 2026-08-14 拍板并回写正文。

---

## 1. 目标与原则

### 1.1 产品方向（已对齐）


| 原则               | 说明                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------- |
| 医学能力主路径          | 以 `plugins/med-tools`（Skill + stdio MCP）扩展，让 **PilotDeck 普通对话 Agent** 调用            |
| 不再依赖 product 运行时 | 新能力**不依赖** `products/medical-integration` 路径，不启动 medical sidecar（`:8765` / `:8766`） |
| product 目录       | **先冻结**：目录保留、不启动；插件侧能力跑通后再逐步删除                                                      |
| 生成归属             | **方案 A**：工具负责解析 / 描述 / RAG 证据；**救治方案由 PilotDeck 主模型生成**                             |
| 战创伤范围            | **先做简版**综合辅助；六阶段留作后续（见 §5.4）                                                        |
| 便携部署             | Node/Python/依赖尽量在仓库 `.runtime` / 插件 `.venv` / `plugins/med-tools/data` 内，避免写死机器绝对路径 |




### 1.2 本轮四项工作


| #   | 工作                                                        | 负责人                                 | 依赖                                |
| --- | --------------------------------------------------------- | ----------------------------------- | --------------------------------- |
| W1  | G9-V-Med-27B 用 vLLM 重新拉起；济南在 **PilotDeck Agent 主页面** 将 G9 配为主模型，调 tools 出结果，并测速度/质量 | **William（起模型）** / **同事（济南连通与 Agent 端到端）** | 无 |
| W2  | **下线全部医疗专用 UI**（含 dialogue / med-trauma / 表格·影像·翻译·eval 等），只保留 PilotDeck Agent 主页面 | **同事** | 可与 W1 并行 |
| W3  | 将 product 中需保留能力迁入 `plugins/med-tools`：战创伤 RAG + 简版综合救治辅助（主模型描述 → RAG） | **William** | RAG 语料迁移；带图端到端依赖主模型多模态 |
| W4  | 理清并优化 `med_parse_medical` 文档/影像解析逻辑 | **William** | 可与 W3 并行，建议错开大改 `app.py` |


---



## 2. 分工总览（RACI 简表）


| 事项                                    | William        | 同事                 |
| ------------------------------------- | -------------- | ------------------ |
| vLLM 启动 G9、参数与健康检查文档                  | **R**          | C（按文档对接）           |
| 济南访问 `http://<host>:8030/v1`、防火墙/代理   | C              | **R**              |
| PilotDeck Agent 主页面配 G9 为主模型 + tools 端到端与测速 | C（给出配置项与测项） | **R** |
| 删除全部医疗专用 UI / 相关入口与专用 API | C（Code Review） | **R** |
| med-tools RAG + 战创伤辅助工具 + Skill       | **R**          | C（联调时可测）           |
| `med_parse_medical` 逻辑梳理与优化           | **R**          | I                  |
| `products/` 删除（本轮不做）                  | —              | —                  |


R=负责执行，C=配合，I=知情。

---



## 3. W1：G9-V-Med-27B（vLLM）与济南 8030



### 3.1 目标

- 模型服务以 **OpenAI 兼容**接口对外：`GET/POST` 基址形如 `http://<host>:8030/v1`。
- **两处用法需区分：**
  1. **PilotDeck 主 Agent 模型**：在 UI Settings / `pilotdeck.yaml` 的 `agent.model` 配成指向 G9 的 provider（济南验收的核心）。
  2. **med-tools 内 VLM**（`med_parse_medical` 出报告）：读 `plugin.json` 的 `MED_VLM_API_BASE` / `MED_VLM_MODEL=G9-V-Med`。
- 插件 fallback（GPT）仅作兜底；济南验收以 **Agent 主页面 + G9 主模型 + tools** 为准。



### 3.2 William：重新 vLLM 启动（实现要点）

1. 在模型机用约定镜像/权重启动 vLLM（命令以你们现网脚本为准，此处列检查清单）：
  - 监听 `0.0.0.0:8030` 或仅内网网卡（济南需能连）。
  - `--served-model-name` / 模型 id 与 `MED_VLM_MODEL` 一致（当前约定 `G9-V-Med`）。
  - 多模态：确保 chat/completions 支持 image_url（med-tools 报告路径会传图）。
2. 本机冒烟：

```bash
curl -sS "http://127.0.0.1:8030/v1/models" | head
# 可选：发一条最小 chat/completions（含或不含图）确认 200
```

1. 将「济南可达的 base URL」（IP/域名、是否 HTTPS、是否要 Token）写进本 issue/群，供同事配置。
  **禁止把永久密钥写进文档仓库**；若必须 key，用环境变量或私密配置通道。



### 3.3 同事：济南连通与「跑通」（已拍板）

**「跑通」定义（唯一验收口径）：**

在 **PilotDeck Agent 主页面**（普通聊天，不是医疗专用页）中：

1. 将 **G9-V-Med** 配置为 **主 Agent 模型**（`agent.model` / Settings，provider `url` 指向济南可达的 `:8030/v1`）。
2. 发起会触发 **tools** 的对话（例如上传医疗文件/文件夹，引导调用 `med_parse_medical`；W3 合入后可再测 RAG / 战创伤辅助）。
3. 确认模型能 **调用工具并基于工具结果生成输出**。
4. **记录响应速度**（首 token / 整轮耗时，可用浏览器网络或 Gateway 日志）与 **回答质量**（是否按 Skill 原样展示 report、是否胡编、中文结构化是否可读）。

建议步骤：

```text
curl 济南可达的 :8030/v1/models
→ start-local / 约定方式启动 PilotDeck
→ Settings 配 G9 为主模型（勿仅改 med-tools env 却忘了 agent.model）
→ 新开对话 → 上传样例 → 观察 tool_call + 最终回复
→ 填写测速与质量笔记交 William
```

配置注意：

- **主 Agent**：`.pilotdeck-home/pilotdeck.yaml`（或 UI Settings）里的 provider / `agent.model`。
- **插件内 VLM**：`plugins/med-tools/plugin.json` → `MED_VLM_*`；改完需重启 Gateway。
- 模型与 PilotDeck 不同机时，两处 URL 都不要写死 `127.0.0.1`（除非用 SSH 隧道）。
- 安全组放行 8030；仅内网。

### 3.4 W1 验收标准

- [ ] `GET <base>/models` 返回含 `G9-V-Med`（或约定 id）
- [ ] Agent 主页面 `agent.model` 实际指向 G9，且能正常流式/非流式回复
- [ ] 至少 1 轮：**主模型发起 tool_call → 工具返回 → 主模型生成可见回答**
- [ ] 记录：TTFT/整轮耗时、样例类型、质量主观结论、失败原文
- [ ] （加分）`med_tools_health` primary_ok；`med_parse_medical` 非 fallback

---



## 4. W2：下线全部医疗专用 UI（只保留 Agent 主页面）

### 4.0 当前前端展示情况（事实）

| 表面 | 是否在主壳导航可见 | 说明 |
|---|---|---|
| **medical-dialogue** | **是** | `MainAreaV2` 的 `MEDICAL_TABS` |
| **medical-trauma** | **是** | 同上 |
| 表格 / 影像工作台 | **否（非独立 Tab）** | 挂在 Dialogue 页抽屉 `MedicalControls` 内，主壳进不去则用户碰不到 |
| Translation / Eval | **否** | 代码在 `ui/src/features/medical/`，**未**挂到 `MainContent` 主路由 |

结论：用户日常能点到的医疗页主要是 **Dialogue + Med-trauma 两个入口**；其它是嵌套或未挂载代码。本轮按产品要求：**整包医疗 UI 下线**，不只删这两个 Tab。

### 4.1 目标

- UI **只保留 PilotDeck Agent 主页面**（聊天 + Files / 原有非医疗管理页按产品原样保留）。
- **不再出现**任何医疗专用全屏页、医疗 Tab、医疗抽屉工作台入口。
- 医学能力仅通过 **普通 Agent 对话 + `plugins/med-tools`** 提供。

### 4.2 删除范围（已拍板）

**纳入本轮（同事）：**

1. **整包医疗前端（建议删除或不再被引用）**
   - `ui/src/features/medical/**`（dialogue、trauma、table、imaging、translation、eval、shared 等）
   - 导航/Tab/路由：`medical-dialogue`、`medical-trauma`、`/medical/dialogue`、`/medical/med-trauma`
   - 涉及：`ui/src/types/app.ts`、`MainContent.tsx`、`MainAreaV2.tsx`、`AppShellV2.tsx`、`useProjectsState.ts`、i18n 医疗文案键等
   - 相关单测与 lazy import

2. **UI Server 医疗专用 API**
   - `ui/server/routes/medical.js`、`medicalResources.js` 及明显仅服务医疗 UI 的 `services/medical*.js`
   - `ui/server/index.js`（或等价）中对 `/api/medical` 的挂载
   - 对应 `*.test.js` / e2e `medical-*.spec.mjs`（若存在）

3. **验收时确认仍保留**
   - 普通聊天、Files、Skills/Dashboard 等非医疗壳
   - `plugins/med-tools`（不要删）
   - `products/medical-integration/` 目录本轮仍可留在仓库（冻结，不启动）；**不**再从 UI 引用

### 4.3 实现步骤（同事）

1. 开分支：`feat/remove-medical-ui`（名称可自定）。
2. 去掉所有 `medical-*` Tab / 路由 / lazy 页面。
3. 删除或停用 `ui/src/features/medical/**` 与 `/api/medical*` 挂载；修编译与测试引用。
4. 搜索残留：`features/medical`、`/api/medical`、`medical-dialogue`、`medical-trauma`、`MedTrauma`、`DialoguePage`。
5. 回归：
   - 启动后侧栏/顶栏无医疗入口
   - 直访旧 URL 不白屏
   - **Agent 主页面**聊天 +（若已配）med-tools 文件夹上传仍可用
6. PR 列出删除清单，方便 Review。

### 4.4 W2 验收标准

- [ ] 无任何医疗专用 Tab / 路由页 / 抽屉工作台入口
- [ ] `/api/medical` 不再对外提供（或明确 404），前端无引用
- [ ] 相关测试已删或改写并通过
- [ ] Agent 主页面与 med-tools 回归通过
- [ ] 未误删 `plugins/med-tools`

---



## 5. W3：med-tools 纳入 RAG + 战创伤综合辅助（William）



### 5.1 背景对照（避免和 product 混淆）


|     | `plugins/med-tools`（保留并扩展）        | `products/.../medical-tools` + sidecar（冻结） |
| --- | --------------------------------- | ------------------------------------------ |
| 形态  | stdio MCP + Skill                 | HTTP MCP `:8766` + REST `:8765` + 专用页      |
| 解析  | `med_parse_medical`（本地解析 + G9 报告） | 附件 prepare 等契约工具                           |
| RAG | **本轮迁入 med-tools**                | `medical_sidecar_rag_query` 等              |
| 战创伤 | **本轮简版工作流工具 + Skill**             | med-trauma 页 + JS `buildTraumaPrompt`      |




### 5.2 已拍板设计

1. **生成：方案 A** — 工具返回 RAG 证据；**救治方案由 PilotDeck 主模型生成**。
2. **简版优先** — 不强制六阶段。
3. **图片：主模型先描述 → 再调 RAG**（describe-first；**不在工具内调 VLM 写描述**）。
4. **语料迁到** `plugins/med-tools/data/`，逻辑与配置不再引用 `products/`。
5. product **先冻结**。
6. UI：**只保留 Agent 主页面**（见 W2）。



### 5.3 建议交付物

```text
plugins/med-tools/
  data/
    rag/
      corpus/war_trauma_books_chunks.jsonl
      embedding/war_trauma_books_embedding.npy
      manifest.json            # corpus_id、sha256、dim、license、相对路径（无绝对路径）
  server/
    rag_*.py                   # 加载 / 词法或向量检索（可简化自 product rag）
    trauma_assist.py           # 工作流编排（可选模块）
    app.py                     # 注册新 MCP tools
  skills/
    med-medical/SKILL.md       # 保持；可交叉引用
    med-trauma-assist/SKILL.md # 新建：何时调用、输出结构、免责声明
  plugin.json                  # 如需增加 RAG 相关 env（相对插件根或 PILOT_HOME）
  README.md                    # 更新工具列表与数据布局
```

> 注：`products/medical-integration/data/rag/` 旧副本已删除；唯一语料在 `plugins/med-tools/data/rag/`。
**建议新增 MCP 工具：**


| 工具名（wire 前缀 `mcp__med-tools__`） | 职责                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `med_trauma_rag_query`          | 输入 query / top_k 等；返回 chunks + 来源字段；无 embedding 服务时 **lexical-fallback** 并标明 |
| `med_trauma_rag_status`         | 语料是否可读、条数、维度、模式 |
| `med_trauma_assist`（可选薄封装） | 若保留：仅接受**已有文本描述** + 可选元数据，内部只做 RAG 编排；**不**在工具内生成图片描述。也可不做此工具，由 Skill 规定：主模型描述 → 直接 `med_trauma_rag_query`。 |


**Skill `med-trauma-assist` 要点（已拍板流程）：**

```text
用户上传战创伤图片和/或文字
  → 主模型用多模态能力生成 1–3 句客观中文伤情描述（不诊断、不调工具写描述）
  → 主模型调用 med_trauma_rag_query(query=描述或用户文本)
  → 主模型基于 evidence 写综合救治辅助方案 + 参考来源
```

- 有图无关键词时必须走「先描述再检索」；有明确文字 query 可直接 RAG。
- 区分「所见/用户陈述」与「检索文献」；禁止编造未检索到的条文。
- 仅供辅助、需医务人员复核。

**路径与便携：**

- 数据路径相对 `plugins/med-tools` 解析（`Path(__file__).resolve().parents[...]`），禁止写死 `/Users/...`。
- 大文件继续走 Git LFS；迁移后更新 `.gitattributes` 如需要。
- 复制语料后校验 sha256（可与现 `medical.yaml` 中记录对照）。



### 5.4 六阶段（本轮不做，仅说明供以后排期）

product 六阶段 = **每次只针对当前救治环节之一**，不是一条 query 填齐六段：

1. 伤员发生地 2. 野战分类场 3. 收容处置组 4. 重伤救治组 5. 手术组 6. 洗消组

实现时：参数 `stage` 或对话追问「当前处于哪一阶段？」；RAG query 可拼阶段关键词；输出固定五段结构。  
**未指定阶段时不要默认某一阶段**；简版综合方案可继续作为 fallback。

### 5.5 W3 实现顺序

1. 迁语料 → `med_trauma_rag_status` / `med_trauma_rag_query` 单测（无网络）。
2. 写 Skill：主模型描述 → `med_trauma_rag_query` → 主模型写方案。
3. 对话测纯文本 RAG；再测带图（主模型多模态描述 + RAG）。
4. （可选）薄封装 `med_trauma_assist`：只包 RAG，不内置 VLM 描述。
5. README + 本协作文档状态更新。

### 5.6 W3 验收标准

- [x] `plugins/med-tools/data/rag` 自包含；代码无 `products/medical-integration` 依赖  
- [x] 纯文本：Agent 能调 RAG 并引用 sources（单测 + 本机向量检索冒烟通过；对话端到端待联调）  
- [ ] 带图：主模型描述 → RAG → 主模型方案（工具内不写描述）  
- [ ] `start-local.sh` 场景下工具注册成功  
- [x] product / sidecar / 医疗 UI **未**被本任务重新启用

> 2026-08-14：已在 `feat/add-plugins` 落地语料拷贝、`med_trauma_rag_*`、Skill `med-trauma-assist`、单测与直连 embedding 冒烟。

---



## 6. W4：理清并优化 `med_parse_medical`（William）



### 6.1 当前逻辑（梳理基线，实现前请对照代码再修订本节）

入口：`plugins/med-tools/server/app.py` → `med_parse_medical` → `_run_medical_parse`。

大致流水线：

1. **路径**：文件或目录；目录下按后缀收集，默认最多 64。
2. **本地解析**（`parsers`）：DICOM / PDF / 图像 / CDA·XML / 文本·JSON / ECG 等 → summary、预览图、warnings；不支持则 degraded。
3. **VLM（除非** `skip_vlm`**）**：优先 G9（`MED_VLM_`*）；失败且开启 fallback → GPT。
4. **返回 JSON**：含 `report`、`fallback_used`、`agent_continue` 等。
5. **Skill** `med-medical`：有 `report` 则**原样展示**；无 report 且 `agent_continue` 时主 Agent 续写。



### 6.2 优化方向（建议优先级）


| 优先级 | 项        | 说明                                                                            |
| --- | -------- | ----------------------------------------------------------------------------- |
| P0  | 文档化上述流水线 | 更新 `plugins/med-tools/README.md` + Skill 与真实行为一致                              |
| P0  | 可观测性     | `med_tools_health` / 解析结果中明确 primary vs fallback、耗时、文件计数截断                    |
| P1  | 目录策略     | 混合后缀时的选取顺序、截断 warnings、与聊天附件 `.tmp/chat-attachments` 路径说明                     |
| P1  | 与 W3 边界  | 战创伤「救治方案」走 `med_trauma_assist`；`med_parse_medical` 专注「解析 + 结构化报告」，避免两个工具抢同一话术 |
| P2  | 性能       | 预览帧数、PDF 页数上限、并行解析是否安全                                                        |
| P2  | 错误体验     | G9 超时文案、部分文件失败时是否仍出总报告                                                        |




### 6.3 W4 交付与验收

- [ ] 一份「现状流程图 + 参数表」（可写在 README）  
- [ ] 至少完成 P0；P1 视时间  
- [ ] 回归：单文件 DICOM/PDF/图片、小目录、G9 不可用时 fallback 行为符合 Skill  
- [ ] 不破坏 W3 新工具注册

---



## 7. 推荐排期与集成顺序

```text
并行：
  W1 William 起 G9 ──┬── W1 同事：Agent 主页面配 G9 + tools 测速/质量
  W2 同事：下线全部医疗 UI ─┘
  W3 William：RAG 迁入 + Skill（文本可先做；带图需主模型多模态）
  W4 William：med_parse 文档化（与 W3 错开改 app.py）

集成：
  W2 合入后确认只剩 Agent 主页面
  W1+W3 在济南/本机做带图 RAG 辅助
  products/ 物理删除单独后续 epic
```

分支建议：

- William：`feat/med-tools-trauma-rag`（W3+W4）
- 同事：`feat/remove-medical-ui`（W2）
- 避免两人无沟通同时大改 `ui/server` 与 `plugins/med-tools/server/app.py`

---



## 8. 明确不在本轮范围

- 启用或维护 medical sidecar / `medical-tools` product 插件  
- **物理删除**整个 `products/medical-integration`（目录先冻结保留）  
- 六阶段战创伤完整工作流  
- 把 Volume / Gallery / M3D / 表格 OCR **迁入** med-tools（本轮是 UI 下线，能力不迁）  
- 把对话家目录改回 `~/.pilotdeck`（继续用 `.pilotdeck-home` + `start-local.sh`）

---

## 9. 已拍板项（原待确认，2026-08-14）

| ID | 问题 | 决定 |
|---|---|---|
| Q1 | W2 删除范围 | **全部医疗专用 UI + 对应 `/api/medical*`**；只留 Agent 主页面 |
| Q2 | 表格/影像等其它医疗 UI | **一并下线**（多数本就非独立 Tab，见 §4.0） |
| Q3 | 济南「跑通」 | **Agent 主页面**将 G9 配为主模型，调 tools 出结果，并测**速度与质量** |
| Q4 | 图片描述 | **主模型生成描述 → 再调 RAG**（工具内不写描述） |
| Q5 | RAG 语料 | **拷贝进 `plugins/med-tools/data` + LFS** |

---

## 10. 联系与交接清单（每次交接填）

**William → 同事（W1）**

- [ ] 8030 Base URL：____________________  
- [ ] 模型 id：`G9-V-Med` / 其它：________  
- [ ] 是否需要 API Key：否 / 是（私密通道发送）  
- [ ] 本机 `curl /v1/models` 截图或 JSON 摘要  
- [ ] 主 Agent 配置示例（`agent.model` / provider url 字段说明）  

**同事 → William（W1/W2）**

- [ ] Agent 主页面 G9 主模型 + tool_call 成功记录  
- [ ] 测速（TTFT/整轮）与质量简评  
- [ ] W2 PR 链接（医疗 UI 全下线）  
- [ ] 回归：Agent 主页面正常、无医疗入口  

**William（W3/W4）**

- [ ] 新工具名与 Skill 名最终定稿  
- [ ] 语料 sha256 校验记录  
- [ ] README 已更新  

---

## 11. 修订记录

| 日期 | 作者 | 说明 |
|---|---|---|
| 2026-08-14 | 协作起草 | 首版：四项工作、实现方式、默认假设与待确认项 |
| 2026-08-14 | 修订 | 拍板 Q1–Q5：全医疗 UI 下线；济南=Agent+G9+tools 测速质量；主模型描述再 RAG；语料进插件 data |
| 2026-08-14 | W3 落地 | `feat/add-plugins`：med-tools 纳入 RAG 语料 + `med_trauma_rag_query/status` + Skill；embedding 直连冒烟通过 |
| 2026-08-14 | 语料去重 | 删除 `products/.../data/rag` 大文件副本；唯一语料在 `plugins/med-tools/data/rag/` |
| 2026-08-14 | Skill/Agent | 协作图写入两 Skill；`medical-assistant` Profile md 保留但不注册（`agents: []`），主页面靠 Skill 自行分流 |
| 2026-08-14 | 方案拆分 | RAG 问答=`med-trauma-assist`；正式六阶段方案=`med-trauma-stage-plan` + `med_trauma_stage_plan`（插件内 G9，原样展示 care_plan） |
