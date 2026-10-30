// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolvePilotDeckWorkspacePath } from "../../src/tool/builtin/filesystem/pathSafety.js";

function readContext(cwd: string, pilotHome: string) {
  return {
    cwd,
    permissionMode: "default",
    permissionContext: { additionalWorkingDirectories: [] },
    env: { PILOT_HOME: pilotHome },
    allowedReadFiles: [],
  };
}

test("registered read allows legacy chat-attachment paths outside workspace cwd", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-path-safety-home-"));
  const workspace = join(pilotHome, "workspaces", "general");
  const legacyBatch = join(pilotHome, ".tmp", "chat-attachments", "batch-1");
  const legacyFile = join(legacyBatch, "scan.dcm");
  try {
    await mkdir(legacyBatch, { recursive: true });
    await writeFile(legacyFile, "dicom");
    const result = resolvePilotDeckWorkspacePath(legacyFile, readContext(workspace, pilotHome), {
      allowRegisteredReadFiles: true,
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.absolutePath, legacyFile);
    }
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("registered read allows inbox attachment paths in workspace cwd", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-path-safety-ws-"));
  const workspace = join(pilotHome, "workspaces", "general");
  const inboxFile = join(workspace, "inbox", "batch-2", "report.pdf");
  try {
    await mkdir(join(workspace, "inbox", "batch-2"), { recursive: true });
    await writeFile(inboxFile, "%PDF");
    const result = resolvePilotDeckWorkspacePath(inboxFile, readContext(workspace, pilotHome), {
      allowRegisteredReadFiles: true,
    });
    assert.equal(result.ok, true);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});
