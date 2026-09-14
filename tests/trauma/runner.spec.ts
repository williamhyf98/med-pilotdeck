import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CompleteJsonInput, StructuredModelClient } from "../../src/trauma/modelClient.js";
import type { TraumaRagClient } from "../../src/trauma/rag/client.js";
import { createTraumaTurnRunner } from "../../src/trauma/runner.js";
import { createTraumaCaseStore } from "../../src/trauma/store.js";
import type { TurnFormInput } from "../../src/trauma/types.js";

const now = "2026-09-03T15:09:00+08:00";

function form(overrides: Partial<TurnFormInput> = {}): TurnFormInput {
  return {
    statedSubStage: null,
    injuryNarrative: "右小腿开放伤，活动性出血",
    treatmentNarrative: "",
    evacuationNarrative: "",
    note: "",
    vitals: { respiratoryRate: 32, systolicBloodPressure: 95 },
    ...overrides,
  };
}

function reasonPayload() {
  return {
    naturalLanguageAnswer: "当前按初级急救处理。",
    classification: {
      version: 1, type: "emergency_triage", createdAt: now, severity: "severe",
      treatmentPriority: "urgent", transportPriority: "urgent", rationale: ["活动性出血"],
    },
    treatmentPlan: [{
      id: "a1", title: "压迫止血", description: "继续止血", scope: "current_stage",
      priority: 1, evidenceChunkIds: ["chunk-stage"], professionalConfirmationRequired: false,
    }],
    missingInformation: ["本轮未测血氧饱和度"],
    transition: { status: "STAY", reason: "继续处置", requiresUserConfirmation: false },
    gateAssessment: {
      needHigherCapability: false, requiredCapabilities: [], transportReadiness: "unknown",
      instabilityIndicators: [], blockingFactors: [], transportPrerequisites: [],
      ruleConflicts: [], confidence: 0.8, evidenceChunkIds: ["chunk-stage"],
    },
    memo: {
      round: 1, mainStage: "battlefield_first_aid", subStage: "primary_first_aid",
      title: "首轮伤情", inputPoints: ["右小腿出血"], actionPoints: ["继续止血"], conclusion: "留观",
    },
  };
}

function model(calls: string[], placement: unknown = {
  determined: true,
  source: "definition",
  stage: "battlefield_first_aid",
  subStage: "primary_first_aid",
  rationale: "符合初级急救定义",
  definitionReferences: ["第七条【战现场急救】"],
}): StructuredModelClient {
  return {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      calls.push(input.name);
      const payload = input.name === "trauma_place" ? placement : reasonPayload();
      if (!input.validate(payload)) throw new Error("schema validation failed");
      return payload as T;
    },
  };
}

function rag(calls: { count: number }): TraumaRagClient {
  return {
    async query() {
      calls.count += 1;
      return {
        retrieval_backend: "remote",
        chunks: [{
          chunk_id: "chunk-stage", text: "止血通气包扎固定", score: 0.99,
          title: "战伤救治规则", retrieval_backend: "remote",
        }],
      };
    },
  };
}

test("explicit substage skips placer and derives facility", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-runner-"));
  try {
    const calls: string[] = [];
    let confirmationRequests = 0;
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({ store, model: model(calls), rag: rag({ count: 0 }) });
    const response = await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "surgical_resuscitation" }),
      requestPlacementConfirmation: async () => {
        confirmationRequests += 1;
        return { choice: "proposed" };
      },
    });
    assert.equal(calls.includes("trauma_place"), false);
    assert.equal(confirmationRequests, 0);
    assert.equal(response.placement.source, "user_stated");
    assert.equal((await store.load())?.currentFacility?.name, "医务中心");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid form fails before model and RAG", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-invalid-"));
  try {
    const modelCalls: string[] = [];
    const ragCalls = { count: 0 };
    const runner = createTraumaTurnRunner({
      store: createTraumaCaseStore(root), model: model(modelCalls), rag: rag(ragCalls),
    });
    await assert.rejects(() => runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ injuryNarrative: "", vitals: {} }),
    }), /invalid trauma form/i);
    assert.deepEqual(modelCalls, []);
    assert.equal(ragCalls.count, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("successful full turn records exactly 11 steps", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-audit-"));
  try {
    const steps: number[] = [];
    const startedDetails: Record<string, unknown>[] = [];
    const skippedPhases: string[] = [];
    const store = createTraumaCaseStore(root);
    const submitted = form({ treatmentNarrative: "已完成加压包扎" });
    const modelCalls: string[] = [];
    const ragCalls = { count: 0 };
    const runner = createTraumaTurnRunner({
      store, model: model(modelCalls), rag: rag(ragCalls),
      audit: {
        path: "/tmp/unused",
        async record(entry) {
          if (entry.event === "step_completed" && entry.step) steps.push(entry.step);
          if (entry.event === "step_started" && entry.step === 10 && entry.details) {
            startedDetails.push(entry.details);
          }
          if (entry.event === "step_completed" && entry.details?.skipped === true && entry.phase) {
            skippedPhases.push(entry.phase);
          }
        },
      },
    });
    await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now, form: submitted,
      requestPlacementConfirmation: async () => ({ choice: "proposed" }),
    });
    assert.deepEqual(steps, Array.from({ length: 11 }, (_, index) => index + 1));
    assert.deepEqual(startedDetails, [{
      round: 1,
      mainStage: "battlefield_first_aid",
      subStage: "primary_first_aid",
    }]);
    // 单波检索：流程里已不再保留任何被跳过的步骤壳子。
    assert.deepEqual(skippedPhases, []);
    assert.equal(ragCalls.count, 3);
    assert.deepEqual(modelCalls, ["trauma_place", "trauma_reason"]);
    const snapshot = (await store.loadSnapshots())[0];
    assert.deepEqual(snapshot?.form, submitted);
    assert.equal(snapshot?.retrieval?.totalCalls, 3);
    assert.equal(snapshot?.retrieval?.queries.length, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("undetermined and out-of-scope placement persist the merged form without RAG", async () => {
  for (const source of ["undetermined", "out_of_scope"] as const) {
    const root = await mkdtemp(join(tmpdir(), `trauma-${source}-`));
    try {
      const ragCalls = { count: 0 };
      const completed: Array<{ step?: number; phase?: string }> = [];
      const store = createTraumaCaseStore(root);
      const runner = createTraumaTurnRunner({
        store,
        model: model([], {
          determined: false, source, stage: null, subStage: null,
          rationale: source === "out_of_scope" ? "当前已进入专科治疗（Ⅲ级）" : "信息不足",
          definitionReferences: [],
        }),
        rag: rag(ragCalls),
        audit: {
          path: "/tmp/unused",
          async record(entry) {
            if (entry.event === "step_completed") completed.push(entry);
          },
        },
      });
      const response = await runner.runTurn({
        projectId: "trauma_med-demo", sessionId: "web:s", messageId: `m-${source}`, now,
        form: form({ note: `${source} round` }),
      });
      const saved = await store.load();
      const snapshots = await store.loadSnapshots();

      assert.equal(response.stage.sub, null);
      assert.equal(response.caseVersion, 1);
      assert.equal(response.round, 1);
      assert.equal(saved?.version, 1);
      assert.equal(saved?.round, 1);
      assert.equal(saved?.injuryNarratives[0]?.text, "右小腿开放伤，活动性出血");
      assert.equal(saved?.notes[0]?.text, `${source} round`);
      assert.deepEqual(saved?.vitalSignsHistory[0]?.values, {
        respiratoryRate: 32,
        systolicBloodPressure: 95,
      });
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]?.eventType, "agent_turn");
      assert.deepEqual(snapshots[0]?.form, form({ note: `${source} round` }));
      assert.equal(snapshots[0]?.response?.placement.source, source);
      assert.equal(ragCalls.count, 0);
      assert.deepEqual(completed.map((entry) => entry.step), [1, 2, 3, 4, 5, 6]);
      assert.deepEqual(completed.slice(4).map((entry) => entry.phase), [
        "build_partial_response_and_snapshot",
        "persist_partial_snapshot",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

function interpreter(calls: string[][], text = "· ct.dcm\n  关键发现：右侧血气胸\n  创伤相关性：需胸腔引流") {
  return {
    async interpret(input: { attachments: Array<{ name: string }>; signal?: AbortSignal }) {
      calls.push(input.attachments.map((item) => item.name));
      if (input.signal?.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }
      return { text, fileNames: input.attachments.map((item) => item.name) };
    },
  };
}

test("attachments produce an interpretation entry persisted on the case state", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interpret-"));
  try {
    const interpretCalls: string[][] = [];
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store,
      model: model([]),
      rag: rag({ count: 0 }),
      interpreter: interpreter(interpretCalls),
    });
    await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
    });
    assert.deepEqual(interpretCalls, [["ct.dcm"]]);
    const entries = (await store.load())?.attachmentInterpretations ?? [];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.round, 1);
    assert.deepEqual(entries[0]?.fileNames, ["ct.dcm"]);
    assert.ok(entries[0]?.text.includes("右侧血气胸"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a turn with no attachments never starts the interpretation station", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-no-attach-"));
  try {
    const interpretCalls: string[][] = [];
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store,
      model: model([]),
      rag: rag({ count: 0 }),
      interpreter: interpreter(interpretCalls),
    });
    const steps: number[] = [];
    await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      onProgress: (progress) => {
        if ("kind" in progress && progress.kind === "runner_step" && progress.status === "started") {
          steps.push(progress.step);
        }
      },
    });
    assert.deepEqual(interpretCalls, []);
    assert.deepEqual(steps, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    assert.equal((await store.load())?.attachmentInterpretations, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interpretation progress is reported outside the numbered main line", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interp-progress-"));
  try {
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store, model: model([]), rag: rag({ count: 0 }), interpreter: interpreter([]),
    });
    const kinds: string[] = [];
    await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
      onProgress: (progress) => {
        if ("kind" in progress && progress.kind === "attachment_interpretation") {
          kinds.push(progress.status);
        }
      },
    });
    assert.deepEqual(kinds, ["started", "finished"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interpretation failure leaves the main line intact with an empty interpretation", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interp-fail-"));
  try {
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store,
      model: model([]),
      rag: rag({ count: 0 }),
      interpreter: {
        async interpret() {
          throw new Error("station exploded");
        },
      },
    });
    const response = await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
    });
    assert.equal(response.naturalLanguageAnswer.length > 0, true);
    assert.equal((await store.load())?.attachmentInterpretations, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("interpretation entries accumulate across rounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interp-accum-"));
  try {
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store, model: model([]), rag: rag({ count: 0 }), interpreter: interpreter([]),
    });
    for (const messageId of ["m1", "m2"]) {
      await runner.runTurn({
        projectId: "trauma_med-demo", sessionId: "web:s", messageId, now,
        form: form({ statedSubStage: "primary_first_aid" }),
        attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
      });
    }
    const entries = (await store.load())?.attachmentInterpretations ?? [];
    assert.deepEqual(entries.map((entry) => entry.round), [1, 2]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("partial-branch turns cancel the interpretation branch and never report progress after runTurn settles", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interp-cancel-"));
  try {
    const store = createTraumaCaseStore(root);
    const gate = deferred<void>();
    let capturedSignal: AbortSignal | undefined;
    let interpretCallCount = 0;
    const slowInterpreter = {
      async interpret(input: { attachments: Array<{ name: string }>; signal?: AbortSignal }) {
        interpretCallCount += 1;
        capturedSignal = input.signal;
        // 挂起，直到测试在 runTurn 结束之后才放行——模拟支线判读比主线慢很多的情况。
        await gate.promise;
        if (input.signal?.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          throw error;
        }
        return { text: "不应被使用", fileNames: input.attachments.map((item) => item.name) };
      },
    };
    let runTurnSettled = false;
    const progressEvents: Array<{ status: string; afterSettle: boolean }> = [];
    const runner = createTraumaTurnRunner({
      store,
      model: model([], {
        determined: false,
        source: "undetermined",
        stage: null,
        subStage: null,
        rationale: "信息不足",
        definitionReferences: [],
      }),
      rag: rag({ count: 0 }),
      interpreter: slowInterpreter,
    });
    const runPromise = runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ note: "undetermined round" }),
      attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
      onProgress: (progress) => {
        if ("kind" in progress && progress.kind === "attachment_interpretation") {
          progressEvents.push({ status: progress.status, afterSettle: runTurnSettled });
        }
      },
    });

    const response = await runPromise;
    runTurnSettled = true;

    // 此时主线早已走了 partial 分支返回；工位 I 的 interpret() 仍卡在 gate 上。
    assert.equal(interpretCallCount, 1);
    assert.equal(capturedSignal?.aborted, true);

    // 放行支线，让它在 runTurn 结束之后真正 settle（无论成功/失败），
    // 用于验证它 settle 时不会再向 onProgress 投递事件。
    gate.resolve();
    await delay(20);

    assert.equal(response.stage.sub, null);
    assert.deepEqual(progressEvents.map((event) => event.status), ["started"]);
    assert.deepEqual(progressEvents.filter((event) => event.afterSettle), []);
    assert.equal((await store.load())?.attachmentInterpretations, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an interpretation entry from a round with attachments survives into a later round with none", async () => {
  const root = await mkdtemp(join(tmpdir(), "trauma-interp-survive-"));
  try {
    const store = createTraumaCaseStore(root);
    const runner = createTraumaTurnRunner({
      store, model: model([]), rag: rag({ count: 0 }), interpreter: interpreter([]),
    });
    await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m1", now,
      form: form({ statedSubStage: "primary_first_aid" }),
      attachments: [{ path: "/inbox/b1/ct.dcm", name: "ct.dcm" }],
    });
    await runner.runTurn({
      projectId: "trauma_med-demo", sessionId: "web:s", messageId: "m2", now,
      form: form({ statedSubStage: "primary_first_aid" }),
    });
    const entries = (await store.load())?.attachmentInterpretations ?? [];
    assert.deepEqual(entries.map((entry) => entry.round), [1]);
    assert.ok(entries[0]?.text.includes("右侧血气胸"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
