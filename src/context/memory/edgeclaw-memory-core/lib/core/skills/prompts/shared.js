/**
 * Single source of truth for prompt fragments shared across all profile archives.
 *
 * Do NOT copy-paste these strings into individual profile files. Interpolate them.
 * If a fragment needs to change, change it here once and both profiles inherit the update.
 */
// ── Primitive fragments ─────────────────────────────────────────────────────
export const JSON_ONLY_RULE = "- 只返回 JSON。";
export const OVERRIDE_TEST = "- 覆盖测试：如果另一个项目可以合理地覆盖这条规则或偏好，它就不属于 user；应分类为 feedback。";
/**
 * Three-line language-follow block that appears verbatim in every note-create prompt.
 * No trailing newline — the template literal supplies the surrounding newlines.
 */
export const LANGUAGE_FOLLOW_RULES = "- 可见输出的语言必须跟随焦点用户轮次及相邻用户轮次中的主要语言。\n"
    + "- 如果上下文混合使用多种语言，优先采用焦点用户轮次的语言，其次采用最近相邻用户轮次的语言。\n"
    + "- 标题/name、description、Markdown 标题和 Markdown 正文都必须一致遵循该语言规则。";
// ── JSON contract shapes ────────────────────────────────────────────────────
export const CLASSIFY_JSON_CONTRACT = `严格使用以下 JSON 结构：
{
  "should_store": true,
  "labels": [
    {
      "type": "user | project | feedback",
      "reason": "为什么适用该类别",
      "evidence": "焦点轮次中的简短原文或证据摘要"
    }
  ]
}`;
/**
 * Build the note-create JSON contract for a specific note kind.
 * The only variation between kinds is the "name" example string.
 */
export function buildNoteCreateJsonContract(kind) {
    return `严格使用以下 JSON 结构：
{
  "skip": false,
  "reason": "",
  "name": "简短的 ${kind} 记忆标题",
  "description": "单行描述",
  "markdown": "Markdown 正文"
}`;
}
// ── Singleton shared object ─────────────────────────────────────────────────
/**
 * Exported as a single object so profiles can hold a reference and tests can
 * assert identity (===) rather than equality — proving no copy was made.
 */
export const SHARED_FRAGMENTS = {
    jsonOnlyRule: JSON_ONLY_RULE,
    overrideTest: OVERRIDE_TEST,
    languageFollowRules: LANGUAGE_FOLLOW_RULES,
};
