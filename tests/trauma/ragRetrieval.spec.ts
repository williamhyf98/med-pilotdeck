import assert from "node:assert/strict";
import test from "node:test";
import { runBaselineRetrieval } from "../../src/trauma/rag/retrieval.js";
import type { TraumaRagClient } from "../../src/trauma/rag/client.js";

test("runBaselineRetrieval runs all queries in parallel with shared RAG options", async () => {
  const started: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const rag: TraumaRagClient = {
    async query(input) {
      started.push(input.query);
      await gate;
      return {
        retrieval_backend: "remote",
        chunks: [{
          chunk_id: input.query,
          text: input.query,
          score: 0.9,
          retrieval_backend: "remote",
        }],
      };
    },
  };
  const promise = runBaselineRetrieval({
    queries: [
      { kind: "knowledge", query: "问题一", reason: "一", critical: false },
      { kind: "knowledge", query: "问题二", reason: "二", critical: false },
    ],
    rag,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started.sort(), ["问题一", "问题二"]);
  release();
  const results = await promise;
  assert.equal(results.length, 2);
  assert.equal(results[0]?.backend, "remote");
});
