// @ts-nocheck
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createAgentProjectSessionStorage } from "../../src/session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../src/session/transcript/TranscriptReader.js";

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
memory:
  enabled: true
  provider: edgeclaw
  maintenanceMode: manual
telemetry:
  enabled: false
`;

test("gateway rewind waits for maintenance and revokes only the pending matching turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "rewind-memory-gateway-"));
  const pilotHome = join(root, "home");
  const projectRoot = join(root, "project");
  const sessionKey = "web:s_rewind_gateway";
  let gateway;
  try {
    await Promise.all([mkdir(pilotHome), mkdir(projectRoot)]);
    await writeFile(join(pilotHome, "pilotdeck.yaml"), CONFIG);
    gateway = createLocalGateway({ pilotHome, projectRoot, env: { PILOT_HOME: pilotHome } });
    const runtime = gateway.registry.resolve(projectRoot);
    const service = runtime.memoryService;
    assert.ok(service);
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
    for (const turnId of ["first", "second"]) {
      await storage.transcript.recordAcceptedInput(sessionKey, turnId, [
        { role: "user", content: [{ type: "text", text: `question ${turnId}` }] },
      ]);
      await storage.transcript.recordDurableMessage(sessionKey, turnId, {
        role: "assistant", content: [{ type: "text", text: `answer ${turnId}` }],
      });
      service.captureTurn([{ role: "user", content: `question ${turnId}` }],
        { sessionKey, turnId });
    }

    let releaseMaintenance;
    let startedMaintenance;
    const started = new Promise((resolve) => { startedMaintenance = resolve; });
    const observed = [];
    service.runDueScheduledMaintenance = async () => {
      observed.push(service.repository.listUnindexedL0BySession(sessionKey).map((row) => row.turnId));
      if (observed.length === 1) {
        startedMaintenance();
        await new Promise((resolve) => { releaseMaintenance = resolve; });
      }
      return { indexRan: false, dreamRan: false };
    };
    gateway.registry.scheduleMemoryMaintenance(projectRoot);
    await started;

    const { entries } = await readTranscript(storage.transcriptPath);
    const target = entries.find((entry) => entry.type === "accepted_input" && entry.turnId === "second");
    assert.ok(target);
    const rewinding = gateway.gateway.rewindSession({
      sessionKey, projectKey: projectRoot, fromEntryId: target.entryId,
    });
    gateway.registry.scheduleMemoryMaintenance(projectRoot);
    assert.deepEqual(service.repository.listUnindexedL0BySession(sessionKey).map((row) => row.turnId),
      ["first", "second"]);
    releaseMaintenance();
    const result = await rewinding;
    assert.equal(result.removedTurnId, "second");
    await runtime.memoryMaintenanceInFlight;
    assert.deepEqual(observed, [["first", "second"], ["first"]]);
    assert.deepEqual(service.repository.listUnindexedL0BySession(sessionKey).map((row) => row.turnId),
      ["first"]);
  } finally {
    gateway?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
