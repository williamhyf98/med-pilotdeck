# Trauma Structured Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 trauma 表单提交后的助手回答在 Runner 尚未结束时，以真实模型增量流的方式显示在现有 ChatInterfaceV2 assistant 气泡中，同时保持结构化病例结果的严格校验和持久化。

**Architecture:** 复用现有 `ModelRuntime.stream()` 和统一 `CanonicalModelEvent` 协议，新增结构化 JSON 流式客户端，仅从增量 JSON 中提取 `naturalLanguageAnswer` 并回调给 Runner。Runner 将这些增量转发为现有 `assistant_text_delta` 网关事件；JSON 完整后再统一校验其余结构化字段，继续执行 Gate、证据标记和快照持久化。前端复用已有 session store、WebSocket frame 映射和 `MessageRowV2`，仅补充 trauma 表单提交后的立即用户气泡。

**Tech Stack:** TypeScript, Node.js async iterators, existing `ModelRuntime.stream`, CanonicalModelEvent, Vitest, React ChatInterfaceV2/session store.

**Spec:** 本轮对话中已确认的“方案 B：结构化 JSON 真流式输出”设计。

## Global Constraints

- 不增加 Runner 的模型调用次数。
- 保留 Runner 14 步编号和现有单波 RAG。
- 只有 `naturalLanguageAnswer` 可进入用户可见 assistant 气泡。
- 其他结构化字段必须等完整 JSON 后通过现有 schema 校验，失败时不得持久化病例快照。
- 用户可见文本继续要求中文，并保留后端中文归一化作为兜底。
- 复用现有 ChatInterfaceV2、MessagesPaneV2、MessageRowV2 和 session store。

### Task 1: 扩展结构化模型客户端的流式接口

**Files:**
- Modify: `src/trauma/modelClient.ts`
- Modify: `src/cli/createLocalGateway.ts:638-645`
- Test: `tests/trauma/modelClient.spec.ts`
- Create: `src/trauma/streamingJson.ts`
- Test: `tests/trauma/streamingJson.spec.ts`

**Interfaces:**
- `StructuredModelClient.streamJson<T>(input, callbacks): Promise<T>`
- `CreateStructuredModelClientOptions` additionally consumes `stream: ModelRuntime["stream"]`
- `extractNaturalLanguageAnswerDelta` consumes text/tool-call JSON fragments and produces safe visible text deltas.

- [ ] **Step 1: Write failing parser tests** for split JSON strings, escaped newlines/quotes, field-before-answer, and complete answer flush.
- [ ] **Step 2: Run parser tests** and verify they fail because the parser does not exist.
- [ ] **Step 3: Implement a small incremental JSON field extractor** that buffers raw fragments, tracks JSON string state, decodes only complete string fragments for `naturalLanguageAnswer`, and flushes the final buffered text.
- [ ] **Step 4: Add `streamJson` to the client** using `options.stream(request)` with `stream: true`, `outputSchema`, existing CanonicalModelEvent normalization, and final `extractStructuredOutput`-equivalent validation.
- [ ] **Step 5: Preserve Anthropic forced-output-tool behavior** by collecting `tool_call_delta` for `__output__` and handling `tool_call_end`; preserve OpenAI/Google text JSON behavior through `text_delta`.
- [ ] **Step 6: Wire `runtime.model.stream.bind(runtime.model)` in `createLocalGateway`.`
- [ ] **Step 7: Run parser/client tests** and verify they pass.

### Task 2: Stream reasoner natural-language output through Runner

**Files:**
- Modify: `src/trauma/stations/reasoner.ts`
- Modify: `src/trauma/runner.ts`
- Test: `tests/trauma/reasoner.spec.ts`
- Test: `tests/trauma/runner.spec.ts`

**Interfaces:**
- `reasoner.reason({ state, promptChunks, onNaturalLanguageDelta? })`
- `TraumaTurnInput.onAssistantTextDelta?: (text: string) => void | Promise<void>`

- [ ] **Step 1: Add failing reasoner test** asserting deltas are forwarded before the structured result resolves.
- [ ] **Step 2: Add failing Runner test** asserting `onAssistantTextDelta` receives multiple chunks and the final response is still fully validated.
- [ ] **Step 3: Implement callback plumbing** from Runner step 9 into reasoner and from reasoner into `streamJson`.
- [ ] **Step 4: Keep existing post-stream constraints** (`assertKnownEvidence`, treatment-plan constraints, Chinese normalization, transition confirmation false).
- [ ] **Step 5: Run focused reasoner/runner tests** and verify they pass.

### Task 3: Forward real deltas through the trauma gateway

**Files:**
- Modify: `src/gateway/client/InProcessGateway.ts`
- Modify: `src/trauma/events.ts`
- Test: `tests/trauma/routing.spec.ts`
- Test: `tests/gateway/traumaRpc.spec.ts` if needed

**Interfaces:**
- Existing `GatewayEvent` type `assistant_text_delta` remains unchanged.
- `traumaTurnEvents` no longer emits the full answer as a second duplicate delta when streaming already occurred.

- [ ] **Step 1: Add failing routing test** asserting multiple assistant delta events are emitted before `turn_completed`, with no duplicate full-answer delta.
- [ ] **Step 2: Pass `onAssistantTextDelta` from `InProcessGateway` to `runner.runTurn`.`
- [ ] **Step 3: Track whether any visible delta was emitted for the turn.`
- [ ] **Step 4: Change final event emission** to send only a fallback full answer when no delta was emitted; otherwise emit only `turn_completed`.
- [ ] **Step 5: Normalize Chinese text safely** at final flush and avoid exposing partial internal enum fragments.
- [ ] **Step 6: Run gateway/routing tests** and verify they pass.

### Task 4: Make trauma form submission immediately render the user bubble

**Files:**
- Modify: `ui/src/components/main-content/view/MainContent.tsx`
- Modify: `ui/src/components/chat-v2/ChatInterfaceV2.tsx`
- Modify: `ui/src/components/chat/hooks/useChatSessionState.ts` only if an explicit optimistic-message hook is required
- Test: `ui/src/components/main-content/view/MainContent.test.tsx`
- Test: `ui/src/components/chat-v2/ChatInterfaceV2.layout.test.tsx` or a focused new test

**Interfaces:**
- Trauma workspace passes a formatted visible input to ChatInterfaceV2 through a narrow callback/prop.
- The existing `addMessage` path remains the source of optimistic user rows.

- [ ] **Step 1: Add failing UI test** asserting form submission immediately produces a user message containing separate Chinese lines.
- [ ] **Step 2: Expose a minimal `onTraumaFormSubmit`/optimistic message bridge** from ChatInterfaceV2 to the parent without exposing internal store implementation broadly.
- [ ] **Step 3: Invoke the optimistic user-message path before `startSessionCommand`.`
- [ ] **Step 4: Ensure temporary-session handoff dedupes the optimistic row exactly once.
- [ ] **Step 5: Keep the composer hidden for trauma while retaining the same message pane and stream handlers.
- [ ] **Step 6: Run focused UI tests** and verify they pass.

### Task 5: Verify end-to-end behavior and failure safety

**Files:**
- Modify: relevant test files from Tasks 1–4 only if fixes are required.
- Test: all focused trauma/model/gateway/UI tests.

- [ ] **Step 1: Run TypeScript checks** for root and UI packages.
- [ ] **Step 2: Run focused trauma tests** covering parser, reasoner, runner, routing, and gateway.
- [ ] **Step 3: Run focused UI tests** covering MainContent and ChatInterfaceV2.
- [ ] **Step 4: Run the broader existing test command** available in the repository.
- [ ] **Step 5: Inspect the diff for duplicate assistant output, raw JSON leakage, internal enum leakage, and snapshot writes after schema failure.
- [ ] **Step 6: Report exact commands and results.**
