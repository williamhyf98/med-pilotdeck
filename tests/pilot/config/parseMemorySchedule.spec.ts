import test from "node:test";
import assert from "node:assert/strict";
import { parseMemoryConfig } from "../../../src/pilot/config/parseMemoryConfig.js";

test("UI flat settings override legacy nested settings field by field", () => {
  for (const mode of ["immediate", "interval", "manual"]) {
    const diagnostics: any[] = [];
    const parsed = parseMemoryConfig({ maintenanceMode: mode, autoIndexIntervalMinutes: 0 }, diagnostics, "/tmp/memory");
    assert.equal(parsed?.schedule?.maintenanceMode, mode);
    assert.equal(parsed?.schedule?.autoIndexIntervalMinutes, 0);
    assert.equal(diagnostics.length, 0);
  }
  assert.equal(parseMemoryConfig({
    maintenanceMode: "immediate", schedule: { maintenanceMode: "manual" },
  }, [], "/tmp/memory")?.schedule?.maintenanceMode, "immediate");
  assert.deepEqual(parseMemoryConfig({
    autoIndexIntervalMinutes: 0,
    schedule: { maintenanceMode: "manual", autoIndexIntervalMinutes: 90, autoDreamIntervalMinutes: 120 },
  }, [], "/tmp/memory")?.schedule, {
    maintenanceMode: "manual", autoIndexIntervalMinutes: 0, autoDreamIntervalMinutes: 120,
  });
});
