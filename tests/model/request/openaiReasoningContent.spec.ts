// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { buildModelRequest } from "../../../src/model/index.js";
test("openai-compatible requests replay all stored reasoning content", () => {
    for (const provider of ["deepseek", "local"]) {
        const body = buildModelRequest({
            provider,
            model: provider === "deepseek" ? "deepseek-chat" : "local-chat",
            stream: true,
            messages: [assistantWithMixedThinking()],
        }, modelConfig());
        assert.equal(body.messages[0]?.reasoning_content, "anthropic native content\ndeepseek native content");
    }
});
test("openai-compatible requests fall back to thinking text when native content is missing", () => {
    const body = buildModelRequest({
        provider: "local",
        model: "local-chat",
        stream: true,
        messages: [{
                role: "assistant",
                content: [
                    { type: "thinking", text: "legacy reasoning text" },
                    { type: "thinking", text: "signed reasoning text", signature: "sig-123" },
                ],
            }],
    }, modelConfig());
    assert.equal(body.messages[0]?.reasoning_content, "legacy reasoning text\nsigned reasoning text");
});
test("openai-compatible requests can replay an intentionally empty reasoning marker", () => {
    const body = buildModelRequest({
        provider: "local",
        model: "local-chat",
        stream: true,
        messages: [{
                role: "assistant",
                content: [
                    { type: "thinking", text: "", reasoningContent: "" },
                    { type: "text", text: "visible answer" },
                ],
            }],
    }, modelConfig());
    assert.equal(body.messages[0]?.reasoning_content, "");
});
function assistantWithMixedThinking() {
    return {
        role: "assistant",
        content: [
            {
                type: "thinking",
                text: "anthropic thought",
                reasoningContent: "anthropic native content",
            },
            {
                type: "thinking",
                text: "deepseek thought",
                reasoningContent: "deepseek native content",
            },
        ],
    };
}
function modelConfig() {
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
    const deepseek = provider("deepseek", "https://api.deepseek.com/v1", "deepseek-chat", capabilities);
    const local = provider("local", "https://example.invalid/v1", "local-chat", capabilities);
    return { providers: { deepseek, local } };
}
function provider(id, url, modelId, capabilities) {
    const models = {
        [modelId]: {
            id: modelId,
            capabilities,
            multimodal: { input: ["text"] },
        },
    };
    return {
        id,
        protocol: "openai",
        url,
        apiKey: "test",
        headers: {},
        models,
    };
}
