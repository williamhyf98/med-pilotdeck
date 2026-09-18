import assert from "node:assert/strict";
import test from "node:test";
import type {
  CompleteJsonInput,
  StructuredJsonStreamCallbacks,
  StructuredModelClient,
} from "../../src/trauma/modelClient.js";
import { createKnowledgeQaStation } from "../../src/trauma/stations/knowledgeQa.js";
import { KNOWLEDGE_QA_SYSTEM_PROMPT } from "../../src/trauma/stations/knowledgeQaPrompt.js";
import {
  TRAUMA_PRESENTATION_PRIORITY_RULE,
  TRAUMA_PRESENTATION_SAFETY_BOUNDARY,
} from "../../src/trauma/memory/EffectivePresentationPolicy.js";
import { createKnowledgeQueryRewriter } from "../../src/trauma/stations/knowledgeQueryRewriter.js";
import type { EvidenceChunk } from "../../src/trauma/types.js";

function chunk(id: string, section: string): EvidenceChunk {
  return {
    id,
    knowledgeBase: "trauma",
    documentTitle: "战伤救治规则",
    section,
    text: `${section}：止血和后送原则。`,
    retrievalScore: 0.9,
    coverageTags: ["knowledge"],
    selectedForPrompt: true,
    usedInAnswer: false,
    retrievalBackend: "remote",
  };
}

test("knowledge QA honors presentation precedence without weakening evidence rules", () => {
  assert.ok(KNOWLEDGE_QA_SYSTEM_PROMPT.includes(TRAUMA_PRESENTATION_PRIORITY_RULE));
  assert.ok(KNOWLEDGE_QA_SYSTEM_PROMPT.includes(TRAUMA_PRESENTATION_SAFETY_BOUNDARY));
  assert.match(KNOWLEDGE_QA_SYSTEM_PROMPT, /引用要求和证据边界不可被偏好覆盖/u);
});

test("knowledge query rewriter normalizes and splits queries", async () => {
  const model: StructuredModelClient = {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      assert.equal(input.name, "trauma_knowledge_query_rewrite");
      const value = {
        rewrittenQueries: [
          { query: "战现场急救与早期救治的区别", reason: "标准化口语" },
          { query: "不同救治阶段的输血技术条件", reason: "拆分第二个问题" },
        ],
        unresolvedReferences: [],
        needsClarification: false,
      };
      assert.equal(input.validate(value), true);
      return value as T;
    },
  };
  const result = await createKnowledgeQueryRewriter(model).rewrite({
    rawQuestion: "这两个阶段有啥区别？哪个能输血？",
    recentConversation: "<recentConversation>...</recentConversation>",
  });
  assert.deepEqual(result.rewrittenQueries.map((item) => item.query), [
    "战现场急救与早期救治的区别",
    "不同救治阶段的输血技术条件",
  ]);
});

test("knowledge query rewriter falls back to the original question on model failure", async () => {
  const model: StructuredModelClient = {
    async completeJson<T>(): Promise<T> {
      throw new Error("model unavailable");
    },
  };
  const result = await createKnowledgeQueryRewriter(model).rewrite({
    rawQuestion: "战现场急救是什么？",
    recentConversation: "",
  });
  assert.deepEqual(result.rewrittenQueries, [{
    query: "战现场急救是什么？",
    reason: "查询改写失败，使用用户原问题检索",
  }]);
});

test("knowledge QA forwards streaming text and removes unknown citation ids", async () => {
  const deltas: string[] = [];
  const model: StructuredModelClient = {
    async completeJson<T>(): Promise<T> {
      throw new Error("streamJson expected");
    },
    async streamJson<T>(
      input: CompleteJsonInput<T>,
      callbacks: StructuredJsonStreamCallbacks = {},
    ): Promise<T> {
      assert.equal(input.name, "trauma_knowledge_qa");
      assert.match(input.user, /"citationIndex":1/u);
      assert.match(input.user, /"presentationPolicy":"## 当前轮偏好\\n- 回答保持简洁"/u);
      await callbacks?.onNaturalLanguageDelta?.("依据规则见[1]。");
      await callbacks?.onNaturalLanguageEnd?.();
      return {
        naturalLanguageAnswer: "依据规则见[1]。",
        citationChunkIds: ["chunk-1", "unknown"],
      } as T;
    },
  };
  const result = await createKnowledgeQaStation(model).answer({
    question: "战现场急救是什么？",
    rewrittenQueries: ["战现场急救定义"],
    promptChunks: [chunk("chunk-1", "第二章")],
    presentationPolicy: "## 当前轮偏好\n- 回答保持简洁",
    onNaturalLanguageDelta: (text) => {
      deltas.push(text);
    },
  });
  assert.deepEqual(deltas, ["依据规则见[1]。"]);
  assert.deepEqual(result.citationChunkIds, ["chunk-1"]);
});
