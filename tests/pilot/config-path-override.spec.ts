// tests/pilot/config-path-override.spec.ts
// @ts-nocheck
import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { getPilotConfigFilePath } from "../../src/pilot/paths.js";

test("defaults to <pilotHome>/pilotdeck.yaml", () => {
  assert.equal(getPilotConfigFilePath("/srv/pd/users/3", {}), resolve("/srv/pd/users/3", "pilotdeck.yaml"));
});

test("PILOTDECK_CONFIG_PATH overrides the home-relative default", () => {
  assert.equal(
    getPilotConfigFilePath("/srv/pd/users/3", { PILOTDECK_CONFIG_PATH: "/srv/pd/pilotdeck.yaml" }),
    resolve("/srv/pd/pilotdeck.yaml"),
  );
});

test("blank override is ignored", () => {
  assert.equal(getPilotConfigFilePath("/h", { PILOTDECK_CONFIG_PATH: "  " }), resolve("/h", "pilotdeck.yaml"));
});
