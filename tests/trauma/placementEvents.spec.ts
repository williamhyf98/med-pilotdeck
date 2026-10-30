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

test("placement question leads with the proposal and its rationale", () => {
  const options = placementConfirmationOptions(request);
  assert.match(options[0]?.label ?? "", /采用建议.*Ⅱ级.*紧急处置/);
  assert.equal(options[0]?.description, "符合Ⅱ级紧急处置定义");
});

test("placement question lists the same sub-stages the form allows, minus the proposal", () => {
  const labels = placementConfirmationOptions(request).slice(1).map((option) => option.label);
  // 当前是初级急救，表单允许「当前及其之后」的子级；建议项（紧急处置）已在首位，不重复。
  assert.equal(labels.length, 3);
  assert.match(labels[0], /^改用：Ⅰ级·战现场急救 · 初级急救（连抢救组）/);
  assert.match(labels[1], /^改用：Ⅰ级·战现场急救 · 高级急救/);
  assert.match(labels[2], /^改用：Ⅱ级·早期救治 · 外科复苏/);
  assert.equal(labels.some((label) => label.includes("紧急处置")), false);
});

test("placement question never offers a sub-stage earlier than the current one", () => {
  const labels = placementConfirmationOptions({
    ...request,
    current: { stage: "early_treatment", subStage: "emergency_treatment", facilityName: "旅救护所" },
  }).map((option) => option.label);
  assert.equal(labels.some((label) => label.includes("初级急救")), false);
  assert.equal(labels.some((label) => label.includes("高级急救")), false);
});

test("placement answer maps the proposal and each alternative sub-stage", () => {
  const options = placementConfirmationOptions(request);
  assert.deepEqual(parsePlacementConfirmation(request, options[0].label), { choice: "proposed" });
  assert.deepEqual(parsePlacementConfirmation(request, options[1].label), {
    choice: "selected",
    stage: "battlefield_first_aid",
    subStage: "primary_first_aid",
  });
  assert.deepEqual(parsePlacementConfirmation(request, options[3].label), {
    choice: "selected",
    stage: "early_treatment",
    subStage: "surgical_resuscitation",
  });
});

test("placement answer falls back to the proposal when skipped or unrecognised", () => {
  // 关掉/跳过确认卡，以及任何落在选项之外的回答，都按建议继续，流程不能卡死。
  assert.deepEqual(parsePlacementConfirmation(request, undefined), { choice: "proposed" });
  assert.deepEqual(parsePlacementConfirmation(request, "随便写点什么"), { choice: "proposed" });
});
