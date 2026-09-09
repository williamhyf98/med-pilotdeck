# 战创伤推演：自由文本输入 + 工位 F 表单化

日期：2026-09-09
状态：设计稿，待评审

对照文档：

- `docs/trauma-form-input-design.md`（当前表单化方案，本稿在其基础上增量）
- `docs/trauma-turn-workflow.md`（当前 11 步实现）

---

## 1. 背景

当前战创伤推演的输入是结构化表单（`TraumaTurnForm.tsx`），用户逐栏填写伤情、处置、后送、补充说明与五项生命体征。诉求是改成与「通用医学」一致的自然语句输入框，由模型把整段话整理成同样这几个字段。

**这件事在本仓库有前科。** `docs/trauma-form-input-design.md` §1 记录了原「工位 A」（自由文本 → 结构化事实）被删除的原因，错误全部集中在槽位对齐：

- 「收缩压92」抽成 `spo2: 92%`
- 机构名落进 `careAndTransportFacts` 而非 `context.facility`
- 「没有开放伤，只是擦伤」被合成一条 confirmed 覆盖旧伤
- 实体被译成 `right_thigh` / `gunshot_wound`，跨轮无法比对
- `transport_mode`、`location` 抽出来却没合并进 state

本稿是对该决策的**部分回滚**，因此必须先回答「这次为什么不会再错」。

### 1.1 为什么这次风险低一个数量级

抽取目标已经完全不同：

| | 旧工位 A | 本稿工位 F |
|---|---|---|
| 目标结构 | 6 组结构化事实、实体 ID、certainty/status、`supersedesFactId`、相对时间、`turnKind` | `TurnFormInput` 的 6 个槽 |
| 模型要做的事 | 抽取 + 改写 + 归一化 + 冲突判定 + 分类 | **分桶 + 抄数字** |
| 错误后果 | 静默写错结构化病历，跨轮污染 | 见 §1.2 |

`TurnFormInput` 里四个字段本身就是自由文本，模型不需要理解、翻译或归一化——原文原样搬进对应的桶即可。且 `compactCaseStateForDownstream` 最终把四段一起交给工位 B，「某句话分到了补充说明而不是伤情描述」这类错对下游影响很小。

### 1.2 真正的风险面只有两处

1. **`vitals` 数值错位**——正是当年那个错。「心率 92」与「收缩压 92」互串、「血压 92/60」须只取收缩压、体温须一位小数。这是唯一会静默写错病历的字段。
2. **`statedSubStage` 误判**——它会短路工位 P（`runner.ts:241-250`，`source=user_stated` 直接采信），用户随口提一句「刚从营救护站过来」若被当成明示级别，等于用闲话劫持定级。

本稿对这两处分别用**用户确认**和**不交给模型**两条硬措施处理。

---

## 2. 目标与非目标

**目标**

- 战创伤主输入改为一句/一段自然语句。
- 模型把该文本整理成现有 `TurnFormInput` 的四段叙述 + 五项体征。
- 整理结果在进入推演流水线**之前**由用户确认，且可逐字段编辑。
- 结构化表单保留为折叠的「精确录入」入口。
- 封闭体征集由五项扩充为六项，新增 SpO₂（见 §5.4）。
- 推演流水线（校验、合并、工位 P / RAG / 工位 B / Gate、持久化）的步骤与语义**零改动**。

**非目标**

- 不改动 `CaseState` 结构、不改动合并规则、不改动任何下游提示词。
- 不让模型判断救治级别（见 §4.3）。
- 不做多轮对话式追问；一次输入产出一次草稿。
- 不恢复任何旧工位 A 的结构（实体 ID、certainty、supersedes 指针、相对时间解析、turnKind）。

---

## 3. 关键决策：确认卡放在提交前，而不是 runner 内部

初始设想是在 runner 里插入 `extract_form` + `confirm_form` 两步，复用落位确认卡走的 elicitation 通道。**探查后否决**：

`PilotDeckElicitationChannel.ts:17-45` 的问答契约是选项式的——每个问题是一组 `{label, description}`，答案是被选中的 label 字符串。它承载不了「4 段可编辑文本 + 5 个可编辑数值」的结构化表单，硬塞只能把 JSON 编进 `annotations.notes`，属于滥用。

改为：**新增一个纯函数式 RPC `trauma_extract_form`，在提交前调用；草稿渲染进现有 `TraumaTurnForm` 作为确认卡；用户确认后走现有 `submit_turn`。**

这样更好，而不只是妥协：

- `runner.ts` 的流程不动，仍是 11 步 / 6 步短路径，审计与快照语义不变（唯一改动是多透传一个 `rawInput` 字段，见 §7）。
- `InProcessGateway` 的 trauma 分支不改。
- 确认卡与「精确录入」面板**是同一个组件**——用户已确认要保留后者，两者复用零额外成本。
- 抽取失败的恢复动作就是「用户直接改」，不需要重试或降级逻辑。
- 抽取 RPC 无副作用（不读写 `CaseState`），可以随便重调。

代价：多一次前后端往返，抽取耗时不计入本轮推演的进度事件。可接受。

---

## 4. 交互流程

```
┌ 战创伤工作区 ────────────────────────────────┐
│ [ 自然语句输入框                          ]  │
│ 救治级别: (由系统判定 ▾)          [ 整理 ]   │
│ ▸ 精确录入（折叠，即现有 TraumaTurnForm）    │
└──────────────────────────────────────────────┘
        │ 点「整理」
        ▼
   trauma_extract_form(rawText)      ← 1 次模型调用，无副作用
        │
        ▼
┌ 确认卡（TraumaTurnForm，预填草稿）───────────┐
│ 原文：……（只读，供比对）                     │
│ 伤情描述  [ 预填，可改 ]                     │
│ 已做处置  [ 预填，可改 ]                     │
│ 后送条件  [ 预填，可改 ]                     │
│ 补充说明  [ 预填，可改 ]                     │
│ 心率 92 ⓘ「心率92次」  呼吸 __  收缩压 __ … │
│ 救治级别: (由系统判定 ▾)                     │
│                     [ 重新整理 ] [ 确认推演 ]│
└──────────────────────────────────────────────┘
        │ 点「确认推演」
        ▼
   submit_turn({ traumaForm, traumaRawInput })  ← 现有路径，11 步流水线
```

### 4.1 体征的原文出处

每个抽出的体征都带 `sourceSpan`（用户原文中的片段）。确认卡把它渲染成数值旁的小字或 tooltip。这是对 §1.2 风险 1 的直接措施：用户不需要重读整段话，只需扫五个「数值 ← 原文片段」的对照。

### 4.2 「重新整理」

用户改了输入框原文后可重新抽取，覆盖草稿。已手工编辑过的字段在覆盖前给出确认提示（避免手工修正被冲掉）。

### 4.3 救治级别不交给模型

`statedSubStage` 由用户的独立单选控件产出，默认「由系统判定」（`null`），走程序直传。工位 F 的输出 schema 里**根本不存在这个字段**，模型无法影响定级。这消除 §1.2 风险 2。

该控件在输入框旁和确认卡里各出现一次，绑同一份状态；用户在看到整理结果后仍可改级别，以确认卡提交时的值为准。

### 4.4 折叠的精确录入

不输入自然语句、直接展开精确录入填表提交的路径原样保留，行为与今天完全一致。

---

## 5. 工位 F 契约

新文件 `src/trauma/stations/extractor.ts` 与 `src/trauma/stations/extractorPrompt.ts`，范式照抄 `stations/placer.ts`。

### 5.1 输出类型与 schema

```ts
// src/trauma/types.ts 新增
export type ExtractedVitalItem = {
  key: VitalItemKey;
  value: number;
  /** 该数值在用户原文中的出处片段，供确认卡高亮。 */
  sourceSpan: string;
};

export type ExtractedTurnForm = {
  injuryNarrative: string;
  treatmentNarrative: string;
  evacuationNarrative: string;
  note: string;
  vitals: ExtractedVitalItem[];
};
```

`vitals` 用数组而非 `Partial<Record<...>>`：strict 模式要求 `required` 覆盖全部 `properties`，可选键只能表达为可空，用数组既避开该约束又能挂 `sourceSpan`。

`schemas.ts` 新增 `EXTRACTOR_OUTPUT_SCHEMA` 与 `validateExtractedTurnForm`，全部走现有 `object()` / `enumOf()` / `described()` 构造器，满足 strict 的三条约束（见 `schemas.ts:1-7` 的注释，以及 commit `7b81778` 踩过的 400）。

### 5.2 输入

```ts
{
  rawText: string,                                  // 用户原文
  caseHistory: compactCaseStateForDownstream(state) // 已有的压缩视图
}
```

带历史是为了让模型能理解「血压比刚才降了」「还是老样子」这类相对表述，把它们如实放进伤情叙述。**不允许**据此补写用户本轮没说的内容（见 §6 硬约束）。

### 5.3 程序侧后处理（`normalizeExtractedForm`，纯函数，可测）

模型输出 → `TurnFormInput` 草稿的确定性转换：

1. `vitals` 数组去重（同 key 取第一条），逐项按 `VITAL_RANGES`（`factMerge.ts:8-14`）校验范围与精度。
2. **越界或精度不合的项直接丢弃，并记入 `warnings`**，不抛错——工位 F 是建议性的，用户随后要确认，硬失败没有价值。
3. 叙述字段**不截断**。超长时交由 `TraumaTurnForm` 现有的 `validate()`（`TraumaTurnForm.tsx:92-118`）报错，用户自行删减。复用既有机制，不引入新规则。
4. 输出 `{ draft: Omit<TurnFormInput, "statedSubStage">, spans: Partial<Record<VitalItemKey, string>>, warnings: string[] }`。

### 5.4 封闭体征集扩充：新增 SpO₂

**保持封闭键集，不改成开放词表。** 开放词表会同时失去四样东西：`VITAL_RANGES` 的范围校验（键未知则无合法区间）、跨轮比对（模型这轮写 `血氧`、下轮写 `SpO2`，`latestByField` 与趋势卡静默失灵，正是 §1 那条「实体被译成 `right_thigh` 无法跨轮比对」的原病换到体征上）、趋势卡渲染、以及由键隐含的单位。其中跨轮退化最恶劣——它不报错，只是安静地降级，而确认卡上的人也核对不了「这轮该叫哪个词才能跟历史对上」，因为历史用词不在眼前。

改为按证据扩充封闭集，本次只加一项：

| 键 | 中文名 | 缩写 | 单位 | 范围 | 精度 | 依据 |
|---|---|---|---|---|---|---|
| `spo2` | 血氧饱和度 | SpO₂ | % | 0–100 | 整数 | `战伤分级救治智能推演系统-项目实施说明书.md:1369-1370` 把伤员状态写作「RR / SBP / HR / SpO₂ 均未测」并列入缺失信息，说明书本身即以 SpO₂ 为核心体征 |

不加舒张压、瞳孔、尿量、毛细血管再充盈：仓库文档中无任何依据，且每多一个槽位就扩大一分工位 F 的错位面（§1.2 风险 1）。定性指标（如 `war_trauma_hemorrhage_evacuation_synthesis.md:42` 的「桡动脉搏动可触及」）继续留在伤情叙述里，不做成体征槽。

**前端展示要求：** SpO₂ 必须同时显示中文名，渲染为「血氧饱和度（SpO₂）」。因此两处体征标签表由 `label: string` 改为 `{ label, abbr? }`，`abbr` 存在时按此格式拼接。现有五项 `abbr` 为空，展示不变。

**迁移：** 不需要。`values` 是稀疏字典，旧快照缺 `spo2` 键天然即「未测」。

**文档一致性：** `docs/trauma-form-input-design.md:72` 有一句「舒张压、SpO₂ 不进表单」，须同步改为「舒张压不进表单；SpO₂ 已于 2026-09-09 加入，依据见本次设计稿 §5.4」，否则两份文档打架。

---

## 6. 提示词设计（`extractorPrompt.ts`）

结构对齐 `placementPrompt.ts`：固定定义 + 判定顺序 + 输出约束 + 示例。

### 6.1 字段定义

| 字段 | 定义 | 归入的内容 |
|---|---|---|
| `injuryNarrative` | 伤员身上**发生了什么**、现在是什么状态 | 部位、伤类、发现、是否活动性出血、意识与外观描述、伤情变化与更正 |
| `treatmentNarrative` | **已经做了**什么 | 已实施的止血、通气、包扎、固定、给药、复苏等，含进度与效果 |
| `evacuationNarrative` | **往哪送、送得了吗** | 拟送目的地、运力与工具、道路天气敌情等限制、后送时机 |
| `note` | 以上三类都不属于的说明 | 兜底桶；无法判断归属时放这里，不要丢弃 |
| `vitals` | 本轮**实测**的六项数值 | 呼吸 / 收缩压 / GCS / 心率 / 体温 / 血氧饱和度 |

### 6.2 硬约束（提示词逐条写明）

1. **禁止改写。** 四段叙述必须由用户原文的句子构成，可以拆句、可以调整顺序、可以删除与该桶无关的句子；**不得改写措辞、不得归纳概括、不得翻译成术语或英文、不得补写用户没说的内容。**
2. **未提及即留空。** 用户没说的字段输出空串 `""`；没测的体征不出现在 `vitals` 数组里。**禁止从历史继承**——历史只用于理解相对表述，不得填进本轮。
3. **信息不丢。** 原文的每一句都必须落进四个桶之一；实在无法归类的放 `note`。
4. **体征只收实测数值。** 「血压 92/60」只取收缩压 92。定性描述（「血压偏低」「呼吸急促」）留在叙述里，不得折算成数字。「体温 38.5」保留一位小数。
5. `sourceSpan` 必须是原文中**真实存在的连续片段**，用于人工核对。
6. 不输出救治级别、机构、分类、后送 Gate、处置建议。用户提到的机构名照原样留在叙述里。

### 6.3 few-shot 示例

提示词内置 4 个示例，覆盖：

- **典型完整输入**：四桶齐全 + 3 项体征。
- **只有伤情、无体征**：验证「未提及即留空」，`vitals: []`，三段空串。
- **数值陷阱**：「血压 92/60，心率 120，血氧 88%，瞳孔等大」→ `systolicBloodPressure: 92`（只取收缩压）、`heartRate: 120`、`spo2: 88`；**舒张压 60 与瞳孔无对应槽位，所在语句原样留在伤情叙述里**，不得塞进任何体征键、不得折算。这条同时压住 §1 的历史错误（收缩压抽成血氧）与「无槽位就硬塞」的倾向。
- **更正型输入**：「上一轮说的开放伤不成立，实际只是擦伤」→ 原样进 `injuryNarrative`，不做任何冲突消解（覆盖语义由下游按轮次顺序处理，见 `docs/trauma-form-input-design.md` §4）。

### 6.4 模型参数

`temperature: 0`，走现有 `StructuredModelClient.completeJson`（`modelClient.ts:104-108`）。不用流式——抽取输出短，且没有 `naturalLanguageAnswer` 可流。

---

## 7. 后端改动清单

| 文件 | 改动 |
|---|---|
| `src/trauma/types.ts` | 新增 `ExtractedVitalItem`、`ExtractedTurnForm`；`CaseSnapshot` 新增可选 `rawInput?: string` |
| `src/trauma/schemas.ts` | 新增 `EXTRACTOR_OUTPUT_SCHEMA`、`validateExtractedTurnForm` |
| `src/trauma/stations/extractorPrompt.ts` | 新建 |
| `src/trauma/stations/extractor.ts` | 新建，导出 `createExtractionStation(model)` |
| `src/trauma/formDraft.ts` | 新建，导出纯函数 `normalizeExtractedForm` |
| `src/trauma/index.ts` | 导出上述 |
| `src/gateway/protocol/types.ts` | 新增 `GatewayExtractTraumaFormInput/Output`；`GatewaySubmitTurnInput` 新增可选 `traumaRawInput?: string` |
| `src/gateway/client/RemoteGateway.ts` | 新增 `extractTraumaForm` → RPC `"trauma_extract_form"` |
| `src/gateway/server/GatewayWsConnection.ts` | 新增 dispatch 分支，与 `trauma_get_case` 等并列 |
| `src/gateway/client/InProcessGateway.ts` | 实现 `extractTraumaForm`；`submit_turn` 分支把 `traumaRawInput` 传给 `recordTraumaTurn` 的 `userText`（替代 `summarizeTraumaForm`）与快照 |
| `src/cli/createLocalGateway.ts` | 抽取工位接入现有 structured model client |
| `src/trauma/runner.ts` | **只有一处**：`runTurn` 入参新增可选 `rawInput`，透传进快照 |
| `src/trauma/auditLog.ts` | 无需改动；抽取在 `trauma_extract_form` 内单独记一条 `extract_form` 审计 |

`factMerge.ts`、`placer.ts`、`reasoner.ts`、`rag/*`、`gate.ts`、`store.ts` **不改**（`rawInput` 是 `CaseSnapshot` 上的可选字段，旧快照读到 `undefined` 即可，无需迁移逻辑）。

### 7.1 服务端桥接

`ui/server/pilotdeck-bridge.js` 新增 `trauma_extract_form` 转发。`sanitizeTraumaFormInput`（`:1155-1203`）**保持不放宽**——`submit_turn` 仍然只接受完整合法的 `traumaForm`，自由文本永远不会绕过校验直达流水线。这是本设计能保住确定性的关键。

---

## 8. 前端改动清单

| 文件 | 改动 |
|---|---|
| `ui/src/components/trauma-workspace/TraumaComposer.tsx` | 新建：textarea + 级别单选 + 「整理」按钮 + loading/错误态 |
| `ui/src/components/trauma-workspace/TraumaTurnForm.tsx` | 新增 `initialValues`、`vitalSpans`、`sourceText`、`mode: "manual" \| "confirm"` 四个可选 prop；确认态下顶部显示只读原文、体征旁显示 span、按钮文案改为「确认推演」+「重新整理」。救治级别 select 已存在（`:86-90`），确认态直接沿用，无需新增控件 |
| `ui/src/components/trauma-workspace/TraumaWorkspace.tsx` | 组合 composer / 确认卡 / 折叠精确录入的状态机 |
| `ui/src/components/main-content/view/MainContent.tsx` | `submitTraumaForm` 的 `command` 改用原文（`:205-241`）；新增 `extractTraumaForm` 调用 |
| `ui/src/components/chat/utils/sessionLauncher.ts` | `options` 透传 `traumaRawInput` |

**`hideComposer` 保持 `true`。** 不去解开 `MainContent.tsx:956` 的绑定、不复用 `ComposerV2` —— 自由文本框做成 `TraumaWorkspace` 内的专用组件。理由：`useChatComposerState` 带着 busy 队列、中断、附件等整套逻辑，而 trauma 的输入语义是「调一个无副作用的 RPC 拿草稿」，两者不是一回事，混用会把 trauma 绑在通用 chat 的状态机上。

### 8.1 三个界面状态

- `idle` — 只有输入框 + 折叠的精确录入。
- `extracting` — 「整理」按钮转圈，输入框只读。
- `confirming` — 确认卡展开；「重新整理」回到 `idle` 并保留原文；「确认推演」提交后回到 `idle` 并清空。

---

## 9. 错误与降级

| 情况 | 行为 |
|---|---|
| 模型调用失败 / schema 校验失败 | 确认卡不出现，输入框下方报「整理失败，可重试或直接使用精确录入」，**同时自动展开精确录入面板并把原文放进伤情描述**。用户永远有一条能走通的路。 |
| 抽取结果四段全空且无体征 | 视同失败，同上处理（此时 `validateTurnFormInput` 本来也会拒绝）。 |
| 体征越界 / 精度不合 | 该项丢弃，确认卡顶部黄色提示列出被丢弃项与原文片段。 |
| 叙述超长 | 草稿照填，`TraumaTurnForm` 现有校验拦住提交，用户删减。 |
| 用户不看直接点确认 | 允许。风险由 §6 的「禁止改写」+ 体征 span 展示承担；这是产品取舍，不加二次确认。 |

---

## 10. 测试计划

**新增**

- `tests/trauma/extractor.spec.ts` — 用 stub `StructuredModelClient`：schema 校验通过/失败、system prompt 含硬约束、输入 payload 结构。
- `tests/trauma/formDraft.spec.ts` — `normalizeExtractedForm` 纯函数：去重、越界丢弃并进 warnings、精度校验、体温一位小数、空数组、spans 映射。
- `tests/trauma/extractorCases.spec.ts` — 语料回归：一张 `{rawText, 模型返回, 期望草稿}` 的 fixture 表，锁住后处理行为（含 §6.3 的血氧陷阱与更正型输入）。
- `ui` 侧：`TraumaTurnForm` 的 `confirm` 模式渲染（预填、span、按钮）与「重新整理」覆盖提示。

**必须保持全绿且不修改**

- `tests/trauma/factMerge.spec.ts`、`tests/trauma/runner.spec.ts`、`tests/trauma/schemas.spec.ts`、`tests/trauma/store.spec.ts`。这些不改动就是「下游零改动」的证明。

**人工验收**

抽取质量无法靠单测保证。落地前用 ≥20 条真实语料跑一遍真实模型，逐条核对：体征零错位、叙述零改写、信息零丢失。任何一条体征错位都要回头改提示词或加 few-shot。

---

## 11. 考虑过但不做（YAGNI）

- **程序侧「是否改写」自动检测**——已决定不做（§12.1）。靠确认卡并列展示原文由人核对。
- **抽取结果直接进流水线、不确认**——即前述方案 B。已否决：`vitals` 错位会静默写错病历。
- **抽取器兼判救治级别**——见 §4.3。
- **多轮追问式补全**——工位 B 的 `missingInformation` 已经承担追问职责，不在输入端重复。
- **`unmapped` 字段**——`note` 已是兜底桶。
- **抽取结果缓存**——一次调用很便宜，重复调用无副作用。

---

## 12. 已决事项

1. **不加程序侧的「改写检测」。** 靠确认卡并列展示原文由人核对。若人工验收（§10）发现改写现象，再回头改提示词或补 few-shot，而不是加检测代码。
2. **确认卡里也放一份救治级别控件。** 用户看到整理结果后可直接改级别，不必退回 `idle`。两处控件绑同一份状态，以确认卡提交时的值为准。
3. **`traumaRawInput` 写进 `CaseSnapshot`。** 作为可选字段新增，对旧快照向后兼容（`store.load()` 读到没有该字段的旧快照时按 `undefined` 处理，不触发迁移报错）。审计与回放能看到用户原话，快照体积的增加可接受。
4. **SpO₂ 加入封闭体征集。** 键 `spo2`，范围 0–100，整数，单位 %，前端展示「血氧饱和度（SpO₂）」。依据与设计见 §5.4。不加其余项（无仓库文档依据，且每多一个槽位就扩大工位 F 的错位面）。
