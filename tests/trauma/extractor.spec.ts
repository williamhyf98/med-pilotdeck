import assert from "node:assert/strict";
import test from "node:test";

import { initialCaseState } from "../../src/trauma/stageConfig.js";
import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import { createExtractorStation } from "../../src/trauma/stations/extractor.js";
import type { ExtractedTurnFacts } from "../../src/trauma/types.js";

const now = "2026-09-03T15:09:00+08:00";
const previous = initialCaseState({
  projectId: "trauma_med-demo",
  sessionId: "web:s_demo",
  now,
});

function fakeClient(payload: unknown): StructuredModelClient {
  return {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      if (!input.validate(payload)) {
        throw new Error("schema validation failed");
      }
      return payload;
    },
  };
}

function validFacts(turnKind: ExtractedTurnFacts["turnKind"]): ExtractedTurnFacts {
  return {
    turnKind,
    context: {},
    vitalSigns: turnKind === "case_update"
      ? [
        {
          value: { type: "blood_pressure", value: { systolic: 95 }, unit: "mmHg" },
          sourceMessageId: "message-2",
          sourceQuote: "收缩压95",
          certainty: "confirmed",
          confidence: 0.98,
        },
        {
          value: { type: "heart_rate", value: 120, unit: "/min" },
          sourceMessageId: "message-2",
          sourceQuote: "心率120",
          certainty: "confirmed",
          confidence: 0.95,
        },
      ]
      : [],
    injuryFindings: [],
    treatmentEvents: [],
    careAndTransportFacts: [],
    correctionsAndProvenance: { conflictingFactIds: [] },
  };
}

test("extractor returns six core groups and no Gate fields", async () => {
  const { extract } = createExtractorStation(fakeClient(validFacts("case_update")));
  const facts = await extract({ userText: "收缩压95，心率120", previous });
  assert.ok(Array.isArray(facts.vitalSigns));
  assert.equal("gate" in facts, false);
  assert.equal(facts.turnKind, "case_update");
  assert.ok("context" in facts);
  assert.ok("injuryFindings" in facts);
  assert.ok("treatmentEvents" in facts);
  assert.ok("careAndTransportFacts" in facts);
  assert.ok("correctionsAndProvenance" in facts);
});

test("no_case_update is a valid turnKind", async () => {
  const { extract } = createExtractorStation(fakeClient(validFacts("no_case_update")));
  const facts = await extract({ userText: "你好", previous });
  assert.equal(facts.turnKind, "no_case_update");
});

test("rejects extractor output that includes currentStage", async () => {
  const { extract } = createExtractorStation(fakeClient({
    ...validFacts("case_update"),
    currentStage: "early_treatment",
  }));
  await assert.rejects(
    () => extract({ userText: "x", previous }),
    /schema/i,
  );
});
