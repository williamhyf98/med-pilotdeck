import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  SandboxExecSandbox,
  buildSandboxProfile,
  runSandboxCheck,
} from "../../../../../src/tool/builtin/bash/sandbox/sandboxExec.js";
import { resolveAppRoot } from "../../../../../src/tool/builtin/bash/sandbox/bwrap.js";

const config = { appRoot: "/app", nodeBinDir: "/usr/bin" };

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sb-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("wrap() passes an inline profile that the user cannot replace", () => {
  withTempDir((tmpHome) => {
    const s = new SandboxExecSandbox(config);
    assert.equal(existsSync(join(tmpHome, ".tmp")), false, ".tmp is created lazily, not up front");
    const { file, args } = s.wrap("echo test", { cwd: tmpHome, userHome: tmpHome, env: {} });
    const profilePath = join(tmpHome, ".tmp", "sandbox.sb");
    assert.equal(s.kind, "sandbox-exec");
    assert.equal(file, "/usr/bin/sandbox-exec");
    assert.deepEqual(args, ["-p", buildSandboxProfile(config, tmpHome), "/bin/sh", "-c", "echo test"]);
    assert.ok(!existsSync(profilePath));
  });
});

test("profile content follows spec 16.5 and includes the user home, app root and node bin dir", () => {
  withTempDir((tmpHome) => {
    const profile = buildSandboxProfile(config, tmpHome);
    assert.ok(profile.includes("(version 1)"));
    assert.ok(profile.includes("(deny default)"));
    assert.ok(!profile.includes("(allow default)"), "the production profile must not allow everything");
    assert.ok(profile.includes("(allow process-exec process-fork signal)"));
    assert.ok(profile.includes("(allow sysctl-read mach-lookup)"));
    assert.ok(profile.includes("(allow network*)"));
    assert.ok(profile.includes('(allow file-read-metadata (literal "/Users")'));
    assert.ok(profile.includes(`(subpath "${tmpHome}")`));
    assert.ok(profile.includes('(subpath "/usr/bin")'));
    assert.ok(!profile.includes('(subpath "/app")'));
    assert.ok(!profile.includes('(subpath "/private/tmp")'));
  });
});

test("every literal metadata grant in the profile is reported to the startup guard", () => {
  const sandbox = new SandboxExecSandbox(config);
  const profile = buildSandboxProfile(config, "/data/users/2");
  const metadataLine = profile.split("\n").find((line) => line.startsWith("(allow file-read-metadata "));
  assert.ok(metadataLine);
  for (const literal of metadataLine.matchAll(/\(literal "([^"]+)"\)/g)) {
    assert.ok(sandbox.grants("/data/users/2").metadataOnly?.includes(literal[1]));
  }
});

test("profile grants writes only under userHome, system temp dirs and /dev/null", () => {
  withTempDir((tmpHome) => {
    const profile = buildSandboxProfile(config, tmpHome);
    const writeLine = profile.split("\n").find((line) => line.startsWith("(allow file* "));
    assert.ok(writeLine, "file* rule present");
    assert.ok(writeLine.includes('(literal "/dev/null")'));
    assert.ok(!writeLine.includes('(subpath "/app")'), "app root is not granted");
    assert.ok(!writeLine.includes('(subpath "/usr/bin")'), "node bin dir is read-only");
  });
});

test("registered task profile reads inbox and writes only scratch/exports", () => {
  withTempDir((home) => {
    const task = join(home, "workspaces", "current");
    for (const folder of ["inbox", "scratch", "exports"]) mkdirSync(join(task, folder), { recursive: true });
    const profile = buildSandboxProfile(config, home, task);
    const writeLine = profile.split("\n").find((line) => line.startsWith("(allow file* "));
    assert.ok(writeLine);
    assert.ok(profile.includes(`(subpath "${join(task, "inbox")}")`));
    assert.ok(writeLine.includes(`(subpath "${join(task, "scratch")}")`));
    assert.ok(writeLine.includes(`(subpath "${join(task, "exports")}")`));
    assert.ok(!writeLine.includes(`(subpath "${home}")`));
    assert.ok(!writeLine.includes(`(subpath "${join(task, "inbox")}")`));
    const sandbox = new SandboxExecSandbox(config);
    assert.deepEqual(sandbox.grants(home, task).writable.filter((p) => p.startsWith(home)),
      [join(task, "scratch"), join(task, "exports")]);
  });
});

test("a symlinked userHome is granted in both its raw and resolved forms", () => {
  withTempDir((dir) => {
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    const profile = buildSandboxProfile(config, link);
    assert.ok(profile.includes(`(subpath "${link}")`), "raw path");
    assert.ok(profile.includes(`(subpath "${realpathSync(real)}")`), "resolved path");
  });
});

test("SBPL special characters in paths are escaped", () => {
  withTempDir((tmpHome) => {
    mkdirSync(join(tmpHome, 'skills'));
    const profile = buildSandboxProfile({ appRoot: tmpHome, nodeBinDir: '/usr/bin' }, join(tmpHome, 'users', '1'));
    assert.ok(profile.includes(`(subpath "${join(tmpHome, 'skills')}")`));
    assert.ok(!profile.includes(`(subpath "${tmpHome}")`));
  });
});

test("runSandboxCheck reports success for a zero exit", () => {
  assert.deepEqual(runSandboxCheck("/bin/sh", ["-c", "exit 0"]), { ok: true });
});

test("runSandboxCheck reports the exit code and stderr for a failing command", () => {
  const result = runSandboxCheck("/bin/sh", ["-c", "echo boom >&2; exit 3"]);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /exit 3: boom/);
});

test("runSandboxCheck reports a missing binary as a spawn error", () => {
  const result = runSandboxCheck("/nonexistent/sandbox-exec-binary", []);
  assert.equal(result.ok, false);
  assert.match((result as { reason: string }).reason, /ENOENT/);
});

test("probe succeeds on macOS and reports a reason elsewhere", async () => {
  const result = await new SandboxExecSandbox(config).probe();
  if (process.platform === "darwin") {
    assert.deepEqual(result, { ok: true });
  } else {
    assert.equal(result.ok, false);
    assert.ok((result as { reason: string }).reason.length > 0);
  }
});

test("on macOS a wrapped command runs inside userHome and cannot write outside it", {
  skip: process.platform !== "darwin" && "sandbox-exec is macOS-only",
}, () => {
  withTempDir((tmpHome) => {
    const sandbox = new SandboxExecSandbox({ appRoot: resolveAppRoot(), nodeBinDir: dirname(process.execPath) });
    const escapeTarget = join(homedir(), `sbx-escape-${process.pid}-${Date.now()}`);
    try {
      const launch = sandbox.wrap(
        `echo inside > ./ok.txt && cat ./ok.txt && echo blocked > "${escapeTarget}" 2>/dev/null; echo "escape-exit=$?"`,
        { cwd: tmpHome, userHome: tmpHome, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
      );
      const run = spawnSync(launch.file, launch.args, { cwd: tmpHome, encoding: "utf8" });
      assert.equal(run.status, 0, `sandboxed sh failed: ${run.stderr}`);
      assert.match(run.stdout, /inside/);
      assert.match(run.stdout, /escape-exit=[1-9]/);
      assert.equal(existsSync(escapeTarget), false, "write outside userHome must be denied");
      assert.equal(readFileSync(join(tmpHome, "ok.txt"), "utf8"), "inside\n");
    } finally {
      rmSync(escapeTarget, { force: true });
    }
  });
});

test("on macOS registered argv can use its task but cannot read a sibling task", {
  skip: process.platform !== "darwin" && "sandbox-exec is macOS-only",
}, () => {
  withTempDir((home) => {
    const task = join(home, "workspaces", "current");
    const other = join(home, "workspaces", "other");
    for (const root of ["inbox", "scratch", "exports"]) mkdirSync(join(task, root), { recursive: true });
    mkdirSync(other, { recursive: true });
    const input = join(task, "inbox", "input.txt");
    const secret = join(other, "secret.txt");
    const output = join(task, "scratch", "result.txt");
    writeFileSync(input, "visible\n");
    writeFileSync(secret, "hidden\n");
    const sandbox = new SandboxExecSandbox({ appRoot: resolveAppRoot(), nodeBinDir: dirname(process.execPath) });
    const launch = sandbox.wrapArgv({
      file: "/bin/sh",
      args: ["-c", 'cat "$1" > "$2"; cat "$3" 2>/dev/null || true', "task", input, output, secret],
    }, { cwd: task, taskRoot: task, userHome: home, env: {} });
    const run = spawnSync(launch.file, launch.args, { cwd: task, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(output, "utf8"), "visible\n");
    assert.ok(!run.stdout.includes("hidden"), run.stdout);
  });
});
