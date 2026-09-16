# 记忆模块医学化改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Every task must preserve existing user data and pass its focused tests before continuing.
>
> **本文档已按真实代码核对过一遍。** 所有文件路径、行号、测试框架和运行命令都经过验证。若执行时发现与代码不符，先停下来更新本文档，不要凭猜测继续。

**Goal:** 让记忆体系围绕医学场景重建——战创伤接入全局画像与项目记忆并按策略写入，Memory 面板增加病例状态页，删除会话时同步清理病例目录，Index/Dream 在对话后立即执行，通用医学的提取逻辑按「医生画像 / 患者病历 / 协作偏好」三层重做。

**Architecture:** 保留两类数据引擎——EdgeClaw 负责可提炼可检索的长期记忆，Trauma Case Store 负责单病例强结构化状态；两者不合并物理格式，只统一身份、生命周期和 UI 表达。新增 `MemoryScopeIdentity` 作为所有存储定位的唯一入口，`MemoryDomainFacade` 作为战创伤访问长期记忆的窄接口，`MemoryPrivacyPolicy` 作为所有落盘路径共用的 PHI 红线。医学化改造集中在提示词层——`llm-extraction.ts` 的 5 个提示词常量抽成 `prompts/` 下按项目类型注入的 `MemoryPromptProfile`，共享片段单一来源，只有医学领域规则分档；不改动 `MemoryRecordType` 枚举、SQLite schema 与检索主干。

**Tech Stack:** TypeScript、Node.js 文件系统、EdgeClaw memory core（vendored 子包）、SQLite、JSON/JSONL、Express、原生 JS Memory Dashboard（iframe）、node:test、Vitest。

**Spec:** 本文档同时是现状分析、目标设计和按依赖排序的实施计划。

---

## 0. 已确认的决策

| 议题 | 决策 | 影响 |
|---|---|---|
| Index/Dream 时机 | **回答返回后异步立即执行**（去掉时间门，保留内容门），**按项目类型分别启用** | 不阻塞用户；Dream 频率上升使全局画像写锁成为必须 |
| 删除语义 | **直接删除，预留归档接口** | 原方案的完整归档体系移出本期；`deleteSession` 返回结构化结果而非 boolean |
| 战创伤写入 | **`feedback_only`**：写反馈与偏好，不写病例事实 | 生命体征、伤情、患者标识一律只留在 Case State |
| **项目与患者的关系** | **一个项目 = 一个患者** | subject 绑定整块取消（§3.3）；项目边界即患者边界，跨项目通路成为唯一泄漏风险 |
| **项目内容能否进全局画像** | **不能，且不新增该通路** | 现有系统本就没有晋升机制（§1.3.1）；本计划不引入，改为强化捕获时的分类判别（§3.4） |
| **提取提示词** | **按项目类型分档，只分医学领域部分** | 战创伤与通用医学语义相反，共用一套判不准；契约/PHI/格式约束仍单一来源（§3.8） |
| **实施优先级** | **先战创伤，通用医学提取改造放最后** | 医学化按「机制」与「内容」拆开，机制提前、内容最后，见 §4 开头 |

---

## 1. 当前实现基线（已核对）

### 1.1 三类容易被混称为「记忆」的数据

| 类型 | 当前存储 | 主要用途 | 当前生命周期 |
|---|---|---|---|
| Conversation History | 项目 chat 目录中的 `<sessionId>.jsonl` | 恢复聊天、给当前会话提供上下文 | 删除 session 时直接删除 |
| Long-term Memory | `$PILOT_HOME/memory/<typeKey>/<projectId>/` 下的 SQLite、manifest 和 Markdown | 跨会话画像、项目事实、反馈召回 | 支持 Index、Dream、导入导出；项目删除时移除 memory 目录 |
| Case State | `$PILOT_HOME/memory/trauma_med/<projectId>/cases/<safeSessionId>/` | 保存当前病例、快照、救治阶段和结构化事实 | 随 turn 保存；**删除 session 时完全不处理 → 孤儿数据** |

这三类不能合并为一种存储：会话历史是事件记录，长期记忆是提炼后的知识，病例状态是医疗流程的权威状态。目标是统一管理和生命周期，不是统一物理格式。

### 1.2 通用医学长期记忆链路

```text
Agent turn
  -> DefaultContextRuntime.prepareForModel
  -> EdgeClawMemoryProvider.retrieve
  -> ReasoningRetriever 检索
  -> User Profile / Project Meta / Project Memory / Feedback Memory
  -> 组装进 system prompt
  -> 模型回答
  -> EdgeClawMemoryProvider.captureTurn      (L0 session capture)
  -> registry.scheduleMemoryMaintenance()    (createLocalGateway.ts:482，每轮都调用)
  -> service.runDueScheduledMaintenance()    (service.ts:915，内部有时间门)
```

**关键事实（全部已核对）：**

- **维护管线已经是「每轮触发」的。** `registry.scheduleMemoryMaintenance(projectKey)` 在 `createLocalGateway.ts:482` 的 turn 完成回调里被调用，实现见 `createLocalGateway.ts:1184`——异步 fire-and-forget，带 `memoryMaintenanceRequested` 请求合并和 `memoryMaintenanceInFlight` 单项目互斥。**不需要新建触发链路。**
- 真正挡住执行的是 `runDueScheduledMaintenance` 内部的时间门（`service.ts:915`）：
  - Index 条件：`pendingDialogueTurns >= 20`（`AUTO_INDEX_PENDING_DIALOGUE_TURN_THRESHOLD`，service.ts:99）**或** `pendingSessions > 0 && 距上次 Index 已过 autoIndexIntervalMinutes`（默认 30）
  - Dream 条件：`changedFilesSinceLastDream > 0 && 距上次 Dream 已过 autoDreamIntervalMinutes`（默认 60）
- **`0` 是「禁用」不是「立即」。** `hasElapsedMinutes` 在 `service.ts:365` 开头就是 `if (intervalMinutes <= 0) return false`。必须引入新的显式语义。
- 默认值 30/60 分钟同时硬编码在两处：`sqlite.ts:1713-1714` 和 `ui/src/components/settings/view/agentMemory/memoryIntervals.ts`（`DEFAULT_INDEX_MINUTES` / `DEFAULT_DREAM_MINUTES`）。
- `captureTurn` 失败不中断主对话——可用性对，但用户看不见失败。
- 召回结果整理成 `User Profile`、`Project Meta`、`Project Memory`、`Feedback Memory` 四段注入 system prompt；当前轮明确指令优先于召回内容。

### 1.3 提取与分类的真实实现

全部集中在 `src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.ts`（3620 行，vendored 子包）。

**活的提示词只有 5 个，消费点只有 4 处**（已逐一 grep 核对）：

| 常量 | 定义行 | 消费行 | 职责 |
|---|---|---|---|
| `MEMORY_CLASSIFICATION_SYSTEM_PROMPT` | 218 | 2535 | 单轮分类：focus turn → `user` / `project` / `feedback` |
| `USER_NOTE_CREATE_SYSTEM_PROMPT` | 253 | 2574 | 生成一条 user note |
| `PROJECT_NOTE_CREATE_SYSTEM_PROMPT` | 279 | 2576 | 生成一条 project note |
| `FEEDBACK_NOTE_CREATE_SYSTEM_PROMPT` | 305 | 2577 | 生成一条 feedback note |
| `USER_PROFILE_REWRITE_SYSTEM_PROMPT` | 565 | 2504 | Dream 重写全局画像 |
| ~~`EXTRACTION_SYSTEM_PROMPT`~~ | 515 | **无** | **死代码**——全仓库零引用，不要改它，收口时删除 |

**提取器的注入缝**：`LlmMemoryExtractor`（`llm-extraction.ts:2184`）在 `service.ts:639` 被构造，每个 `MemoryService` 实例一个；而 `MemoryService` 本来就是**按项目（typeKey + projectId）隔离**的。所以「按项目类型使用不同提示词」只需要在构造时注入一份档案，不需要改动任何调用方——这是 §3.8 设计的基础。

**类型枚举**：`MemoryRecordType = "user" | "feedback" | "project" | "general_project_meta"`（`core/types.ts:13`）。这个枚举同时是 SQLite 列值和检索分支依据，**本计划不改动它**——医学维度通过 note 内部的结构化字段表达。

**全局画像当前只有一个段落**：`USER_PROFILE_REWRITE_SYSTEM_PROMPT` 只产出 `identity_background_markdown`，写入 `## 身份背景`。其规则第 574 行明确排除「reply preferences, formatting habits, style choices, language choices」。所以「全局临床偏好」当前**无处安放**——需要新增段落，见 §3.2。

**分类的 Override test**（第 233 行）：「if another project could reasonably override this rule or preference, it is not user; classify it as feedback」。这是全局 / 项目边界的**唯一判定点**，见 §3.4。

### 1.3.1 「项目内容晋升到全局画像」不存在，且不应被引入

核对结论：**当前系统没有任何机制能把 `project` 或 `feedback` 记忆提升为 `user` 记忆。** 两道硬隔离：

1. Dream 重写全局画像时只读 `kinds:["user"], scope:"global"`（`dream-review.ts:1045-1049`）；`project` / `feedback` 是 `scope:"project"`，走 `runCategoryDream` 另一条完全独立的路径，二者在 Dream 全流程中不交汇。
2. `rewriteUserProfile` 入口第一行就是 `input.candidates.filter((c) => c.type === "user")`（`llm-extraction.ts:2498`），非 user 候选连函数内部都进不去。

真实机制是：一条内容属于哪一类，**在捕获时由分类器判定一次就定终身**，之后归属不再改变。

**本计划不引入晋升机制。** 在「一个项目 = 一个患者」的模型下，晋升会是唯一一条能把患者甲的内容带到患者乙对话中的通路——与其新增它再用一整套否决条件去堵，不如让这条路径在设计上就不存在。全局临床偏好仍然能被收集：医生说出带跨项目信号的偏好时，现有分类器按 Override test 本就会判成 `user`，直接进全局画像。需要做的只是让分类提示词具备医学语境判别力（§3.4），不是新增数据通路。

### 1.4 全局画像

权威文件：`$PILOT_HOME/memory/global/UserIdentity/user-profile.md`

user 类型候选先进全局 user notes，Dream 再选择、合并并重写 `user-profile.md`。风险：

- **并发写入无保护。** 多个项目可能同时触发同一全局画像的 Dream 重写。在 60 分钟间隔下是低概率事件；**改成每轮立即执行后会变成常态**——两个项目同时对话，两个 Dream 同时 rewrite-from-scratch，后写的完全覆盖先写的。
- Index/Dream 延迟导致 UI 无法区分「已捕获 / 已索引 / 已并入画像」。

### 1.5 项目与 session 身份不统一（已核对，有硬证据）

**证据 1：存在三套独立的 projectId 推导。**
- `resolveProjectStorageId` / `resolveGatewayProjectKey`（`src/pilot/paths.ts`）
- `createLocalGateway.ts:784` 和 `:936` 就地推导：`projectKey.replace(/\\/gu,"/").split("/").filter(Boolean).at(-1)`（重复两次）
- Memory API 走 `resolveProjectPathFromRequest(req)`（`ui/server/services/memoryService.js:375`），从前端传入的 `projectPath` 反解

**证据 2：存在两套不兼容的 sessionId 清洗算法。**

| 用途 | 位置 | 规则 | 空值兜底 |
|---|---|---|---|
| transcript 文件名 | `ui/server/utils/pilotPaths.js:200` `sanitizeSessionIdForPath` | 只替换 `\ /`（win 另加 `:<>"\|?*`）→ `-` | `'session'` |
| Case State 目录 | `src/pilot/paths.ts:98` `resolveTraumaCaseDir` 内联 | 替换**所有** `[^A-Za-z0-9._-]` → `_` | `sha256(sessionId).slice(0,24)` |

sessionId = `2026-09-16 case A` 会得到：
- transcript → `2026-09-16 case A.jsonl`（空格保留）
- case 目录 → `2026-09-16_case_A/`（空格变下划线）

**这是删除任务的头号陷阱**：只用一套算法去删，另一套路径下的数据会留成孤儿。而且单独测「只有 transcript」和「只有 case」两个用例时都能通过，只有两者同时存在且 sessionId 含特殊字符时才暴露。

**证据 3：`ui/server/utils/pilotPaths.js` 是 `src/pilot/paths.ts` 的手工 JS 移植**，文件头注释明写「Keep this in sync — both must round-trip identically」。这是 UI server 不能依赖 TS dist 产物导致的既有约束，本计划不推翻它，但必须用共享 fixture 守住。

### 1.6 Memory Dashboard 的真实形态

- `ui/src/components/main-content/view/memory/MemoryPanel.tsx` **只有 89 行**，是个拼 URL 的 iframe 壳，传 `projectPath` / `locale` / `theme` / `token` 四个参数。
- 真正的 Dashboard 是 `src/context/memory/edgeclaw-memory-core/ui-source/app.js`——**2078 行原生 JS**，由 `ui/server/index.js:788` 以 `express.static` 挂在 `/memory-dashboard`。
- 它属于 vendored 子包，**不在 `ui` 的 vitest 覆盖范围内**，目前零测试基建。
- **已存在 `/cases` API**：`ui/server/routes/memory.js:513` 的 `GET /cases` 走 `service.listCaseTraces()`。这是 EdgeClaw 的 **index case trace**，和 Trauma Case Store 的 `cases/<sessionId>/current.json` **名字撞了但完全不是一个东西**。病例状态页上线前必须先解决这个命名冲突。

### 1.7 `reasoningMode` 的真实状态

链路是通的：

```text
parseMemoryConfig.ts:97  schedule.reasoningMode
  -> createEdgeClawMemoryProviderFromConfig.ts:74  defaultIndexingSettings: cfg.schedule
  -> service.ts:626  mergeIndexingSettings
  -> SQLite indexing settings
```

真正的问题是**没有任何消费者**：整个 `edgeclaw-memory-core/src/` 里 `reasoningMode` 只出现在 `service.ts:335`（归一化）、`core/types.ts:197`（类型）、`core/storage/sqlite.ts:258/1712`（持久化）。`core/retrieval/reasoning-loop.ts` 零引用。

附带问题：`service.ts:645` 是 `repository.getIndexingSettings(this.defaultIndexingSettings)`——**DB 记录优先，config 只作兜底**。改 `pilotdeck.yaml` 对已建库的老项目不生效。

`ui/src/` 全目录零引用——它没有 UI，只活在 `pilotdeckConfig.js:76` 的默认值和 `routes/memory.js` 的校验里。

### 1.8 当前删除行为

`ui/server/projects.js:559` 的 `deleteSession(projectName, sessionId, _options)`：

1. 删除 chat transcript（对 `safeId` 和原始 `sessionId` 做**双探测**，兼容 legacy 文件）
2. 删除 workspace 下的 `inbox/<safeId>`
3. **不处理** `memory/trauma_med/<projectId>/cases/<...>`

注意签名第一个参数是 **`projectName` 不是 `projectId`**——要定位 case 目录必须先做 name → id 解析。

---

## 2. 统一术语与身份契约

### 2.1 固定术语

- **Conversation History**：原始聊天事件，不称作长期记忆。
- **Long-term Memory**：EdgeClaw 管理的全局画像、项目元数据、项目事实和反馈。
- **Case State**：战创伤单病例当前状态与快照，是病例流程权威数据。
- **Index Case Trace**：EdgeClaw 索引过程的诊断记录（即现有 `/cases` API 的内容）。**必须改名**，避免与 Case State 混淆。

### 2.2 身份契约

```ts
type MemoryScopeIdentity = {
  projectId: string;          // 稳定的 typed storage id，唯一主键
  projectType: "general_medicine" | "war_trauma";
  projectPath?: string;       // 可变展示/工作路径，不作为主键
  sessionId?: string;         // 原始 session id，API 中必须保留
  transcriptSlug?: string;    // sanitizeSessionIdForPath 的结果
  caseDirSlug?: string;       // resolveTraumaCaseDir 的结果
  displayName?: string;       // 仅供 UI 展示
};
```

**关键设计**：`safeSessionId` 拆成 `transcriptSlug` 和 `caseDirSlug` 两个字段。这是对 §1.5 证据 2 的直接回应——两套清洗算法客观存在，与其冒险合并（会让存量目录全部失配），不如显式建模并让所有消费者同时拿到两个。

规则：

- 存储和关联使用 `projectId + sessionId`，不得使用 display name 作为主键。
- 两个 slug 只能作为路径组件，API 返回值必须同时携带原始 `sessionId`。
- 删除、定位类操作必须同时消费两个 slug，并对每个 slug 做 raw/sanitized 双探测。
- 所有操作使用同一 resolver，禁止就地推导。

---

## 3. 医学化提取设计

### 3.1 一句话原则

**全局画像写「医生是谁」，项目记忆写「这位患者是什么情况」，feedback 写「在这个项目里怎么跟我配合」。**

因为**一个项目对应一个患者**，项目记忆天然就是这位患者的病历，不需要在项目内做患者消歧。代价是边界必须更硬：任何患者相关内容一旦越出项目边界，就是串患者。

### 3.2 全局画像（`user`，跨项目）

当前只有 `## 身份背景` 一段。扩展为三段：

| 段落 | 内容 | 状态 |
|---|---|---|
| `## 身份背景` | 姓名/称呼、所在医院、科室、职称、执业年限 | 已有，收窄规则 |
| `## 专业领域` | 专科方向、擅长病种、常参与的诊疗环节（门诊/急诊/手术/会诊） | **新增** |
| `## 临床偏好` | 跨项目稳定的诊疗与表达倾向，如「优先考虑保守治疗」「要求给出剂量范围而非单一值」「习惯看 SOAP 格式」 | **新增** |

**硬性排除（写进提示词，并在代码侧二次过滤）：**
- 任何患者可识别信息
- **任何具体病情内容**——某次诊断、某个化验值、某个既往史、某条过敏史。在「一个项目 = 一个患者」模型下，这些一旦进入全局画像就会出现在**所有其他患者**的对话里。
- 任何只在单个项目成立的规则

实现上需要把 `USER_PROFILE_REWRITE_SYSTEM_PROMPT` 的输出从单字段 `identity_background_markdown` 扩展为三字段，并同步改 `llm-extraction.ts` 里拼装 `## 身份背景` 的 `normalizedSection` 逻辑（约 966 行）。**这是本计划唯一涉及全局画像文件格式变化的改动**，必须先写兼容读取测试：旧文件只有 `## 身份背景` 时，另外两段视为空而不是报错。

### 3.3 项目记忆（`project`，项目内）= 单患者病历

一个项目对应一个患者，所以项目记忆直接就是这位患者的持久临床事实，**不需要 subject 绑定**。

**医学 note 小类**（作为 project note 内部的结构化标签，**不改 `MemoryRecordType` 枚举**）：

| 小类 | 内容 | 说明 |
|---|---|---|
| `allergy` | 过敏史 | 见 §3.5 特殊待遇 |
| `clinical_history` | 既往史、现病史 | |
| `surgical_history` | 手术史 | |
| `medication` | 长期用药 | 与 `allergy` 冲突时必须提示 |
| `diagnosis_thread` | 当前诊疗线索、待排查项、鉴别诊断 | 允许随诊疗推进更新 |
| `project_context` | 不涉及病情的项目上下文（科研课题、教学案例） | |

**两条硬边界，必须有测试固化：**

1. **禁止跨项目召回任何 `project` 类记忆。** 现有召回本来就是项目内的，但在「项目 = 患者」模型下这条从「合理」升级为「安全红线」，必须写成显式测试而不是依赖现有行为。
2. **禁止任何病情内容进入全局画像。** 由两层保证：捕获时分类器的硬否决（§3.4），以及系统本就不存在项目→全局的数据通路（§1.3.1）。

### 3.4 项目反馈（`feedback`）与全局 / 项目边界的判定

feedback 写「在这个项目里怎么跟我配合」：

- **汇报格式偏好**：「先给结论再给依据」「要 SOAP 格式」「表格列出鉴别诊断」「每条建议后标注证据等级」
- **表达偏好**：用词习惯、是否要英文术语、是否要引用指南条目及版本
- **诊疗习惯**：「先问过敏史再给方案」「每次都要列禁忌证」「儿童剂量必须按体重给」
- **工作流规则**：文件/工具边界、交付顺序

**边界只在捕获时判定一次，没有后续晋升**（§1.3.1）。所以全部力气都花在分类提示词上，让它在医学语境下判得准：

| 判定 | 归类 | 例 |
|---|---|---|
| 描述**医生本人**，跨项目稳定 | `user` → 全局画像 | 「我是心内科主治」「我一直习惯先看指南再给方案」「所有项目都请标注证据等级」 |
| 描述**这位患者**的临床事实 | `project` | 「青霉素过敏」「三年前做过胆囊切除」 |
| 描述**在这个项目里**的配合方式 | `feedback` | 「这个病例的汇报请用表格」 |

沿用现有 Override test（`llm-extraction.ts:233`）作为 user / feedback 的分界，只增加医学语境的判别规则和例子：

- 含任何具体病情、诊断、化验值、用药记录、既往史、过敏史 → **一律不得判为 `user`**。这条是硬否决，优先于其他所有规则；在「项目 = 患者」模型下它等价于「禁止串患者」。
- 含患者称呼或个体指代（「这位患者」「他」「她」）→ 一律不得判为 `user`。
- 只有在特定病情语境下才成立的规则 → `feedback`，不是 `user`。

宁可漏判为 `user`（偏好留在项目内，下次再说一遍），不可误判为 `user`（患者内容泄漏到全部其他患者的对话）。

**已知代价**：`## 临床偏好` 段在 Task 4 建好后会空着，直到 Task 11 让分类器学会医学语境下的跨项目判别。这是可接受的——空段落不出错，只是暂时不填充。

### 3.5 过敏史特殊待遇

临床价值最高的一条，单独实现并单独测试：

- **召回优先级最高**，且**不受 token 预算裁剪**——其他记忆可以被截断，过敏史不可以。
- **Dream 合并时禁止删除**。Dream 是 rewrite-from-scratch 的，默认会丢弃它认为过时的内容；过敏史必须走白名单，只能追加或标记「用户已明确撤销」，不能静默消失。
- **冲突必须显式暴露**。当召回的过敏史与当前轮输入矛盾时，禁止静默采信任一方，必须让模型指出冲突并请用户确认。
- **低置信度不得以确定口吻注入**。条目必须携带置信度和来源轮次。
- **绝不进入全局画像**（§3.4 的硬否决已覆盖，但过敏史需单独写一个测试固化）。

### 3.6 PHI 红线（适用于所有层）

提取前做规则过滤，以下一律不得进入任何长期记忆文件：

真实姓名、身份证号、病历号/住院号/门诊号、手机号、详细住址、精确出生日期（只保留年龄或年龄段）、影像文件的原始路径与文件名。

实现为 `MemoryPrivacyPolicy` 的纯函数 + 正则规则集，在 note 落盘前调用，命中即脱敏并在 trace 中记录「被删除字段数」。**先做规则版**，不引入外部 NLP 依赖。

**这个模块是地基**——通用医学和战创伤两侧的写入路径都要用它，所以它排在很前面（Task 3），而不是跟着通用医学提取改造走。

### 3.7 战创伤侧（`feedback_only`）

战创伤只写 feedback：汇报格式、表达偏好、工作流规则、明确纠错。

**生命体征、伤情分级、救治阶段、患者标识一律只留在 Case State**，不进任何长期记忆。§3.3 的患者病历化是通用医学的能力，战创伤不启用。

### 3.8 提示词档案：两种模式分开，其余共享

战创伤与通用医学的提取语义差别很大——通用医学要把患者病历沉淀成项目记忆，战创伤**明确禁止**这么做。用一套提示词同时描述两种相反的要求，只会让两边都判不准。所以提示词按项目类型分档，但**只分该分的那一部分**。

**分档的判据：这段文字是否描述「医学领域行为」。** 是则分档，否则共享。

```ts
// prompts/types.ts
type MemoryPromptProfile = {
  key: ProjectTypeKey;                    // "general_medicine" | "war_trauma"
  classification: string;                 // 分档
  noteCreate: {
    user?: string;                        // 分档；war_trauma 不提供 → 禁止写 user
    project?: string;                     // 分档；war_trauma 不提供 → 禁止写 project
    feedback: string;                     // 分档
  };
  allowedTypes: readonly MemoryRecordType[];
};
```

| 部分 | 处理 | 理由 |
|---|---|---|
| 输出 JSON 契约、字段名、解析容错说明 | **共享**（`prompts/shared.ts` 常量，插值进各档） | 与医学无关，写两份必然漂移 |
| PHI 红线条款（§3.6） | **共享** | 两侧同一套红线 |
| Override test 骨架（§3.4） | **共享** | 全局/项目边界的判据同一套 |
| note 结构、长度、语言、置信度要求 | **共享** | 格式约束，与领域无关 |
| 医学领域规则与例子 | **分档** | 通用医学要沉淀患者病历；战创伤要拒绝病例事实 |
| 允许写入的记忆类型 | **分档** | general_medicine 全开；war_trauma 只有 `feedback` |
| `USER_PROFILE_REWRITE_SYSTEM_PROMPT` | **不分档，保持单份** | 全局画像是「这位医生」，跨模式只有一个，分档会让两种模式互相覆盖对方写的画像 |

**`allowedTypes` 是代码级硬闸，不只是提示词约束。** war_trauma 档案不提供 `noteCreate.project`，捕获路径遇到 `project` 分类时直接丢弃并记 trace——即使提示词被改坏或模型判错，病例事实也进不了长期记忆。§3.7 的边界由类型系统而非文字保证。

**注入方式**：`LlmMemoryExtractor` 构造函数增加第 4 个参数 `promptProfile`，缺省为 `general_medicine`（老调用方零改动）；`MemoryService` options 增加 `projectType`，在 `createEdgeClawMemoryProviderFromConfig.ts:65` 传入。因为 `MemoryService` 本来就每项目一实例（§1.3），这是一次性注入，4 个消费点从引用模块常量改为读 `this.prompts.*` 即可，不需要在调用链上层层透传。

文件布局：

```text
core/skills/prompts/
  types.ts           MemoryPromptProfile 定义
  shared.ts          共享片段常量（JSON 契约 / PHI / Override test / 格式约束）
  generalMedicine.ts 通用医学档案
  warTrauma.ts       战创伤档案
  index.ts           resolveMemoryPromptProfile(projectType)
```

**实施上的直接后果**：战创伤写入（Task 7）需要 `warTrauma.ts`，所以**档案机制和战创伤档案必须早做**（Task 5）；`generalMedicine.ts` 的医学内容填充才是可以最后做的部分（Task 11）。这正好与「先战创伤、通用医学最后」的优先级一致。

---

## 4. 实施任务（按依赖排序）

> **排序原则**：测试基建 → 身份 → 正在丢数据的问题 → **地基（PHI + 全局画像 + 提示词档案机制）** → **战创伤全链路** → 面板 → 即时化 → 通用医学档案填充。
>
> **医学化按「机制」与「内容」拆开，不是按项目类型拆开。** 你要求先做战创伤、通用医学提取最后，而战创伤的写入路径需要 PHI 过滤、需要提示词档案机制、读取路径需要全局画像的新段落。所以：
> - **地基**（Task 3 PHI、Task 4 全局画像三段化、Task 5 提示词档案机制 + 战创伤档案）提前，两侧共用；
> - **通用医学档案的医学内容**（患者病历化、过敏史、分类器医学判别，Task 11）放最后。
>
> **即时化（Task 10）按项目类型分别启用**。在 Task 11 完成前，通用医学的档案还是通用版，让 Dream 每轮跑会加速积累噪音。所以 Task 10 先只对战创伤开 `immediate`，通用医学保持 `interval`，等 Task 11 完成后再切——这是 Task 11 的收尾项。

### Task 0（低，前置）：为 edgeclaw-memory-core 建立测试基建

Task 4/5/10/11 都要改这个 vendored 子包，它目前**没有 test 脚本也没有 test 目录**（`package.json` 只有 `build` 和 `typecheck`）。

**Files:**
- Modify: `src/context/memory/edgeclaw-memory-core/package.json`
- Create: `src/context/memory/edgeclaw-memory-core/test/service.test.ts`
- Create: `src/context/memory/edgeclaw-memory-core/test/prompts.test.ts`

- [ ] 加 `"test": "tsx --test \"test/**/*.test.ts\""`。**已定，不要再选**——理由：
  - 子包 `tsconfig.json` 是 `rootDir: "./src"` + `include: ["src/**/*.ts"]`，测试文件不在编译范围内。走「先 tsc 再 node --test」必须另建 `tsconfig.test.json`，且产物会落进 `lib/`，而 `build` 脚本第一步就是 `rm -rf lib`。
  - 根仓库已有 `tsx ^4.21.0`，方案中其他本地测试命令也都是 `tsx --test`，保持一致。
  - 子包**不是 pnpm workspace 成员**（`pnpm-workspace.yaml` 只列了 `ui`），没有自己的 `node_modules`；`tsx` 靠父目录查找解析到根 `node_modules/.bin`。这可行但很隐蔽，**首次实现时必须实跑一次确认**；若失败则改为从根目录起跑：`pnpm exec tsx --test "src/context/memory/edgeclaw-memory-core/test/**/*.test.ts"`，并把本文档的运行命令一并改掉。
  - `node --test` 的 glob 参数需要 Node 22+；子包 `engines` 已声明 `>=22.13.0 <23`，满足。
- [ ] 确认新增 `test/` 目录不影响根 `prebuild`（它执行 `cd 子包 && npm run build`，`include` 只有 `src/**`，测试不会被编译进 `lib/`）。
- [ ] `service.test.ts` 覆盖 `runDueScheduledMaintenance` 的现有门控：`intervalMinutes <= 0` 不执行、backlog 阈值 20、`changedFilesSinceLastDream === 0` 时不 Dream。**这是 Task 10 的回归基线，必须先固化当前行为。**
- [ ] `prompts.test.ts` 对 5 个活提示词常量做结构快照（非全文），作为 Task 4/5/11 改写时的 diff 锚点。**不要为 `EXTRACTION_SYSTEM_PROMPT` 建快照**——它是死代码（§1.3），Task 12 会删。

运行：
```bash
pnpm --dir src/context/memory/edgeclaw-memory-core test
```

### Task 1（低）：统一项目与 session 身份

Task 2、6、9 的共同前置。

**Files:**
- Modify: `src/pilot/paths.ts`
- Modify: `ui/server/utils/pilotPaths.js`
- Create: `src/context/memory/MemoryScopeIdentity.ts`
- Create: `ui/server/utils/memoryIdentity.js`
- Create: `tests/fixtures/memory-identity.golden.json`
- Modify: `ui/server/services/memoryService.js`
- Modify: `src/cli/createLocalGateway.ts`（收编 `:784` 和 `:936` 的就地推导）
- Create: `tests/context/memory/identity.spec.ts`
- Create: `ui/server/utils/memoryIdentity.test.js`（**vitest**，见 §5）
- Modify: `tests/pilot/workspace-paths.spec.ts`

- [ ] 建立 `MemoryScopeIdentity` 和唯一 resolver，覆盖 general_medicine、war_trauma、legacy general 和路径型项目。
- [ ] 同时产出 `transcriptSlug` 和 `caseDirSlug`，保留原始 `sessionId`。处理空值、`.`、`..`、Unicode、含空格、含斜杠、超长和碰撞。
- [ ] **共享 golden fixture**：一份 JSON 列出输入 → 期望的 `projectId` / `transcriptSlug` / `caseDirSlug`，TS 和 JS 两侧测试读同一份。这是对「手工同步两份实现」这个既有约束的唯一有效防线。
- [ ] 收编 `createLocalGateway.ts:784` / `:936` 的两处就地推导。
- [ ] Memory API 不再仅凭前端传入的 `projectPath` 隐式决定存储作用域；返回 display 字段但不用它定位。
- [ ] 为现有目录布局写兼容测试，**本任务不迁移任何数据**。

运行：
```bash
pnpm exec tsx --test tests/context/memory/identity.spec.ts tests/pilot/workspace-paths.spec.ts
pnpm --dir ui test -- server/utils/memoryIdentity.test.js
```

### Task 2（低至中）：删除 session 同步删除病例目录 ✅ 目标 5

在修「数据正在变成孤儿」的问题，依赖只有 Task 1，所以排得早。

**Files:**
- Modify: `ui/server/projects.js`（`deleteSession`，:559）
- Create: `ui/server/utils/sessionCleanup.js`
- Create: `ui/server/utils/sessionCleanup.test.js`（vitest）
- Modify: session 删除的前端确认文案

- [ ] `deleteSession` 先用 Task 1 的 resolver 把 `projectName` 解析为 `MemoryScopeIdentity`，拿到 `projectId` 和两个 slug。
- [ ] 仅当 `projectType === "war_trauma"` 时定位 `memory/trauma_med/<projectId>/cases/<caseDirSlug>`；通用医学项目不存在该目录属于正常情况，不得报错。
- [ ] **对 case 目录同样做 raw/sanitized 双探测**，与 transcript 的现有兼容策略一致。
- [ ] 返回值从 boolean 改为 `{ deleted: { transcript, inbox, traumaCase }, projectId, sessionId }`——**给后续归档预留的接入点**。
- [ ] 三类数据任一不存在都必须成功完成；任一删除失败必须明确报错而不是静默吞掉。
- [ ] 前端确认文案说明「将同时删除该会话的病例状态，且不可恢复」。
- [ ] **回归测试**：把当前「聊天删了但病例仍留存」的行为固化为一个必须失败→修复的测试。
- [ ] **必测**：sessionId 含空格（两个 slug 不同）、只有 transcript、只有 case、两者都有、通用医学项目、重复删除幂等。

运行：
```bash
pnpm --dir ui test -- server/utils/sessionCleanup.test.js
pnpm exec tsx --test tests/trauma/store.spec.ts
```

### Task 3（中）：PHI 红线 `MemoryPrivacyPolicy`（地基）

两侧写入路径共用，战创伤写入（Task 7）直接依赖它。

**Files:**
- Create: `src/context/memory/MemoryPrivacyPolicy.ts`
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/file-memory.ts`（落盘前调用）
- Create: `tests/context/memory/privacy.spec.ts`

- [ ] 规则版纯函数 + 正则规则集，覆盖 §3.6 的全部字段。
- [ ] 在 note 落盘前调用，命中即脱敏并记录被删除字段数到 trace。
- [ ] 提供 `redact(text) -> { text, removedCount, hits }`，便于上层记录审计信息。
- [ ] 导出文字片段常量供 §3.8 的 `prompts/shared.ts` 插值，**规则与提示词说明保持单一来源**。
- [ ] **必测**：身份证号、病历号/住院号、手机号、精确出生日期、影像文件路径在 user / project / feedback 三类记忆中均不出现；脱敏后文本仍可读。
- [ ] **必测**：误伤检查——正常的医学表述（剂量「5mg/kg」、日期「2026 年 3 月」、编号「WHO 分级 II 级」）不得被误当作 PHI 删除。

运行：
```bash
pnpm exec tsx --test tests/context/memory/privacy.spec.ts
pnpm --dir src/context/memory/edgeclaw-memory-core test
```

### Task 4（中）：全局画像三段化（地基）✅ §3.2

战创伤要读这三段（Task 6），所以必须在战创伤之前。

**Files:**
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.ts`（`USER_PROFILE_REWRITE_SYSTEM_PROMPT` :565、`## 身份背景` 拼装逻辑约 :966）
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/file-memory.ts`
- Test: `src/context/memory/edgeclaw-memory-core/test/prompts.test.ts`
- Create: `tests/context/memory/globalProfile.spec.ts`

- [ ] 输出扩展为 `identity_background_markdown` / `specialty_markdown` / `clinical_preference_markdown` 三字段，分别写入 `## 身份背景` / `## 专业领域` / `## 临床偏好`。
- [ ] **这个提示词保持单份，不按项目类型分档**（§3.8）——全局画像是「这位医生」，两种模式共用一份，分档会让两边互相覆盖。
- [ ] **先写兼容读取测试**：存量 `user-profile.md` 只有 `## 身份背景` 时，另两段视为空而非报错；Dream 重写后不丢失原有身份背景内容。
- [ ] 提示词明确排除患者信息、**任何具体病情内容**和单项目规则（§3.2 硬性排除）。
- [ ] 复用 Task 3 的 `MemoryPrivacyPolicy` 做落盘前二次过滤。
- [ ] **已知且可接受**：`## 临床偏好` 在 Task 11 之前会是空的（§3.4 末尾）。测试断言「空段落不报错」，不要断言它有内容。
- [ ] **必测**：一段包含患者既往史的对话跑完 Dream 后，全局画像三段中均不出现病情内容。

运行：
```bash
pnpm --dir src/context/memory/edgeclaw-memory-core test
pnpm exec tsx --test tests/context/memory/globalProfile.spec.ts
```

### Task 5（中）：提示词档案机制 + 战创伤档案（地基）✅ §3.8

把提示词从模块常量改成可按项目类型注入的档案，并落地 `war_trauma` 档案。**本任务不改动通用医学的提示词内容**——`generalMedicine.ts` 先原样搬运现有 5 个常量的文字，行为必须零变化。

**Files:**
- Create: `src/context/memory/edgeclaw-memory-core/src/core/skills/prompts/types.ts`
- Create: `src/context/memory/edgeclaw-memory-core/src/core/skills/prompts/shared.ts`
- Create: `src/context/memory/edgeclaw-memory-core/src/core/skills/prompts/generalMedicine.ts`
- Create: `src/context/memory/edgeclaw-memory-core/src/core/skills/prompts/warTrauma.ts`
- Create: `src/context/memory/edgeclaw-memory-core/src/core/skills/prompts/index.ts`
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.ts`（构造函数 :2184；消费点 :2535、:2574-2577）
- Modify: `src/context/memory/edgeclaw-memory-core/src/service.ts`（:639 构造处，options 增加 `projectType`）
- Modify: `src/context/memory/createEdgeClawMemoryProviderFromConfig.ts`（:65 传入 projectType）
- Test: `src/context/memory/edgeclaw-memory-core/test/prompts.test.ts`
- Create: `tests/context/memory/promptProfile.spec.ts`

- [ ] 按 §3.8 的表格切分共享片段与分档片段。共享片段（JSON 契约、PHI 条款、Override test 骨架、格式约束）写进 `shared.ts` 一次，两个档案插值引用，**不得复制粘贴**。
- [ ] `LlmMemoryExtractor` 构造函数增加第 4 个参数 `promptProfile`，缺省 `general_medicine`，保证老调用方零改动。
- [ ] 4 个消费点改为读 `this.prompts.*`；`USER_PROFILE_REWRITE_SYSTEM_PROMPT` **不进档案**，保持直接引用。
- [ ] **`allowedTypes` 实现为代码级硬闸**：`war_trauma` 档案的 `allowedTypes` 只有 `["feedback"]`，捕获路径遇到不在其中的分类直接丢弃并记 trace，不依赖提示词自觉。
- [ ] `warTrauma.ts` 的分类提示词只需在 `feedback` 与「丢弃」之间判别，不需要三分类；明确拒绝生命体征、伤情分级、救治阶段、患者标识（§3.7）。
- [ ] **搬运验证**：`generalMedicine.ts` 搬运后，`prompts.test.ts` 的结构快照必须与 Task 0 建立的基线**逐字相同**。这是本任务唯一的正确性判据。
- [ ] **必测**：`resolveMemoryPromptProfile("war_trauma")` 的 `noteCreate.project` 和 `noteCreate.user` 为 undefined；两个档案的共享片段字符串引用同一常量（同一性断言，不是相等断言）。

运行：
```bash
pnpm --dir src/context/memory/edgeclaw-memory-core test
pnpm exec tsx --test tests/context/memory/promptProfile.spec.ts
```

### Task 6（中）：战创伤只读接入全局画像与项目记忆 ✅ 目标 1（读）

**Files:**
- Create: `src/context/memory/MemoryDomainFacade.ts`
- Create: `src/trauma/memory/TraumaMemoryContext.ts`
- Modify: `src/cli/createLocalGateway.ts`
- Modify: `src/gateway/client/InProcessGateway.ts`
- Modify: `src/trauma/runner.ts`
- Modify: `src/trauma/stations/knowledgeQa.ts`
- Create: `tests/trauma/memoryContext.spec.ts`
- Test: `tests/trauma/runner.spec.ts`、`tests/trauma/knowledgeQa.spec.ts`

背景：战创伤消息在 `InProcessGateway` 走独立的 extractor / knowledge QA / Trauma Runner，**不走** `DefaultContextRuntime.prepareForModel`，所以当前没有 EdgeClaw retrieve/capture。

- [ ] Facade 提供按 `MemoryScopeIdentity` 读取全局画像（三段）和当前项目 Feedback 的**窄接口**，不向 Trauma 暴露底层 repository。
- [ ] 召回内容执行 Task 3 的过滤和长度限制。
- [ ] 作为**独立 prompt section** 传给 Runner 与知识问答，**不塞进 `caseHistory`**。
- [ ] 固定召回优先级并写进 prompt：
  ```text
  当前轮明确输入 > 当前病例 Case State > 已验证的医学知识/RAG 证据 > 当前项目 Feedback > 全局用户画像
  ```
- [ ] 召回失败只记 warning，不中断战创伤流程。
- [ ] **必测**：其他项目的记忆、其他病例的 Case State 均不会被召回。

运行：
```bash
pnpm exec tsx --test tests/trauma/memoryContext.spec.ts tests/trauma/runner.spec.ts tests/trauma/knowledgeQa.spec.ts
```

### Task 7（中）：战创伤 feedback_only 写入 ✅ 目标 1（写）

依赖 Task 3（PHI）和 Task 5（`war_trauma` 档案 + `allowedTypes` 硬闸）。

**Files:**
- Create: `src/trauma/memory/TraumaMemoryCapturePolicy.ts`
- Modify: `src/context/memory/MemoryDomainFacade.ts`
- Modify: `src/gateway/client/InProcessGateway.ts`
- Modify: `src/pilot/config/types.ts`、`ui/server/services/pilotdeckConfig.js`
- Modify: `ui/src/components/settings/view/agentMemory/index.tsx`
- Create: `tests/trauma/memoryCapturePolicy.spec.ts`

- [ ] 实现 `"off" | "feedback_only"`，默认 `feedback_only`。
  **`eligible_turns` 本期不实现**——类型里预留但拒绝启用并给出明确错误。
- [ ] 只接受：明确纠错、稳定展示偏好、汇报格式偏好、工作流规则。
- [ ] **拒绝**：生命体征、伤情分级、救治阶段、患者标识、任何病例医学事实。这层由 Task 5 的 `allowedTypes` 硬闸兜底，本任务负责在策略层再判一次。
- [ ] 落盘前调用 Task 3 的 `MemoryPrivacyPolicy`。
- [ ] errored / aborted / 模型未完成的 turn 默认不捕获。
- [ ] 每次捕获记录 policy、原因、被删除字段数、目标 scope。
- [ ] UI 说明该策略的隐私影响。
- [ ] **必测**：一段包含生命体征的战创伤对话跑完后，长期记忆里不出现任何生命体征数值。
- [ ] **必测（绕过验证）**：即使人为把分类结果篡改为 `project`，`allowedTypes` 硬闸仍然拦住，长期记忆无写入。

运行：
```bash
pnpm exec tsx --test tests/trauma/memoryCapturePolicy.spec.ts
pnpm --dir ui test -- server/routes/memory.test.js
pnpm --dir ui typecheck
```

### Task 8（中）：统一 Dashboard 的项目与 session 身份

Task 9 的前置。

**Files:**
- Modify: `ui/src/components/main-content/view/memory/MemoryPanel.tsx`
- Modify: `src/context/memory/edgeclaw-memory-core/ui-source/app.js`
- Modify: `ui/server/routes/memory.js`
- Modify: `ui/server/services/memoryService.js`
- Create: `ui/src/components/main-content/view/memory/MemoryPanel.test.tsx`
- Test: `ui/server/routes/memory.test.js`

- [ ] iframe URL 改为传 `projectId` + `projectType` + 当前 `sessionId`，`projectPath` 降级为展示参数。
- [ ] **`/cases` 改名为 `/index-case-traces`**（§2.1），把 `cases` 这个词让给 Case State。保留旧路径一个版本并返回 deprecation 头。
- [ ] Dashboard 顶部始终显示项目类型、稳定 project id、数据目录、只读状态。
- [ ] 防止在项目 A 的面板中编辑项目 B 的 meta。
- [ ] 导入导出 bundle 使用稳定 project id，兼容旧 bundle 的 projectPath。
- [ ] 注意 `MemoryPanel.test.tsx` 只能测到 iframe URL 拼装；`app.js` 侧的行为放进 Task 0 建立的子包测试。

运行：
```bash
pnpm --dir ui test -- server/routes/memory.test.js MemoryPanel.test.tsx
pnpm --dir ui typecheck
```

### Task 9（中）：Memory 面板增加病例状态页 ✅ 目标 2

**Files:**
- Modify: `src/context/memory/edgeclaw-memory-core/ui-source/app.js`
- Create: `ui/server/routes/caseState.js`
- Create: `ui/server/routes/caseState.test.js`（vitest）
- Modify: `ui/server/routes/memory.js`
- Modify: `ui/src/components/main-content/view/memory/MemoryPanel.tsx`

- [ ] 面板一级导航区分「长期记忆 / 病例状态 / 运行记录」。
- [ ] **通用医学隐藏病例状态页**；战创伤展示当前 session 的 `current.json` 摘要 + `snapshots.jsonl` 时间线。
- [ ] 复用 `readTraumaCase`（`createLocalGateway.ts:936`）的读取路径，经 Task 1 的 resolver 定位。
- [ ] **病例状态只读展示**，编辑仍走 Trauma 专用业务接口。不得把 Case State 表现成可自由编辑的 Markdown memory。
- [ ] 长期记忆条目标注 scope、来源、更新时间、是否已被 Dream 合并。
- [ ] 依赖 Task 8 的 `/cases` 改名，否则两个「病例」入口会撞。

运行：
```bash
pnpm --dir ui test -- server/routes/caseState.test.js
pnpm --dir ui test
pnpm --dir ui typecheck
```

### Task 10（中）：Index / Dream 即时化 + 全局画像写锁 ✅ 目标 3（战创伤侧）

**Files:**
- Modify: `src/context/memory/edgeclaw-memory-core/src/service.ts`
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/types.ts`
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/storage/sqlite.ts`（默认值）
- Modify: `src/pilot/config/types.ts`、`src/pilot/config/parseMemoryConfig.ts`
- Modify: `ui/src/components/settings/view/agentMemory/memoryIntervals.ts`
- Create: `src/context/memory/GlobalProfileLock.ts`
- Modify: `src/context/memory/EdgeClawMemoryProvider.ts`
- Modify: `ui/server/routes/memory.js`
- Test: `src/context/memory/edgeclaw-memory-core/test/service.test.ts`
- Create: `tests/context/memory/globalProfileLock.spec.ts`

- [ ] 新增显式语义，**不复用 `0`**：
  ```ts
  type MemoryMaintenanceMode = "immediate" | "interval" | "manual";
  ```
  `immediate` = 去掉时间门、保留内容门；`interval` = 现有行为；`manual` = 只有手动按钮。
- [ ] **按项目类型分别配置**。本任务把战创伤默认设为 `immediate`，**通用医学保持 `interval`**——通用医学档案要到 Task 11 才医学化，提前提频只会加速积累通用框架的噪音。切换是 Task 11 的收尾项。
- [ ] `runDueScheduledMaintenance`（`service.ts:915`）在 `immediate` 下：Index 条件收缩为 `overview.pendingSessions > 0`；Dream 条件收缩为 `changedFilesSinceLastDream > 0`。
- [ ] 保留 `intervalMinutes <= 0 → 禁用` 的现有语义不变，避免破坏老配置。写迁移测试。
- [ ] 同步 `sqlite.ts:1713-1714` 和 `memoryIntervals.ts` 两处默认值，并在设置 UI 暴露 mode 选择。
- [ ] **全局画像单写锁**（`GlobalProfileLock`）：跨项目、跨进程有效的文件锁或 CAS。**全局画像是两种模式共用的单一文件**（§3.8），所以锁的作用域必须是全局而非按项目类型划分。锁必须有超时，超时可观测、不破坏数据；拿不到锁时**跳过本次 Dream 而不是排队堆积**。
- [ ] 成本护栏：Dream 连续失败 N 次后自动降级为 `interval` 并在 Dashboard 提示。
- [ ] 为每个 turn 展示 `captured -> pending_index -> indexed -> pending_dream -> consolidated` 状态。
- [ ] 捕获失败写 trace/warning，仍不阻断对话。
- [ ] Dashboard 显示 backlog、最近捕获/索引/Dream 时间、失败原因、当前 mode。
- [ ] 手动 Index 后刷新同一 snapshot，避免用户以为按钮没生效。
- [ ] **必测**：一个战创伤项目与一个通用医学项目并发触发 Dream，全局画像不丢内容；`immediate` 下单轮对话后 Index/Dream 确实执行；老配置升级后行为可预期。

运行：
```bash
pnpm --dir src/context/memory/edgeclaw-memory-core test
pnpm exec tsx --test tests/context/memory/globalProfileLock.spec.ts
pnpm --dir ui test -- server/routes/memory.test.js
```

### Task 11（高）：填充通用医学档案 ✅ 目标 4

本计划最大的一块，按你的要求放在最后。地基已就位：Task 3 PHI、Task 4 全局画像三段、Task 5 档案机制。**本任务只改 `generalMedicine.ts` 的医学内容，不动机制。**

**Files:**
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/skills/prompts/generalMedicine.ts`
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/retrieval/reasoning-loop.ts`（过敏史优先级）
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/review/dream-review.ts`（过敏史白名单）
- Test: `src/context/memory/edgeclaw-memory-core/test/prompts.test.ts`
- Create: `tests/context/memory/medicalExtraction.spec.ts`
- Create: `tests/context/memory/allergyRecall.spec.ts`

**11a 项目记忆患者病历化（§3.3）**
- [ ] `noteCreate.project` 增加六个医学小类的抽取规则，明确「本项目对应单一患者，项目记忆即该患者病历」。
- [ ] **必测（安全红线）**：项目 A 的临床事实不会在项目 B 的对话中被召回。

**11b feedback 医学化 + 分类器医学判别（§3.4）**
- [ ] `noteCreate.feedback` 覆盖汇报格式、表达偏好、诊疗习惯。
- [ ] `classification` 按 §3.4 的三行表格增加医学语境判别规则和例子，在共享的 Override test 骨架之上叠加。
- [ ] 实现硬否决：含具体病情、诊断、化验值、用药记录、既往史、过敏史，或含患者指代的内容，**一律不得判为 `user`**。
- [ ] **不实现晋升机制**（§1.3.1）。项目内容到全局画像没有任何通路，这是设计约束不是待办。
- [ ] **必测（安全红线）**：含病情/诊断/化验值/患者指代的内容，即使在 3 个不同项目中重复出现，也不会出现在全局画像里。
- [ ] **必测**：带明确跨项目信号的纯格式偏好（「所有项目都请标注证据等级」）能被判为 `user` 并落入 `## 临床偏好`——这是 Task 4 留下的空段落第一次被填充。

**11c 过敏史特殊待遇（§3.5）**
- [ ] 召回优先级最高且不受 token 预算裁剪。
- [ ] Dream 白名单：禁止删除，只能追加或标记「用户已撤销」。
- [ ] 与当前轮输入冲突时必须显式暴露，禁止静默采信。
- [ ] **必测**：Dream 连跑 10 次后过敏史仍在；记忆与本轮输入矛盾时 prompt 中出现冲突提示；过敏史绝不出现在全局画像中。

**11d 收尾：打开通用医学的即时化**
- [ ] 把通用医学项目的 `MemoryMaintenanceMode` 默认值从 `interval` 切到 `immediate`（Task 10 留下的开关）。
- [ ] 切换后重跑 Task 10 和 11c 的全部测试，确认高频 Dream 下过敏史保护与分类硬否决仍然成立。

运行：
```bash
pnpm --dir src/context/memory/edgeclaw-memory-core test
pnpm exec tsx --test tests/context/memory/medicalExtraction.spec.ts tests/context/memory/allergyRecall.spec.ts
```

### Task 12（低）：归档接口预留与遗留项收口

**Files:**
- Modify: `ui/server/utils/sessionCleanup.js`
- Modify: `src/pilot/config/parseMemoryConfig.ts`
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.ts`
- Create: `docs/superpowers/plans/memory-followups.md`

- [ ] 在 `sessionCleanup` 留出 `beforeDelete` 钩子。复用已有的 `getPilotArchivesRootDir`（`paths.ts:385`）和 `formatProjectArchiveTimestamp`（`:404`），不新造常量。
- [ ] **删除死代码 `EXTRACTION_SYSTEM_PROMPT`**（`llm-extraction.ts:515`，全仓库零引用，§1.3）。放在最后删，避免早期误判为「还有别的入口在用」。
- [ ] **`reasoningMode` 收口**（§1.7）：它没有消费者。二选一——(a) 在 `reasoning-loop.ts` 真正接上两种模式并各写测试；(b) 从配置解析和 API 校验中移除，给出迁移 warning，保留 SQLite 列以兼容旧库。**推荐 (b)**。
- [ ] 顺带修复 `service.ts:645` 的「DB 记录优先于 config」问题，或至少在设置 UI 说明该行为。
- [ ] followups 记录本期未做项：完整可恢复归档、`eligible_turns` 策略、记忆 provenance、项目删除与 session 删除的去重、归档保留期与容量治理。

运行：
```bash
pnpm exec tsc -p tsconfig.json --noEmit
pnpm --dir ui typecheck
pnpm test
git diff --check
```

---

## 5. 测试框架约定（必读）

| 位置 | 框架 | 运行方式 |
|---|---|---|
| `tests/**/*.spec.ts` | node:test | `pnpm exec tsx --test tests/xxx.spec.ts`（本地快跑）；CI 走根 `pnpm test`，先 `build` 再跑 `dist/tests/**` |
| `tests/pilot/*.spec.js` | node:test | `node --test tests/pilot/xxx.spec.js` |
| `ui/**/*.test.js` `ui/**/*.test.tsx` `ui/**/*.spec.ts` | **vitest** | `pnpm --dir ui test -- <filter>` |
| `src/context/memory/edgeclaw-memory-core/test/**` | Task 0 中选定 | `pnpm --dir src/context/memory/edgeclaw-memory-core test` |

**硬性规则：**

1. **`ui/` 下新建的任何测试文件必须用 vitest。** `ui` 的 vitest 用默认 include（`**/*.{test,spec}.?(c|m)[jt]s?(x)`），会把 `ui/server/**` 一并收走。写成 `node:test` 风格会让 `pnpm --dir ui test` 全量跑变红。
2. **`ui/server/routes/memory.test.js` 是 vitest**，不能用 `node --test` 跑。
3. 根仓库 `pnpm test` = `npm run build && node --test dist/tests/**`，会先全量 TS 编译。日常用 `tsx` 直跑，合并前用 `pnpm test`。
4. 仓库用 **pnpm**（`pnpm-lock.yaml`），但 `package.json` 脚本内部写的是 `npm run`。不要改它们。

---

## 6. 里程碑

| 里程碑 | 任务 | 可交付结果 |
|---|---|---|
| M1 基线可信 | Task 0-1 | 子包可测试；项目/session 身份唯一，两套 slug 显式建模 |
| M2 止血 | Task 2 | 删除 session 不再留下孤儿病例目录 ✅ 目标 5 |
| M3 地基 | Task 3-5 | PHI 红线覆盖所有落盘路径；全局画像三段化；提示词按项目类型分档，通用医学行为零变化 |
| M4 战创伤记忆 | Task 6-7 | 战创伤读全局画像与项目 Feedback，按 feedback_only 写入，病例事实有代码级硬闸 ✅ 目标 1 |
| M5 面板 | Task 8-9 | 病例状态页上线，Dashboard 身份统一 ✅ 目标 2 |
| M6 即时生效 | Task 10 | 战创伤对话后 Index/Dream 立即执行，全局画像有写锁 ✅ 目标 3（战创伤侧） |
| M7 通用医学提取 | Task 11-12 | 通用医学档案按医生画像/患者病历/协作偏好三层组织，过敏史受保护，通用医学也切到即时 ✅ 目标 4 + 目标 3（通用医学侧） |

---

## 7. 验收标准

**目标达成**
- 战创伤对话能读取全局画像（三段）与当前项目 Feedback，且不会跨项目、跨病例召回。
- 战创伤 Memory 面板有独立的病例状态页，展示 `current.json` 摘要与 snapshots 时间线，只读。
- 对话结束后 Index 与 Dream 无需等待即执行，面板在数秒内反映新记忆（战创伤在 M6 达成，通用医学在 M7 达成）。
- 两种模式使用各自的提取提示词档案，共享片段单一来源、无重复文字。
- 提取产物符合 §3 分层：全局画像只有医生信息/专业领域/临床偏好；项目记忆是这位患者的病历；feedback 是项目内协作规则。
- 删除任一战创伤 session 后，transcript、inbox、case 目录三者同步消失。

**不回归**
- 通用医学原有 EdgeClaw 召回、捕获、Index、Dream 和回滚行为保持兼容。
- **Task 5 完成后通用医学提取行为逐字不变**——提示词结构快照与 Task 0 基线相同。
- 存量 `user-profile.md`（只有 `## 身份背景`）能被新代码正确读取，Dream 重写后不丢内容。
- 存量 case 目录能被新 resolver 正确定位（含空格/Unicode 的 sessionId）。
- 老配置（显式设了 intervalMinutes）升级后行为可预期且有文档说明。

**安全（「一个项目 = 一个患者」模型下的红线）**
- 项目 A 的临床事实不会在项目 B 的对话中被召回。
- 任何病情、诊断、化验值、既往史、过敏史都不会进入全局画像——即使在多个项目中重复出现。**系统中不存在从项目记忆到全局画像的任何数据通路**（§1.3.1）。
- 过敏史经过 10 次 Dream 后仍然存在，且与本轮输入冲突时被显式指出。
- 身份证号、病历号、手机号、精确出生日期不出现在任何长期记忆文件中。
- 战创伤的生命体征与伤情不进入长期记忆，且在分类结果被人为篡改时仍由 `allowedTypes` 硬闸拦住。
- 两个不同类型的项目并发 Dream 不会互相覆盖全局画像。

---

## 8. 实施纪律

- 每次只实施一个 Task，开始前重新核对实际文件名、行号和现有未提交修改（当前分支 `feat/trauma` 有未提交的 chat-v2 改动）。
- **数据格式变化必须先写兼容读取测试，再写迁移代码。** 本期只有一处格式变化：全局画像三段化（Task 4）。
- **不引入「项目记忆晋升到全局画像」机制**（§1.3.1）。看到任何需求想把 feedback/project 内容并入全局画像时，先回来读这一节。
- **提示词分档只分医学领域部分**（§3.8）。JSON 契约、PHI 条款、格式约束必须留在 `shared.ts`，两个档案插值引用——发现自己在两个档案里写相似的话，说明切分错了。
- **Task 5 是纯机制重构，通用医学行为必须零变化。** 搬运后提示词快照与基线逐字相同才算通过。医学内容改造一律留到 Task 11。
- 涉及 `src/pilot/paths.ts` 的改动必须同步 `ui/server/utils/pilotPaths.js`，并由 Task 1 的 golden fixture 守护。
- `ui/` 下新建测试一律 vitest；`tests/` 下用 node:test。见 §5。
- 不直接编辑用户现有的 memory Markdown、病例 JSON 进行「修复」。
- 迁移先支持 dry-run 和备份；不使用不可恢复的批量删除命令。
- Task 2 会引入不可恢复的删除。落地前必须确认前端确认文案已更新，且用真实测试项目验证过一次。
- **Task 10 不得把通用医学切到 `immediate`**——那是 Task 11d 的收尾项，提前切会在档案还没医学化时加速积累噪音。
- 每个里程碑完成后，用真实的通用医学与战创伤测试项目各做一次端到端验收。
