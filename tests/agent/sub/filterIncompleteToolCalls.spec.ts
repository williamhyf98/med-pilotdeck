// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { filterIncompleteToolCalls } from "../../../src/agent/sub/filterIncompleteToolCalls.js";
test("filterIncompleteToolCalls tolerates malformed messages without content", () => {
    const malformed = { role: "assistant" };
    const messages = [
        malformed,
        { role: "user", content: [{ type: "text", text: "next" }] },
    ];
    assert.deepEqual(filterIncompleteToolCalls(messages), [
        { role: "user", content: [{ type: "text", text: "next" }] },
    ]);
});
