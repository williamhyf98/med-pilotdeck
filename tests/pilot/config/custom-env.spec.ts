import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";

test("loads customEnv into the gateway snapshot for runtime service overrides", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilot-custom-env-"));
  try {
    writeFileSync(join(pilotHome, "pilotdeck.yaml"), `schemaVersion: 1
agent:
  model: local/text
model:
  providers:
    local:
      protocol: openai
      url: http://127.0.0.1:19000/v1
      apiKey: EMPTY
      models:
        text: {}
customEnv:
  MED_RADAR_API_BASE: https://10.20.30.42:18121/v1
`);

    const { config } = loadPilotConfig({ env: { PILOT_HOME: pilotHome } });
    assert.equal(config.customEnv.MED_RADAR_API_BASE, "https://10.20.30.42:18121/v1");
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
