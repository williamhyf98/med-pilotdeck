// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  GENERAL_WORKSPACE_ID,
  ensureWorkspaceLayout,
  isGeneralProjectKey,
  resolveAgentCwd,
  resolveGatewayProjectKey,
  resolveInboxBatchDir,
  resolveInboxDerivedDir,
  resolveProjectChatDir,
  createProjectId,
  getPilotProjectChatDir,
  resolveWorkspaceDataRoot,
  resolveWorkspaceDirectoryForProjectName,
  resolveWorkspaceId,
  resolveAssociatedProjectPath,
} from "../../src/pilot/paths.js";

test("relative project markers remain valid after moving the data directory", async () => {
  const { mkdir, writeFile, rename } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "portable-project-"));
  try {
    const oldHome = join(root, "before");
    const newHome = join(root, "after");
    const id = "trauma_med-portable";
    await mkdir(join(oldHome, "projects/trauma_med", id), { recursive: true });
    await mkdir(join(oldHome, "workspaces/trauma_med", id), { recursive: true });
    await writeFile(join(oldHome, "projects/trauma_med", id, ".cwd"), `workspaces/trauma_med/${id}`);
    await rename(oldHome, newHome);
    assert.equal(resolveAssociatedProjectPath(id, newHome), join(newHome, "workspaces/trauma_med", id));
    const { listWebProjects } = await import("../../src/web/server/listProjects.js");
    const result = await listWebProjects({ pilotHome: newHome });
    assert.ok(result.projects.some(p => p.fullPath === join(newHome, "workspaces/trauma_med", id)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("migrated workspace paths retain their project identity without relying on old cwd markers", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-migrated-"));
  const { mkdir, writeFile } = await import("node:fs/promises");
  try {
    for (const [type, id] of [["trauma_med", "trauma_med-demo"], ["general_med", "general_med-demo"]]) {
      const workspace = join(pilotHome, "workspaces", type, id);
      const project = join(pilotHome, "projects", type, id);
      await mkdir(workspace, { recursive: true });
      await mkdir(project, { recursive: true });
      await writeFile(join(project, ".cwd"), `/old-machine/workspaces/${type}/${id}`);
      assert.equal(resolveWorkspaceId(workspace, pilotHome), id);
      assert.equal(resolveAgentCwd(workspace, pilotHome), workspace);
    }
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("general chat resolves to workspaces/general", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-ws-paths-"));
  try {
    const workspaceRoot = resolveWorkspaceDataRoot(GENERAL_WORKSPACE_ID, pilotHome);
    assert.equal(resolveWorkspaceId(pilotHome, pilotHome), GENERAL_WORKSPACE_ID);
    assert.equal(resolveWorkspaceId(null, pilotHome), GENERAL_WORKSPACE_ID);
    assert.equal(resolveWorkspaceId(GENERAL_WORKSPACE_ID, pilotHome), GENERAL_WORKSPACE_ID);
    assert.ok(isGeneralProjectKey(pilotHome, pilotHome));
    assert.equal(resolveAgentCwd(pilotHome, pilotHome), workspaceRoot);
    assert.equal(resolveWorkspaceDirectoryForProjectName("general", pilotHome), workspaceRoot);
    assert.equal(resolveGatewayProjectKey(pilotHome, pilotHome), pilotHome);

    ensureWorkspaceLayout(workspaceRoot);
    assert.ok(resolveInboxBatchDir(workspaceRoot, "batch-1").endsWith(join("inbox", "batch-1")));
    assert.ok(resolveInboxDerivedDir(workspaceRoot, "batch-1").endsWith(join("inbox", "batch-1", "derived")));
    const chatDir = resolveProjectChatDir(pilotHome, pilotHome);
    assert.ok(chatDir.endsWith(join("projects", createProjectId(pilotHome), "chats")));
    assert.equal(resolveProjectChatDir(workspaceRoot, pilotHome), chatDir);
    assert.equal(getPilotProjectChatDir(workspaceRoot, pilotHome), chatDir);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("linked project uses slug workspace id but keeps gateway key on repo path", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-ws-project-"));
  const repoRoot = await mkdtemp(join(tmpdir(), "pilotdeck-ws-repo-"));
  try {
    const workspaceRoot = resolveAgentCwd(repoRoot, pilotHome);
    assert.notEqual(workspaceRoot, repoRoot);
    assert.ok(workspaceRoot.includes(join("workspaces")));
    assert.equal(resolveGatewayProjectKey(repoRoot, pilotHome), repoRoot);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
    await rm(repoRoot, { recursive: true, force: true });
  }
});

test("typed system project nests under typeKey and gateway key is project id", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-ws-typed-"));
  const { writeFile, mkdir } = await import("node:fs/promises");
  const projectId = "general_med-demo1";
  try {
    const workspaceRoot = resolveWorkspaceDataRoot(projectId, pilotHome);
    assert.ok(workspaceRoot.endsWith(join("workspaces", "general_med", projectId)));
    ensureWorkspaceLayout(workspaceRoot);

    const projectDir = join(pilotHome, "projects", "general_med", projectId);
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, ".cwd"), workspaceRoot, "utf8");

    assert.equal(resolveGatewayProjectKey(workspaceRoot, pilotHome), projectId);
    assert.equal(resolveGatewayProjectKey(projectId, pilotHome), projectId);
    assert.equal(resolveAgentCwd(projectId, pilotHome), workspaceRoot);
    assert.equal(
      resolveProjectChatDir(workspaceRoot, pilotHome),
      join(pilotHome, "projects", "general_med", projectId, "chats"),
    );
    assert.equal(
      resolveProjectChatDir(projectId, pilotHome),
      join(pilotHome, "projects", "general_med", projectId, "chats"),
    );
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("general and typed projects never resolve memory under memory/workspaces", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-mem-dir-"));
  const { resolveProjectMemoryDataDir, LEGACY_GENERAL_PROJECT_ID, GENERAL_WORKSPACE_ID } =
    await import("../../src/pilot/paths.js");
  try {
    const generalMem = resolveProjectMemoryDataDir(pilotHome, pilotHome);
    assert.equal(
      generalMem,
      join(pilotHome, "memory", "general_med", LEGACY_GENERAL_PROJECT_ID),
    );
    const generalWsMem = resolveProjectMemoryDataDir(
      join(pilotHome, "workspaces", GENERAL_WORKSPACE_ID),
      pilotHome,
    );
    assert.equal(generalWsMem, generalMem);
    assert.ok(!generalMem.includes(`${join("memory", "workspaces")}`));

    const projectId = "trauma_med-demo";
    const typedMem = resolveProjectMemoryDataDir(projectId, pilotHome);
    assert.equal(typedMem, join(pilotHome, "memory", "trauma_med", projectId));
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("sanitizeSessionIdForTranscript: only path separators become dashes", async () => {
  const {
    sanitizeSessionIdForTranscript,
  } = await import("../../src/pilot/paths.js");

  // slashes become dashes, leading/trailing dashes stripped
  assert.equal(sanitizeSessionIdForTranscript("a/b/c"), "a-b-c");
  assert.equal(sanitizeSessionIdForTranscript("/leading"), "leading");
  assert.equal(sanitizeSessionIdForTranscript("trailing/"), "trailing");
  // non-separator chars (space, colon, unicode) are preserved on posix
  assert.equal(sanitizeSessionIdForTranscript("2026-09-16 case A"), "2026-09-16 case A");
  assert.equal(sanitizeSessionIdForTranscript("web:s_abc"), "web:s_abc");
  assert.equal(sanitizeSessionIdForTranscript("emoji-🩺"), "emoji-🩺");
  // empty / all-separator falls back to "session"
  assert.equal(sanitizeSessionIdForTranscript(""), "session");
  assert.equal(sanitizeSessionIdForTranscript("///"), "session");
});

test("sanitizeSessionIdForTranscript", async () => {
  const { sanitizeSessionIdForTranscript } = await import("../../src/pilot/paths.js");
  assert.equal(sanitizeSessionIdForTranscript("a/b/c"), "a-b-c");
  assert.equal(sanitizeSessionIdForTranscript(""), "session");
});

test("sanitizeSessionIdForCaseDir: all non-[A-Za-z0-9._-] become underscore; dot-only and empty are hashed", async () => {
  const { sanitizeSessionIdForCaseDir } = await import("../../src/pilot/paths.js");

  // safe chars unchanged
  assert.equal(sanitizeSessionIdForCaseDir("trauma_med-demo"), "trauma_med-demo");
  assert.equal(sanitizeSessionIdForCaseDir("a"), "a");
  // slashes, spaces, colons → underscores
  assert.equal(sanitizeSessionIdForCaseDir("a/b/c"), "a_b_c");
  assert.equal(sanitizeSessionIdForCaseDir("2026-09-16 case A"), "2026-09-16_case_A");
  assert.equal(sanitizeSessionIdForCaseDir("web:s_abc"), "web_s_abc");
  // dot-escape: "." and ".." must not be returned as-is (directory traversal)
  const dotHash = sanitizeSessionIdForCaseDir(".");
  assert.ok(dotHash.length === 24 && /^[0-9a-f]+$/.test(dotHash), `"." hash should be 24 hex chars: ${dotHash}`);
  const dotDotHash = sanitizeSessionIdForCaseDir("..");
  assert.ok(dotDotHash.length === 24 && /^[0-9a-f]+$/.test(dotDotHash));
  assert.notEqual(dotHash, dotDotHash);
  // empty string → hash of ""
  const emptyHash = sanitizeSessionIdForCaseDir("");
  assert.ok(emptyHash.length === 24 && /^[0-9a-f]+$/.test(emptyHash));
});

test("sanitizeSessionIdForCaseDir produces different results from sanitizeSessionIdForTranscript for space and colon inputs", async () => {
  const { sanitizeSessionIdForTranscript, sanitizeSessionIdForCaseDir } =
    await import("../../src/pilot/paths.js");
  // This is the core regression guard: the two algorithms must not be unified.
  const id = "2026-09-16 case A";
  assert.equal(sanitizeSessionIdForTranscript(id), "2026-09-16 case A"); // space kept
  assert.equal(sanitizeSessionIdForCaseDir(id),    "2026-09-16_case_A"); // space → _
  const id2 = "web:s_3f2a1b";
  assert.equal(sanitizeSessionIdForTranscript(id2), "web:s_3f2a1b"); // colon kept
  assert.equal(sanitizeSessionIdForCaseDir(id2),    "web_s_3f2a1b"); // colon → _
});
