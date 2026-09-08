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
  state.currentStage = "battlefield_first_aid";
  state.currentSubStage = "primary_first_aid";
  state.currentFacility = {
    name: "连抢救组",
    type: "company_aid_team",
    capabilities: ["止血"],
  };
  state.injuryNarratives.push({
    round: 1,
    createdAt: state.updatedAt,
    text: "右小腿开放伤出血",
  });
  state.round = 2;
  state.treatmentNarratives.push({
    round: 2,
    createdAt: state.updatedAt,
    text: `已完成加压包扎${"处".repeat(400)}`,
  });
  state.evacuationNarratives.push({
    round: 2,
    createdAt: state.updatedAt,
    text: "车辆可用，道路通行",
  });
  state.notes.push({
    round: 2,
    createdAt: state.updatedAt,
    text: "胸痛仍需复查",
  });
  state.vitalSignsHistory.push(
    {
      round: 1,
      recordedAt: state.updatedAt,
      values: { systolicBloodPressure: 92, gcs: 15 },
    },
    {
      round: 2,
      recordedAt: state.updatedAt,
      values: { respiratoryRate: 30 },
    },
  );

  const plan = buildBaselineQueries(state);
  assert.equal(plan.length, 3);
  assert.ok(plan.every((query) => query.wave === 1 && query.critical));
  assert.deepEqual(plan.map((query) => query.kind), [
    "stage",
    "classification_transport",
    "primary_injury",
  ]);
  assert.match(plan[0]?.query ?? "", /第二章 分级救治/);
  assert.match(plan[0]?.query ?? "", /第三章 战伤救治技术范围/);
  assert.match(plan[0]?.query ?? "", /连抢救组/);
  assert.match(plan[0]?.query ?? "", /止血|包扎|固定|搬运|通气/);
  assert.ok(!plan[0]?.query.includes("救送结合"));

  assert.match(plan[1]?.query ?? "", /第二章 分类救治/);
  assert.match(plan[1]?.query ?? "", /第四章 伤势判断与救治优先顺序/);
  assert.match(plan[1]?.query ?? "", /附件2 伤员伤势评估及救治顺序参考条件/);
  assert.match(plan[1]?.query ?? "", /初级急救/);
  assert.match(plan[1]?.query ?? "", /车辆/);
  assert.match(plan[1]?.query ?? "", /道路/);
  assert.match(plan[1]?.query ?? "", /SBP 92/);
  assert.match(plan[1]?.query ?? "", /GCS 15/);

  assert.match(plan[2]?.query ?? "", /具体伤情处置/);
  assert.match(plan[2]?.query ?? "", /第六章/);
  assert.match(plan[2]?.query ?? "", /四肢伤救治/);
  assert.match(plan[2]?.query ?? "", /胸部伤救治/);
  assert.match(plan[2]?.query ?? "", /胸痛/);
  assert.match(plan[2]?.query ?? "", /小腿/);
  assert.match(plan[2]?.query ?? "", /加压包扎/);

  assert.ok(plan.every((query) => query.query.length < 2_000));
  assert.ok(plan.every((query) => !query.query.includes("时效")));
});
