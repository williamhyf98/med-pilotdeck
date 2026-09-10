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
