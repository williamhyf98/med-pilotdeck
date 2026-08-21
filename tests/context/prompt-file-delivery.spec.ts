// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";
test("default prompt does not require Markdown links for generated files", () => {
    const extension = {
        listCommands: () => [],
        listSkills: () => [],
        listMcpInstructions: () => [],
    };
    const prompt = new PromptAssembler(extension).assemble({
        cwd: "/workspace",
        provider: "openai",
        model: "test-model",
        permissionMode: "bypassPermissions",
        additionalWorkingDirectories: [],
        tools: [],
        now: () => new Date("2026-07-21T00:00:00.000Z"),
    }).joined;
    assert.doesNotMatch(prompt, /File delivery links:/);
    assert.doesNotMatch(prompt, /make generated or modified files clickable/i);
    assert.doesNotMatch(prompt, /include a Markdown link to that file/i);
});
test("default prompt uses local-only lookup and does not advertise deleted network tools", () => {
    const extension = {
        listCommands: () => [],
        listSkills: () => [],
        listMcpInstructions: () => [],
    };
    const prompt = new PromptAssembler(extension).assemble({
        cwd: "/workspace",
        provider: "openai",
        model: "test-model",
        permissionMode: "bypassPermissions",
        additionalWorkingDirectories: [],
        tools: [{
                name: "web_fetch",
                description: "Fetch a known URL",
                inputSchema: { type: "object", properties: {} },
            }],
        now: () => new Date("2026-07-21T00:00:00.000Z"),
    }).joined;
    assert.doesNotMatch(prompt, /\bweb_search\b/);
    assert.doesNotMatch(prompt, /\bweb_fetch\b/);
    assert.match(prompt, /This runtime is offline/);
});
