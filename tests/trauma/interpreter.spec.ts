import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INTERPRETATION_IMAGES,
  createInterpretationStation,
  renderInterpretation,
} from "../../src/trauma/stations/interpreter.js";
import type { TraumaParseClient } from "../../src/trauma/attachments/parseClient.js";
import type { StructuredModelClient } from "../../src/trauma/modelClient.js";
import type { CaseState } from "../../src/trauma/types.js";

const state = {
  caseId: "case-1",
  sessionId: "s",
  projectId: "p",
  version: 1,
  round: 2,
  updatedAt: "2026-09-11T00:00:00.000Z",
  currentFacility: null,
  currentStage: null,
  currentSubStage: null,
  injuryNarratives: [],
  treatmentNarratives: [],
  evacuationNarratives: [],
  notes: [],
  vitalSignsHistory: [],
  requiredCapabilities: [],
  currentCapabilities: [],
  classificationHistory: [],
  transport: { needed: false, priority: "pending", readiness: "unknown", gateStatus: "ASSESSING" },
  manualStageOverrides: [],
  evidence: [],
  memos: [],
  missingInformation: [],
} as unknown as CaseState;

function parseClient(pngPaths: string[] = []): TraumaParseClient {
  return {
    async parse({ attachment }) {
      return {
        name: attachment.name,
        path: attachment.path,
        summary: `${attachment.name} 的解析文本`,
        pngPaths,
        ok: true,
        warnings: [],
      };
    },
  };
}

function modelClient(calls: any[], output?: any): StructuredModelClient {
  return {
    async completeJson(input: any) {
      calls.push(input);
      return (output ?? {
        attachments: [{ fileName: "ct.dcm", keyFindings: "右侧血气胸", traumaRelevance: "提示需要胸腔闭式引流" }],
        overall: "存在张力性血气胸风险。",
      }) as any;
    },
  };
}

test("renderInterpretation formats per-attachment findings and the overall note", () => {
  const text = renderInterpretation({
    attachments: [{ fileName: "ct.dcm", keyFindings: "右侧血气胸", traumaRelevance: "需胸腔引流" }],
    overall: "张力性血气胸风险。",
  });
  assert.ok(text.includes("ct.dcm"));
  assert.ok(text.includes("关键发现：右侧血气胸"));
  assert.ok(text.includes("创伤相关性：需胸腔引流"));
  assert.ok(text.includes("综合判读：张力性血气胸风险。"));
});

test("interpret returns rendered text and the file names it covered", async () => {
  const calls: any[] = [];
  const station = createInterpretationStation({
    model: modelClient(calls),
    parse: parseClient(),
    readImage: async () => null,
    supportsImages: true,
  });
  const result = await station.interpret({
    state,
    attachments: [{ path: "/inbox/ct.dcm", name: "ct.dcm" }],
  });
  assert.deepEqual(result.fileNames, ["ct.dcm"]);
  assert.ok(result.text.includes("右侧血气胸"));
  assert.equal(calls[0].name, "trauma_interpret_attachments");
  assert.ok(calls[0].user.includes("ct.dcm 的解析文本"));
});

test("interpret attaches preview images and caps them at the image limit", async () => {
  const calls: any[] = [];
  const pngPaths = Array.from({ length: 12 }, (_, index) => `/inbox/p${index}.png`);
  const station = createInterpretationStation({
    model: modelClient(calls),
    parse: parseClient(pngPaths),
    readImage: async (path) => ({ data: Buffer.from(path).toString("base64"), mimeType: "image/png" }),
    supportsImages: true,
  });
  await station.interpret({ state, attachments: [{ path: "/inbox/ct.dcm", name: "ct.dcm" }] });
  assert.equal(calls[0].images.length, MAX_INTERPRETATION_IMAGES);
});

test("interpret skips image blocks when the model has no image capability", async () => {
  const calls: any[] = [];
  const station = createInterpretationStation({
    model: modelClient(calls),
    parse: parseClient(["/inbox/p0.png"]),
    readImage: async () => ({ data: "QQ==", mimeType: "image/png" }),
    supportsImages: false,
  });
  await station.interpret({ state, attachments: [{ path: "/inbox/ct.dcm", name: "ct.dcm" }] });
  assert.equal(calls[0].images, undefined);
});

test("interpret returns an empty result when the model call fails", async () => {
  const station = createInterpretationStation({
    model: {
      async completeJson() {
        throw new Error("model down");
      },
    },
    parse: parseClient(),
    readImage: async () => null,
    supportsImages: true,
  });
  const result = await station.interpret({
    state,
    attachments: [{ path: "/inbox/ct.dcm", name: "ct.dcm" }],
  });
  assert.deepEqual(result, { text: "", fileNames: [] });
});

test("interpret returns an empty result when there are no attachments", async () => {
  const calls: any[] = [];
  const station = createInterpretationStation({
    model: modelClient(calls),
    parse: parseClient(),
    readImage: async () => null,
    supportsImages: true,
  });
  const result = await station.interpret({ state, attachments: [] });
  assert.deepEqual(result, { text: "", fileNames: [] });
  assert.equal(calls.length, 0, "no attachments must not reach the model");
});

test("interpret rethrows an abort so the runner can cancel the branch", async () => {
  const controller = new AbortController();
  const station = createInterpretationStation({
    model: {
      async completeJson() {
        controller.abort();
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    },
    parse: parseClient(),
    readImage: async () => null,
    supportsImages: true,
  });
  await assert.rejects(
    () => station.interpret({
      state,
      attachments: [{ path: "/inbox/ct.dcm", name: "ct.dcm" }],
      signal: controller.signal,
    }),
    /aborted/u,
  );
});
