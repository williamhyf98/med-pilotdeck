import assert from "node:assert/strict";
import test from "node:test";

import { initialCaseState } from "../../src/trauma/stageConfig.js";
import { buildBaselineQueries } from "../../src/trauma/rag/queryPlan.js";

test("baseline plan is exactly three critical wave-1 queries", () => {
  const state = initialCaseState({
    projectId: "trauma_med-demo",
    sessionId: "web:s_demo",
    now: "2026-09-03T15:09:00+08:00",
  });
  state.injuries.push({
    id: "inj-leg",
    category: "open_wound",
    bodyPart: "右小腿",
    finding: "开放伤出血",
    certainty: "confirmed",
    status: "controlled",
    sourceMessageId: "message-1",
    sourceQuote: "右小腿伤口流血",
    confidence: 0.9,
  });

  const plan = buildBaselineQueries(state);
  assert.equal(plan.length, 3);
  assert.ok(plan.every((query) => query.wave === 1 && query.critical));
  assert.deepEqual(plan.map((query) => query.kind), [
    "stage",
    "classification_transport",
    "primary_injury",
  ]);
  assert.ok(plan.every((query) => query.query.includes("初级急救") || query.query.length > 0));
});
