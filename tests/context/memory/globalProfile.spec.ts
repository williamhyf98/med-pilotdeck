/**
 * Tests for the global user-profile identity/specialty structure.
 *
 * Run: pnpm exec tsx --test tests/context/memory/globalProfile.spec.ts
 *
 * These are unit tests of the pure builder; no LLM calls are made.
 * PHI protection relies on MemoryPrivacyPolicy applied inside the builder;
 * the full disk-write filter (writeRecord) is an additional layer tested
 * separately in privacy.spec.ts.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildUserProfileBodyFromParsedSections } from "../../../src/context/memory/edgeclaw-memory-core/src/core/skills/llm-extraction.js";

// ── Compatibility: legacy single-section profile ──────────────────────────

describe("globalProfile — backward-compat: legacy single-section input", () => {
  test("only identity_background_markdown populated → body has exactly ## 身份背景, no other headings", () => {
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: "- 外科主任医师\n- 北京协和医院",
    });
    assert.ok(body !== null, "result should not be null");
    assert.ok(body!.includes("## 身份背景"), "## 身份背景 must be present");
    assert.ok(body!.includes("外科主任医师"), "identity content must be preserved");
    assert.ok(!body!.includes("## 专业领域"), "## 专业领域 must be absent");
    assert.ok(!body!.includes("## 临床偏好"), "## 临床偏好 must be absent");
  });

  test("all profile fields undefined → returns null (no content to write)", () => {
    const body = buildUserProfileBodyFromParsedSections({});
    assert.equal(body, null);
  });

  test("identity_background_markdown is empty string → returns null", () => {
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: "",
    });
    assert.equal(body, null);
  });

  test("existing profile with only ## 身份背景 section can be round-tripped without data loss", () => {
    // Simulate: the LLM rewrites from an old single-section profile and returns
    // only identity_background_markdown (no specialty or preference content yet).
    const incoming = "- 急诊外科，执业 12 年\n- 擅长战创伤救治";
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: incoming,
      specialty_markdown: "",
    });
    assert.ok(body !== null);
    assert.ok(body!.includes("急诊外科，执业 12 年"), "original content preserved");
    assert.ok(!body!.includes("## 专业领域"), "empty specialty must be omitted");
    assert.ok(!body!.includes("## 临床偏好"), "null preference must be omitted");
  });
});

// ── Two-section output ─────────────────────────────────────────────────────

describe("globalProfile — identity and specialty output", () => {
  test("legacy clinical preference input is omitted from the rewritten profile", () => {
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: "- 主任医师，心血管外科",
      specialty_markdown: "- 冠状动脉旁路移植术\n- 瓣膜修复",
      clinical_preference_markdown: "- 优先评估保守治疗可行性\n- 需要给出剂量范围",
    });
    assert.ok(body !== null);
    assert.ok(body!.includes("## 身份背景"), "## 身份背景 must be present");
    assert.ok(body!.includes("## 专业领域"), "## 专业领域 must be present");
    assert.ok(!body!.includes("## 临床偏好"), "legacy preference section must be omitted");
    assert.ok(!body!.includes("需要给出剂量范围"), "legacy preference content must be omitted");
  });

  test("sections appear in canonical order: 身份背景 before 专业领域", () => {
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: "- 内科主治医师",
      specialty_markdown: "- 呼吸科",
    })!;
    const bgIdx = body.indexOf("## 身份背景");
    const spIdx = body.indexOf("## 专业领域");
    assert.ok(bgIdx < spIdx, "身份背景 before 专业领域");
  });

  test("section with content only — omits sections that are absent", () => {
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: "- 麻醉科副主任医师",
      specialty_markdown: "- 神经外科麻醉",
    })!;
    assert.ok(body.includes("## 身份背景"));
    assert.ok(body.includes("## 专业领域"));
    assert.ok(!body.includes("## 临床偏好"));
  });

  test("LLM returns section markdown with the heading included — heading stripped, no duplication", () => {
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: "## 身份背景\n- 骨科医师",
      specialty_markdown: "## 专业领域\n- 脊柱外科",
    })!;
    const headingMatches = (body.match(/## 身份背景/g) ?? []).length;
    assert.equal(headingMatches, 1, "## 身份背景 must appear exactly once");
    const spHeadingMatches = (body.match(/## 专业领域/g) ?? []).length;
    assert.equal(spHeadingMatches, 1, "## 专业领域 must appear exactly once");
  });
});

// ── PHI protection at the builder layer ───────────────────────────────────

describe("globalProfile — PHI redaction applied before returning body", () => {
  test("ID number accidentally in identity section is stripped", () => {
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: "- 身份证：110101199001011234\n- 骨科主任",
    })!;
    assert.ok(!body.includes("110101199001011234"), "raw ID number must not appear in body");
    assert.ok(body.includes("[ID号已脱敏]"), "placeholder must be present");
    assert.ok(body.includes("骨科主任"), "non-PHI content must be preserved");
  });

  test("imaging path accidentally in specialty section is stripped", () => {
    const body = buildUserProfileBodyFromParsedSections({
      specialty_markdown: "- 影像参考：/data/scans/patient.dcm",
    })!;
    assert.ok(!body.includes("patient.dcm"), "imaging path must be stripped");
  });
});

// ── Empty / null / array input handling ───────────────────────────────────

describe("globalProfile — input normalization edge cases", () => {
  test("section value is an array of strings → joined as bullet list", () => {
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: ["急诊主任医师", "北京协和医院急诊科"],
    })!;
    assert.ok(body.includes("## 身份背景"));
    assert.ok(body.includes("急诊主任医师"));
  });

  test("section value is a non-string non-array (number) → treated as empty, section omitted", () => {
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: 42 as unknown as string,
    });
    assert.equal(body, null);
  });

  test("section value contains only whitespace → section omitted", () => {
    const body = buildUserProfileBodyFromParsedSections({
      identity_background_markdown: "   \n\n   ",
      specialty_markdown: "- 心内科",
    })!;
    assert.ok(!body.includes("## 身份背景"), "whitespace-only section must be omitted");
    assert.ok(body.includes("## 专业领域"));
  });
});
