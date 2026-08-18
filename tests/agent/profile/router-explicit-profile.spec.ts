// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { createRouterRuntime } from "../../../src/router/index.js";
test("server-validated profile model selection bypasses custom routing", async () => {
    let customRouterCalled = false;
    const modelRuntime = {
        async *stream() { },
        async complete() {
            throw new Error("not used");
        },
        getCapabilities() {
            throw new Error("not used");
        },
        getMultimodal() {
            return { input: ["text"] };
        },
        getProviderProtocol() {
            return "openai";
        },
        getProviderBaseUrl() {
            return "https://example.invalid/v1";
        },
    };
    const router = createRouterRuntime({
        enabled: true,
        scenarios: {
            default: { id: "openai/default", provider: "openai", model: "default" },
        },
        customRouter: { extensionId: "medical-router" },
    }, {
        modelRuntime,
        customRouterRegistry: {
            lookupRouter: () => ({
                id: "medical-router",
                async decide() {
                    customRouterCalled = true;
                    return { provider: "other", model: "other-model" };
                },
            }),
        },
    });
    try {
        const decision = await router.decide({
            sessionId: "session-1",
            isMainAgent: true,
            request: {
                provider: "openrouter",
                model: "medical/model",
                messages: [{ role: "user", content: [{ type: "text", text: "triage" }] }],
            },
            metadata: {
                explicitProvider: "openrouter",
                explicitModel: "medical/model",
                serverValidatedModelOverride: true,
            },
        });
        assert.equal(customRouterCalled, false);
        assert.equal(decision.provider, "openrouter");
        assert.equal(decision.model, "medical/model");
        assert.equal(decision.resolvedFrom, "explicit");
    }
    finally {
        await router.shutdown();
    }
});
