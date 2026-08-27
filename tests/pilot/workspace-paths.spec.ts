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
} from "../../src/pilot/paths.js";

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
