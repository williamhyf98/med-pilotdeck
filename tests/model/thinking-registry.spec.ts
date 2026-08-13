// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { resolveThinkingPlan } from "../../src/model/thinking/registry.js";
test("Qwen model-family thinking controls win over an OpenAI-compatible gateway URL", () => {
    const plan = resolveThinkingPlan({ enabled: false, mode: "off" }, provider("http://model.internal/openai/v1"), model("qwen3.6-27b"));
    assert.equal(plan.enabled, false);
    assert.deepEqual(plan.bodyPatch, {
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
    });
    assert.equal(plan.unsupportedReason, undefined);
});
test("official OpenAI models retain their explicit-off validation", () => {
    const plan = resolveThinkingPlan({ enabled: false, mode: "off" }, { ...provider("https://api.openai.com/v1"), id: "openai" }, model("gpt-4.1"));
    assert.match(plan.unsupportedReason ?? "", /does not support an explicit off/u);
});
function provider(url) {
    return {
        id: "my-llm",
        protocol: "openai",
        url,
        apiKey: "test",
        headers: {},
        models: {},
    };
}
function model(id) {
    const capabilities = {
        supportsToolUse: true,
        supportsStreaming: true,
        supportsParallelToolCalls: true,
        supportsThinking: true,
        supportsJsonSchema: true,
        supportsSystemPrompt: true,
        supportsPromptCache: false,
        maxContextTokens: 128_000,
        maxOutputTokens: 4_096,
    };
    return {
        id,
        capabilities,
        multimodal: { input: ["text"] },
    };
}
