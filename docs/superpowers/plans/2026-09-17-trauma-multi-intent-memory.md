# Trauma Multi-Intent Preference Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a trauma turn contain both a medical request and preference updates, apply those preferences to the current answer, and persist them as project Feedback for later turns.

**Architecture:** Replace single-purpose routing output with one primary workflow plus validated preference side intents. Build an effective presentation policy from current-turn preferences, deterministic project Feedback, and the global profile; pass that policy to Reasoner or Knowledge QA while keeping workflow execution and Case State mutation deterministic.

**Tech Stack:** TypeScript, Node.js, `node:test`, EdgeClaw memory core, JSON-schema structured model output.

**Spec:** `docs/superpowers/specs/2026-09-17-trauma-multi-intent-memory-design.md`

## Global Constraints

- War-trauma projects remain `feedback_only`; they must not create `user` or `project` memory notes.
- Patient facts, vital signs, injury details, treatment facts, Case State, and PHI must never enter long-term memory.
- Current-turn preferences apply before Index/Dream and remain effective even if persistence fails.
- Feedback may override presentation defaults but never medical safety, evidence, stage, citation, schema, or review-disclaimer requirements.
- Exactly one primary workflow may mutate Case State per turn.
- Existing stored memory and existing Case State formats remain readable without migration.
- Memory failures remain non-fatal to the trauma response.

---

### Task 1: Add The Multi-Intent Extraction Contract

**Files:**
- Modify: `src/trauma/types.ts`
- Modify: `src/trauma/schemas.ts`
- Modify: `src/trauma/formDraft.ts`
- Test: `tests/trauma/schemas.spec.ts`
- Test: `tests/trauma/factMerge.spec.ts`

**Interfaces:**
- Consumes: Existing `TurnFormInput`, `ExtractedTurnForm`, and `TraumaInputIntent`.
- Produces: `TraumaPrimaryIntent`, `TraumaPreferenceCategory`, `ExtractedTraumaPreference`, `TraumaIntentPlan`, and `normalizeTraumaIntentPlan(rawText, extracted)`.

- [ ] **Step 1: Write failing schema tests for preference side intents**

Add cases that accept exact-source preference spans alongside a case update and reject unknown categories or malformed entries:

```ts
const extracted = {
  inputIntent: "case_update",
  scopeReason: "同时包含病例更新和输出偏好",
  preferences: [{
    sourceSpan: "以后先给结论",
    directive: "回答时先给结论",
    category: "format",
  }],
  injuryNarratives: [{ text: "患者右腿持续出血", sourceSpan: "患者右腿持续出血" }],
  treatmentNarratives: [],
  evacuationNarratives: [],
  notes: [],
  vitals: [],
};
assert.equal(validateExtractedTurnForm(extracted), true);
```

- [ ] **Step 2: Run the focused schema tests and verify failure**

Run:

```bash
pnpm exec tsx --test tests/trauma/schemas.spec.ts tests/trauma/factMerge.spec.ts
```

Expected: the new `preferences` contract is not accepted or normalized yet.

- [ ] **Step 3: Add the types and backward-compatible schema**

Define:

```ts
export type TraumaPrimaryIntent =
  | "case_update"
  | "knowledge_question"
  | "system_help"
  | "out_of_scope";

export type TraumaPreferenceCategory =
  | "format"
  | "detail"
  | "language"
  | "workflow";

export type ExtractedTraumaPreference = {
  sourceSpan: string;
  directive: string;
  category: TraumaPreferenceCategory;
};

export type TraumaIntentPlan = {
  primaryIntent: TraumaPrimaryIntent;
  scopeReason: string;
  preferences: ExtractedTraumaPreference[];
  caseForm: TurnFormInput;
  knowledgeQuestion?: string;
};
```

Keep `inputIntent` in `ExtractedTurnForm` for compatibility and add
`preferences?: ExtractedTraumaPreference[]`. Extend the schema with a bounded
array, bounded strings, and the four fixed categories.

- [ ] **Step 4: Implement normalization to the internal plan**

Add:

```ts
export function normalizeTraumaIntentPlan(
  rawText: string,
  extracted: ExtractedTurnForm,
): TraumaIntentPlan {
  const primaryIntent = extractedInputIntent(extracted) === "domain_question_no_case"
    ? "knowledge_question"
    : extractedInputIntent(extracted);
  return {
    primaryIntent,
    scopeReason: extracted.scopeReason ?? "",
    preferences: validateExtractedPreferenceSpans(rawText, extracted.preferences ?? []),
    caseForm: normalizeExtractedForm(extracted),
    ...(primaryIntent === "knowledge_question" ? { knowledgeQuestion: rawText.trim() } : {}),
  };
}
```

`validateExtractedPreferenceSpans` must discard entries whose `sourceSpan` is
empty, absent from `rawText`, or whose normalized directive is empty.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm exec tsx --test tests/trauma/schemas.spec.ts tests/trauma/factMerge.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/trauma/types.ts src/trauma/schemas.ts src/trauma/formDraft.ts tests/trauma/schemas.spec.ts tests/trauma/factMerge.spec.ts
git commit -m "feat(trauma): add multi-intent extraction contract"
```

### Task 2: Teach The Extractor To Separate Preferences From Medical Content

**Files:**
- Modify: `src/trauma/stations/extractorPrompt.ts`
- Modify: `src/trauma/stations/extractor.ts`
- Test: `tests/trauma/schemas.spec.ts`
- Test: `tests/trauma/routing.spec.ts`

**Interfaces:**
- Consumes: `ExtractedTurnForm.preferences` and the validation rules from Task 1.
- Produces: Model output that identifies preference spans independently of the primary intent.

- [ ] **Step 1: Add failing mixed-intent routing fixtures**

Cover at least these inputs:

```text
以后先给结论。患者心率 130。
解释止血带使用原则，以后回答简洁一些。
以后所有回答使用表格。
患者血压 80/50。
```

Assert respectively:

```text
case_update + one format preference
knowledge_question + one detail preference
out_of_scope + one format preference
case_update + no preference
```

- [ ] **Step 2: Run tests and verify the new expectations fail**

Run:

```bash
pnpm exec tsx --test tests/trauma/schemas.spec.ts tests/trauma/routing.spec.ts
```

- [ ] **Step 3: Extend the extraction prompt and examples**

Add a `preferences` array to the required JSON output. State explicitly:

```text
偏好更新与 primary intent 相互独立。
即使主意图是 case_update、knowledge_question、system_help 或 out_of_scope，
都必须单独识别用户明确提出的格式、详略、语言和工作流偏好。
sourceSpan 必须是 currentUserInput 中连续存在的原文。
不得把病例事实、医疗建议或助手推断写成偏好。
```

Add few-shot examples for preference-only, case-plus-preference, and
knowledge-plus-preference messages.

- [ ] **Step 4: Keep extractor failure behavior conservative**

When extraction fails, retain the existing fallback case form and set
`preferences: []`. Never infer preferences from the fallback text.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm exec tsx --test tests/trauma/schemas.spec.ts tests/trauma/routing.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/trauma/stations/extractorPrompt.ts src/trauma/stations/extractor.ts tests/trauma/schemas.spec.ts tests/trauma/routing.spec.ts
git commit -m "feat(trauma): extract preference side intents"
```

### Task 3: Validate Preferences Once For Immediate Use And Persistence

**Files:**
- Create: `src/trauma/memory/TraumaPreferencePolicy.ts`
- Modify: `src/trauma/memory/TraumaMemoryCapturePolicy.ts`
- Test: `tests/trauma/memoryCapturePolicy.spec.ts`
- Create: `tests/trauma/preferencePolicy.spec.ts`

**Interfaces:**
- Consumes: `ExtractedTraumaPreference[]`, raw user text, and existing PHI redaction.
- Produces: `ValidatedTraumaPreference[]` and capture input that no longer reparses the full raw message.

- [ ] **Step 1: Write failing validation tests**

Test exact-source validation, category preservation, length limits, PHI
redaction, and rejection of clinical content:

```ts
const result = validateTraumaPreferences({
  rawText: "以后先给结论。患者心率 130。",
  preferences: [{
    sourceSpan: "以后先给结论",
    directive: "回答时先给结论",
    category: "format",
  }],
});
assert.deepEqual(result.accepted.map((item) => item.directive), ["回答时先给结论"]);
```

Also assert that a preference span containing `患者心率 130` is rejected.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm exec tsx --test tests/trauma/preferencePolicy.spec.ts tests/trauma/memoryCapturePolicy.spec.ts
```

- [ ] **Step 3: Implement the focused policy module**

Define:

```ts
export type ValidatedTraumaPreference = {
  directive: string;
  category: TraumaPreferenceCategory;
  redactedCount: number;
  redactedHits: string[];
};

export type TraumaPreferenceValidationResult = {
  accepted: ValidatedTraumaPreference[];
  rejected: Array<{ sourceSpan: string; reason: string }>;
};

export function validateTraumaPreferences(input: {
  rawText: string;
  preferences: readonly ExtractedTraumaPreference[];
}): TraumaPreferenceValidationResult;
```

Move the clinical-pattern check behind a reusable exported helper. Apply it to
each extracted preference span, then run `redact()` over the directive.

- [ ] **Step 4: Change capture to consume validated directives**

Replace raw-message reparsing in the sink input with:

```ts
export type TraumaMemoryCaptureSink = (input: {
  sessionId: string;
  preferences: readonly ValidatedTraumaPreference[];
  turnStatus: TraumaTurnStatus;
}) => void;
```

Join accepted directives only when constructing the L0 capture text. Preserve
the `off`, incomplete-turn, audit, PHI, and `feedback_only` behavior.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm exec tsx --test tests/trauma/preferencePolicy.spec.ts tests/trauma/memoryCapturePolicy.spec.ts
```

Expected: PASS, including the existing `allowedTypes` bypass test.

- [ ] **Step 6: Commit**

```bash
git add src/trauma/memory/TraumaPreferencePolicy.ts src/trauma/memory/TraumaMemoryCapturePolicy.ts tests/trauma/preferencePolicy.spec.ts tests/trauma/memoryCapturePolicy.spec.ts
git commit -m "refactor(trauma): validate feedback before use and capture"
```

### Task 4: Add Deterministic Baseline Preference Reads

**Files:**
- Modify: `src/context/memory/MemoryDomainFacade.ts`
- Modify: `src/context/memory/edgeclaw-memory-core/src/service.ts`
- Modify: `src/context/memory/edgeclaw-memory-core/src/core/index.ts`
- Modify generated build output under: `src/context/memory/edgeclaw-memory-core/lib/`
- Test: `tests/trauma/memoryContext.spec.ts`
- Test: `src/context/memory/edgeclaw-memory-core/test/service.test.ts`

**Interfaces:**
- Consumes: Existing global user summary and project-scoped Feedback records.
- Produces: `EdgeClawMemoryService.readPresentationMemory()` and `MemoryDomainFacade.readPresentationMemory()`.

- [ ] **Step 1: Write failing service tests for gate-independent reads**

Seed a global profile and project Feedback, force the semantic route to `none`,
and assert:

```ts
const memory = service.readPresentationMemory();
assert.match(memory.globalProfile ?? "", /临床偏好/);
assert.match(memory.projectFeedback ?? "", /先给结论/);
```

Also seed a project memory record containing a patient fact and assert that it
is absent.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
npm --prefix src/context/memory/edgeclaw-memory-core test
pnpm exec tsx --test tests/trauma/memoryContext.spec.ts
```

- [ ] **Step 3: Add the narrow EdgeClaw service method**

Define:

```ts
export type PresentationMemorySnapshot = {
  globalProfile?: string;
  projectFeedback?: string;
};

readPresentationMemory(options?: {
  feedbackLimit?: number;
}): PresentationMemorySnapshot;
```

Implementation requirements:

- Read the canonical compact global user profile through the existing global
  user store.
- List only `kinds: ["feedback"]`, `scope: "project"`, and
  `includeDeprecated: false`.
- Sort newest first and cap the number of loaded Feedback files.
- Never read `project` or `general_project_meta` records.
- Return strings only; do not expose the repository to Trauma.

- [ ] **Step 4: Project and sanitize through MemoryDomainFacade**

Add:

```ts
export type TraumaPreferenceMemory = {
  globalProfile?: string;
  projectFeedback?: string;
};

readPresentationMemory(): TraumaPreferenceMemory | null;
```

Reuse existing redaction and character limits. Keep `read({ query })` during
the transition, but move Trauma callers to the deterministic method in Task 6.

- [ ] **Step 5: Build the vendored package and run tests**

Run:

```bash
npm --prefix src/context/memory/edgeclaw-memory-core test
npm --prefix src/context/memory/edgeclaw-memory-core run build
pnpm exec tsx --test tests/trauma/memoryContext.spec.ts
```

Expected: PASS and generated `lib` declarations expose the new method.

- [ ] **Step 6: Commit**

```bash
git add src/context/memory/MemoryDomainFacade.ts src/context/memory/edgeclaw-memory-core/src src/context/memory/edgeclaw-memory-core/lib tests/trauma/memoryContext.spec.ts
git commit -m "feat(memory): add deterministic trauma preference reads"
```

### Task 5: Build The Effective Presentation Policy

**Files:**
- Create: `src/trauma/memory/EffectivePresentationPolicy.ts`
- Modify: `src/trauma/memory/TraumaMemoryContext.ts`
- Create: `tests/trauma/effectivePresentationPolicy.spec.ts`
- Modify: `tests/trauma/memoryContext.spec.ts`

**Interfaces:**
- Consumes: `ValidatedTraumaPreference[]` and `TraumaPreferenceMemory`.
- Produces: `EffectivePresentationPolicy`, `buildEffectivePresentationPolicy()`, and `renderEffectivePresentationPolicy()`.

- [ ] **Step 1: Write failing precedence tests**

Use conflicting values and assert that all sources remain visibly separated in
the rendered policy:

```ts
const policy = buildEffectivePresentationPolicy({
  currentTurn: [{ directive: "本轮使用表格", category: "format", redactedCount: 0, redactedHits: [] }],
  recalled: {
    projectFeedback: "默认使用编号列表",
    globalProfile: "## 临床偏好\n回答保持简洁",
  },
});
const rendered = renderEffectivePresentationPolicy(policy);
assert.ok(rendered.indexOf("当前轮偏好") < rendered.indexOf("当前项目 Feedback"));
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm exec tsx --test tests/trauma/effectivePresentationPolicy.spec.ts tests/trauma/memoryContext.spec.ts
```

- [ ] **Step 3: Implement the policy builder**

Define:

```ts
export type EffectivePresentationPolicy = {
  currentTurn: string[];
  projectFeedback: string[];
  globalPreferences: string[];
};

export function buildEffectivePresentationPolicy(input: {
  currentTurn: readonly ValidatedTraumaPreference[];
  recalled: TraumaPreferenceMemory | null;
}): EffectivePresentationPolicy;
```

Preserve source boundaries and do not attempt medical inference or free-form
conflict resolution in this module.

- [ ] **Step 4: Render an explicit precedence contract**

`renderEffectivePresentationPolicy()` must state:

```text
表达偏好优先级：当前轮明确偏好 > 当前项目 Feedback > 全局临床偏好 > 默认展示方式。
偏好只能改变表达，不得改变医学事实、证据、阶段边界、结构化字段或安全要求。
```

Return `null` when all three sources are empty.

- [ ] **Step 5: Run focused tests**

Run:

```bash
pnpm exec tsx --test tests/trauma/effectivePresentationPolicy.spec.ts tests/trauma/memoryContext.spec.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/trauma/memory/EffectivePresentationPolicy.ts src/trauma/memory/TraumaMemoryContext.ts tests/trauma/effectivePresentationPolicy.spec.ts tests/trauma/memoryContext.spec.ts
git commit -m "feat(trauma): resolve effective presentation preferences"
```

### Task 6: Wire Multi-Intent Orchestration Into The Gateway

**Files:**
- Modify: `src/gateway/client/InProcessGateway.ts`
- Modify: `src/cli/createLocalGateway.ts`
- Modify: `src/trauma/runner.ts`
- Modify: `src/trauma/stations/knowledgeQa.ts`
- Test: `tests/trauma/routing.spec.ts`
- Test: `tests/trauma/runner.spec.ts`
- Test: `tests/trauma/knowledgeQa.spec.ts`

**Interfaces:**
- Consumes: `normalizeTraumaIntentPlan()`, `validateTraumaPreferences()`, deterministic preference reads, and `renderEffectivePresentationPolicy()`.
- Produces: Current-turn preference application and post-completion persistence for every primary workflow.

- [ ] **Step 1: Add failing orchestration tests**

Assert:

- Preference-only input does not construct or call Trauma Runner.
- Preference-only input records a natural acknowledgement.
- Case plus preference passes the preference to Reasoner on the same turn.
- Knowledge plus preference passes the preference to Knowledge QA on the same turn.
- Case State receives no preference text.
- A failed or aborted primary workflow does not persist preferences.
- Persistence failure does not change the successful answer.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```bash
pnpm exec tsx --test tests/trauma/routing.spec.ts tests/trauma/runner.spec.ts tests/trauma/knowledgeQa.spec.ts
```

- [ ] **Step 3: Build the per-turn policy before dispatch**

In the Trauma branch:

```ts
const plan = normalizeTraumaIntentPlan(rawText, extracted);
const preferenceValidation = validateTraumaPreferences({
  rawText,
  preferences: plan.preferences,
});
const recalled = await traumaPreferenceProvider?.();
const presentationPolicy = renderEffectivePresentationPolicy(
  buildEffectivePresentationPolicy({
    currentTurn: preferenceValidation.accepted,
    recalled,
  }),
);
```

Retrieval failure must yield a policy containing current-turn preferences only.

- [ ] **Step 4: Replace the single-intent branch with deterministic dispatch**

Implement this order:

```text
case_update       -> Runner
knowledge_question -> Knowledge QA
system_help       -> help response
out_of_scope      -> scope response
```

When `preferences.length > 0` and there is no medical primary workflow, return
a preference acknowledgement instead of only the out-of-scope text. When an
unrelated remainder exists, append a short scope note after the acknowledgement.

- [ ] **Step 5: Pass the same rendered policy to both model paths**

Rename the model input field from the broad `memoryContext` to
`presentationPolicy` in Runner and Knowledge QA requests. During migration,
accept the old optional argument in internal TypeScript types only if needed by
existing tests; do not emit both fields to the model.

- [ ] **Step 6: Persist accepted preferences only after successful completion**

Call the capture sink with:

```ts
captureTraumaMemory?.({
  projectKey,
  sessionId,
  preferences: preferenceValidation.accepted,
  turnStatus: "completed",
});
```

Apply this consistently to case, knowledge, help, out-of-scope, and
preference-only success paths. Do not call it from error or abort handling.

- [ ] **Step 7: Run focused tests**

Run:

```bash
pnpm exec tsx --test tests/trauma/routing.spec.ts tests/trauma/runner.spec.ts tests/trauma/knowledgeQa.spec.ts tests/trauma/memoryCapturePolicy.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/gateway/client/InProcessGateway.ts src/cli/createLocalGateway.ts src/trauma/runner.ts src/trauma/stations/knowledgeQa.ts tests/trauma/routing.spec.ts tests/trauma/runner.spec.ts tests/trauma/knowledgeQa.spec.ts tests/trauma/memoryCapturePolicy.spec.ts
git commit -m "feat(trauma): orchestrate primary and preference intents"
```

### Task 7: Make Default Presentation Overridable

**Files:**
- Modify: `src/trauma/stations/reasonerPrompt.ts`
- Modify: `src/trauma/stations/knowledgeQaPrompt.ts`
- Modify: `src/trauma/stations/reasoner.ts`
- Modify: `src/trauma/stations/knowledgeQa.ts`
- Test: `tests/trauma/reasoner.spec.ts`
- Test: `tests/trauma/knowledgeQa.spec.ts`
- Test: `tests/trauma/memoryContext.spec.ts`

**Interfaces:**
- Consumes: Rendered `presentationPolicy` from Task 5.
- Produces: Flexible natural-language rendering with unchanged structured clinical output.

- [ ] **Step 1: Write failing prompt-contract tests**

Assert that the Reasoner prompt contains both concepts:

```text
必须覆盖：结论、确认阶段、当前措施、阶段/后送建议、关键缺失信息
没有适用表达偏好时，默认使用五段式
```

Assert that it no longer contains `缺一不可`, and that both prompts state the
presentation precedence and non-overridable safety boundary.

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
pnpm exec tsx --test tests/trauma/reasoner.spec.ts tests/trauma/knowledgeQa.spec.ts tests/trauma/memoryContext.spec.ts
```

- [ ] **Step 3: Split content requirements from presentation defaults**

Rewrite the Reasoner natural-language section so the five content groups remain
required but headings, order, and table/list rendering are defaults. Explicitly
allow `presentationPolicy` to override defaults while preserving all Global
Constraints.

- [ ] **Step 4: Update the model payloads**

Send:

```ts
{
  confirmedPlacement,
  state,
  attachmentInterpretation,
  presentationPolicy: input.presentationPolicy ?? null,
  promptChunks,
}
```

Knowledge QA sends the same field beside `question`, `rewrittenQueries`, and
`promptChunks`.

- [ ] **Step 5: Add model-spy assertions**

Verify that current-turn, project, and global sources appear in the model input
in the documented priority order, and that `null` is sent when no preference is
available.

- [ ] **Step 6: Run focused tests**

Run:

```bash
pnpm exec tsx --test tests/trauma/reasoner.spec.ts tests/trauma/knowledgeQa.spec.ts tests/trauma/memoryContext.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/trauma/stations/reasonerPrompt.ts src/trauma/stations/knowledgeQaPrompt.ts src/trauma/stations/reasoner.ts src/trauma/stations/knowledgeQa.ts tests/trauma/reasoner.spec.ts tests/trauma/knowledgeQa.spec.ts tests/trauma/memoryContext.spec.ts
git commit -m "feat(trauma): make answer presentation preference-driven"
```

### Task 8: Add End-To-End Memory Lifecycle Coverage

**Files:**
- Modify: `tests/trauma/routing.spec.ts`
- Modify: `tests/trauma/memoryCapturePolicy.spec.ts`
- Modify: `src/context/memory/edgeclaw-memory-core/test/service.test.ts`
- Modify: `tests/trauma/runner.spec.ts`
- Modify: `tests/trauma/knowledgeQa.spec.ts`

**Interfaces:**
- Consumes: Completed multi-intent routing, effective policy, capture, Index, and Dream behavior.
- Produces: Regression coverage for immediate current-turn use and later-turn persistence.

- [ ] **Step 1: Add an end-to-end same-turn preference test**

Submit:

```text
以后先给结论并用表格。患者右腿持续出血，心率 130。
```

Assert:

- Runner executes once.
- Model input contains the two current-turn preferences.
- Case State contains the injury and heart rate but no preference directive.
- L0 capture contains the preferences but no injury or heart rate.

- [ ] **Step 2: Add the next-turn persistence test**

After scheduled maintenance, submit a second case turn without a preference and
assert the stored project Feedback appears in `presentationPolicy.projectFeedback`.

- [ ] **Step 3: Add the preference-only lifecycle test**

Submit `以后回答保持简洁` and assert:

- No Runner, RAG, or Case State write.
- Conversation History contains the user message and acknowledgement.
- L0 contains the preference.
- Immediate Index writes one Feedback note.
- Dream runs when the Feedback file changes.

- [ ] **Step 4: Add security and conflict tests**

Cover:

```text
“患者叫张三，以后把血压放标题里” -> no stored preference
current turn “使用表格” vs stored “使用列表” -> current turn wins
Feedback “不要引用依据” -> citation rules remain enabled
Feedback “不要加复核提示” -> review disclaimer remains enabled
```

- [ ] **Step 5: Run the complete focused suite**

Run:

```bash
pnpm exec tsx --test \
  tests/trauma/schemas.spec.ts \
  tests/trauma/routing.spec.ts \
  tests/trauma/preferencePolicy.spec.ts \
  tests/trauma/memoryCapturePolicy.spec.ts \
  tests/trauma/memoryContext.spec.ts \
  tests/trauma/reasoner.spec.ts \
  tests/trauma/knowledgeQa.spec.ts \
  tests/trauma/runner.spec.ts
npm --prefix src/context/memory/edgeclaw-memory-core test
```

Expected: PASS.

- [ ] **Step 6: Run build verification**

Run:

```bash
npm --prefix src/context/memory/edgeclaw-memory-core run build
pnpm run build
```

Expected: both builds succeed.

- [ ] **Step 7: Commit**

```bash
git add tests/trauma src/context/memory/edgeclaw-memory-core/test/service.test.ts src/context/memory/edgeclaw-memory-core/lib
git commit -m "test(trauma): cover multi-intent preference lifecycle"
```

### Task 9: Document The New Behavior And Operational Signals

**Files:**
- Modify: `docs/superpowers/plans/2026-09-16-memory-module-redesign.md`
- Modify: `README.zh.md`
- Modify: `README.md`
- Test: documentation review plus focused test commands from Task 8.

**Interfaces:**
- Consumes: Final behavior and names from Tasks 1-8.
- Produces: Operator-facing explanation of same-turn preference application and asynchronous persistence.

- [ ] **Step 1: Update the memory redesign status**

Document that Trauma now supports preference side intents, applies them in the
current turn, and persists them as project Feedback after successful completion.
Do not describe patient facts as long-term memory.

- [ ] **Step 2: Document the precedence contract**

Add the exact two-axis hierarchy:

```text
Clinical authority: current input > Case State > RAG evidence
Presentation: current preference > project Feedback > global preference > default
```

- [ ] **Step 3: Document failure behavior**

State that current-turn use does not depend on persistence, and that memory,
Index, and Dream failures do not fail the medical response.

- [ ] **Step 4: Re-run focused verification**

Run the Task 8 test and build commands. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-09-16-memory-module-redesign.md README.zh.md README.md
git commit -m "docs: explain trauma multi-intent preference flow"
```

## Final Verification

- [ ] Run `git diff --check`.
- [ ] Run the complete focused test suite from Task 8.
- [ ] Run `npm --prefix src/context/memory/edgeclaw-memory-core run build`.
- [ ] Run `pnpm run build`.
- [ ] Confirm a preference-only turn does not create or modify Case State.
- [ ] Confirm a mixed case/preference turn applies the preference before the first streamed answer token.
- [ ] Confirm L0, generated Feedback, Index traces, and Dream traces contain no patient facts or PHI.
- [ ] Confirm the existing project worktree changes remain untouched except for files explicitly changed by this plan.
