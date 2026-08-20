// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { createTodoWriteTool } from "../../src/tool/builtin/todoWrite.js";
function baseContext() {
    return {
        sessionId: "s1",
        turnId: "t1",
        cwd: "/tmp",
        permissionMode: "bypassPermissions",
        permissionContext: {
            mode: "bypassPermissions",
            cwd: "/tmp",
            additionalWorkingDirectories: [],
            canPrompt: true,
            bypassAvailable: true,
            rules: { allow: [], deny: [], ask: [] },
        },
        now: () => new Date("2026-07-09T00:00:00.000Z"),
    };
}
function textOf(result) {
    const first = result.content[0];
    if (first?.type === "text")
        return first.text ?? "";
    if (first?.type === "json")
        return JSON.stringify(first.value);
    return "";
}
test("todo_write returns the actual todo list in model-visible content", async () => {
    const result = await createTodoWriteTool().execute({
        todos: [
            { id: "review", content: "Review tool outputs", status: "in_progress", priority: "high" },
            { id: "tests", content: "Add focused tests", status: "pending" },
        ],
        reason: "Track review steps",
    }, baseContext());
    const text = textOf(result);
    assert.match(text, /Todo list updated:/);
    assert.match(text, /reason: Track review steps/);
    assert.match(text, /- \[in_progress\] id=review priority=high Review tool outputs/);
    assert.match(text, /- \[pending\] id=tests Add focused tests/);
});
