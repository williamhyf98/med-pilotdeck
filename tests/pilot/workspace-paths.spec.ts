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
