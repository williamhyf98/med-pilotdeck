import assert from "node:assert/strict";
import test from "node:test";

import {
  compactCaseStateForDownstream,
  mergeFormInput,
  validateTurnFormInput,
} from "../../src/trauma/factMerge.js";
import { normalizeTraumaIntentPlan } from "../../src/trauma/formDraft.js";
import { initialCaseState } from "../../src/trauma/stageConfig.js";
import type { TurnFormInput } from "../../src/trauma/types.js";

const now = "2026-09-03T15:09:00+08:00";

test("normalizes one primary intent plus exact-source preference side intents", () => {
  const rawText = "以后先给结论。患者右腿持续出血。";
  const plan = normalizeTraumaIntentPlan(rawText, {
    inputIntent: "case_update",
    scopeReason: "同时包含病例更新和输出偏好",
    preferences: [
      { sourceSpan: "以后先给结论", directive: "回答时先给结论", category: "format" },
      { sourceSpan: "原文不存在", directive: "使用表格", category: "format" },
    ],
    injuryNarratives: [{ text: "患者右腿持续出血", sourceSpan: "患者右腿持续出血" }],
    treatmentNarratives: [],
    evacuationNarratives: [],
    notes: [],
    vitals: [],
  });

  assert.equal(plan.primaryIntent, "case_update");
  assert.deepEqual(plan.preferences, [
    { sourceSpan: "以后先给结论", directive: "回答时先给结论", category: "format" },
  ]);
  assert.equal(plan.caseForm.injuryNarrative, "患者右腿持续出血");
});

test("normalizes legacy knowledge intent without requiring preferences", () => {
  const plan = normalizeTraumaIntentPlan("止血带应该使用多久？", {
    inputIntent: "domain_question_no_case",
    scopeReason: "战创伤知识问题",
    injuryNarratives: [],
    treatmentNarratives: [],
    evacuationNarratives: [],
    notes: [],
    vitals: [],
  });

  assert.equal(plan.primaryIntent, "knowledge_question");
  assert.equal(plan.knowledgeQuestion, "止血带应该使用多久？");
  assert.deepEqual(plan.preferences, []);
});

function form(overrides: Partial<TurnFormInput> = {}): TurnFormInput {
  return {
    statedSubStage: null,
    injuryNarrative: "",
    treatmentNarrative: "",
    evacuationNarrative: "",
    note: "",
    vitals: {},
    ...overrides,
  };
}

test("validateTurnFormInput accepts partial measured vitals and narrative", () => {
  assert.equal(validateTurnFormInput(form({
    injuryNarrative: "右小腿开放伤，活动性出血",
    vitals: {
      respiratoryRate: 32,
      systolicBloodPressure: 95,
      heartRate: 120,
      temperature: 36.6,
    },
  })), true);
});

test("validateTurnFormInput rejects empty and out-of-range forms", () => {
  assert.equal(validateTurnFormInput(form()), false);
  assert.equal(validateTurnFormInput({ ...form(), vitals: { gcs: 15 } }), false);
  assert.equal(validateTurnFormInput(form({ vitals: { temperature: 36.66 } })), false);
});

test("validation requires exact fields, integer vitals, and text limits", () => {
  assert.equal(validateTurnFormInput({ ...form({ note: "x" }), extra: true }), false);
  assert.equal(validateTurnFormInput(form({ vitals: { respiratoryRate: 20.5 } })), false);
  assert.equal(validateTurnFormInput(form({ injuryNarrative: "伤".repeat(1_001) })), false);
  assert.equal(validateTurnFormInput(form({
    statedSubStage: "surgical_resuscitation",
    injuryNarrative: "  有效叙述  ",
  })), true);
});

test("merge appends narratives and only this round's measured vitals", () => {
  const previous = initialCaseState({
    projectId: "trauma_med-demo",
    sessionId: "web:s_demo",
    now,
  });
  previous.vitalSignsHistory.push({
    round: 1,
    recordedAt: "2026-09-03T15:00:00+08:00",
    values: { heartRate: 110 },
  });

  const next = mergeFormInput(previous, form({
    injuryNarrative: "右小腿开放伤，压迫后出血已控制",
    treatmentNarrative: "已完成加压包扎",
    evacuationNarrative: "车辆可用，道路通行",
    note: "胸痛仍需复查",
    vitals: { respiratoryRate: 32, systolicBloodPressure: 95 },
  }), 2, now);

  assert.equal(next.currentSubStage, previous.currentSubStage);
  assert.equal(next.version, previous.version);
  assert.equal(next.injuryNarratives.at(-1)?.text, "右小腿开放伤，压迫后出血已控制");
  assert.equal(next.treatmentNarratives.at(-1)?.text, "已完成加压包扎");
  assert.equal(next.evacuationNarratives.at(-1)?.text, "车辆可用，道路通行");
  assert.equal(next.notes.at(-1)?.text, "胸痛仍需复查");
  assert.deepEqual(next.vitalSignsHistory.at(-1)?.values, {
    respiratoryRate: 32,
    systolicBloodPressure: 95,
  });
  assert.equal(next.vitalSignsHistory.at(-1)?.values.heartRate, undefined);
  assert.equal(previous.injuryNarratives.length, 0);
  assert.equal(next.injuryNarratives.at(-1)?.text, "右小腿开放伤，压迫后出血已控制");
});

test("merge leaves narrative histories unchanged for blank fields", () => {
  const previous = initialCaseState({
    projectId: "trauma_med-demo",
    sessionId: "web:s_demo",
    now,
  });
  previous.injuryNarratives.push({ round: 1, createdAt: now, text: "右大腿贯通伤" });

  const next = mergeFormInput(previous, form({ vitals: { heartRate: 120 } }), 2, now);

  assert.deepEqual(next.injuryNarratives, previous.injuryNarratives);
  assert.equal(next.vitalSignsHistory.at(-1)?.values.heartRate, 120);
});

test("downstream view preserves history and marks stale vitals", () => {
  const previous = initialCaseState({
    projectId: "trauma_med-demo",
    sessionId: "web:s_demo",
    now,
  });
  previous.round = 3;
  previous.injuryNarratives.push(
    { round: 1, createdAt: now, text: "右大腿贯通伤，活动性出血" },
    { round: 3, createdAt: now, text: "更正：右大腿出血已经控制" },
  );
  previous.vitalSignsHistory.push(
    {
      round: 1,
      recordedAt: now,
      values: { systolicBloodPressure: 92 },
    },
    {
      round: 2,
      recordedAt: now,
      values: { respiratoryRate: 28 },
    },
    {
      round: 3,
      recordedAt: now,
      values: { heartRate: 120 },
    },
  );

  const view = compactCaseStateForDownstream(previous);

  assert.equal(view.injuryNarratives.length, 2);
  assert.equal(view.injuryNarratives[0]?.round, 3);
  assert.deepEqual(view.vitals.recentRecords.map((record) => record.round), [3, 2, 1]);
  assert.equal(view.vitals.latestMeasuredRound, 3);
  assert.equal(view.vitals.measuredThisRound, true);
  assert.equal(view.vitals.values.systolicBloodPressure, 92);
  assert.deepEqual(view.vitals.latestByField.systolicBloodPressure, {
    value: 92,
    round: 1,
    stale: true,
  });
  assert.deepEqual(view.vitals.latestByField.respiratoryRate, {
    value: 28,
    round: 2,
    stale: true,
  });
  assert.deepEqual(view.vitals.latestByField.heartRate, {
    value: 120,
    round: 3,
    stale: false,
  });
});

test("downstream vital history is bounded to six newest records", () => {
  const state = initialCaseState({
    projectId: "trauma_med-demo",
    sessionId: "web:s_demo",
    now,
  });
  state.round = 8;
  state.vitalSignsHistory = Array.from({ length: 8 }, (_, index) => ({
    round: index + 1,
    recordedAt: now,
    values: { heartRate: 100 + index },
  }));

  const view = compactCaseStateForDownstream(state);
  assert.deepEqual(view.vitals.recentRecords.map((record) => record.round), [8, 7, 6, 5, 4, 3]);
});
