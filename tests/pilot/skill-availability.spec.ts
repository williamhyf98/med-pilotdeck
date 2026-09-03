import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { isToolAvailableForProjectType } from "../../src/pilot/projectTypePolicy.js";
import { writeSkillAvailabilityOverride } from "../../src/pilot/skillAvailability.js";

test("medical tools stay global despite legacy med-medical overrides", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-skill-availability-"));
  const previousPilotHome = process.env.PILOT_HOME;
  try {
    process.env.PILOT_HOME = pilotHome;
    await writeSkillAvailabilityOverride("med-medical", ["general_medicine"], pilotHome);
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
  } finally {
    if (previousPilotHome === undefined) delete process.env.PILOT_HOME;
    else process.env.PILOT_HOME = previousPilotHome;
    await rm(pilotHome, { recursive: true, force: true });
  }
});
