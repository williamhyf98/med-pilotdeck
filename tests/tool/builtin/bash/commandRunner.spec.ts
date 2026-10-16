import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { spawn, SpawnOptions } from "node:child_process";
import {
  NodeShellCommandRunner,
  getCommandSandbox,
  initializeSandbox,
  setCommandSandbox,
} from "../../../../src/tool/builtin/bash/commandRunner.js";
import type { CommandSandbox } from "../../../../src/tool/builtin/bash/sandbox/index.js";
import type { MultiUserConfig } from "../../../../src/pilot/config/parseMultiUserConfig.js";

type SpawnCall = { file: string; args: string[]; options: SpawnOptions };

/** 记录 spawn 调用的假实现：立即输出 stdout 并以 0 退出。 */
function recordingSpawn(calls: SpawnCall[], stdout = "hello\n") {
  return ((file: string, second?: unknown, third?: unknown) => {
    const args = Array.isArray(second) ? (second as string[]) : [];
    const options = (Array.isArray(second) ? third : second) as SpawnOptions;
    calls.push({ file, args, options });
    const child = new EventEmitter() as EventEmitter & { pid: number; stdout: EventEmitter; stderr: EventEmitter };
    child.pid = 4321;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      child.stdout.emit("data", Buffer.from(stdout));
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof spawn;
}

function fakeSandbox(kind: CommandSandbox["kind"] = "bwrap"): CommandSandbox & { wrapCalls: unknown[] } {
  const wrapCalls: unknown[] = [];
  return {
    kind,
    wrapCalls,
    wrap(command, options) {
      wrapCalls.push({ command, options });
      return { file: "/fake/sandbox-launcher", args: ["--wrapped", command] };
    },
    async probe() {
      return { ok: true };
    },
  };
}

afterEach(() => setCommandSandbox(null));

test("without a sandbox the command is handed to the shell as before", async () => {
  const calls: SpawnCall[] = [];
  const runner = new NodeShellCommandRunner(recordingSpawn(calls));
  const result = await runner.run("echo hi", { cwd: "/work", env: { PATH: "/usr/bin" }, timeoutMs: 5_000 });

  assert.equal(result.stdout, "hello\n");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "echo hi");
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].options.shell, true);
  assert.equal(calls[0].options.cwd, "/work");
});

test("with a sandbox, wrap() receives cwd, userHome, env and its argv is spawned without a shell", async () => {
  const calls: SpawnCall[] = [];
  const sandbox = fakeSandbox("bwrap");
  setCommandSandbox(sandbox);
  const env = { PATH: "/usr/bin", PILOT_HOME: "/root/.pilotdeck" };
  const runner = new NodeShellCommandRunner(recordingSpawn(calls));

  await runner.run("ls", { cwd: "/root/.pilotdeck/users/u1/projects", env, userHome: "/root/.pilotdeck/users/u1", timeoutMs: 5_000 });

  assert.deepEqual(sandbox.wrapCalls, [{
    command: "ls",
    options: { cwd: "/root/.pilotdeck/users/u1/projects", userHome: "/root/.pilotdeck/users/u1", env },
  }]);
  assert.equal(calls[0].file, "/fake/sandbox-launcher");
  assert.deepEqual(calls[0].args, ["--wrapped", "ls"]);
  assert.equal(calls[0].options.shell, false);
});

test("userHome defaults to PILOT_HOME from the command env", async () => {
  const calls: SpawnCall[] = [];
  const sandbox = fakeSandbox("none");
  setCommandSandbox(sandbox);
  const runner = new NodeShellCommandRunner(recordingSpawn(calls));

  await runner.run("pwd", { cwd: "/home/u", env: { PILOT_HOME: "/srv/pilot/users/u1" }, timeoutMs: 5_000 });

  assert.equal((sandbox.wrapCalls[0] as { options: { userHome: string } }).options.userHome, "/srv/pilot/users/u1");
});

test("bwrap children are not detached: --new-session would fail with EPERM under a process-group leader", async () => {
  const calls: SpawnCall[] = [];
  setCommandSandbox(fakeSandbox("bwrap"));
  await new NodeShellCommandRunner(recordingSpawn(calls)).run("true", { cwd: "/w", env: {}, timeoutMs: 5_000 });
  assert.equal(calls[0].options.detached, false);
});

test("none keeps a detached process group, matching the original runner", async () => {
  const calls: SpawnCall[] = [];
  setCommandSandbox(fakeSandbox("none"));
  await new NodeShellCommandRunner(recordingSpawn(calls)).run("true", { cwd: "/w", env: {}, timeoutMs: 5_000 });
  assert.equal(calls[0].options.detached, process.platform !== "win32");
});

test("initializeSandbox rejects multi-user mode when only none is available", async () => {
  await assert.rejects(
    initializeSandbox(
      { retention: {} as MultiUserConfig["retention"], sandbox: { kind: "none", allowUnsandboxed: false } } as MultiUserConfig,
      { PILOTDECK_DISABLE_LOCAL_AUTH: "0" },
    ),
    /multi-user mode requires an OS sandbox/,
  );
  assert.equal(getCommandSandbox(), null);
});

test("initializeSandbox accepts an explicit unsandboxed opt-in in multi-user mode", async () => {
  const sandbox = await initializeSandbox(
    { retention: {} as MultiUserConfig["retention"], sandbox: { kind: "none", allowUnsandboxed: true } } as MultiUserConfig,
    { PILOTDECK_DISABLE_LOCAL_AUTH: "false" },
  );
  assert.equal(sandbox.kind, "none");
  assert.equal(getCommandSandbox(), sandbox);
});
