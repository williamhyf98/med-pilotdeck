import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { spawn, SpawnOptions } from "node:child_process";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTaskProcess,
  assertScratchWithinLimit,
  DEFAULT_RESOURCE_LIMITS,
  measureScratchBytes,
  resetTaskProcessLimitsForTests,
  resolveResourceLimits,
} from "../../src/security/policy/resourceLimits.js";
import { NodeShellCommandRunner } from "../../src/tool/builtin/bash/commandRunner.js";
import { createBashTool } from "../../src/tool/builtin/bash.js";

test("resource limits are centralized with conservative defaults", () => {
  assert.equal(DEFAULT_RESOURCE_LIMITS.maxForegroundTimeoutMs, 600_000);
  assert.equal(DEFAULT_RESOURCE_LIMITS.maxToolOutputBytes, 200_000);
  assert.equal(DEFAULT_RESOURCE_LIMITS.maxChildProcesses, 1);
  assert.equal(resolveResourceLimits({ maxScratchBytes: 123 }).maxScratchBytes, 123);
  assert.throws(() => resolveResourceLimits({ maxChildProcesses: 0 }), /positive safe integer/u);
});

test("scratch accounting is recursive and does not follow symlinks", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-resource-scratch-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scratch", "nested"), { recursive: true });
  writeFileSync(join(root, "scratch", "a.txt"), "1234");
  writeFileSync(join(root, "scratch", "nested", "b.txt"), "56789");
  symlinkSync(tmpdir(), join(root, "scratch", "outside"));

  assert.equal(measureScratchBytes(root), 9);
  assert.equal(assertScratchWithinLimit(root, resolveResourceLimits({ maxScratchBytes: 9 })), 9);
  assert.throws(
    () => assertScratchWithinLimit(root, resolveResourceLimits({ maxScratchBytes: 8 })),
    /exceeds the limit/u,
  );
});

test("task process slots reject concurrent registered execution and release safely", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-resource-process-"));
  t.after(() => {
    resetTaskProcessLimitsForTests();
    rmSync(root, { recursive: true, force: true });
  });
  const limits = resolveResourceLimits({ maxChildProcesses: 1 });
  const release = acquireTaskProcess(root, limits);
  assert.throws(() => acquireTaskProcess(root, limits), /active registered child process/u);
  release();
  assert.doesNotThrow(() => acquireTaskProcess(root, limits)());
});

test("command runner stops accumulating output at the shared output limit", async () => {
  const spawnFake = ((file: string, second?: unknown, third?: unknown) => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 987654;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from("123456789"));
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof spawn;

  const result = await new NodeShellCommandRunner(spawnFake).run("ignored", {
    cwd: process.cwd(),
    env: {},
    timeoutMs: 5_000,
    maxOutputBytes: 8,
  });

  assert.equal(result.outputLimitExceeded, "stdout");
  assert.equal(Buffer.byteLength(result.stdout, "utf8"), 8);
});

function taskContext(cwd: string) {
  return {
    sessionId: "resource-session",
    turnId: "resource-turn",
    cwd,
    permissionMode: "bypassPermissions" as const,
    permissionContext: {
      mode: "bypassPermissions" as const,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    env: { PILOT_HOME: cwd },
  };
}

test("registered Bash enforces scratch quota and task concurrency", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-resource-bash-"));
  const cwd = join(root, "task");
  mkdirSync(join(cwd, "inbox"), { recursive: true });
  mkdirSync(join(cwd, "scratch"), { recursive: true });
  mkdirSync(join(cwd, "exports"), { recursive: true });
  t.after(() => {
    resetTaskProcessLimitsForTests();
    rmSync(root, { recursive: true, force: true });
  });

  let resolveFirst: (() => void) | undefined;
  let started = false;
  const tool = createBashTool({
    resourceLimits: { maxScratchBytes: 64, maxChildProcesses: 1 },
    runner: {
      async run() {
        throw new Error("legacy shell is unavailable");
      },
      async runRegistered() {
        started = true;
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
        return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 1 };
      },
    },
  });
  const input = { command: 'bash "$PDF_SKILL_ROOT/scripts/pdf.sh" make --body hi --out exports/a.pdf' };
  const first = tool.execute(input, taskContext(cwd));
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => tool.execute(input, taskContext(cwd)), /active registered child process/u);
  resolveFirst!();
  await first;

  writeFileSync(join(cwd, "scratch", "large.bin"), Buffer.alloc(65));
  await assert.rejects(() => tool.execute(input, taskContext(cwd)), /exceeds the limit/u);
});
