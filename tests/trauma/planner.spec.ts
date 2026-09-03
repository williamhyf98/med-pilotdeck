import assert from "node:assert/strict";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import { initialCaseState } from "../../src/trauma/stageConfig.js";
import { createPlannerStation } from "../../src/trauma/stations/planner.js";
import type { RetrievalTrace } from "../../src/trauma/types.js";

const state = initialCaseState({
  projectId: "trauma_med-demo",
  sessionId: "web:s_demo",
  now: "2026-09-03T15:09:00+08:00",
});

const firstWave: RetrievalTrace = {
  queries: [
    {
      wave: 1,
      kind: "stage",
      query: "初级急救规则",
      reason: "stage",
      critical: true,
      chunkIds: ["c1"],
    },
  ],
  totalCalls: 3,
  allChunkIds: ["chunk-1"],
  promptChunkIds: ["chunk-1"],
  criticalCoverageGaps: [],
};

function fakeClient(payload: unknown, calls: { count: number }): StructuredModelClient {
  return {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      calls.count += 1;
      if (!input.validate(payload)) {
        throw new Error("schema validation failed");
      }
      return payload;
    },
  };
}

test("planner skips the model when remaining budget is 0", async () => {
  const calls = { count: 0 };
  const { plan } = createPlannerStation(fakeClient({ queries: [{ query: "x", reason: "y" }] }, calls));
  const result = await plan({ state, firstWave, remainingBudget: 0 });
  assert.deepEqual(result, []);
  assert.equal(calls.count, 0);
});

test("planner caps supplemental queries at remaining budget and wave 2", async () => {
  const calls = { count: 0 };
  const { plan } = createPlannerStation(fakeClient({
    queries: [
      { query: "初级急救规则", reason: "duplicate" },
      { query: "空运禁忌", reason: "transport", critical: true },
      { query: "骨盆伤", reason: "injury" },
      { query: "污染暴露", reason: "extra" },
      { query: "第五条", reason: "overflow" },
    ],
  }, calls));
  const result = await plan({ state, firstWave, remainingBudget: 3 });
  assert.equal(calls.count, 1);
  assert.equal(result.length, 3);
  assert.ok(result.every((item) => item.wave === 2 && item.kind === "supplemental"));
  assert.equal(result[0]?.query, "空运禁忌");
  assert.equal(result[0]?.critical, true);
  assert.equal(result[1]?.critical, false);
  assert.ok(!result.some((item) => item.query === "初级急救规则"));
});
