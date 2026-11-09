import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

const tool: PilotDeckToolDefinition = {
  name: "write_file", kind: "filesystem", description: "write",
  inputSchema: { type: "object", properties: {} },
  isReadOnly: () => false, isConcurrencySafe: () => false,
  checkPermissions: async () => ({ type: "passthrough" }),
  execute: async () => ({ content: [] }),
};
function context(mode: "default" | "plan" = "default"): PilotDeckToolRuntimeContext {
  return {
    sessionId: "s", turnId: "t", cwd: process.cwd(), taskRoot: process.cwd(),
    permissionMode: mode,
    permissionContext: createDefaultPermissionContext({ cwd: process.cwd(), mode, canPrompt: false }),
  };
}

test("ordinary task-local writes auto-run without permission prompts", async () => {
  assert.equal((await new PermissionRuntime().decide(tool, {}, context(), "write")).type, "allow");
});

test("hard path deny, admin deny and plan constraints still block automatic writes", async () => {
  const runtime = new PermissionRuntime();
  const unsafe = { ...tool, checkPermissions: async () => ({
    type: "deny" as const, reason: { type: "safety" as const, message: "outside task" }, message: "outside task",
  }) };
  assert.equal((await runtime.decide(unsafe, {}, context(), "unsafe")).type, "deny");
  const policy = context();
  policy.permissionContext.rules.deny.push({ source: "policy", behavior: "deny", toolName: "write_file" });
  assert.equal((await runtime.decide(tool, { file_path: "scratch/report.md" }, policy, "policy")).type, "deny");
  assert.equal((await runtime.decide(tool, {}, context("plan"), "plan")).type, "deny");
});

test("an unregistered unknown tool cannot auto-run by falling through default mode", async () => {
  const unknown = { ...tool, name: "unknown_dynamic_tool", kind: "mcp" as const };
  assert.notEqual((await new PermissionRuntime().decide(unknown, {}, context(), "unknown")).type, "allow");
});
