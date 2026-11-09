import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { PermissionRuntime } from "../../../../src/permission/index.js";
import { createBashTool } from "../../../../src/tool/builtin/bash.js";
import { NodeShellCommandRunner, setCommandSandbox } from "../../../../src/tool/builtin/bash/commandRunner.js";
import { SandboxExecSandbox } from "../../../../src/tool/builtin/bash/sandbox/sandboxExec.js";
import { resolveAppRoot } from "../../../../src/tool/builtin/bash/sandbox/bwrap.js";
import { dirname } from "node:path";
import { ToolRuntime } from "../../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../../src/tool/registry/ToolRegistry.js";
import { evaluateBashCommand } from "../../../../src/tool/builtin/bash/registeredCommands.js";
import { parseCommandPolicy } from "../../../../src/security/policy/parseCommandPolicy.js";

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "registered-bash-"));
  const cwd = join(home, "workspace");
  for (const folder of ["inbox", "scratch", "exports"]) mkdirSync(join(cwd, folder), { recursive: true });
  writeFileSync(join(cwd, "inbox", "record.txt"), "record");
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let launched = 0;
  const registry = new ToolRegistry();
  registry.register(createBashTool({
    runner: {
      async run() { throw new Error("Old shell runner must never be used by Agent."); },
      async runRegistered(_file, _args) {
        launched++;
        return { exitCode: 0, stdout: "document generated", stderr: "", timedOut: false, durationMs: 1 };
      },
    },
  }));
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const context = (mode: "default" | "bypassPermissions" = "bypassPermissions") => ({
    sessionId: "session", turnId: "turn", cwd, env: { ...process.env, PILOT_HOME: home },
    permissionMode: mode, permissionContext: {
      mode, cwd, additionalWorkingDirectories: [], canPrompt: true, bypassAvailable: true,
      rules: { allow: [{ toolName: "bash", behavior: "allow" as const, source: "user" as const }], deny: [], ask: [] },
    },
  });
  return { home, cwd, runtime, context, launched: () => launched };
}

test("user allow and bypass do not authorize an unregistered command", async (t) => {
  const { runtime, context, launched } = setup(t);
  for (const mode of ["default", "bypassPermissions"] as const) {
    for (const command of ["echo unsafe", "python3 -c 'print(1)'", "pwd; id", "bash \"$PDF_SKILL_ROOT/scripts/pdf.sh\" self-test"]) {
      const result = await runtime.execute({ id: command, name: "bash", input: { command } }, context(mode));
      assert.equal(result.type, "error", command);
      if (result.type === "error") assert.match(result.error.code, /violation|denied/u);
    }
  }
  assert.equal(launched(), 0);
});

test("registered inspection only exposes task roots and never launches a process", async (t) => {
  const { runtime, context, cwd, home, launched } = setup(t);
  writeFileSync(join(cwd, "private.txt"), "secret");
  symlinkSync(home, join(cwd, "inbox", "link"));
  for (const [command, expected] of [
    ["pwd", cwd], ["ls", "inbox"], ["ls inbox", "record.txt"],
    ["stat inbox/record.txt", "record.txt"], ["find inbox", "record.txt"],
  ]) {
    const result = await runtime.execute({ id: command, name: "bash", input: { command } }, context());
    assert.equal(result.type, "success", command);
    if (result.type === "success") {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
      assert.doesNotMatch(text, /private\.txt|secret/u);
    }
  }
  assert.equal(launched(), 0);
  const denied = await runtime.execute({ id: "link", name: "bash", input: { command: "stat inbox/link" } }, context());
  assert.equal(denied.type, "error");
});

test("registered Skill goes through argv and admin policy can disable it", async (t) => {
  const { runtime, context, home, launched } = setup(t);
  const command = 'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --body "病历" --out exports/report.pdf';
  const first = await runtime.execute({ id: "first", name: "bash", input: { command } }, context());
  assert.equal(first.type, "success");
  assert.equal(launched(), 1);
  const security = join(home, "system", "security");
  mkdirSync(security, { recursive: true });
  writeFileSync(join(security, "command-policy.yaml"), "version: 1\nmode: registered_only\ncommands: []\n");
  const second = await runtime.execute({ id: "second", name: "bash", input: { command } }, context());
  assert.equal(second.type, "error");
  assert.equal(launched(), 1);
  assert.match(readFileSync(join(security, "command-policy.yaml"), "utf8"), /commands: \[\]/u);
});

test("PreToolUse command rewrite is checked and cannot reach the legacy shell", async (t) => {
  const { cwd, context } = setup(t);
  let called = 0;
  const registry = new ToolRegistry();
  registry.register(createBashTool({
    runner: {
      async run() { called++; throw new Error("legacy shell"); },
      async runRegistered() { called++; throw new Error("argv runner"); },
    },
  }));
  const lifecycle = {
    async dispatch(input: { event: string }) {
      return {
        effects: input.event === "PreToolUse"
          ? [{ type: "updated_tool_input" as const, input: { command: "node -e 'process.exit(0)'" } }]
          : [],
        messages: [], events: [], blockingErrors: [], nonBlockingErrors: [],
      };
    },
  };
  const runtime = new ToolRuntime(registry, new PermissionRuntime(), lifecycle as never);
  const result = await runtime.execute({ id: "rewrite", name: "bash", input: { command: "pwd" } }, context());
  assert.equal(result.type, "error");
  assert.equal(called, 0);
  assert.ok(cwd);
});

test("PreToolUse cannot turn an ask-mode workspace inspection into document generation", async (t) => {
  const { context } = setup(t);
  let called = 0;
  const registry = new ToolRegistry();
  registry.register(createBashTool({ runner: {
    async run() { called++; throw new Error("legacy shell"); },
    async runRegistered() { called++; throw new Error("argv runner"); },
  } }));
  const lifecycle = {
    async dispatch(input: { event: string }) {
      return {
        effects: input.event === "PreToolUse"
          ? [{ type: "updated_tool_input" as const, input: {
            command: 'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --body x --out exports/a.pdf',
          } }]
          : [],
        messages: [], events: [], blockingErrors: [], nonBlockingErrors: [],
      };
    },
  };
  const runtime = new ToolRuntime(registry, new PermissionRuntime(), lifecycle as never);
  const result = await runtime.execute({ id: "ask-rewrite", name: "bash", input: { command: "pwd" } },
    { ...context(), runMode: "ask" });
  assert.equal(result.type, "error");
  assert.equal(result.type === "error" ? result.error.code : "", "ask_mode_violation");
  assert.equal(called, 0);
});

test("direct Bash execution and permission evaluation reject unregistered commands", async (t) => {
  const { runtime, context, launched } = setup(t);
  const tool = createBashTool({
    runner: {
      async run() { throw new Error("legacy shell path"); },
      async runRegistered() { throw new Error("unregistered input reached runner"); },
    },
  });
  const permission = await new PermissionRuntime().decide(tool, { command: "echo untrusted" }, context(), "direct");
  assert.equal(permission.type, "deny");
  await assert.rejects(() => tool.execute({ command: "echo untrusted" }, context()), /registered|Unregistered/u);
  assert.equal(launched(), 0);
  assert.equal((await runtime.execute({ id: "safe", name: "bash", input: { command: "pwd" } }, context())).type, "success");
});

test("the parser rejects symlinks and undocumented flags before executing", (t) => {
  const { cwd } = setup(t);
  symlinkSync(tmpdir(), join(cwd, "scratch", "escape"));
  const policy = parseCommandPolicy(undefined);
  for (const command of ["find scratch/escape", "ls inbox/../private.txt", "find inbox -exec id", "bash \"$PDF_SKILL_ROOT/scripts/pdf.sh\" make --builder scratch/x.py --out exports/a.pdf"]) {
    assert.throws(() => evaluateBashCommand(command, { cwd, appRoot: process.cwd(), policy }));
  }
});

test("document argv receives a minimal environment and a task-local temporary directory", async (t) => {
  const { cwd, home, context } = setup(t);
  let childEnv: NodeJS.ProcessEnv | undefined;
  const registry = new ToolRegistry();
  registry.register(createBashTool({ runner: {
    async run() { throw new Error("shell execution is forbidden"); },
    async runRegistered(_file, _args, options) {
      childEnv = options.env;
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 1 };
    },
  } }));
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const value = context() as ReturnType<typeof context> & { env: NodeJS.ProcessEnv };
  value.env.PYTHONPATH = join(home, "untrusted");
  value.env.NODE_OPTIONS = "--require untrusted";
  value.env.PDF_SKILL_ROOT = join(home, "fake-skill");
  const result = await runtime.execute({ id: "env", name: "bash",
    input: { command: 'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --body hi --out exports/a.pdf' } }, value);
  assert.equal(result.type, "success");
  assert.ok(childEnv);
  assert.equal(childEnv.PYTHONPATH, undefined);
  assert.equal(childEnv.NODE_OPTIONS, undefined);
  assert.equal(childEnv.PDF_SKILL_ROOT, undefined);
  assert.equal(childEnv.TMPDIR, join(cwd, "scratch", ".tmp"));
});

test("registered document execution passes the task boundary to the runner", async (t) => {
  const { cwd, context } = setup(t);
  let taskRoot: string | undefined;
  const tool = createBashTool({ runner: {
    async run() { throw new Error("legacy shell unavailable"); },
    async runRegistered(_file, _args, options) {
      taskRoot = options.taskRoot;
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 1 };
    },
  } });
  const result = await tool.execute({
    command: 'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --body hello --out exports/a.pdf',
  }, context() as never);
  assert.equal(result.data?.exitCode, 0);
  assert.equal(taskRoot, cwd);
});

test("registered documents receive their task-local work directory", async (t) => {
  const { cwd, context } = setup(t);
  let childEnv: NodeJS.ProcessEnv | undefined;
  const tool = createBashTool({ runner: {
    async run() { throw new Error("legacy shell unavailable"); },
    async runRegistered(_file, _args, options) {
      childEnv = options.env;
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 1 };
    },
  } });
  await tool.execute({ command: 'bash "$DOCX_SKILL_ROOT/scripts/docx.sh" make --body hello --out exports/a.docx' },
    { ...context(), env: {
      ...context().env,
      PILOTDECK_WORK_DIR: join(cwd, "scratch", "work", "session", "turn"),
      PILOTDECK_WORKSPACE_DIR: cwd,
    } } as never);
  assert.equal(childEnv?.PILOTDECK_WORK_DIR, join(cwd, "scratch", "work", "session", "turn"));
  assert.equal(childEnv?.PILOTDECK_WORKSPACE_DIR, cwd);
});

test("registered Skill JSON output becomes structured task artifacts", async (t) => {
  const { cwd, context } = setup(t);
  const finalPath = join(cwd, "exports", "report.pdf");
  const intermediatePath = join(cwd, "scratch", "audit.json");
  writeFileSync(finalPath, "pdf");
  writeFileSync(intermediatePath, "{}");
  const tool = createBashTool({
    runner: {
      async run() { throw new Error("legacy shell unavailable"); },
      async runRegistered() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            status: "ok",
            output: finalPath,
            report: intermediatePath,
            input: join(cwd, "inbox", "record.txt"),
            path: join(cwd, "inbox", "record.txt"),
          }),
          stderr: "",
          timedOut: false,
          durationMs: 1,
        };
      },
    },
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute({
    id: "artifact-json",
    name: "bash",
    input: { command: 'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --body hello --out exports/report.pdf' },
  }, context());
  assert.equal(result.type, "success");
  if (result.type === "success") {
    assert.deepEqual(result.artifacts, [
      { path: "exports/report.pdf", role: "final" },
      { path: "scratch/audit.json", role: "intermediate" },
    ]);
  }
});

test("registered Skill output exposes task-relative paths to the Agent", async (t) => {
  const { cwd, context } = setup(t);
  const finalPath = join(cwd, "exports", "report.docx");
  const previewPath = join(cwd, "scratch", "work", "session", "turn", "docx", "make", "render", "page-1.png");
  writeFileSync(finalPath, "docx");
  mkdirSync(join(previewPath, ".."), { recursive: true });
  writeFileSync(previewPath, "png");
  const tool = createBashTool({
    runner: {
      async run() { throw new Error("legacy shell unavailable"); },
      async runRegistered() {
        return {
          exitCode: 0,
          stdout: JSON.stringify({ status: "ok", output: finalPath, preview: [previewPath] }),
          stderr: "",
          timedOut: false,
          durationMs: 1,
        };
      },
    },
  });
  const registry = new ToolRegistry();
  registry.register(tool);
  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute({
    id: "relative-output",
    name: "bash",
    input: { command: 'bash "$DOCX_SKILL_ROOT/scripts/docx.sh" make --body hello --out exports/report.docx' },
  }, {
    ...context(),
    env: {
      ...context().env,
      PILOTDECK_WORK_DIR: join(cwd, "scratch", "work", "session", "turn"),
    },
  } as never);
  assert.equal(result.type, "success");
  if (result.type === "success") {
    assert.ok(result.content[0]?.type === "text");
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    assert.match(text, /"output":\s*"exports\/report\.docx"/u);
    assert.match(text, /page-1\.png/u);
    assert.doesNotMatch(text, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("a symlinked scratch temporary path cannot redirect document writes", async (t) => {
  const { cwd, home, context, runtime, launched } = setup(t);
  symlinkSync(home, join(cwd, "scratch", ".tmp"));
  const result = await runtime.execute({ id: "symlink-temp", name: "bash",
    input: { command: 'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --body hi --out exports/a.pdf' } }, context());
  assert.equal(result.type, "error");
  assert.equal(launched(), 0);
});

test("bundled diagram command creates an artifact using the real argv runner", {
  skip: process.platform !== "darwin" && "requires the local macOS sandbox for real execution",
}, async (t) => {
  const { cwd, context } = setup(t);
  setCommandSandbox(new SandboxExecSandbox({ appRoot: resolveAppRoot(), nodeBinDir: dirname(process.execPath) }));
  t.after(() => setCommandSandbox(null));
  const registry = new ToolRegistry();
  registry.register(createBashTool({ runner: new NodeShellCommandRunner() }));
  const result = await new ToolRuntime(registry, new PermissionRuntime()).execute({
    id: "diagram", name: "bash",
    input: { command: 'bash "$DIAGRAM_SKILL_ROOT/scripts/diagram.sh" make --body "A -> B" --out exports/flow.svg' },
  }, context());
  assert.equal(result.type, "success", result.type === "error" ? result.error.message : "");
  assert.match(readFileSync(join(cwd, "exports", "flow.svg"), "utf8"), /<svg/u);
});
