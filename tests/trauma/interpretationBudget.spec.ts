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

test("a total exactly at the budget is not truncated", () => {
  const maxChars = 500;
  const prefixLength = buildInterpretationContext([entry(1, "")], Number.MAX_SAFE_INTEGER).length;
  const exact = entry(1, "x".repeat(maxChars - prefixLength));
  const full = buildInterpretationContext([exact], Number.MAX_SAFE_INTEGER);
  assert.equal(full.length, maxChars);

  const context = buildInterpretationContext([exact], maxChars);
  assert.equal(context, full);
  assert.ok(!context.includes("已截断"));
  assert.ok(!context.includes("已省略"));
});

test("one character over the budget triggers truncation", () => {
  const maxChars = 500;
  const prefixLength = buildInterpretationContext([entry(1, "")], Number.MAX_SAFE_INTEGER).length;
  const overEntry = entry(1, "x".repeat(maxChars - prefixLength + 1));
  const full = buildInterpretationContext([overEntry], Number.MAX_SAFE_INTEGER);
  assert.equal(full.length, maxChars + 1);

  const context = buildInterpretationContext([overEntry], maxChars);
  assert.ok(context.length <= maxChars);
  assert.notEqual(context, full);
});

test("a single entry that alone exceeds the budget is clipped even with other entries present", () => {
  const maxChars = 1000;
  const entries = [entry(1, "x".repeat(5000)), entry(2, "small"), entry(3, "small")];
  const context = buildInterpretationContext(entries, maxChars);
  assert.ok(context.length <= maxChars, `expected length <= ${maxChars}, got ${context.length}`);
  assert.ok(context.includes("【第 1 轮影像判读】"), "baseline must still be present");
});
