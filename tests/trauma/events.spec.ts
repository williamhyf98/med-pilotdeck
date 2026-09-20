import assert from "node:assert/strict";
import test from "node:test";

import { traumaProgressEvents } from "../../src/trauma/events.js";

test("interpretation progress emits an uncounted step event", () => {
  const started = traumaProgressEvents({
    progress: { kind: "attachment_interpretation", status: "started" },
    runId: "run-1",
  });
  assert.equal(started.length, 1);
  assert.equal(started[0]?.type, "tool_call_started");
  const payload = JSON.parse((started[0] as any).argsPreview);
  assert.equal(payload.countInTotal, false);
  assert.equal(payload.stepNumber, undefined);
  assert.equal(payload.title, "附件影像判读");
  assert.equal(payload.expectedTotalSteps, 11);
});

test("a finished interpretation reports its ok flag", () => {
  const finished = traumaProgressEvents({
    progress: { kind: "attachment_interpretation", status: "finished", ok: false },
    runId: "run-1",
  });
  assert.equal(finished[0]?.type, "tool_call_finished");
  assert.equal((finished[0] as any).ok, false);
});

test("started and finished share a tool call id so the UI pairs them", () => {
  const started = traumaProgressEvents({
    progress: { kind: "attachment_interpretation", status: "started" },
    runId: "run-1",
  });
  const finished = traumaProgressEvents({
    progress: { kind: "attachment_interpretation", status: "finished", ok: true },
    runId: "run-1",
  });
  assert.equal((started[0] as any).toolCallId, (finished[0] as any).toolCallId);
});
