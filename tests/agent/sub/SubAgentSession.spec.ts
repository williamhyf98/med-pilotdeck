// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { SubAgentSession, } from "../../../src/agent/sub/SubAgentSession.js";
import { SUBAGENT_DEFINITIONS, } from "../../../src/agent/sub/builtinSubagentTypes.js";
import { PermissionRuntime, createDefaultPermissionContext, } from "../../../src/permission/index.js";
import { createBashTool } from "../../../src/tool/builtin/bash.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry, } from "../../../src/tool/index.js";
const FINAL_REPORT = [
    "Scope: inspected inputs",
    "Result: ok",
    "Key files: none",
    "Files changed: none",
    "Issues: none",
].join("\n");
function createNoopTool(name, isReadOnly) {
    return {
        name,
        description: `${name} test tool`,
        kind: "custom",
        inputSchema: {
            type: "object",
            additionalProperties: true,
            properties: {},
        },
        isReadOnly,
        isConcurrencySafe: () => true,
        execute: async () => ({
            content: [{ type: "text", text: "ok" }],
            data: {},
        }),
    };
}
function createRouter() {
    return {
        decide: async ({ request }) => ({
            provider: request.provider,
            model: request.model,
            scenarioType: "default",
            isSubagent: true,
            orchestrating: false,
            resolvedFrom: "fallback",
            mutations: {},
        }),
        execute: async function* () {
            yield { type: "text_delta", text: FINAL_REPORT };
            yield {
                type: "usage",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
        },
        stream: async function* () {
            yield { type: "text_delta", text: FINAL_REPORT };
        },
    };
}
function parentConfig() {
    return {
        provider: "test",
        model: "test-model",
        cwd: process.cwd(),
        runMode: "agent",
        permissionMode: "bypassPermissions",
        permissionContext: {
            mode: "bypassPermissions",
            cwd: process.cwd(),
            additionalWorkingDirectories: [],
            canPrompt: false,
            bypassAvailable: true,
            rules: { allow: [], deny: [], ask: [] },
        },
    };
}
function sessionFor(definition, registry, configPatch = {}) {
    const options = {
        definition,
        directive: "Inspect the workspace.",
        parentConfig: { ...parentConfig(), ...configPatch },
        parentDependencies: {
            router: {},
            tools: {
                registry,
                scheduler: {},
            },
        },
        parentSessionId: "parent-session",
        parentTurnId: "parent-turn",
        subagentSessionId: "child-session",
        subagentId: "child-agent",
    };
    return new SubAgentSession(options);
}
function runtimeContext(config) {
    return {
        sessionId: "child-session",
        turnId: "child-turn",
        cwd: config.cwd,
        runMode: config.runMode,
        permissionMode: config.permissionMode,
        permissionContext: config.permissionContext,
        now: () => new Date("2026-07-17T00:00:00.000Z"),
    };
}
test("explore subagent does not probe tool safety before execution", async () => {
    const readOnlyChecks = [];
    const registry = new ToolRegistry();
    registry.register(createNoopTool("execute_code", (input) => {
        readOnlyChecks.push("execute_code");
        return input.code.length === 0;
    }));
    registry.register(createNoopTool("read_file", () => {
        readOnlyChecks.push("read_file");
        return true;
    }));
    const session = new SubAgentSession({
        definition: SUBAGENT_DEFINITIONS.explore,
        directive: "Inspect the provided files.",
        parentConfig: {
            provider: "test",
            model: "test-model",
            cwd: process.cwd(),
            permissionMode: "bypassPermissions",
            permissionContext: createDefaultPermissionContext({
                cwd: process.cwd(),
                mode: "bypassPermissions",
                canPrompt: true,
                bypassAvailable: true,
            }),
        },
        parentDependencies: {
            router: createRouter(),
            tools: {
                registry,
                scheduler: {},
            },
        },
        parentSessionId: "parent-session",
        parentTurnId: "parent-turn",
        subagentSessionId: "subagent-session",
        subagentId: "subagent-1",
    });
    const report = await session.run();
    assert.equal(report.definitionId, "explore");
    assert.equal(report.markdown, FINAL_REPORT);
    assert.deepEqual(readOnlyChecks, []);
});
test("explore registry ignores an unallowed dynamic tool without probing it", () => {
    const registry = new ToolRegistry();
    registry.register(createNoopTool("write_file", () => false));
    registry.register(createBashTool({
        runner: {
            async run() {
                return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
            },
        },
    }));
    const session = sessionFor(SUBAGENT_DEFINITIONS.explore, registry);
    const scoped = session.buildScopedRegistry();
    assert.deepEqual(scoped.list().map((tool) => tool.name), ["bash"]);
    assert.equal(session.buildConfig().runMode, "ask");
});
test("subagent tool scope cannot exceed the parent profile policy", () => {
    const registry = new ToolRegistry();
    registry.register(createNoopTool("read_file", () => true));
    registry.register(createNoopTool("bash", () => true));
    registry.register(createNoopTool("web_search", () => true));
    const session = sessionFor(SUBAGENT_DEFINITIONS.explore, registry, {
        toolPolicy: {
            allowedTools: ["read_file", "bash"],
            deniedTools: ["bash"],
        },
    });
    assert.deepEqual(session.buildScopedRegistry().list().map((tool) => tool.name), ["read_file"]);
});
test("read-only subagent evaluates bash safety from the real command", async () => {
    const commands = [];
    const runner = {
        async run(command) {
            commands.push(command);
            return {
                exitCode: 0,
                stdout: `${command}\n`,
                stderr: "",
                timedOut: false,
                durationMs: 1,
            };
        },
    };
    const registry = new ToolRegistry();
    registry.register(createBashTool({ runner }));
    const session = sessionFor(SUBAGENT_DEFINITIONS.explore, registry);
    const scoped = session.buildScopedRegistry();
    const config = session.buildConfig();
    const runtime = new ToolRuntime(scoped, new PermissionRuntime());
    const readResult = await runtime.execute({ id: "read-command", name: "bash", input: { command: "pwd" } }, runtimeContext(config));
    assert.equal(readResult.type, "success");
    assert.deepEqual(commands, ["pwd"]);
    const writeResult = await runtime.execute({ id: "write-command", name: "bash", input: { command: "touch blocked.txt" } }, runtimeContext(config));
    assert.equal(writeResult.type, "error");
    assert.equal(writeResult.type === "error" ? writeResult.error.code : "", "ask_mode_violation");
    assert.deepEqual(commands, ["pwd"], "blocked command must not reach the shell runner");
});
