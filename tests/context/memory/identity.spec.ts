// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  sanitizeSessionIdForTranscript,
  sanitizeSessionIdForCaseDir,
} from "../../../src/pilot/paths.js";
import {
  resolveMemoryScopeIdentity,
  isWarTraumaScope,
} from "../../../src/context/memory/MemoryScopeIdentity.js";

const fixtureDir = join(import.meta.dirname ?? __dirname, "../../fixtures");
const golden = JSON.parse(
  readFileSync(join(fixtureDir, "memory-identity.golden.json"), "utf8"),
);

// ── slug cases ─────────────────────────────────────────────────────────────

test("sanitizeSessionIdForTranscript matches golden fixture", () => {
  for (const c of golden.sessionSlugCases) {
    assert.equal(
      sanitizeSessionIdForTranscript(c.sessionId),
      c.transcriptSlug,
      `transcriptSlug mismatch for ${JSON.stringify(c.sessionId)} (${c.note})`,
    );
  }
});

test("sanitizeSessionIdForCaseDir matches golden fixture", () => {
  for (const c of golden.sessionSlugCases) {
    assert.equal(
      sanitizeSessionIdForCaseDir(c.sessionId),
      c.caseDirSlug,
      `caseDirSlug mismatch for ${JSON.stringify(c.sessionId)} (${c.note})`,
    );
  }
});

// ── identity cases ─────────────────────────────────────────────────────────

test("resolveMemoryScopeIdentity matches golden fixture", () => {
  for (const c of golden.identityCases) {
    const result = resolveMemoryScopeIdentity(c.input);
    for (const [key, value] of Object.entries(c.expected)) {
      assert.equal(
        result[key],
        value,
        `identity field '${key}' mismatch for case: ${c.note}`,
      );
    }
    // Fields absent from expected must not appear on result.
    for (const key of ["projectPath", "sessionId", "transcriptSlug", "caseDirSlug", "displayName"]) {
      if (!(key in c.expected)) {
        assert.equal(
          result[key],
          undefined,
          `unexpected field '${key}' present for case: ${c.note}`,
        );
      }
    }
  }
});

test("isWarTraumaScope returns true only for trauma_med projects", () => {
  const trauma = resolveMemoryScopeIdentity({
    projectKey: "trauma_med-demo",
    pilotHome: "/tmp/ph",
  });
  const general = resolveMemoryScopeIdentity({
    projectKey: "general_med-clinic1",
    pilotHome: "/tmp/ph",
  });
  assert.equal(isWarTraumaScope(trauma), true);
  assert.equal(isWarTraumaScope(general), false);
});

test("slug pair is produced together or not at all", () => {
  const withSession = resolveMemoryScopeIdentity({
    projectKey: "trauma_med-demo",
    pilotHome: "/tmp/ph",
    sessionId: "web:s_3f2a1b",
  });
  assert.ok("transcriptSlug" in withSession, "transcriptSlug missing when sessionId given");
  assert.ok("caseDirSlug" in withSession, "caseDirSlug missing when sessionId given");

  const noSession = resolveMemoryScopeIdentity({
    projectKey: "trauma_med-demo",
    pilotHome: "/tmp/ph",
  });
  assert.equal(noSession.transcriptSlug, undefined);
  assert.equal(noSession.caseDirSlug, undefined);

  const emptySession = resolveMemoryScopeIdentity({
    projectKey: "trauma_med-demo",
    pilotHome: "/tmp/ph",
    sessionId: "",
  });
  assert.equal(emptySession.transcriptSlug, undefined, "empty sessionId must not produce slug");
  assert.equal(emptySession.caseDirSlug, undefined, "empty sessionId must not produce slug");
});
