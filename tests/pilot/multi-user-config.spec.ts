// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { parseMultiUserConfig, DEFAULT_RETENTION } from "../../src/pilot/config/parseMultiUserConfig.js";

test("defaults when the section is absent", () => {
  assert.deepEqual(parseMultiUserConfig(undefined, []).retention, DEFAULT_RETENTION);
});
test("overrides are applied and invalid values fall back with a diagnostic", () => {
  const diags = [];
  const r = parseMultiUserConfig({ retention: { attachmentMaxAgeDays: 3, logKeep: "many" } }, diags);
  assert.equal(r.retention.attachmentMaxAgeDays, 3);
  assert.equal(r.retention.logKeep, DEFAULT_RETENTION.logKeep);
  assert.ok(diags.some((d) => /logKeep/.test(d.message)));
  assert.ok(diags.some((d) => d.code === "multi-user.retention.invalid" && d.severity === "warning" && d.path === "multiUser.retention.logKeep"));
});
test("sandbox defaults when the section is absent: auto kind, no unsandboxed, network on, no extra binds", () => {
  const diags = [];
  const r = parseMultiUserConfig(undefined, diags);
  assert.deepEqual(r.sandbox, { kind: undefined, allowUnsandboxed: false, network: true, extraReadOnlyBinds: [] });
  assert.deepEqual(diags, []);
});
test("sandbox overrides are applied without diagnostics", () => {
  const diags = [];
  const r = parseMultiUserConfig(
    { sandbox: { kind: "none", allowUnsandboxed: true, network: false, extraReadOnlyBinds: ["/usr/local/bin"] } },
    diags,
  );
  assert.deepEqual(r.sandbox, {
    kind: "none",
    allowUnsandboxed: true,
    network: false,
    extraReadOnlyBinds: ["/usr/local/bin"],
  });
  assert.deepEqual(diags, []);
});
test("invalid sandbox values fall back to defaults with one diagnostic per key", () => {
  const diags = [];
  const r = parseMultiUserConfig(
    { sandbox: { kind: "docker", allowUnsandboxed: "yes", network: 0, extraReadOnlyBinds: ["relative/path"] } },
    diags,
  );
  assert.deepEqual(r.sandbox, { kind: undefined, allowUnsandboxed: false, network: true, extraReadOnlyBinds: [] });
  const paths = diags.map((d) => d.path).sort();
  assert.deepEqual(paths, [
    "multiUser.sandbox.allowUnsandboxed",
    "multiUser.sandbox.extraReadOnlyBinds",
    "multiUser.sandbox.kind",
    "multiUser.sandbox.network",
  ]);
  assert.ok(diags.every((d) => d.code === "multi-user.sandbox.invalid" && d.severity === "warning" && d.recoverable === true));
});
