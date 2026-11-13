// @ts-nocheck
// S4 / A6–A9 + N1–N4：在真实沙箱里验证"可写范围收窄"确实生效。
// 没有可用沙箱（非 macOS/Linux、缺 sandbox-exec/bwrap）时整组跳过，不影响 CI。
import test, { after, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  NodeShellCommandRunner,
  setCommandSandbox,
} from "../../../../../src/tool/builtin/bash/commandRunner.js";
import { BwrapSandbox } from "../../../../../src/tool/builtin/bash/sandbox/bwrap.js";
import { SandboxExecSandbox, SANDBOX_EXEC_BIN } from "../../../../../src/tool/builtin/bash/sandbox/sandboxExec.js";

/** 从测试文件向上找仓库根（含 package.json + skills/）。 */
function findAppRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "skills"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

const APP_ROOT = findAppRoot();

function realSandboxKind(): "sandbox-exec" | "bwrap" | undefined {
  if (process.platform === "darwin") {
    const probe = spawnSync(SANDBOX_EXEC_BIN, ["-p", "(version 1) (allow default)", "/usr/bin/true"]);
    return probe.status === 0 ? "sandbox-exec" : undefined;
  }
  if (process.platform === "linux") {
    const probe = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
    return probe.status === 0 ? "bwrap" : undefined;
  }
  return undefined;
}

const KIND = realSandboxKind();
const skip = KIND ? false : { skip: `no usable OS sandbox on ${process.platform}` };

let root: string;
let home: string;
let workspace: string;
let sibling: string;

before(() => {
  if (!KIND) return;
  root = mkdtempSync(join(tmpdir(), "sb-writable-scope-"));
  home = join(root, "users", "7");
  workspace = join(home, "workspaces", "p1");
  sibling = join(home, "workspaces", "p2");
  for (const dir of ["memory", "logs", "projects", "skills/pdf", ".cache", ".tmp", ".trash"]) {
    mkdirSync(join(home, dir), { recursive: true });
  }
  for (const dir of ["inbox/batch1", "exports", "scratch"]) mkdirSync(join(workspace, dir), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(home, "memory", "seed.txt"), "记忆必须可读\n");
  writeFileSync(join(home, "skills", "pdf", "SKILL.md"), "# PDF\n");
  writeFileSync(join(home, "logs", "audit.jsonl"), "{}\n");

  const sandbox =
    KIND === "sandbox-exec"
      ? new SandboxExecSandbox({
          appRoot: APP_ROOT,
          nodeBinDir: dirname(process.execPath),
          network: "none",
          networkAllow: [],
          narrowWrites: true,
        })
      : new BwrapSandbox({
          appRoot: APP_ROOT,
          nodeBinDir: dirname(process.execPath),
          network: false,
          extraBinds: [],
          narrowWrites: true,
        });
  setCommandSandbox(sandbox);
});

after(() => {
  setCommandSandbox(null);
  if (root) rmSync(root, { recursive: true, force: true });
});

afterEach(() => {
  // 每个用例都从干净的工作区开始，避免上一个用例的产物影响断言
  if (!workspace) return;
  for (const dir of ["exports", "scratch"]) {
    rmSync(join(workspace, dir), { recursive: true, force: true });
    mkdirSync(join(workspace, dir), { recursive: true });
  }
});

const env = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
};

function sh(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const runner = new NodeShellCommandRunner();
  return runner.run(command, {
    cwd: workspace,
    env,
    userHome: home,
    writeRoots: [workspace],
    timeoutMs: 30_000,
  });
}

test("A6：工作区 / .cache / .tmp 可写", skip, async () => {
  for (const [label, target] of [
    ["工作区 exports", "exports/probe.txt"],
    [".cache", '"$HOME/.cache/probe.txt"'],
    [".tmp", '"$HOME/.tmp/probe.txt"'],
  ]) {
    const result = await sh(`printf x > ${target}`);
    assert.equal(result.exitCode, 0, `${label} 应当可写：${result.stderr}`);
  }
});

test("A7：memory / logs / projects / 兄弟工作区 全部不可写", skip, async () => {
  const targets = [
    '"$HOME/memory/x.txt"',
    '"$HOME/logs/x.txt"',
    '"$HOME/projects/x"',
    '"$HOME/workspaces/p2/x.txt"',
    '"$HOME/skills/x.txt"',
  ];
  for (const target of targets) {
    const result = await sh(`printf x > ${target}`);
    assert.notEqual(result.exitCode, 0, `${target} 必须被拒绝`);
  }
  assert.deepEqual(readdirSync(join(home, "memory")), ["seed.txt"], "memory 不允许留下任何新文件");
});

test("A8：工作区内软链指向 memory，写入同样被拒绝", skip, async () => {
  const result = await sh('ln -sfn "$HOME/memory" m && printf x > m/escape.txt');
  assert.notEqual(result.exitCode, 0);
  assert.ok(!existsSync(join(home, "memory", "escape.txt")));
});

test("A9：读范围不受收窄影响（memory / skills 仍可读）", skip, async () => {
  const memory = await sh('cat "$HOME/memory/seed.txt"');
  assert.equal(memory.exitCode, 0, memory.stderr);
  assert.match(memory.stdout, /记忆必须可读/);
  const skill = await sh('cat "$HOME/skills/pdf/SKILL.md"');
  assert.equal(skill.exitCode, 0, skill.stderr);
});

test("N1：rm -rf ~/memory 失败，记忆文件仍在", skip, async () => {
  const result = await sh('rm -rf "$HOME/memory"');
  assert.notEqual(result.exitCode, 0);
  assert.ok(existsSync(join(home, "memory", "seed.txt")));
});

test("N2：rm -rf 兄弟工作区失败", skip, async () => {
  const result = await sh('rm -rf "$HOME/workspaces/p2"');
  assert.notEqual(result.exitCode, 0);
  assert.ok(existsSync(sibling));
});

test("N3（已知残余风险）：工作区内 .trash 仍可被 bash 删除", skip, async () => {
  // 设计取舍见 docs/plans/sandbox-write-scope-narrowing.md §6：
  // 回收站依赖 rename 进 .trash，只读挂载会与软删除冲突，
  // 因此继续靠「软删除 + 审计 trash.purge」兜底。这条断言是把这个风险钉成显式行为。
  mkdirSync(join(workspace, ".trash"), { recursive: true });
  const result = await sh("rm -rf .trash");
  assert.equal(result.exitCode, 0);
  assert.ok(!existsSync(join(workspace, ".trash")));
});
