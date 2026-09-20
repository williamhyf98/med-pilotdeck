/**
 * Tests for MemoryPrivacyPolicy — Task 3 of the memory module redesign.
 *
 * Run: pnpm exec tsx --test tests/context/memory/privacy.spec.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../../../src/context/memory/MemoryPrivacyPolicy.js";

// ── PHI that must be redacted ─────────────────────────────────────────────

describe("MemoryPrivacyPolicy — must redact PHI", () => {
  test("Chinese national ID number (18-digit with digit check)", () => {
    const { text, removedCount, hits } = redact("患者身份证号：110101199001011234，已登记。");
    assert.ok(!text.includes("110101199001011234"), "ID number must be removed");
    assert.ok(text.includes("[ID号已脱敏]"), "placeholder must be present");
    assert.equal(removedCount, 1);
    assert.ok(hits.includes("id-number"));
  });

  test("Chinese national ID number ending in X", () => {
    const { text, removedCount } = redact("证件号 34052419800101001X。");
    assert.ok(!text.includes("34052419800101001X"), "ID with X suffix must be removed");
    assert.equal(removedCount, 1);
  });

  test("Chinese mobile phone number", () => {
    const { text, removedCount, hits } = redact("联系电话：13812345678，请回拨。");
    assert.ok(!text.includes("13812345678"), "phone must be removed");
    assert.ok(text.includes("[手机号已脱敏]"), "placeholder must be present");
    assert.equal(removedCount, 1);
    assert.ok(hits.includes("phone-cn"));
  });

  test("precise birth date with day (YYYY年M月D日)", () => {
    const { text, removedCount, hits } = redact("患者出生于1985年3月15日，现年41岁。");
    assert.ok(!text.includes("1985年3月15日"), "precise date must be removed");
    assert.ok(text.includes("[精确日期已脱敏]"), "placeholder must be present");
    assert.ok(text.includes("41岁"), "age may remain");
    assert.equal(removedCount, 1);
    assert.ok(hits.includes("precise-dob"));
  });

  test("birth date with DOB keyword (ISO-style)", () => {
    const { text, removedCount, hits } = redact("DOB: 1990/06/20, admitted today.");
    assert.ok(!text.includes("1990/06/20"), "ISO date with DOB keyword must be removed");
    assert.equal(removedCount, 1);
    assert.ok(hits.includes("precise-dob-iso"));
  });

  test("medical record number with label", () => {
    const { text, removedCount, hits } = redact("病历号：B20240012345 已归档。");
    assert.ok(!text.includes("B20240012345"), "record number must be removed");
    assert.ok(text.includes("[病历号已脱敏]"), "placeholder must be present");
    assert.equal(removedCount, 1);
    assert.ok(hits.includes("medical-record-no"));
  });

  test("hospitalization number with label", () => {
    const { text, removedCount } = redact("住院号：H2024-00567 对应的入院记录已上传。");
    assert.ok(!text.includes("H2024-00567"), "hospitalization number must be removed");
    assert.equal(removedCount, 1);
  });

  test("DICOM imaging file path (.dcm)", () => {
    const { text, removedCount, hits } = redact("上传了 /data/patients/p001/scan.dcm 进行分析。");
    assert.ok(!text.includes("scan.dcm"), "imaging path must be removed");
    assert.ok(text.includes("[影像路径已脱敏]"), "placeholder must be present");
    assert.equal(removedCount, 1);
    assert.ok(hits.includes("imaging-path"));
  });

  test("NIfTI imaging file (.nii.gz)", () => {
    const { text, removedCount } = redact("文件 brain_mri.nii.gz 已处理。");
    assert.ok(!text.includes("brain_mri.nii.gz"), "nii.gz path must be removed");
    assert.equal(removedCount, 1);
  });

  test("detailed street address", () => {
    const { text, removedCount, hits } = redact("患者居住在朝阳区建国路88号，就近就诊。");
    assert.ok(!text.includes("朝阳区建国路88号"), "detailed address must be removed");
    assert.equal(removedCount, 1);
    assert.ok(hits.includes("detailed-address"));
  });

  test("multiple PHI items in one note — all removed, count is correct", () => {
    const input = [
      "患者身份证：110101199001011234",
      "手机：13812345678",
      "病历号：A20230099",
      "影像：chest.dcm",
    ].join("，");
    const { text, removedCount } = redact(input);
    assert.ok(!text.includes("110101199001011234"));
    assert.ok(!text.includes("13812345678"));
    assert.ok(!text.includes("A20230099"));
    assert.ok(!text.includes("chest.dcm"));
    assert.equal(removedCount, 4);
  });
});

// ── Allowable medical expressions that must NOT be redacted ──────────────

describe("MemoryPrivacyPolicy — must NOT redact allowed medical expressions", () => {
  test("dose expression (5 mg/kg)", () => {
    const { text, removedCount } = redact("建议剂量为5mg/kg，静脉注射。");
    assert.equal(removedCount, 0, "dose expression must not be removed");
    assert.ok(text.includes("5mg/kg"));
  });

  test("year-month without day (2026年3月)", () => {
    const { text, removedCount } = redact("2026年3月首次就诊，症状持续两周。");
    assert.equal(removedCount, 0, "year-month must not be removed");
    assert.ok(text.includes("2026年3月"));
  });

  test("age or age range", () => {
    const { text, removedCount } = redact("患者35岁，常规30-40岁人群发病率较高。");
    assert.equal(removedCount, 0, "age expressions must not be removed");
    assert.ok(text.includes("35岁"));
    assert.ok(text.includes("30-40岁"));
  });

  test("WHO classification code", () => {
    const { text, removedCount } = redact("病理分级 WHO 分级 II 级，属中度。");
    assert.equal(removedCount, 0, "classification codes must not be removed");
    assert.ok(text.includes("WHO 分级 II 级"));
  });

  test("AIS trauma score", () => {
    const { text, removedCount } = redact("头部 AIS 3 分，躯干 AIS 2 分。");
    assert.equal(removedCount, 0, "AIS scores must not be removed");
    assert.ok(text.includes("AIS 3"));
  });

  test("volume/weight measurement without PHI context", () => {
    const { text, removedCount } = redact("给予0.9% NaCl 500mL，输注速率 100mL/h。");
    assert.equal(removedCount, 0, "volume measurements must not be removed");
  });

  test("empty string is a no-op", () => {
    const { text, removedCount, hits } = redact("");
    assert.equal(text, "");
    assert.equal(removedCount, 0);
    assert.deepEqual(hits, []);
  });

  test("text with no PHI is returned unchanged", () => {
    const input = "患者偏好使用 SOAP 格式汇报，每次换班后更新一次病情摘要。";
    const { text, removedCount } = redact(input);
    assert.equal(text, input);
    assert.equal(removedCount, 0);
  });
});

// ── Return shape ───────────────────────────────────────────────────────────

describe("MemoryPrivacyPolicy — return shape", () => {
  test("redact() returns { text, removedCount, hits } with correct types", () => {
    const result = redact("联系我：13912345678");
    assert.equal(typeof result.text, "string");
    assert.equal(typeof result.removedCount, "number");
    assert.ok(Array.isArray(result.hits));
  });

  test("hits array contains only rules that actually fired", () => {
    const { hits } = redact("病历号：C20240001，无其他敏感信息。");
    assert.ok(hits.includes("medical-record-no"), "fired rule must appear");
    assert.ok(!hits.includes("id-number"), "non-firing rule must not appear");
    assert.ok(!hits.includes("phone-cn"), "non-firing rule must not appear");
  });
});
