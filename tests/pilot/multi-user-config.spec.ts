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
