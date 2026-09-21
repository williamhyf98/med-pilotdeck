// @ts-nocheck
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMcpToolDefinitionsFromRuntime } from "../../src/mcp/runtime/PluginToToolBridge.js";

function runtimeFor(toolName: string, callTool: Function) {
  const spec = {
    serverId: "med-tools",
    toolName,
    wireName: `mcp__med-tools__${toolName}`,
    description: "medical test tool",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
  const client = {
    spec: { transport: "stdio", cwd: "/tmp" },
    callTool,
  };
  return {
    listAllTools: async () => [spec],
    getClient: () => client,
  };
}

function context(events: unknown[]) {
  return {
    sessionId: "session-medical",
    turnId: "turn-medical",
    currentToolCallId: "call-medical",
    cwd: "/workspace",
    permissionMode: "default",
    permissionContext: {},
    progress: (event: unknown) => events.push(event),
    now: () => new Date("2026-09-21T08:00:00.000Z"),
  };
}

test("DICOM routing emits only sanitized medical activity", async () => {
  const events: any[] = [];
  const runtime = runtimeFor("med_dicom_route", async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        status: "ready",
        path: "/private/patient/alice/scan.dcm",
        modality: "CT",
        body_region: "chest",
        is_complete_3d_series: true,
        recommended_skill: "med-deepchest-3dmedagent",
      }),
    }],
  }));
  const [definition] = await createMcpToolDefinitionsFromRuntime(runtime as any);
  await definition.execute({ path: "/private/patient/alice/scan.dcm" }, context(events));

  const activityEvents = events.filter((event) => event.metadata?.channel === "medical_activity");
  assert.equal(activityEvents.length, 2);
  assert.equal(activityEvents[0].metadata.title, "正在读取 DICOM 元数据");
  assert.equal(activityEvents[1].metadata.state, "completed");
  assert.match(activityEvents[1].metadata.detail, /CT \/ chest/);
  assert.doesNotMatch(JSON.stringify(activityEvents), /private|alice|scan\.dcm/);
});

test("medical report progress remains assistant text while stages use activity", async () => {
  const events: any[] = [];
  const runtime = runtimeFor("med_parse_medical", async (_name: string, _input: unknown, options: any) => {
    options.onProgress?.({ progress: 1, message: "中文医学报告" });
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          ok: true,
          status: "ready",
          report: "中文医学报告",
          items: [{}],
          png_paths: ["/private/generated/frame.png"],
        }),
      }],
    };
  });
  const [definition] = await createMcpToolDefinitionsFromRuntime(runtime as any);
  await definition.execute({ path: "/private/patient/scan.dcm" }, context(events));

  assert.ok(events.some((event) => (
    event.metadata?.channel === "assistant_text_delta"
    && event.metadata?.text === "中文医学报告"
  )));
  assert.ok(events.some((event) => (
    event.metadata?.channel === "medical_activity"
    && event.metadata?.title === "正在生成医学报告"
  )));
  const activityText = JSON.stringify(events.filter((event) => event.metadata?.channel === "medical_activity"));
  assert.doesNotMatch(activityText, /private|frame\.png|scan\.dcm/);
});

test("medical tools resolve project-relative and uploaded basenames inside inbox", async (t) => {
  const projectRoot = mkdtempSync(join(tmpdir(), "pilotdeck-medical-path-"));
  t.after(() => rmSync(projectRoot, { recursive: true, force: true }));
  const uploadDir = join(projectRoot, "inbox", "upload-1");
  mkdirSync(uploadDir, { recursive: true });
  const dicomPath = join(uploadDir, "1-scan.dcm");
  writeFileSync(dicomPath, "fixture");

  const receivedPaths: string[] = [];
  const runtime = runtimeFor("med_dicom_route", async (_name: string, input: any) => {
    receivedPaths.push(input.path);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ status: "ready", modality: "CT", body_region: "abdomen" }),
      }],
    };
  });
  const [definition] = await createMcpToolDefinitionsFromRuntime(runtime as any);
  const executionContext = { ...context([]), cwd: projectRoot };

  await definition.execute({ path: "inbox/upload-1/1-scan.dcm" }, executionContext);
  await definition.execute({ path: "scan.dcm" }, executionContext);

  assert.deepEqual(receivedPaths, [realpathSync(dicomPath), realpathSync(dicomPath)]);
});

test("RADAR result paths are exposed as file artifacts", async () => {
  const scoresCsv = "/workspace/exports/radar/request/scores.csv";
  const summaryJson = "/workspace/exports/radar/request/summary.json";
  const runtime = runtimeFor("med_radar_analyze_ct", async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        ok: true,
        status: "completed",
        artifacts: {
          scores_csv: scoresCsv,
          summary_json: summaryJson,
        },
      }),
    }],
  }));
  const [definition] = await createMcpToolDefinitionsFromRuntime(runtime as any);
  const result = await definition.execute({ path: "/workspace/inbox/study.dcm" }, context([]));

  assert.ok(result && "content" in result);
  const files = result.content.filter((item: any) => item.type === "file");
  assert.deepEqual(files, [
    {
      type: "file",
      path: scoresCsv,
      mimeType: "text/csv",
      description: "RADAR 评分 CSV",
    },
    {
      type: "file",
      path: summaryJson,
      mimeType: "application/json",
      description: "RADAR 摘要 JSON",
    },
  ]);
});
