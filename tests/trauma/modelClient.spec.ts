import assert from "node:assert/strict";
import test from "node:test";

import { createStructuredModelClient } from "../../src/trauma/modelClient.js";

test("streamJson emits only naturalLanguageAnswer deltas and validates final JSON", async () => {
  const requests: any[] = [];
  const model = createStructuredModelClient({
    provider: "test",
    model: "test-model",
    complete: async () => {
      throw new Error("complete should not be called");
    },
    stream: async function* (request) {
      requests.push(request);
      yield { type: "text_delta", text: '{"naturalLanguageAnswer":"当前' };
      yield { type: "text_delta", text: '按初级急救处理。","classification":{}}' };
      yield { type: "message_end", finishReason: "stop" };
    },
  });
  const deltas: string[] = [];
  const result = await model.streamJson?.<{ naturalLanguageAnswer: string }>({
    name: "trauma_reason",
    system: "system",
    user: "user",
    schema: {},
    validate: (value): value is { naturalLanguageAnswer: string } =>
      Boolean(value && typeof value === "object" && typeof (value as any).naturalLanguageAnswer === "string"),
  }, {
    onNaturalLanguageDelta: (text) => {
      deltas.push(text);
    },
  });

  assert.deepEqual(deltas, ["当前", "按初级急救处理。"]);
  assert.equal(result?.naturalLanguageAnswer, "当前按初级急救处理。");
  assert.equal(requests[0]?.stream, true);
});

test("completeJson sends a single text block when no images are supplied", async () => {
  const requests: any[] = [];
  const model = createStructuredModelClient({
    provider: "test",
    model: "test-model",
    complete: async (request) => {
      requests.push(request);
      return { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }], finishReason: "stop" };
    },
    stream: async function* () {
      throw new Error("stream should not be called");
    },
  });
  await model.completeJson<{ ok: boolean }>({
    name: "trauma_test",
    system: "system",
    user: "user",
    schema: {},
    validate: (value): value is { ok: boolean } => Boolean(value),
  });
  assert.deepEqual(requests[0].messages[0].content, [{ type: "text", text: "user" }]);
});

test("completeJson prepends image blocks before the text block", async () => {
  const requests: any[] = [];
  const model = createStructuredModelClient({
    provider: "test",
    model: "test-model",
    complete: async (request) => {
      requests.push(request);
      return { role: "assistant", content: [{ type: "text", text: '{"ok":true}' }], finishReason: "stop" };
    },
    stream: async function* () {
      throw new Error("stream should not be called");
    },
  });
  await model.completeJson<{ ok: boolean }>({
    name: "trauma_test",
    system: "system",
    user: "user",
    schema: {},
    validate: (value): value is { ok: boolean } => Boolean(value),
    images: [{ data: "QUJD", mimeType: "image/png" }],
  });
  assert.deepEqual(requests[0].messages[0].content, [
    { type: "image", source: "base64", data: "QUJD", mimeType: "image/png" },
    { type: "text", text: "user" },
  ]);
  // 结构化输出与图像块互不干扰，两者必须同时存在。
  assert.equal(requests[0].outputSchema.strict, true);
});
