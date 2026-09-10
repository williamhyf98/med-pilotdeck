import assert from "node:assert/strict";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import { initialCaseState } from "../../src/trauma/stageConfig.js";
import { PLACEMENT_SYSTEM_PROMPT } from "../../src/trauma/stations/placementPrompt.js";
import { createPlacementStation } from "../../src/trauma/stations/placer.js";

test("placement prompt checks unsupported levels before definition placement", () => {
  const scopeGate = PLACEMENT_SYSTEM_PROMPT.indexOf("out_of_scope");
  const definitionPlacement = PLACEMENT_SYSTEM_PROMPT.indexOf("定义判断");

  assert.ok(scopeGate >= 0, "提示词必须包含超范围判定");
  assert.ok(definitionPlacement >= 0, "提示词必须包含定义判断");
  assert.ok(
    scopeGate < definitionPlacement,
    "范围判定必须排在定义判断之前",
  );
  // 只能对应后两级的机构必须可被识别，否则机构明示分支会绕过范围判定。
  assert.match(PLACEMENT_SYSTEM_PROMPT, /后方医院/);
  assert.doesNotMatch(PLACEMENT_SYSTEM_PROMPT, /user_stated|用户明示/);
});

test("placement station uses embedded definitions without a retrieval dependency", async () => {
  let request: CompleteJsonInput<unknown> | undefined;
  const model: StructuredModelClient = {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      request = input as CompleteJsonInput<unknown>;
      return {
        determined: true,
        source: "definition",
        stage: "early_treatment",
        subStage: "emergency_treatment",
        rationale: "用户明确说明当前位于Ⅱ级紧急处置",
        definitionReferences: [],
      } as T;
    },
  };
  const previous = initialCaseState({
    projectId: "trauma_med-demo",
    sessionId: "web:s_demo",
    now: "2026-09-04T16:30:00+08:00",
  });
  previous.round = 2;
  previous.vitalSignsHistory.push(
    { round: 1, recordedAt: previous.updatedAt, values: { systolicBloodPressure: 92 } },
    { round: 2, recordedAt: previous.updatedAt, values: { respiratoryRate: 30 } },
  );

  const result = await createPlacementStation(model).place({
    state: previous,
  });

  assert.equal(result.source, "definition");
  assert.equal(result.subStage, "emergency_treatment");
  assert.equal(request?.name, "trauma_place");
  assert.match(request?.user ?? "", /"recentRecords"/);
  assert.match(request?.user ?? "", /"latestByField"/);
  assert.match(request?.user ?? "", /"systolicBloodPressure":\{"value":92,"round":1,"stale":true\}/);
  assert.match(request?.system ?? "", /Ⅰ级/);
  assert.match(request?.system ?? "", /Ⅱ级/);
  assert.doesNotMatch(request?.system ?? "", /field_specialist_treatment/);
  assert.doesNotMatch(request?.system ?? "", /functional_recovery/);
});

test("placement station keeps the result empty when definitions are insufficient", async () => {
  const model: StructuredModelClient = {
    async completeJson<T>(): Promise<T> {
      return {
        determined: false,
        source: "undetermined",
        stage: null,
        subStage: null,
        rationale: "伤情描述不足",
        definitionReferences: [],
      } as T;
    },
  };
  const state = initialCaseState({
    projectId: "trauma_med-demo",
    sessionId: "web:s_demo",
    now: "2026-09-04T16:30:00+08:00",
  });

  const result = await createPlacementStation(model).place({
    state,
  });

  assert.equal(result.determined, false);
  assert.equal(result.stage, null);
  assert.equal(result.subStage, null);
});

test("placement station marks specialist and rehabilitation treatment as out of scope", async () => {
  const model: StructuredModelClient = {
    async completeJson<T>(): Promise<T> {
      return {
        determined: false,
        source: "out_of_scope",
        stage: null,
        subStage: null,
        rationale: "当前情况需要专科治疗（Ⅲ级），超出本系统支持范围。",
        definitionReferences: [],
      } as T;
    },
  };
  const state = initialCaseState({
    projectId: "trauma_med-demo",
    sessionId: "web:s_demo",
    now: "2026-09-04T16:30:00+08:00",
  });

  const result = await createPlacementStation(model).place({
    state,
  });

  assert.equal(result.source, "out_of_scope");
  assert.match(result.rationale, /专科治疗（Ⅲ级）/);
});
