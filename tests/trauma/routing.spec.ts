// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";

import { InProcessGateway } from "../../src/gateway/client/InProcessGateway.js";
import { SessionRouter } from "../../src/gateway/SessionRouter.js";

function fakeResponse(overrides = {}) {
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
    ...overrides,
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
  const counter = {
    submit: 0,
    trauma: 0,
    recordedUserText: "",
    runnerForm: null,
    runnerPresentationPolicy: null,
    qaPresentationPolicy: null,
    capturedPreferences: [],
    processMessages: [],
    extractorInput: null,
  };
  const router = new SessionRouter({
    idleSweepIntervalMs: 0,
    createSession: () => fakeSession(counter),
  });
  const gateway = new InProcessGateway(router, {
    async recordTraumaTurn(input) {
      counter.recordedUserText = input.userText;
      counter.processMessages = input.processMessages ?? [];
    },
    ...(options.extractorResult || options.extractorError
      ? {
          traumaExtractorFactory: async () => ({
            async extract(input) {
              counter.extractorInput = input;
              if (options.extractorError) throw options.extractorError;
              return options.extractorResult;
            },
          }),
        }
      : {}),
    traumaRunnerFactory: async () => ({
      async runTurn(input) {
        counter.trauma += 1;
        counter.runnerForm = input.form;
        counter.runnerPresentationPolicy = input.presentationPolicy ?? null;
        if (options.runnerError) throw options.runnerError;
        if (options.streamAnswer) {
          await input.onAssistantTextDelta?.("当前仍在");
          await input.onAssistantTextDelta?.("初级急救。");
        }
        if (options.streamAnswerWithCitation) {
          // 工位 B 开跑前先下发本轮候选引用（promptChunks 全量），编号沿用
          // promptChunks 顺序；正文里只会用到其中一部分。
          await input.onAssistantCitations?.([
            { index: 1, title: "战伤救治规则", section: "第二章 分类救治" },
            { index: 2, title: "战伤救治规则", section: "第五章 后送" },
          ]);
          await input.onAssistantTextDelta?.("应先控制活动性出血[1]。");
          await input.onAssistantTextEnd?.();
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
    traumaPreferenceProvider: options.preferenceMemory
      ? async () => options.preferenceMemory
      : undefined,
    captureTraumaMemory(input) {
      counter.capturedPreferences.push(...(input.preferences ?? []));
      if (options.captureError) throw options.captureError;
    },
    ...(options.knowledgeQaFactory ? { traumaKnowledgeQaFactory: options.knowledgeQaFactory } : {}),
  });
  return { gateway, counter, projectKey };
}

test("domain_question_no_case uses independent knowledge QA with shared RAG and citations", async () => {
  const calls = { runner: 0, rewrite: 0, rag: 0, qa: 0 };
  const { gateway, counter } = createTestGateway("trauma_med-demo", {
    extractorResult: {
      inputIntent: "domain_question_no_case",
      scopeReason: "知识问题",
      injuryNarratives: [],
      treatmentNarratives: [],
      evacuationNarratives: [],
      notes: [],
      vitals: [],
    },
    knowledgeQaFactory: async () => ({
      rewriter: {
        async rewrite() {
          calls.rewrite += 1;
          return {
            rewrittenQueries: [{ query: "战现场急救定义", reason: "标准化" }],
            unresolvedReferences: [],
            needsClarification: false,
          };
        },
      },
      rag: {
        async query(input) {
          calls.rag += 1;
          assert.equal(input.topic, "战创伤");
          return {
            retrieval_backend: "remote",
            chunks: [{
              chunk_id: "knowledge-1",
              text: "战现场急救原则",
              score: 0.9,
              title: "战伤救治规则",
              section: "第二章",
              retrieval_backend: "remote",
            }],
          };
        },
      },
      qa: {
        async answer(input) {
          calls.qa += 1;
          assert.equal(input.promptChunks[0]?.id, "knowledge-1");
          await input.onNaturalLanguageDelta?.("战现场急救见[1]。");
          await input.onNaturalLanguageEnd?.();
          return {
            naturalLanguageAnswer: "战现场急救见[1]。",
            citationChunkIds: ["knowledge-1"],
          };
        },
      },
    }),
  });
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_knowledge",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: "战现场急救是什么？",
    traumaRawInput: "战现场急救是什么？",
    traumaExtract: true,
    traumaForm: {
      statedSubStage: null,
      injuryNarrative: "",
      treatmentNarrative: "",
      evacuationNarrative: "",
      note: "",
      vitals: {},
    },
  })) events.push(event);
  assert.deepEqual(calls, { runner: 0, rewrite: 1, rag: 1, qa: 1 });
  assert.equal(counter.trauma, 0);
  assert.match(events.filter((event) => event.type === "assistant_text_delta").map((event) => event.text).join(""), /战现场急救/);
  assert.deepEqual(events.find((event) => event.type === "assistant_text_end")?.citations, [
    { index: 1, title: "战伤救治规则", section: "第二章" },
  ]);
});

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

test("streams citation metadata with the body and closes with the used subset", async () => {
  const { gateway } = createTestGateway("trauma_med-demo", { streamAnswerWithCitation: true });
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_stream_citation",
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

  const deltaEvents = events.filter((event) => event.type === "assistant_text_delta");
  const streamedText = deltaEvents.map((event) => event.text).join("");
  // 参考来源列表改由前端组件渲染，正文里不再拼接 <details> 溯源块，也没有短引文。
  assert.doesNotMatch(streamedText, /<details>/);
  assert.doesNotMatch(streamedText, /参考来源/);
  assert.doesNotMatch(streamedText, /短引文/);
  assert.match(streamedText, /\[1\]/);

  // 候选引用随第一个 delta 一起下发，前端才能在流式期间就把 [N] 渲染成蓝色上标。
  assert.deepEqual(deltaEvents[0].citations, [
    { index: 1, title: "战伤救治规则", section: "第二章 分类救治" },
    { index: 2, title: "战伤救治规则", section: "第五章 后送" },
  ]);
  assert.ok(deltaEvents.slice(1).every((event) => event.citations === undefined));

  // 正文结束的瞬间下发「实际被引用」的子集，参考来源列表据此整块出现。
  const streamEndIndex = events.findIndex((event) => event.type === "assistant_text_end");
  assert.ok(streamEndIndex >= 0);
  assert.deepEqual(events[streamEndIndex].citations, [
    { index: 1, title: "战伤救治规则", section: "第二章 分类救治" },
  ]);

  const postAnswerIndex = events.findIndex((event) =>
    event.type === "tool_call_started" && event.toolCallId.startsWith("trauma-post-answer:"));
  assert.ok(postAnswerIndex > streamEndIndex);
});

test("traumaExtract runs extraction before the runner and records it as a non-counted process step", async () => {
  const extracted = {
    injuryNarratives: [{ text: "右小腿开放性骨折", sourceSpan: "右小腿开放性骨折" }],
    treatmentNarratives: [{ text: "已加压包扎", sourceSpan: "已加压包扎" }],
    evacuationNarratives: [],
    notes: [],
    vitals: [{ field: "heartRate", value: 118, unit: "次/分", sourceSpan: "心率118" }],
  };
  const { gateway, counter } = createTestGateway("trauma_med-demo", { extractorResult: extracted });
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_extract",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: "右小腿开放性骨折，已加压包扎，心率118",
    traumaForm: {
      statedSubStage: "advanced_first_aid",
      injuryNarrative: "右小腿开放性骨折，已加压包扎，心率118",
      treatmentNarrative: "",
      evacuationNarrative: "",
      note: "",
      vitals: {},
    },
    traumaRawInput: "右小腿开放性骨折，已加压包扎，心率118",
    traumaExtract: true,
  })) {
    events.push(event);
  }

  assert.deepEqual(counter.extractorInput, {
    rawText: "右小腿开放性骨折，已加压包扎，心率118",
    caseHistory: "",
  });
  assert.deepEqual(counter.runnerForm, {
    statedSubStage: "advanced_first_aid",
    injuryNarrative: "右小腿开放性骨折",
    treatmentNarrative: "已加压包扎",
    evacuationNarrative: "",
    note: "",
    vitals: { heartRate: 118 },
  });
  const extractionStarted = events.findIndex((event) =>
    event.type === "tool_call_started" && event.name === "大模型信息抽取");
  const extractionFinished = events.findIndex((event) =>
    event.type === "tool_call_finished" && event.toolName === "大模型信息抽取");
  const runnerStarted = events.findIndex((event) =>
    event.type === "tool_call_started" && event.name === "校验并合并表单");
  assert.ok(extractionStarted >= 0);
  assert.ok(extractionFinished > extractionStarted);
  assert.ok(runnerStarted > extractionFinished);
  assert.equal(JSON.parse(events[extractionStarted].argsPreview).countInTotal, false);
  assert.equal(JSON.parse(events[extractionStarted].argsPreview).title, "大模型信息抽取");
  assert.equal(counter.processMessages.filter((message) =>
    message.metadata?.purpose === "trauma_runner_step").length >= 2, true);
  assert.equal(counter.processMessages.some((message) =>
    JSON.stringify(message).includes("大模型信息抽取")), true);
});

test("case update plus preference applies the preference now and captures it after success", async () => {
  const rawInput = "以后先给结论。患者心率 130。";
  const { gateway, counter } = createTestGateway("trauma_med-demo", {
    extractorResult: {
      inputIntent: "case_update",
      scopeReason: "病例更新并包含表达偏好",
      preferences: [{
        sourceSpan: "以后先给结论",
        directive: "回答时先给结论",
        category: "format",
      }],
      injuryNarratives: [],
      treatmentNarratives: [],
      evacuationNarratives: [],
      notes: [],
      vitals: [{ field: "heartRate", value: 130, unit: "次/分", sourceSpan: "心率 130" }],
    },
    preferenceMemory: {
      projectFeedback: "默认使用编号列表",
      globalProfile: "## 专业领域\n- 战创伤复苏",
    },
  });

  for await (const _event of gateway.submitTurn({
    sessionKey: "web:s_case_preference",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: rawInput,
    traumaRawInput: rawInput,
    traumaExtract: true,
    traumaForm: {
      statedSubStage: null,
      injuryNarrative: rawInput,
      treatmentNarrative: "",
      evacuationNarrative: "",
      note: "",
      vitals: {},
    },
  })) {}

  assert.equal(counter.trauma, 1);
  assert.equal(counter.runnerForm?.vitals.heartRate, 130);
  assert.doesNotMatch(JSON.stringify(counter.runnerForm), /先给结论/u);
  assert.match(counter.runnerPresentationPolicy ?? "", /当前轮偏好[\s\S]*回答时先给结论/u);
  assert.match(counter.runnerPresentationPolicy ?? "", /当前项目 Feedback[\s\S]*默认使用编号列表/u);
  assert.match(counter.runnerPresentationPolicy ?? "", /全局用户画像[\s\S]*战创伤复苏/u);
  assert.deepEqual(counter.capturedPreferences.map((item) => item.directive), ["回答时先给结论"]);
});

test("preference-only input acknowledges and persists without constructing the runner", async () => {
  const rawInput = "以后所有回答都先给结论，再用表格列出处置措施。";
  const { gateway, counter } = createTestGateway("trauma_med-demo", {
    extractorResult: {
      inputIntent: "out_of_scope",
      scopeReason: "仅包含输出偏好",
      preferences: [{
        sourceSpan: rawInput,
        directive: "先给结论，并用表格列出处置措施",
        category: "format",
      }],
      injuryNarratives: [],
      treatmentNarratives: [],
      evacuationNarratives: [],
      notes: [],
      vitals: [],
    },
  });
  const events = [];

  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_preference_only",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: rawInput,
    traumaRawInput: rawInput,
    traumaExtract: true,
    traumaForm: {
      statedSubStage: null,
      injuryNarrative: rawInput,
      treatmentNarrative: "",
      evacuationNarrative: "",
      note: "",
      vitals: {},
    },
  })) events.push(event);

  assert.equal(counter.trauma, 0);
  assert.match(
    events.filter((event) => event.type === "assistant_text_delta").map((event) => event.text).join(""),
    /已记录.*先给结论/u,
  );
  assert.deepEqual(counter.capturedPreferences.map((item) => item.directive), [
    "先给结论，并用表格列出处置措施",
  ]);
});

test("preference plus unrelated request acknowledges the preference and appends a scope note", async () => {
  const rawInput = "以后回答简洁。今天北京天气怎么样？";
  const { gateway } = createTestGateway("trauma_med-demo", {
    extractorResult: {
      inputIntent: "out_of_scope",
      scopeReason: "包含偏好和非战创伤问题",
      preferences: [{
        sourceSpan: "以后回答简洁",
        directive: "回答保持简洁",
        category: "detail",
      }],
      injuryNarratives: [],
      treatmentNarratives: [],
      evacuationNarratives: [],
      notes: [],
      vitals: [],
    },
  });
  const events = [];

  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_preference_scope",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: rawInput,
    traumaRawInput: rawInput,
    traumaExtract: true,
    traumaForm: {
      statedSubStage: null,
      injuryNarrative: rawInput,
      treatmentNarrative: "",
      evacuationNarrative: "",
      note: "",
      vitals: {},
    },
  })) events.push(event);

  const answer = events
    .filter((event) => event.type === "assistant_text_delta")
    .map((event) => event.text)
    .join("");
  assert.match(answer, /已记录.*回答保持简洁/u);
  assert.match(answer, /不属于战创伤救治范围/u);
});

test("knowledge question plus preference passes the same-turn policy to Knowledge QA", async () => {
  const rawInput = "解释止血带使用原则，以后回答简洁一些。";
  const { gateway, counter } = createTestGateway("trauma_med-demo", {
    extractorResult: {
      inputIntent: "domain_question_no_case",
      scopeReason: "知识问题并包含详略偏好",
      preferences: [{
        sourceSpan: "以后回答简洁一些",
        directive: "回答保持简洁",
        category: "detail",
      }],
      injuryNarratives: [],
      treatmentNarratives: [],
      evacuationNarratives: [],
      notes: [],
      vitals: [],
    },
    knowledgeQaFactory: async () => ({
      rewriter: {
        async rewrite() {
          return {
            rewrittenQueries: [{ query: "止血带使用原则", reason: "标准化" }],
            unresolvedReferences: [],
            needsClarification: false,
          };
        },
      },
      rag: {
        async query() {
          return { retrieval_backend: "local", chunks: [] };
        },
      },
      qa: {
        async answer(input) {
          counter.qaPresentationPolicy = input.presentationPolicy ?? null;
          return { naturalLanguageAnswer: "简要回答。", citationChunkIds: [] };
        },
      },
    }),
  });

  for await (const _event of gateway.submitTurn({
    sessionKey: "web:s_knowledge_preference",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: rawInput,
    traumaRawInput: rawInput,
    traumaExtract: true,
    traumaForm: {
      statedSubStage: null,
      injuryNarrative: rawInput,
      treatmentNarrative: "",
      evacuationNarrative: "",
      note: "",
      vitals: {},
    },
  })) {}

  assert.equal(counter.trauma, 0);
  assert.match(counter.qaPresentationPolicy ?? "", /当前轮偏好[\s\S]*回答保持简洁/u);
  assert.deepEqual(counter.capturedPreferences.map((item) => item.directive), ["回答保持简洁"]);
});

test("failed primary workflow does not persist current-turn preferences", async () => {
  const rawInput = "以后先给结论。患者心率 130。";
  const { gateway, counter } = createTestGateway("trauma_med-demo", {
    runnerError: new Error("reasoner failed"),
    extractorResult: {
      inputIntent: "case_update",
      scopeReason: "病例更新并包含表达偏好",
      preferences: [{
        sourceSpan: "以后先给结论",
        directive: "回答时先给结论",
        category: "format",
      }],
      injuryNarratives: [],
      treatmentNarratives: [],
      evacuationNarratives: [],
      notes: [],
      vitals: [{ field: "heartRate", value: 130, unit: "次/分", sourceSpan: "心率 130" }],
    },
  });

  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_failed_preference",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: rawInput,
    traumaRawInput: rawInput,
    traumaExtract: true,
    traumaForm: {
      statedSubStage: null,
      injuryNarrative: rawInput,
      treatmentNarrative: "",
      evacuationNarrative: "",
      note: "",
      vitals: {},
    },
  })) events.push(event);

  assert.equal(events.at(-1)?.type, "error");
  assert.deepEqual(counter.capturedPreferences, []);
});

test("preference persistence failure does not replace a successful answer", async () => {
  const rawInput = "以后先给结论。患者心率 130。";
  const { gateway } = createTestGateway("trauma_med-demo", {
    captureError: new Error("memory unavailable"),
    extractorResult: {
      inputIntent: "case_update",
      scopeReason: "病例更新并包含表达偏好",
      preferences: [{
        sourceSpan: "以后先给结论",
        directive: "回答时先给结论",
        category: "format",
      }],
      injuryNarratives: [],
      treatmentNarratives: [],
      evacuationNarratives: [],
      notes: [],
      vitals: [{ field: "heartRate", value: 130, unit: "次/分", sourceSpan: "心率 130" }],
    },
  });

  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_capture_failure",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: rawInput,
    traumaRawInput: rawInput,
    traumaExtract: true,
    traumaForm: {
      statedSubStage: null,
      injuryNarrative: rawInput,
      treatmentNarrative: "",
      evacuationNarrative: "",
      note: "",
      vitals: {},
    },
  })) events.push(event);

  assert.equal(events.at(-1)?.type, "turn_completed");
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("traumaExtract falls back to the raw narrative when extraction fails", async () => {
  const rawInput = "胸部爆炸伤，血压测不到，现场没有吸引器";
  const { gateway, counter } = createTestGateway("trauma_med-demo", {
    extractorError: new Error("模型服务不可用"),
  });
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_extract_fallback",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: rawInput,
    traumaForm: {
      statedSubStage: "emergency_treatment",
      injuryNarrative: rawInput,
      treatmentNarrative: "",
      evacuationNarrative: "",
      note: "",
      vitals: {},
    },
    traumaRawInput: rawInput,
    traumaExtract: true,
  })) {
    events.push(event);
  }

  assert.deepEqual(counter.runnerForm, {
    statedSubStage: "emergency_treatment",
    injuryNarrative: rawInput,
    treatmentNarrative: "",
    evacuationNarrative: "",
    note: "",
    vitals: {},
  });
  const extractionFinished = events.find((event) =>
    event.type === "tool_call_finished" && event.toolName === "大模型信息抽取");
  assert.equal(extractionFinished?.ok, false);
  assert.match(extractionFinished?.resultPreview ?? "", /抽取失败，已使用自由文本继续推演/);
  assert.match(counter.recordedUserText, new RegExp(rawInput));
});

for (const scenario of [
  {
    intent: "out_of_scope",
    rawInput: "今天北京天气怎么样？",
    expectedText: "你好！我是战创伤辅助救治助手",
  },
  {
    intent: "domain_question_no_case",
    rawInput: "战现场急救和早期救治有什么区别？",
    expectedText: "这是战创伤救治相关知识问题",
  },
  {
    intent: "system_help",
    rawInput: "这个系统应该怎么用？",
    expectedText: "你好！这里是战创伤辅助救治助手",
  },
]) {
  test(`traumaExtract returns fixed reply and skips runner for ${scenario.intent}`, async () => {
    const extracted = {
      inputIntent: scenario.intent,
      scopeReason: "不进入病例推演",
      injuryNarratives: [],
      treatmentNarratives: [],
      evacuationNarratives: [],
      notes: [],
      vitals: [],
    };
    const { gateway, counter } = createTestGateway("trauma_med-demo", { extractorResult: extracted });
    const events = [];
    for await (const event of gateway.submitTurn({
      sessionKey: `web:s_${scenario.intent}`,
      channelKey: "web",
      projectKey: "trauma_med-demo",
      message: scenario.rawInput,
      traumaForm: {
        statedSubStage: null,
        injuryNarrative: scenario.rawInput,
        treatmentNarrative: "",
        evacuationNarrative: "",
        note: "",
        vitals: {},
      },
      traumaRawInput: scenario.rawInput,
      traumaExtract: true,
    })) {
      events.push(event);
    }

    assert.equal(counter.trauma, 0);
    assert.deepEqual(counter.extractorInput, {
      rawText: scenario.rawInput,
      caseHistory: "",
    });
    const streamedText = events
      .filter((event) => event.type === "assistant_text_delta")
      .map((event) => event.text)
      .join("");
    assert.match(streamedText, new RegExp(scenario.expectedText));
    assert.equal(events.some((event) => event.type === "assistant_text_end"), true);
    assert.equal(events.at(-1)?.type, "turn_completed");
    assert.equal(counter.recordedUserText, scenario.rawInput);
  });
}

test("traumaExtract uses fallback and emits extraction status when no extractor is configured", async () => {
  const rawInput = "左前臂裂伤";
  const { gateway, counter } = createTestGateway("trauma_med-demo");
  const events = [];
  for await (const event of gateway.submitTurn({
    sessionKey: "web:s_no_extractor",
    channelKey: "web",
    projectKey: "trauma_med-demo",
    message: rawInput,
    traumaForm: {
      statedSubStage: null,
      injuryNarrative: rawInput,
      treatmentNarrative: "",
      evacuationNarrative: "",
      note: "",
      vitals: {},
    },
    traumaRawInput: rawInput,
    traumaExtract: true,
  })) {
    events.push(event);
  }

  assert.equal(counter.trauma, 1);
  assert.equal(events.some((event) =>
    event.type === "tool_call_finished" && event.toolName === "大模型信息抽取" && event.ok === false), true);
  assert.equal(counter.runnerForm?.injuryNarrative, rawInput);
});
