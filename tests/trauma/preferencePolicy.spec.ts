import assert from "node:assert/strict";
import test from "node:test";

import { validateTraumaPreferences } from "../../src/trauma/memory/TraumaPreferencePolicy.js";

test("accepts an exact-source presentation preference", () => {
  const result = validateTraumaPreferences({
    rawText: "以后先给结论。患者右腿持续出血。",
    preferences: [{
      sourceSpan: "以后先给结论",
      directive: "回答时先给结论",
      category: "format",
    }],
  });

  assert.deepEqual(result.accepted, [{
    sourceSpan: "以后先给结论",
    directive: "回答时先给结论",
    category: "format",
    redactedCount: 0,
    redactedHits: [],
  }]);
  assert.deepEqual(result.rejected, []);
});

test("rejects a preference whose source span is not present in the user input", () => {
  const result = validateTraumaPreferences({
    rawText: "以后先给结论。",
    preferences: [{
      sourceSpan: "以后使用表格",
      directive: "回答时使用表格",
      category: "format",
    }],
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "source_span_mismatch");
});

test("rejects preference spans containing clinical facts", () => {
  const result = validateTraumaPreferences({
    rawText: "以后把患者心率 130 放在标题里。",
    preferences: [{
      sourceSpan: "以后把患者心率 130 放在标题里",
      directive: "把患者心率 130 放在标题里",
      category: "format",
    }],
  });

  assert.equal(result.accepted.length, 0);
  assert.equal(result.rejected[0]?.reason, "clinical_content");
});

test("redacts PHI from an accepted preference directive", () => {
  const result = validateTraumaPreferences({
    rawText: "以后联系信息统一写成值班电话，号码是 13800138000。",
    preferences: [{
      sourceSpan: "以后联系信息统一写成值班电话，号码是 13800138000",
      directive: "联系信息统一写成值班电话 13800138000",
      category: "workflow",
    }],
  });

  assert.equal(result.accepted.length, 1);
  assert.doesNotMatch(result.accepted[0]?.directive ?? "", /13800138000/u);
  assert.equal(result.accepted[0]?.redactedCount, 1);
  assert.deepEqual(result.accepted[0]?.redactedHits, ["phone-cn"]);
});
