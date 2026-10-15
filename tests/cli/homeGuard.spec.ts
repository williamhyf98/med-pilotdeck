// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveCliHome, applyCliHome } from "../../src/cli/homeGuard.js";

function systemRoot(withAdminHome = true) {
  const root = mkdtempSync(join(tmpdir(), "pd-guard-"));
  mkdirSync(join(root, "system"), { recursive: true });
  writeFileSync(join(root, "system", "auth.db"), "");
  writeFileSync(join(root, "pilotdeck.yaml"), "schemaVersion: 1\n");
  if (withAdminHome) {
    mkdirSync(join(root, "users", "1"), { recursive: true });
    writeFileSync(join(root, "system", "admin-home"), join(root, "users", "1") + "\n");
  }
  return root;
}

test("a plain user home is left alone", () => {
  const home = mkdtempSync(join(tmpdir(), "pd-guard-user-"));
  assert.deepEqual(resolveCliHome({ PILOT_HOME: home }), { kind: "user-home", pilotHome: home });
  rmSync(home, { recursive: true, force: true });
});

test("a system root redirects to the admin home and the root config", () => {
  const root = systemRoot();
  const r = resolveCliHome({ PILOT_HOME: root });
  assert.equal(r.kind, "redirected");
  assert.equal(r.pilotHome, join(root, "users", "1"));
  assert.equal(r.configPath, join(root, "pilotdeck.yaml"));
  const env = { PILOT_HOME: root };
  const lines = [];
  applyCliHome(env, (m) => lines.push(m));
  assert.equal(env.PILOT_HOME, join(root, "users", "1"));
  assert.equal(env.PILOTDECK_CONFIG_PATH, join(root, "pilotdeck.yaml"));
  assert.match(lines[0], /users\/1/);
  rmSync(root, { recursive: true, force: true });
});

test("an explicit PILOTDECK_CONFIG_PATH is not overridden", () => {
  const root = systemRoot();
  const env = { PILOT_HOME: root, PILOTDECK_CONFIG_PATH: "/etc/pd.yaml" };
  applyCliHome(env, () => {});
  assert.equal(env.PILOTDECK_CONFIG_PATH, "/etc/pd.yaml");
  rmSync(root, { recursive: true, force: true });
});

test("a system root without admin-home is reported, not guessed", () => {
  const root = systemRoot(false);
  assert.deepEqual(resolveCliHome({ PILOT_HOME: root }), { kind: "system-root-without-admin", pilotHome: root });
  rmSync(root, { recursive: true, force: true });
});

test("applyCliHome on a system root without admin-home logs and leaves env untouched", () => {
  const root = systemRoot(false);
  const env = { PILOT_HOME: root };
  const lines = [];
  applyCliHome(env, (m) => lines.push(m));
  assert.equal(env.PILOT_HOME, root);
  assert.equal(env.PILOTDECK_CONFIG_PATH, undefined);
  assert.match(lines[0], /admin-home is missing/);
  rmSync(root, { recursive: true, force: true });
});
