import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelRuntime,
} from "../../src/model/index.js";
import {
  createRouterRuntime,
  MODEL_CONNECTION_TIMEOUT_MS,
  MODEL_FIRST_PROGRESS_TIMEOUT_MS,
  MODEL_PROGRESS_IDLE_TIMEOUT_MS,
  MODEL_STREAM_HARD_TIMEOUT_MS,
} from "../../src/router/index.js";

test("stream timeout constants match the configured watchdog policy", () => {
  // 5s was too aggressive for intranet vLLM: cold cache, queued requests and
  // long-context prefill routinely exceed it, which surfaced as
  // "Model connection timed out after 5000ms" on otherwise healthy providers.
  // 30s was too aggressive for buffering proxies: llmpro's deepseek/glm emit the
  // whole answer in one flush (no token-level deltas), so silence ≈ total
  // generation time and any document over ~5k characters tripped the watchdog.
  assert.equal(MODEL_CONNECTION_TIMEOUT_MS, 30_000);
  assert.equal(MODEL_FIRST_PROGRESS_TIMEOUT_MS, 60_000);
  assert.equal(MODEL_PROGRESS_IDLE_TIMEOUT_MS, 60_000);
  assert.equal(MODEL_STREAM_HARD_TIMEOUT_MS, 600_000);
});

test("mid-stream timeout switches to the next model with a continuation request", async () => {
  const requests: CanonicalModelRequest[] = [];
  const modelRuntime = {
    async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
      requests.push(request);
      yield { type: "request_started", provider: request.provider, model: request.model };
      if (request.provider === "primary") {
        yield { type: "text_delta", text: "已有内容。" };
        yield {
          type: "error",
          error: {
            provider: "primary",
            model: "primary-model",
            protocol: "openai",
            code: "timeout",
            message: "Model output was idle for 30000ms.",
            retryable: true,
          },
        };
        return;
      }
      yield { type: "text_delta", text: "备用模型继续输出。" };
      yield { type: "message_end", finishReason: "stop" };
    },
    getCapabilities: () => ({ maxOutputTokens: 4096 }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
  } as unknown as ModelRuntime;

  const runtime = createRouterRuntime({
    enabled: true,
    fallback: {
      default: [{
        id: "backup/backup-model",
        provider: "backup",
        model: "backup-model",
      }],
    },
  }, { modelRuntime });

  const events: CanonicalModelEvent[] = [];
  for await (const event of runtime.execute({
    provider: "primary",
    model: "primary-model",
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "scenario",
    mutations: {},
  }, {
    provider: "primary",
    model: "primary-model",
    messages: [{ role: "user", content: [{ type: "text", text: "继续回答" }] }],
  }, {
    sessionId: "session-timeout-fallback",
    turnId: "turn-timeout-fallback",
    isMainAgent: true,
  })) {
    events.push(event);
  }

  assert.deepEqual(requests.map((request) => request.provider), ["primary", "backup"]);
  assert.equal(requests[1]?.model, "backup-model");
  const continuationMessage = requests[1]?.messages.at(-2);
  const continuationBlock = continuationMessage?.content[0];
  assert.equal(continuationMessage?.role, "assistant");
  assert.equal(continuationBlock?.type, "text");
  assert.equal(
    continuationBlock?.type === "text"
      ? continuationBlock.text
      : undefined,
    "已有内容。",
  );
  assert.ok(events.some((event) => event.type === "text_delta" && event.text === "备用模型继续输出。"));
  assert.ok(events.some((event) => event.type === "message_end" && event.finishReason === "stop"));

  await runtime.shutdown();
});
