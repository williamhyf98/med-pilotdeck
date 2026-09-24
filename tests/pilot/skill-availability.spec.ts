import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isToolAvailableForProjectType } from "../../src/pilot/projectTypePolicy.js";
import {
  normalizeSkillAvailability,
  writeSkillAvailabilityOverride,
} from "../../src/pilot/skillAvailability.js";

test("legacy skill availability overrides are normalized to global", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-skill-availability-"));
  const previousPilotHome = process.env.PILOT_HOME;
  try {
    process.env.PILOT_HOME = pilotHome;
    assert.deepEqual(normalizeSkillAvailability(["general_medicine"]), ["global"]);
    await writeSkillAvailabilityOverride("med-medical", ["global"], pilotHome);
    assert.deepEqual(
      JSON.parse(await readFile(join(pilotHome, "skill-availability.json"), "utf8")),
      { "med-medical": ["global"] },
    );
    assert.equal(
      isToolAvailableForProjectType(
        "mcp__med-tools__med_parse_medical",
        "general_medicine",
      ),
      true,
    );
    assert.equal(
      isToolAvailableForProjectType(
        "mcp__med-tools__med_parse_medical",
        "war_trauma",
      ),
      true,
    );
    assert.equal(
      isToolAvailableForProjectType(
        "mcp__med-tools__med_tools_health",
        "war_trauma",
      ),
      true,
    );
    assert.equal(
      isToolAvailableForProjectType(
        "mcp__med-tools__med_trauma_stage_plan",
        "general_medicine",
      ),
      true,
    );
    assert.equal(
      isToolAvailableForProjectType(
        "mcp__med-tools__med_dicom_route",
        "general_medicine",
      ),
      true,
    );
    assert.equal(
      isToolAvailableForProjectType(
        "mcp__med-tools__med_radar_status",
        "general_medicine",
      ),
      false,
    );
  } finally {
    if (previousPilotHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = previousPilotHome;
    await rm(pilotHome, { recursive: true, force: true });
  }
});
