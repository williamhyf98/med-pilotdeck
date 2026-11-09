import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { createDefaultPermissionContext, PermissionRuntime } from "../../../src/permission/index.js";
import {
  createDiagramMakeTool,
  createDocxMakeTool,
  createPptxMakeTool,
  createSpreadsheetMakeTool,
} from "../../../src/tool/builtin/documentMakeTools.js";
import type { PilotDeckCommandRunner } from "../../../src/tool/builtin/bash/commandRunner.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "document-make-"));
  const cwd = join(home, "workspace");
  for (const folder of ["inbox", "scratch", "exports"]) {
    mkdirSync(join(cwd, folder), { recursive: true });
  }
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const invocations: Array<{ file: string; args: string[] }> = [];
  const runner: PilotDeckCommandRunner = {
    async run() {
      throw new Error("Structured document tools must never use the legacy shell runner.");
    },
    async runRegistered(file, args) {
      invocations.push({ file, args });
      const output = args[args.indexOf("--out") + 1]!;
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, "generated");
      const preview = join(cwd, "scratch", "work", "document", "preview.png");
      mkdirSync(dirname(preview), { recursive: true });
      writeFileSync(preview, "preview");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: "ok",
          output,
          preview: [preview],
        }),
        stderr: "",
        timedOut: false,
        durationMs: 4,
      };
    },
  };

  const context = {
    sessionId: "session",
    turnId: "turn",
    cwd,
    taskRoot: cwd,
    env: { ...process.env, PILOT_HOME: home, PILOTDECK_SYSTEM_HOME: home },
    permissionMode: "default" as const,
    runMode: "agent" as const,
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "default",
      canPrompt: true,
      bypassAvailable: true,
    }),
  };
  return { home, cwd, runner, context, invocations };
}

test("structured document make tools translate typed input to registered Skill argv", async (t) => {
  const { cwd, runner, context, invocations } = setup(t);
  const tools = [
    {
      name: "docx_make",
      create: createDocxMakeTool,
      input: { body: "病例正文", output_path: "exports/report.docx" },
      expected: ["make", "--body", "病例正文", "--out", join(cwd, "exports", "report.docx")],
    },
    {
      name: "pptx_make",
      create: createPptxMakeTool,
      input: {
        title: "研究汇报",
        markdown_path: "scratch/slides.md",
        theme: "academic",
        output_path: "exports/deck.pptx",
      },
      expected: [
        "make",
        "--title",
        "研究汇报",
        "--markdown",
        join(cwd, "scratch", "slides.md"),
        "--theme",
        "academic",
        "--out",
        join(cwd, "exports", "deck.pptx"),
      ],
    },
    {
      name: "spreadsheets_make",
      create: createSpreadsheetMakeTool,
      input: {
        csv_path: "inbox/data.csv",
        infer_types: true,
        output_path: "exports/data.xlsx",
      },
      expected: [
        "make",
        "--csv",
        join(cwd, "inbox", "data.csv"),
        "--infer-types",
        "--out",
        join(cwd, "exports", "data.xlsx"),
      ],
    },
    {
      name: "diagram_make",
      create: createDiagramMakeTool,
      input: {
        body: "输入 -> 输出",
        direction: "LR",
        output_path: "exports/flow.svg",
      },
      expected: [
        "make",
        "--body",
        "输入 -> 输出",
        "--direction",
        "LR",
        "--out",
        join(cwd, "exports", "flow.svg"),
      ],
    },
  ] as const;

  for (const item of tools) {
    const registry = new ToolRegistry();
    registry.register(item.create({ runner }));
    const result = await new ToolRuntime(registry, new PermissionRuntime()).execute({
      id: item.name,
      name: item.name,
      input: item.input,
    }, context);

    assert.equal(result.type, "success", result.type === "error" ? result.error.message : "");
    const invocation = invocations.at(-1);
    assert.equal(invocation?.file, "/bin/bash");
    assert.deepEqual(invocation?.args.slice(1), item.expected);
    if (result.type === "success") {
      assert.equal(result.data && typeof result.data === "object", true);
      assert.equal(result.artifacts?.some((artifact) => artifact.role === "final"), true);
      assert.equal(result.artifacts?.some((artifact) => artifact.role === "intermediate"), true);
    }
  }
});

test("structured document make tools reject unsafe output roots before launching a Skill", async (t) => {
  const { runner, context, invocations } = setup(t);
  const registry = new ToolRegistry();
  registry.register(createDocxMakeTool({ runner }));
  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute({
    id: "docx-inbox",
    name: "docx_make",
    input: { body: "blocked", output_path: "inbox/report.docx" },
  }, context);

  assert.equal(result.type, "error");
  assert.equal(invocations.length, 0);
  if (result.type === "error") assert.equal(result.error.code, "permission_denied");
});

test("spreadsheet make rejects multiple content sources without launching a Skill", async (t) => {
  const { runner, context, invocations } = setup(t);
  const registry = new ToolRegistry();
  registry.register(createSpreadsheetMakeTool({ runner }));
  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute({
    id: "spreadsheet-sources",
    name: "spreadsheets_make",
    input: {
      body: "表格",
      csv_path: "inbox/data.csv",
      output_path: "exports/data.xlsx",
    },
  }, context);

  assert.equal(result.type, "error");
  assert.equal(invocations.length, 0);
  if (result.type === "error") assert.equal(result.error.code, "invalid_tool_input");
});

