import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createTraumaAuditLogger } from "../../src/trauma/auditLog.js";

test("trauma audit logger appends structured redacted JSONL with restricted permissions", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "trauma-audit-"));
  try {
    const logger = createTraumaAuditLogger({ pilotHome });
    assert.equal((await stat(logger.path)).mode & 0o777, 0o600);
    await logger.record({
      timestamp: "2026-09-04T02:20:00.000Z",
      level: "INFO",
      event: "step_completed",
      runId: "run-1",
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      step: 2,
      phase: "extract_facts",
      status: "ok",
      durationMs: 123,
      details: {
        turnKind: "case_update",
        userText: "这段伤情原文不应进入审计日志",
        apiKey: "secret",
      },
    });

    const path = join(pilotHome, "logs", "trauma-agent.jsonl");
    const entry = JSON.parse((await readFile(path, "utf8")).trim());
    assert.equal(entry.schemaVersion, 1);
    assert.equal(entry.service, "trauma-turn-runner");
    assert.equal(entry.phase, "extract_facts");
    assert.deepEqual(entry.details, { turnKind: "case_update" });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("trauma audit logger records normalized errors without stack traces", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "trauma-audit-"));
  try {
    const logger = createTraumaAuditLogger({ pilotHome });
    await logger.record({
      timestamp: "2026-09-04T02:20:00.000Z",
      level: "ERROR",
      event: "step_failed",
      runId: "run-2",
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      step: 11,
      phase: "reason",
      status: "error",
      error: Object.assign(new Error("upstream request failed"), {
        code: "UPSTREAM_400",
      }),
    });

    const path = join(pilotHome, "logs", "trauma-agent.jsonl");
    const entry = JSON.parse((await readFile(path, "utf8")).trim());
    assert.deepEqual(entry.error, {
      name: "Error",
      code: "UPSTREAM_400",
      message: "upstream request failed",
    });
    assert.equal("stack" in entry.error, false);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});
