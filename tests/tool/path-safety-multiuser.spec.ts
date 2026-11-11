// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { resolvePilotDeckWorkspacePath } from "../../src/tool/builtin/filesystem/pathSafety.js";
import { skillPathForModel } from "../../src/tool/builtin/readSkill.js";

const MULTI_USER_ENV = { PILOTDECK_DISABLE_LOCAL_AUTH: "false" };

function context({ cwd, pilotHome, permissionMode = "bypassPermissions", multiUser = true }) {
  return {
    cwd,
    permissionMode,
    permissionContext: { additionalWorkingDirectories: [] },
    env: { PILOT_HOME: pilotHome, ...(multiUser ? MULTI_USER_ENV : {}) },
    allowedReadFiles: [],
  };
}

async function withHome(fn) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-multiuser-"));
  const pilotHome = join(root, "users", "1");
  const system = join(root, "system");
  const other = join(root, "users", "2");
  try {
    await mkdir(join(pilotHome, "workspaces", "general"), { recursive: true });
    await mkdir(system, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeFile(join(system, "auth.db"), "secret");
    await writeFile(join(other, "note.txt"), "other user");
    await fn({ root, pilotHome, system, other, workspace: join(pilotHome, "workspaces", "general") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("multi-user bypassPermissions allows paths inside the user home", async () => {
  await withHome(async ({ pilotHome, workspace }) => {
    const inside = join(workspace, "a.txt");
    const result = resolvePilotDeckWorkspacePath(inside, context({ cwd: workspace, pilotHome }), { forWrite: true });
    assert.equal(result.ok, true);
  });
});

test("multi-user bypassPermissions rejects absolute paths outside the user home", async () => {
  await withHome(async ({ pilotHome, workspace, system, other }) => {
    for (const outside of [join(system, "auth.db"), join(other, "note.txt")]) {
      const result = resolvePilotDeckWorkspacePath(outside, context({ cwd: workspace, pilotHome }), { mustExist: true });
      assert.equal(result.ok, false, `expected rejection for ${outside}`);
      assert.equal(result.error.code, "path_not_allowed");
    }
  });
});

test("multi-user rejects ../ escapes out of the user home", async () => {
  await withHome(async ({ pilotHome, workspace }) => {
    const result = resolvePilotDeckWorkspacePath("../../../2/note.txt", context({ cwd: workspace, pilotHome }), { mustExist: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "path_not_allowed");
  });
});

test("multi-user rejects a symlink under the home that points outside it", async () => {
  await withHome(async ({ pilotHome, workspace, system }) => {
    await symlink(system, join(workspace, "escape"));
    const result = resolvePilotDeckWorkspacePath(join(workspace, "escape", "auth.db"), context({ cwd: workspace, pilotHome }), { mustExist: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "path_not_allowed");
  });
});

test("multi-user rejects a dangling symlink that would make a write land outside the home", async () => {
  await withHome(async ({ pilotHome, workspace, system }) => {
    await symlink(join(system, "new.conf"), join(workspace, "dangling"));
    const result = resolvePilotDeckWorkspacePath(join(workspace, "dangling"), context({ cwd: workspace, pilotHome }), { forWrite: true });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "path_not_allowed");
  });
});

test("multi-user blocks allowOutsideWorkspace from escaping the user home in default mode", async () => {
  await withHome(async ({ pilotHome, workspace, system }) => {
    const result = resolvePilotDeckWorkspacePath(
      join(system, "auth.db"),
      context({ cwd: workspace, pilotHome, permissionMode: "default" }),
      { mustExist: true, allowOutsideWorkspace: true },
    );
    assert.equal(result.ok, false);
  });
});

test("multi-user error message does not echo the real root or the requested path", async () => {
  await withHome(async ({ pilotHome, workspace, system }) => {
    const requested = join(system, "auth.db");
    const result = resolvePilotDeckWorkspacePath(requested, context({ cwd: workspace, pilotHome }), { mustExist: true });
    assert.equal(result.ok, false);
    assert.ok(!result.error.message.includes(system));
    assert.ok(!result.error.message.includes(pilotHome));
  });
});

test("local single-user bypassPermissions keeps original semantics (no home confinement)", async () => {
  await withHome(async ({ pilotHome, workspace, system }) => {
    const result = resolvePilotDeckWorkspacePath(
      join(system, "auth.db"),
      context({ cwd: workspace, pilotHome, multiUser: false }),
      { mustExist: true },
    );
    assert.equal(result.ok, true);
  });
});

test("read_skill path is shown relative to the skills root, never absolute", () => {
  assert.equal(
    skillPathForModel("/Users/x/.pilotdeck/users/1/skills/med-foo/SKILL.md", "med-foo"),
    "med-foo/SKILL.md",
  );
  assert.equal(
    skillPathForModel("/opt/app/plugins/med-tools/skills/med-bar/SKILL.md", "med-bar"),
    "med-bar/SKILL.md",
  );
  assert.equal(skillPathForModel("/abs/no/marker/SKILL.md", "med-baz"), "med-baz/SKILL.md");
  assert.equal(skillPathForModel("relative/SKILL.md", "x"), "relative/SKILL.md");
});

// npm test runs from the repository root (same convention as tests/tool/diagram-skill.spec.ts).
const REPO_ROOT = resolve(process.cwd());

test("multi-user allows reading shared skills and plugins trees (read-only whitelist)", async () => {
  await withHome(async ({ pilotHome, workspace }) => {
    for (const shared of [join(REPO_ROOT, "skills", "pdf", "SKILL.md"), join(REPO_ROOT, "skills", "pdf", "references")]) {
      const result = resolvePilotDeckWorkspacePath(shared, context({ cwd: workspace, pilotHome }), { mustExist: true });
      assert.equal(result.ok, true, `expected read allowed for ${shared}`);
    }
    const plugin = join(REPO_ROOT, "plugins", "med-tools", "plugin.json");
    const pluginResult = resolvePilotDeckWorkspacePath(plugin, context({ cwd: workspace, pilotHome }), { mustExist: true });
    assert.equal(pluginResult.ok, true);
  });
});

test("multi-user shared-tree whitelist is read-only", async () => {
  await withHome(async ({ pilotHome, workspace }) => {
    const result = resolvePilotDeckWorkspacePath(
      join(REPO_ROOT, "skills", "pdf", "SKILL.md"),
      context({ cwd: workspace, pilotHome }),
      { forWrite: true },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "path_not_allowed");
  });
});

test("multi-user whitelist does not open the rest of the app root or ../ escapes out of skills/", async () => {
  await withHome(async ({ pilotHome, workspace }) => {
    for (const outside of [join(REPO_ROOT, "package.json"), join(REPO_ROOT, "skills", "..", "src", "cli", "pilotdeck.ts")]) {
      const result = resolvePilotDeckWorkspacePath(outside, context({ cwd: workspace, pilotHome }), { mustExist: true });
      assert.equal(result.ok, false, `expected rejection for ${outside}`);
    }
  });
});

test("skill references are readable without a prompt (default permission mode)", async () => {
  await withHome(async ({ pilotHome, workspace }) => {
    const ctx = context({ cwd: workspace, pilotHome, permissionMode: "default" });

    // 绝对路径：<appRoot>/skills/**
    const absolute = resolvePilotDeckWorkspacePath(
      join(REPO_ROOT, "skills", "docx", "references", "specifications.md"),
      ctx,
      { mustExist: true },
    );
    assert.equal(absolute.ok, true);
    assert.equal(absolute.root, join(REPO_ROOT, "skills"));

    // read_skill 返回的是技能根相对路径（如 "docx/SKILL.md"），模型会照着写
    const relative = resolvePilotDeckWorkspacePath("docx/references/specifications.md", ctx, { mustExist: true });
    assert.equal(relative.ok, true);
    assert.equal(relative.absolutePath, join(REPO_ROOT, "skills", "docx", "references", "specifications.md"));

    // 同一套规则对单机（非多用户）模式成立：开发者本机不弹窗
    const single = resolvePilotDeckWorkspacePath(
      "docx/references/specifications.md",
      context({ cwd: workspace, pilotHome, permissionMode: "default", multiUser: false }),
      { mustExist: true },
    );
    assert.equal(single.ok, true);
  });
});

test("skill reference resolution stays read-only and inside the skill directory", async () => {
  await withHome(async ({ pilotHome, workspace }) => {
    const ctx = context({ cwd: workspace, pilotHome, permissionMode: "default" });

    // 写入共享技能树仍然拒绝
    const write = resolvePilotDeckWorkspacePath(
      join(REPO_ROOT, "skills", "docx", "SKILL.md"),
      ctx,
      { forWrite: true },
    );
    assert.equal(write.ok, false);

    // 用 .. 跳出技能目录不成立（回落到工作区相对解析后不存在）
    for (const escape of [
      "docx/../src/cli/pilotdeck.ts",
      "docx/references/../../../package.json",
    ]) {
      const result = resolvePilotDeckWorkspacePath(escape, ctx, { mustExist: true });
      assert.equal(result.ok, false, `expected rejection for ${escape}`);
    }

    // 不存在的工作区同名路径不会被"猜"成技能文件
    const missing = resolvePilotDeckWorkspacePath("no-such-skill/references/x.md", ctx, { mustExist: true });
    assert.equal(missing.ok, false);
  });
});
