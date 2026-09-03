import assert from "node:assert/strict";
import test from "node:test";

import { computeTimeline } from "../../src/trauma/timeline.js";

test("timing is a soft window and never a hard Gate", () => {
  const timeline = computeTimeline({
    injuryTime: "2026-09-03T14:55:00+08:00",
    now: "2026-09-03T15:09:00+08:00",
    currentSubStage: "primary_first_aid",
  });

  assert.equal(timeline.elapsedMinutes, 14);
  assert.equal(timeline.recommendedWindowMinutes, 10);
  assert.equal(timeline.timingStatus, "exceeded");
  assert.equal(timeline.isHardGate, false);
});

test("unknown injury time stays within the soft window", () => {
  const timeline = computeTimeline({
    injuryTime: "",
    now: "2026-09-03T15:09:00+08:00",
    currentSubStage: "advanced_first_aid",
  });

  assert.equal(timeline.elapsedMinutes, 0);
  assert.equal(timeline.recommendedWindowMinutes, 60);
  assert.equal(timeline.timingStatus, "within_window");
});
