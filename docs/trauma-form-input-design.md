# 战创伤推演：表单化输入设计稿

状态：**已实现**（以仓库代码为准；细节与测试清单见 `docs/trauma-turn-workflow.md`）。下文保留当时的设计决策，不当作待办清单。

对照文档：

- `docs/trauma-turn-workflow.md`（当前 11 步实现）
- `docs/战伤分级救治智能推演系统-项目实施说明书.md`（业务与类型约定）

---

## 1. 为什么改

当前输入是一段自由中文，工位 A 负责把它拆成 `turnKind` + 六组结构化事实。真实模型暴露出来的错都集中在**槽位对齐**，不在医学判断：

- 「收缩压92」被抽成 `spo2: 92%`
- 机构名落进 `careAndTransportFacts` 而不是 `context.facility`
- 「没有开放伤，只是擦伤」被合成一条 confirmed 覆盖旧伤
- 实体被译成 `right_thigh` / `gunshot_wound`，跨轮无法比对
- `transport_mode`、`location` 抽出来了却没有合并进 state

这些都是提示词补丁在压，且每来一种新说法就会再破一次。

表单化的核心是**把槽位交给界面，把内容留给用户**：

- 槽位由表单结构保证 → 血压不可能填进血氧栏
- 内容是用户原话 → 不存在翻译、改写、编造
- 提交即增量，程序确定性合并 → 不需要模型判断「是否更新」

结论：**工位 A 已取消**。抽取和分类两步一起消失，模型只保留工位 P（定级）和 B（研判）。

---

## 2. 表单字段

共 5 组。除「明示救治级别」是选择项外，内容一律为叙述或数值。

### 2.1 本轮明示救治级别

| 属性 | 内容 |
|---|---|
| 控件 | 单选 |
| 选项 | 初级急救 / 高级急救 / 紧急处置 / 外科复苏 / 由系统判定（默认） |
| 空值 | 选「由系统判定」时交工位 P 按固化定义判断 |

**不再让用户填机构。** 机构由子级派生，取 `stageConfig.ts` 的 `TYPICAL_FACILITY_BY_SUBSTAGE`：

| 子级 | 派生机构 |
|---|---|
| primary_first_aid | 连抢救组 |
| advanced_first_aid | 营救护站 |
| emergency_treatment | 旅（团）救护所 |
| surgical_resuscitation | 医务中心 |

派生后 `currentCapabilities` 也一并取该机构的能力表，不再靠 `capability` 事实累加。

### 2.2 伤情描述

| 属性 | 内容 |
|---|---|
| 控件 | 多行文本 |
| 长度 | ≤ 1000 字 |
| 空值 | 本轮未报告伤情变化，沿用已有叙述 |
| 提示文案 | 部位、发现、是否活动性；本轮有变化或更正也写在这里 |

更正不再需要指针：叙述按轮次追加，**后一轮覆盖前一轮**。用户写「上一轮说的开放伤不成立，实际只是擦伤」，下游按顺序读到最新描述即可。这样一次性去掉伤情身份识别、`supersedesFactId`、`bodyPart + finding` 字面比对、`conflictingFactIds` 全套机制。

### 2.3 生命体征

五项。前三项对应《战伤救治规则》第二十九条「简易战伤计分」：**呼吸次数、收缩期血压、意识状况**。意识按附件 1 用 GCS 总分（3–15）填写，不拆成睁眼/语言/运动三栏。另加 **心率、体温**：规则在抗休克、心肺复苏、低体温/中暑等专章里反复用这两项，现场也常一起报。

舒张压不进表单，需要时写进伤情、后送条件或补充说明。SpO₂ 已于 2026-09-09 加入封闭体征集（键 `spo2`），依据与设计见 `docs/superpowers/specs/2026-09-09-trauma-freetext-extraction-design.md` §5.4。

| 项 | 输入 | 单位 | 合法范围 | 依据 |
|---|---|---|---|---|
| 呼吸 | 整数 | 次/分 | 0–80 | 计分表 A |
| 收缩压 | 整数 | mmHg | 20–300 | 计分表 B |
| GCS | 整数 | — | 3–15 | 计分表 C |
| 心率 | 整数 | 次/分 | 0–300 | 抗休克 / 心肺复苏 / 心律失常专章 |
| 体温 | 一位小数 | ℃ | 20–45 | 低体温、冻伤、中暑、致命三联征 |

**空值 = 本轮未测，不继承上一轮。** 每条体征按轮次入库。界面把上一轮实测值显示为灰色参考，不设「沿用上一轮」按钮：历史里已经记着「第 3 轮实测 SBP 92」，下游照实说「上次第 3 轮 92，本轮未复核」。勾选沿用等于把没做过的测量记成本轮做过。

本轮不要求五项填齐。未测项由工位 B 写入 `missingInformation`。系统**不在程序里自动算战伤计分**——计分是规则里的伤势参考方法，分类仍由工位 B 依据知识块完成。

### 2.4 已做处置描述

| 属性 | 内容 |
|---|---|
| 控件 | 多行文本 |
| 长度 | ≤ 800 字 |
| 空值 | 本轮无新处置 |
| 提示文案 | 做了什么、进度、效果如何 |

同样按轮次追加。原来的 `planned / in_progress / completed` 与 `completedActions / currentActions` 拆分不再从输入产生（见 §4）。

### 2.5 后送条件描述

| 属性 | 内容 |
|---|---|
| 控件 | 多行文本 |
| 长度 | ≤ 500 字 |
| 空值 | 本轮无后送信息 |
| 提示文案 | 拟送何处、运力、道路与天气等限制 |

原来的 `destination` / `transport_mode` / `transport_constraint` / `capability_gap` 五类合并成一段描述。`transport.targetFacilityType`、`blockingReason` 改由工位 B 的 `gateAssessment` 写入，不再由输入直接写。

### 2.6 补充说明

| 属性 | 内容 |
|---|---|
| 控件 | 多行文本 |
| 长度 | ≤ 500 字 |
| 空值 | 无 |
| 用途 | 任何不属于上述四类的说明；随本轮交给工位 B，不单独结构化 |

---

## 3. Schema 重新设计

以下类型已落入 `src/trauma/types.ts` 与 `src/trauma/schemas.ts`。

### 3.1 表单输入类型（程序校验，非模型输出）

```ts
export type VitalItemKey =
  | "respiratoryRate"
  | "systolicBloodPressure"
  | "gcs"
  | "heartRate"
  | "temperature";

export type TurnFormInput = {
  /** 用户明示子级；null 表示交工位 P 判断 */
  statedSubStage: SubStage | null;
  /** 本轮伤情叙述；空串表示本轮未报告 */
  injuryNarrative: string;
  /** 本轮已做处置叙述 */
  treatmentNarrative: string;
  /** 本轮后送条件叙述 */
  evacuationNarrative: string;
  /** 补充说明 */
  note: string;
  /** 仅本轮实测项；未填的键直接缺席 */
  vitals: Partial<Record<VitalItemKey, number>>;
};
```

校验规则（`validateTurnFormInput`，纯程序）：

1. 至少一项非空（四段叙述或任一体征），否则拒绝提交。
2. 各体征在 §2.3 的范围内；除体温为一位小数外均为整数。
3. 叙述长度不超上限。
4. `statedSubStage` 若非 null，必须是四个子级之一。

失败即拒绝，不进流水线，不消耗模型调用。这已取代原先的模型抽取与重试。

### 3.2 CaseState 变更

新增叙述条目类型：

```ts
export type NarrativeEntry = {
  round: number;
  createdAt: string;
  text: string;
};

export type VitalsRoundRecord = {
  round: number;
  recordedAt: string;
  values: Partial<Record<VitalItemKey, number>>;
};
```

字段对照：

| 现字段 | 变更 | 说明 |
|---|---|---|
| `injuries: InjuryFinding[]` | **替换**为 `injuryNarratives: NarrativeEntry[]` | 按轮次追加，后覆盖前 |
| `completedActions` / `currentActions: TreatmentAction[]` | **替换**为 `treatmentNarratives: NarrativeEntry[]` | `TreatmentAction` 保留，仅用于工位 B 的 `treatmentPlan` 输出 |
| — | **新增** `evacuationNarratives: NarrativeEntry[]` | 后送条件 |
| — | **新增** `notes: NarrativeEntry[]` | 补充说明 |
| `vitalSignsHistory: VitalSigns[]` | 改为 `VitalsRoundRecord[]` | 键从 `(measuredAt, sourceMessageId)` 改为 `round` |
| `currentFacility` | 保留，改为**派生** | 由已确认子级查 `TYPICAL_FACILITY_BY_SUBSTAGE` |
| `currentCapabilities` | 保留，改为**派生** | 同上 |
| `timeline: TimelineState` | **删除** | 去掉时效判断 |
| `conflictingFactIds: string[]` | **删除** | 更正靠叙述顺序 |
| `requiredCapabilities` | 保留 | 改由工位 B `gateAssessment` 写入 |
| `currentStage` / `currentSubStage` / `version` / `round` / `placementRationale` / `classificationHistory` / `transport` / `pendingTransition` / `manualStageOverrides` / `evidence` / `memos` / `missingInformation` | 不变 | — |

### 3.3 删除的类型

- `ExtractedTurnFacts`、`ExtractedFact`、`ExtractedVital`
- `EXTRACTED_TURN_FACTS_SCHEMA`、`validateExtractedTurnFacts`、`stripForbiddenExtractorKeys`
- 原时效计算状态与输入类型
- `InjuryFinding`、`VitalSigns`（被 `VitalsRoundRecord` 取代）
- `AgentTurnResponse` 中原时效计算结果

### 3.4 工位 P / B 的 schema 变更

`PLACEMENT_OUTPUT_SCHEMA`：去掉 `facilityName`（机构由子级派生）。`source` 保留四值，但 `user_stated` 现在只可能来自表单的 `statedSubStage`，「用户明示机构」这条判定路径删除。

`REASONER_OUTPUT_SCHEMA`：结构保持不变，研判入参不再包含时效计算状态。

---

## 4. 合并规则（确定性，无模型参与）

`mergeExtractedFacts` 已替换为 `mergeFormInput(previous, form, round, now)`：

| 输入 | 合并动作 | 空值行为 |
|---|---|---|
| `injuryNarrative` | 追加一条 `NarrativeEntry` | 不追加，历史保留 |
| `treatmentNarrative` | 追加一条 | 不追加 |
| `evacuationNarrative` | 追加一条 | 不追加 |
| `note` | 追加一条 | 不追加 |
| `vitals` | 追加一条 `VitalsRoundRecord`，只含填了的键 | 全空则不追加记录 |
| `statedSubStage` | **不在本步写入**，透传给工位 P | — |

`mergeFormInput` 不改 `version` / `currentStage` / `currentSubStage`。runner 在本步之后把 `candidate.round` 设为 `previous.round + 1`；`version` 与落盘仍在完整流水线最后两步。级别只在用户确认建议之后写入。

叙述条目一律 append-only，不修改历史条目——这也让快照回放天然正确。

合并规则**只负责把本轮表单写进历史**，不等于下游已经「结合历史」。两者必须分开：

| | 做什么 | 不做什么 |
|---|---|---|
| `mergeFormInput` | 把本轮非空字段追加到 `CaseState` | 不把上一轮数值填进本轮空栏；不改写历史条目 |
| 下游（P / RAG / B） | **读取合并后的完整 state**，按轮次看叙述和体征 | 不得只看本轮表单 |

因此「结合历史」是下游读 state 的约定，不是合并时的继承。实现上使用 `compactCaseStateForDownstream(state)`：

- 伤情 / 处置 / 后送：倒序最多 6 条，各截断到 300 字，并保留 round
- 补充说明：仅本轮一条（没有本轮 note 则为 null）
- 体征：`recentRecords` 保留最近 6 条记录（新到旧）；`latestByField` 给出每项最近值、来源轮次与 `stale`；另有聚合 `values`、`latestMeasuredRound`、`measuredThisRound`
- 已确认主级 / 子级 / 派生机构

工位 P、工位 B 吃这份压缩视图（伤情/处置/后送倒序最多 6 条、各截断约 300 字）。检索问句用平行逻辑直接读 `CaseState`（同样最近 6 条伤情叙述、最近体征轮次、派生机构），不经过该 helper。后一轮叙述与前一轮冲突时，提示词写明**后一轮覆盖前一轮**。

---

## 5. 下游改动（已按此落地）

### 5.1 工位 P（`stations/placer.ts` + `placementPrompt.ts`）

程序短路：`statedSubStage` 非 null 时不调工位 P，直接 `determined=true、source=user_stated`，再进入确认卡（首次或与当前级别不同时）。模型工位 P 只在「由系统判定」时调用，入参为上一轮落位 + `compactCaseStateForDownstream`，判定顺序为：

1. **范围判定**（最高优先）。叙述表明伤员当前已处于专科治疗（Ⅲ级）或康复治疗（Ⅳ级）→ `out_of_scope`。
2. **定义判断**。按固化定义与叙述判断，`source=definition`；无法唯一确定输出 `undetermined`。

级别单选**不加**「已进入Ⅲ/Ⅳ级」。范围闸门仍只靠叙述文本由工位 P 识别；用户明示四个子级之一时，程序采用该级，不再走范围判定。

### 5.2 RAG（`rag/queryPlan.ts`）

- `injurySummary` 由 `bodyPart + finding` 拼接改为取最近若干条伤情叙述（按 round 倒序，截断到约 300 字）。
- `latestVitals` 改读 `VitalsRoundRecord`，附注轮次。
- `caseContext` 里的机构名改为派生机构。
- 第二条 query 文案「分类、时效与后送通用规则」→「分类与后送通用规则」。

### 5.3 工位 B（`stations/reasoner.ts` + `reasonerPrompt.ts`）

- 入参删除原时效计算状态。
- 入参 `state.injuries` 改为叙述列表，需在提示词里加一条：**伤情、处置、后送条件是按轮次累积的叙述，后一轮描述覆盖前一轮冲突内容。**
- 提示词删除结构化字段规则第 2 条「时效要求是软提示，不得仅因超过建议时间而切换阶段」。
- 主文「按照时间紧迫性和救治优先级组织回答」改为按救治优先级组织，避免暗示存在时限计算。
- `missingInformation` 更重要了：本轮未测的体征应出现在这里。

### 5.4 Gate（`gate.ts`）

不依赖时效计算状态，`resolveGate` 的五条否决与其后判定保持原样。`READY` 仅是医学后送建议，不产生第二张确认卡。

### 5.5 前端

- 输入统一走表单（`TraumaWorkspace.tsx`），不再用对话输入框提交。
- 原对话栏改为**只读时间线**：每轮一条，上半是本轮表单提交摘要（级别、伤情/处置/后送摘录、本轮体征），下半是工位 B 主文。
- `ChatInterfaceV2` runtime 仍持续挂载并处理实时事件；`hideComposer=true` 移除普通 composer，提交期间展开 runtime panel，显示落位 permission/elicitation banner。
- 不再存在「闲聊」输入，因此没有 `no_case_update` 短路。
- `domain/patientStateView.ts`：伤情列表改为叙述时间线；处置同理；体征五张数值卡（呼吸 / 收缩压 / GCS / 心率 / 体温）与相邻实测轮次趋势。
- `domain/snapshotAdapter.ts`：不再提供建议窗口、已过分钟数等时效卡片。
- `domain/types.ts`、`testFixtures.ts`：跟随 `CaseState` 变更。

---

## 6. Runner 当前路径（已落地）

完整成功路径固定 11 步：

| 步 | phase | 执行者 |
|---|---|---|
| 1 | `load_case_state` | 程序 |
| 2 | `validate_and_merge_form` | 程序 |
| 3 | `assess_placement` | 工位 P（明示时短路） |
| 4 | `confirm_placement` | 程序 + 用户 |
| 5 | `baseline_retrieval` | 程序 + RAG |
| 6 | `merge_retrieval` | 程序 |
| 7 | `reason` | 工位 B |
| 8 | `resolve_gate` | 程序 |
| 9 | `mark_evidence` | 程序 |
| 10 | `build_response_and_snapshot` | 程序 |
| 11 | `persist_snapshot` | 程序 |

每轮模型调用最多 2 次（明示级别时 1 次）。若已校验表单最终为 `undetermined` / `out_of_scope`，则在步骤 1–4 后执行 `build_partial_response_and_snapshot`、`persist_partial_snapshot`，形成 **6 步短路径**：合并后的表单以部分 `agent_turn` 持久化，`version` / `round` 各加 1，响应 `messageId` 使用真实 runId；不调用 RAG 或工位 B。

---

## 7. 当前实现与测试入口

- `src/trauma/factMerge.ts`：`validateTurnFormInput` / `mergeFormInput` / `compactCaseStateForDownstream`
- `src/trauma/runner.ts`：11 步完整路径与 6 步未落位短路径
- `src/trauma/store.ts`：病例迁移与持久化
- `tests/trauma/factMerge.spec.ts`：表单校验、确定性合并、体征历史压缩与陈旧标记
- `tests/trauma/runner.spec.ts`：模型调用、11 步完整路径、6 步部分持久化路径
- `tests/trauma/store.spec.ts`：旧病例迁移
- 根目录 `npm test` 与 `cd ui && npm test`

---

## 8. 旧病例迁移

旧 `current.json` 病例读取时：

- 把旧伤情数组合成**一条** `round: 0` 叙述；每个旧伤情项分别加前缀「迁移自结构化伤情：」，拼接 `bodyPart + finding` 及可选 certainty/status，多项用「；」连接。
- `completedActions` / `currentActions` 的 `title` 合成一条「迁移自结构化处置：…」。
- 旧体征对象按原数组顺序转成 `VitalsRoundRecord`，只保留五项，轮次依次为 **`index + 1`**；已是新结构则原样保留。
- 原时效计算状态、`conflictingFactIds` 以及旧伤情 / 动作数组从迁移结果删除。

迁移在 `store.load()` / `loadSnapshots()` 里做。无法识别的旧结构 **抛错**（`trauma case migration failed`），不会当成空病例，也不会单独写审计告警。当前 `.pilotdeck-home` 下若无正式旧病例，实际迁移量可能为零。

---

## 9. 这样修掉了什么

| 原问题 | 是否消失 | 原因 |
|---|---|---|
| 血压抽成血氧 | 消失 | 只保留收缩压一项，无血氧栏 |
| 实体被译成英文代码 | 消失 | 无模型改写 |
| 机构落错栏 / 正则兜底 | 消失 | 机构由子级派生 |
| 否定旧伤被合成一条 | 消失 | 叙述后覆盖前 |
| `transport_mode` / `location` 抽了不合并 | 消失 | 归入后送条件叙述 |
| `turnKind` 误判导致空跑或丢事实 | 消失 | 无分类步骤 |
| 相对时间「大约14分钟前」解析失败 | 消失 | 去掉时效判断 |
| 提示词长、规则靠自然语言约束 | 大幅缓解 | 工位 A 提示词整体删除 |

剩下的风险改变了性质：不再是「模型抽错」，而是「用户描述不全」。这属于 `missingInformation` 和界面提示文案的问题，可以靠工位 B 明确追问，不会静默写错病历。

---

## 10. 已确认（实现时仍有效）

1. 级别单选不加「已进入Ⅲ/Ⅳ级」。范围闸门仍由工位 P 读叙述识别。
2. 对话栏改为只读时间线，展示每轮提交摘要与工位 B 主文；输入统一走表单。
3. 不设「沿用上一轮」；下游读体征历史。
4. 用户明示四个子级之一时，程序短路工位 P，直接 `user_stated`。
