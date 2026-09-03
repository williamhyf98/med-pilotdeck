import assert from "node:assert/strict";
import test from "node:test";

import { mergeExtractedFacts } from "../../src/trauma/factMerge.js";
import { initialCaseState } from "../../src/trauma/stageConfig.js";
import type { ExtractedTurnFacts } from "../../src/trauma/types.js";

const now = "2026-09-03T15:09:00+08:00";

function facts(): ExtractedTurnFacts {
  return {
    turnKind: "case_update",
    context: {
      eventTime: {
        value: "2026-09-03T14:55:00+08:00",
        sourceMessageId: "message-2",
        sourceQuote: "伤后14分钟",
        certainty: "confirmed",
        confidence: 0.95,
      },
    },
    vitalSigns: [
      {
        value: { type: "respiratory_rate", value: 32, unit: "/min" },
        sourceMessageId: "message-2",
        sourceQuote: "呼吸大约每分钟32次",
        measuredAt: now,
        certainty: "confirmed",
        confidence: 0.95,
      },
      {
        value: { type: "blood_pressure", value: { systolic: 95 }, unit: "mmHg" },
        sourceMessageId: "message-2",
        sourceQuote: "收缩压95",
        measuredAt: now,
        certainty: "confirmed",
        confidence: 0.98,
      },
    ],
    injuryFindings: [
      {
        value: {
          bodyPart: "右小腿",
          finding: "开放伤出血",
          status: "controlled",
        },
        sourceMessageId: "message-2",
        sourceQuote: "小腿压迫后基本止住血了",
        certainty: "confirmed",
        confidence: 0.95,
      },
    ],
    treatmentEvents: [],
    careAndTransportFacts: [],
    correctionsAndProvenance: {
      conflictingFactIds: ["fact-old-bp"],
    },
  };
}

test("merge appends vitals and applies injury updates without changing stage", () => {
  const previous = initialCaseState({
    projectId: "trauma_med-demo",
    sessionId: "web:s_demo",
    now,
  });
  previous.injuries.push({
    id: "inj-leg",
    category: "open_wound",
    bodyPart: "右小腿",
    finding: "开放伤出血",
    certainty: "confirmed",
    status: "active",
    sourceMessageId: "message-1",
    sourceQuote: "右小腿伤口流血",
    confidence: 0.9,
  });

  const next = mergeExtractedFacts(previous, facts(), now);

  assert.equal(next.currentSubStage, previous.currentSubStage);
  assert.equal(next.version, previous.version);
  assert.equal(next.vitalSignsHistory.length, 1);
  assert.equal(next.vitalSignsHistory[0]?.respiratoryRate, 32);
  assert.equal(next.vitalSignsHistory[0]?.systolicBloodPressure, 95);
  assert.equal(next.injuries.find((injury) => injury.id === "inj-leg")?.status, "controlled");
  assert.deepEqual(next.conflictingFactIds, ["fact-old-bp"]);
  assert.equal(previous.vitalSignsHistory.length, 0);
});

test("merge ignores attempted stage injection", () => {
  const previous = initialCaseState({
    projectId: "trauma_med-demo",
    sessionId: "web:s_demo",
    now,
  });
  const tainted = {
    ...facts(),
    currentStage: "early_treatment",
    currentSubStage: "emergency_treatment",
  };

  const next = mergeExtractedFacts(previous, tainted as ExtractedTurnFacts, now);

  assert.equal(next.currentStage, "battlefield_first_aid");
  assert.equal(next.currentSubStage, "primary_first_aid");
});
