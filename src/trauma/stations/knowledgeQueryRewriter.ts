import type { StructuredModelClient } from "../modelClient.js";
import {
  KNOWLEDGE_QUERY_REWRITE_SCHEMA,
  validateKnowledgeQueryRewrite,
} from "../schemas.js";
import type { KnowledgeQueryRewrite } from "../types.js";
import { KNOWLEDGE_QUERY_REWRITER_SYSTEM_PROMPT } from "./knowledgeQueryRewriterPrompt.js";

export type KnowledgeQueryRewriter = {
  rewrite(input: {
    rawQuestion: string;
    recentConversation: string;
    signal?: AbortSignal;
  }): Promise<KnowledgeQueryRewrite>;
};

function normalize(raw: KnowledgeQueryRewrite, fallback: string): KnowledgeQueryRewrite {
  const seen = new Set<string>();
  const rewrittenQueries = raw.rewrittenQueries
    .map((item) => ({
      query: item.query.trim(),
      reason: item.reason.trim() || "基于用户问题进行标准化改写",
    }))
    .filter((item) => item.query && !seen.has(item.query) && seen.add(item.query))
    .slice(0, 4);
  if (rewrittenQueries.length === 0) {
    rewrittenQueries.push({ query: fallback.trim(), reason: "模型未生成有效改写，使用用户原问题检索" });
  }
  return {
    rewrittenQueries,
    unresolvedReferences: raw.unresolvedReferences.map((item) => item.trim()).filter(Boolean),
    needsClarification: raw.needsClarification,
  };
}

export function createKnowledgeQueryRewriter(model: StructuredModelClient): KnowledgeQueryRewriter {
  return {
    async rewrite(input) {
      try {
        const raw = await model.completeJson({
          name: "trauma_knowledge_query_rewrite",
          system: KNOWLEDGE_QUERY_REWRITER_SYSTEM_PROMPT,
          user: `${input.recentConversation || "<recentConversation></recentConversation>"}\n\n<currentQuestion>\n${input.rawQuestion}\n</currentQuestion>`,
          schema: KNOWLEDGE_QUERY_REWRITE_SCHEMA,
          validate: validateKnowledgeQueryRewrite,
          signal: input.signal,
        });
        return normalize(raw, input.rawQuestion);
      } catch (error) {
        if (input.signal?.aborted) throw error;
        return {
          rewrittenQueries: [{
            query: input.rawQuestion.trim(),
            reason: "查询改写失败，使用用户原问题检索",
          }],
          unresolvedReferences: [],
          needsClarification: false,
        };
      }
    },
  };
}
