# 战创伤 Agent 多模态支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让战创伤 Agent 支持上传 DICOM / PDF / 图像 / XML 等医学附件，由一个与定级工位并行的新工位产出紧凑的「影像判读」，供 RAG 检索与答案生成消费。

**Architecture:** 新增**工位 I（interpret_attachments）**，在 runner 的 step 2 之后与 step 3/4（`assess_placement` / `confirm_placement`）并行启动，通过 `Promise.all` 在 `baseline_retrieval` 之前汇合。工位 I 分两步：先用 `mcp__med-tools__med_parse_medical`（`skip_vlm=true`）做本地预处理拿到 `summary` + `png_paths`，再用 `local/G9-V-Med` 结合文本与图像块生成结构化判读。判读按轮次累积进 `CaseState.attachmentInterpretations`，下游 `buildBaselineQueries` 与 `reasoner` 各自消费。工位 I 不占主线步骤编号（走已有的 `countInTotal: false` 通道），失败时判读置空、主线继续。

**Tech Stack:** TypeScript (NodeNext ESM)、`node:test` + `node:assert/strict`、React 18 + Tailwind（UI 层）、既有 `StructuredModelClient` / `ModelRuntime` / MCP `tool.execute` 直调机制。

**Spec:** `docs/superpowers/plans/2026-09-11-trauma-multimodal-design.md`

## Global Constraints

- 工位 I 使用的模型固定为 provider `local` / model `G9-V-Med`；该 provider/model 在配置中不存在时回退到 `runtime.snapshot.config.agent.model`。
- `med_parse_medical` 调用参数固定为 `skip_vlm: true`、`continuation_mode: "material"`，且**不注册 progress 回调**（避免通用长报告泄漏到气泡）。
- 图像块数量上限 `MAX_INTERPRETATION_IMAGES = 8`，与 `.pilotdeck-home/pilotdeck.yaml` 中 `maxImagesPerRequest: 8` 对齐。
- 累积判读的字符预算 `MAX_INTERPRETATION_CHARS = 60000`；超出时保留最早一条 + 从最新往前尽可能多条，中间段以「已省略第 X–Y 轮影像判读」注明。
- 主线步骤总数保持 **11**，`TRAUMA_RUNNER_TOTAL_STEPS` 与 `RUNNER_STEP_LABELS` 不改动。
- 所有结构化 schema 必须满足 OpenAI strict 模式：每个 object 带 `additionalProperties: false` 且 `required` 覆盖全部 properties；可选值只能声明为可空（`nullable()`）。
- 无附件的轮次：工位 I 不启动，11 步行为逐字节不变。
- 工位 I 必须响应 `input.abortSignal`；主线走 partial 分支提前返回时必须取消支线，不得向已结束的轮次写状态。
- 测试命令统一为：`npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/<spec>.js`

## File Structure

**新建**

| 文件 | 职责 |
|---|---|
| `src/trauma/attachments/interpretationBudget.ts` | `InterpretationEntry` 的格式化与字符预算裁剪，纯函数 |
| `src/trauma/attachments/parseClient.ts` | `med_parse_medical` 的战创伤专用薄封装，归一化为 `TraumaParsedAttachment` |
| `src/trauma/stations/interpreter.ts` | 工位 I：预处理产物 + 图像块 → 结构化判读 → 渲染成文本 |
| `src/trauma/stations/interpreterPrompt.ts` | 工位 I 的 system prompt |
| `tests/trauma/interpretationBudget.spec.ts` | 预算裁剪单测 |
| `tests/trauma/parseClient.spec.ts` | parseClient 归一化单测 |
| `tests/trauma/interpreter.spec.ts` | 工位 I 单测（含降级与能力检查） |

**修改**

| 文件 | 改动 |
|---|---|
| `src/trauma/types.ts` | 新增 `TraumaAttachmentRef` / `InterpretationEntry` / `AttachmentInterpretationOutput`；`CaseState` 增 `attachmentInterpretations?` |
| `src/trauma/modelClient.ts` | `CompleteJsonInput` 增 `images?`，`buildRequest()` 构造多块 content |
| `src/trauma/schemas.ts` | 新增 `INTERPRETATION_OUTPUT_SCHEMA` + `validateAttachmentInterpretation` |
| `src/trauma/runner.ts` | `TraumaTurnInput` 增 `attachments?`；runner deps 增 `interpreter?`；并行调度与汇合 |
| `src/trauma/rag/queryPlan.ts` | `buildBaselineQueries` 增第二参数 `interpretation` |
| `src/trauma/stations/reasoner.ts` | `reason()` 入参增 `attachmentInterpretation`，写入 user message JSON |
| `src/trauma/stations/reasonerPrompt.ts` | 增加区分「用户填报」与「系统生成判读」的说明段 |
| `src/trauma/events.ts` | 新增 `traumaInterpretationEvents`（`countInTotal: false`） |
| `src/cli/createLocalGateway.ts` | 构建 `parseClient` + 第二个 `StructuredModelClient`，注入 interpreter |
| `src/gateway/protocol/types.ts` | `GatewaySubmitTurnInput` 增 `traumaAttachments?` |
| `src/gateway/client/InProcessGateway.ts` | trauma 分支透传 `traumaAttachments` |
| `ui/server/pilotdeck-bridge.js` | `sanitizeTraumaAttachments()` 路径校验 + 透传 |
| `ui/src/components/chat/utils/sessionLauncher.ts` | options 增 `traumaAttachments` |
| `ui/src/components/main-content/view/MainContent.tsx` | `submitTraumaForm` 增第 4 参并透传 |
| `ui/src/components/trauma-workspace/TraumaWorkspace.tsx` | `onSubmitForm` 签名扩展 |
| `ui/src/components/trauma-workspace/TraumaComposer.tsx` | 上传区 UI + 上传逻辑 |

**依赖顺序**：Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10。Task 7/8 只依赖 Task 1，可与 5/6 并行审阅，但按序执行最省心。

---

### Task 1: 判读条目类型与字符预算裁剪

**Files:**
- Modify: `src/trauma/types.ts:266-292`（`CaseState`）
- Create: `src/trauma/attachments/interpretationBudget.ts`
- Test: `tests/trauma/interpretationBudget.spec.ts`

**Interfaces:**
- Consumes: 无（本任务是链路起点）
- Produces:
  - `type TraumaAttachmentRef = { path: string; name: string }`
  - `type InterpretationEntry = { id: string; round: number; createdAt: string; fileNames: string[]; text: string }`
  - `type AttachmentInterpretationOutput = { attachments: Array<{ fileName: string; keyFindings: string; traumaRelevance: string }>; overall: string }`
  - `CaseState.attachmentInterpretations?: InterpretationEntry[]`
  - `const MAX_INTERPRETATION_CHARS = 60000`
  - `function buildInterpretationContext(entries: InterpretationEntry[], maxChars?: number): string`

- [ ] **Step 1: 在 `src/trauma/types.ts` 增加类型**

在 `TurnFormInput`（第 66-73 行）之后插入：

```typescript
/** 用户本轮上传的医学附件引用；path 为服务端绝对路径。 */
export type TraumaAttachmentRef = {
  path: string;
  name: string;
};

/** 工位 I 一轮产出的影像判读，随快照持久化并跨轮累积。 */
export type InterpretationEntry = {
  id: string;
  round: number;
  createdAt: string;
  fileNames: string[];
  text: string;
};

/** 工位 I 的结构化模型输出，由 station 渲染成 InterpretationEntry.text。 */
export type AttachmentInterpretationOutput = {
  attachments: Array<{
    fileName: string;
    keyFindings: string;
    traumaRelevance: string;
  }>;
  overall: string;
};
```

在 `CaseState`（第 266-292 行）的 `missingInformation: string[];` 之后、闭合 `}` 之前插入一行：

```typescript
  /** 历轮影像判读；没有附件的轮次不产生条目。 */
  attachmentInterpretations?: InterpretationEntry[];
```

- [ ] **Step 2: 写失败测试**

创建 `tests/trauma/interpretationBudget.spec.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INTERPRETATION_CHARS,
  buildInterpretationContext,
} from "../../src/trauma/attachments/interpretationBudget.js";
import type { InterpretationEntry } from "../../src/trauma/types.js";

function entry(round: number, text: string): InterpretationEntry {
  return {
    id: `interp-${round}`,
    round,
    createdAt: "2026-09-11T00:00:00.000Z",
    fileNames: [`scan-${round}.dcm`],
    text,
  };
}

test("empty entries produce an empty context", () => {
  assert.equal(buildInterpretationContext([]), "");
});

test("a single entry is rendered with round and file names", () => {
  const context = buildInterpretationContext([entry(3, "右侧血气胸。")]);
  assert.ok(context.includes("【第 3 轮影像判读】"));
  assert.ok(context.includes("scan-3.dcm"));
  assert.ok(context.includes("右侧血气胸。"));
});

test("entries under budget are all kept and ordered by round", () => {
  const context = buildInterpretationContext([entry(2, "B"), entry(1, "A")]);
  assert.ok(context.indexOf("【第 1 轮") < context.indexOf("【第 2 轮"));
  assert.ok(context.includes("A") && context.includes("B"));
});

test("over budget keeps the earliest and the latest, noting the omitted range", () => {
  const entries = [1, 2, 3, 4, 5].map((round) => entry(round, "x".repeat(400)));
  const context = buildInterpretationContext(entries, 1000);
  assert.ok(context.includes("【第 1 轮影像判读】"), "earliest baseline must survive");
  assert.ok(context.includes("【第 5 轮影像判读】"), "most recent must survive");
  assert.ok(/【已省略第 2–\d 轮影像判读】/u.test(context), context);
  assert.ok(context.length <= 1000 + 128);
});

test("the default budget is 60000 characters", () => {
  assert.equal(MAX_INTERPRETATION_CHARS, 60000);
});
```

- [ ] **Step 3: 运行测试，确认失败**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/interpretationBudget.spec.js
```

Expected: `tsc` 报 `Cannot find module '../../src/trauma/attachments/interpretationBudget.js'`。

- [ ] **Step 4: 写最小实现**

创建 `src/trauma/attachments/interpretationBudget.ts`：

```typescript
import type { InterpretationEntry } from "../types.js";

/**
 * 判读天然稀疏（并非每轮都有附件），正常会话的累计量远低于上下文压力线。
 * 这个预算只在极端长会话时兜底，避免 reasoner 那一步以不直观的 400 报错。
 * 取值依据：可用输入约 114k tokens，扣除 system + 病例摘要 + RAG chunk 约 30k
 * 后仍有充裕余量；中文近似 1 char/token。
 */
export const MAX_INTERPRETATION_CHARS = 60000;

const SEPARATOR = "\n\n";
/** 为省略提示预留的字符数，避免裁剪后反而超出预算。 */
const OMISSION_RESERVE = 64;

function formatEntry(entry: InterpretationEntry): string {
  const files = entry.fileNames.length > 0
    ? `（附件：${entry.fileNames.join("、")}）`
    : "";
  return `【第 ${entry.round} 轮影像判读】${files}\n${entry.text}`;
}

/**
 * 把历轮判读拼成给下游模型的上下文文本。默认取全部条目；仅在超出字符预算时
 * 才裁剪，策略为保留最早一条（纵向对比的基线影像）加上从最新往前尽可能多条。
 */
export function buildInterpretationContext(
  entries: InterpretationEntry[],
  maxChars: number = MAX_INTERPRETATION_CHARS,
): string {
  if (entries.length === 0) return "";
  const ordered = entries.slice().sort((left, right) => left.round - right.round);
  const blocks = ordered.map(formatEntry);

  const total = blocks.reduce(
    (sum, block) => sum + block.length + SEPARATOR.length,
    0,
  );
  if (total <= maxChars) return blocks.join(SEPARATOR);

  const first = blocks[0] ?? "";
  const kept: string[] = [];
  let used = first.length;
  for (let index = blocks.length - 1; index >= 1; index -= 1) {
    const block = blocks[index] ?? "";
    if (used + block.length + SEPARATOR.length + OMISSION_RESERVE > maxChars) break;
    used += block.length + SEPARATOR.length;
    kept.unshift(block);
  }

  const omittedCount = blocks.length - 1 - kept.length;
  if (omittedCount <= 0) return [first, ...kept].join(SEPARATOR);

  const omittedStartRound = ordered[1]?.round ?? 0;
  const omittedEndRound = ordered[blocks.length - kept.length - 1]?.round ?? omittedStartRound;
  const notice = `【已省略第 ${omittedStartRound}–${omittedEndRound} 轮影像判读】`;
  return [first, notice, ...kept].join(SEPARATOR);
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/interpretationBudget.spec.js
```

Expected: 5/5 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/trauma/types.ts src/trauma/attachments/interpretationBudget.ts tests/trauma/interpretationBudget.spec.ts
git commit -m "feat(trauma): 新增影像判读条目类型与字符预算裁剪"
```

---

### Task 2: modelClient 开放 image content block

**Files:**
- Modify: `src/trauma/modelClient.ts:11-20`（`CompleteJsonInput`）、`:71-93`（`buildRequest`）
- Test: `tests/trauma/modelClient.spec.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type TraumaImageInput = { data: string; mimeType: string }`（`data` 为裸 base64，不带 `data:` 前缀）
  - `CompleteJsonInput<T>.images?: TraumaImageInput[]`
  - 语义保证：不传 `images` 时请求与改动前逐字段相同（单个 text block）

- [ ] **Step 1: 写失败测试**

追加到 `tests/trauma/modelClient.spec.ts` 末尾：

```typescript
test("completeJson sends a single text block when no images are supplied", async () => {
  const requests: any[] = [];
  const model = createStructuredModelClient({
    provider: "test",
    model: "test-model",
    complete: async (request) => {
      requests.push(request);
      return { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }], finishReason: "stop" };
    },
    stream: async function* () {
      throw new Error("stream should not be called");
    },
  });
  await model.completeJson<{ ok: boolean }>({
    name: "trauma_test",
    system: "system",
    user: "user",
    schema: {},
    validate: (value): value is { ok: boolean } => Boolean(value),
  });
  assert.deepEqual(requests[0].messages[0].content, [{ type: "text", text: "user" }]);
});

test("completeJson prepends image blocks before the text block", async () => {
  const requests: any[] = [];
  const model = createStructuredModelClient({
    provider: "test",
    model: "test-model",
    complete: async (request) => {
      requests.push(request);
      return { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }], finishReason: "stop" };
    },
    stream: async function* () {
      throw new Error("stream should not be called");
    },
  });
  await model.completeJson<{ ok: boolean }>({
    name: "trauma_test",
    system: "system",
    user: "user",
    schema: {},
    validate: (value): value is { ok: boolean } => Boolean(value),
    images: [{ data: "QUJD", mimeType: "image/png" }],
  });
  assert.deepEqual(requests[0].messages[0].content, [
    { type: "image", source: "base64", data: "QUJD", mimeType: "image/png" },
    { type: "text", text: "user" },
  ]);
  // 结构化输出与图像块互不干扰，两者必须同时存在。
  assert.equal(requests[0].outputSchema.strict, true);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/modelClient.spec.js
```

Expected: `tsc` 报 `Object literal may only specify known properties, and 'images' does not exist in type 'CompleteJsonInput<{ ok: boolean; }>'`。

- [ ] **Step 3: 写最小实现**

在 `src/trauma/modelClient.ts` 的 `CompleteJsonInput` 之前插入类型：

```typescript
/** 送进多模态工位的图像；data 为裸 base64，不带 data: 前缀。 */
export type TraumaImageInput = {
  data: string;
  mimeType: string;
};
```

在 `CompleteJsonInput<T>` 内、`signal?: AbortSignal;` 之前插入：

```typescript
  /** 仅多模态工位使用；其余工位不传，请求形态与改动前完全一致。 */
  images?: TraumaImageInput[];
```

把 `buildRequest` 的 `messages` 字段替换为：

```typescript
    messages: [
      {
        role: "user",
        content: [
          ...(input.images ?? []).map((image) => ({
            type: "image" as const,
            source: "base64" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
          { type: "text" as const, text: input.user },
        ],
      },
    ],
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/modelClient.spec.js
```

Expected: 3/3 PASS（含原有的 streamJson 用例）。

- [ ] **Step 5: 跑一遍 trauma 全量测试，确认既有工位未受影响**

```bash
node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/
```

Expected: 全绿。

- [ ] **Step 6: 提交**

```bash
git add src/trauma/modelClient.ts tests/trauma/modelClient.spec.ts
git commit -m "feat(trauma): modelClient 支持可选 image content block"
```

---

### Task 3: 影像判读输出 schema 与校验器

**Files:**
- Modify: `src/trauma/schemas.ts`（在 `PLACEMENT_OUTPUT_SCHEMA` 块之后、`GATE_STATUSES` 之前插入）
- Test: `tests/trauma/schemas.spec.ts`

**Interfaces:**
- Consumes: `AttachmentInterpretationOutput`（Task 1）
- Produces:
  - `const INTERPRETATION_OUTPUT_SCHEMA: Record<string, unknown>`
  - `function validateAttachmentInterpretation(value: unknown): value is AttachmentInterpretationOutput`

- [ ] **Step 1: 写失败测试**

追加到 `tests/trauma/schemas.spec.ts` 末尾（若文件未导入 `test`/`assert`，沿用文件既有导入风格）：

```typescript
test("interpretation schema satisfies OpenAI strict mode", () => {
  const schema = INTERPRETATION_OUTPUT_SCHEMA as any;
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["attachments", "overall"]);
  const item = schema.properties.attachments.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, ["fileName", "keyFindings", "traumaRelevance"]);
});

test("validateAttachmentInterpretation accepts a well-formed output", () => {
  assert.equal(validateAttachmentInterpretation({
    attachments: [{ fileName: "ct.dcm", keyFindings: "右侧血气胸", traumaRelevance: "与胸部穿透伤一致" }],
    overall: "提示张力性血气胸风险。",
  }), true);
});

test("validateAttachmentInterpretation accepts an empty attachment list", () => {
  assert.equal(validateAttachmentInterpretation({ attachments: [], overall: "" }), true);
});

test("validateAttachmentInterpretation rejects malformed items", () => {
  assert.equal(validateAttachmentInterpretation({ attachments: [{ fileName: "a" }], overall: "x" }), false);
  assert.equal(validateAttachmentInterpretation({ attachments: "nope", overall: "x" }), false);
  assert.equal(validateAttachmentInterpretation({ attachments: [], overall: 1 }), false);
  assert.equal(validateAttachmentInterpretation(null), false);
});
```

在该文件的 import 块中加入：

```typescript
import {
  INTERPRETATION_OUTPUT_SCHEMA,
  validateAttachmentInterpretation,
} from "../../src/trauma/schemas.js";
```

（若文件已有从 `schemas.js` 的具名导入，合并进去而不是新增一条 import。）

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/schemas.spec.js
```

Expected: `tsc` 报 `Module '"../../src/trauma/schemas.js"' has no exported member 'INTERPRETATION_OUTPUT_SCHEMA'`。

- [ ] **Step 3: 写最小实现**

在 `src/trauma/schemas.ts` 第 87 行 `}`（`validatePlacementAssessment` 结束）之后插入：

```typescript
export const INTERPRETATION_OUTPUT_SCHEMA: Record<string, unknown> = described(
  object({
    attachments: described(
      arrayOf(object({
        fileName: described(STRING, "附件文件名，必须与输入中给出的文件名一致。"),
        keyFindings: described(
          STRING,
          "该附件的关键发现，一到三句话。只描述可从材料直接读出的内容，不要推测。",
        ),
        traumaRelevance: described(
          STRING,
          "该发现与本轮战创伤救治决策的相关性；无相关性时写「与本轮救治决策无直接关联」。",
        ),
      })),
      "按输入附件逐条给出的判读；解析为空的附件也要出现在列表中并说明原因。",
    ),
    overall: described(
      STRING,
      "跨附件的综合判读，不超过 200 字；没有可综合的内容时为空串。",
    ),
  }),
  "工位 I 的战创伤影像判读输出，供检索与推理消费，不直接展示为长报告。",
);

export function validateAttachmentInterpretation(
  value: unknown,
): value is import("./types.js").AttachmentInterpretationOutput {
  if (!isRecord(value)) return false;
  if (typeof value.overall !== "string") return false;
  if (!Array.isArray(value.attachments)) return false;
  return value.attachments.every((item: unknown) => (
    isRecord(item)
    && typeof item.fileName === "string"
    && typeof item.keyFindings === "string"
    && typeof item.traumaRelevance === "string"
  ));
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/schemas.spec.js
```

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/trauma/schemas.ts tests/trauma/schemas.spec.ts
git commit -m "feat(trauma): 新增影像判读输出 schema 与校验器"
```

---

### Task 4: med_parse_medical 的战创伤薄封装

**Files:**
- Create: `src/trauma/attachments/parseClient.ts`
- Test: `tests/trauma/parseClient.spec.ts`

**Interfaces:**
- Consumes: `TraumaAttachmentRef`（Task 1）、`payloadFromTool`（既有，`src/trauma/rag/client.ts` 已导出）
- Produces:
  - `const TRAUMA_PARSE_TOOL_NAME = "mcp__med-tools__med_parse_medical"`
  - `type TraumaParsedAttachment = { name: string; path: string; summary: string; pngPaths: string[]; ok: boolean; warnings: string[] }`
  - `type TraumaParseClient = { parse(input: { attachment: TraumaAttachmentRef; signal?: AbortSignal }): Promise<TraumaParsedAttachment> }`
  - `function normalizeParsePayload(attachment: TraumaAttachmentRef, payload: unknown): TraumaParsedAttachment`
  - `function createMcpTraumaParseClient(callTool: (name: string, input: unknown, signal?: AbortSignal) => Promise<unknown>): TraumaParseClient`

- [ ] **Step 1: 写失败测试**

创建 `tests/trauma/parseClient.spec.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import {
  TRAUMA_PARSE_TOOL_NAME,
  createMcpTraumaParseClient,
  normalizeParsePayload,
} from "../../src/trauma/attachments/parseClient.js";

const attachment = { path: "/inbox/b1/ct.dcm", name: "ct.dcm" };

test("normalizeParsePayload keeps summary and png paths", () => {
  const parsed = normalizeParsePayload(attachment, {
    ok: true,
    summary: "胸部 CT，层厚 5mm。",
    png_paths: ["/inbox/b1/ct-0.png", "/inbox/b1/ct-1.png"],
    warnings: [],
  });
  assert.deepEqual(parsed, {
    name: "ct.dcm",
    path: "/inbox/b1/ct.dcm",
    summary: "胸部 CT，层厚 5mm。",
    pngPaths: ["/inbox/b1/ct-0.png", "/inbox/b1/ct-1.png"],
    ok: true,
    warnings: [],
  });
});

test("normalizeParsePayload falls back to report when summary is absent", () => {
  const parsed = normalizeParsePayload(attachment, { ok: true, report: "报告正文" });
  assert.equal(parsed.summary, "报告正文");
  assert.deepEqual(parsed.pngPaths, []);
});

test("normalizeParsePayload marks a non-object payload as failed instead of throwing", () => {
  const parsed = normalizeParsePayload(attachment, "not-json-object");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.summary, "");
  assert.ok(parsed.warnings[0]?.includes("ct.dcm"));
});

test("normalizeParsePayload drops non-string png paths and warnings", () => {
  const parsed = normalizeParsePayload(attachment, {
    ok: true,
    summary: "s",
    png_paths: ["/a.png", 42, null],
    warnings: ["w1", 7],
  });
  assert.deepEqual(parsed.pngPaths, ["/a.png"]);
  assert.deepEqual(parsed.warnings, ["w1"]);
});

test("createMcpTraumaParseClient pins skip_vlm and continuation_mode", async () => {
  const calls: Array<{ name: string; input: any }> = [];
  const client = createMcpTraumaParseClient(async (name, input) => {
    calls.push({ name, input });
    return JSON.stringify({ ok: true, summary: "s", png_paths: [] });
  });
  const parsed = await client.parse({ attachment });
  assert.equal(calls[0]?.name, TRAUMA_PARSE_TOOL_NAME);
  assert.equal(calls[0]?.input.path, "/inbox/b1/ct.dcm");
  assert.equal(calls[0]?.input.skip_vlm, true);
  assert.equal(calls[0]?.input.continuation_mode, "material");
  assert.equal(parsed.summary, "s");
});

test("parse surfaces a tool failure as a non-ok attachment instead of throwing", async () => {
  const client = createMcpTraumaParseClient(async () => {
    throw new Error("tool exploded");
  });
  const parsed = await client.parse({ attachment });
  assert.equal(parsed.ok, false);
  assert.ok(parsed.warnings.some((item) => item.includes("tool exploded")));
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/parseClient.spec.js
```

Expected: `tsc` 报 `Cannot find module '../../src/trauma/attachments/parseClient.js'`。

- [ ] **Step 3: 写最小实现**

创建 `src/trauma/attachments/parseClient.ts`：

```typescript
import { payloadFromTool } from "../rag/client.js";
import type { TraumaAttachmentRef } from "../types.js";

export const TRAUMA_PARSE_TOOL_NAME = "mcp__med-tools__med_parse_medical";

export type TraumaParsedAttachment = {
  name: string;
  path: string;
  /** 本地解析出的文本摘要：PDF 正文、CDA 检验项、DICOM 元数据。 */
  summary: string;
  /** DICOM / PDF 渲染出的预览 PNG 绝对路径。 */
  pngPaths: string[];
  ok: boolean;
  warnings: string[];
};

export type TraumaParseClient = {
  parse(input: {
    attachment: TraumaAttachmentRef;
    signal?: AbortSignal;
  }): Promise<TraumaParsedAttachment>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function failed(
  attachment: TraumaAttachmentRef,
  reason: string,
): TraumaParsedAttachment {
  return {
    name: attachment.name,
    path: attachment.path,
    summary: "",
    pngPaths: [],
    ok: false,
    warnings: [`附件 ${attachment.name} 解析失败：${reason}`],
  };
}

/**
 * 单个附件解析失败不应中断整个工位——其余附件仍然有判读价值。
 * 所以这里把异常形态收敛成 ok:false 的条目，由 station 决定如何呈现。
 */
export function normalizeParsePayload(
  attachment: TraumaAttachmentRef,
  payload: unknown,
): TraumaParsedAttachment {
  if (!isRecord(payload)) {
    return failed(attachment, `返回形态不是对象（${typeof payload}）`);
  }
  const summary = typeof payload.summary === "string" && payload.summary
    ? payload.summary
    : typeof payload.report === "string"
      ? payload.report
      : "";
  return {
    name: attachment.name,
    path: attachment.path,
    summary,
    pngPaths: stringsOf(payload.png_paths),
    ok: payload.ok !== false,
    warnings: stringsOf(payload.warnings),
  };
}

export function createMcpTraumaParseClient(
  callTool: (name: string, input: unknown, signal?: AbortSignal) => Promise<unknown>,
): TraumaParseClient {
  return {
    async parse({ attachment, signal }) {
      try {
        const raw = await callTool(
          TRAUMA_PARSE_TOOL_NAME,
          {
            path: attachment.path,
            // 只取本地预处理产物，跳过通用医学的 G9 长报告。
            skip_vlm: true,
            // material 表示这是素材而非终结性回答，不结束本轮。
            continuation_mode: "material",
          },
          signal,
        );
        return normalizeParsePayload(attachment, payloadFromTool(raw));
      } catch (error) {
        if (signal?.aborted) throw error;
        return failed(attachment, error instanceof Error ? error.message : String(error));
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/parseClient.spec.js
```

Expected: 6/6 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/trauma/attachments/parseClient.ts tests/trauma/parseClient.spec.ts
git commit -m "feat(trauma): 新增 med_parse_medical 的战创伤薄封装"
```

---

### Task 5: 工位 I — 影像判读 station

**Files:**
- Create: `src/trauma/stations/interpreterPrompt.ts`
- Create: `src/trauma/stations/interpreter.ts`
- Test: `tests/trauma/interpreter.spec.ts`

**Interfaces:**
- Consumes: `TraumaParseClient` / `TraumaParsedAttachment`（Task 4）、`StructuredModelClient` + `TraumaImageInput`（Task 2）、`INTERPRETATION_OUTPUT_SCHEMA` + `validateAttachmentInterpretation`（Task 3）、`TraumaAttachmentRef`（Task 1）、`compactCaseStateForDownstream`（既有）
- Produces:
  - `const MAX_INTERPRETATION_IMAGES = 8`
  - `type InterpretationStation = { interpret(input: { state: CaseState; attachments: TraumaAttachmentRef[]; signal?: AbortSignal }): Promise<{ text: string; fileNames: string[] }> }`
  - `function createInterpretationStation(deps: { model: StructuredModelClient; parse: TraumaParseClient; readImage: (path: string) => Promise<TraumaImageInput | null>; supportsImages: boolean }): InterpretationStation`
  - `function renderInterpretation(output: AttachmentInterpretationOutput): string`
  - 失败语义：任何异常（非 abort）都返回 `{ text: "", fileNames: [] }`，绝不抛出

- [ ] **Step 1: 写 prompt 文件**

创建 `src/trauma/stations/interpreterPrompt.ts`：

```typescript
export const INTERPRETATION_SYSTEM_PROMPT = `你是战创伤救治推演系统中的影像与资料判读工位。

你会收到：
1. 当前伤员的病例摘要（伤情叙述、处置、生命体征）；
2. 用户本轮上传的每个附件的本地解析文本（DICOM 元数据、PDF 正文、CDA 检验项等）；
3. 部分附件渲染出的预览图像。

任务：对每个附件给出一条简短判读，并给出一段跨附件的综合判读。

硬性要求：
- 只描述能从材料中直接读出的内容。看不清、解析为空或格式不支持时，如实写明，不要推测。
- 心电类文件（.ecg/.edf/.atr/.qrs/.scp）本轮不做波形识别，统一写「心电数据未做波形识别」。
- 每条 keyFindings 一到三句话；overall 不超过 200 字。这是给下游检索与推理用的素材，不是给用户看的完整影像报告，不要写成长篇报告，不要写检查技术参数罗列。
- traumaRelevance 必须落到本轮战创伤救治决策上（例如提示某类损伤、某项处置的必要性、后送优先级）；确实无关时写「与本轮救治决策无直接关联」。
- attachments 数组必须覆盖输入中给出的每一个附件文件名，顺序一致，fileName 逐字照抄。
- 不要输出思考过程，直接给出符合 schema 的 JSON。`;
```

- [ ] **Step 2: 写失败测试**

创建 `tests/trauma/interpreter.spec.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INTERPRETATION_IMAGES,
  createInterpretationStation,
  renderInterpretation,
} from "../../src/trauma/stations/interpreter.js";
import type { TraumaParseClient } from "../../src/trauma/attachments/parseClient.js";
import type { StructuredModelClient } from "../../src/trauma/modelClient.js";
import type { CaseState } from "../../src/trauma/types.js";

const state = {
  caseId: "case-1",
  sessionId: "s",
  projectId: "p",
  version: 1,
  round: 2,
  updatedAt: "2026-09-11T00:00:00.000Z",
  currentFacility: null,
  currentStage: null,
  currentSubStage: null,
  injuryNarratives: [],
  treatmentNarratives: [],
  evacuationNarratives: [],
  notes: [],
  vitalSignsHistory: [],
  requiredCapabilities: [],
  currentCapabilities: [],
  classificationHistory: [],
  transport: { needed: false, priority: "pending", readiness: "unknown", gateStatus: "ASSESSING" },
  manualStageOverrides: [],
  evidence: [],
  memos: [],
  missingInformation: [],
} as unknown as CaseState;

function parseClient(pngPaths: string[] = []): TraumaParseClient {
  return {
    async parse({ attachment }) {
      return {
        name: attachment.name,
        path: attachment.path,
        summary: `${attachment.name} 的解析文本`,
        pngPaths,
        ok: true,
        warnings: [],
      };
    },
  };
}

function modelClient(calls: any[], output?: any): StructuredModelClient {
  return {
    async completeJson(input: any) {
      calls.push(input);
      return (output ?? {
        attachments: [{ fileName: "ct.dcm", keyFindings: "右侧血气胸", traumaRelevance: "提示需要胸腔闭式引流" }],
        overall: "存在张力性血气胸风险。",
      }) as any;
    },
  };
}

test("renderInterpretation formats per-attachment findings and the overall note", () => {
  const text = renderInterpretation({
    attachments: [{ fileName: "ct.dcm", keyFindings: "右侧血气胸", traumaRelevance: "需胸腔引流" }],
    overall: "张力性血气胸风险。",
  });
  assert.ok(text.includes("ct.dcm"));
  assert.ok(text.includes("关键发现：右侧血气胸"));
  assert.ok(text.includes("创伤相关性：需胸腔引流"));
  assert.ok(text.includes("综合判读：张力性血气胸风险。"));
});

test("interpret returns rendered text and the file names it covered", async () => {
  const calls: any[] = [];
  const station = createInterpretationStation({
    model: modelClient(calls),
    parse: parseClient(),
    readImage: async () => null,
    supportsImages: true,
  });
  const result = await station.interpret({
    state,
    attachments: [{ path: "/inbox/ct.dcm", name: "ct.dcm" }],
  });
  assert.deepEqual(result.fileNames, ["ct.dcm"]);
  assert.ok(result.text.includes("右侧血气胸"));
  assert.equal(calls[0].name, "trauma_interpret_attachments");
  assert.ok(calls[0].user.includes("ct.dcm 的解析文本"));
});

test("interpret attaches preview images and caps them at the image limit", async () => {
  const calls: any[] = [];
  const pngPaths = Array.from({ length: 12 }, (_, index) => `/inbox/p${index}.png`);
  const station = createInterpretationStation({
    model: modelClient(calls),
    parse: parseClient(pngPaths),
    readImage: async (path) => ({ data: Buffer.from(path).toString("base64"), mimeType: "image/png" }),
    supportsImages: true,
  });
  await station.interpret({ state, attachments: [{ path: "/inbox/ct.dcm", name: "ct.dcm" }] });
  assert.equal(calls[0].images.length, MAX_INTERPRETATION_IMAGES);
});

test("interpret skips image blocks when the model has no image capability", async () => {
  const calls: any[] = [];
  const station = createInterpretationStation({
    model: modelClient(calls),
    parse: parseClient(["/inbox/p0.png"]),
    readImage: async () => ({ data: "QQ==", mimeType: "image/png" }),
    supportsImages: false,
  });
  await station.interpret({ state, attachments: [{ path: "/inbox/ct.dcm", name: "ct.dcm" }] });
  assert.equal(calls[0].images, undefined);
});

test("interpret returns an empty result when the model call fails", async () => {
  const station = createInterpretationStation({
    model: {
      async completeJson() {
        throw new Error("model down");
      },
    },
    parse: parseClient(),
    readImage: async () => null,
    supportsImages: true,
  });
  const result = await station.interpret({
    state,
    attachments: [{ path: "/inbox/ct.dcm", name: "ct.dcm" }],
  });
  assert.deepEqual(result, { text: "", fileNames: [] });
});

test("interpret returns an empty result when there are no attachments", async () => {
  const calls: any[] = [];
  const station = createInterpretationStation({
    model: modelClient(calls),
    parse: parseClient(),
    readImage: async () => null,
    supportsImages: true,
  });
  const result = await station.interpret({ state, attachments: [] });
  assert.deepEqual(result, { text: "", fileNames: [] });
  assert.equal(calls.length, 0, "no attachments must not reach the model");
});

test("interpret rethrows an abort so the runner can cancel the branch", async () => {
  const controller = new AbortController();
  const station = createInterpretationStation({
    model: {
      async completeJson() {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    },
    parse: parseClient(),
    readImage: async () => null,
    supportsImages: true,
  });
  await assert.rejects(
    () => station.interpret({
      state,
      attachments: [{ path: "/inbox/ct.dcm", name: "ct.dcm" }],
      signal: controller.signal,
    }),
    /aborted/u,
  );
});
```

- [ ] **Step 3: 运行测试，确认失败**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/interpreter.spec.js
```

Expected: `tsc` 报 `Cannot find module '../../src/trauma/stations/interpreter.js'`。

- [ ] **Step 4: 写最小实现**

创建 `src/trauma/stations/interpreter.ts`：

```typescript
import type { TraumaParseClient, TraumaParsedAttachment } from "../attachments/parseClient.js";
import { compactCaseStateForDownstream } from "../factMerge.js";
import type { StructuredModelClient, TraumaImageInput } from "../modelClient.js";
import {
  INTERPRETATION_OUTPUT_SCHEMA,
  validateAttachmentInterpretation,
} from "../schemas.js";
import type {
  AttachmentInterpretationOutput,
  CaseState,
  TraumaAttachmentRef,
} from "../types.js";
import { INTERPRETATION_SYSTEM_PROMPT } from "./interpreterPrompt.js";

/** 与 pilotdeck.yaml 的 multimodal.maxImagesPerRequest 对齐。 */
export const MAX_INTERPRETATION_IMAGES = 8;

export type InterpretationResult = {
  text: string;
  fileNames: string[];
};

export type InterpretationStation = {
  interpret(input: {
    state: CaseState;
    attachments: TraumaAttachmentRef[];
    signal?: AbortSignal;
  }): Promise<InterpretationResult>;
};

export type InterpretationStationDeps = {
  model: StructuredModelClient;
  parse: TraumaParseClient;
  /** 读取预览 PNG 并转成 base64；读不到时返回 null。 */
  readImage: (path: string) => Promise<TraumaImageInput | null>;
  /** 判读模型是否支持 image 输入；trauma 路径绕过了自动降级，必须自己查。 */
  supportsImages: boolean;
};

export function renderInterpretation(output: AttachmentInterpretationOutput): string {
  const blocks = output.attachments.map((item) => (
    `· ${item.fileName}\n  关键发现：${item.keyFindings}\n  创伤相关性：${item.traumaRelevance}`
  ));
  if (output.overall.trim()) {
    blocks.push(`综合判读：${output.overall.trim()}`);
  }
  return blocks.join("\n");
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof Error && error.name === "AbortError");
}

function describeAttachment(parsed: TraumaParsedAttachment): Record<string, unknown> {
  return {
    fileName: parsed.name,
    parsed: parsed.ok,
    // 单个附件的本地解析文本可能很长，这里截断——判读只需要要点。
    summary: parsed.summary.slice(0, 4000),
    previewImageCount: parsed.pngPaths.length,
    warnings: parsed.warnings,
  };
}

async function collectImages(
  parsedList: TraumaParsedAttachment[],
  readImage: InterpretationStationDeps["readImage"],
): Promise<TraumaImageInput[]> {
  const images: TraumaImageInput[] = [];
  // 按附件顺序取，超出上限就截断——靠前的附件通常是用户最关心的那份。
  for (const parsed of parsedList) {
    for (const path of parsed.pngPaths) {
      if (images.length >= MAX_INTERPRETATION_IMAGES) return images;
      const image = await readImage(path).catch(() => null);
      if (image) images.push(image);
    }
  }
  return images;
}

export function createInterpretationStation(
  deps: InterpretationStationDeps,
): InterpretationStation {
  return {
    async interpret(input) {
      if (input.attachments.length === 0) {
        return { text: "", fileNames: [] };
      }
      try {
        const parsedList: TraumaParsedAttachment[] = [];
        for (const attachment of input.attachments) {
          parsedList.push(await deps.parse.parse({ attachment, signal: input.signal }));
        }

        const images = deps.supportsImages
          ? await collectImages(parsedList, deps.readImage)
          : [];
        const truncatedImages = parsedList
          .reduce((sum, parsed) => sum + parsed.pngPaths.length, 0) > images.length;

        const output = await deps.model.completeJson<AttachmentInterpretationOutput>({
          name: "trauma_interpret_attachments",
          system: INTERPRETATION_SYSTEM_PROMPT,
          user: JSON.stringify({
            caseHistory: compactCaseStateForDownstream(input.state),
            attachments: parsedList.map(describeAttachment),
            previewImagesTruncated: truncatedImages,
            imageCapabilityAvailable: deps.supportsImages,
          }),
          schema: INTERPRETATION_OUTPUT_SCHEMA,
          validate: validateAttachmentInterpretation,
          ...(images.length > 0 ? { images } : {}),
          signal: input.signal,
        });

        const text = renderInterpretation(output);
        if (!text.trim()) return { text: "", fileNames: [] };
        return { text, fileNames: parsedList.map((parsed) => parsed.name) };
      } catch (error) {
        // 中止要向上传播，让 runner 收束支线；其余故障一律降级为空判读，
        // 主线继续推演而不是整轮失败。
        if (isAbort(error, input.signal)) throw error;
        return { text: "", fileNames: [] };
      }
    },
  };
}
```

- [ ] **Step 5: 运行测试，确认通过**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/interpreter.spec.js
```

Expected: 7/7 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/trauma/stations/interpreter.ts src/trauma/stations/interpreterPrompt.ts tests/trauma/interpreter.spec.ts
git commit -m "feat(trauma): 新增工位 I 影像判读 station"
```

---

### Task 6: runner 并行调度与跨轮累积

**Files:**
- Modify: `src/trauma/runner.ts:30-52`（`TraumaTurnProgress`）、`:54-70`（`TraumaTurnInput`）、`:256-264`（deps 与 station 构建）、`:370-371` 之后（支线启动）、`:461-513`（partial 分支取消支线）、`:515-523`（汇合与 query 构建）
- Test: `tests/trauma/runner.spec.ts`

**Interfaces:**
- Consumes: `InterpretationStation`（Task 5）、`buildInterpretationContext`（Task 1）、`TraumaAttachmentRef` / `InterpretationEntry`（Task 1）
- Produces:
  - `TraumaTurnInput.attachments?: TraumaAttachmentRef[]`
  - `createTraumaTurnRunner(deps)` 的 deps 增 `interpreter?: InterpretationStation`
  - `TraumaTurnProgress` 增 `{ kind: "attachment_interpretation"; status: "started" } | { kind: "attachment_interpretation"; status: "finished"; ok: boolean }`
  - 内部变量 `interpretationContext: string` 传给 `buildBaselineQueries`（Task 7）与 `reasoner.reason`（Task 7）
  - 不变量：主线步骤编号与数量完全不变

- [ ] **Step 1: 写失败测试**

追加到 `tests/trauma/runner.spec.ts` 末尾：

```typescript
function interpreter(calls: string[][], text = "· ct.dcm\n  关键发现：右侧血气胸\n  创伤相关性：需胸腔引流") {
  return {
    async interpret(input: { attachments: Array<{ name: string }>; signal?: AbortSignal }) {
      calls.push(input.attachments.map((item) => item.name));
      if (input.signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return { text, fileNames: input.attachments.map((item) => item.name) };
    },
  };
}

test("attachments produce an interpretation entry persisted on the case state", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interpret-"));
  try {
    const interpretCalls: string[][] = [];
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store,
      model: model([]),
      rag: rag({ count: 0 }),
      interpreter: interpreter(interpretCalls),
    });
    await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
    });
    assert.deepEqual(interpretCalls, [["ct.dcm"]]);
    const entries = (await store.load())?.attachmentInterpretations ?? [];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.round, 1);
    assert.deepEqual(entries[0]?.fileNames, ["ct.dcm"]);
    assert.ok(entries[0]?.text.includes("右侧血气胸"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a turn with no attachments never starts the interpretation station", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-no-attach-"));
  try {
    const interpretCalls: string[][] = [];
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store,
      model: model([]),
      rag: rag({ count: 0 }),
      interpreter: interpreter(interpretCalls),
    });
    const steps: number[] = [];
    await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      onProgress: (progress) => {
        if ("kind" in progress && progress.kind === "runner_step" && progress.status === "started") {
          steps.push(progress.step);
        }
      },
    });
    assert.deepEqual(interpretCalls, []);
    assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal((await store.load())?.attachmentInterpretations, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interpretation progress is reported outside the numbered main line", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interp-progress-"));
  try {
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store, model: model([]), rag: rag({ count: 0 }), interpreter: interpreter([]),
    });
    const kinds: string[] = [];
    await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
      onProgress: (progress) => {
        if ("kind" in progress && progress.kind === "attachment_interpretation") {
          kinds.push(progress.status);
        }
      },
    });
    assert.deepEqual(kinds, ["started", "finished"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interpretation failure leaves the main line intact with an empty interpretation", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interp-fail-"));
  try {
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store,
      model: model([]),
      rag: rag({ count: 0 }),
      interpreter: {
        async interpret() {
          throw new Error("station exploded");
        },
      },
    });
    const response = await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
    });
    assert.equal(response.naturalLanguageAnswer.length > 0, true);
    assert.equal((await store.load())?.attachmentInterpretations, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interpretation entries accumulate across rounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interp-accum-"));
  try {
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store, model: model([]), rag: rag({ count: 0 }), interpreter: interpreter([]),
    });
    for (const messageId of ["m1", "m2"]) {
      await runner.runTurn({
        projectId: "trauma_med-demo", sessionId: "web:s", messageId, now,
        form: form({ statedSubStage: "primary_first_aid" }),
        attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
      });
    }
    const entries = (await store.load())?.attachmentInterpretations ?? [];
    assert.deepEqual(entries.map((entry) => entry.round), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/runner.spec.js
```

Expected: `tsc` 报 `'interpreter' does not exist in type` 与 `'attachments' does not exist in type 'TraumaTurnInput'`。

- [ ] **Step 3: 扩展类型与 deps**

`src/trauma/runner.ts` 顶部 import 块中加入：

```typescript
import { buildInterpretationContext } from "./attachments/interpretationBudget.js";
import type { InterpretationStation } from "./stations/interpreter.js";
```

并把既有的 `import type { ... } from "./types.js";` 中补上 `InterpretationEntry,` 与 `TraumaAttachmentRef,`。

在 `TraumaTurnProgress` 联合类型（第 30-52 行）末尾追加两个成员：

```typescript
  | { kind: "attachment_interpretation"; status: "started" }
  | { kind: "attachment_interpretation"; status: "finished"; ok: boolean };
```

在 `TraumaTurnInput`（第 54-70 行）的 `rawInput?: string;` 之后插入：

```typescript
  /** 本轮上传的医学附件；为空或缺省时工位 I 不启动。 */
  attachments?: TraumaAttachmentRef[];
```

在 `createTraumaTurnRunner` 的 deps（第 256-262 行）中 `rag: TraumaRagClient;` 之后插入：

```typescript
  /** 工位 I；未注入时附件被忽略，行为与无附件轮次一致。 */
  interpreter?: InterpretationStation;
```

- [ ] **Step 4: 在 step 2 之后启动支线**

在第 370 行 `await completeStep({ ... vitalHistoryCount ... });` 之后、第 372 行 `await beginStep(3, "assess_placement");` 之前插入：

```typescript
        // 工位 I 与 step 3/4 并行：定级只看表单生命体征与叙述，不需要影像；
        // 而 confirm_placement 要等用户点确认，这个窗口通常足以覆盖判读耗时。
        const attachments = input.attachments ?? [];
        const runInterpretation = Boolean(deps.interpreter) && attachments.length > 0;
        const interpretController = new AbortController();
        const cancelInterpretation = () => {
          interpretController.abort(input.abortSignal?.reason ?? "interpretation cancelled");
        };
        input.abortSignal?.addEventListener("abort", cancelInterpretation, { once: true });
        const interpretationPromise: Promise<{ text: string; fileNames: string[] }> =
          runInterpretation
            ? (async () => {
              report({ kind: "attachment_interpretation", status: "started" });
              try {
                const result = await deps.interpreter!.interpret({
                  state: candidate,
                  attachments,
                  signal: interpretController.signal,
                });
                report({ kind: "attachment_interpretation", status: "finished", ok: Boolean(result.text) });
                return result;
              } catch {
                // 支线故障不该让整轮失败——判读置空，主线照常推演。
                report({ kind: "attachment_interpretation", status: "finished", ok: false });
                return { text: "", fileNames: [] };
              }
            })()
            : Promise.resolve({ text: "", fileNames: [] });
```

- [ ] **Step 5: partial 分支取消支线**

在第 461 行 `if (!candidate.currentStage || !candidate.currentSubStage) {` 之后、`const outOfScope = ...` 之前插入：

```typescript
          // 本轮不会走到 reasoner，判读没有消费者；取消支线，避免它向一个
          // 已经结束的轮次写状态。
          cancelInterpretation();
          void interpretationPromise;
```

- [ ] **Step 6: 汇合并累积**

在第 515-517 行注释与 `await beginStep(5, "baseline_retrieval", {...})` 之前插入汇合逻辑：

```typescript
        const interpretation = await interpretationPromise;
        if (interpretation.text) {
          const entry: InterpretationEntry = {
            id: randomUUID(),
            round: nextRound,
            createdAt: now,
            fileNames: interpretation.fileNames,
            text: interpretation.text,
          };
          candidate.attachmentInterpretations = [
            ...(previous.attachmentInterpretations ?? []),
            entry,
          ];
        }
        const interpretationContext = buildInterpretationContext(
          candidate.attachmentInterpretations ?? [],
        );
```

- [ ] **Step 7: 确保监听器被摘除**

在 `runTurn` 的 `try { ... }` 对应的 `finally` 块中（若当前没有 `finally`，在 `catch` 之后新增一个）加入：

```typescript
      } finally {
        input.abortSignal?.removeEventListener("abort", cancelInterpretation);
      }
```

由于 `cancelInterpretation` 声明在 `try` 内部，需要把它提升到 `try` 之前：在第 291 行 `const report = input.onProgress ?? (() => {});` 之后插入

```typescript
      const interpretController = new AbortController();
      const cancelInterpretation = () => {
        interpretController.abort(input.abortSignal?.reason ?? "interpretation cancelled");
      };
      input.abortSignal?.addEventListener("abort", cancelInterpretation, { once: true });
```

并从 Step 4 的插入片段中删掉这三行的重复声明（保留 `attachments` / `runInterpretation` / `interpretationPromise`）。

- [ ] **Step 8: 运行测试，确认通过**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/runner.spec.js
```

Expected: 原有 4 个用例 + 新增 5 个用例全绿。特别确认「successful full turn records exactly 11 steps」仍然通过。

- [ ] **Step 9: 提交**

```bash
git add src/trauma/runner.ts tests/trauma/runner.spec.ts
git commit -m "feat(trauma): runner 并行调度工位 I 并跨轮累积影像判读"
```

---

### Task 7: 下游消费 — 检索 query 与 reasoner

**Files:**
- Modify: `src/trauma/rag/queryPlan.ts:511-573`（`buildBaselineQueries`）
- Modify: `src/trauma/stations/reasoner.ts:83-121`（`reason` 入参与 user message）
- Modify: `src/trauma/stations/reasonerPrompt.ts`（新增说明段）
- Modify: `src/trauma/runner.ts`（把 `interpretationContext` 接到两个调用点）
- Test: `tests/trauma/queryPlan.spec.ts`、`tests/trauma/runner.spec.ts`

**Interfaces:**
- Consumes: Task 6 产出的 `interpretationContext: string`
- Produces:
  - `buildBaselineQueries(state: CaseState, interpretation?: string): PlannedRagQuery[]`
  - `reason(input: { state; promptChunks; attachmentInterpretation?: string; signal?; onNaturalLanguageDelta?; onNaturalLanguageEnd? })`
  - reasoner user message JSON 新增顶层键 `attachmentInterpretation: string | null`

- [ ] **Step 1: 写失败测试**

追加到 `tests/trauma/queryPlan.spec.ts` 末尾（沿用该文件既有的 `state` 构造方式；若文件已有名为 `baseState()` 之类的工厂，直接复用）：

```typescript
test("interpretation keywords widen the primary injury query", () => {
  const state = baseState();
  const withoutInterpretation = buildBaselineQueries(state)[2]?.query ?? "";
  const withInterpretation = buildBaselineQueries(
    state,
    "· ct.dcm\n  关键发现：右侧血气胸\n  创伤相关性：需胸腔闭式引流",
  )[2]?.query ?? "";
  assert.notEqual(withInterpretation, withoutInterpretation);
  assert.ok(withInterpretation.includes("右侧血气胸"));
});

test("an empty interpretation leaves the baseline queries byte-identical", () => {
  const state = baseState();
  assert.deepEqual(buildBaselineQueries(state, ""), buildBaselineQueries(state));
});
```

追加到 `tests/trauma/runner.spec.ts` 末尾：

```typescript
test("the interpretation reaches the reasoner user message", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interp-reason-"));
  try {
    const users: Record<string, string> = {};
    const capturing: StructuredModelClient = {
      async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
        users[input.name] = input.user;
        const payload = input.name === "trauma_place" ? null : reasonPayload();
        return payload as T;
      },
    };
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store, model: capturing, rag: rag({ count: 0 }), interpreter: interpreter([]),
    });
    await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
    });
    const reasonUser = JSON.parse(users.trauma_reason ?? "{}");
    assert.ok(String(reasonUser.attachmentInterpretation).includes("右侧血气胸"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/queryPlan.spec.js dist/tests/trauma/runner.spec.js
```

Expected: `tsc` 报 `Expected 1 arguments, but got 2`（`buildBaselineQueries`）。

- [ ] **Step 3: 扩展 `buildBaselineQueries`**

把 `src/trauma/rag/queryPlan.ts:511` 的签名与 `query3` 构造改为：

```typescript
/** 从判读文本里抽取可作为检索关键词的短语，避免把整段判读塞进 query。 */
function interpretationKeywords(interpretation: string | undefined): string[] {
  if (!interpretation) return [];
  const matches = interpretation.match(/关键发现：(.+)/gu) ?? [];
  return matches
    .map((line) => line.replace(/^关键发现：/u, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

export function buildBaselineQueries(
  state: CaseState,
  interpretation?: string,
): PlannedRagQuery[] {
  const context = buildQueryContext(state);
  const interpretationHints = interpretationKeywords(interpretation);
```

并在 `query3` 的关键词数组中，把 `...context.actionKeywords,` 之后改为：

```typescript
    ...context.actionKeywords,
    ...interpretationHints,
    "处置",
```

- [ ] **Step 4: 扩展 reasoner**

`src/trauma/stations/reasoner.ts` 的 `reason` 入参类型（第 84-90 行）中，在 `promptChunks: EvidenceChunk[];` 之后插入：

```typescript
	    /** 工位 I 产出的历轮影像判读，已按字符预算裁剪；无判读时为空串。 */
	    attachmentInterpretation?: string;
```

在 user message 的 `JSON.stringify({ ... })` 中，`state: compactCaseStateForDownstream(input.state),` 之后插入：

```typescript
          attachmentInterpretation: input.attachmentInterpretation || null,
```

- [ ] **Step 5: 扩展 reasoner prompt**

在 `src/trauma/stations/reasonerPrompt.ts` 的 `REASONER_SYSTEM_PROMPT` 模板字符串末尾（闭合反引号之前）追加：

```
输入中的 attachmentInterpretation 是系统对用户上传附件（影像、检验、病历文书）自动生成的判读，与用户自己填报的伤情叙述来源不同，可信度也不同：
- 依据判读得出的结论，必须在正文中写明「据影像判读」或等价表述，不要与用户填报的事实混为一谈。
- 判读为 null 表示本次没有附件，不要臆造影像发现。
- 判读中标注「未做波形识别」「解析失败」的条目，不能作为结论依据，必要时列入 missingInformation。
```

- [ ] **Step 6: 在 runner 接上两个调用点**

`src/trauma/runner.ts` 第 523 行：

```typescript
        const baseline = buildBaselineQueries(candidate, interpretationContext);
```

reasoner 调用处（搜索 `reasoner.reason({`），在 `promptChunks:` 参数之后加入：

```typescript
          attachmentInterpretation: interpretationContext,
```

- [ ] **Step 7: 运行测试，确认通过**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/
```

Expected: trauma 全量测试全绿。

- [ ] **Step 8: 提交**

```bash
git add src/trauma/rag/queryPlan.ts src/trauma/stations/reasoner.ts src/trauma/stations/reasonerPrompt.ts src/trauma/runner.ts tests/trauma/queryPlan.spec.ts tests/trauma/runner.spec.ts
git commit -m "feat(trauma): 检索与推理消费影像判读"
```

---

### Task 8: 判读进度事件（不计入主线总数）

**Files:**
- Modify: `src/trauma/events.ts:117-171`（`traumaProgressEvents`）
- Test: `tests/trauma/events.spec.ts`（若不存在则创建）

**Interfaces:**
- Consumes: `TraumaTurnProgress` 的 `attachment_interpretation` 成员（Task 6）
- Produces: `traumaProgressEvents` 对 `kind === "attachment_interpretation"` 返回 `tool_call_started` / `tool_call_finished`，payload 的 `countInTotal` 为 `false`、`stepNumber` 为 `undefined`
- 前端零改动：复用 `traumaExtractionEvents` 已经在用的 `countInTotal: false` 通道

- [ ] **Step 1: 写失败测试**

创建（或追加到）`tests/trauma/events.spec.ts`：

```typescript
import assert from "node:assert/strict";
import test from "node:test";

import { traumaProgressEvents } from "../../src/trauma/events.js";

test("interpretation progress emits an uncounted step event", () => {
  const started = traumaProgressEvents({
    progress: { kind: "attachment_interpretation", status: "started" },
    runId: "run-1",
  });
  assert.equal(started.length, 1);
  assert.equal(started[0]?.type, "tool_call_started");
  const payload = JSON.parse((started[0] as any).argsPreview);
  assert.equal(payload.countInTotal, false);
  assert.equal(payload.stepNumber, undefined);
  assert.equal(payload.title, "附件影像判读");
  assert.equal(payload.expectedTotalSteps, 11);
});

test("a finished interpretation reports its ok flag", () => {
  const finished = traumaProgressEvents({
    progress: { kind: "attachment_interpretation", status: "finished", ok: false },
    runId: "run-1",
  });
  assert.equal(finished[0]?.type, "tool_call_finished");
  assert.equal((finished[0] as any).ok, false);
});

test("started and finished share a tool call id so the UI pairs them", () => {
  const started = traumaProgressEvents({
    progress: { kind: "attachment_interpretation", status: "started" },
    runId: "run-1",
  });
  const finished = traumaProgressEvents({
    progress: { kind: "attachment_interpretation", status: "finished", ok: true },
    runId: "run-1",
  });
  assert.equal((started[0] as any).toolCallId, (finished[0] as any).toolCallId);
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/events.spec.js
```

Expected: `payload.countInTotal` 为 `true` 或读取 `progress.step` 得到 `undefined` 导致的断言失败。

- [ ] **Step 3: 写最小实现**

在 `src/trauma/events.ts` 的 `traumaProgressEvents` 函数体开头、`if ("kind" in progress && progress.kind === "runner_step")` 之前插入：

```typescript
  if ("kind" in progress && progress.kind === "attachment_interpretation") {
    // 工位 I 与主线并行，占用主线编号会让进度条跳跃甚至回退；
    // 复用抽取工位已在用的 countInTotal:false 通道，单独显示一行。
    const payload = runnerStepPayload({
      phase: "interpret",
      title: "附件影像判读",
      runningTitle: "正在判读上传附件",
      countInTotal: false,
    });
    const toolCallId = `trauma-interpretation:${runId}`;
    if (progress.status === "started") {
      return [{
        type: "tool_call_started",
        toolCallId,
        name: payload.title,
        argsPreview: previewPayload(payload),
        runId,
      }];
    }
    return [{
      type: "tool_call_finished",
      toolCallId,
      toolName: payload.title,
      ok: progress.ok,
      resultPreview: previewPayload(payload),
      runId,
    }];
  }
```

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/events.spec.js
```

Expected: 3/3 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/trauma/events.ts tests/trauma/events.spec.ts
git commit -m "feat(trauma): 新增不计入主线总数的影像判读进度事件"
```

---

### Task 9: 网关装配 — parseClient、G9 客户端、协议透传

**Files:**
- Modify: `src/cli/createLocalGateway.ts:648-693`（`createTraumaRunner`）
- Modify: `src/gateway/protocol/types.ts:90-102`（`GatewaySubmitTurnInput`）
- Modify: `src/gateway/client/InProcessGateway.ts:702-709`（`runner.runTurn` 调用）
- Modify: `ui/server/pilotdeck-bridge.js:1169-1217`（校验函数区）、`:1300-1302`、`:1340-1355`
- Test: 手工冒烟（本任务是装配，纯逻辑已由 Task 4/5 覆盖）

**Interfaces:**
- Consumes: `createMcpTraumaParseClient` / `TRAUMA_PARSE_TOOL_NAME`（Task 4）、`createInterpretationStation`（Task 5）、`TraumaTurnInput.attachments`（Task 6）
- Produces:
  - `GatewaySubmitTurnInput.traumaAttachments?: Array<{ path: string; name: string }>`
  - `createTraumaRunner` 注入的 `interpreter`
  - `sanitizeTraumaAttachments(value, projectRoot)`（bridge 内部函数，非导出）
- 说明：`input.attachments`（通用医学的 `ChannelAttachment[]`）继续在 trauma 分支被忽略，两条链路互不影响。

- [ ] **Step 1: 协议字段**

在 `src/gateway/protocol/types.ts` 的 `GatewaySubmitTurnInput` 中，`traumaExtract?: boolean;` 之后插入：

```typescript
  /** 战创伤本轮上传的医学附件；独立于通用路径的 attachments。 */
  traumaAttachments?: Array<{ path: string; name: string }>;
```

- [ ] **Step 2: 网关透传**

在 `src/gateway/client/InProcessGateway.ts` 的 `runner.runTurn({ ... })` 调用中，`rawInput: input.traumaRawInput,` 之后插入：

```typescript
            ...(input.traumaAttachments?.length ? { attachments: input.traumaAttachments } : {}),
```

- [ ] **Step 3: 装配 parseClient 与判读模型**

在 `src/cli/createLocalGateway.ts` 顶部 import 块加入：

```typescript
import { createMcpTraumaParseClient } from "../trauma/attachments/parseClient.js";
import { createInterpretationStation } from "../trauma/stations/interpreter.js";
```

并确保 `node:fs/promises` 的 `readFile` 已引入（若文件已从 `node:fs/promises` 具名导入，合并进去）。

在 `createTraumaRunner` 中，`const rag = createMcpTraumaRagClient(...)` 之后、`return createTraumaTurnRunner({...})` 之前插入：

```typescript
    const callTraumaTool = async (name: string, toolInput: unknown, signal?: AbortSignal) => {
      const tool = runtime.tools.get(name);
      if (!tool) {
        throw new Error(`Trauma tool is unavailable: ${name}`);
      }
      const output = await tool.execute(toolInput, {
        sessionId: sessionKey,
        turnId: `trauma-parse:${this.options.now().getTime()}`,
        abortSignal: signal,
        cwd: runtime.projectRoot,
        permissionMode: "bypassPermissions",
        permissionContext: createDefaultPermissionContext({
          cwd: runtime.projectRoot,
          mode: "bypassPermissions",
          bypassAvailable: true,
        }),
        now: this.options.now,
      });
      return output.data ?? output.content;
    };

    // 影像判读交给医学微调 VLM；它正是 med_parse_medical 背后的同一个模型，
    // 但 prompt 与输出长度由我们控制，避开那份冗长的通用报告。
    const INTERPRETATION_PROVIDER = "local";
    const INTERPRETATION_MODEL = "G9-V-Med";
    let interpretationSelection = {
      provider: INTERPRETATION_PROVIDER,
      model: INTERPRETATION_MODEL,
    };
    let supportsImages = false;
    try {
      supportsImages = runtime.model
        .getMultimodal(INTERPRETATION_PROVIDER, INTERPRETATION_MODEL)
        .input.includes("image");
    } catch {
      // 配置里没有这个 provider/model，退回主 agent 模型。
      interpretationSelection = modelSelection;
      try {
        supportsImages = runtime.model
          .getMultimodal(modelSelection.provider, modelSelection.model)
          .input.includes("image");
      } catch {
        supportsImages = false;
      }
    }

    const interpreter = createInterpretationStation({
      model: createStructuredModelClient({
        complete: runtime.model.complete.bind(runtime.model),
        stream: runtime.model.stream.bind(runtime.model),
        provider: interpretationSelection.provider,
        model: interpretationSelection.model,
      }),
      parse: createMcpTraumaParseClient(callTraumaTool),
      readImage: async (path) => {
        const data = await readFile(path);
        return { data: data.toString("base64"), mimeType: "image/png" };
      },
      supportsImages,
    });
```

并把 `return createTraumaTurnRunner({...})` 的参数补上 `interpreter,`：

```typescript
    return createTraumaTurnRunner({
      store: createTraumaCaseStore(caseDirectory),
      model,
      rag,
      interpreter,
      audit: this.traumaAudit,
      now: () => this.options.now().toISOString(),
    });
```

- [ ] **Step 4: bridge 路径校验**

在 `ui/server/pilotdeck-bridge.js` 的校验函数区（`sanitizeTraumaFormInput` 附近，约第 1217 行之后）插入：

```javascript
/**
 * 附件路径来自前端，必须是上传端点落盘的 inbox 绝对路径。
 * 放任任意路径会让 med_parse_medical 读到项目外的文件。
 */
function sanitizeTraumaAttachments(value, projectRoot) {
    if (!Array.isArray(value) || !projectRoot) return undefined;
    const inboxRoot = path.resolve(projectRoot, 'inbox');
    const sanitized = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const rawPath = typeof item.path === 'string' ? item.path : '';
        const name = typeof item.name === 'string' ? item.name.trim() : '';
        if (!rawPath || !name) continue;
        const resolved = path.resolve(rawPath);
        if (resolved !== inboxRoot && !resolved.startsWith(`${inboxRoot}${path.sep}`)) continue;
        sanitized.push({ path: resolved, name });
    }
    return sanitized.length > 0 ? sanitized : undefined;
}
```

在读取 trauma 选项处（约第 1300-1302 行）加一行：

```javascript
    const traumaAttachments = sanitizeTraumaAttachments(options?.traumaAttachments, projectRoot);
```

在 `gw.submitTurn({ ... })` 中，`...(traumaExtract ? { traumaExtract: true } : {}),` 之后加一行：

```javascript
            ...(traumaAttachments ? { traumaAttachments } : {}),
```

若该作用域内没有 `projectRoot` 变量，使用该函数中已用于解析项目目录的等价变量（搜索 `projectKey` 附近的项目路径解析），不要新引入解析逻辑。

- [ ] **Step 5: 编译并跑全量 trauma 测试**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/
```

Expected: 全绿（本任务不新增单测，确认装配没破坏既有行为）。

- [ ] **Step 6: 提交**

```bash
git add src/cli/createLocalGateway.ts src/gateway/protocol/types.ts src/gateway/client/InProcessGateway.ts ui/server/pilotdeck-bridge.js
git commit -m "feat(trauma): 装配影像判读工位并透传附件路径"
```

---

### Task 10: UI 上传入口

**Files:**
- Modify: `ui/src/components/chat/utils/sessionLauncher.ts:12`（options 类型）、`:96-123`（解构）、`:128-159`（emit）
- Modify: `ui/src/components/main-content/view/MainContent.tsx:216`、`:245-257`、`:685`
- Modify: `ui/src/components/trauma-workspace/TraumaWorkspace.tsx:25`、`:42`、`:181-189`
- Modify: `ui/src/components/trauma-workspace/TraumaComposer.tsx:14-23`、`:105-107`、`:113-116`、`:123-132`、`:134-154`、`:159-177`
- Test: 手工验收（前端无既有单测基建）

**Interfaces:**
- Consumes: `GatewaySubmitTurnInput.traumaAttachments`（Task 9）、既有 `POST /api/projects/:projectName/upload-attachments`（无需改动）、`medicalFolderUpload.ts` 的 `MEDICAL_ATTACHMENT_EXTENSIONS` / `collectMedicalFilesFromFileList` / `validateAttachmentBatch` / `formatAttachmentLimitErrors` / `ensureUploadFailedMessage`
- Produces:
  - `type TraumaAttachmentDraft = { path: string; name: string }`
  - `TraumaComposer` 的 `onSubmit(form, rawInput, extract?, attachments?)`
  - `TraumaWorkspace` 的 `onSubmitForm(form, rawInput, traumaExtract?, attachments?)`
  - `submitTraumaForm(form, rawInput?, traumaExtract?, attachments?)`
  - `startSessionCommand` options 增 `traumaAttachments?: TraumaAttachmentDraft[]`

> 上传端点的路由参数是 `:projectName`，调用时用 `selectedProject.name`。`TraumaComposer` 目前把 `projectKey` 解构成 `_projectKey` 弃用，本任务需要恢复使用。

- [ ] **Step 1: 打通签名（自底向上，先不做 UI）**

`ui/src/components/chat/utils/sessionLauncher.ts` 的 options 类型中，`traumaExtract?: boolean;` 旁加入：

```typescript
  traumaAttachments?: Array<{ path: string; name: string }>;
```

在解构块加入 `traumaAttachments,`，并在 emit 的 `options` 对象中 `...(traumaExtract ? { traumaExtract: true } : {}),` 之后加入：

```typescript
      ...(Array.isArray(traumaAttachments) && traumaAttachments.length > 0
        ? { traumaAttachments }
        : {}),
```

`MainContent.tsx:216` 的签名改为：

```typescript
  const submitTraumaForm = useCallback((
    form: TurnFormInput,
    rawInput = '',
    traumaExtract = false,
    traumaAttachments: Array<{ path: string; name: string }> = [],
  ) => {
```

在 `startSessionCommand({ ... })` 的 `traumaExtract,` 之后加入：

```typescript
        ...(traumaAttachments.length > 0 ? { traumaAttachments } : {}),
```

`MainContent.tsx:685` 的 props 类型改为：

```typescript
  submitTraumaForm: (
    form: TurnFormInput,
    rawInput?: string,
    traumaExtract?: boolean,
    traumaAttachments?: Array<{ path: string; name: string }>,
  ) => void;
```

`TraumaWorkspace.tsx:25` 改为：

```typescript
  onSubmitForm?: (
    form: TurnFormInput,
    rawInput: string,
    traumaExtract?: boolean,
    attachments?: Array<{ path: string; name: string }>,
  ) => void | Promise<void>;
```

`TraumaComposer.tsx:20` 改为：

```typescript
  onSubmit: (
    form: TurnFormInput,
    rawInput: string,
    extract?: boolean,
    attachments?: Array<{ path: string; name: string }>,
  ) => void | Promise<void>;
```

- [ ] **Step 2: 类型检查前端**

```bash
cd ui && npx tsc --noEmit -p tsconfig.json; cd ..
```

Expected: 通过（签名都是可选参数，旧调用点不受影响）。

- [ ] **Step 3: 在 TraumaComposer 里加附件状态与上传**

把第 105-107 行的解构改回使用 `projectKey`：

```typescript
  projectKey,
  sessionId: _sessionId,
  caseHistory: _caseHistory = '',
```

在第 116 行之后加入状态：

```typescript
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
```

把第 118-119 行的 `busy` 改为：

```typescript
  const busy = submitting || isExtracting || uploading;
```

在第 123-132 行的重置 effect 中补上两行：

```typescript
      setPendingFiles([]);
      setAttachmentError(null);
```

在 `handleExtract` 之前插入选择与上传逻辑：

```typescript
  function handleFilesPicked(list: FileList | null) {
    if (!list || list.length === 0) return;
    const collected = collectMedicalFilesFromFileList(list);
    const incoming = collected.entries.map((item) => item.file);
    const validation = validateAttachmentBatch({
      existingCount: pendingFiles.length,
      existingBytes: totalFileBytes(pendingFiles),
      incoming,
      scanOverflow: collected.scanOverflow,
    });
    if (!validation.ok) {
      setAttachmentError(formatAttachmentLimitErrors(validation.errors));
      return;
    }
    setAttachmentError(collected.warnings[0] ?? null);
    setPendingFiles((current) => [...current, ...incoming]);
  }

  // 上传在提交瞬间完成，而不是在 runner 运行期间等待——附件只对当前轮有效。
  async function uploadPendingFiles(): Promise<Array<{ path: string; name: string }> | null> {
    if (pendingFiles.length === 0) return [];
    if (!projectKey) {
      setAttachmentError('上传失败：当前没有可用的项目。');
      return null;
    }
    const formData = new FormData();
    pendingFiles.forEach((file) => {
      formData.append('attachments', file);
    });
    // 战创伤链路自己做预处理，不需要服务端回传 data-URL 图像。
    formData.append('pathOnlyIndexes', JSON.stringify(pendingFiles.map((_, index) => index)));
    try {
      setUploading(true);
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectKey)}/upload-attachments`,
        { method: 'POST', headers: {}, body: formData },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload?.error === 'string' ? payload.error : '附件上传失败，请稍后重试');
      }
      const result = await response.json();
      const files = [
        ...(Array.isArray(result.files) ? result.files : []),
        ...(Array.isArray(result.images) ? result.images : []),
      ];
      return files
        .filter((file: { path?: string }) => Boolean(file?.path))
        .map((file: { path: string; name: string }) => ({ path: file.path, name: file.name }));
    } catch (error) {
      setAttachmentError(ensureUploadFailedMessage(
        error instanceof Error ? error.message : '未知错误',
      ));
      return null;
    } finally {
      setUploading(false);
    }
  }
```

在文件顶部加入 import：

```typescript
import { authenticatedFetch } from '../../utils/api';
import {
  collectMedicalFilesFromFileList,
  ensureUploadFailedMessage,
  formatAttachmentLimitErrors,
  totalFileBytes,
  validateAttachmentBatch,
  MEDICAL_ATTACHMENT_EXTENSIONS,
} from '../chat/utils/medicalFolderUpload';
```

（`authenticatedFetch` 的实际导入路径以 `useChatComposerState.ts` 中的写法为准，照抄该文件的 import 说明符。）

- [ ] **Step 4: 让两个提交路径带上附件**

`handleExtract` 改为：

```typescript
  async function handleExtract() {
    const trimmed = rawText.trim();
    // 只传附件不写字也是有效输入——判读本身就是本轮的信息。
    if ((!trimmed && pendingFiles.length === 0) || busy) return;
    const attachments = await uploadPendingFiles();
    if (!attachments) return;
    setState({ phase: 'extracting' });
    await onSubmit({
      statedSubStage: freeSubStage,
      injuryNarrative: trimmed.slice(0, 1000),
      treatmentNarrative: '',
      evacuationNarrative: '',
      note: '',
      vitals: {},
    }, trimmed, true, attachments);
  }

  async function handleManualSubmit(form: TurnFormInput) {
    const attachments = await uploadPendingFiles();
    if (!attachments) return;
    await onSubmit(form, rawText.trim(), false, attachments);
  }
```

- [ ] **Step 5: 加上传区 JSX**

在第 170 行 `</textarea>` 之后、第 171 行的 footer `<div>` 之前插入：

```tsx
        {pendingFiles.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {pendingFiles.map((file, index) => (
              <span
                key={`${file.name}:${index}`}
                className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              >
                {file.name}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPendingFiles((current) => current.filter((_, at) => at !== index))}
                  className="text-neutral-400 hover:text-neutral-700 disabled:opacity-50 dark:hover:text-neutral-100"
                  aria-label={`移除附件 ${file.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachmentError && (
          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{attachmentError}</p>
        )}
```

在 footer 行内、`<LevelRadios ... />` 之后插入触发按钮：

```tsx
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={[...MEDICAL_ATTACHMENT_EXTENSIONS].map((ext) => `.${ext}`).join(',')}
            onChange={(event) => {
              handleFilesPicked(event.target.files);
              event.target.value = '';
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => fileInputRef.current?.click()}
            className="shrink-0 rounded-lg border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {uploading ? '上传中…' : '+ 添加医学附件'}
          </button>
```

- [ ] **Step 6: 把附件转发到 TraumaWorkspace / MainContent**

`TraumaWorkspace.tsx:186` 保持 `onSubmit={onSubmitForm}` 不变（签名已兼容）；确认 `MainContent.tsx:1199` 的 `onSubmitForm={submitTraumaForm}` 仍然类型匹配。

- [ ] **Step 7: 前端类型检查与构建**

```bash
cd ui && npx tsc --noEmit -p tsconfig.json && npm run build; cd ..
```

Expected: 通过。

- [ ] **Step 8: 手工冒烟**

1. 启动本地网关与 UI，进入一个战创伤项目。
2. 在输入框点「+ 添加医学附件」，选一个 `.dcm` 与一个 `.pdf`，确认出现 chip。
3. 填写伤情、选级别、提交。
4. 观察进度区出现「附件影像判读」独立一行，且主线仍是 11 步。
5. 观察回答中出现「据影像判读」类表述。
6. 再提交一轮（不带附件），确认上一轮判读仍被引用（跨轮累积生效）。
7. 停掉 8030 端口的判读模型再提交一次带附件的轮次，确认整轮仍正常完成、判读为空。

- [ ] **Step 9: 提交**

```bash
git add ui/src/components/chat/utils/sessionLauncher.ts ui/src/components/main-content/view/MainContent.tsx ui/src/components/trauma-workspace/TraumaWorkspace.tsx ui/src/components/trauma-workspace/TraumaComposer.tsx
git commit -m "feat(trauma): 战创伤输入框支持上传医学附件"
```

---

## 附录：与设计文档的两处偏差

1. **设计文档 §5 说「前端需增加一个事件类型的处理（改动很小）」——实际不需要。** `src/trauma/events.ts` 已有 `countInTotal: false` 机制（`traumaExtractionEvents` 在用），工位 I 复用同一通道，前端零改动。Task 8 据此实现。
2. **设计文档 §4.8 末尾说「`compactCaseStateForDownstream()` 需要相应处理该字段的裁剪」——实际不需要。** 该函数返回的是显式字段的对象字面量（`src/trauma/factMerge.ts:147`），新增的 `CaseState` 字段不会被带出去；判读通过 reasoner 的独立顶层键 `attachmentInterpretation` 传递，裁剪由 `buildInterpretationContext` 负责。

---

### Task 11: 判读文本进入同一条回答消息

> 自检发现的缺口：Task 6 只把判读喂给下游模型，设计文档 §4.9 还要求判读文本**先于推演主文出现在同一条 assistant 消息里**。本任务补上这一段。

**Files:**
- Modify: `src/trauma/runner.ts`（汇合点之后、`beginStep(5, ...)` 之前；以及 `:9xx` 附近 step 9 计算 `naturalLanguageAnswer` 处）
- Test: `tests/trauma/runner.spec.ts`

**Interfaces:**
- Consumes: Task 6 汇合点产出的 `interpretationEntry`（本轮新增的那一条，可能为 `null`）
- Produces:
  - 模块级常量 `export const INTERPRETATION_ANSWER_HEADING = "## 附件影像判读";`
  - 模块级函数 `renderInterpretationSection(text: string): string`
  - 不变量：无附件轮次 `onAssistantTextDelta` 的调用序列与现在完全一致

- [ ] **Step 1: 写失败测试**

追加到 `tests/trauma/runner.spec.ts`：

```typescript
test("the interpretation is streamed ahead of the answer in the same message", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interpret-stream-"));
  try {
    const deltas: string[] = [];
    const runner = createTraumaTurnRunner({
      store: createTraumaCaseStore(root),
      model: model([]),
      rag: rag({ count: 0 }),
      interpreter: interpreter([]),
    });
    const result = await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
      onAssistantTextDelta: (text) => { deltas.push(text); },
    });
    // 判读必须是这条消息里最先推出去的一段。
    assert.ok(deltas[0]?.includes("附件影像判读"));
    assert.ok(deltas[0]?.includes("右侧血气胸"));
    // 落库的回答也要带上这一段，刷新页面后不能凭空消失。
    assert.ok(result.response?.naturalLanguageAnswer.includes("附件影像判读"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a turn without attachments streams nothing extra", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-no-interpret-stream-"));
  try {
    const deltas: string[] = [];
    const runner = createTraumaTurnRunner({
      store: createTraumaCaseStore(root),
      model: model([]),
      rag: rag({ count: 0 }),
    });
    const result = await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      onAssistantTextDelta: (text) => { deltas.push(text); },
    });
    assert.equal(deltas.some((text) => text.includes("附件影像判读")), false);
    assert.equal(result.response?.naturalLanguageAnswer.includes("附件影像判读"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/runner.spec.js
```

Expected: 第一个测试失败（`deltas[0]` 是推演主文的第一段，不含「附件影像判读」）。

- [ ] **Step 3: 写最小实现**

在 `src/trauma/runner.ts` 模块顶层（其他常量附近）加入：

```typescript
export const INTERPRETATION_ANSWER_HEADING = "## 附件影像判读";

function renderInterpretationSection(text: string): string {
  return `${INTERPRETATION_ANSWER_HEADING}\n\n${text.trim()}\n\n`;
}
```

在 Task 6 的汇合点，`interpretationEntry` 求出之后、`await beginStep(5, "baseline_retrieval", ...)` 之前插入：

```typescript
        // 先把判读推出去；后面 baseline_retrieval / merge_retrieval 的进度条
        // 会隔在中间，推演主文随后续到同一条消息上。
        const interpretationSection = interpretationEntry
          ? renderInterpretationSection(interpretationEntry.text)
          : "";
        if (interpretationSection) {
          await input.onAssistantTextDelta?.(interpretationSection);
        }
```

在 step 9 计算 `naturalLanguageAnswer` 处，把赋值改为：

```typescript
        const naturalLanguageAnswer = interpretationSection
          + normalizeChineseDisplayText(normalizedAnswerCitations.answer);
```

> 注意顺序：拼接必须发生在 `normalizeAnswerCitations` / `normalizeChineseDisplayText` **之后**。判读文本里不含角标，提前混入会让角标归一化误判正文边界。

- [ ] **Step 4: 运行测试，确认通过**

```bash
npx tsc -p tsconfig.json && node --test --test-force-exit --test-timeout 60000 dist/tests/trauma/runner.spec.js
```

Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/trauma/runner.ts tests/trauma/runner.spec.ts
git commit -m "feat(trauma): 影像判读随推演主文进入同一条回答消息"
```

---

## 自检结论

**规格覆盖**（对照设计文档 §1–§9）：

| 设计章节 | 对应任务 |
|---|---|
| §4.1 UI 上传区 | Task 10 |
| §4.2 协议层 | Task 6（`TraumaTurnInput`）+ Task 9（`GatewaySubmitTurnInput`） |
| §4.3 网关 trauma 分支 | Task 9 |
| §4.4 modelClient image block | Task 2 |
| §4.5 parseClient | Task 4（逻辑）+ Task 9（装配） |
| §4.6 工位 I 判读 | Task 3（schema）+ Task 5（station）+ Task 9（G9 客户端与能力检查） |
| §4.7 下游消费 | Task 7 |
| §4.8 跨轮累积与字符预算 | Task 1（预算）+ Task 6（累积落库） |
| §4.9 输出呈现 | Task 11 |
| §5 步骤编号与进度上报 | Task 8 |
| §6 影响边界（无附件 / partial / abort） | Task 6 的三个不变量测试 |

**类型一致性**：`TraumaAttachmentRef` / `InterpretationEntry`（Task 1）→ Task 5、6、9、10 全链路同名；`buildInterpretationContext`（Task 1）仅在 Task 6 汇合点调用；`interpretationContext`（Task 6）→ Task 7 的 `buildBaselineQueries(state, interpretation?)` 与 `reason({..., attachmentInterpretation})` 参数名一致。

**占位符扫描**：无 TBD / TODO / 「参照 Task N」。Task 9 与 Task 10 有两处「以该文件现有写法为准」的指示（`projectRoot` 变量名、`authenticatedFetch` 的 import 说明符），均给出了确切的查找依据。
