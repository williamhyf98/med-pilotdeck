import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolvePilotDeckWorkspacePath } from "../../src/tool/builtin/filesystem/pathSafety.js";
import { checkFilesystemWritePermission } from "../../src/tool/builtin/filesystem/writePermissions.js";
import { createGlobTool } from "../../src/tool/builtin/glob.js";
import { createGrepTool } from "../../src/tool/builtin/grep.js";
import { createReadFileTool } from "../../src/tool/builtin/readFile.js";
import { createPlanFileManager } from "../../src/tool/builtin/planFile.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";

test("task file paths never reveal workspace metadata or sibling tasks in any permission mode", (t) => {
  const home = mkdtempSync(join(tmpdir(), "task-path-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const task = join(home, "workspaces", "current");
  const other = join(home, "workspaces", "other");
  for (const dir of [task, other]) {
    for (const root of ["inbox", "scratch", "exports"]) mkdirSync(join(dir, root), { recursive: true });
  }
  writeFileSync(join(other, "inbox", "secret.txt"), "private");
  writeFileSync(join(task, "inbox", "uploaded.txt"), "input");
  writeFileSync(join(task, "metadata.txt"), "hidden");
  symlinkSync(other, join(task, "scratch", "escape"));
  for (const mode of ["default", "bypassPermissions"] as const) {
    const context = {
      cwd: task, taskRoot: task, permissionMode: mode,
      permissionContext: { mode, cwd: task, additionalWorkingDirectories: [other] },
      env: { PILOT_HOME: home, PILOTDECK_DISABLE_LOCAL_AUTH: "false" },
    };
    for (const value of [".", "metadata.txt", "../other/inbox/secret.txt", "scratch/escape/inbox/secret.txt",
      join(task, "scratch", "note.txt"), join(other, "inbox", "secret.txt")]) {
      const result = resolvePilotDeckWorkspacePath(value, context as never, { mustExist: false, allowOutsideWorkspace: true });
      assert.equal(result.ok, false, `${mode}: ${value}`);
    }
    for (const value of ["inbox/uploaded.txt", "scratch/note.txt", "exports/result.txt"]) {
      assert.equal(resolvePilotDeckWorkspacePath(value, context as never).ok, true, value);
    }
    for (const value of ["inbox/new.txt", "metadata.txt", "../other/exports/out.txt", "scratch/escape/new.txt"]) {
      const decision = checkFilesystemWritePermission("write_file", value, context as never);
      assert.equal(decision.type, "deny", `${mode}: ${value}`);
    }
    assert.equal(resolvePilotDeckWorkspacePath("scratch/note.txt", context as never, { forWrite: true }).ok, true);
    assert.equal(resolvePilotDeckWorkspacePath("exports/result.txt", context as never, { forWrite: true }).ok, true);
  }
});

test("registered attachment read is exact, read-only and cannot be widened by bypass mode", (t) => {
  const home = mkdtempSync(join(tmpdir(), "task-attachment-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const task = join(home, "workspaces", "current");
  const attachment = join(home, "im-attachments", "scan.txt");
  mkdirSync(join(task, "inbox"), { recursive: true });
  mkdirSync(join(home, "im-attachments"), { recursive: true });
  writeFileSync(attachment, "diagnosis");
  writeFileSync(join(home, "im-attachments", "other.txt"), "other");
  const context = {
    cwd: task, taskRoot: task, permissionMode: "bypassPermissions",
    permissionContext: { mode: "bypassPermissions", cwd: task, additionalWorkingDirectories: [] },
    env: { PILOT_HOME: home, PILOTDECK_DISABLE_LOCAL_AUTH: "false" },
    allowedReadFiles: [attachment],
  };
  assert.equal(resolvePilotDeckWorkspacePath(attachment, context as never, { allowRegisteredReadFiles: true }).ok, true);
  assert.equal(resolvePilotDeckWorkspacePath(join(home, "im-attachments", "other.txt"), context as never,
    { allowRegisteredReadFiles: true }).ok, false);
  assert.equal(resolvePilotDeckWorkspacePath(attachment, context as never, { forWrite: true,
    allowOutsideWorkspace: true }).ok, false);
});

test("glob and grep cannot search outside the three task directories", async (t) => {
  const task = mkdtempSync(join(tmpdir(), "task-search-"));
  t.after(() => rmSync(task, { recursive: true, force: true }));
  for (const root of ["inbox", "scratch", "exports"]) mkdirSync(join(task, root));
  writeFileSync(join(task, "private.txt"), "should not find");
  writeFileSync(join(task, "inbox", "visible.txt"), "should find");
  symlinkSync(join(task, "private.txt"), join(task, "inbox", "linked.txt"));
  symlinkSync(task, join(task, "scratch", "linked-dir"));
  const context = {
    cwd: task, taskRoot: task, permissionMode: "bypassPermissions",
    permissionContext: { mode: "bypassPermissions", cwd: task, additionalWorkingDirectories: [] },
  };
  const glob = createGlobTool();
  const grep = createGrepTool();
  const files = await glob.execute({ pattern: "**/*.txt" }, context as never);
  assert.equal((files.data as { files: string[] }).files.some((value) => value.includes("private.txt")), false);
  assert.deepEqual((files.data as { files: string[] }).files, ["inbox/visible.txt"]);
  const found = await grep.execute({ pattern: "should", output_mode: "files_with_matches" }, context as never);
  assert.deepEqual((found.data as { files: string[] }).files, ["inbox/visible.txt"]);
  const filtered = await grep.execute({ pattern: "should", glob: "*.txt",
    output_mode: "files_with_matches" }, context as never);
  assert.deepEqual((filtered.data as { files: string[] }).files, ["inbox/visible.txt"]);
  for (const pattern of ["../private.txt", "scratch/../private.txt", "{inbox,../}/*.txt", "**/linked.txt"]) {
    const result = await glob.execute({ pattern }, context as never);
    assert.deepEqual((result.data as { files: string[] }).files, [], pattern);
  }
  for (const target of ["inbox/linked.txt", "scratch/linked-dir"]) {
    const result = resolvePilotDeckWorkspacePath(target, context as never, { mustExist: true });
    assert.equal(result.ok, false, target);
  }
});

test("task-scoped agents can read bundled skill references but cannot write shared trees", async (t) => {
  const task = mkdtempSync(join(tmpdir(), "task-shared-read-"));
  t.after(() => rmSync(task, { recursive: true, force: true }));
  for (const root of ["inbox", "scratch", "exports"]) mkdirSync(join(task, root), { recursive: true });
  const context = {
    cwd: task,
    taskRoot: task,
    permissionMode: "bypassPermissions",
    permissionContext: { mode: "bypassPermissions", cwd: task, additionalWorkingDirectories: [] },
    env: { PILOTDECK_DISABLE_LOCAL_AUTH: "false" },
  };

  const relativeSkillReference = "skills/docx/references/specifications.md";
  const absoluteSkillReference = join(process.cwd(), relativeSkillReference);
  const readFile = createReadFileTool();
  const permission = await readFile.checkPermissions?.(
    { file_path: relativeSkillReference },
    context as never,
  );
  assert.equal(permission?.type, "passthrough");
  const readResult = await readFile.execute({ file_path: relativeSkillReference }, context as never);
  assert.match(JSON.stringify(readResult.content), /spec|image|block/i);
  assert.equal(
    resolvePilotDeckWorkspacePath(absoluteSkillReference, context as never, { mustExist: true }).ok,
    true,
  );
  assert.equal(
    resolvePilotDeckWorkspacePath(relativeSkillReference, context as never, { forWrite: true }).ok,
    false,
  );
  assert.equal(
    resolvePilotDeckWorkspacePath(absoluteSkillReference, context as never, { forWrite: true }).ok,
    false,
  );
});

test("task-scoped file tools can use the controlled turn work directory alias", async (t) => {
  const task = mkdtempSync(join(tmpdir(), "task-work-dir-alias-"));
  t.after(() => rmSync(task, { recursive: true, force: true }));
  for (const root of ["inbox", "scratch", "exports"]) mkdirSync(join(task, root), { recursive: true });
  const workDir = join(task, "scratch", "work", "session", "turn");
  mkdirSync(join(workDir, "docx", "qa"), { recursive: true });
  const context = {
    cwd: task,
    taskRoot: task,
    permissionMode: "bypassPermissions",
    permissionContext: { mode: "bypassPermissions", cwd: task, additionalWorkingDirectories: [] },
    env: {
      PILOTDECK_DISABLE_LOCAL_AUTH: "false",
      PILOTDECK_WORK_DIR: workDir,
    },
  };
  const resolved = resolvePilotDeckWorkspacePath(
    "$PILOTDECK_WORK_DIR/docx/qa/inspection.json",
    context as never,
  );
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.equal(resolved.absolutePath, join(workDir, "docx", "qa", "inspection.json"));
  }
  assert.equal(resolvePilotDeckWorkspacePath(
    "$PILOTDECK_WORK_DIR/../../outside.json",
    context as never,
  ).ok, false);
});

test("task-scoped glob can explicitly search bundled skill references", async (t) => {
  const task = mkdtempSync(join(tmpdir(), "task-shared-glob-"));
  t.after(() => rmSync(task, { recursive: true, force: true }));
  for (const root of ["inbox", "scratch", "exports"]) mkdirSync(join(task, root), { recursive: true });
  const context = {
    cwd: task,
    taskRoot: task,
    permissionMode: "bypassPermissions",
    permissionContext: { mode: "bypassPermissions", cwd: task, additionalWorkingDirectories: [] },
    env: { PILOTDECK_DISABLE_LOCAL_AUTH: "false" },
  };

  const glob = createGlobTool();
  const result = await glob.execute({
    path: "skills/docx/references",
    pattern: "*.md",
  }, context as never);
  const files = (result.data as { files: string[] }).files;
  assert.ok(files.includes("skills/docx/references/specifications.md"));
});

test("plan files live in task scratch and can be submitted through the plan manager", (t) => {
  const task = mkdtempSync(join(tmpdir(), "task-plans-"));
  t.after(() => rmSync(task, { recursive: true, force: true }));
  for (const root of ["inbox", "scratch", "exports"]) mkdirSync(join(task, root), { recursive: true });
  const manager = createPlanFileManager({ projectRoot: task });
  const planDir = manager.getPlanDirectoryPath();
  assert.equal(planDir, join(task, "scratch", "plans"));
  const path = join(planDir, "research.md");
  writeFileSync(path, "# Plan\n");
  assert.equal(manager.resolvePlanFilePath("scratch/plans/research.md", task), path);
  assert.equal(manager.readPlanFile("scratch/plans/research.md", task), "# Plan");
  const outside = join(task, "inbox", "private.md");
  writeFileSync(outside, "# Private");
  symlinkSync(outside, join(planDir, "escape.md"));
  assert.equal(manager.readPlanFile("scratch/plans/escape.md", task), undefined);
  assert.equal(manager.resolvePlanFilePath("scratch/plans/escape.md", task), undefined);
});

test("long tool outputs are saved where task read_file can access them", (t) => {
  const home = mkdtempSync(join(tmpdir(), "task-tool-outputs-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const storage = createAgentProjectSessionStorage({
    projectRoot: "general", pilotHome: home, sessionId: "case-1", now: () => new Date(),
  });
  assert.equal(storage.toolResultsDir,
    join(home, "workspaces", "general", "scratch", "tool-results", "case-1"));
});
