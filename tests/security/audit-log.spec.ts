// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendAudit,
  auditFilePath,
  resolveAuditDir,
  sanitizeTarget,
} from "../../src/security/audit/auditLog.js";
import {
  resolvePilotDeckWorkspacePath,
} from "../../src/tool/builtin/filesystem/pathSafety.js";

async function withHome(fn) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-audit-"));
  const pilotHome = join(root, "users", "7");
  try {
    await mkdir(pilotHome, { recursive: true });
    await fn({ root, pilotHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function readLines(file) {
  return readFile(file, "utf8").then((text) => text.trim().split("\n").map((line) => JSON.parse(line)));
}

test("appendAudit writes one JSON line per event under system/audit", async () => {
  await withHome(async ({ pilotHome }) => {
    const env = { PILOT_HOME: pilotHome };
    const now = new Date("2026-11-11T10:00:00+08:00");
    const first = appendAudit(
      { action: "file.denied", decision: "deny", tool: "write_file", target: "inbox/a.csv", reason: "read-only" },
      { env, now },
    );
    assert.equal(first.ok, true);
    appendAudit({ action: "bash.denied", decision: "deny", tool: "bash", reason: "network-blocked" }, { env, now });

    const file = auditFilePath(now, env);
    assert.equal(file, join(pilotHome, "system", "audit", "2026-11-11.jsonl"));
    const lines = await readLines(file);
    assert.equal(lines.length, 2);
    assert.equal(lines[0].action, "file.denied");
    assert.equal(lines[0].target, "inbox/a.csv");
    assert.equal(lines[0].decision, "deny");
    assert.match(lines[0].ts, /^2026-11-11T/);
    assert.equal(lines[1].action, "bash.denied");
  });
});

test("audit files roll over by day", async () => {
  await withHome(async ({ pilotHome }) => {
    const env = { PILOT_HOME: pilotHome };
    appendAudit({ action: "file.denied" }, { env, now: new Date("2026-11-11T23:59:00+08:00") });
    appendAudit({ action: "file.denied" }, { env, now: new Date("2026-11-12T00:01:00+08:00") });
    const day1 = await readLines(join(pilotHome, "system", "audit", "2026-11-11.jsonl"));
    const day2 = await readLines(join(pilotHome, "system", "audit", "2026-11-12.jsonl"));
    assert.equal(day1.length, 1);
    assert.equal(day2.length, 1);
  });
});

test("PILOTDECK_SYSTEM_HOME wins over PILOT_HOME (shared audit root)", async () => {
  await withHome(async ({ root, pilotHome }) => {
    const env = { PILOT_HOME: pilotHome, PILOTDECK_SYSTEM_HOME: root };
    assert.equal(resolveAuditDir(env), join(root, "system", "audit"));
  });
});

test("absolute targets are reduced to a basename placeholder", () => {
  assert.equal(sanitizeTarget("/etc/passwd"), "(absolute)/passwd");
  assert.equal(sanitizeTarget("inbox/a.csv"), "inbox/a.csv");
  assert.equal(sanitizeTarget(""), "");
});

test("appendAudit never throws when the audit dir is not writable", async () => {
  await withHome(async ({ pilotHome }) => {
    const auditDir = join(pilotHome, "system", "audit");
    await mkdir(auditDir, { recursive: true });
    await chmod(auditDir, 0o500);
    try {
      let result;
      assert.doesNotThrow(() => {
        result = appendAudit({ action: "file.denied" }, { env: { PILOT_HOME: pilotHome } });
      });
      assert.equal(result.ok, false);
      assert.ok(result.error);
    } finally {
      await chmod(auditDir, 0o700);
    }
  });
});

test("long fields are clipped instead of blowing up the line", async () => {
  await withHome(async ({ pilotHome }) => {
    const env = { PILOT_HOME: pilotHome };
    const now = new Date("2026-11-11T09:00:00+08:00");
    appendAudit({ action: "file.denied", reason: "x".repeat(5000) }, { env, now });
    const [line] = await readLines(auditFilePath(now, env));
    assert.ok(line.reason.length <= 501);
  });
});

test("a denied file write leaves an audit record (end to end)", async () => {
  await withHome(async ({ pilotHome }) => {
    const workspace = join(pilotHome, "workspaces", "general", "ws1");
    await mkdir(join(workspace, "inbox"), { recursive: true });
    const context = {
      cwd: workspace,
      permissionMode: "bypassPermissions",
      permissionContext: { additionalWorkingDirectories: [] },
      env: { PILOT_HOME: pilotHome },
      allowedReadFiles: [],
    };
    const result = resolvePilotDeckWorkspacePath("inbox/x.txt", context, { forWrite: true });
    assert.equal(result.ok, false);

    const dir = join(pilotHome, "system", "audit");
    assert.equal(existsSync(dir), true);
    const files = (await import("node:fs/promises")).readdir(dir).then((entries) => entries.filter((n) => n.endsWith(".jsonl")));
    const names = await files;
    assert.equal(names.length, 1);
    const [record] = await readLines(join(dir, names[0]));
    assert.equal(record.action, "file.denied");
    assert.equal(record.target, join("inbox", "x.txt"));
    assert.equal(record.decision, "deny");
  });
});
