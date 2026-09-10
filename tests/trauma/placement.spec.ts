import assert from "node:assert/strict";
import test from "node:test";

import { resolveStagePlacement } from "../../src/trauma/placement.js";

test("definition placement requires mapping, rationale, and definition references", () => {
  const placed = resolveStagePlacement({
    placement: {
      determined: true,
      source: "definition",
      stage: "early_treatment",
      subStage: "emergency_treatment",
      rationale: "需要紧急处置级能力",
      definitionReferences: ["第八条【早期救治】·紧急处置"],
    },
  });
  assert.equal(placed.determined, true);
  assert.equal(placed.subStage, "emergency_treatment");
  assert.equal(placed.facility?.name, "旅（团）救护所");
});

test("mismatched stage mapping stays empty", () => {
  const placed = resolveStagePlacement({
    placement: {
      determined: true,
      source: "definition",
      stage: "battlefield_first_aid",
      subStage: "emergency_treatment",
      rationale: "错误映射",
      definitionReferences: ["第八条【早期救治】·紧急处置"],
    },
  });
  assert.equal(placed.determined, false);
  assert.equal(placed.stage, null);
  assert.equal(placed.facility, null);
});

test("missing definition reference or rationale stays empty", () => {
  const noEvidence = resolveStagePlacement({
    placement: {
      determined: true,
      source: "definition",
      stage: "battlefield_first_aid",
      subStage: "primary_first_aid",
      rationale: "初级急救",
      definitionReferences: [],
    },
  });
  assert.equal(noEvidence.determined, false);

  const noRationale = resolveStagePlacement({
    placement: {
      determined: true,
      source: "definition",
      stage: "battlefield_first_aid",
      subStage: "primary_first_aid",
      rationale: "  ",
      definitionReferences: ["Ⅰ级·初级急救"],
    },
  });
  assert.equal(noRationale.determined, false);
});

test("facility is always derived from selected substage", () => {
  const placed = resolveStagePlacement({
    placement: {
      determined: true,
      source: "user_stated",
      stage: "battlefield_first_aid",
      subStage: "advanced_first_aid",
      rationale: "需要高级急救",
      definitionReferences: [],
    },
  });
  assert.equal(placed.facility?.name, "营救护站");
  assert.equal(placed.facility?.type, "battalion_aid_station");
});
