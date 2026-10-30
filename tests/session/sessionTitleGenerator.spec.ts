import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { createSessionTitleGenerator } from "../../src/session/title/SessionTitleGenerator.js";

function generatorFor(title: string, inspect?: (request: CanonicalModelRequest) => void) {
  const modelRuntime = {
    complete: async (request: CanonicalModelRequest) => {
      inspect?.(request);
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: JSON.stringify({ title }) }],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;
  return createSessionTitleGenerator({
    modelRuntime,
    agentModel: { id: "test-model", provider: "test", model: "test-model" },
  });
}

test("session title prompt requires a Simplified Chinese title", async () => {
  let systemPrompt = "";
  const generate = generatorFor("分析胸部影像", (request) => {
    systemPrompt = request.systemPrompt ?? "";
  });

  const title = await generate({
    text: "请分析这份胸部 CT",
    sessionId: "web:s1",
    turnId: "turn-1",
    signal: new AbortController().signal,
  });

  assert.equal(title, "分析胸部影像");
  assert.match(systemPrompt, /只能使用简体中文/u);
});

test("session title generator rejects titles without Chinese characters", async () => {
  const generate = generatorFor("Analyze chest CT");

  const title = await generate({
    text: "请分析这份胸部 CT",
    sessionId: "web:s1",
    turnId: "turn-1",
    signal: new AbortController().signal,
  });

  assert.equal(title, null);
});

test("session title generator rejects mixed Chinese and English titles", async () => {
  const generate = generatorFor("分析胸部 CT");

  const title = await generate({
    text: "请分析这份胸部 CT",
    sessionId: "web:s1",
    turnId: "turn-1",
    signal: new AbortController().signal,
  });

  assert.equal(title, null);
});

test("session title generator rejects full-width Latin letters", async () => {
  const generate = generatorFor("分析胸部ＣＴ");

  const title = await generate({
    text: "请分析这份胸部影像",
    sessionId: "web:s1",
    turnId: "turn-1",
    signal: new AbortController().signal,
  });

  assert.equal(title, null);
});
