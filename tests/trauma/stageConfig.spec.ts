import assert from "node:assert/strict";
import test from "node:test";

import {
  SUBSTAGE_ORDER,
  deriveNodeStatus,
  isLaterSubStage,
  typicalFacilityForSubStage,
} from "../../src/trauma/stageConfig.js";
import type { CaseState } from "../../src/trauma/types.js";

test("later-stage order matches the specification", () => {
  assert.deepEqual(SUBSTAGE_ORDER, [
    "primary_first_aid",
    "advanced_first_aid",
    "emergency_treatment",
    "surgical_resuscitation",
  ]);
  assert.equal(isLaterSubStage("primary_first_aid", "advanced_first_aid"), true);
  assert.equal(isLaterSubStage("emergency_treatment", "primary_first_aid"), false);
  assert.equal(isLaterSubStage("primary_first_aid", "primary_first_aid"), false);
  assert.equal(typicalFacilityForSubStage("surgical_resuscitation").name, "医务中心");
  assert.equal(
    isLaterSubStage(null, "field_specialist_treatment" as never),
    false,
    "legacy or forged unsupported substages must be rejected at runtime",
  );
});

test("node status follows current stage and Gate state", () => {
  const base = {
    currentSubStage: "primary_first_aid",
    transport: { gateStatus: "ASSESSING" },
    pendingTransition: undefined,
  } as Pick<CaseState, "currentSubStage" | "transport" | "pendingTransition">;

  assert.equal(deriveNodeStatus(base, "primary_first_aid"), "current");
  assert.equal(
    deriveNodeStatus({
      ...base,
      transport: { gateStatus: "BLOCKED" },
    } as typeof base, "primary_first_aid"),
    "blocked",
  );
  assert.equal(
    deriveNodeStatus({
      ...base,
      transport: { gateStatus: "READY" },
      pendingTransition: {
        askedAt: "2026-09-03T15:09:00+08:00",
        targetStage: "battlefield_first_aid",
        targetSubStage: "advanced_first_aid",
        reason: "higher capability required",
      },
    } as typeof base, "primary_first_aid"),
    "transfer_preparing",
  );
  assert.equal(deriveNodeStatus(base, "advanced_first_aid"), "not_started");
  assert.equal(
    deriveNodeStatus({
      ...base,
      currentSubStage: "advanced_first_aid",
    } as typeof base, "primary_first_aid"),
    "completed",
  );
  assert.equal(
    deriveNodeStatus({
      currentSubStage: null,
      transport: { gateStatus: "ASSESSING" },
      pendingTransition: undefined,
    } as Pick<CaseState, "currentSubStage" | "transport" | "pendingTransition">, "primary_first_aid"),
    "not_started",
  );
  assert.equal(isLaterSubStage(null, "emergency_treatment"), true);
});
