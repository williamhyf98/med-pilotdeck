import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { NoneSandbox } from "../../../../../src/tool/builtin/bash/sandbox/none.js";

const execFileAsync = promisify(execFile);

test("wrap returns /bin/sh -c with the raw command, independent of options", () => {
  const s = new NoneSandbox();
  const a = s.wrap("echo hello", { cwd: "/tmp", userHome: "/home/u", env: {} });
  const b = s.wrap("echo hello", { cwd: "/elsewhere", userHome: "/home/other", env: { FOO: "1" } });
  assert.deepEqual(a, { file: "/bin/sh", args: ["-c", "echo hello"] });
  assert.deepEqual(b, a);
});

test("wrapped argv actually runs the command and returns its stdout", async () => {
  const s = new NoneSandbox();
  const { file, args } = s.wrap("printf '%s' \"$((2 + 3))\"", { cwd: "/tmp", userHome: "/tmp", env: {} });
  const { stdout } = await execFileAsync(file, args, { cwd: "/tmp" });
  assert.equal(stdout, "5");
});

test("probe always succeeds", async () => {
  const s = new NoneSandbox();
  assert.deepEqual(await s.probe(), { ok: true });
  assert.equal(s.kind, "none");
});
