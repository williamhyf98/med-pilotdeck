import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import type { TraumaRagClient } from "../../src/trauma/rag/client.js";
import { createTraumaTurnRunner } from "../../src/trauma/runner.js";
import { initialCaseState } from "../../src/trauma/stageConfig.js";
import { createTraumaCaseStore } from "../../src/trauma/store.js";
import type { ExtractedTurnFacts } from "../../src/trauma/types.js";

const now = "2026-09-03T15:09:00+08:00";

function extractedVitals(): ExtractedTurnFacts {
  return {
    turnKind: "case_update",
    context: {
      eventTime: {
        value: "2026-09-03T14:55:00+08:00",
        sourceMessageId: "message-2",
        sourceQuote: "伤后14分钟",
        certainty: "confirmed",
        confidence: 0.9,
      },
    },
    vitalSigns: [
      {
        value: { type: "respiratory_rate", value: 32, unit: "/min" },
        sourceMessageId: "message-2",
        sourceQuote: "呼吸32次",
        measuredAt: now,
        certainty: "confirmed",
        confidence: 0.9,
      },
    ],
    injuryFindings: [],
    treatmentEvents: [],
    careAndTransportFacts: [],
    correctionsAndProvenance: { conflictingFactIds: [] },
  };
}

function reasonPayload() {
  return {
    naturalLanguageAnswer: "当前仍在初级急救，建议确认转入高级急救。",
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
        description: "继续控制出血",
        scope: "current_stage",
        priority: 1,
        evidenceChunkIds: ["chunk-stage"],
        professionalConfirmationRequired: false,
      },
    ],
    missingInformation: [],
    transition: {
      status: "READY",
      targetStage: "battlefield_first_aid",
      targetSubStage: "advanced_first_aid",
      reason: "需要更高通气能力",
      requiresUserConfirmation: true,
    },
    gateAssessment: {
      needHigherCapability: true,
      requiredCapabilities: ["高级通气支持"],
      targetStage: "battlefield_first_aid",
      targetSubStage: "advanced_first_aid",
      transportReadiness: "ready",
      instabilityIndicators: [],
      blockingFactors: [],
      transportPrerequisites: [],
      ruleConflicts: [],
      confidence: 0.9,
      evidenceChunkIds: ["chunk-stage"],
    },
    memo: {
      round: 1,
      mainStage: "battlefield_first_aid",
      subStage: "primary_first_aid",
      title: "生命体征补充",
      inputPoints: ["呼吸32次"],
      actionPoints: ["继续止血"],
      conclusion: "建议确认转入高级急救",
    },
  };
}

function fakeModel(options: {
  extract?: ExtractedTurnFacts;
  planQueries?: Array<{ query: string; reason: string }>;
  failAt?: "trauma_extract" | "trauma_plan" | "trauma_reason";
}): StructuredModelClient {
  return {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      if (options.failAt === input.name) {
        throw new Error(`${input.name} failed`);
      }
      const payload = input.name === "trauma_extract"
        ? (options.extract ?? extractedVitals())
        : input.name === "trauma_plan"
          ? { queries: options.planQueries ?? [] }
          : reasonPayload();
      if (!input.validate(payload)) {
        throw new Error("schema validation failed");
      }
      return payload;
    },
  };
}

function fakeRag(calls: { count: number }): TraumaRagClient {
  return {
    async query() {
      calls.count += 1;
      return {
        retrieval_backend: "remote",
        chunks: [
          {
            chunk_id: "chunk-stage",
            text: "止血通气包扎固定搬运",
            score: 0.99,
            title: "战伤救治规则",
            retrieval_backend: "remote",
          },
          {
            chunk_id: `chunk-${calls.count}-a`,
            text: "分类与后送",
            score: 0.8,
            retrieval_backend: "remote",
          },
          {
            chunk_id: `chunk-${calls.count}-b`,
            text: "胸部伤观察",
            score: 0.7,
            retrieval_backend: "remote",
          },
        ],
      };
    },
  };
}

test("happy path keeps the stage, stores pending transition and one memo", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-runner-"));
  try {
    const store = createTraumaCaseStore(root);
    const ragCalls = { count: 0 };
    const runner = createTraumaTurnRunner({
      store,
      model: fakeModel({}),
      rag: fakeRag(ragCalls),
    });
    const response = await runner.runTurn({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      messageId: "message-2",
      userText: "呼吸32次，收缩压95",
      now,
    });
    const saved = await store.load();
    assert.equal(ragCalls.count, 3);
    assert.equal(response.stage.sub, "primary_first_aid");
    assert.equal(response.transition.status, "READY");
    assert.equal(response.transition.requiresUserConfirmation, true);
    assert.equal(saved?.currentStage, "battlefield_first_aid");
    assert.equal(saved?.pendingTransition?.targetSubStage, "advanced_first_aid");
    assert.equal(saved?.memos.length, 1);
    assert.equal(saved?.round, 1);
    assert.equal(saved?.version, 1);
    assert.equal(saved?.transport.gateStatus, "READY");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no_case_update skips retrieval and persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-runner-idle-"));
  try {
    const store = createTraumaCaseStore(root);
    const ragCalls = { count: 0 };
    const runner = createTraumaTurnRunner({
      store,
      model: fakeModel({
        extract: {
          turnKind: "no_case_update",
          context: {},
          vitalSigns: [],
          injuryFindings: [],
          treatmentEvents: [],
          careAndTransportFacts: [],
          correctionsAndProvenance: { conflictingFactIds: [] },
        },
      }),
      rag: fakeRag(ragCalls),
    });
    const response = await runner.runTurn({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      messageId: "message-hi",
      userText: "你好",
      now,
    });
    assert.equal(ragCalls.count, 0);
    assert.ok(response.naturalLanguageAnswer.length > 0);
    assert.equal("changed" in response.stage, false);
    assert.equal(await store.load(), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("second-wave queries stay within a 3-6 call budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-runner-wave2-"));
  try {
    const store = createTraumaCaseStore(root);
    const ragCalls = { count: 0 };
    const runner = createTraumaTurnRunner({
      store,
      model: fakeModel({
        planQueries: [
          { query: "空运禁忌", reason: "transport" },
          { query: "骨盆伤", reason: "injury" },
        ],
      }),
      rag: fakeRag(ragCalls),
    });
    await runner.runTurn({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      messageId: "message-2",
      userText: "呼吸32次",
      now,
    });
    assert.equal(ragCalls.count, 5);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("station failure leaves the previous current state unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-runner-fail-"));
  try {
    const store = createTraumaCaseStore(root);
    const previous = initialCaseState({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      now,
    });
    previous.version = 1;
    await store.saveTurn(previous, {
      eventType: "agent_turn",
      round: 1,
      createdAt: now,
      triggerMessageId: "message-1",
      state: previous,
    });
    const runner = createTraumaTurnRunner({
      store,
      model: fakeModel({ failAt: "trauma_reason" }),
      rag: fakeRag({ count: 0 }),
    });
    await assert.rejects(() => runner.runTurn({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      messageId: "message-2",
      userText: "呼吸32次",
      now,
    }));
    assert.equal((await store.load())?.version, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
