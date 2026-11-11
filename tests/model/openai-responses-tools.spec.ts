// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAIResponsesRequest } from "../../src/model/providers/openai-responses/request.js";

function modelConfig(modelId) {
  return {
    id: modelId,
    capabilities: {
      supportsToolUse: true,
      supportsStreaming: true,
      supportsParallelToolCalls: true,
      supportsThinking: true,
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

test("Responses API tools with optional properties are sent as non-strict", () => {
  const modelId = "deepseek-v4.1-flash-mb";
  const body = buildOpenAIResponsesRequest(
    {
      provider: "llmcenter",
      model: modelId,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      tools: [
        {
          name: "read_file",
          description: "Read a file",
          inputSchema: {
            type: "object",
            required: ["file_path"],
            additionalProperties: false,
            properties: {
              file_path: { type: "string" },
              offset: { type: "integer" },
              limit: { type: "integer" },
            },
          },
        },
      ],
      maxOutputTokens: 64,
      stream: true,
    },
    modelConfig(modelId),
    provider(),
  );

  assert.equal(body.tools?.[0]?.strict, false);
  assert.deepEqual(body.tools?.[0]?.parameters.required, ["file_path"]);
});
