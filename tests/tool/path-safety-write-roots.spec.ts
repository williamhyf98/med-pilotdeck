// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  READ_ONLY_WORKSPACE_ROOTS,
  RESERVED_WORKSPACE_ENTRIES,
  isWorkspaceWriteDenied,
  resolvePilotDeckWorkspacePath,
} from "../../src/tool/builtin/filesystem/pathSafety.js";

/**
 * spec §4.2 #4 / #5：reserved 顶部点号项与 inbox 只读。
 * 这两条只作用于**写操作**，读操作与普通目录不受影响。
 */

function context({ cwd, pilotHome, permissionMode = "bypassPermissions" }) {
  return {
    cwd,
    permissionMode,
    permissionContext: { additionalWorkingDirectories: [] },
    env: { PILOT_HOME: pilotHome },
    allowedReadFiles: [],
  };
}

async function withWorkspace(fn) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-write-roots-"));
  const pilotHome = join(root, "users", "1");
  const workspace = join(pilotHome, "workspaces", "general", "ws1");
  try {
    await mkdir(join(workspace, "inbox", "batch1"), { recursive: true });
    await mkdir(join(workspace, "exports"), { recursive: true });
    await mkdir(join(workspace, "scratch", "work"), { recursive: true });
    await fn({ workspace, pilotHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const permissionMode of ["bypassPermissions", "default"]) {
  test(`[${permissionMode}] writing under inbox/ is denied`, async () => {
    await withWorkspace(async ({ workspace, pilotHome }) => {
      const ctx = context({ cwd: workspace, pilotHome, permissionMode });
      for (const input of ["inbox/x.txt", "inbox/batch1/a.csv", "inbox", "inbox/batch1/derived/out.json"]) {
        const result = resolvePilotDeckWorkspacePath(input, ctx, { forWrite: true });
        assert.equal(result.ok, false, `expected deny for ${input}`);
        assert.equal(result.error.code, "path_not_allowed");
        assert.match(result.error.message, /read-only/);
      }
    });
  });

  test(`[${permissionMode}] reading under inbox/ is still allowed`, async () => {
    await withWorkspace(async ({ workspace, pilotHome }) => {
      const ctx = context({ cwd: workspace, pilotHome, permissionMode });
      const result = resolvePilotDeckWorkspacePath("inbox/batch1/a.csv", ctx);
      assert.equal(result.ok, true);
      assert.equal(result.relativePath, join("inbox", "batch1", "a.csv"));
    });
  });

  test(`[${permissionMode}] writing to reserved top-level entries is denied`, async () => {
    await withWorkspace(async ({ workspace, pilotHome }) => {
      const ctx = context({ cwd: workspace, pilotHome, permissionMode });
      for (const input of [".trash/x.txt", ".usage.json", ".pinned", ".tmp/upload.bin"]) {
        const result = resolvePilotDeckWorkspacePath(input, ctx, { forWrite: true });
        assert.equal(result.ok, false, `expected deny for ${input}`);
        assert.equal(result.error.code, "path_not_allowed");
        assert.match(result.error.message, /reserved system path/);
      }
    });
  });
}

test("normal directories stay writable (exports / scratch / user-created)", async () => {
  await withWorkspace(async ({ workspace, pilotHome }) => {
    const ctx = context({ cwd: workspace, pilotHome });
    for (const input of [
      "exports/report.pdf",
      "scratch/work/turn1/analysis.py",
      "我的资料/会诊记录.md",
      "inbox-lite/note.txt",
      "my/inbox/deep.txt",
    ]) {
      const result = resolvePilotDeckWorkspacePath(input, ctx, { forWrite: true });
      assert.equal(result.ok, true, `expected allow for ${input}`);
    }
  });
});

test("only the top-level segment decides; nested reserved names are fine", async () => {
  assert.equal(isWorkspaceWriteDenied(".trash/a"), true);
  assert.equal(isWorkspaceWriteDenied("data/.trash/a"), false);
  assert.equal(isWorkspaceWriteDenied("data/inbox/a.csv"), false);
  assert.equal(isWorkspaceWriteDenied("."), false);
  assert.equal(isWorkspaceWriteDenied(".git/config"), true);
});

test("read-only roots and reserved entries are exported for reuse", () => {
  assert.deepEqual([...READ_ONLY_WORKSPACE_ROOTS], ["inbox"]);
  assert.deepEqual([...RESERVED_WORKSPACE_ENTRIES].sort(), [".pinned", ".tmp", ".trash", ".usage.json"]);
});
