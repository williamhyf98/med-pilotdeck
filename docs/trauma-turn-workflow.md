# 战创伤推演：用户输入后的整体工作流

本文记录 **当前实现**（表单输入 + `TraumaTurnRunner`）从提交本轮表单到流程图刷新的完整链路，便于按步骤读源码。业务背景见：

- `docs/trauma-form-input-design.md`（表单化设计决策；状态已落地）
- `docs/战伤分级救治智能推演系统-项目实施说明书.md`（业务类型约定，可能滞后）

**冲突时以本仓库代码为准。**

---

## 1. 一句话

**用户填写表单并提交 → 程序校验并确定性合并 → 表单明示子级则短路工位 P，否则工位 P 按固化定义判断落位 → 首次或变化时请求用户确认推演基线 → 按确认级别做固定 3 次第一波 RAG → 工位 B 出方案 → 程序 Gate → 落盘病例与对话 → 只读轮次时间线与流程图刷新。**

模型只负责医学内容（工位 **P / R / B**），**不能自行调工具**。完整有效病例轮最多 **3 次** strict JSON 调用；用户明示四个子级之一时跳过工位 P，最多 **2 次**。工位 P 之前不做 RAG。Gate 只作为医学建议，**不再产生第二张确认卡**。没有工位 A、没有 `turnKind`、没有时效时间线计算。

---

## 2. 与通用医学路径的差别

|        | 战创伤（`war_trauma` / `trauma_med`） | 通用医学（`general_medicine` / `general_med`） |
| ------ | ------------------------------------ | ---------------------------------------------- |
| 谁决定下一步 | `TraumaTurnRunner` 固定 14 步编排 | 模型在 `AgentSession` 里自主循环 |
| 输入     | 结构化 `traumaForm`（级别选择 + 四段叙述 + 五项体征） | 对话文本 + 可选附件 |
| 模型调用   | 每轮最多 3 次 strict JSON（P 可短路；R / B） | 多轮对话 + 任意工具 |
| RAG    | 程序调用 MCP，3～6 次 | 模型自己决定何时调、调几次 |
| 阶段     | 仅支持战现场急救（Ⅰ级）和早期救治（Ⅱ级）；首次或变化时由用户确认推演基线 | 无战创伤救治状态机 |
| 工作台    | 表单 + 只读轮次时间线 + 三层流程树 + 详情 | 普通对话 |

分流位置：`src/gateway/client/InProcessGateway.ts` 的 `isTraumaProject()`。

判定条件：

- `projectTypeKeyFromProjectId === "trauma_med"`，或
- 项目元数据 `war_trauma`

命中后 **不进入** `AgentSession.submit`。缺少合法 `traumaForm` 时直接抛错：`war_trauma turns require a valid traumaForm`。

---

## 3. 端到端总览

```text
用户在 TraumaWorkspace 填写表单并提交
        │
        ▼
MainContent.submitTraumaForm
  → sessionLauncher（command 文本 + options.traumaForm）
  → UI Server sanitizeTraumaFormInput
  → Gateway.submitTurn（message + traumaForm）
        │
        ├─ 立刻 emit turn_started
        ├─ runner.runTurn({ form, ... })
        │     ├─ 校验并 mergeFormInput
        │     ├─ 明示子级则程序合成 user_stated；否则工位 P
        │     ├─ 首次/变化时 elicitation_request，原回合暂停
        │     ├─ 用户选择建议级或保持当前级后继续
        │     ├─ 无法落位则走 6 步短路径：生成并持久化部分 agent_turn
        │     │    （version/round +1；不检索、不调用工位 B）
        │     ├─ 按已确认级别执行 RAG 两波
        │     ├─ 工位 B 研判
        │     ├─ resolveGate
        │     └─ saveTurn + 审计日志
        ├─ recordTraumaTurn（对话 JSONL：表单摘要 + 主文）
        └─ traumaTurnEvents
              ├─ assistant_text_delta（整段主文一次推送）
              └─ turn_completed
                    │
                    ▼
              流程图 useCaseStore 立即刷新（3s 轮询兜底）
              只读 TraumaRoundTimeline 展示本轮提交摘要 + 工位 B 主文
```

进度反馈：校验 / 定级 / 检索 / 研判映射成 `tool_call_started` / `tool_call_finished`（`src/trauma/events.ts` 的 `traumaProgressEvents`）。可见 phase：`validate` / `place` / `retrieve` / `reason`。

---

## 4. 表单字段（当前 UI 与协议）

入口：`ui/src/components/trauma-workspace/TraumaTurnForm.tsx`。提交载荷类型：`TurnFormInput`（`src/trauma/types.ts`，前端镜像在 `domain/types.ts`）。

**不再用普通对话输入框提交。** 战创伤工作台显示表单与只读 `TraumaRoundTimeline`；`MainContent.tsx` 仍把隐藏普通 composer 的 `ChatInterfaceV2` 作为 runtime panel 持续挂载，用来接收实时事件并展示落位 permission/elicitation banner。

### 4.1 本轮明示救治级别

- 控件：单选按钮组。
- 选项：初级急救 / 高级急救 / 紧急处置 / 外科复苏 / **由系统判定**（默认，值为 `statedSubStage: null`）。
- 选择四个子级之一本身 **不算** 有效输入；必须另有叙述或体征。
- 不填机构。机构由确认后的子级派生，见 §8。

### 4.2 四段叙述

| 字段 | 上限 | 空值 |
| --- | --- | --- |
| `injuryNarrative` 伤情描述 | 1000 字 | 本轮未报告伤情，不追加 |
| `treatmentNarrative` 已做处置 | 800 字 | 本轮无新处置，不追加 |
| `evacuationNarrative` 后送条件 | 500 字 | 本轮无后送信息，不追加 |
| `note` 补充说明 | 500 字 | 不追加 |

更正写进伤情叙述即可：条目按轮次追加，下游约定 **后一轮覆盖前一轮冲突内容**。

### 4.3 五项本轮实测体征

前三项对应《战伤救治规则》第二十九条简易战伤计分（呼吸、收缩压、GCS 总分）；另加心率、体温。舒张压、SpO₂ **不进表单**。

| 键 | 界面标签 | 单位 | 范围 | 精度 |
| --- | --- | --- | --- | --- |
| `respiratoryRate` | 呼吸频率 | 次/分 | 0–80 | 整数 |
| `systolicBloodPressure` | 收缩压 | mmHg | 20–300 | 整数 |
| `gcs` | GCS | 分 | 3–15 | 整数 |
| `heartRate` | 心率 | 次/分 | 0–300 | 整数 |
| `temperature` | 体温 | ℃ | 20–45 | 一位小数 |

未填的键缺席，**不继承上一轮**。界面把历史实测显示为灰色参考（「上次 RN：…」），没有「沿用上一轮」按钮。未测项由工位 B 写入 `missingInformation`。程序 **不算** 战伤计分。

### 4.4 提交校验

`validateTurnFormInput`（`src/trauma/factMerge.ts`）：

1. 仅允许键：`statedSubStage` + 四段叙述 + `vitals`。
2. 至少一段非空叙述 **或** 任一体征，否则拒绝。
3. 叙述为字符串且不超过上限。
4. 体征键必须是五项之一，数值有限；体温须一位小数（`n * 10` 为整数），其余为整数，且在范围内。
5. `statedSubStage` 为 `null` 或四个子级之一。

失败在 runner 第 2 步抛 `invalid trauma form input`，不调模型、不检索。网关在进 runner 前再校验一次。UI Server 的 `sanitizeTraumaFormInput` 只做类型/枚举清洗，**不**复刻范围与「至少一项」规则。

---

## 5. 存储布局

### 5.1 病例状态（按会话）

路径由 `resolveTraumaCaseDir` 生成：

```text
$PILOT_HOME/memory/trauma_med/<projectId>/cases/<sessionId>/
  current.json          # 当前 CaseState（原子写：临时文件 + rename）
  snapshots.jsonl       # 每轮一条快照
```

实现：`src/trauma/store.ts`、`src/pilot/paths.ts`。读取时一律走 `migrateCaseState`。

快照 `eventType`：

- `agent_turn`：完整 14 步流水线，或未落位 6 步短路径写入的病例回合
- `transition_confirmation`：兼容旧 `pendingTransition` 确认；**当前 Gate 不再写入 pendingTransition**
- `manual_stage_override`：流程图人工覆盖

落位确认发生在同一活跃回合内；确认且落位成功后才运行 RAG / 工位 B。人工覆盖单独写快照，不追加纪要叶子。

**未落位短路径**（工位 P `undetermined` / `out_of_scope`，或程序校验后主级/子级仍空）：完成步骤 1–4 后执行 `build_partial_response_and_snapshot` 与 `persist_partial_snapshot`，总计 **6 步**。已校验表单的确定性合并结果会写入 `current.json` 和一条 `eventType: "agent_turn"` 快照；`version` / `round` 各加 1；不调用 RAG / 工位 B。响应 `messageId` 使用真实 `input.messageId`（网关 runId），不再使用固定占位值。

### 5.2 对话记录

```text
$PILOT_HOME/projects/trauma_med/<projectId>/chats/<sessionId>.jsonl
```

`createLocalGateway` 的 `recordTraumaTurn` 写入两条 `durable_message`（user = `summarizeTraumaForm` 文本摘要，assistant = 主文）。

### 5.3 审计日志

```text
$PILOT_HOME/logs/trauma-agent.jsonl
```

实现：`src/trauma/auditLog.ts`。每步 `step_started` / `step_completed` / `step_failed`。`turn_started` 的 details 含叙述字符数与本轮实测体征个数。

### 5.4 旧病例迁移（`migrateCaseState`）

读取 `current.json` / `snapshots.jsonl` 时执行，不单独写审计告警。

- 已有 `injuryNarratives` 则保留；否则把旧 `injuries` 合成 **一条** `round: 0` 叙述。每个旧伤情项分别加前缀「迁移自结构化伤情：」，内容为 `bodyPart + finding`，后接可选 certainty/status；多项之间用「；」连接。
- 已有 `treatmentNarratives` 则保留；否则把旧 `completedActions` / `currentActions` 的 `title` 拼成一条「迁移自结构化处置：…」。
- `evacuationNarratives` / `notes` 缺省则置 `[]`。
- `vitalSignsHistory`：已是 `{ round, recordedAt, values }` 则保留；否则按旧数组顺序只抽出五项数值，并把轮次依次迁移为 **`index + 1`**（1、2、3……）。
- 若已有 `currentSubStage`，机构与能力按 `typicalFacilityForSubStage` **重新派生**。
- 删除：`injuries`、`completedActions`、`currentActions`、`timeline`、`conflictingFactIds`。
- 无法识别的结构 **抛错**（`trauma case migration failed: …`），不会当成空病例继续。

---

## 6. Runner 十四步

编排器：`src/trauma/runner.ts` 的 `runTurn`。输入是 `TurnFormInput`，没有 `turnKind`。

| 步 | 审计 phase | 执行者 | 源码 | 当前行为 |
| --- | --- | --- | --- | --- |
| 1 | `load_case_state` | 程序 | `store.ts`, `stageConfig.ts` | 读并迁移 `current.json`；无则 `initialCaseState`（主级/子级/机构全空） |
| 2 | `validate_and_merge_form` | 程序 | `factMerge.ts` | 校验表单；`nextRound = previous.round + 1`；`mergeFormInput` 后写入 `candidate.round` |
| 3 | `assess_placement` | 程序或工位 P | `runner.ts`, `stations/placer.ts` | 见 §7.1 短路 |
| 4 | `confirm_placement` | 程序 + 用户 | `runner.ts`, `events.ts`, `placement.ts` | 首次/变化时暂停确认；派生机构与能力；无法落位则转 6 步短路径 |
| 5 | `baseline_retrieval` | 程序 + RAG | `rag/queryPlan.ts`, `rag/client.ts` | 固定 3 条并行，`top_k=8` |
| 6 | `plan_supplemental_queries` | 程序 | `runner.ts` | 当前单波模式，记录 `skipped: true` |
| 7 | `supplemental_retrieval` | 程序 | `runner.ts` | 当前单波模式，记录 `skipped: true`、`queryCount: 0` |
| 8 | `merge_retrieval` | 程序 | `rag/merge.ts` | 全量证据落盘；prompt ≤15 块 |
| 9 | `reason` | **工位 B** | `stations/reasoner.ts`, `reasonerPrompt.ts` | 确认级别下出方案；入参无时间线 |
| 10 | `resolve_gate` | 程序 | `gate.ts` | 安全约束覆盖模型建议 |
| 11 | `prepare_transition_advice` | 程序 | `runner.ts` | `pendingTransition` 固定为 `undefined` |
| 12 | `mark_evidence` | 程序 | `runner.ts` | 标记引用知识块 |
| 13 | `build_response_and_snapshot` | 程序 | `runner.ts`, `types.ts` | `version+1`，`round` 已是本轮，追加 memo |
| 14 | `persist_snapshot` | 程序 | `store.ts` | `current.json` + `snapshots.jsonl` |

落位首次确定或变化时，经 `GatewayElicitationChannel` 暂停等待用户；选择完成后在 **同一回合** 继续。网关解析答案只区分「采用建议」与「保持当前」（见 `parsePlacementConfirmation`）。runner 类型上还允许 `choice: "selected"`，当前 elicitation 选项 **不会** 产生该分支。

### 第 2 步 `validate_and_merge_form`

`mergeFormInput(previous, form, round, now)` 对上一版 `structuredClone` 后改副本：

| 输入 | 动作 | 空值 |
| --- | --- | --- |
| 四段叙述 | trim 后追加 `NarrativeEntry` | 不追加 |
| `vitals` | 追加一条 `VitalsRoundRecord`，只含已填键 | 全空则不追加 |
| `statedSubStage` | 本步不写入级别 | 交给第 3 步 |

本步 **不改** `version` / `currentStage` / `currentSubStage`。`updatedAt` 改为 `now`。`round` 由 runner 在合并后赋为 `nextRound`。磁盘上一版要到第 14 步才被替换。

### 第 3 步 `assess_placement`：程序短路

`statedSubStage !== null` 时 **不调** `placer.place`，直接：

- `determined: true`
- `source: "user_stated"`
- 主级由 `SUBSTAGE_TO_MAIN` 映射
- `rationale`: 「用户通过表单明示本轮救治级别。」

否则调用工位 P（见 §7.1）。明示四个子级之一时 **不再走范围判定**；Ⅲ/Ⅳ 级只能靠叙述让工位 P 标 `out_of_scope`。

### 第 4 步 `confirm_placement`

`placementChanged`：建议已确定，且主级或子级与 `previous` 不同（含首次从空到有）。

- 需要确认但未注入 `requestPlacementConfirmation` → 抛错。
- 用户选保持当前：用上一版级别，`source=user_stated`。
- 建议未变：跳过确认卡。
- 建议为 `undetermined` 但上一版已有级别：保持当前，不弹卡。

然后 `resolveStagePlacement`：合法主级/子级映射、非空理由；`source=definition` 还必须有 `definitionReferences`。否则主级/子级/机构全空。机构一律 `typicalFacilityForSubStage`，**不采用模型填的机构名**（schema 里也没有该字段）。

全空则进入短路径：第 5 步 `build_partial_response_and_snapshot` 构造 version/round 已递增的部分状态与 `placementOnlyResponse`，第 6 步 `persist_partial_snapshot` 写 `agent_turn`。响应沿用真实 runId；没有 RAG、工位 R 或工位 B。落位成功时仍继续走上表完整 **14 步**。

---

## 7. 三个模型工位

客户端：`src/trauma/modelClient.ts`

- `temperature: 0`
- OpenAI **strict JSON Schema**
- 返回后 `stripNulls`，再跑 TypeScript `validate`
- Schema：`src/trauma/schemas.ts`（仅 P / R / B）

工位 P / R / B 的病例侧入参都通过 `compactCaseStateForDownstream`（RAG 第一波问句是平行实现，见 §8、§9）。

压缩视图实际内容：

- 已确认主级 / 子级 / 派生机构
- 伤情 / 处置 / 后送：按 round **倒序最多 6 条**，每条截断 **300** 字
- 补充说明：**仅本轮**一条
- 体征：`recentRecords` 为最近 **6 条**体征记录（新到旧）；`latestByField` 为每个体征最近值及其来源 `round`、`stale`；另有跨字段聚合后的 `values`、`latestMeasuredRound`、`measuredThisRound`

### 7.1 工位 P · Placement

输入（模型）：`previousPlacement` + `caseHistory`（compact 视图）。**没有**单独的 `statedSubStage` 字段，因为明示路径已在程序侧短路。

输出：`PlacementAssessment`（主级、子级、来源、理由、定义标题）。无 `facilityName`。

模型侧判定顺序（`placementPrompt.ts`）：

1. **范围判定**（最高优先）：叙述表明伤员 **当前已处于** 专科治疗（Ⅲ级）或康复治疗（Ⅳ级），或身处只能对应后两级的机构 → `source=out_of_scope`，不落位。仅「可能需要」更高级能力不适用。
2. **定义判断**：按固化第七、八条与历史叙述，`source=definition`。
3. 无法唯一确定 → `source=undetermined`，stage/subStage 为 null。不得默认Ⅰ级或连抢救组。

程序兜底：`resolveStagePlacement` 校验 `SUBSTAGE_TO_MAIN`。

工位 P 之前不调用 RAG。固化内容只保留Ⅰ/Ⅱ级及四个子级；Ⅲ/Ⅳ 级只作超范围名称。

### 7.2 工位 R · Planner

输入：compact 病例、第一波 `RetrievalTrace`、剩余预算。输出 0～3 条补检 query。

### 7.3 工位 B · Reasoner

输入：已确认落位（含派生机构与 `placementRationale`）、compact 状态、最多 15 个知识块。工位 B 不再定级，也 **没有 timeline**。

程序再拆成主文、`treatmentPlan`、`classification`、`gateAssessment`、`transition`、`memo`、`missingInformation`。主文要求约 800～2500 字、固定板块；`treatmentPlan` 短标题 + `evidenceChunkIds`。纪要供流程图叶子使用。

若需更高级能力，只能提示转入「专科治疗（Ⅲ级）」或「康复治疗（Ⅳ级）」，结构化目标阶段保持 `null`。`transition.requiresUserConfirmation` 一律 false。

**当前不是 token 流式**：网关一次 `assistant_text_delta` 推整段主文。

程序还会按子级约束 `treatmentPlan`（例如初级急救把超出提示能力的 `current_stage` 改成 `next_stage`；过滤明显Ⅲ/Ⅳ 级措辞）。

---

## 8. 派生机构

`TYPICAL_FACILITY_BY_SUBSTAGE`（`src/trauma/stageConfig.ts`）：

| 子级 | 机构名 | `type` |
| --- | --- | --- |
| `primary_first_aid` | 连抢救组 | `company_aid_team` |
| `advanced_first_aid` | 营救护站 | `battalion_aid_station` |
| `emergency_treatment` | 旅（团）救护所 | `regiment_aid_station` |
| `surgical_resuscitation` | **医务中心** | `medical_center` |

确认落位或人工覆盖后，`currentFacility` 与 `currentCapabilities` 都取该表副本。用户不能在表单里填机构。

---

## 9. RAG 细节

工具名：`mcp__med-tools__med_trauma_rag_query`（`src/trauma/rag/client.ts`）。

### 9.1 第一波（固定 3 次，并行）

`buildBaselineQueries` 用 **完整 CaseState** 拼三条中文问题（伤情取最近 6 条叙述倒序截断 300 字；体征取最近一条并标注轮次与「本轮未测」；机构用派生名）。问句 **不含「时效」**：

1. `stage`：当前已确认级别允许的救治技术、任务范围和机构能力
2. `classification_transport`：**分类与后送通用规则**
3. `primary_injury`：当前级别下主要伤情专项处置规则

每条 `top_k = 8`（`TRAUMA_RAG_TOP_K`）。

### 9.2 第二波（当前停用）

当前采用单波模式：工位 R 和第二波补检均跳过，但保留审计步骤 6、7。`RetrievalTrace` 只包含第一波 3 条查询，单轮总 RAG 调用数固定为 **3**。

### 9.3 合并（`rag/merge.ts`）

- 全部 chunk 进入 `evidence`
- 远程结果优先于本地
- 注入 prompt 上限 **15**（`MAX_PROMPT_CHUNKS`）
- 关键覆盖缺口进入 Gate：未补上时程序倾向 `ASSESSING`

---

## 10. Gate 混合判断（`src/trauma/gate.ts`）

工位 B 给出 `ClinicalGateAssessment`。程序否决：下列任一成立 → **ASSESSING**

- `needHigherCapability === "unknown"`
- 存在未消解 `ruleConflicts`
- `evidenceChunkIds` 为空
- 检索仍有 `criticalCoverageGaps`
- `confidence < 0.75`

其后：

| 条件 | 结果 |
| --- | --- |
| 不需要更高能力 | `STAY` |
| `transportReadiness === "unknown"` | `ASSESSING` |
| 需要但未就绪，或有 `blockingFactors` | `BLOCKED` |
| 就绪且有 `targetStage` / `targetSubStage` 与所需能力 | `READY` |
| 其余 | `ASSESSING` |

没有时效超时硬 Gate（时间线已删除）。**`READY` 只表示后送医学建议，不产生确认卡，也不自动改变 `currentStage`。** `prepare_transition_advice` 不创建 `pendingTransition`。

`confirmTransition` 仍挂在 runner / RPC 上，仅处理磁盘里遗留的 `pendingTransition`；当前完整流水线不会新写入该项。

业务规则来源提示在 `reasonerPrompt.ts`（如《战伤救治规则》第二十至二十二条）；具体条款靠本轮知识块。

---

## 11. 网关协议与前端

### 11.1 `traumaForm`

`GatewaySubmitTurnInput.traumaForm?: TurnFormInput`（`src/gateway/protocol/types.ts`）。

路径：

1. `TraumaTurnForm` → `MainContent.submitTraumaForm`
2. `startSessionCommand` 把 `traumaForm` 放进 `pilotdeck-command` 的 `options`，可见文本是表单摘要，**不把 JSON 写进用户可见句**
3. `ui/server/pilotdeck-bridge.js` 的 `sanitizeTraumaFormInput` 后交给 `submitTurn`
4. `InProcessGateway` 校验并 `runner.runTurn({ form })`

战创伤回合 **忽略** 附件抽取：没有把文件内容送进模型的工位。

### 11.2 落位确认

- `metadata.source = "trauma_pending_placement"`
- 选项：采用建议（带派生机构名）/ 若已有当前级则「保持当前」
- 回答走通用 `elicitation-response`

工位 B 完成后只发整段 `assistant_text_delta` 和 `turn_completed`。

### 11.3 只读轮次时间线

`TraumaRoundTimeline.tsx`：`eventType === "agent_turn"` 的快照按 round 排序。上半为本轮表单摘要（明示级别、四段叙述、本轮体征），下半为 `snapshot.response.naturalLanguageAnswer`。

### 11.4 流程图与患者视图

- `ui/src/components/trauma-workspace/store/useCaseStore.ts`
- API：`GET /api/trauma/cases/:sessionId?projectKey=...`
- 远程网关 RPC：`trauma_get_case` / `trauma_confirm_transition` / `trauma_override_stage`
- 对话完成后立即 `refresh`；保留 3 秒轮询兜底
- 叶子来自 `memos`；节点颜色由当前子级 + Gate 推导
- `patientStateView.ts`：伤情/处置为叙述时间线；五项体征卡带相邻实测轮次趋势
- `snapshotAdapter.ts` **没有** 伤时/建议窗口/`elapsed` 卡片

工作台入口：`MainContent` 在战创伤且非 files 视图时渲染 `TraumaWorkspace`，传入 `onSubmitForm` 与始终挂载的 `ChatInterfaceV2` runtime。runtime 设置 `hideComposer=true`：普通 composer 被移除，但 WebSocket 实时处理保持运行；提交期间面板展开，落位 permission/elicitation banner 可见。新项目默认空树，等待首轮提交。

Gate `READY` 的详情文案是「医学建议，未自动执行」。它不是第二次确认，不会弹第二张确认卡。

---

## 12. 源码地图

```text
src/trauma/
  runner.ts                 # 14 步编排
  events.ts                 # 进度事件、落位确认选项、回合事件
  types.ts                  # TurnFormInput / CaseState / RoundMemo / Gate
  schemas.ts                # 工位 P/R/B strict schema
  modelClient.ts            # completeJson + stripNulls
  factMerge.ts              # validateTurnFormInput / mergeFormInput / compactCaseStateForDownstream
  placement.ts              # resolveStagePlacement + 派生机构
  stageConfig.ts            # 四个子级、TYPICAL_FACILITY_BY_SUBSTAGE（外科复苏=医务中心）
  gate.ts
  store.ts                  # 读写 + migrateCaseState
  auditLog.ts
  stations/placer.ts
  stations/placementPrompt.ts
  stations/planner.ts
  stations/reasoner.ts
  stations/reasonerPrompt.ts
  rag/queryPlan.ts
  rag/client.ts
  rag/merge.ts

src/gateway/protocol/types.ts            # traumaForm
src/gateway/client/InProcessGateway.ts   # 分流、表单校验、turn_started
src/cli/createLocalGateway.ts            # runner 工厂、recordTraumaTurn、病例读取

ui/src/components/trauma-workspace/
  TraumaWorkspace.tsx
  TraumaTurnForm.tsx
  TraumaRoundTimeline.tsx
  TreatmentTree.tsx
  store/useCaseStore.ts
  domain/patientStateView.ts
  domain/snapshotAdapter.ts
  detail/StageOverrideDialog.tsx
ui/src/components/main-content/view/MainContent.tsx
ui/src/components/chat/utils/sessionLauncher.ts
ui/server/pilotdeck-bridge.js            # sanitizeTraumaFormInput
```

---

## 13. 测试与命令

根目录 `npm test` 会先 `build` 再跑 `dist/tests/**/*.spec.js`。

后端（需先编译，或对 `tests/` 用你们现有的 tsx/`node --test` 流程）：

```bash
npm run build && node --test --test-force-exit --test-timeout 60000 \
  dist/tests/trauma/*.spec.js \
  dist/tests/gateway/traumaRpc.spec.js
```

现存 `tests/trauma/*.spec.ts`：`auditLog`、`factMerge`、`gate`、`placement`、`placementEvents`、`placer`、`planner`、`queryPlan`、`ragMerge`、`reasoner`、`routing`、`runner`、`schemas`、`stageConfig`、`store`。另有说明文 `tests/trauma/acceptance-15.1.md`（不是自动测试）。`tests/gateway/traumaRpc.spec.ts` 覆盖远程 `trauma_get_case` / `trauma_confirm_transition` / `trauma_override_stage`。

`runner.spec.ts` 覆盖：明示子级跳过工位 P 且外科复苏派生 **医务中心**、非法表单不调模型与 RAG、完整轮审计恰好 14 步、`undetermined` / `out_of_scope` 走 6 步短路径并持久化合并表单且不调用 RAG。`store.spec.ts` 覆盖旧体征按 `index + 1` 迁移；`factMerge.spec.ts` 覆盖 bounded `recentRecords` 与带来源轮次/陈旧标记的 `latestByField`。

前端：

```bash
cd ui && npm test
```

与表单工作流直接相关的用例包括：`TraumaTurnForm.test.tsx`、`TraumaWorkspace.test.tsx`、`store/useCaseStore.test.tsx`、`StageOverrideDialog.test.tsx`、`main-content/view/MainContent.test.tsx`、`chat/utils/sessionLauncher.test.tsx`、`ui/server/pilotdeck-bridge.test.js`。没有单独的 `TraumaRoundTimeline` 测试文件。

每改一步建议先补对应 `tests/trauma/` 或 UI vitest，再对照 `.pilotdeck-home/logs/trauma-agent.jsonl` 做真实会话。

---

## 14. 建议的优化阅读顺序

1. 分流、`traumaForm` 校验与超时：`InProcessGateway.ts`
2. 表单校验与合并：`factMerge.ts`（决定病历槽位，不再经过抽取模型）
3. 落位短路与确认：`runner.ts` 第 3–4 步、`placement.ts`、`placementPrompt.ts`
4. 检索预算：`queryPlan` / Planner / `merge`（时延与依据覆盖）
5. 工位 B：主文质量 vs 结构化字段 vs 纪要长度
6. `resolveGate` 阈值是否过严或过松
7. 前端：表单提交、只读时间线、树刷新；主文仍是一次到达
