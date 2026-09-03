import assert from "node:assert/strict";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import { initialCaseState } from "../../src/trauma/stageConfig.js";
import { createReasonerStation } from "../../src/trauma/stations/reasoner.js";
import type { EvidenceChunk, TimelineState } from "../../src/trauma/types.js";

const now = "2026-09-03T15:09:00+08:00";
const state = initialCaseState({
  projectId: "trauma_med-demo",
  sessionId: "web:s_demo",
  now,
});
const timeline: TimelineState = {
  injuryTime: "2026-09-03T14:55:00+08:00",
  currentTime: now,
  elapsedMinutes: 14,
  recommendedWindowMinutes: 10,
  timingStatus: "exceeded",
  isHardGate: false,
};
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
    () => reason({ state, timeline, promptChunks }),
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
  const result = await reason({ state, timeline, promptChunks });
  assert.equal(result.treatmentPlan[0]?.scope, "next_stage");
  assert.equal(result.treatmentPlan[0]?.professionalConfirmationRequired, true);
});

test("rejects memos that exceed point and conclusion limits", async () => {
  const { reason } = createReasonerStation(fakeClient(validPayload({
    memo: {
      round: 2,
      mainStage: "battlefield_first_aid",
      subStage: "primary_first_aid",
      title: "生命体征补充",
      inputPoints: ["这是一条远远超过三十个字的输入要点所以应当被 schema 拒绝掉"],
      actionPoints: ["继续止血"],
      conclusion: "建议确认转入高级急救",
    },
  })));
  await assert.rejects(
    () => reason({ state, timeline, promptChunks }),
    /schema/i,
  );
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
    () => reason({ state, timeline, promptChunks }),
    /schema/i,
  );
});

test("READY suggestions require user confirmation", async () => {
  const { reason } = createReasonerStation(fakeClient(validPayload({
    transition: {
      status: "READY",
      targetStage: "battlefield_first_aid",
      targetSubStage: "advanced_first_aid",
      reason: "需要更高通气能力",
      requiresUserConfirmation: false,
    },
  })));
  const result = await reason({ state, timeline, promptChunks });
  assert.equal(result.transition.requiresUserConfirmation, true);
});
