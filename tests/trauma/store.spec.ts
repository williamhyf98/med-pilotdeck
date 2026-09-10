import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveTraumaCaseDir } from "../../src/pilot/paths.js";
import { initialCaseState } from "../../src/trauma/stageConfig.js";
import { createTraumaCaseStore } from "../../src/trauma/store.js";
import type { CaseSnapshot } from "../../src/trauma/types.js";

const now = "2026-09-03T15:09:00+08:00";

test("trauma case path is isolated under trauma_med memory", () => {
  const path = resolveTraumaCaseDir("trauma_med-demo", "web:s_demo", "/pilot");
  assert.equal(
    path,
    join("/pilot", "memory", "trauma_med", "trauma_med-demo", "cases", "web_s_demo"),
  );
  assert.throws(
    () => resolveTraumaCaseDir("general_med-demo", "web:s_demo", "/pilot"),
    /war_trauma/i,
  );
});

test("case store writes current state and appends snapshots", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-trauma-store-"));
  try {
    const store = createTraumaCaseStore(root);
    assert.equal(await store.load(), null);

    const first = initialCaseState({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      now,
    });
    first.version = 1;
    const firstSnapshot: CaseSnapshot = {
      eventType: "agent_turn",
      round: 1,
      createdAt: now,
      triggerMessageId: "message-1",
      state: first,
    };
    await store.saveTurn(first, firstSnapshot);
    assert.deepEqual(await store.load(), first);

    const second = structuredClone(first);
    second.version = 2;
    const secondSnapshot: CaseSnapshot = {
      eventType: "transition_confirmation",
      round: 1,
      createdAt: now,
      triggerMessageId: "confirmation-1",
      state: second,
    };
    await store.saveTurn(second, secondSnapshot);

    assert.equal((await readFile(join(root, "snapshots.jsonl"), "utf8")).trim().split("\n").length, 2);
    assert.equal((await store.load())?.version, 2);
    assert.deepEqual(await store.loadSnapshots(), [firstSnapshot, secondSnapshot]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("serialization failure does not replace current state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-trauma-store-failure-"));
  try {
    const store = createTraumaCaseStore(root);
    const state = initialCaseState({
      projectId: "trauma_med-demo",
      sessionId: "web:s_demo",
      now,
    });
    state.version = 1;
    await store.saveTurn(state, {
      eventType: "agent_turn",
      round: 1,
      createdAt: now,
      triggerMessageId: "message-1",
      state,
    });

    const circular = { ...state, version: 2 } as typeof state & { self?: unknown };
    circular.self = circular;
    await assert.rejects(
      () => store.saveTurn(circular, {
        eventType: "agent_turn",
        round: 2,
        createdAt: now,
        triggerMessageId: "message-2",
        state: circular,
      }),
      /circular/i,
    );
    assert.equal((await store.load())?.version, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load migrates legacy structured facts and drops extractor-era fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-trauma-migrate-"));
  try {
    const legacy = initialCaseState({
      projectId: "trauma_med-demo", sessionId: "web:s_demo", now,
    }) as unknown as Record<string, unknown>;
    delete legacy.injuryNarratives;
    delete legacy.treatmentNarratives;
    legacy.injuries = [{
      bodyPart: "右小腿", finding: "开放伤", certainty: "confirmed", status: "controlled",
    }];
    legacy.completedActions = [{ title: "加压包扎" }];
    legacy.currentActions = [{ title: "持续监测" }];
    legacy.vitalSignsHistory = [
      { measuredAt: "2026-09-03T15:00:00+08:00", systolicBloodPressure: 92, gcs: 15, spo2: 95 },
      { measuredAt: now, respiratoryRate: 28, heartRate: 118 },
    ];
    legacy.timeline = { elapsedMinutes: 14 };
    legacy.conflictingFactIds = ["old"];
    await writeFile(join(root, "current.json"), JSON.stringify(legacy), "utf8");

    const migrated = await createTraumaCaseStore(root).load();
    assert.match(migrated?.injuryNarratives[0]?.text ?? "", /右小腿开放伤/);
    assert.match(migrated?.treatmentNarratives[0]?.text ?? "", /加压包扎.*持续监测/);
    assert.deepEqual(migrated?.vitalSignsHistory.map((record) => record.round), [1, 2]);
    assert.deepEqual(migrated?.vitalSignsHistory.map((record) => record.values), [
      { systolicBloodPressure: 92, gcs: 15 },
      { respiratoryRate: 28, heartRate: 118 },
    ]);
    assert.equal("timeline" in (migrated ?? {}), false);
    assert.equal("injuries" in (migrated ?? {}), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load rejects corrupt state instead of replacing it with an empty case", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-trauma-corrupt-"));
  try {
    await writeFile(join(root, "current.json"), JSON.stringify({ caseId: "broken" }), "utf8");
    await assert.rejects(() => createTraumaCaseStore(root).load(), /migration failed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
