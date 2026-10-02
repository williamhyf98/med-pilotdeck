import assert from "node:assert/strict";
import test from "node:test";

import {
  BROKEN_CRITERIA_REVIEWS,
  isBenchmarkReviewUsable,
  partitionUsableReviews,
} from "../../src/meta/benchmark/knownIssues.js";

test("known-issue registry skips broken-criteria reviews but keeps the reasons visible", () => {
  // 2026-10-02 审计出的 5 篇：P/I 为空或抽错章节，任何策略下都接近 0 分。
  assert.deepEqual(
    Object.keys(BROKEN_CRITERIA_REVIEWS).sort(),
    ["CD010841", "CD013387", "CD014745", "CD015436", "CD015456"],
  );
  assert.equal(isBenchmarkReviewUsable("CD000259"), true);
  assert.equal(isBenchmarkReviewUsable("CD013387"), false);

  const { usable, skipped } = partitionUsableReviews(["CD000259", "CD013387", "CD013562"]);
  assert.deepEqual(usable, ["CD000259", "CD013562"]);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0]?.id, "CD013387");
  assert.match(skipped[0]?.reason ?? "", /经济学评价章节/);
});
