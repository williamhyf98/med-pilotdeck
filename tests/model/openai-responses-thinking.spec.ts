// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAIResponsesRequest } from "../../src/model/providers/openai-responses/request.js";

function modelConfig(modelId, { supportsThinking = true } = {}) {
  return {
    id: modelId,
    capabilities: {
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: true,
      supportsThinking,
      supportsJsonSchema: true,
      supportsSystemPrompt: true,
      supportsPromptCache: false,
      maxContextTokens: 272_000,
      maxOutputTokens: 32_768,
    },
    multimodal: { input: ["text", "image"] },
  };
}

function provider() {
  return {
    id: "llmcenter",
    protocol: "openai-responses",
    url: "http://127.0.0.1:15724/v1",
    apiKey: "test",
    headers: {},
    models: {},
  };
}

function request(providerId, modelId, thinking) {
  return {
    provider: providerId,
    model: modelId,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    maxOutputTokens: 64,
    stream: true,
    thinking,
  };
}

test("DeepSeek reasoning models on Responses API use native reasoning.effort", () => {
  const modelId = "deepseek-v4.1-flash-mb";
  const body = buildOpenAIResponsesRequest(
    request("llmcenter", modelId, { enabled: true, mode: "high" }),
    modelConfig(modelId),
    provider(),
  );
  assert.deepEqual(body.reasoning, { effort: "high" });
  assert.equal(body.enable_thinking, undefined);
  assert.equal(body.thinking_budget, undefined);
});

test("Responses API omits reasoning when thinking is off", () => {
  const modelId = "deepseek-v4.1-flash-mb";
  const body = buildOpenAIResponsesRequest(
    request("llmcenter", modelId, { enabled: false, mode: "off" }),
    modelConfig(modelId),
    provider(),
  );
  assert.equal(body.reasoning, undefined);
});
