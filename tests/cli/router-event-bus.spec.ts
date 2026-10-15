// @ts-nocheck
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shouldWriteRouterEvents } from "../../src/router/routerEventFlags.js";
import { createModelRuntime } from "../../src/model/index.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";

test("shouldWriteRouterEvents is on only for the exact value 1", () => {
  assert.equal(shouldWriteRouterEvents({}), false);
  assert.equal(shouldWriteRouterEvents({ PILOTDECK_ROUTER_DEBUG: "" }), false);
  assert.equal(shouldWriteRouterEvents({ PILOTDECK_ROUTER_DEBUG: "0" }), false);
  assert.equal(shouldWriteRouterEvents({ PILOTDECK_ROUTER_DEBUG: "true" }), false);
  assert.equal(shouldWriteRouterEvents({ PILOTDECK_ROUTER_DEBUG: "1" }), true);
});

const CONFIG = `schemaVersion: 1
agent:
  model: openai/gpt-agent
model:
  providers:
    openai:
      protocol: openai
      url: http://127.0.0.1:1/v1
      apiKey: EMPTY
      models:
        gpt-agent: {}
router:
  # The token-stats collector is a separate feature that also keeps files under
  # router/ (stats.jsonl); switch it off so this test observes only events.jsonl.
  stats:
    enabled: false
telemetry:
  enabled: false
`;

async function buildRuntime(extraEnv: Record<string, string>) {
  const pilotHome = await mkdtemp(join(tmpdir(), "router-bus-home-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "router-bus-proj-"));
  await writeFile(join(pilotHome, "pilotdeck.yaml"), CONFIG, "utf8");
  const result = createLocalGateway({
    projectRoot,
    pilotHome,
    env: { PILOT_HOME: pilotHome, ...extraEnv },
    __testModelFactory: (snapshot) => createModelRuntime(snapshot.config.model),
  });
  try {
    result.registry.resolve(projectRoot);
    return existsSync(join(pilotHome, "router"));
  } finally {
    result.dispose();
    await rm(pilotHome, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("building a project runtime creates no router/ directory without the debug flag", async () => {
  assert.equal(await buildRuntime({}), false);
});

test("building a project runtime creates router/ with PILOTDECK_ROUTER_DEBUG=1", async () => {
  assert.equal(await buildRuntime({ PILOTDECK_ROUTER_DEBUG: "1" }), true);
});
