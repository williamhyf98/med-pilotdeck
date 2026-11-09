import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { createDefaultPermissionContext, PermissionRuntime } from "../../../src/permission/index.js";
import { createPdfMakeTool } from "../../../src/tool/builtin/pdfMake.js";
import {
  NodeShellCommandRunner,
  setCommandSandbox,
} from "../../../src/tool/builtin/bash/commandRunner.js";
import { SandboxExecSandbox } from "../../../src/tool/builtin/bash/sandbox/sandboxExec.js";
import { resolveAppRoot } from "../../../src/tool/builtin/bash/sandbox/bwrap.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import type { PilotDeckCommandRunner } from "../../../src/tool/builtin/bash/commandRunner.js";

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "pdf-make-"));
  const cwd = join(home, "workspace");
  for (const folder of ["inbox", "scratch", "exports"]) {
    mkdirSync(join(cwd, folder), { recursive: true });
  }
  t.after(() => rmSync(home, { recursive: true, force: true }));

  let launched = 0;
  let invocation: { file: string; args: string[]; timeoutMs: number } | undefined;
  const runner: PilotDeckCommandRunner = {
    async run() {
      throw new Error("Structured pdf_make must never use the legacy shell runner.");
    },
    async runRegistered(file, args, options) {
      launched += 1;
      invocation = { file, args, timeoutMs: options.timeoutMs };
      const output = join(cwd, "exports", "report.pdf");
      const preview = join(cwd, "scratch", "work", "pdf", "make", "render", "page-1.png");
      const audit = join(cwd, "scratch", "work", "pdf", "make", "render", "audit.json");
      mkdirSync(join(preview, ".."), { recursive: true });
      writeFileSync(output, "%PDF-1.7");
      writeFileSync(preview, "png");
      writeFileSync(audit, "{}");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: "ok",
          output,
          pages: 1,
          preview: [preview],
          audit,
          warnings: [],
        }),
        stderr: "",
        timedOut: false,
        durationMs: 5,
      };
    },
  };

  const registry = new ToolRegistry();
  registry.register(createPdfMakeTool({ runner }));
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const context = (mode: "default" | "bypassPermissions" = "default") => ({
    sessionId: "session",
    turnId: "turn",
    cwd,
    taskRoot: cwd,
    env: { ...process.env, PILOT_HOME: home, PILOTDECK_SYSTEM_HOME: home },
    permissionMode: mode,
    runMode: "agent" as const,
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode,
      canPrompt: true,
      bypassAvailable: true,
    }),
  });
  return {
    home,
    cwd,
    runtime,
    context,
    launched: () => launched,
    invocation: () => invocation,
  };
}

test("pdf_make maps structured input to the trusted Skill argv and returns artifacts", async (t) => {
  const { runtime, context, cwd, launched, invocation } = setup(t);
  const result = await runtime.execute({
    id: "pdf-structured",
    name: "pdf_make",
    input: {
      title: "病例报告",
      body: "伤情概述",
      output_path: "exports/report.pdf",
      force: true,
    },
  }, context());

  assert.equal(result.type, "success");
  assert.equal(launched(), 1);
  assert.equal(invocation()?.file, "/bin/bash");
  assert.deepEqual(invocation()?.args.slice(1), [
    "make",
    "--title",
    "病例报告",
    "--body",
    "伤情概述",
    "--out",
    join(cwd, "exports", "report.pdf"),
    "--force",
  ]);
  if (result.type === "success") {
    assert.equal((result.data as { output?: string } | undefined)?.output, "exports/report.pdf");
    assert.deepEqual(result.artifacts, [
      { path: "exports/report.pdf", role: "final" },
      { path: "scratch/work/pdf/make/render/page-1.png", role: "intermediate" },
      { path: "scratch/work/pdf/make/render/audit.json", role: "intermediate" },
    ]);
    assert.equal(result.content[0]?.type, "file");
  }
});

test("pdf_make cannot write inbox and does not launch the Skill", async (t) => {
  const { runtime, context, launched } = setup(t);
  const result = await runtime.execute({
    id: "pdf-inbox",
    name: "pdf_make",
    input: { body: "blocked", output_path: "inbox/report.pdf" },
  }, context());

  assert.equal(result.type, "error");
  assert.equal(launched(), 0);
  if (result.type === "error") assert.equal(result.error.code, "permission_denied");
});

test("pdf_make re-reads the administrator command policy and rejects disabled capability", async (t) => {
  const { runtime, context, home, launched } = setup(t);
  const first = await runtime.execute({
    id: "pdf-before-policy",
    name: "pdf_make",
    input: { body: "first", output_path: "exports/report.pdf" },
  }, context());
  assert.equal(first.type, "success");
  assert.equal(launched(), 1);

  const policyDir = join(home, "system", "security");
  mkdirSync(policyDir, { recursive: true });
  writeFileSync(
    join(policyDir, "command-policy.yaml"),
    "version: 1\nmode: registered_only\ncommands: []\n",
  );
  const second = await runtime.execute({
    id: "pdf-after-policy",
    name: "pdf_make",
    input: { body: "second", output_path: "exports/second.pdf" },
  }, context());
  assert.equal(second.type, "error");
  assert.equal(launched(), 1);
});

test("pdf_make rejects executable source files as spec inputs", async (t) => {
  const { runtime, context, cwd, launched } = setup(t);
  writeFileSync(join(cwd, "scratch", "unsafe.py"), "print('no')");
  const result = await runtime.execute({
    id: "pdf-source",
    name: "pdf_make",
    input: {
      spec_path: "scratch/unsafe.py",
      output_path: "exports/report.pdf",
    },
  }, context("bypassPermissions"));

  assert.equal(result.type, "error");
  assert.equal(launched(), 0);
  assert.match(readFileSync(join(cwd, "scratch", "unsafe.py"), "utf8"), /print/u);
});

test("pdf_make creates a real PDF through the OS sandbox", {
  skip: process.platform !== "darwin" && "requires the local macOS sandbox for real execution",
}, async (t) => {
  const { runtime, context, cwd } = setup(t);
  setCommandSandbox(new SandboxExecSandbox({
    appRoot: resolveAppRoot(),
    nodeBinDir: dirname(process.execPath),
  }));
  t.after(() => setCommandSandbox(null));

  const registry = new ToolRegistry();
  registry.register(createPdfMakeTool({ runner: new NodeShellCommandRunner() }));
  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute({
    id: "pdf-real",
    name: "pdf_make",
    input: {
      title: "受控 PDF 测试",
      body: "由结构化工具调用可信 PDF Skill 生成。",
      output_path: "exports/real-report.pdf",
    },
  }, context("bypassPermissions"));

  assert.equal(result.type, "success", result.type === "error" ? result.error.message : "");
  assert.equal(readFileSync(join(cwd, "exports", "real-report.pdf")).subarray(0, 5).toString(), "%PDF-");
});
