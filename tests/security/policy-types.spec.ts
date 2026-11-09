import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultPermissionContext, PermissionRuntime, permissionSettingsToRuleSet } from "../../src/permission/index.js";
import { evaluateCapabilityPolicy } from "../../src/security/policy/types.js";
import type { PilotDeckCapability } from "../../src/security/policy/types.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import type { PilotDeckToolDefinition, PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

test("invalid capability kinds and impossible directory grants are denied", () => {
  const invalid = [
    { kind: "task.write", root: "inbox" },
    { kind: "task.read", root: "memory" },
    { kind: "task.read", root: { toString: () => "inbox" } },
    { kind: "shell", id: "python" },
    { kind: "command", id: "" },
    { kind: "command", id: "/usr/bin/python" },
    { kind: "command", id: "pdf.make\n" },
    { kind: "network", id: "http://example.org" },
  ];
  for (const capability of invalid) {
    assert.equal(
      evaluateCapabilityPolicy([capability], [capability]).type,
      "deny",
      JSON.stringify(capability),
    );
  }
});

test("a requested capability must be declared by the trusted tool", () => {
  const result = evaluateCapabilityPolicy(
    [{ kind: "task.write", root: "exports" }],
    [{ kind: "task.read", root: "inbox" }],
  );
  assert.equal(result.type, "deny");
});

test("declared file capabilities are usable, but command and network require separate system registration", () => {
  assert.equal(evaluateCapabilityPolicy(
    [{ kind: "task.read", root: "inbox" }, { kind: "task.write", root: "scratch" }],
    [{ kind: "task.read", root: "inbox" }, { kind: "task.write", root: "scratch" }],
  ).type, "allow");

  for (const capability of [
    { kind: "command", id: "workspace.pwd" },
    { kind: "command", id: "pdf.make" },
    { kind: "network", id: "office.renderer" },
  ]) {
    assert.equal(evaluateCapabilityPolicy([capability], [capability]).type, "deny");
    assert.equal(evaluateCapabilityPolicy([capability], [capability], [capability]).type, "allow");
  }
});

const required = { kind: "task.write", root: "scratch" } as const;

function configuredTool(requiredCapabilities: readonly PilotDeckCapability[]): PilotDeckToolDefinition {
  return {
    name: "test_capability_tool",
    kind: "filesystem",
    description: "test",
    inputSchema: { type: "object", properties: {} },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    capabilityPolicy: {
      declared: [required],
      required: () => requiredCapabilities,
    },
    execute: async () => ({ content: [] }),
  };
}

function context(mode: "default" | "plan" | "bypassPermissions" = "default"): PilotDeckToolRuntimeContext {
  return {
    sessionId: "s",
    turnId: "t",
    cwd: process.cwd(),
    permissionMode: mode,
    permissionContext: createDefaultPermissionContext({
      cwd: process.cwd(),
      mode,
      canPrompt: true,
      rules: permissionSettingsToRuleSet({
        version: 1,
        allowedTools: ["test_capability_tool"],
        disallowedTools: [],
        skipPermissions: true,
      }),
    }),
  };
}

test("permissions.json allow and bypassPermissions cannot grant an undeclared capability", async () => {
  for (const mode of ["default", "bypassPermissions"] as const) {
    const decision = await new PermissionRuntime().decide(
      configuredTool([{ kind: "command", id: "python.run" }]), {}, context(mode), "call",
    );
    assert.equal(decision.type, "deny");
  }
});

test("declared ordinary task-file operations auto-run while admin deny and plan constraints remain", async () => {
  const runtime = new PermissionRuntime();
  const tool = configuredTool([required]);
  const ordinary = context();
  ordinary.permissionContext.rules.allow = [];
  assert.equal((await runtime.decide(tool, {}, ordinary, "call")).type, "allow");
  ordinary.permissionContext.rules.deny.push({
    source: "policy", behavior: "deny", toolName: "test_capability_tool",
  });
  assert.equal((await runtime.decide(tool, {}, ordinary, "call")).type, "deny");
  assert.equal((await runtime.decide(tool, {}, context("plan"), "call")).type, "deny");
});

test("a declared command is not enabled by user allow even when registered in the tool definition", async () => {
  const command = { kind: "command", id: "pdf.make" } as const;
  const tool = configuredTool([command]);
  tool.capabilityPolicy = { declared: [required, command], required: () => [command] };
  assert.equal((await new PermissionRuntime().decide(tool, {}, context(), "call")).type, "deny");
  assert.equal((await new PermissionRuntime([command]).decide(tool, {}, context(), "call")).type, "allow");
});

test("an administrator deny rule still blocks a registered command", async () => {
  const command = { kind: "command", id: "pdf.make" } as const;
  const tool = configuredTool([command]);
  tool.capabilityPolicy = { declared: [command], required: () => [command] };
  const current = context("bypassPermissions");
  current.permissionContext.rules.deny.push({
    source: "policy", behavior: "deny", toolName: "test_capability_tool",
  });
  assert.equal((await new PermissionRuntime([command]).decide(tool, {}, current, "call")).type, "deny");
});

test("ToolRuntime never executes an unregistered command despite persisted user allow and bypass", async () => {
  const command = { kind: "command", id: "pdf.make" } as const;
  const registry = new ToolRegistry();
  let executed = false;
  registry.register({
    ...configuredTool([command]),
    capabilityPolicy: { declared: [command], required: () => [command] },
    execute: async () => {
      executed = true;
      return { content: [{ type: "text", text: "ran" }] };
    },
  });
  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
    { id: "call", name: "test_capability_tool", input: {} },
    context("bypassPermissions"),
  );
  assert.equal(result.type, "error");
  assert.equal(result.error.code, "permission_denied");
  assert.equal(executed, false);
});

test("an opted-in side-effecting tool cannot auto-run with an empty capability declaration", async () => {
  const tool = configuredTool([]);
  tool.capabilityPolicy = { declared: [], required: () => [] };
  assert.equal((await new PermissionRuntime().decide(tool, {}, context("bypassPermissions"), "call")).type, "deny");
});

test("an opted-in read-only tool cannot run with an empty capability declaration", async () => {
  const tool = configuredTool([]);
  tool.isReadOnly = () => true;
  tool.capabilityPolicy = { declared: [], required: () => [] };
  assert.equal((await new PermissionRuntime().decide(tool, {}, context(), "call")).type, "deny");
});
