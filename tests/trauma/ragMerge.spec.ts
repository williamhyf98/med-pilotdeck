import assert from "node:assert/strict";
import test from "node:test";

import { mergeRetrieval } from "../../src/trauma/rag/merge.js";
import type { PlannedRagQuery } from "../../src/trauma/rag/queryPlan.js";
import type { TraumaRagHit } from "../../src/trauma/rag/client.js";

const queries: PlannedRagQuery[] = [
  { wave: 1, kind: "stage", query: "初级急救规则", reason: "stage", critical: true },
  { wave: 1, kind: "classification_transport", query: "分类后送", reason: "triage", critical: true },
  { wave: 1, kind: "primary_injury", query: "胸部伤", reason: "injury", critical: true },
];

function hit(id: string, score: number, backend: "remote" | "local" = "remote"): TraumaRagHit {
  return {
    chunk_id: id,
    text: `text-${id}`,
    score,
    title: `doc-${id}`,
    retrieval_backend: backend,
  };
}

test("merge stores all chunks and selects at most 15 for the prompt", () => {
  const results = queries.map((query, index) => ({
    query,
    backend: "remote" as const,
    chunks: Array.from({ length: index === 0 ? 9 : 8 }, (_, offset) =>
      hit(`${query.kind}-${offset}`, 1 - offset / 20)),
  }));
  const merged = mergeRetrieval({ queries, results });
  assert.equal(merged.evidence.length, 25);
  assert.ok(merged.promptChunks.length <= 15);
  assert.ok(merged.promptChunks.length >= 10 || merged.retrieval.criticalCoverageGaps.length > 0);
  assert.ok(merged.evidence.every((chunk) => typeof chunk.selectedForPrompt === "boolean"));
  assert.ok(merged.evidence.every((chunk) => chunk.usedInAnswer === false));
});

test("missing primary_injury hits become a coverage gap", () => {
  const results = [
    { query: queries[0]!, backend: "remote" as const, chunks: [hit("stage-0", 0.9)] },
    { query: queries[1]!, backend: "remote" as const, chunks: [hit("triage-0", 0.8)] },
    { query: queries[2]!, backend: "remote" as const, chunks: [] },
  ];
  const merged = mergeRetrieval({ queries, results });
  assert.ok(merged.retrieval.criticalCoverageGaps.includes("primary_injury"));
});

test("prefers remote chunks over local scores when mixed", () => {
  const results = [
    {
      query: queries[0]!,
      backend: "local" as const,
      chunks: [hit("local-high", 0.99, "local")],
    },
    {
      query: queries[1]!,
      backend: "remote" as const,
      chunks: [hit("remote-low", 0.2, "remote")],
    },
    { query: queries[2]!, backend: "remote" as const, chunks: [hit("injury-0", 0.5, "remote")] },
  ];
  const merged = mergeRetrieval({ queries, results });
  const remoteIndex = merged.promptChunks.findIndex((chunk) => chunk.id === "remote-low");
  const localIndex = merged.promptChunks.findIndex((chunk) => chunk.id === "local-high");
  assert.ok(remoteIndex >= 0 && localIndex > remoteIndex);
});
