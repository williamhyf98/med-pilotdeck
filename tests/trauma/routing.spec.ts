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
    placement: {
      determined: true,
      stage: "battlefield_first_aid",
      subStage: "primary_first_aid",
      rationale: "按分级定义属初级急救",
      evidenceChunkIds: ["chunk-1"],
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

function createTestGateway(projectKey, options = { askPlacement: false }) {
  const counter = { submit: 0, trauma: 0, recordedUserText: "" };
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(counter),
  });
  const gateway = new InProcessGateway(router, {
    async recordTraumaTurn(input) {
      counter.recordedUserText = input.userText;
    },
    traumaRunnerFactory: async () => ({
      async runTurn(input) {
        counter.trauma += 1;
        if (options.streamAnswer) {
          await input.onAssistantTextDelta?.("当前仍在");
          await input.onAssistantTextDelta?.("初级急救。");
        }
        input.onProgress?.({ phase: "validate", status: "started" });
        input.onProgress?.({ phase: "validate", status: "finished", ok: true });
        if (options.askPlacement) {
          const decision = await input.requestPlacementConfirmation({
            current: { stage: null, subStage: null, facilityName: null },
            proposed: {
              determined: true,
              source: "definition",
              stage: "early_treatment",
              subStage: "emergency_treatment",
              rationale: "符合Ⅱ级紧急处置定义",
              definitionReferences: ["第八条【早期救治】·紧急处置"],
            },
          });
          assert.deepEqual(decision, { choice: "proposed" });
        }
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
    traumaForm: {
      statedSubStage: null, injuryNarrative: "呼吸急促", treatmentNarrative: "",
      evacuationNarrative: "", note: "", vitals: { respiratoryRate: 32, systolicBloodPressure: 95 },
    },
  })) {
    events.push(event);
  }

  assert.equal(counter.submit, 0);
  assert.equal(counter.trauma, 1);
  assert.match(counter.recordedUserText, /伤情：呼吸急促/);
  assert.match(counter.recordedUserText, /生命体征：呼吸 32，收缩压 95/);
  assert.ok(events.some((event) => event.type === "assistant_text_delta"));

  // 推演开始就要有 turn_started 和阶段进度，等待期间界面才不会停在「连接中」。
  assert.equal(events.filter((event) => event.type === "turn_started").length, 1);
  assert.equal(events[0]?.type, "turn_started");
  const progressStarted = events.find((event) => event.type === "tool_call_started");
  assert.equal(progressStarted?.name, "校验并合并表单");
  assert.ok(events.some((event) =>
    event.type === "tool_call_finished" && event.toolName === "校验并合并表单" && event.ok === true));
  assert.ok(
    events.indexOf(progressStarted) < events.findIndex((event) => event.type === "assistant_text_delta"),
  );

  assert.equal(events.some((event) => event.type === "elicitation_request"), false);
});

test("war_trauma submitTurn rejects a missing form before invoking runner", async () => {
  const { gateway, counter } = createTestGateway("trauma_med-demo");
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_missing_form",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: "",
  })) events.push(event);
  assert.equal(counter.trauma, 0);
  assert.ok(events.some((event) => event.type === "error"));
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

test("placement confirmation pauses the trauma turn and resumes through elicitation", async () => {
  const { gateway } = createTestGateway("trauma_med-demo", { askPlacement: true });
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_place",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: "胸部爆炸伤，血压测不到",
    traumaForm: {
      statedSubStage: null, injuryNarrative: "胸部爆炸伤，血压测不到", treatmentNarrative: "",
      evacuationNarrative: "", note: "", vitals: {},
    },
  })) {
    events.push(event);
    if (event.type === "elicitation_request") {
      assert.equal(event.metadata?.source, "trauma_pending_placement");
      await gateway.respondElicitation({
        sessionKey: "web:s_place",
        requestId: event.requestId,
        answer: {
          type: "answered",
          answers: {
            "请选择本轮后续推演采用的主级和子级": event.questions[0].options[0].label,
          },
        },
      });
    }
  }
  const questionIndex = events.findIndex((event) => event.type === "elicitation_request");
  const answerIndex = events.findIndex((event) => event.type === "assistant_text_delta");
  assert.ok(questionIndex >= 0);
  assert.ok(answerIndex > questionIndex);
});

test("forwards streamed trauma answer deltas without duplicating the final answer", async () => {
  const { gateway } = createTestGateway("trauma_med-demo", { streamAnswer: true });
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_stream",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: "右小腿开放伤",
    traumaForm: {
      statedSubStage: "primary_first_aid", injuryNarrative: "右小腿开放伤", treatmentNarrative: "",
      evacuationNarrative: "", note: "", vitals: {},
    },
  })) {
    events.push(event);
  }
  const deltas = events
    .filter((event) => event.type === "assistant_text_delta")
    .map((event) => event.text);
  assert.deepEqual(deltas, ["当前仍在", "初级急救。"]);
  assert.equal(events.at(-1)?.type, "turn_completed");
});
