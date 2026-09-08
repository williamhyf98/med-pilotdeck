# 战创伤回合编排器实现计划

> **给执行代理：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans，按任务逐步实现。步骤用复选框（`- [ ]`）跟踪。

**目标：** 把战创伤工作台从纯演示换成按 `war_trauma` 路由的 `TraumaTurnRunner`：抽取事实、按预算检索、产出结构化回合结果，只有用户确认或带审计的人工覆盖后才改阶段。

**架构：** 继续使用现有会话记录和 MCP RAG 通道。在 `AgentSession.submit` 之前拦截 `war_trauma` 回合，走确定性 17 步编排，把 Case State 落到 `$PILOT_HOME/memory/trauma_med/<projectId>/cases/<sessionId>/`，再发出普通助手消息（必要时附带 `ask_user_question` 卡片）。模型只占用三个注入工位（A/R/B），用 JSON Schema 返回，不得自行调工具。

**技术栈：** TypeScript、Node 22、后端 `node:test`、前端 Vitest/jsdom、现有 MCP `mcp__med-tools__med_trauma_rag_query`、现有 `ask_user_question` 渲染。

**说明书：** `docs/战伤分级救治智能推演系统-项目实施说明书.md`（V2.2）。执行时必须同时阅读说明书和本计划。冲突时以说明书为准，但本计划写明的「第一期前端已落地」事实除外。

## 全局约束

- 项目类型 `war_trauma` 落在 `trauma_med`；`general_medicine` 落在 `general_med`。两套枚举不得混用。
- 整套推演**不是** Skill，也**不是**通用工作流引擎。
- 只有有效病例回合才跑完整流程：`case_update`、`correction`、`question`。`no_case_update`、确认、人工覆盖和纯界面操作不检索。
- RAG：第一波固定并行 3 次；第二波可选 1–3 次；合计 3–6 次；最多两波；全部 chunk 落盘；向模型注入 10–15 条。
- Gate 是混合判断：工位 B 产出 `ClinicalGateAssessment`；`resolveGate` 施加安全约束。时效永远不是硬性 Gate。
- `runTurn` 不得阻塞等待用户。READY 只写 `pendingTransition` 并发出确认。只有 `confirmTransition` / `overrideStage` 才能改 `currentStage`。
- 确认和覆盖事件使 `CaseState.version` 加一并写 Snapshot，但**不追加**纪要叶子。
- 人工覆盖可跳到固定全序中的任意**后续**子级；`BLOCKED` 必须二次确认；不得伪造机构或能力。
- 第一期演示 UI 已经存在。在真实链路接通且测试通过前，不要删除 `DemoTranscript`。第二期用真实会话/快照替换左侧演示，而不是直接拆掉回放。
- 后端测试：`npm test`（先编译，再对 `dist/tests/**/*.spec.js` 跑 `node --test`）。前端测试：`cd ui && npm test`。
- 不要提交密钥或 `.pilotdeck-home` 里的对话日志。

---

## 文件地图

新建：

```text
src/trauma/
  types.ts                 # 说明书第 6 章类型（唯一真相源）
  stageConfig.ts           # Ⅰ–Ⅳ / 8 个子级 / 后续阶段全序
  timeline.ts             # 伤后分钟数 + 软时限
  stageResolver.ts        # 由状态和机构映射当前主级/子级
  nodeStatus.ts           # NodeStatus 推导
  factMerge.ts            # 把 ExtractedTurnFacts 合并进 CaseState
  schemas.ts              # 工位 A/R/B 的 JSON Schema
  modelClient.ts          # StructuredModelClient 接口
  rag/queryPlan.ts        # 由 CaseState 生成三条保底 query
  rag/client.ts           # 封装 MCP 的 TraumaRagClient
  rag/merge.ts            # 去重、重排选择、覆盖缺口
  stations/extractor.ts  # 工位 A
  stations/planner.ts    # 工位 R
  stations/reasoner.ts   # 工位 B
  gate.ts                 # resolveGate
  store.ts                # current.json + snapshots.jsonl
  runner.ts               # runTurn / confirmTransition / overrideStage
  events.ts               # 把 runner 输出映射为会话/网关事件
  index.ts

tests/trauma/
  stageConfig.spec.ts
  timeline.spec.ts
  factMerge.spec.ts
  extractor.spec.ts
  queryPlan.spec.ts
  ragMerge.spec.ts
  gate.spec.ts
  store.spec.ts
  runner.spec.ts
  routing.spec.ts

ui/src/components/trauma-workspace/
  domain/types.ts          # 把后端契约适配给前端
  domain/stageConfig.ts
  domain/nodeStatus.ts
  domain/patientStateView.ts
  store/useCaseStore.ts
  detail/StageOverrideDialog.tsx
```

修改：

- `src/pilot/paths.ts` — 增加 `resolveTraumaCaseDir(projectId, sessionId, pilotHome)`
- `src/gateway/client/InProcessGateway.ts` — 把 `war_trauma` 提示词路由到 runner
- `ui/src/components/main-content/view/MainContent.tsx` — 第二期把真实对话传入 `TraumaWorkspace`
- `ui/src/components/trauma-workspace/TraumaWorkspace.tsx` — 有快照用快照，否则用演示
- `ui/src/components/trauma-workspace/TreatmentTree.tsx` — 后续阶段覆盖按钮（主级/子级节点仍不可点）
- `ui/src/components/trauma-workspace/types.ts` — 对齐说明书枚举（用 `battlefield_first_aid`，不用 `initial`）
- `docs/战伤分级救治智能推演系统-项目实施说明书.md` — 仅当实现中发现必须改说明书时才改，否则不动

**不要**创建 `plugins/med-tools/skills/med-trauma-case-advance/`。

---

### 任务 1：领域类型与阶段全序

**文件：**
- 新建：`src/trauma/types.ts`
- 新建：`src/trauma/stageConfig.ts`
- 新建：`src/trauma/nodeStatus.ts`
- 测试：`tests/trauma/stageConfig.spec.ts`

**接口：**
- 消费：无
- 产出：`MainStage`、`SubStage`、`SUBSTAGE_ORDER`、`isLaterSubStage()`、`deriveNodeStatus()`、`initialCaseState()`

- [ ] **步骤 1：写失败测试**

```ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBSTAGE_ORDER,
  isLaterSubStage,
  deriveNodeStatus,
} from "../../src/trauma/stageConfig.js";
import type { CaseState } from "../../src/trauma/types.js";

test("later-stage order matches the spec", () => {
  assert.deepEqual(SUBSTAGE_ORDER, [
    "primary_first_aid",
    "advanced_first_aid",
    "emergency_treatment",
    "surgical_resuscitation",
  ]);
  assert.equal(isLaterSubStage("primary_first_aid", "advanced_first_aid"), true);
  assert.equal(isLaterSubStage("emergency_treatment", "primary_first_aid"), false);
  assert.equal(isLaterSubStage("primary_first_aid", "primary_first_aid"), false);
});

test("node status follows current stage plus gate", () => {
  const base = {
    currentSubStage: "primary_first_aid",
    transport: { gateStatus: "ASSESSING" },
    pendingTransition: undefined,
  } as Pick<CaseState, "currentSubStage" | "transport" | "pendingTransition">;
  assert.equal(deriveNodeStatus(base, "primary_first_aid"), "current");
  assert.equal(deriveNodeStatus({
    ...base,
    transport: { gateStatus: "BLOCKED" },
  } as typeof base, "primary_first_aid"), "blocked");
  assert.equal(deriveNodeStatus({
    ...base,
    transport: { gateStatus: "READY" },
    pendingTransition: { askedAt: "t", targetStage: "battlefield_first_aid", targetSubStage: "advanced_first_aid", reason: "x" },
  } as typeof base, "primary_first_aid"), "transfer_preparing");
  assert.equal(deriveNodeStatus(base, "advanced_first_aid"), "not_started");
  assert.equal(deriveNodeStatus({
    ...base,
    currentSubStage: "advanced_first_aid",
  } as typeof base, "primary_first_aid"), "completed");
});
```

- [ ] **步骤 2：跑测试，确认失败**

命令：`npm run build && node --test --test-force-exit dist/tests/trauma/stageConfig.spec.js`

预期：失败，因为还没有 `src/trauma/stageConfig.ts`。

- [ ] **步骤 3：写类型和阶段配置**

把说明书 V2.2 第 6 章的 TypeScript 契约抄进 `src/trauma/types.ts`（`MainStage`、`SubStage`、`NodeStatus`、`VitalSigns`、`InjuryFinding`、`ClassificationRecord`、`TransportState`、`TimelineState`、`EvidenceChunk`、`RetrievalTrace`、`TreatmentAction`、`ExtractedTurnFacts`、`RoundMemo`、`PatientStateView`、`ClinicalGateAssessment`、`StageTransitionConfirmation`、`ManualStageOverride`、`CaseState`、`CaseSnapshot`、`AgentTurnResponse`）。名称必须与说明书一致。

在 `stageConfig.ts`：

```ts
export const SUBSTAGE_ORDER = [ /* four supported substages */ ] as const;
export const SUBSTAGE_TO_MAIN: Record<SubStage, MainStage> = {
  primary_first_aid: "battlefield_first_aid",
  advanced_first_aid: "battlefield_first_aid",
  emergency_treatment: "early_treatment",
  surgical_resuscitation: "early_treatment",
};
export function isLaterSubStage(from: SubStage, to: SubStage): boolean {
  return SUBSTAGE_ORDER.indexOf(to) > SUBSTAGE_ORDER.indexOf(from);
}
export function deriveNodeStatus(
  state: Pick<CaseState, "currentSubStage" | "transport" | "pendingTransition">,
  node: SubStage,
): NodeStatus {
  const current = SUBSTAGE_ORDER.indexOf(state.currentSubStage);
  const index = SUBSTAGE_ORDER.indexOf(node);
  if (index < current) return "completed";
  if (index > current) return "not_started";
  if (state.transport.gateStatus === "BLOCKED") return "blocked";
  if (state.transport.gateStatus === "READY" && state.pendingTransition) return "transfer_preparing";
  return "current";
}
```

机构默认：地点不明 → 连抢救组 / `primary_first_aid`。营救护站 → `advanced_first_aid`。旅（团）救护所 → `emergency_treatment`。不得根据生命体征自动升级。

- [ ] **步骤 4：跑测试，确认通过**

命令：`npm run build && node --test --test-force-exit dist/tests/trauma/stageConfig.spec.js`

预期：通过

- [ ] **步骤 5：提交**

```bash
git add src/trauma/types.ts src/trauma/stageConfig.ts src/trauma/nodeStatus.ts tests/trauma/stageConfig.spec.ts
git commit -m "$(cat <<'EOF'
增加战创伤阶段全序与节点状态推导。

EOF
)"
```

---

### 任务 2：时效计算与事实合并

**文件：**
- 新建：`src/trauma/timeline.ts`
- 新建：`src/trauma/factMerge.ts`
- 测试：`tests/trauma/timeline.spec.ts`
- 测试：`tests/trauma/factMerge.spec.ts`

**接口：**
- 消费：`CaseState`、`ExtractedTurnFacts`、`VitalSigns`
- 产出：`computeTimeline(state, now): TimelineState`、`mergeExtractedFacts(prev, facts, now): CaseState`

- [ ] **步骤 1：写失败测试**

```ts
test("timing is a soft window and never a hard gate", () => {
  const timeline = computeTimeline({
    injuryTime: "2026-09-03T14:55:00+08:00",
    now: "2026-09-03T15:09:00+08:00",
    currentSubStage: "primary_first_aid",
  });
  assert.equal(timeline.elapsedMinutes, 14);
  assert.equal(timeline.recommendedWindowMinutes, 10);
  assert.equal(timeline.timingStatus, "exceeded");
  assert.equal(timeline.isHardGate, false);
});

test("merge appends vitals and applies corrections without changing stage", () => {
  const next = mergeExtractedFacts(prev, extracted, "2026-09-03T15:09:00+08:00");
  assert.equal(next.currentSubStage, prev.currentSubStage);
  assert.equal(next.version, prev.version); // 候选状态；版本由 runner 稍后加一
  assert.equal(next.vitalSignsHistory.length, prev.vitalSignsHistory.length + 1);
  assert.equal(next.injuries.find((i) => i.id === "inj-leg")?.status, "controlled");
});

test("extractor cannot write currentStage through merge", () => {
  const tainted = { ...extracted, forbiddenStage: "early_treatment" };
  const next = mergeExtractedFacts(prev, tainted as ExtractedTurnFacts, now);
  assert.equal(next.currentStage, prev.currentStage);
});
```

时限来自说明书 §3.4：初级急救 10 分钟，高级急救 60 分钟，早期救治 180 分钟。专科治疗（Ⅲ级）和康复治疗（Ⅳ级）不进入本系统的阶段枚举、时限计算或流程树，只允许作为超范围建议名称出现。

合并规则：
- 体征只追加，不覆盖历史。
- 伤情按 `id` 或 `(bodyPart + finding)` 匹配；`excluded` 是新的确定性，不是删除。
- `supersedesFactId` 记录更正。给 `CaseState` 增加 `conflictingFactIds: string[]`（说明书目前只写在抽取输出上），把未解决冲突 id 抄过去。不得静默覆盖旧发现。
- 丢弃未知字段。
- `turnKind === "no_case_update"` 由 runner 处理，不在 merge 里处理。

- [ ] **步骤 2：跑测试，确认失败**

命令：`npm run build && node --test --test-force-exit dist/tests/trauma/timeline.spec.js dist/tests/trauma/factMerge.spec.js`

预期：失败（模块不存在）

- [ ] **步骤 3：实现时效与合并**

`computeTimeline` 使用状态里的 `injuryTime`（首次已知事件时间）和 `now`。若没有 `injuryTime`，则 `elapsedMinutes = 0`，`timingStatus = "within_window"`。

- [ ] **步骤 4：跑测试，确认通过**

命令：同上。预期：通过

- [ ] **步骤 5：提交**

```bash
git add src/trauma/timeline.ts src/trauma/factMerge.ts tests/trauma/timeline.spec.ts tests/trauma/factMerge.spec.ts
git commit -m "$(cat <<'EOF'
增加战创伤时效窗口与候选状态事实合并。

EOF
)"
```

---

### 任务 3：病例存储

**文件：**
- 修改：`src/pilot/paths.ts`
- 新建：`src/trauma/store.ts`
- 测试：`tests/trauma/store.spec.ts`

**接口：**
- 消费：`CaseState`、`CaseSnapshot`
- 产出：

```ts
export function resolveTraumaCaseDir(projectId: string, sessionId: string, pilotHome: string): string
export type TraumaCaseStore = {
  load(): Promise<CaseState | null>;
  saveTurn(state: CaseState, snapshot: CaseSnapshot): Promise<void>;
}
export function createTraumaCaseStore(dir: string): TraumaCaseStore
```

路径：`$PILOT_HOME/memory/trauma_med/<projectId>/cases/<sessionId>/current.json` 和 `snapshots.jsonl`。

- [ ] **步骤 1：用 `mkdtemp` 写失败测试。** 断言：
  - `general_med-*` 项目 id 调用 `resolveTraumaCaseDir` 会抛错
  - 首次 `load` 返回 `null`
  - `saveTurn` 写出两个文件
  - 再次加载等于已保存状态
  - 第二次 snapshot 追加一行 jsonl
  - snapshots 写入失败时，不得留下更新过的 `current.json`（先写 snapshots 再写 current，或写临时文件再 rename）

- [ ] **步骤 2：跑测试，确认失败**

命令：`npm run build && node --test --test-force-exit dist/tests/trauma/store.spec.js`

- [ ] **步骤 3：实现**

`current.json` 用 `fs.promises` 的 `writeFile` + `rename` 做原子替换。snapshot JSON 序列化后再 `appendFile`。目录用 `recursive: true` 创建。

文件系统里把 `sessionId` 的 `:` 换成 `_`，但 `CaseState.sessionId` 仍保存原始 id。

- [ ] **步骤 4：测试通过**

- [ ] **步骤 5：提交**

```bash
git add src/pilot/paths.ts src/trauma/store.ts tests/trauma/store.spec.ts
git commit -m "$(cat <<'EOF'
把战创伤病例快照落到 trauma_med 记忆目录。

EOF
)"
```

---

### 任务 4：结构化模型客户端与工位 A

**文件：**
- 新建：`src/trauma/modelClient.ts`
- 新建：`src/trauma/schemas.ts`
- 新建：`src/trauma/stations/extractor.ts`
- 测试：`tests/trauma/extractor.spec.ts`

**接口：**
- 消费：经注入客户端发出的 `CanonicalModelRequest`
- 产出：

```ts
export type StructuredModelClient = {
  completeJson<T>(input: {
    name: string;
    system: string;
    user: string;
    schema: Record<string, unknown>;
    validate: (value: unknown) => value is T;
  }): Promise<T>;
};

export function createExtractorStation(model: StructuredModelClient): {
  extract(input: {
    userText: string;
    previous: CaseState;
    attachmentSummary?: string;
  }): Promise<ExtractedTurnFacts>;
}
```

- [ ] **步骤 1：用假客户端写失败测试**

```ts
test("extractor returns six core groups and no gate fields", async () => {
  const facts = await extract({ userText: "收缩压95，心率120", previous });
  assert.ok(Array.isArray(facts.vitalSigns));
  assert.equal("gate" in facts, false);
  assert.equal(facts.turnKind, "case_update");
});

test("no_case_update is a valid turnKind", async () => {
  const facts = await extract({ userText: "你好", previous });
  assert.equal(facts.turnKind, "no_case_update");
});

test("rejects extractor output that includes currentStage", async () => {
  fake.completeJson = async () => ({ turnKind: "case_update", currentStage: "early_treatment" });
  await assert.rejects(() => extract({ userText: "x", previous }), /schema/i);
});
```

工位 A 的 prompt 必须禁止诊断、趋势、治疗方案、Gate 和阶段变化。上下文只给本轮用户原文 + 压缩后的上一版状态（伤情、最近体征、机构、阶段）。

`validateExtractedTurnFacts` 检查六组核心字段存在、`turnKind` 枚举合法、每条事实都有 `sourceQuote` / `certainty` / `confidence`。

- [ ] **步骤 2：确认失败**

- [ ] **步骤 3：实现抽取器与 JSON Schema**

真实客户端（稍后给 runner 用）包装 `src/model/streaming/streamModel.ts` 的 `complete()`，并设置 `outputSchema`。测试不得访问网络。

- [ ] **步骤 4：确认通过**

- [ ] **步骤 5：提交**

```bash
git add src/trauma/modelClient.ts src/trauma/schemas.ts src/trauma/stations/extractor.ts tests/trauma/extractor.spec.ts
git commit -m "$(cat <<'EOF'
增加带 Schema 校验的战创伤事实抽取工位。

EOF
)"
```

---

### 任务 5：保底 RAG 计划与 chunk 合并

**文件：**
- 新建：`src/trauma/rag/queryPlan.ts`
- 新建：`src/trauma/rag/client.ts`
- 新建：`src/trauma/rag/merge.ts`
- 测试：`tests/trauma/queryPlan.spec.ts`
- 测试：`tests/trauma/ragMerge.spec.ts`

**接口：**

```ts
export type RagQueryKind = "stage" | "classification_transport" | "primary_injury" | "supplemental";
export type PlannedRagQuery = {
  wave: 1 | 2;
  kind: RagQueryKind;
  query: string;
  reason: string;
  critical: boolean;
};

export function buildBaselineQueries(state: CaseState): PlannedRagQuery[] // 长度 3，wave 1，critical true

export type TraumaRagHit = {
  chunk_id: string;
  text: string;
  score: number;
  doc_id?: string;
  title?: string;
  article?: string;
  retrieval_backend: "remote" | "local";
};

export type TraumaRagClient = {
  query(input: { query: string; top_k: number }): Promise<{
    retrieval_backend: "remote" | "local";
    chunks: TraumaRagHit[];
  }>;
};

export function mergeRetrieval(input: {
  queries: PlannedRagQuery[];
  results: Array<{ query: PlannedRagQuery; chunks: TraumaRagHit[]; backend: "remote" | "local" }>;
}): { evidence: EvidenceChunk[]; retrieval: RetrievalTrace; promptChunks: EvidenceChunk[] }
```

- [ ] **步骤 1：写失败测试**

```ts
test("baseline plan is exactly three critical wave-1 queries", () => {
  const plan = buildBaselineQueries(stateAtPrimaryAid);
  assert.equal(plan.length, 3);
  assert.ok(plan.every((q) => q.wave === 1 && q.critical));
  assert.deepEqual(plan.map((q) => q.kind), [
    "stage",
    "classification_transport",
    "primary_injury",
  ]);
});

test("merge stores all chunks and selects at most 15 for the prompt", () => {
  const merged = mergeRetrieval({ queries, results: twentyFiveHits });
  assert.equal(merged.evidence.length, 25);
  assert.ok(merged.promptChunks.length <= 15);
  assert.ok(merged.promptChunks.length >= 10 || merged.retrieval.criticalCoverageGaps.length > 0);
  assert.ok(merged.evidence.every((c) => typeof c.selectedForPrompt === "boolean"));
});

test("missing primary_injury hits become a coverage gap", () => {
  const merged = mergeRetrieval({ queries, results: onlyStageAndTriage });
  assert.ok(merged.retrieval.criticalCoverageGaps.includes("primary_injury"));
});
```

`top_k` 为 8。按 `chunk_id` 去重。按返回的 `score` 降序排序（不要把 remote 与 local 的分数放进同一标尺比较：按后端分桶，混合时先取 remote 再取 local）。`coverageTags` 来自检索到该 chunk 的 query（同一 chunk 被两次检索到可以有多个 tag）。

合并时 `usedInAnswer` 为 false；工位 B / runner 稍后根据引用 id 标记。

- [ ] **步骤 2：确认失败**

- [ ] **步骤 3：实现计划与合并。** `client.ts` 映射 MCP JSON：

```ts
export function createMcpTraumaRagClient(callTool: (name: string, input: unknown) => Promise<unknown>): TraumaRagClient {
  return {
    async query({ query, top_k }) {
      const raw = await callTool("mcp__med-tools__med_trauma_rag_query", { query, top_k });
      const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
      return normalizeRagPayload(payload);
    },
  };
}
```

不要加细粒度 Metadata Filter。

- [ ] **步骤 4：确认通过**

- [ ] **步骤 5：提交**

```bash
git add src/trauma/rag tests/trauma/queryPlan.spec.ts tests/trauma/ragMerge.spec.ts
git commit -m "$(cat <<'EOF'
增加战创伤保底检索查询与证据合并。

EOF
)"
```

---

### 任务 6：工位 R 与 Gate 判定

**文件：**
- 新建：`src/trauma/stations/planner.ts`
- 新建：`src/trauma/gate.ts`
- 测试：`tests/trauma/gate.spec.ts`
- 测试：`tests/trauma/planner.spec.ts`

**接口：**

```ts
export function createPlannerStation(model: StructuredModelClient): {
  plan(input: {
    state: CaseState;
    firstWave: RetrievalTrace;
    remainingBudget: number; // 0–3
  }): Promise<PlannedRagQuery[]>;
}

export function resolveGate(
  assessment: ClinicalGateAssessment,
  retrieval: RetrievalTrace,
): "ASSESSING" | "STAY" | "BLOCKED" | "READY"
```

- [ ] **步骤 1：写失败测试**

规划工位：
- remainingBudget 为 0 → 不调用模型，返回 `[]`
- 模型返回 4 条 query → 截成 3 条
- 与第一波重复的 query 丢弃
- 补充项的 `kind` 为 `supplemental`，`wave` 为 2
- 除非模型标明，`critical` 默认为 false

Gate（按说明书逻辑）：
- 即使超时，只要 `needHigherCapability === false` 仍为 STAY
- `needHigherCapability true` 且 `transportReadiness not_ready` → BLOCKED
- 优先级 urgent 且 `not_ready` → BLOCKED
- 未解决冲突 → ASSESSING
- `evidenceChunkIds` 为空 → ASSESSING
- `criticalCoverageGaps.length > 0` → ASSESSING
- 置信度 `< 0.75` → ASSESSING
- READY 要求 targetStage、targetSubStage、requiredCapabilities 非空，且 readiness 为 ready
- 模型不得输出 COMPLETED

- [ ] **步骤 2：确认失败**

- [ ] **步骤 3：按说明书 §8.1 原样实现 `resolveGate`。** 不稳定指标单独出现不足以 BLOCK，除非进入 `blockingFactors`，或 readiness 为 `not_ready`。

- [ ] **步骤 4：确认通过**

- [ ] **步骤 5：提交**

```bash
git add src/trauma/stations/planner.ts src/trauma/gate.ts tests/trauma/gate.spec.ts tests/trauma/planner.spec.ts
git commit -m "$(cat <<'EOF'
增加检索规划工位与混合 Gate 判定。

EOF
)"
```

---

### 任务 7：工位 B

**文件：**
- 新建：`src/trauma/stations/reasoner.ts`
- 新建：`src/trauma/stations/reasonerPrompt.ts`
- 测试：`tests/trauma/reasoner.spec.ts`

**接口：**

```ts
export function createReasonerStation(model: StructuredModelClient): {
  reason(input: {
    state: CaseState;
    timeline: TimelineState;
    promptChunks: EvidenceChunk[];
  }): Promise<Pick<AgentTurnResponse, "naturalLanguageAnswer" | "classification" | "treatmentPlan" | "missingInformation" | "transition" | "gateAssessment" | "memo">>;
}
```

- [ ] **步骤 1：写失败测试**

- `current_stage` 行动引用未知 chunk id → 拒绝
- `胸腔穿刺减压` 标成 `current_stage` 且当前是 `primary_first_aid` 时，改写为 `next_stage` 并打标，回合仍能完成
- memo 超过 30/40 字 → schema 失败
- `transition.status` 不能是 `COMPLETED`
- 仅当建议状态为 READY 时，`requiresUserConfirmation` 必须为 true（这是工位 B 的建议，不是最终写入）

Prompt 文本：把说明书 §7.7 约束 1–12 抄进 `reasonerPrompt.ts`。

- [ ] **步骤 2：确认失败**

- [ ] **步骤 3：实现校验器：**
  1. 按 schema 解析 JSON
  2. `evidenceChunkIds` 必须落在本轮注入的 prompt chunk 中（未知 id → schema 错误）
  3. 能力白名单：初级急救的 `current_stage` 只能是止血/通气/包扎/固定/搬运/心肺复苏/检伤评估/监测。其他内容若标成 `current_stage`，改写为 `next_stage` 并设 `professionalConfirmationRequired = true`

- [ ] **步骤 4：确认通过**

- [ ] **步骤 5：提交**

```bash
git add src/trauma/stations/reasoner.ts src/trauma/stations/reasonerPrompt.ts tests/trauma/reasoner.spec.ts
git commit -m "$(cat <<'EOF'
增加带证据与能力校验的战创伤研判工位。

EOF
)"
```

---

### 任务 8：TraumaTurnRunner.runTurn

**文件：**
- 新建：`src/trauma/runner.ts`
- 测试：`tests/trauma/runner.spec.ts`

**接口：**

```ts
export type TraumaTurnInput = {
  projectId: string;
  sessionId: string;
  messageId: string;
  userText: string;
  now: string;
  attachmentSummary?: string;
};

export type TraumaTurnRunner = {
  runTurn(input: TraumaTurnInput): Promise<AgentTurnResponse>;
  confirmTransition(input: TransitionConfirmationInput): Promise<CaseSnapshot>;
  overrideStage(input: ManualStageOverrideInput): Promise<CaseSnapshot>;
};

export function createTraumaTurnRunner(deps: {
  store: TraumaCaseStore;
  model: StructuredModelClient;
  rag: TraumaRagClient;
  now?: () => string;
}): TraumaTurnRunner
```

- [ ] **步骤 1：用假依赖写失败的编排测试**

用例：
1. 类似 R2 的主路径：抽取器返回体征；3 次 RAG；规划工位无补充；研判 READY；`currentStage` 不变；写入 `pendingTransition`；追加 memo；snapshot 的 `eventType` 为 `agent_turn`；`round` 加一。
2. `turnKind === "no_case_update"`：从不调用 rag.query；不调用 store.saveTurn；仍返回简短 `naturalLanguageAnswer`；没有 `stage.changed` 字段。
3. 规划工位返回 2 条补充 query → rag.query 共 5 次，绝不是 7 次。
4. 任一工位抛错 → 旧的 current.json 不变。
5. READY 的同一回合不追加第二枚叶子。

假 RAG 记录调用次数。假模型按 `name` 分流：`trauma_extract`、`trauma_plan`、`trauma_reason`。

- [ ] **步骤 2：确认失败**

- [ ] **步骤 3：按说明书顺序实现 `runTurn`：**

1. 加载或 `initialCaseState()`
2. 抽取
3. 若 `no_case_update` 则提前返回
4. 合并候选状态
5. 从**已有** currentStage 解析机构/阶段（不要推断升级）
6. 计算时效
7. `Promise.all` 执行 3 条保底 query
8. 规划工位
9. 若有补充 query 则跑第二波
10. mergeRetrieval
11. 研判工位
12. resolveGate(assessment, retrieval) **覆盖** `transition.status`
13. 若 READY，写入 `pendingTransition` 并设 `requiresUserConfirmation`
14. version + 1，落盘 snapshot，`eventType: "agent_turn"`
15. 用 treatmentPlan 和 gateAssessment 的证据 id 标记 `usedInAnswer`
16. 返回带 memo 的 AgentTurnResponse

新病例初始化为 `battlefield_first_aid` / `primary_first_aid`。

- [ ] **步骤 4：确认通过**

- [ ] **步骤 5：提交**

```bash
git add src/trauma/runner.ts tests/trauma/runner.spec.ts
git commit -m "$(cat <<'EOF'
用固定编排器驱动战创伤回合。

EOF
)"
```

---

### 任务 9：confirmTransition 与 overrideStage

**文件：**
- 修改：`src/trauma/runner.ts`
- 修改：`tests/trauma/runner.spec.ts`

**接口：**

```ts
export type TransitionConfirmationInput = {
  sessionId: string;
  projectId: string;
  answer: "confirmed" | "declined";
  expectedVersion: number;
};

export type ManualStageOverrideInput = {
  sessionId: string;
  projectId: string;
  actorId: string;
  toStage: MainStage;
  toSubStage: SubStage;
  reason: string;
  riskAcknowledged: true;
  blockedOverrideConfirmed?: boolean;
};
```

- [ ] **步骤 1：写失败测试**

- 过期 `expectedVersion` 的确认抛错且不落盘
- 确认后应用 `targetStage` / `targetSubStage`，Gate 为 `COMPLETED`，清空 `pendingTransition`，`eventType: "transition_confirmation"`，`memos.length` 不变，`round` 不变，`version + 1`
- 拒绝时保持阶段，记录 `confirmation.answer = "declined"`，不新增叶子
- 覆盖到更早子级抛错
- 覆盖到后续子级成功，且不调用 rag/model
- BLOCKED 覆盖缺少 `blockedOverrideConfirmed` 时抛错
- BLOCKED 覆盖二次确认后成功，并保存 `unresolvedRisks`
- 覆盖不改变 `currentFacility` 或 `currentCapabilities`

- [ ] **步骤 2：确认失败**

- [ ] **步骤 3：实现**

没有 `pendingTransition` 时，`confirmTransition` 必须拒绝。

覆盖完成后 `transport.gateStatus = "COMPLETED"`，并保存 `originalGateStatus`。下一次 `runTurn` 用新的评估覆盖 Gate。

- [ ] **步骤 4：确认通过**

- [ ] **步骤 5：提交**

```bash
git add src/trauma/runner.ts tests/trauma/runner.spec.ts
git commit -m "$(cat <<'EOF'
实现战创伤阶段确认与带审计的人工覆盖。

EOF
)"
```

---

### 任务 10：网关路由与会话事件

**文件：**
- 新建：`src/trauma/events.ts`
- 新建：`src/trauma/index.ts`
- 修改：`src/gateway/client/InProcessGateway.ts`
- 测试：`tests/trauma/routing.spec.ts`

**接口：**
- 消费：`AgentTurnResponse`，以及网关 `prompt` 入参（`sessionKey`、`projectKey`、`message`）
- 产出：现有 `GatewayEvent` 的异步迭代，前端聊天链路不需要新的 websocket 类型

路由规则：`projectMetaTypeFromProjectPath(projectKey) === "war_trauma"`，或 `projectTypeKeyFromProjectId(projectKey) === "trauma_med"`。

- [ ] **步骤 1：写失败测试。** 构造带桩 session factory 的 `InProcessGateway`（战创伤路径不得调用它）和假 runner。

```ts
test("war_trauma prompt uses TraumaTurnRunner instead of AgentSession.submit", async () => {
  const events = [];
  for await (const event of gateway.prompt({
    sessionKey: "web:s_test",
    projectKey: "trauma_med-demo",
    message: "呼吸32次，收缩压95",
  })) events.push(event);
  assert.equal(submitCalls, 0);
  assert.ok(events.some((e) => e.type === "assistant" || e.type === "agent_event"));
});

test("general_medicine prompt still uses AgentSession.submit", async () => {
  // submitCalls === 1
});
```

先核对 `InProcessGateway` 的真实方法名（`prompt` 还是 `submit`），测试必须调用真实方法。

`events.ts` 应发出：
1. 用户消息若网关已记录，不要重复
2. 助手正文来自 `naturalLanguageAnswer`
3. 若 READY，发一条名为 `AskUserQuestion` / `ask_user_question` 的合成 tool_call，header 为 `阶段转换`，问题含目标阶段，两个选项与演示文案一致，metadata 为 `{ source: "trauma_pending_transition", version }`
4. **不要**在 `runTurn` 里等待用户回答

确认答案走独立 web 方法 `trauma.confirmTransition`，注册在 `src/web/` 和 `ui/server/pilotdeck-bridge.js` 的现有方法旁边。助手消息仍渲染 `ask_user_question` 卡片；前端提交时调用 `trauma.confirmTransition`，而不是在 `runTurn` 里等待。在 `src/trauma/events.ts` 注释里写清这对关系。

- [ ] **步骤 2：确认失败**

- [ ] **步骤 3：在回合泵开始处、查到 session 之后、`session.submit` 之前实现路由。** 用 `resolveTraumaCaseDir(projectId, sessionId, pilotHome)` 构造 store。

真实 `StructuredModelClient` 使用 agent 同一套 `ModelRuntime`（`options.agent.dependencies.model`）。若从 Gateway 取这个依赖不方便，在 `CreateGatewayOptions.traumaRunner` 传入工厂。测试注入该工厂。

- [ ] **步骤 4：`tests/trauma/routing.spec.ts` 和现有网关测试通过**

命令：有时间就跑 `npm test`；至少跑新 spec，以及若有破坏时跑 `dist/tests/gateway/*.spec.js`。

- [ ] **步骤 5：提交**

```bash
git add src/trauma/events.ts src/trauma/index.ts src/gateway/client/InProcessGateway.ts tests/trauma/routing.spec.ts
git commit -m "$(cat <<'EOF'
把 war_trauma 对话回合路由到 TraumaTurnRunner。

EOF
)"
```

---

### 任务 11：前端契约、真实工作台、覆盖弹窗

**文件：**
- 新建：`ui/src/components/trauma-workspace/domain/types.ts`（镜像 runner JSON；不要继续用 `initial` / `early` 当 id）
- 新建：`ui/src/components/trauma-workspace/domain/patientStateView.ts`
- 新建：`ui/src/components/trauma-workspace/store/useCaseStore.ts`
- 新建：`ui/src/components/trauma-workspace/detail/StageOverrideDialog.tsx`
- 新建：`ui/src/components/trauma-workspace/StageOverrideDialog.test.tsx`
- 修改：`ui/src/components/trauma-workspace/TraumaWorkspace.tsx`
- 修改：`ui/src/components/trauma-workspace/TreatmentTree.tsx`
- 修改：`ui/src/components/trauma-workspace/MemoDetailPanel.tsx`
- 修改：`ui/src/components/main-content/view/MainContent.tsx`
- 修改：`ui/src/components/trauma-workspace/TraumaWorkspace.test.tsx`
- 修改：`ui/src/components/main-content/view/MainContent.test.tsx`

**接口：**
- 消费：从读取接口拿到的 `CaseSnapshot[]`（若还没有，就在 `ui/server` 读 `current.json` + `snapshots.jsonl`）
- 产出：用快照驱动树和详情；覆盖走 POST/WS 到 `overrideStage`

需要读接口。最小做法：

1. 每个 runner 回合后，快照已在磁盘上。
2. 前端拉取 `GET /api/trauma/cases/:sessionId`；`ui/server` 用 `PILOT_HOME` 读病例目录。
3. 覆盖：`POST /api/trauma/cases/:sessionId/override`，body 为 ManualStageOverride；服务端转给 runner。

若 `ui/server` 不好直接 import `src/trauma`（CJS/tsx 混用），不要复制第二套业务逻辑。统一走 TypeScript：在 `src/web/` 增加 `trauma.case`、`trauma.override`，前端桥接层按现有 gateway 方法同样调用。

在 `ui/server/pilotdeck-bridge.js` 里搜索现有方法调用方式，把 `trauma.case` / `trauma.override` 加在旁边。

- [ ] **步骤 1：写失败的前端测试**

- `StageOverrideDialog` 只列出后续子级
- 主级节点点击仍没有 `button` 角色（沿用现有测试）
- 覆盖控件是独立 `button`，名为 `调整救治阶段`
- BLOCKED 提交前必须勾选二次确认
- 查看历史叶子快照时隐藏弹窗（`snapshotVersion !== current.version`）
- `snapshots.length > 0` 时不用 DemoTranscript，改显示 `ChatInterfaceV2`
- 没有快照时仍用演示（第一期）

- [ ] **步骤 2：用 vitest 确认失败**

命令：`cd ui && npx vitest run src/components/trauma-workspace/StageOverrideDialog.test.tsx src/components/trauma-workspace/TraumaWorkspace.test.tsx`

- [ ] **步骤 3：实现**

`MainContent.tsx` 当前是：

```tsx
<TraumaWorkspace resetKey={`${selectedProject?.name ?? ''}:${selectedSession?.id ?? ''}`} />
```

改为传入 `selectedProject`、`selectedSession`，以及通用对话区同样的聊天 props（`ws`、`sendMessage` 等），且仅在存在 `selectedSession` 时传入。没有会话或没有快照时继续演示。

`ChatInterfaceV2` 放左栏；右侧仍是树 + 详情。

`patientStateView.ts` 从 `vitalSignsHistory` 最近两次样本派生可读体征和趋势。异常标记：RR > 20、SBP < 90、HR > 100、SpO2 < 94。这些只是**视图启发式**，不是 Gate 规则。

- [ ] **步骤 4：vitest 通过，并在 `ui/` 跑 `npm run typecheck`**

- [ ] **步骤 5：提交**

```bash
git add ui/src/components/trauma-workspace ui/src/components/main-content/view/MainContent.tsx ui/src/components/main-content/view/MainContent.test.tsx
git add src/web ui/server   # 只加实际改动的文件
git commit -m "$(cat <<'EOF'
把战创伤工作台接到真实快照和阶段覆盖。

EOF
)"
```

---

### 任务 12：端到端夹具与说明书核对

**文件：**
- 新建：`tests/trauma/demoRound2.fixture.ts`（说明书 §12.2 的静态抽取/研判载荷）
- 修改：`tests/trauma/runner.spec.ts`
- 测试：`ui/src/components/trauma-workspace/TraumaWorkspace.test.tsx`（若尚未覆盖真实快照渲染）

- [ ] **步骤 1：夹具测试**

把 R2 用户原句送进 `runTurn`，用确定性假依赖返回说明书风格的 JSON。断言：
- 时效已超时，但阶段仍是初级急救
- Gate 为 READY
- memo 标题为 `生命体征补充`
- 确认问题提到 `高级急救`
- 除非抽取器提供了机构，否则不得编造营救护站（目标是能力/阶段，机构可选）

- [ ] **步骤 2：若 runner 偏离则失败**

- [ ] **步骤 3：修 runner/prompt，直到夹具通过**

- [ ] **步骤 4：人工核对说明书 §15.1**（不得跳过）

逐项把 §15.1 对应到 `tests/trauma/*.spec.ts` 或某个 UI 测试名。纯 UI 项写出 vitest 名称。第三期评测报告不在本计划内，提交说明里注明即可。

- [ ] **步骤 5：提交**

```bash
git add tests/trauma/demoRound2.fixture.ts tests/trauma/runner.spec.ts
git commit -m "$(cat <<'EOF'
用第二轮夹具锁住说明书中的 Gate 行为。

EOF
)"
```

---

## 本计划不做

- RAG 评测报告、医生审核记录、能力改写之外的高风险拦截
- 把已迁到 `general_medicine` 的旧项目迁回
- `med_trauma_rag_query` 的细粒度 Metadata Filter
- MockAgentService 双后端
- 除非文案对不上，否则不改 HTML demo

## 给执行者的说明

- 在真实快照出现前，保留第一期演示的上/下一轮控件。不要在接路由的同一批改动里弄坏现有 `TraumaWorkspace.test.tsx` 演示断言，除非任务 11 同步改这些测试。
- 不要把 UI 的 React 类型 import 进 `src/trauma`。
- 仓库根目录 `npm test` 会先编译；新测试放在 `tests/trauma/`，这样 `tsc` 才会收录。
