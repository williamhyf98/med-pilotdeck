/**
 * PHI (Protected Health Information) redaction for long-term memory writes.
 *
 * All long-term memory notes pass through `redact()` before hitting disk.
 * This is a rule-based, regex-only module — no external NLP dependencies.
 * Rules cover the hard minimum from §3.6 of the memory redesign plan.
 *
 * What is redacted (§3.6):
 *   - Chinese national ID numbers (18-digit, last char may be X)
 *   - Chinese mobile phone numbers (1[3-9]XXXXXXXXX)
 *   - Precise birth dates carrying a day component
 *   - Medical record / hospitalization / outpatient numbers (keyword-prefixed)
 *   - Medical imaging file paths (.dcm / .dicom / .nii / .nii.gz / .ima / .img)
 *   - Detailed addresses (best-effort: keyword-prefixed street-level patterns)
 *
 * What is intentionally NOT redacted:
 *   - Year-month expressions without a day ("2026年3月", "March 2026")
 *   - Dose / weight expressions ("5 mg/kg", "0.1 mL")
 *   - Classification codes ("WHO 分级 II 级", "AIS 3")
 *   - Age or age-range expressions ("35岁", "30-40 岁")
 *
 * The exported `PHI_POLICY_DESCRIPTION` constant is the single source of truth
 * for what this module enforces; `prompts/shared.ts` interpolates it into the
 * extraction prompts so the prompts and the code never diverge.
 */

export type RedactResult = {
  /** Body text with all PHI replaced by placeholder tokens. */
  text: string;
  /** Total number of matches replaced across all rules. */
  removedCount: number;
  /** Rule labels that fired at least once, for audit / trace recording. */
  hits: string[];
};

type PhiRule = {
  label: string;
  pattern: RegExp;
  replacement: string;
};

// ── Rule set ─────────────────────────────────────────────────────────────────

const RULES: PhiRule[] = [
  {
    label: "id-number",
    // Chinese national ID: 17 digits followed by a digit or X/x
    pattern: /\b\d{17}[\dXx]\b/g,
    replacement: "[ID号已脱敏]",
  },
  {
    label: "phone-cn",
    // Chinese mobile: 1 followed by 3-9, then 9 digits
    pattern: /\b1[3-9]\d{9}\b/g,
    replacement: "[手机号已脱敏]",
  },
  {
    label: "precise-dob",
    // Precise dates that include a day: YYYY年M月D日 — year-month alone ("2026年3月") does NOT match
    pattern: /\d{4}年\d{1,2}月\d{1,2}日/g,
    replacement: "[精确日期已脱敏]",
  },
  {
    label: "precise-dob-iso",
    // ISO-style date with explicit DOB context keyword only — avoids redacting every ISO timestamp
    pattern: /(?:出生(?:日期|于|年月日)|生日|DOB|birth\s*date)[：:\s为upon]*\d{4}[-/]\d{1,2}[-/]\d{1,2}/gi,
    replacement: "[出生日期已脱敏]",
  },
  {
    label: "medical-record-no",
    // Medical record / hospitalization / outpatient number with preceding label
    pattern: /(?:病历号|住院号|门诊号)[：:\s]*[A-Za-z0-9][A-Za-z0-9\-]{2,19}/g,
    replacement: "[病历号已脱敏]",
  },
  {
    label: "imaging-path",
    // Medical imaging file names / paths (DICOM and common research formats)
    pattern: /\S+\.(?:dcm|dicom|nii(?:\.gz)?|ima|img|mha|nrrd|vtk)\b/gi,
    replacement: "[影像路径已脱敏]",
  },
  {
    label: "detailed-address",
    // Best-effort: street-level address patterns with house numbers
    // Matches patterns like "朝阳区建国路88号", "北京市海淀区中关村大街1号"
    pattern: /[一-鿿]{2,6}(?:省|市|区|县|镇|乡|街|路|巷|弄|号|栋|楼|室|单元){1,2}\d+号?/g,
    replacement: "[地址已脱敏]",
  },
];

// ── Core function ────────────────────────────────────────────────────────────

/**
 * Redact PHI from a memory note body.
 *
 * All rules run against a single pass of the text; the order matters only
 * when two patterns could match the same substring — more specific rules
 * (medical-record-no) appear before less specific ones.
 *
 * Returns the cleaned text, total replacement count, and the set of rule
 * labels that fired at least once (for trace / audit recording by the caller).
 */
export function redact(text: string): RedactResult {
  const hits: string[] = [];
  let removedCount = 0;
  let current = text;

  for (const rule of RULES) {
    // Reset lastIndex so /g patterns start from the beginning each call
    rule.pattern.lastIndex = 0;
    const matches = current.match(rule.pattern);
    if (matches && matches.length > 0) {
      hits.push(rule.label);
      removedCount += matches.length;
      rule.pattern.lastIndex = 0;
      current = current.replace(rule.pattern, rule.replacement);
    }
  }

  return { text: current, removedCount, hits };
}

// ── Prompt fragment ──────────────────────────────────────────────────────────

/**
 * Single-source description of what this policy enforces.
 * Import this in `prompts/shared.ts` and interpolate into the extraction
 * system prompts so the prompts and the enforcement code stay in sync.
 */
export const PHI_POLICY_DESCRIPTION = `\
以下信息一律不得出现在任何长期记忆条目中：
- 真实姓名（患者姓名、身份证姓名）
- 身份证号
- 病历号 / 住院号 / 门诊号
- 手机号或任何联系电话
- 详细住址（精确到门牌号或房间号）
- 精确出生日期（含日的日期；只保留年龄或年龄段）
- 医学影像文件的原始路径或文件名（.dcm / .dicom / .nii 等）

允许保留：年龄或年龄段、年月（不含日）、剂量与体重表达（5 mg/kg）、分类编码（WHO 分级 II 级、AIS 3）。\
`;
