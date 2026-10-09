import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPilotConfig } from "../../../src/pilot/config/loadPilotConfig.js";
import { PilotConfigError } from "../../../src/pilot/config/types.js";

const yaml = `schemaVersion: 1
agent:
  model: primary/text-model
medical:
  interpretationModel: visual/image-model
model:
  providers:
    primary:
      protocol: openai
      url: http://127.0.0.1:1/v1
      apiKey: EMPTY
      models:
        text-model: {}
    visual:
      protocol: openai
      url: http://127.0.0.1:2/v1
      apiKey: EMPTY
      models:
        image-model:
          multimodal:
            input: [text, image]
`;

function withConfig(content: string, run: (pilotHome: string) => void): void {
  const pilotHome = mkdtempSync(join(tmpdir(), "medical-model-"));
  try {
    writeFileSync(join(pilotHome, "pilotdeck.yaml"), content);
    run(pilotHome);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
}

test("medical role resolves a configured image model independently of the agent", () => {
  withConfig(yaml, (pilotHome) => {
    const { config } = loadPilotConfig({ env: { PILOT_HOME: pilotHome } });
    assert.deepEqual(config.medical?.interpretationModel, {
      id: "visual/image-model", provider: "visual", model: "image-model",
    });
  });
});

test("unknown medical model is a configuration error", () => {
  withConfig(yaml.replace("visual/image-model", "visual/missing"), (pilotHome) => {
    assert.throws(
      () => loadPilotConfig({ env: { PILOT_HOME: pilotHome } }),
      (error: unknown) => error instanceof PilotConfigError
        && error.diagnostics.some((item) => item.path === "medical.interpretationModel"),
    );
  });
});

test("medical model must advertise image input and use OpenAI chat protocol", () => {
  withConfig(yaml.replace("input: [text, image]", "input: [text]"), (pilotHome) => {
    assert.throws(() => loadPilotConfig({ env: { PILOT_HOME: pilotHome } }), /image input/);
  });
  withConfig(yaml.replace("visual:\n      protocol: openai", "visual:\n      protocol: anthropic"), (pilotHome) => {
    assert.throws(() => loadPilotConfig({ env: { PILOT_HOME: pilotHome } }), /OpenAI-compatible/);
  });
});
