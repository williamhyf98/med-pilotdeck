// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePilotDeckWorkspacePath } from "../../dist/src/tool/builtin/filesystem/pathSafety.js";
import { skillPathForModel } from "../../dist/src/tool/builtin/readSkill.js";

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

// NOTE: White-list tests for skills/ and plugins/ read access are verified through
// integration tests (tests/skill-e2e) rather than unit tests, as they require
// the real appRoot structure to exist.
