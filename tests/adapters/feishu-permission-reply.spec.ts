// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { FeishuChannel } from "../../src/adapters/index.js";
test("Feishu handles permission replies before the active chat drain finishes", async () => {
    const chatId = "oc_test";
    const decisions = [];
    let resolveDecided;
    const decided = new Promise((resolve) => {
        resolveDecided = resolve;
    });
    const gateway = {
        permissionDecide: async (input) => {
            decisions.push(input);
            resolveDecided();
            return { delivered: true };
        },
    };
    const sent = [];
    const channel = new FeishuChannel({
        connectionMode: "webhook",
        send: async (message) => {
            sent.push(message);
        },
    });
    await channel.start({ gateway, logger: {} });
    channel.permissions.capture(chatId, "session-1", {
        type: "permission_request",
        requestId: "request-1",
        toolName: "read_file",
        payload: { file_path: "/tmp/a.txt" },
    });
    channel.inboundBatches.set(chatId, { messages: [], draining: true });
    const response = createMockResponse();
    await channel.handleWebhook({}, response, JSON.stringify({ chatId, text: "1", eventId: "reply-1" }));
    await withTimeout(decided, 1_000);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(decisions, [
        { sessionKey: "session-1", requestId: "request-1", decision: "allow", remember: false },
    ]);
    assert.deepEqual(sent, [{ chatId, text: "已允许一次，继续执行。" }]);
    assert.deepEqual(channel.inboundBatches.get(chatId), { messages: [], draining: true });
});
function createMockResponse() {
    return {
        writeHead(statusCode) {
            this.statusCode = statusCode;
        },
        end(body) {
            this.body = body;
        },
    };
}
async function withTimeout(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error("timed out waiting for permission decision")), timeoutMs);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
