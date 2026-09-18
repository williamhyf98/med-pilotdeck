import assert from "node:assert/strict";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import { REASONER_OUTPUT_SCHEMA } from "../../src/trauma/schemas.js";
import { initialCaseState } from "../../src/trauma/stageConfig.js";
import { createReasonerStation } from "../../src/trauma/stations/reasoner.js";
import { REASONER_SYSTEM_PROMPT } from "../../src/trauma/stations/reasonerPrompt.js";
import {
  TRAUMA_PRESENTATION_PRIORITY_RULE,
  TRAUMA_PRESENTATION_SAFETY_BOUNDARY,
} from "../../src/trauma/memory/EffectivePresentationPolicy.js";
import { TRAUMA_DEFAULT_REASONER_ANSWER_LENGTH_RULE } from "../../src/trauma/presentationDefaults.js";
import type { EvidenceChunk } from "../../src/trauma/types.js";

const now = "2026-09-03T15:09:00+08:00";
const state = initialCaseState({
  projectId: "trauma_med-demo",
  sessionId: "web:s_demo",
  now,
});
state.currentStage = "battlefield_first_aid";
state.currentSubStage = "primary_first_aid";
const promptChunks: EvidenceChunk[] = [{
  id: "chunk-stage",
  knowledgeBase: "trauma",
  documentTitle: "战伤救治规则",
  section: "初级急救",
  text: "止血通气包扎固定",
  retrievalScore: 0.9,
  coverageTags: ["stage"],
  selectedForPrompt: true,
  usedInAnswer: false,
  retrievalBackend: "remote",
}];

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

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    naturalLanguageAnswer: "当前仍在初级急救。建议压迫止血并准备后送确认。",
    classification: {
      version: 1,
      type: "emergency_triage",
      createdAt: now,
      severity: "severe",
      treatmentPriority: "urgent",
      transportPriority: "urgent",
      rationale: ["呼吸急促"],
    },
    treatmentPlan: [
      {
        id: "act-1",
        title: "压迫止血",
        description: "继续控制右小腿出血",
        scope: "current_stage",
        priority: 1,
        evidenceChunkIds: ["chunk-stage"],
        professionalConfirmationRequired: false,
      },
    ],
    missingInformation: ["胸部是否开放伤"],
    transition: {
      status: "READY",
      targetStage: "battlefield_first_aid",
      targetSubStage: "advanced_first_aid",
      reason: "需要更高通气能力",
      requiresUserConfirmation: true,
    },
    gateAssessment: {
      needHigherCapability: true,
      requiredCapabilities: ["胸腔闭式引流"],
      targetStage: "battlefield_first_aid",
      targetSubStage: "advanced_first_aid",
      transportReadiness: "ready",
      instabilityIndicators: ["呼吸32次"],
      blockingFactors: [],
      transportPrerequisites: ["气道评估"],
      ruleConflicts: [],
      confidence: 0.88,
      evidenceChunkIds: ["chunk-stage"],
    },
    memo: {
      round: 2,
      mainStage: "battlefield_first_aid",
      subStage: "primary_first_aid",
      title: "生命体征补充",
      inputPoints: ["呼吸32次", "收缩压95"],
      actionPoints: ["继续止血", "观察呼吸"],
      conclusion: "建议确认转入高级急救",
    },
    ...overrides,
  };
}

test("reasoner treats clinical sections and attachment interpretation as preference-aware defaults", () => {
  assert.match(
    REASONER_SYSTEM_PROMPT,
    /必须覆盖：结论、确认阶段、当前措施、阶段\/后送建议、关键缺失信息，以及 attachmentInterpretation\.current 非空时的影像\/附件判读/u,
  );
  assert.match(REASONER_SYSTEM_PROMPT, /没有适用表达偏好时，必须使用五至六段式/u);
  assert.match(REASONER_SYSTEM_PROMPT, /presentationPolicy 存在表达偏好需求时，必须按照其中的需求进行输出/u);
  assert.doesNotMatch(REASONER_SYSTEM_PROMPT, /缺一不可/u);
  assert.ok(REASONER_SYSTEM_PROMPT.includes(TRAUMA_PRESENTATION_PRIORITY_RULE));
  assert.ok(REASONER_SYSTEM_PROMPT.includes(TRAUMA_PRESENTATION_SAFETY_BOUNDARY));
  assert.match(REASONER_SYSTEM_PROMPT, /只输出 attachmentInterpretation\.current/u);
  assert.match(REASONER_SYSTEM_PROMPT, /current 为 null 时，不生成/u);
  assert.match(REASONER_SYSTEM_PROMPT, /history 仅用于内部综合判断/u);
});

test("reasoner uses one shared longer default-answer rule in its prompt and output schema", () => {
  const schema = REASONER_OUTPUT_SCHEMA as any;
  const answerDescription = schema.properties.naturalLanguageAnswer.description;

  assert.match(TRAUMA_DEFAULT_REASONER_ANSWER_LENGTH_RULE, /1200～2500/u);
  assert.ok(REASONER_SYSTEM_PROMPT.includes(TRAUMA_DEFAULT_REASONER_ANSWER_LENGTH_RULE));
  assert.ok(answerDescription.includes(TRAUMA_DEFAULT_REASONER_ANSWER_LENGTH_RULE));
});

test("reasoner sends presentationPolicy as a separate non-clinical input", async () => {
  let userPayload = "";
  const client: StructuredModelClient = {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      userPayload = input.user;
      return validPayload() as T;
    },
  };

  await createReasonerStation(client).reason({
    state,
    promptChunks,
    presentationPolicy: "## 当前轮偏好\n- 使用表格",
  });

  const parsed = JSON.parse(userPayload);
  assert.equal(parsed.presentationPolicy, "## 当前轮偏好\n- 使用表格");
  assert.equal("memoryContext" in parsed, false);
});

test("rejects current_stage actions that cite unknown chunk ids", async () => {
  const { reason } = createReasonerStation(fakeClient(validPayload({
    treatmentPlan: [{
      id: "act-1",
      title: "压迫止血",
      description: "继续控制右小腿出血",
      scope: "current_stage",
      priority: 1,
      evidenceChunkIds: ["chunk-missing"],
      professionalConfirmationRequired: false,
    }],
  })));
  await assert.rejects(
    () => reason({ state, promptChunks }),
    /schema/i,
  );
});

test("rewrites out-of-scope current_stage actions at primary first aid", async () => {
  const { reason } = createReasonerStation(fakeClient(validPayload({
    treatmentPlan: [{
      id: "act-2",
      title: "胸腔穿刺减压",
      description: "疑张力性气胸",
      scope: "current_stage",
      priority: 1,
      evidenceChunkIds: ["chunk-stage"],
      professionalConfirmationRequired: false,
    }],
  })));
  const result = await reason({ state, promptChunks });
  assert.equal(result.treatmentPlan[0]?.scope, "next_stage");
  assert.equal(result.treatmentPlan[0]?.professionalConfirmationRequired, true);
});

test("removes concrete treatment actions beyond early treatment", async () => {
  const surgicalState = structuredClone(state);
  surgicalState.currentStage = "early_treatment";
  surgicalState.currentSubStage = "surgical_resuscitation";
  const { reason } = createReasonerStation(fakeClient(validPayload({
    treatmentPlan: [{
      id: "act-specialist",
      title: "确定性专科手术",
      description: "转入专科治疗后实施确定性手术",
      scope: "next_stage",
      priority: 1,
      evidenceChunkIds: ["chunk-stage"],
      professionalConfirmationRequired: true,
    }],
    memo: {
      round: 2,
      mainStage: "early_treatment",
      subStage: "surgical_resuscitation",
      title: "外科复苏",
      inputPoints: ["需要更高能力"],
      actionPoints: ["建议后送"],
      conclusion: "建议转入专科治疗（Ⅲ级）",
    },
  })));

  const result = await reason({ state: surgicalState, promptChunks });

  assert.deepEqual(result.treatmentPlan, []);
});

test("accepts memos whose points exceed the suggested length instead of failing the turn", async () => {
  // 长度只是 schema 描述里的软提示：偶尔超出不应中断整轮推演，展示层负责截断。
  const longPoint = "这是一条远远超过三十个字的输入要点，但不应该让整轮推演直接失败";
  const { reason } = createReasonerStation(fakeClient(validPayload({
    memo: {
      round: 2,
      mainStage: "battlefield_first_aid",
      subStage: "primary_first_aid",
      title: "生命体征补充",
      inputPoints: [longPoint],
      actionPoints: ["继续止血"],
      conclusion: "建议确认转入高级急救",
    },
  })));

  const result = await reason({ state, promptChunks });

  assert.deepEqual(result.memo.inputPoints, [longPoint]);
});

test("rejects COMPLETED transition suggestions", async () => {
  const { reason } = createReasonerStation(fakeClient(validPayload({
    transition: {
      status: "COMPLETED",
      reason: "already moved",
      requiresUserConfirmation: false,
    },
  })));
  await assert.rejects(
    () => reason({ state, promptChunks }),
    /schema/i,
  );
});

test("READY gate remains advice and never requires another confirmation", async () => {
  const { reason } = createReasonerStation(fakeClient(validPayload({
    transition: {
      status: "READY",
      targetStage: "battlefield_first_aid",
      targetSubStage: "advanced_first_aid",
      reason: "需要更高通气能力",
      requiresUserConfirmation: false,
    },
  })));
  const result = await reason({ state, promptChunks });
  assert.equal(result.transition.requiresUserConfirmation, false);
});
