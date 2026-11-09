import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createMcpToolDefinitionsFromRuntime,
} from "../../src/mcp/runtime/PluginToToolBridge.js";
import {
  getMcpToolCapabilities,
  mergeMcpServerSources,
} from "../../src/mcp/runtime/mcpCapabilities.js";
import { createMcpTool } from "../../src/tool/builtin/mcpTool.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../../src/permission/index.js";

function context(taskRoot: string, serviceIds: readonly string[] = []) {
  return {
    sessionId: "session",
    turnId: "turn",
    cwd: taskRoot,
    taskRoot,
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      cwd: taskRoot,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
    networkAccess: {
      listServices: () => serviceIds.map((id) => ({ id })),
    },
  } as any;
}

function runtimeFor(spec: Record<string, unknown>, payload: unknown) {
  return {
    async listAllTools() {
      return [{
        serverId: "med-tools",
        toolName: "test_tool",
        wireName: "mcp__med-tools__test_tool",
        description: "test",
        inputSchema: { type: "object", properties: {} },
        ...spec,
      }];
    },
    getClient() {
      return {
        spec: { transport: "stdio", cwd: "/tmp" },
        async callTool() {
          return { content: [{ type: "text", text: JSON.stringify(payload) }] };
        },
      };
    },
  };
}

test("registered medical MCP tools expose read, write, network, and artifact capabilities", () => {
  assert.deepEqual(getMcpToolCapabilities("med-tools", "med_radar_analyze_ct"), {
    readOnly: false,
    taskReadRoots: ["inbox"],
    taskWriteRoots: ["exports"],
    networkServiceIds: ["service.radar"],
    artifactPolicy: "final",
  });
});

test("network-only MCP tools require their registered service, not task.read:inbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-network-only-"));
  try {
    const capabilities = getMcpToolCapabilities("med-tools", "med_trauma_rag_query");
    assert.ok(capabilities);
    const runtime = runtimeFor({ capabilities }, { ok: true });
    const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);

    assert.deepEqual(tool!.capabilityPolicy?.declared, [
      { kind: "network", id: "service.rag" },
    ]);
    assert.deepEqual(tool!.capabilityPolicy?.required({}, context(root)), [
      { kind: "network", id: "service.rag" },
    ]);

    const denied = await new PermissionRuntime().decide(
      tool!,
      {},
      context(root),
      "rag-unregistered",
    );
    assert.equal(denied.type, "deny");
    assert.match(denied.message ?? "", /not registered by the system: network:service\.rag/u);

    const allowed = await new PermissionRuntime().decide(
      tool!,
      {},
      context(root, ["service.rag"]),
      "rag-registered",
    );
    assert.equal(allowed.type, "allow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all registered network-only medical tools avoid an implicit inbox capability", async () => {
  const cases = [
    ["med-tools", "med_tools_health", ["service.rag", "service.radar", "service.deepchest", "service.vlm"]],
    ["med-tools", "med_trauma_rag_status", ["service.rag"]],
    ["med-tools", "med_trauma_rag_query", ["service.rag"]],
    ["med-tools", "med_radar_status", ["service.radar"]],
    ["med-tools", "med_deepchest_status", ["service.deepchest"]],
    ["med-tools", "med_deepchest_job", ["service.deepchest"]],
    ["mineru-ingest-tools", "mineru_ingest_health", ["service.mineru"]],
    ["mineru-ingest-tools", "mineru_ingest_status", ["service.mineru"]],
    ["mineru-ingest-tools", "mineru_ingest_result", ["service.mineru"]],
    ["mineru-ingest-tools", "mineru_ingest_validate", ["service.mineru"]],
    ["mineru-ingest-tools", "mineru_ingest_batch_status", ["service.mineru"]],
    ["mineru-ingest-tools", "mineru_ingest_batch_result", ["service.mineru"]],
    ["mineru-ingest-tools", "mineru_ingest_batch_validate", ["service.mineru"]],
  ] as const;
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-network-only-matrix-"));
  try {
    for (const [serverId, toolName, serviceIds] of cases) {
      const capabilities = getMcpToolCapabilities(serverId, toolName);
      assert.ok(capabilities, `${serverId}/${toolName}`);
      assert.deepEqual(capabilities.taskReadRoots, [], `${serverId}/${toolName}`);
      assert.deepEqual(capabilities.taskWriteRoots, [], `${serverId}/${toolName}`);

      const runtime = runtimeFor({ capabilities }, { ok: true });
      const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);
      const required = tool!.capabilityPolicy?.required({}, context(root)) ?? [];
      assert.deepEqual(required, serviceIds.map((id) => ({ kind: "network", id })), `${serverId}/${toolName}`);

      const decision = await new PermissionRuntime().decide(
        tool!,
        {},
        context(root, serviceIds),
        `${serverId}/${toolName}`,
      );
      assert.equal(decision.type, "allow", `${serverId}/${toolName}`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a registered RAG tool reaches the backend and reports backend failure separately", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-rag-backend-"));
  let called = false;
  try {
    const runtime = runtimeFor({
      capabilities: getMcpToolCapabilities("med-tools", "med_trauma_rag_query"),
    }, { ok: false, error: "embedding service unavailable" });
    runtime.getClient = (() => ({
      spec: { transport: "stdio", cwd: root },
      async callTool() {
        called = true;
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: false, error: "embedding service unavailable" }) }],
          isError: true,
        };
      },
    })) as any;
    const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);
    const decision = await new PermissionRuntime().decide(
      tool!,
      {},
      context(root, ["service.rag"]),
      "rag-backend-error",
    );
    assert.equal(decision.type, "allow");

    await assert.rejects(
      tool!.execute({ query: "战伤四级救治" }, context(root, ["service.rag"]) as any),
      /embedding service unavailable/u,
    );
    assert.equal(called, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP tools with files and services require both capability classes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-mixed-capabilities-"));
  try {
    const runtime = runtimeFor({
      capabilities: getMcpToolCapabilities("med-tools", "med_radar_analyze_ct"),
    }, { ok: true });
    const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);

    assert.deepEqual(tool!.capabilityPolicy?.required({}, context(root)), [
      { kind: "task.read", root: "inbox" },
      { kind: "task.write", root: "exports" },
      { kind: "network", id: "service.radar" },
    ]);

    const denied = await new PermissionRuntime().decide(
      tool!,
      {},
      context(root),
      "radar-unregistered",
    );
    assert.equal(denied.type, "deny");
    assert.match(denied.message ?? "", /not registered by the system: network:service\.radar/u);

    const allowed = await new PermissionRuntime().decide(
      tool!,
      {},
      context(root, ["service.radar"]),
      "radar-registered",
    );
    assert.equal(allowed.type, "allow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project MCP config cannot replace a system-registered medical server", () => {
  const merged = mergeMcpServerSources(
    {
      "med-tools": { command: "trusted-medical-entrypoint" },
      "mineru-ingest-tools": { command: "trusted-mineru-entrypoint" },
      "user-plugin": { command: "plugin-entrypoint" },
    },
    {
      "med-tools": { command: "project-controlled-entrypoint" },
      "user-plugin": { command: "project-controlled-plugin" },
      "browser-use": { command: "browser-entrypoint" },
    },
  );

  assert.equal((merged["med-tools"] as any).command, "trusted-medical-entrypoint");
  assert.equal((merged["mineru-ingest-tools"] as any).command, "trusted-mineru-entrypoint");
  assert.equal((merged["user-plugin"] as any).command, "project-controlled-plugin");
  assert.equal((merged["browser-use"] as any).command, "browser-entrypoint");
});

test("an MCP tool without a registered capability profile is denied", async () => {
  const [tool] = await createMcpToolDefinitionsFromRuntime(runtimeFor({}, { ok: true }) as any);
  const decision = await tool!.checkPermissions?.({}, context("/tmp"));
  assert.equal(decision?.type, "deny");
  assert.match(decision?.message ?? "", /registered capability profile/u);
});

test("MCP final and intermediate artifacts are normalized to task-relative paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-artifacts-"));
  try {
    await mkdir(join(root, "exports"), { recursive: true });
    await mkdir(join(root, "scratch", "qa"), { recursive: true });
    await writeFile(join(root, "exports", "report.csv"), "a,b\n1,2\n");
    await writeFile(join(root, "scratch", "qa", "audit.json"), "{}");

    const finalRuntime = runtimeFor({
      capabilities: {
        readOnly: false,
        taskReadRoots: ["inbox"],
        taskWriteRoots: ["exports"],
        networkServiceIds: [],
        artifactPolicy: "final",
      },
    }, {
      artifacts: [{ path: join(root, "exports", "report.csv"), description: "结果" }],
    });
    const [finalTool] = await createMcpToolDefinitionsFromRuntime(finalRuntime as any);
    const finalResult = await finalTool!.execute({}, context(root) as any);
    assert.deepEqual(finalResult.artifacts, [{
      path: "exports/report.csv",
      role: "final",
      description: "结果",
    }]);

    const intermediateRuntime = runtimeFor({
      capabilities: {
        readOnly: true,
        taskReadRoots: ["inbox"],
        taskWriteRoots: [],
        networkServiceIds: [],
        artifactPolicy: "intermediate",
      },
    }, {
      artifacts: [{ path: join(root, "scratch", "qa", "audit.json") }],
    });
    const [intermediateTool] = await createMcpToolDefinitionsFromRuntime(intermediateRuntime as any);
    const intermediateResult = await intermediateTool!.execute({}, context(root) as any);
    assert.deepEqual(intermediateResult.artifacts, [{
      path: "scratch/qa/audit.json",
      role: "intermediate",
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP output outside the task is rejected, except for declared managed medical data", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-boundary-"));
  const managed = join(root, "managed-derived");
  try {
    await mkdir(managed, { recursive: true });
    const managedReport = join(managed, "report.md");
    await writeFile(managedReport, "# report");

    const outsideRuntime = runtimeFor({
      capabilities: {
        readOnly: false,
        taskReadRoots: ["inbox"],
        taskWriteRoots: ["exports"],
        networkServiceIds: [],
        artifactPolicy: "final",
      },
    }, {
      artifacts: [{ path: "/tmp/not-in-task/report.csv" }],
    });
    const [outsideTool] = await createMcpToolDefinitionsFromRuntime(outsideRuntime as any);
    await assert.rejects(
      outsideTool!.execute({}, context(root) as any),
      /outside the current task/u,
    );

    const managedRuntime = runtimeFor({
      capabilities: {
        readOnly: true,
        taskReadRoots: ["inbox"],
        taskWriteRoots: [],
        networkServiceIds: [],
        artifactPolicy: "managed_derived",
      },
    }, {
      artifacts: [{ path: managedReport, description: "受控派生报告" }],
    });
    const [managedTool] = await createMcpToolDefinitionsFromRuntime(managedRuntime as any);
    const managedContext = {
      ...context(root),
      env: { PILOT_HOME: root, MED_DEEPCHEST_OUTPUT_DIR: managed },
    };
    const managedResult = await managedTool!.execute({}, managedContext as any);
    assert.equal(managedResult.artifacts, undefined);
    assert.equal((managedResult.metadata as any)?.mcp?.managedDerivedArtifacts?.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy MCP adapter cannot run without an explicit capability profile", async () => {
  const tool = createMcpTool({
    serverId: "legacy",
    toolName: "run",
    adapter: { callTool: async () => ({ ok: true }) },
  });
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-adapter-"));
  try {
    const decision = await new PermissionRuntime().decide(tool, {}, {
      sessionId: "session",
      turnId: "turn",
      cwd: root,
      taskRoot: root,
      permissionMode: "bypassPermissions",
      permissionContext: createDefaultPermissionContext({
        cwd: root,
        mode: "bypassPermissions",
        canPrompt: false,
        bypassAvailable: true,
      }),
    }, "call");
    assert.equal(decision.type, "deny");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP markdown image links cannot read files outside the task root", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-image-"));
  const taskRoot = join(root, "task");
  try {
    await mkdir(taskRoot, { recursive: true });
    const outside = join(root, "outside.png");
    await writeFile(outside, Buffer.from("not-a-real-png"));
    const runtime = {
      async listAllTools() {
        return [{
          serverId: "med-tools",
          toolName: "test_tool",
          wireName: "mcp__med-tools__test_tool",
          description: "test",
          inputSchema: { type: "object", properties: {} },
          capabilities: {
            readOnly: true,
            taskReadRoots: [],
            taskWriteRoots: [],
            networkServiceIds: [],
            artifactPolicy: "none",
          },
        }];
      },
      getClient() {
        return {
          spec: { transport: "stdio", cwd: taskRoot },
          async callTool() {
            return {
              content: [{ type: "text", text: "[outside](../outside.png)" }],
            };
          },
        };
      },
    };
    const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);
    const result = await tool!.execute({}, context(taskRoot));
    assert.equal(result.content.some((item) => item.type === "image"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP input paths stay inside the declared task roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-input-boundary-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-input-outside-"));
  try {
    await mkdir(join(root, "inbox", "upload"), { recursive: true });
    const inputPath = join(root, "inbox", "upload", "scan.dcm");
    await writeFile(inputPath, "fixture");
    const outsidePath = join(outside, "scan.dcm");
    await writeFile(outsidePath, "outside");

    let received: unknown;
    const runtime = runtimeFor({
      capabilities: {
        readOnly: true,
        taskReadRoots: ["inbox"],
        taskWriteRoots: [],
        networkServiceIds: [],
        artifactPolicy: "none",
      },
    }, { ok: true });
    runtime.getClient = (() => ({
      spec: { transport: "stdio", cwd: root },
      async callTool(_name: string, input: unknown) {
        received = input;
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      },
    })) as any;
    const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);

    await tool!.execute({ path: inputPath }, context(root) as any);
    assert.deepEqual(received, { path: await realpath(inputPath) });

    await assert.rejects(
      tool!.execute({ path: outsidePath }, context(root) as any),
      /outside the current task/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("MCP path arrays and nested document paths are normalized to task files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-input-shapes-"));
  try {
    await mkdir(join(root, "inbox", "batch"), { recursive: true });
    const first = join(root, "inbox", "batch", "one.pdf");
    const second = join(root, "inbox", "batch", "two.pdf");
    await writeFile(first, "one");
    await writeFile(second, "two");

    let received: unknown;
    const runtime = runtimeFor({
      capabilities: {
        readOnly: false,
        taskReadRoots: ["inbox"],
        taskWriteRoots: ["scratch"],
        networkServiceIds: [],
        artifactPolicy: "managed_derived",
      },
    }, { ok: true });
    runtime.getClient = (() => ({
      spec: { transport: "stdio", cwd: root },
      async callTool(_name: string, input: unknown) {
        received = input;
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      },
    })) as any;
    const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);

    await tool!.execute({
      image_paths: ["batch/one.pdf", "batch/two.pdf"],
      documents: [{ source_path: "one.pdf" }, { path: "two.pdf" }],
    }, context(root) as any);

    assert.deepEqual(received, {
      image_paths: [await realpath(first), await realpath(second)],
      documents: [{ source_path: await realpath(first) }, { path: await realpath(second) }],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP tools without task roots cannot receive path inputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-mcp-no-input-root-"));
  try {
    const runtime = runtimeFor({
      capabilities: {
        readOnly: true,
        taskReadRoots: [],
        taskWriteRoots: [],
        networkServiceIds: [],
        artifactPolicy: "none",
      },
    }, { ok: true });
    const [tool] = await createMcpToolDefinitionsFromRuntime(runtime as any);
    await assert.rejects(
      tool!.execute({ path: join(root, "secret.txt") }, context(root) as any),
      /does not declare a task input capability/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
