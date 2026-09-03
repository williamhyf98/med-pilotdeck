import assert from "node:assert/strict";
import test from "node:test";

import { resolveGate } from "../../src/trauma/gate.js";
import type { ClinicalGateAssessment, RetrievalTrace } from "../../src/trauma/types.js";

function assessment(overrides: Partial<ClinicalGateAssessment> = {}): ClinicalGateAssessment {
  return {
    needHigherCapability: true,
    requiredCapabilities: ["胸腔闭式引流"],
    targetStage: "battlefield_first_aid",
    targetSubStage: "advanced_first_aid",
    transportReadiness: "ready",
    instabilityIndicators: [],
    blockingFactors: [],
    transportPrerequisites: [],
    ruleConflicts: [],
    confidence: 0.9,
    evidenceChunkIds: ["chunk-1"],
    ...overrides,
  };
}

function retrieval(overrides: Partial<RetrievalTrace> = {}): RetrievalTrace {
  return {
    queries: [],
    totalCalls: 3,
    allChunkIds: ["chunk-1"],
    promptChunkIds: ["chunk-1"],
    criticalCoverageGaps: [],
    ...overrides,
  };
}

test("timeout alone stays when higher capability is not needed", () => {
  assert.equal(
    resolveGate(assessment({ needHigherCapability: false }), retrieval()),
    "STAY",
  );
});

test("not_ready transport with higher capability is BLOCKED", () => {
  assert.equal(
    resolveGate(assessment({ transportReadiness: "not_ready" }), retrieval()),
    "BLOCKED",
  );
});

test("unresolved conflicts and missing evidence force ASSESSING", () => {
  assert.equal(
    resolveGate(assessment({
      ruleConflicts: [{ summary: "conflict", evidenceChunkIds: ["chunk-1"], unresolved: true }],
    }), retrieval()),
    "ASSESSING",
  );
  assert.equal(resolveGate(assessment({ evidenceChunkIds: [] }), retrieval()), "ASSESSING");
  assert.equal(
    resolveGate(assessment(), retrieval({ criticalCoverageGaps: ["primary_injury"] })),
    "ASSESSING",
  );
  assert.equal(resolveGate(assessment({ confidence: 0.74 }), retrieval()), "ASSESSING");
});

test("READY requires target stages, capabilities and ready transport", () => {
  assert.equal(resolveGate(assessment(), retrieval()), "READY");
  assert.equal(
    resolveGate(assessment({ targetSubStage: undefined }), retrieval()),
    "ASSESSING",
  );
  assert.equal(
    resolveGate(assessment({ requiredCapabilities: [] }), retrieval()),
    "ASSESSING",
  );
});
