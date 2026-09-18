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
export declare function redact(text: string): RedactResult;
/**
 * Single-source description of what this policy enforces.
 * Import this in `prompts/shared.ts` and interpolate into the extraction
 * system prompts so the prompts and the enforcement code stay in sync.
 */
export declare const PHI_POLICY_DESCRIPTION = "\u4EE5\u4E0B\u4FE1\u606F\u4E00\u5F8B\u4E0D\u5F97\u51FA\u73B0\u5728\u4EFB\u4F55\u957F\u671F\u8BB0\u5FC6\u6761\u76EE\u4E2D\uFF1A\n- \u771F\u5B9E\u59D3\u540D\uFF08\u60A3\u8005\u59D3\u540D\u3001\u8EAB\u4EFD\u8BC1\u59D3\u540D\uFF09\n- \u8EAB\u4EFD\u8BC1\u53F7\n- \u75C5\u5386\u53F7 / \u4F4F\u9662\u53F7 / \u95E8\u8BCA\u53F7\n- \u624B\u673A\u53F7\u6216\u4EFB\u4F55\u8054\u7CFB\u7535\u8BDD\n- \u8BE6\u7EC6\u4F4F\u5740\uFF08\u7CBE\u786E\u5230\u95E8\u724C\u53F7\u6216\u623F\u95F4\u53F7\uFF09\n- \u7CBE\u786E\u51FA\u751F\u65E5\u671F\uFF08\u542B\u65E5\u7684\u65E5\u671F\uFF1B\u53EA\u4FDD\u7559\u5E74\u9F84\u6216\u5E74\u9F84\u6BB5\uFF09\n- \u533B\u5B66\u5F71\u50CF\u6587\u4EF6\u7684\u539F\u59CB\u8DEF\u5F84\u6216\u6587\u4EF6\u540D\uFF08.dcm / .dicom / .nii \u7B49\uFF09\n\n\u5141\u8BB8\u4FDD\u7559\uFF1A\u5E74\u9F84\u6216\u5E74\u9F84\u6BB5\u3001\u5E74\u6708\uFF08\u4E0D\u542B\u65E5\uFF09\u3001\u5242\u91CF\u4E0E\u4F53\u91CD\u8868\u8FBE\uFF085 mg/kg\uFF09\u3001\u5206\u7C7B\u7F16\u7801\uFF08WHO \u5206\u7EA7 II \u7EA7\u3001AIS 3\uFF09\u3002";
