// @ts-nocheck
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function makePilotHome() {
  // Prefer repo-local tmp so CI/sandbox without writable os.tmpdir still works.
  return mkdtempSync(join(process.cwd(), ".tmp-bootstrap-"));
}

test("config bootstrap creates pilotdeck.yaml and home layout without copying bundled skills", () => {
  const pilotHome = makePilotHome();
  try {
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "scripts", "bootstrap-pilotdeck-config.mjs")],
      {
        cwd: process.cwd(),
        env: { ...process.env, PILOT_HOME: pilotHome },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const configPath = join(pilotHome, "pilotdeck.yaml");
    assert.equal(existsSync(configPath), true);
    assert.equal(existsSync(join(pilotHome, "skills")), true);
    assert.equal(existsSync(join(pilotHome, "plugins")), true);
    // Layout dirs only — do not copy repo skills into user storage.
    assert.equal(existsSync(join(pilotHome, "skills", "pdf")), false);
    const yaml = readFileSync(configPath, "utf8");
    assert.match(yaml, /schemaVersion:\s*1/);
    assert.match(yaml, /agent:\s*\n\s*model:/);
    assert.match(yaml, /PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE/);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("config bootstrap is idempotent when pilotdeck.yaml already exists", () => {
  const pilotHome = makePilotHome();
  try {
    const script = join(process.cwd(), "scripts", "bootstrap-pilotdeck-config.mjs");
    const first = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      env: { ...process.env, PILOT_HOME: pilotHome },
      encoding: "utf8",
    });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const configPath = join(pilotHome, "pilotdeck.yaml");
    const before = readFileSync(configPath, "utf8");
    const second = spawnSync(process.execPath, [script], {
      cwd: process.cwd(),
      env: { ...process.env, PILOT_HOME: pilotHome },
      encoding: "utf8",
    });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(readFileSync(configPath, "utf8"), before);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
