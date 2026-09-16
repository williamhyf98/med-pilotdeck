import type { StructuredModelClient } from "../modelClient.js";
import {
  KNOWLEDGE_QA_OUTPUT_SCHEMA,
  validateKnowledgeQaOutput,
} from "../schemas.js";
import type { EvidenceChunk, KnowledgeQaOutput } from "../types.js";
import { KNOWLEDGE_QA_SYSTEM_PROMPT } from "./knowledgeQaPrompt.js";

export type KnowledgeQaStation = {
  answer(input: {
    question: string;
    rewrittenQueries: string[];
    promptChunks: EvidenceChunk[];
    signal?: AbortSignal;
    onNaturalLanguageDelta?: (text: string) => void | Promise<void>;
    onNaturalLanguageEnd?: () => void | Promise<void>;
  }): Promise<KnowledgeQaOutput>;
};

export function createKnowledgeQaStation(model: StructuredModelClient): KnowledgeQaStation {
  return {
    async answer(input) {
      const promptIds = new Set(input.promptChunks.map((chunk) => chunk.id));
      const raw = await (model.streamJson
        ? model.streamJson({
          name: "trauma_knowledge_qa",
          system: KNOWLEDGE_QA_SYSTEM_PROMPT,
          user: JSON.stringify({
            question: input.question,
            rewrittenQueries: input.rewrittenQueries,
            promptChunks: input.promptChunks.map((chunk, index) => ({
              citationIndex: index + 1,
              id: chunk.id,
              title: chunk.documentTitle,
              section: chunk.section,
              chapter: chunk.chapter ?? null,
              heading: chunk.heading ?? null,
              article: chunk.article ?? null,
              text: chunk.text,
            })),
          }),
          schema: KNOWLEDGE_QA_OUTPUT_SCHEMA,
          validate: validateKnowledgeQaOutput,
          signal: input.signal,
        }, {
          onNaturalLanguageDelta: input.onNaturalLanguageDelta,
          onNaturalLanguageEnd: input.onNaturalLanguageEnd,
        })
        : model.completeJson({
          name: "trauma_knowledge_qa",
          system: KNOWLEDGE_QA_SYSTEM_PROMPT,
          user: JSON.stringify({
            question: input.question,
            rewrittenQueries: input.rewrittenQueries,
            promptChunks: input.promptChunks.map((chunk, index) => ({
              citationIndex: index + 1,
              id: chunk.id,
              title: chunk.documentTitle,
              section: chunk.section,
              text: chunk.text,
            })),
          }),
          schema: KNOWLEDGE_QA_OUTPUT_SCHEMA,
          validate: validateKnowledgeQaOutput,
          signal: input.signal,
        }));
      return {
        naturalLanguageAnswer: raw.naturalLanguageAnswer,
        citationChunkIds: raw.citationChunkIds.filter((id) => promptIds.has(id)),
      };
    },
  };
}
