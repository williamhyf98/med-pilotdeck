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
import { traumaTurnEvents } from "../../src/trauma/events.js";
import {
  DEMO_ROUND_2_EXTRACTED,
  DEMO_ROUND_2_REASONER_OUTPUT,
  DEMO_ROUND_2_USER_TEXT,
} from "./demoRound2.fixture.js";

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
  reason?: unknown;
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
          : (options.reason ?? reasonPayload());
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

test("round 2 fixture keeps initial aid while raising a READY confirmation", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-runner-round-2-"));
  try {
    const store = createTraumaCaseStore(root);
    const previous = initialCaseState({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      now: "2026-09-03T14:55:00+08:00",
    });
    previous.version = 1;
    previous.round = 1;
    previous.timeline.injuryTime = "2026-09-03T14:55:00+08:00";
    await store.saveTurn(previous, {
      eventType: "agent_turn",
      round: 1,
      createdAt: previous.updatedAt,
      triggerMessageId: "message-1",
      state: previous,
    });

    const runner = createTraumaTurnRunner({
      store,
      model: fakeModel({
        extract: DEMO_ROUND_2_EXTRACTED,
        reason: DEMO_ROUND_2_REASONER_OUTPUT,
      }),
      rag: fakeRag({ count: 0 }),
    });
    const response = await runner.runTurn({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      messageId: "message-2",
      userText: DEMO_ROUND_2_USER_TEXT,
      now,
    });
    const saved = await store.load();
    const confirmation = traumaTurnEvents({
      response,
      runId: "run-2",
      version: response.caseVersion,
    }).find((event) => event.type === "elicitation_request");

    assert.equal(response.timeline.timingStatus, "exceeded");
    assert.equal(response.stage.sub, "primary_first_aid");
    assert.equal(saved?.currentSubStage, "primary_first_aid");
    assert.equal(response.transition.status, "READY");
    assert.equal(response.memo.title, "生命体征补充");
    assert.match(confirmation?.questions[0]?.question ?? "", /高级急救/);
    assert.doesNotMatch(JSON.stringify({ response, saved }), /营救护站/);
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

test("stale confirmation is rejected without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-confirm-stale-"));
  try {
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({ store, model: fakeModel({}), rag: fakeRag({ count: 0 }) });
    await runner.runTurn({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      messageId: "message-2",
      userText: "呼吸32次",
      now,
    });
    await assert.rejects(() => runner.confirmTransition({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      answer: "confirmed",
      expectedVersion: 0,
    }));
    assert.equal((await store.load())?.version, 1);
    assert.equal((await store.load())?.currentSubStage, "primary_first_aid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("confirmed transition completes the gate without a new memo leaf", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-confirm-ok-"));
  try {
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({ store, model: fakeModel({}), rag: fakeRag({ count: 0 }) });
    await runner.runTurn({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      messageId: "message-2",
      userText: "呼吸32次",
      now,
    });
    const snapshot = await runner.confirmTransition({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      answer: "confirmed",
      expectedVersion: 1,
    });
    assert.equal(snapshot.eventType, "transition_confirmation");
    assert.equal(snapshot.state.currentSubStage, "advanced_first_aid");
    assert.equal(snapshot.state.transport.gateStatus, "COMPLETED");
    assert.equal(snapshot.state.pendingTransition, undefined);
    assert.equal(snapshot.state.memos.length, 1);
    assert.equal(snapshot.state.round, 1);
    assert.equal(snapshot.state.version, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("declined transition keeps the stage and does not add a memo", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-confirm-no-"));
  try {
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({ store, model: fakeModel({}), rag: fakeRag({ count: 0 }) });
    await runner.runTurn({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      messageId: "message-2",
      userText: "呼吸32次",
      now,
    });
    const snapshot = await runner.confirmTransition({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      answer: "declined",
      expectedVersion: 1,
    });
    assert.equal(snapshot.state.currentSubStage, "primary_first_aid");
    assert.equal(snapshot.state.transport.confirmation?.answer, "declined");
    assert.equal(snapshot.state.memos.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manual override can jump forward but not backward and does not call RAG", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-override-"));
  try {
    const store = createTraumaCaseStore(root);
    const previous = initialCaseState({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      now,
    });
    previous.version = 1;
    previous.transport.gateStatus = "BLOCKED";
    previous.currentFacility = { name: "连抢救组", type: "company_aid_team", capabilities: ["止血"] };
    previous.currentCapabilities = ["止血"];
    await store.saveTurn(previous, {
      eventType: "agent_turn",
      round: 1,
      createdAt: now,
      triggerMessageId: "message-1",
      state: previous,
    });
    const ragCalls = { count: 0 };
    const runner = createTraumaTurnRunner({ store, model: fakeModel({}), rag: fakeRag(ragCalls) });
    await assert.rejects(() => runner.overrideStage({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      actorId: "user-1",
      toStage: "battlefield_first_aid",
      toSubStage: "primary_first_aid",
      reason: "too early",
      riskAcknowledged: true,
      blockedOverrideConfirmed: true,
    }));
    await assert.rejects(() => runner.overrideStage({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      actorId: "user-1",
      toStage: "early_treatment",
      toSubStage: "emergency_treatment",
      reason: "force",
      riskAcknowledged: true,
    }));
    const snapshot = await runner.overrideStage({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      actorId: "user-1",
      toStage: "early_treatment",
      toSubStage: "emergency_treatment",
      reason: "现场指挥要求",
      riskAcknowledged: true,
      blockedOverrideConfirmed: true,
    });
    assert.equal(ragCalls.count, 0);
    assert.equal(snapshot.eventType, "manual_stage_override");
    assert.equal(snapshot.state.currentSubStage, "emergency_treatment");
    assert.equal(snapshot.state.currentFacility.name, "连抢救组");
    assert.deepEqual(snapshot.state.currentCapabilities, ["止血"]);
    assert.equal(snapshot.state.transport.gateStatus, "COMPLETED");
    assert.equal(snapshot.state.manualStageOverrides[0]?.originalGateStatus, "BLOCKED");
    assert.ok((snapshot.state.manualStageOverrides[0]?.unresolvedRisks.length ?? 0) >= 0);
    assert.equal(snapshot.state.memos.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
