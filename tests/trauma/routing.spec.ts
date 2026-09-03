// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

function fakeResponse() {
  return {
    messageId: "message-1",
    caseVersion: 2,
    round: 1,
    naturalLanguageAnswer: "当前仍在初级急救。",
    stage: { main: "battlefield_first_aid", sub: "primary_first_aid" },
    classification: {
      version: 1,
      type: "emergency_triage",
      createdAt: "2026-09-03T15:09:00+08:00",
      severity: "severe",
      treatmentPriority: "urgent",
      transportPriority: "urgent",
      rationale: [],
    },
    treatmentPlan: [],
    missingInformation: [],
    timeline: {
      injuryTime: "",
      currentTime: "2026-09-03T15:09:00+08:00",
      elapsedMinutes: 0,
      timingStatus: "within_window",
      isHardGate: false,
    },
    transition: {
      status: "READY",
      targetStage: "battlefield_first_aid",
      targetSubStage: "advanced_first_aid",
      reason: "需要高级急救能力",
      requiresUserConfirmation: true,
    },
    gateAssessment: {
      needHigherCapability: true,
      requiredCapabilities: ["高级通气"],
      transportReadiness: "ready",
      instabilityIndicators: [],
      blockingFactors: [],
      transportPrerequisites: [],
      ruleConflicts: [],
      confidence: 0.9,
      evidenceChunkIds: ["chunk-1"],
    },
    memo: {
      round: 1,
      mainStage: "battlefield_first_aid",
      subStage: "primary_first_aid",
      title: "生命体征补充",
      inputPoints: [],
      actionPoints: [],
      conclusion: "建议转入高级急救",
    },
    evidence: [],
  };
}

function fakeSession(counter) {
  return {
    async *submit() {
      counter.submit += 1;
      yield { type: "turn_started", turnId: "turn-1" };
      yield {
        type: "turn_completed",
        result: {
          type: "success",
          stopReason: "completed",
          usage: {},
          messages: [],
          permissionDenials: [],
        },
      };
    },
    abort() {},
    snapshot() {
      return { messages: [], usage: {}, status: "idle", sessionId: "web:s_test" };
    },
  };
}

function createTestGateway(projectKey) {
  const counter = { submit: 0, trauma: 0 };
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(counter),
  });
  const gateway = new InProcessGateway(router, {
    traumaRunnerFactory: async () => ({
      async runTurn() {
        counter.trauma += 1;
        return fakeResponse();
      },
      async confirmTransition() {
        throw new Error("not used");
      },
      async overrideStage() {
        throw new Error("not used");
      },
    }),
  });
  return { gateway, counter, projectKey };
}

test("war_trauma submitTurn uses TraumaTurnRunner instead of AgentSession.submit", async () => {
  const { gateway, counter } = createTestGateway("trauma_med-demo");
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_test",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: "呼吸32次，收缩压95",
  })) {
    events.push(event);
  }

  assert.equal(counter.submit, 0);
  assert.equal(counter.trauma, 1);
  assert.ok(events.some((event) => event.type === "assistant_text_delta"));
  const question = events.find((event) => event.type === "elicitation_request");
  assert.equal(question?.metadata?.source, "trauma_pending_transition");
  assert.equal(question?.metadata?.version, 2);
});

test("general_medicine submitTurn still uses AgentSession.submit", async () => {
  const { gateway, counter } = createTestGateway("general_med-demo");
  for await (const _event of gateway.submitTurn({
    sessionKey: "web:s_test",
    channelKey: "web",
    projectKey: "general_med-demo",
    message: "普通医学问题",
  })) {
    // drain
  }
  assert.equal(counter.submit, 1);
  assert.equal(counter.trauma, 0);
});
