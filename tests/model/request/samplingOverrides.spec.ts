// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { buildModelRequest, } from "../../../src/model/index.js";
test("standard OpenAI lowering emits only supported sampling parameters", () => {
    const body = buildModelRequest({
        ...baseRequest("openai"),
        temperature: 0.2,
        topP: 0.9,
        presencePenalty: 0.3,
        frequencyPenalty: -0.1,
        seed: 42,
    }, modelConfig("openai", "openai"));
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.9);
    assert.equal(body.presence_penalty, 0.3);
    assert.equal(body.frequency_penalty, -0.1);
    assert.equal(body.seed, 42);
    assert.equal("top_k" in body, false);
    assert.equal("min_p" in body, false);
    assert.equal("repetition_penalty" in body, false);
});
test("OpenRouter lowering supports declared OpenAI-compatible extensions", () => {
    const body = buildModelRequest({
        ...baseRequest("openrouter"),
        topP: 0.9,
        topK: 40,
        minP: 0.05,
        presencePenalty: 0.2,
        frequencyPenalty: 0.1,
        repetitionPenalty: 1.1,
        seed: 7,
    }, modelConfig("openrouter", "openai"));
    assert.equal(body.top_p, 0.9);
    assert.equal(body.top_k, 40);
    assert.equal(body.min_p, 0.05);
    assert.equal(body.presence_penalty, 0.2);
    assert.equal(body.frequency_penalty, 0.1);
    assert.equal(body.repetition_penalty, 1.1);
    assert.equal(body.seed, 7);
});
test("server config can opt an OpenAI-compatible provider into extension parameters", () => {
    const config = modelConfig("local", "openai", ["topK", "minP", "repetitionPenalty"]);
    const body = buildModelRequest({
        ...baseRequest("local"),
        topK: 20,
        minP: 0.1,
        repetitionPenalty: 1.2,
    }, config);
    assert.equal(body.top_k, 20);
    assert.equal(body.min_p, 0.1);
    assert.equal(body.repetition_penalty, 1.2);
});
test("unsupported protocol parameters fail before a provider request is emitted", () => {
    assert.throws(() => buildModelRequest({
        ...baseRequest("openai"),
        topK: 40,
    }, modelConfig("openai", "openai")), /does not support topK/u);
    assert.throws(() => buildModelRequest({
        ...baseRequest("anthropic"),
        presencePenalty: 0.2,
    }, modelConfig("anthropic", "anthropic")), /does not support presencePenalty/u);
});
test("Anthropic and Google lower their native sampling controls", () => {
    const anthropic = buildModelRequest({
        ...baseRequest("anthropic"),
        topP: 0.8,
        topK: 32,
    }, modelConfig("anthropic", "anthropic"));
    assert.equal(anthropic.top_p, 0.8);
    assert.equal(anthropic.top_k, 32);
    const google = buildModelRequest({
        ...baseRequest("google"),
        topP: 0.8,
        topK: 32,
        presencePenalty: 0.2,
        frequencyPenalty: 0.1,
        seed: 11,
    }, modelConfig("google", "google"));
    assert.equal(google.config.topP, 0.8);
    assert.equal(google.config.topK, 32);
    assert.equal(google.config.presencePenalty, 0.2);
    assert.equal(google.config.frequencyPenalty, 0.1);
    assert.equal(google.config.seed, 11);
});
function baseRequest(provider) {
    return {
        provider,
        model: "test-model",
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        stream: true,
    };
}
function modelConfig(providerId, protocol, supportedRequestParameters) {
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
            [providerId]: {
                id: providerId,
                protocol,
                url: "https://example.invalid/v1",
                apiKey: "test",
                headers: {},
                supportedRequestParameters,
                models: {
                    "test-model": {
                        id: "test-model",
                        capabilities,
                        multimodal: { input: ["text"] },
                    },
                },
            },
        },
    };
}
