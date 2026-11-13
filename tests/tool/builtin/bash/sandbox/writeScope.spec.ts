import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  canonicalPath,
  describeWriteScope,
  resolveWriteRoots,
} from "../../../../../src/tool/builtin/bash/sandbox/writeScope.js";
import { BwrapSandbox } from "../../../../../src/tool/builtin/bash/sandbox/bwrap.js";
import {
  SandboxExecSandbox,
  buildSandboxProfile,
} from "../../../../../src/tool/builtin/bash/sandbox/sandboxExec.js";

function withHome(fn: (home: string, workspace: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "pd-scope-"));
  const workspace = join(home, "workspaces", "general_med-demo");
  mkdirSync(workspace, { recursive: true });
  try {
    fn(home, workspace);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const pairs = (args: string[]): string[][] => {
  const result: string[][] = [];
  for (let i = 0; i < args.length - 1; i += 1) result.push([args[i]!, args[i + 1]!]);
  return result;
};

test("narrowWrites=false：整个 home 可写，writeRoots 被忽略（兼容旧行为）", () => {
  withHome((home, workspace) => {
    assert.deepEqual(
      resolveWriteRoots({ userHome: home, writeRoots: [workspace], narrowWrites: false }),
      [resolvePath(home)],
    );
    assert.equal(describeWriteScope(false), "home");
  });
});

test("narrowWrites=true：工作区 + .cache + .tmp", () => {
  withHome((home, workspace) => {
    const roots = resolveWriteRoots({ userHome: home, writeRoots: [workspace], narrowWrites: true });
    for (const expected of [
      canonicalPath(workspace),
      join(canonicalPath(home), ".cache"),
      join(canonicalPath(home), ".tmp"),
    ]) {
      assert.ok(roots.includes(expected), `缺少 ${expected}`);
    }
    // 每个逻辑根最多两种拼写（原始 + realpath），不允许把 home 本身放行
    assert.ok(roots.length <= 6);
    assert.ok(!roots.includes(canonicalPath(home)), "home 本身不能出现在可写根里");
    assert.ok(!roots.includes(resolvePath(home)), "home 本身不能出现在可写根里");
    assert.equal(describeWriteScope(true), "narrow");
  });
});

test("narrowWrites=true：丢弃 home 之外、相对路径与 home 本身", () => {
  withHome((home, workspace) => {
    const roots = resolveWriteRoots({
      userHome: home,
      writeRoots: ["/etc", "relative/dir", home, `${workspace}/../..`, workspace],
      narrowWrites: true,
    });
    assert.ok(roots.includes(canonicalPath(workspace)));
    assert.ok(!roots.some((root) => root === "/etc" || root.endsWith("/etc")));
    assert.ok(!roots.some((root) => root.startsWith(`${home}/..`)));
  });
});

test("narrowWrites=true：没有 writeRoots 时只剩 .cache 与 .tmp", () => {
  withHome((home) => {
    const roots = resolveWriteRoots({ userHome: home, narrowWrites: true });
    assert.ok(roots.includes(join(canonicalPath(home), ".cache")));
    assert.ok(roots.includes(join(canonicalPath(home), ".tmp")));
    assert.ok(roots.every((root) => root.startsWith(canonicalPath(home)) || root.startsWith(resolvePath(home))));
  });
});

test("bwrap：默认档位仍是 --bind home home（argv 不变）", () => {
  withHome((home, workspace) => {
    const sandbox = new BwrapSandbox({
      appRoot: "/app",
      nodeBinDir: "/opt/node/bin",
      network: true,
      extraBinds: [],
    });
    const { args } = sandbox.wrap("echo hi", {
      cwd: workspace,
      userHome: home,
      env: {},
      writeRoots: [workspace],
    });
    assert.ok(pairs(args).some(([a, b]) => a === "--bind" && b === home));
    assert.ok(!args.includes("--ro-bind") || !pairs(args).some(([a, b]) => a === "--ro-bind" && b === home));
    assert.deepEqual(
      sandbox.grants(home, [workspace]).writable,
      [...new Set([resolvePath(home), canonicalPath(home)])],
    );
  });
});

test("bwrap：narrowWrites=true 时 home 只读、只挂载工作区与缓存目录", () => {
  withHome((home, workspace) => {
    const sandbox = new BwrapSandbox({
      appRoot: "/app",
      nodeBinDir: "/opt/node/bin",
      network: true,
      extraBinds: [],
      narrowWrites: true,
    });
    const { args } = sandbox.wrap("echo hi", {
      cwd: workspace,
      userHome: home,
      env: {},
      writeRoots: [workspace],
    });
    const all = pairs(args);
    assert.ok(all.some(([a, b]) => a === "--ro-bind" && b === home), "home 必须是只读挂载");
    assert.ok(!all.some(([a, b]) => a === "--bind" && b === home), "home 不能整体读写挂载");

    const homeCanon = canonicalPath(home);
    for (const root of [
      canonicalPath(workspace),
      join(homeCanon, ".cache"),
      join(homeCanon, ".tmp"),
    ]) {
      assert.ok(
        all.some(([a, b]) => a === "--bind" && b === root),
        `缺少可写挂载 ${root}`,
      );
    }
    // 收窄模式需要 .cache 真实存在，否则 bwrap 会报 ENOENT
    assert.ok(existsSync(join(home, ".cache")));
    for (const expected of [
      canonicalPath(workspace),
      join(homeCanon, ".cache"),
      join(homeCanon, ".tmp"),
    ]) {
      assert.ok(sandbox.grants(home, [workspace]).writable.includes(expected), `缺少授权 ${expected}`);
    }
  });
});

test("sandbox-exec：默认档位 profile 里写规则覆盖整个 home", () => {
  const config = { appRoot: "/app", nodeBinDir: "/usr/bin" };
  const profile = buildSandboxProfile(config, "/data/users/1");
  const writeLine = profile.split("\n").find((line) => line.includes('(literal "/dev/null")'));
  assert.ok(writeLine);
  assert.ok(writeLine.includes('(subpath "/data/users/1")'));
  // 读规则始终覆盖 home（与收窄档同一口径，避免"能写才可读"的隐式依赖）
  const readLine = profile.split("\n").find((line) => line.includes("(allow file-read*"));
  assert.ok(readLine?.includes('(subpath "/data/users/1")'));
});

test("sandbox-exec：narrowWrites=true 时写规则不再覆盖整个 home", () => {
  withHome((home, workspace) => {
    const narrow = new SandboxExecSandbox({
      appRoot: "/app",
      nodeBinDir: "/usr/bin",
      narrowWrites: true,
    });
    const { args } = narrow.wrap("echo hi", {
      cwd: workspace,
      userHome: home,
      env: {},
      writeRoots: [workspace],
    });
    const profile = args[1] as string;
    const writeLine = profile.split("\n").find((line) => line.includes('(literal "/dev/null")'));
    assert.ok(writeLine);
    assert.ok(!writeLine.includes(`(subpath "${home}")`), "不能再把整个 home 放进写规则");
    assert.ok(writeLine.includes(`(subpath "${canonicalPath(workspace)}")`));
    assert.ok(writeLine.includes(`(subpath "${join(canonicalPath(home), ".cache")}")`));
    assert.ok(writeLine.includes(`(subpath "${join(canonicalPath(home), ".tmp")}")`));
    // 读规则必须显式覆盖整个 home：兼容档位是写规则 `file*` 顺带给的读权限，
    // 收窄后写规则里没有 home 了，必须单独放行，否则 `cat ~/memory/x` 直接 EPERM
    // （2026-11-12 macOS 实测）。
    const readLine = profile.split("\n").find((line) => line.includes("(allow file-read*"));
    assert.ok(readLine, "profile 里必须有读规则");
    assert.ok(readLine.includes(`(subpath "${home}")`), "读规则必须覆盖整个 home");
    assert.ok(
      narrow.grants(home, [workspace]).readOnly.includes(resolvePath(home)),
      "grants().readOnly 必须包含 home",
    );
    assert.ok(existsSync(join(home, ".cache")));
    for (const expected of [
      canonicalPath(workspace),
      join(canonicalPath(home), ".cache"),
      join(canonicalPath(home), ".tmp"),
    ]) {
      assert.ok(narrow.grants(home, [workspace]).writable.includes(expected), `缺少授权 ${expected}`);
    }
  });
});
