import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { createSecurityPolicyStore, PolicyConflictError } from "../../src/security/policy/PolicyStore.js";
import { resolveSecurityPolicyPaths } from "../../src/security/policy/paths.js";

const enabled = {
  version: 1, mode: "registered_only",
  commands: [{ id: "workspace.pwd", enabled: true, allowedOptions: [], inputRoots: [],
    outputRoots: [], writable: false, networkRuleIds: [], timeoutMs: 1000 }],
};
const network = {
  version: 1, mode: "deny",
  rules: [{ id: "hospital.pacs", enabled: true, host: "pacs.internal",
    port: 8443, protocol: "https", purpose: "PACS" }],
};

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "pilot-security-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { PILOT_HOME: home };
  const paths = resolveSecurityPolicyPaths(env);
  mkdirSync(paths.directory, { recursive: true });
  return { home, env, paths };
}

test("system policy path is shared across web and per-user Gateway", (t) => {
  const { home, paths } = fixture(t);
  assert.equal(paths.command, join(home, "system/security/command-policy.yaml"));
  assert.deepEqual(paths, resolveSecurityPolicyPaths({
    PILOT_HOME: join(home, "users/17"),
    PILOTDECK_SYSTEM_HOME: home,
    PILOTDECK_CONFIG_PATH: join(home, "pilotdeck.yaml"),
  }));
});

test("absent files enable only bundled commands, deny network, and saving uses disk revisions", async (t) => {
  const { env, paths } = fixture(t);
  const store = createSecurityPolicyStore({ env });
  const initial = store.getSnapshot();
  assert.equal(initial.commands.commands.some((entry) => entry.id === "pdf.make" && entry.enabled), true);
  assert.deepEqual(initial.network.rules, []);
  const saved = await store.updateCommands(enabled, initial.commandRevision);
  assert.equal(saved.commands.commands[0]?.id, "workspace.pwd");
  assert.match(readFileSync(paths.command, "utf8"), /registered_only/);
  assert.notEqual(saved.commandRevision, initial.commandRevision);
  assert.equal(readFileSync(paths.command).byteLength > 0, true);
  await assert.rejects(store.updateCommands(enabled, initial.commandRevision), PolicyConflictError);
  assert.deepEqual(store.getSnapshot().network, initial.network);
});

test("invalid YAML and schema on reload do not replace either valid snapshot", async (t) => {
  const { env, paths } = fixture(t);
  const store = createSecurityPolicyStore({ env });
  const previous = await store.updateCommands(enabled, store.getSnapshot().commandRevision);
  writeFileSync(paths.network, "mode: [\n");
  await assert.rejects(store.reload(), /YAML/i);
  assert.equal(store.getSnapshot(), previous);
  writeFileSync(paths.network, "version: 1\nmode: allow\nrules: []\n");
  await assert.rejects(store.reload(), /mode/i);
  assert.equal(store.getSnapshot(), previous);
  assert.ok(store.getDiagnostics());
});

test("external modifications conflict even when the store has not reloaded", async (t) => {
  const { env, paths } = fixture(t);
  const store = createSecurityPolicyStore({ env });
  const original = store.getSnapshot();
  writeFileSync(paths.command, "version: 1\nmode: registered_only\ncommands: []\n");
  await assert.rejects(store.updateCommands(enabled, original.commandRevision), PolicyConflictError);
  assert.equal(store.getSnapshot(), original);
  const reloaded = await store.reload();
  assert.notEqual(reloaded.commandRevision, original.commandRevision);
});

test("invalid updates preserve disk and effective policy; network save commits after validation", async (t) => {
  const { env, paths } = fixture(t);
  const store = createSecurityPolicyStore({ env });
  await assert.rejects(store.updateNetwork({ ...network, mode: "allow" }, store.getSnapshot().networkRevision));
  assert.equal(store.getSnapshot().network.rules.length, 0);
  const saved = await store.updateNetwork(network, store.getSnapshot().networkRevision);
  assert.equal(saved.network.rules.length, 1);
  const content = readFileSync(paths.network, "utf8");
  await assert.rejects(store.updateNetwork({ ...network, rules: [{ ...network.rules[0], host: "*" }] }, saved.networkRevision));
  assert.equal(readFileSync(paths.network, "utf8"), content);
  assert.equal(store.getSnapshot(), saved);
});

test("invalid existing policy fails closed at startup", (t) => {
  const { env, paths } = fixture(t);
  const store = createSecurityPolicyStore({ env });
  assert.equal(store.getSnapshot().network.rules.length, 0);
  writeFileSync(paths.command, "version: 1\nmode: allow_all\ncommands: []\n");
  assert.throws(() => createSecurityPolicyStore({ env }), /mode/i);
});

test("a security policy file cannot be a symlink into another directory", (t) => {
  const { home, env, paths } = fixture(t);
  writeFileSync(join(home, "outside.yaml"), "version: 1\nmode: registered_only\ncommands: []\n");
  symlinkSync(join(home, "outside.yaml"), paths.command);
  assert.throws(() => createSecurityPolicyStore({ env }), /Symlink/i);
});

test("a dangling symlink cannot impersonate an absent security policy", (t) => {
  const { home, env, paths } = fixture(t);
  symlinkSync(join(home, "missing.yaml"), paths.command);
  assert.throws(() => createSecurityPolicyStore({ env }), /Symlink/i);
});

test("concurrent writes from a stale revision cannot overwrite the first save", async (t) => {
  const { env, paths } = fixture(t);
  const store = createSecurityPolicyStore({ env });
  const revision = store.getSnapshot().commandRevision;
  const results = await Promise.allSettled([
    store.updateCommands(enabled, revision),
    store.updateCommands({ ...enabled, commands: [] }, revision),
  ]);
  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "rejected"]);
  assert.match(readFileSync(paths.command, "utf8"), /workspace.pwd/);
});
