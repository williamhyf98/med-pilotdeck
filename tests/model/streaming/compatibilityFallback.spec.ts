// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { streamModel, } from "../../../src/model/index.js";
test("streamModel accepts a non-streaming JSON response from an OpenAI-compatible endpoint", async () => {
    const events = await collect(streamModel(baseRequest(), modelConfig(), {
        fetch: async () => new Response(JSON.stringify({
            id: "response-1",
            choices: [{
                    index: 0,
                    message: { role: "assistant", content: "medical bridge ok" },
                    finish_reason: "stop",
                }],
            usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }), {
            status: 200,
            headers: { "content-type": "application/json" },
        }),
    }));
    assert.ok(events.some((event) => event.type === "text_delta" && event.text === "medical bridge ok"));
    assert.ok(events.some((event) => event.type === "message_end" && event.finishReason === "stop"));
});
test("streamModel treats clean text EOF as completion when no tool call is open", async () => {
    const events = await collect(streamModel(baseRequest(), modelConfig(), {
        fetch: async () => new Response([
            "data: {\"id\":\"response-2\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"medical eof ok\"},\"finish_reason\":null}]}",
            "",
            "",
        ].join("\n"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        }),
    }));
    assert.ok(events.some((event) => event.type === "text_delta" && event.text === "medical eof ok"));
    assert.ok(events.some((event) => event.type === "message_end" && event.finishReason === "stop"));
});
test("streamModel accepts newline-delimited JSON from a mislabeled event-stream endpoint", async () => {
    const events = await collect(streamModel(baseRequest(), modelConfig(), {
        fetch: async () => new Response([
            "{\"id\":\"response-3\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"medical ndjson ok\"},\"finish_reason\":null}]}",
            "{\"id\":\"response-3\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}",
        ].join("\n"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        }),
    }));
    assert.ok(events.some((event) => event.type === "text_delta" && event.text === "medical ndjson ok"));
    assert.ok(events.some((event) => event.type === "message_end" && event.finishReason === "stop"));
});
test("streamModel auto-detects Responses API events from a chat-completions provider", async () => {
    const events = await collect(streamModel(baseRequest(), modelConfig(), {
        fetch: async () => new Response([
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"response-4\"}}",
            "",
            "data: {\"type\":\"response.output_text.delta\",\"response_id\":\"response-4\",\"delta\":\"responses compatibility ok\"}",
            "",
            "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"response-4\",\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}}",
            "",
            "",
        ].join("\n"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        }),
    }));
    assert.ok(events.some((event) => event.type === "text_delta" && event.text === "responses compatibility ok"));
    assert.ok(events.some((event) => event.type === "message_end" && event.finishReason === "stop"));
});
test("streamModel completes a fully assembled Responses tool call at clean EOF", async () => {
    const events = await collect(streamModel(baseRequest(), modelConfig(), {
        fetch: async () => new Response([
            "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"id\":\"item-1\",\"type\":\"function_call\",\"call_id\":\"call-1\",\"name\":\"medical_lookup\",\"arguments\":\"\"}}",
            "",
            "data: {\"type\":\"response.function_call_arguments.done\",\"item_id\":\"item-1\",\"output_index\":0,\"call_id\":\"call-1\",\"name\":\"medical_lookup\",\"arguments\":\"{}\"}",
            "",
            "",
        ].join("\n"), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
        }),
    }));
    assert.ok(events.some((event) => event.type === "tool_call_end"));
    assert.ok(events.some((event) => event.type === "message_end" && event.finishReason === "tool_call"));
});
test("streamModel falls back to non-streaming completion after reasoning-only EOF", async () => {
    let calls = 0;
    const events = await collect(streamModel(baseRequest(), modelConfig(), {
        fetch: async () => {
            calls += 1;
            if (calls === 1) {
                return new Response([
                    "data: {\"type\":\"response.reasoning_text.delta\",\"delta\":\"internal reasoning\"}",
                    "",
                    "data: {\"type\":\"response.reasoning_text.done\",\"text\":\"internal reasoning\"}",
                    "",
                    "",
                ].join("\n"), {
                    status: 200,
                    headers: { "content-type": "text/event-stream" },
                });
            }
            return new Response(JSON.stringify({
                object: "response",
                status: "completed",
                output_text: "safe fallback answer",
                output: [],
            }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        },
    }));
    assert.equal(calls, 2);
    assert.ok(events.some((event) => event.type === "text_delta" && event.text === "safe fallback answer"));
    assert.ok(events.some((event) => event.type === "message_end" && event.finishReason === "stop"));
});
function baseRequest() {
    return {
        provider: "local",
        model: "medical-model",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        stream: true,
    };
}
function modelConfig() {
    const capabilities = {
        supportsToolUse: true,
        supportsStreaming: true,
        supportsParallelToolCalls: true,
        supportsThinking: false,
        supportsJsonSchema: true,
        supportsSystemPrompt: true,
        supportsPromptCache: false,
        maxContextTokens: 128_000,
        maxOutputTokens: 4_096,
    };
    return {
        providers: {
            local: {
                id: "local",
                protocol: "openai",
                url: "http://127.0.0.1:9000/v1",
                apiKey: "test",
                headers: {},
                retry: { streamMaxRetries: 0 },
                models: {
                    "medical-model": {
                        id: "medical-model",
                        capabilities,
                        multimodal: { input: ["text"] },
                    },
                },
            },
        },
    };
}
async function collect(iterable) {
    const events = [];
    for await (const event of iterable)
        events.push(event);
    return events;
}
