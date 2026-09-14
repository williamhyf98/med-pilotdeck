import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_INTERPRETATION_CHARS,
  buildInterpretationContext,
} from "../../src/trauma/attachments/interpretationBudget.js";
import type { InterpretationEntry } from "../../src/trauma/types.js";

function entry(round: number, text: string): InterpretationEntry {
  return {
    id: `interp-${round}`,
    round,
    createdAt: "2026-09-11T00:00:00.000Z",
    fileNames: [`scan-${round}.dcm`],
    text,
  };
}

test("empty entries produce an empty context", () => {
  assert.equal(buildInterpretationContext([]), "");
});

test("a single entry is rendered with round and file names", () => {
  const context = buildInterpretationContext([entry(3, "右侧血气胸。")]);
  assert.ok(context.includes("【第 3 轮影像判读】"));
  assert.ok(context.includes("scan-3.dcm"));
  assert.ok(context.includes("右侧血气胸。"));
});

test("entries under budget are all kept and ordered by round", () => {
  const context = buildInterpretationContext([entry(2, "B"), entry(1, "A")]);
  assert.ok(context.indexOf("【第 1 轮") < context.indexOf("【第 2 轮"));
  assert.ok(context.includes("A") && context.includes("B"));
});

test("over budget keeps the earliest and the latest, noting the omitted range", () => {
  const entries = [1, 2, 3, 4, 5].map((round) => entry(round, "x".repeat(400)));
  const context = buildInterpretationContext(entries, 1000);
  assert.ok(context.includes("【第 1 轮影像判读】"), "earliest baseline must survive");
  assert.ok(context.includes("【第 5 轮影像判读】"), "most recent must survive");
  assert.ok(/【已省略第 2–\d 轮影像判读】/u.test(context), context);
  assert.ok(context.length <= 1000 + 128);
});

test("the default budget is 60000 characters", () => {
  assert.equal(MAX_INTERPRETATION_CHARS, 60000);
});
