import assert from "node:assert/strict";
import test from "node:test";

import {
  parsePlacementConfirmation,
  placementConfirmationOptions,
} from "../../src/trauma/events.js";
import type { PlacementConfirmationRequest } from "../../src/trauma/runner.js";

const request: PlacementConfirmationRequest = {
  current: {
    stage: "battlefield_first_aid",
    subStage: "primary_first_aid",
    facilityName: "连抢救组",
  },
  proposed: {
    determined: true,
    source: "definition",
    stage: "early_treatment",
    subStage: "emergency_treatment",
    rationale: "符合Ⅱ级紧急处置定义",
    definitionReferences: ["第八条【早期救治】·紧急处置"],
  },
};

test("placement question offers proposed and current baselines", () => {
  const options = placementConfirmationOptions(request);
  assert.match(options[0]?.label ?? "", /采用建议.*Ⅱ级.*紧急处置/);
  assert.match(options[1]?.label ?? "", /保持当前.*Ⅰ级.*初级急救/);
});

test("placement answer selects proposed or current baseline", () => {
  assert.deepEqual(
    parsePlacementConfirmation(request, "采用建议：Ⅱ级·早期救治 · 紧急处置"),
    { choice: "proposed" },
  );
  assert.deepEqual(parsePlacementConfirmation(request, undefined), { choice: "current" });
});
