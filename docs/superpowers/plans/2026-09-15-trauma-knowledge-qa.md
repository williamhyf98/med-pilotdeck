# 战创伤知识问答独立链路实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `domain_question_no_case` 增加独立的战创伤知识问答链路：先基于对话历史重写/拆分 Query，再直接复用 Runner 的 baseline retrieval 与 merge retrieval，最后使用专属知识问答 Prompt 流式回答，并复用现有正文角标和“参考来源”展示。

**Architecture:** Extractor 判断为 `domain_question_no_case` 后，网关读取最近的用户/助手对话文本，将当前问题交给 Query Rewriter。Rewriter 输出 1～4 个适合检索的 Query；这些 Query 转换为现有 baseline retrieval 所需的计划查询格式，并调用同一个 `TraumaRagClient` 并行检索，随后直接调用现有 `mergeRetrieval` 产生 `promptChunks`。知识问答模型只消费这些 chunks，不进入 Trauma Runner，也不写入病例状态。

**Tech Stack:** TypeScript、`StructuredModelClient`、`TraumaRagClient`、现有 `buildBaselineQueries`/baseline retrieval 调用模式、`mergeRetrieval`、Gateway event protocol、React Chat V2 citation renderer、Node test runner。

**Spec:** 本文档即本功能的设计规格与执行计划。

## Global Constraints

- `caseHistory` 仍然只表示压缩后的病例状态历史；知识问题改写使用独立的 `recentConversation`。
- 不复制实现 chunk 去重、remote/local 选择、排序、prompt chunk 截断和 metadata 解析；统一调用现有 baseline retrieval 与 `mergeRetrieval`。
- 允许对现有 baseline/merge 增加最小的通用入口或适配类型，但不得为知识问答创建第二套 merge 算法。
- Query Rewriter 只生成检索 Query，不回答问题、不生成处置建议。
- 多 Query 检索继续使用 `Promise.all`，并传递同一个 `AbortSignal`。
- `domain_question_no_case` 不调用 `TraumaTurnRunner.runTurn`，不执行 placement、gate、reasoner、memo、snapshot 或流程图节点写入。
- 知识问答复用 Runner 的 `TraumaRagClient`、MCP 工具、topic、top-k 和远程→本地 fallback。
- 正文角标和来源列表复用现有 `assistant_text_delta` / `assistant_text_end` citation 机制。

---

## 当前可直接复用的实现

当前 Runner 已经提供以下能力：

1. `createMcpTraumaRagClient`
   - 调用同一 MCP RAG 工具；
   - 统一处理远程结果、本地 fallback 和 payload；
   - 解析 chunk metadata。

2. `src/trauma/runner.ts` 的 baseline retrieval 执行模式：

```ts
const results = await Promise.all(
  queries.map(async (query) => {
    const result = await rag.query({
      query: query.query,
      top_k: TRAUMA_RAG_TOP_K,
      topic: TRAUMA_RAG_TOPIC,
      signal,
    });
    return {
      query,
      chunks: result.chunks,
      backend: result.retrieval_backend,
    };
  }),
);
```

3. `src/trauma/rag/merge.ts` 的 `mergeRetrieval`
   - 以 `chunk_id` 去重；
   - remote/local 结果选择；
   - score 排序；
   - 截断到 `MAX_PROMPT_CHUNKS`；
   - 转换为 `EvidenceChunk`；
   - 章节、标题和正文 metadata 处理；
   - 生成 `promptChunks`。

4. Runner 的引用处理：
   - 根据 `promptChunks` 生成候选 citation metadata；
   - 根据正文实际出现的 `[N]` 筛选最终 citations；
   - 在 `assistant_text_end` 下发最终来源列表。

因此，本功能不新增 `knowledgeQaMerge.ts`，也不复制 RAG 去重和排序逻辑。

## 必须保留的最小改造点

当前 `mergeRetrieval` 的输入类型是 `PlannedRagQuery`，其 `kind` 只能是：

```ts
"stage" | "classification_transport" | "primary_injury"
```

知识问答的 Query 不属于这三个语义类别。因此需要采用以下最小改造：

1. 抽取一个共享的 baseline retrieval executor；
2. 让 `mergeRetrieval` 接受知识 Query 的最小适配字段；
3. 保留 Runner 当前的 `RetrievalTrace` 和 coverage gap 行为；
4. 知识问答只消费 `merged.promptChunks`，不消费 Runner 的 gate coverage。

不应把所有知识 Query 强行标记为 `primary_injury`，也不应复制 `mergeRetrieval`。

## 目标链路

```text
submitTurn
  ↓
Extractor
  ↓
inputIntent = domain_question_no_case
  ↓
读取 recentConversation
  ↓
Query Rewriter：口语标准化 + 指代消解 + 多问题分解
  ↓
转换为共享 RetrievalQuery
  ↓
复用 baseline retrieval 的 Promise.all 并行 RAG 调用
  ↓
直接调用现有 mergeRetrieval
  ↓
从 merged.promptChunks 生成 citations
  ↓
知识问答 Prompt 流式回答
  ↓
assistant_text_delta：候选 citations
  ↓
assistant_text_end：实际 citations
  ↓
记录普通对话，不写病例状态
```

## 数据契约

### 最近对话上下文

新增内部 helper：

```ts
type RecentConversationMessage = {
  role: "user" | "assistant";
  text: string;
};

async function loadRecentConversation(input: {
  sessionKey: string;
  projectKey: string;
  limit: number;
}): Promise<string>;
```

实现要求：

- 通过 `readSessionMessages({ sessionKey, projectKey, limit, direction: "backward" })` 读取；
- 只保留用户和助手的可见文本；
- 排除工具调用、系统消息、流程步骤和细节页结构化消息；
- 排除当前正在提交的用户输入；
- 反转为时间正序；
- 单条最多 800 字，总上下文最多 3,000 字；
- 读取失败时返回空字符串并记录 warning；
- 使用以下边界传给 Query Rewriter：

```text
<recentConversation>
<turn role="user">...</turn>
<turn role="assistant">...</turn>
</recentConversation>
```

`recentConversation` 不得传给 `ExtractorInput.caseHistory`。

### Query Rewriter 输出

```ts
type KnowledgeQueryRewrite = {
  rewrittenQueries: Array<{
    query: string;
    reason: string;
  }>;
  unresolvedReferences: string[];
  needsClarification: boolean;
};
```

约束：

- 生成 1～4 条 Query；
- 每条 Query 只表达一个主要检索意图；
- 中文标准书面语；
- 口语化表达转换为标准战伤救治术语；
- 使用最近对话历史消解“这个、它、该阶段、上面提到的办法”等指代；
- 多个独立问题拆分；
- 不添加用户未提及的固定章节或额外治疗主题；
- 不改写成具体病例推演；
- 无法确定指代时保留原表述并标记 `unresolvedReferences`；
- 如果模型失败或返回空列表，回退为当前原始问题这一条 Query。

### 共享检索输入

Query Rewriter 结果转换为共享 retrieval/merge 所需的查询描述：

```ts
type RetrievalQuery = {
  query: string;
  reason: string;
  kind?: RagQueryKind;
  critical?: boolean;
};
```

Runner 的 `PlannedRagQuery` 保留原有 `kind` 和 `critical`；知识问答 Query 使用 `kind` 缺省、`critical: false`。这样 `mergeRetrieval` 可以继续产生 Runner 所需字段，同时不伪造知识问答的语义类型。

## 共享 baseline retrieval 的重构方式

### 新增共享执行函数

建议在 `src/trauma/rag/retrieval.ts` 中抽取：

```ts
export async function runBaselineRetrieval(input: {
  queries: RetrievalQuery[];
  rag: TraumaRagClient;
  signal?: AbortSignal;
}): Promise<Array<{
  query: RetrievalQuery;
  chunks: TraumaRagHit[];
  backend: "remote" | "local";
}>>;
```

实现就是把当前 Runner 中的 `Promise.all(baseline.map(...))` 移入共享函数。

Runner 改为：

```ts
const firstWaveResults = await runBaselineRetrieval({
  queries: baseline,
  rag: deps.rag,
  signal: input.abortSignal,
});
const merged = mergeRetrieval({
  queries: baseline,
  results: firstWaveResults,
});
```

知识问答改为：

```ts
const retrievalQueries = rewrite.rewrittenQueries.map((item) => ({
  query: item.query,
  reason: item.reason,
  critical: false as const,
}));

const results = await runBaselineRetrieval({
  queries: retrievalQueries,
  rag,
  signal,
});

const merged = mergeRetrieval({
  queries: retrievalQueries,
  results,
});
```

`mergeRetrieval` 仍然是唯一的 chunk 合并入口。

### 相似度阈值处理

本轮不在知识问答中重新实现阈值逻辑。应先确认并统一 `TraumaRagHit.score` 的语义：

- 当前 merge 已按“分数越高越相关”排序；
- 历史日志中出现过低分值，需确认远程和本地 backend 的分数是否同向；
- 在 score 语义确认前，不得硬编码 `0.75` 导致合法结果全部被过滤。

如果确认需要阈值，应在 `mergeRetrieval` 内增加统一可选参数：

```ts
mergeRetrieval({
  queries,
  results,
  scoreThreshold,
});
```

Runner 和知识问答共同使用该参数，确保两条链路不产生不同的过滤行为。阈值不是知识问答专用逻辑。

## Knowledge QA Prompt

知识问答模型只接收：

- 原始用户问题；
- Query Rewriter 生成的 Query；
- `merged.promptChunks`；
- 每个 prompt chunk 的引用编号；
- 书名、章节、条款和正文。

模型输出：

```ts
{
  naturalLanguageAnswer: string;
  citationChunkIds: string[];
}
```

Prompt 必须要求：

- 使用中文；
- 只能根据提供的 chunks 回答；
- 证据不足时明确说明；
- 不判断当前病例救治级别；
- 不生成当前病例行动计划、gate、后送决策或病例状态；
- 证据支持的句子后添加 `[N]`；
- `[N]` 必须对应给定 prompt chunk 的编号；
- 不输出 `<details>`、手写“参考来源”或其他末尾溯源块。

## 引用实时展示

复用 Runner 当前做法：

1. `merged.promptChunks` 已确定后，先生成候选 citation metadata。
2. 在第一个 `assistant_text_delta` 中携带候选 citations。
3. 前端流式解析正文中的 `[N]`，立即显示蓝色角标。
4. 流式结束后，按正文实际出现的合法 `[N]` 筛选最终 citations。
5. `assistant_text_end` 携带最终 citations。
6. `CitationSourceList` 展示编号、书名和章节，保持编号顺序。

不为知识问答创建第二套前端引用组件。

## 任务分解

### Task 1: 最近对话读取 helper

**Files:**

- Create: `src/trauma/conversationHistory.ts`
- Test: `tests/trauma/conversationHistory.spec.ts`

- [ ] 编写测试：过滤角色、排除工具/流程消息、正序、截断、读取失败回退。
- [ ] 运行：

```bash
pnpm exec tsx --test tests/trauma/conversationHistory.spec.ts
```

- [ ] 实现 helper，不修改 `caseHistory`。
- [ ] 重新运行测试并通过。

### Task 2: Query Rewriter

**Files:**

- Create: `src/trauma/stations/knowledgeQueryRewriter.ts`
- Create: `src/trauma/stations/knowledgeQueryRewriterPrompt.ts`
- Modify: `src/trauma/schemas.ts`
- Modify: `src/trauma/types.ts`
- Test: `tests/trauma/knowledgeQueryRewriter.spec.ts`

- [ ] 测试口语标准化、对话指代消解、多问题拆分、最多 4 条和失败回退。
- [ ] 使用 `StructuredModelClient.completeJson` 实现。
- [ ] 对返回 Query 做 trim、去重、截断和空值回退。
- [ ] 运行：

```bash
pnpm exec tsx --test tests/trauma/knowledgeQueryRewriter.spec.ts
```

### Task 3: 抽取共享 baseline retrieval executor

**Files:**

- Create: `src/trauma/rag/retrieval.ts`
- Modify: `src/trauma/runner.ts`
- Modify: `src/trauma/rag/merge.ts`
- Test: `tests/trauma/ragRetrieval.spec.ts`

- [ ] 测试多个 Query 使用 `Promise.all`，共享 `topic`、`top_k` 和 `AbortSignal`。
- [ ] 将 Runner 现有 baseline `Promise.all` 原样抽到 `runBaselineRetrieval`。
- [ ] 让 Runner 调用新 executor，确保现有 11 步、3 次 RAG 和快照 trace 不变。
- [ ] 让 `mergeRetrieval` 接受知识 Query 的最小适配字段，同时保留 Runner 的 `RetrievalTrace` 输出。
- [ ] 不新增知识问答 merge 算法。
- [ ] 运行：

```bash
pnpm exec tsx --test tests/trauma/ragRetrieval.spec.ts tests/trauma/ragMerge.spec.ts tests/trauma/runner.spec.ts
```

### Task 4: Knowledge QA station

**Files:**

- Create: `src/trauma/stations/knowledgeQa.ts`
- Create: `src/trauma/stations/knowledgeQaPrompt.ts`
- Modify: `src/trauma/schemas.ts`
- Modify: `src/trauma/types.ts`
- Test: `tests/trauma/knowledgeQa.spec.ts`

- [ ] 测试模型收到带 citationIndex 的 `promptChunks`。
- [ ] 测试中文输出、stream delta/end 回调和非法 citation ID 过滤。
- [ ] 使用 `StructuredModelClient.streamJson`。
- [ ] 不复用 reasoner schema，不生成 Runner 字段。
- [ ] 运行：

```bash
pnpm exec tsx --test tests/trauma/knowledgeQa.spec.ts
```

### Task 5: 复用同一 RAG client 和模型 runtime

**Files:**

- Modify: `src/cli/createLocalGateway.ts`
- Modify: `src/gateway/client/InProcessGateway.ts`
- Modify: `src/gateway/Gateway.ts`（如需要透传 factory）

- [ ] 新增 `traumaKnowledgeQaFactory`。
- [ ] factory 与 `createTraumaRunner` 使用同一个 runtime、同一个 model selection、同一个 `createMcpTraumaRagClient`。
- [ ] 不创建第二个 RAG MCP 工具调用实现。
- [ ] 保证每个 session 使用正确的 runtime tool registry。

### Task 6: 网关接入独立知识问答路径

**Files:**

- Modify: `src/gateway/client/InProcessGateway.ts`
- Modify: `src/trauma/formDraft.ts`
- Test: `tests/trauma/routing.spec.ts`

路由保持：

```text
case_update              → TraumaTurnRunner
domain_question_no_case  → recentConversation + Query Rewriter + shared retrieval + Knowledge QA
system_help              → 固定帮助说明
out_of_scope             → 固定礼貌拒答
```

- [ ] 测试 `domain_question_no_case` 不调用 Runner。
- [ ] 测试 Query Rewriter 收到对话历史而非病例状态。
- [ ] 测试多 Query 通过共享 executor 并行调用 RAG。
- [ ] 测试 `mergeRetrieval` 的 `promptChunks` 直接进入 Knowledge QA。
- [ ] 测试首个 delta 携带候选 citations，stream end 携带最终 citations。
- [ ] 测试只记录 transcript，不写病例 snapshot。
- [ ] 运行：

```bash
pnpm exec tsx --test tests/trauma/routing.spec.ts
```

### Task 7: 前端引用回归验证

**Files:**

- Test: `ui/src/components/chat-v2/MessageRowV2.streaming.test.tsx`

- [ ] 验证流式期间 `[N]` 立即显示蓝色角标。
- [ ] 验证来源列表只在 stream end 后出现。
- [ ] 验证列表按编号顺序显示书名和章节。
- [ ] 如果现有测试已覆盖这些行为，则只补充知识问答消息场景，不新建组件。
- [ ] 运行：

```bash
pnpm --dir ui test -- MessageRowV2.streaming.test.tsx
pnpm --dir ui typecheck
```

### Task 8: 日志和全量验收

**Files:**

- Modify: 现有 trauma audit/log 调用点（仅增加知识问答 trace 字段）
- Test: `tests/trauma/knowledgeQa.e2e.spec.ts`

- [ ] 记录原始问题、改写 Query、每个 Query 的 backend/chunk count、合并后 prompt chunk count、最终引用 IDs、总耗时。
- [ ] 验证事件顺序：

```text
turn_started
→ 大模型信息抽取
→ Query 改写
→ baseline retrieval
→ merge retrieval
→ assistant_text_delta
→ assistant_text_end
→ turn_completed
```

- [ ] 验证不出现 placement、gate、reasoner、case snapshot 或流程图节点。
- [ ] 运行：

```bash
pnpm exec tsc -p tsconfig.json --noEmit
pnpm exec tsx --test tests/trauma/schemas.spec.ts tests/trauma/routing.spec.ts tests/trauma/ragRetrieval.spec.ts tests/trauma/ragMerge.spec.ts tests/trauma/knowledgeQueryRewriter.spec.ts tests/trauma/knowledgeQa.spec.ts tests/trauma/knowledgeQa.e2e.spec.ts
pnpm --dir ui typecheck
git diff --check
```

## 失败和降级策略

| 阶段 | 失败情况 | 行为 |
|---|---|---|
| 读取对话历史 | transcript reader 异常 | warning，使用空 `recentConversation` |
| Query Rewriter | 模型异常或 schema 错误 | 当前原始问题作为唯一 Query |
| baseline RAG | 远程返回空或不可用 | 继续使用现有 TraumaRagClient 的本地 fallback |
| merge 无 chunk | 无证据 | 知识问答模型明确说明未检索到足够依据 |
| QA 模型异常 | stream/JSON 失败 | 发送可读错误，不进入 Runner |
| 用户停止本轮 | AbortSignal 触发 | 取消共享 retrieval 和 QA stream，不写病例状态 |

## 验收标准

- Query 经过独立模型改写，支持口语标准化、指代消解和多问题拆分。
- 多 Query 检索使用与 Runner 相同的 baseline retrieval executor。
- chunk 去重、remote/local 选择、排序、章节 metadata 和 prompt chunk 截断只由现有 `mergeRetrieval` 完成。
- 不存在知识问答专用的重复 merge 算法。
- RAG 工具、topic、fallback 与 Runner 相同。
- 知识问答专属 Prompt 基于 `merged.promptChunks` 生成答案。
- 正文流式期间引用角标立即显示。
- 结束后显示按编号排序的“参考来源”列表。
- `domain_question_no_case` 不修改病例状态、不运行 Runner。
- `case_update` 原有 Runner 行为保持不变。

## 自检清单

- [ ] `caseHistory` 和 `recentConversation` 完全分离。
- [ ] Query 改写失败时仍能直接检索原始问题。
- [ ] retrieval executor 只是抽取现有 baseline `Promise.all`，没有第二份检索实现。
- [ ] `mergeRetrieval` 是唯一的 chunk 合并入口。
- [ ] 没有强行把知识 Query 标记为 `primary_injury`。
- [ ] citation 编号只在 merged prompt chunks 确定后生成一次。
- [ ] 前端继续使用现有 citation renderer。
