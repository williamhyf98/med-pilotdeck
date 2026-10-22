import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapSandbox, resolveAppRoot } from "../../../../../src/tool/builtin/bash/sandbox/bwrap.js";

const baseConfig = {
  appRoot: "/app",
  nodeBinDir: "/opt/node/bin",
  network: true,
  extraBinds: ["/opt/libreoffice"],
};

const SYSTEM_RO = ["/usr", "/lib", "/lib64", "/bin", "/sbin", "/etc/alternatives", "/etc/ssl", "/etc/resolv.conf"]
  .filter(existsSync).flatMap((path) => ["--ro-bind", path, path]);

test("bwrap wrap() produces the exact argv skeleton from spec 16.4", () => {
  const sandbox = new BwrapSandbox(baseConfig);
  const { file, args } = sandbox.wrap("echo test", {
    cwd: "/home/u1/projects",
    userHome: "/home/u1",
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", SECRET_KEY: "s3cr3t", HOME: "/root" },
  });

  assert.equal(file, "bwrap");
  assert.deepEqual(args, [
    "--clearenv",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    ...SYSTEM_RO,
    ...(["dist", "node_modules", "skills", "plugins", ".runtime/node", ".runtime/python",
      ".runtime/cache/xdg/pilotdeck-docx", ".runtime/cache/xdg/pilotdeck-pptx",
      ".runtime/cache/xdg/pilotdeck-spreadsheets"]
      .map((part) => join(baseConfig.appRoot, part)).filter(existsSync)
      .flatMap((path) => ["--ro-bind", path, path])),
    "--ro-bind", baseConfig.nodeBinDir, baseConfig.nodeBinDir,
    "--bind", "/home/u1", "/home/u1",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--die-with-parent",
    "--new-session",
    "--chdir", "/home/u1/projects",
    "--setenv", "PATH", "/usr/bin:/bin",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "HOME", "/home/u1",
    "--setenv", "TMPDIR", "/home/u1/.tmp",
    "--setenv", "PILOT_HOME", "/home/u1",
    "/bin/sh", "-c", "echo test",
  ]);
});

test("host secrets are never passed into the sandbox env", () => {
  const sandbox = new BwrapSandbox(baseConfig);
  const { args } = sandbox.wrap("env", {
    cwd: "/home/u1",
    userHome: "/home/u1",
    env: { PATH: "/usr/bin", SECRET_KEY: "s3cr3t", ANTHROPIC_API_KEY: "sk-xyz" },
  });
  assert.equal(args[0], "--clearenv");
  assert.ok(!args.includes("SECRET_KEY"));
  assert.ok(!args.includes("s3cr3t"));
  assert.ok(!args.includes("ANTHROPIC_API_KEY"));
});

test("only the user home is writable: userHome is the sole --bind", () => {
  const sandbox = new BwrapSandbox(baseConfig);
  const { args } = sandbox.wrap("true", { cwd: "/home/u1", userHome: "/home/u1", env: {} });
  const writable = args.flatMap((arg, i) => (arg === "--bind" ? [args[i + 1]] : []));
  assert.deepEqual(writable, ["/home/u1"]);
});

test("adds --unshare-net only when network is disabled", (t) => {
  const root = mkdtempSync(join(tmpdir(), "bwrap-net-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userHome = join(root, "user");
  const open = new BwrapSandbox({ ...baseConfig, network: true });
  assert.ok(!open.wrap("true", { cwd: "/tmp", userHome, env: {} }).args.includes("--unshare-net"));

  const isolated = new BwrapSandbox({ ...baseConfig, network: false, extraBinds: [] });
  const { args } = isolated.wrap("true", { cwd: "/tmp", userHome, env: {} });
  assert.ok(args.includes("--unshare-net"));
});

test("extra read-only binds are normalized, and absent paths are skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "bwrap-extra-"));
  try {
    const sandbox = new BwrapSandbox({ ...baseConfig, extraBinds: [`${root}/`, "/opt/x/../y"] });
    const userHome = join(root, "user");
    const { args } = sandbox.wrap("true", { cwd: userHome, userHome, env: {} });
    assert.ok(args.includes(root));
    assert.ok(!args.includes(`${root}/`));
    assert.ok(!args.includes("/opt/y"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tmpfs /tmp is mounted before binds so a userHome under /tmp stays visible", () => {
  const sandbox = new BwrapSandbox(baseConfig);
  const { args } = sandbox.wrap("true", { cwd: "/tmp/pd/u1", userHome: "/tmp/pd/u1", env: {} });
  const tmpfsAt = args.indexOf("--tmpfs");
  const bindAt = args.indexOf("--bind");
  assert.ok(tmpfsAt >= 0 && bindAt > tmpfsAt, "tmpfs must precede the userHome bind");
  assert.equal(args[tmpfsAt + 1], "/tmp");
});

test("command is always the final argument after /bin/sh -c", () => {
  const sandbox = new BwrapSandbox(baseConfig);
  const { args } = sandbox.wrap("ls -la 'a b'", { cwd: "/home/u1", userHome: "/home/u1", env: {} });
  assert.deepEqual(args.slice(-3), ["/bin/sh", "-c", "ls -la 'a b'"]);
});

test("resolveAppRoot finds the directory containing package.json", () => {
  const root = mkdtempSync(join(tmpdir(), "bwrap-approot-"));
  try {
    mkdirSync(join(root, "dist", "src", "sandbox"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    assert.equal(resolveAppRoot(join(root, "dist", "src", "sandbox")), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const bwrapInstalled = spawnSync("bwrap", ["--version"]).status === 0;

test("probe reports a missing bwrap binary", { skip: bwrapInstalled }, async () => {
  const result = await new BwrapSandbox(baseConfig).probe();
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /not found|cannot execute/);
});

test("probe succeeds when bwrap is installed and can run /bin/true", {
  skip: !bwrapInstalled || process.platform !== "linux",
}, async () => {
  const result = await new BwrapSandbox(baseConfig).probe();
  assert.deepEqual(result, { ok: true });
});

test("only existing app subdirectories are mounted, and no root or data directory is exposed", () => {
  const root = mkdtempSync(join(tmpdir(), "bwrap-app-"));
  try {
    for (const part of ["dist", "skills", "plugins", "node_modules", ".pilotdeck-home/users/2"]) {
      mkdirSync(join(root, part), { recursive: true });
    }
    const home = join(root, ".pilotdeck-home", "users", "2");
    const sandbox = new BwrapSandbox({ ...baseConfig, appRoot: root, extraBinds: [join(root, "missing")] });
    const { args } = sandbox.wrap("true", { cwd: home, userHome: home, env: {} });
    const grants = sandbox.grants(home);
    assert.ok(!grants.readOnly.includes(root));
    assert.ok(!grants.readOnly.includes(join(root, ".pilotdeck-home")));
    assert.ok(grants.readOnly.includes(join(root, "skills")));
    assert.ok(!args.includes(join(root, "missing")));
    assert.ok(!args.includes(join(root, ".pilotdeck-home")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
