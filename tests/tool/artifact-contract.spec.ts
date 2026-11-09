import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

function context(cwd: string): any {
  return {
    sessionId: "session",
    turnId: "turn",
    cwd,
    taskRoot: cwd,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
}

test("ToolRuntime carries validated structured artifacts into the tool result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-tool-artifacts-"));
  try {
    await mkdir(join(root, "exports"), { recursive: true });
    await writeFile(join(root, "exports", "report.pdf"), "%PDF");
    const registry = new ToolRegistry();
    registry.register({
      name: "artifact_tool",
      description: "test",
      kind: "custom",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      execute: async () => ({
        content: [{ type: "text", text: "done" }],
        artifacts: [{ path: "exports/report.pdf", role: "final", mimeType: "application/pdf" }],
      }),
    });

    const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
      { id: "call-1", name: "artifact_tool", input: {} },
      context(root),
    );

    assert.equal(result.type, "success");
    if (result.type === "success") {
      assert.deepEqual(result.artifacts, [{
        path: "exports/report.pdf",
        role: "final",
        mimeType: "application/pdf",
      }]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ToolRuntime rejects a tool that returns an invalid artifact declaration", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-tool-artifacts-invalid-"));
  try {
    await mkdir(join(root, "exports"), { recursive: true });
    await writeFile(join(root, "exports", "report.pdf"), "%PDF");
    const registry = new ToolRegistry();
    registry.register({
      name: "invalid_artifact_tool",
      description: "test",
      kind: "custom",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
      isReadOnly: () => false,
      isConcurrencySafe: () => true,
      execute: async () => ({
        content: [{ type: "text", text: "done" }],
        artifacts: [{ path: "/tmp/report.pdf", role: "final" }],
      }),
    });

    const result = await new ToolRuntime(registry, new PermissionRuntime()).execute(
      { id: "call-1", name: "invalid_artifact_tool", input: {} },
      context(root),
    );

    assert.equal(result.type, "error");
    if (result.type === "error") {
      assert.equal(result.error.code, "tool_execution_failed");
      assert.match(result.error.message, /artifact/u);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
