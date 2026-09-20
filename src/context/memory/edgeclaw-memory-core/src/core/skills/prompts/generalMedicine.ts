/**
 * General-medicine prompt profile.
 *
 * The 4 prompt strings here are verbatim copies of the constants that lived in
 * llm-extraction.ts before Task 5. They are the baselines; Task 11 will edit
 * them (medical specialisation). Do NOT change these strings in Task 5 — the
 * prompts.test.ts snapshot is the correctness gate.
 *
 * llm-extraction.ts re-exports the 4 constants by reading from this profile so
 * that the snapshot test still imports from the same path it always did.
 */

import type { MemoryPromptProfile } from "./types.js";
import { SHARED_FRAGMENTS } from "./shared.js";

export const GENERAL_MEDICINE_PROFILE: MemoryPromptProfile = {
  type: "general_medicine",
  allowedTypes: ["user", "project", "feedback"],
  shared: SHARED_FRAGMENTS,

  classify: `你负责为长期记忆索引流水线分类一个焦点用户轮次。

你只负责判断类别，此时不要生成记忆文件。

规则：
- 首先以焦点用户轮次作为判断依据。
- 只能使用相邻的用户/助手轮次来消除焦点轮次中的歧义。
- 助手文本仅作为上下文。绝不能分类仅存在于助手表述中的内容。
- 一个轮次可以匹配多个类别，但每个类别最多出现一次。
- 允许的类别：
  - user：关于用户是谁的、跨项目持久有效的个人身份/背景事实，例如姓名、职业、长期角色背景、人生背景或持久关系背景。
  - project：当前项目中持久有效的事实，例如项目是什么、目标、范围、重要进展、阻塞、风险和关键决策。
  - feedback：当前项目的协作规则、交付规则、输出结构、标题/正文模板规则、已确认的风格指导、语言规则及文件/工具边界。
- 身份测试：仅当焦点轮次是在描述用户本人时，才使用 user。
- 覆盖测试：如果另一个项目可以合理地覆盖这条规则或偏好，它就不属于 user；应分类为 feedback。
- 输出测试：如果该轮次在约束助手如何回复、写作、格式化、交付或操作文件/工具，应分类为 feedback。
- project 记忆应优先保留稳定事实。短期进度流转、百分比或临时排期不应分类为 project，除非它们体现了持久的阻塞、风险或事实。
- 如果用户明确说“请记住”“帮我记住”或“remember this”，将其视为需要持久记忆的更强信号，但仍只能根据可见的用户文本推断。
- 如果没有值得持久记忆的内容，返回 should_store=false 且 labels=[]。
- 只返回 JSON。

严格使用以下 JSON 结构：
{
  "should_store": true,
  "labels": [
    {
      "type": "user | project | feedback",
      "reason": "为什么适用该类别",
      "evidence": "焦点轮次中的简短原文或证据摘要"
    }
  ]
}`,

  noteCreate: {
    user: `你根据一个焦点用户轮次创建一条仅追加的 user 记忆笔记。

规则：
- 最多创建一条 user 笔记。
- 笔记只能记录关于用户是谁的、跨项目持久有效的个人身份/背景信息。
- 只保留长期有效的身份事实，例如姓名、职业、稳定角色背景、人生背景或持久关系背景。
- 不要包含语言选择、回答结构、格式习惯、风格偏好、文件边界、工具边界或项目特定的协作规则。
- 一条笔记应表达一项持久的身份/背景事实，而不是重写完整画像。
- 可见输出的语言必须跟随焦点用户轮次及相邻用户轮次中的主要语言。
- 如果上下文混合使用多种语言，优先采用焦点用户轮次的语言，其次采用最近相邻用户轮次的语言。
- 标题/name、description、Markdown 标题和 Markdown 正文都必须一致遵循该语言规则。
- 保持笔记为可读的 Markdown。
- 不要强制套用固定画像模板。仅在确实有助于阅读时使用标题。
- 只返回 JSON。

严格使用以下 JSON 结构：
{
  "skip": false,
  "reason": "",
  "name": "简短的 user 记忆标题",
  "description": "单行描述",
  "markdown": "Markdown 正文"
}`,

    project: `你根据一个焦点用户轮次创建一条仅追加的 project 记忆笔记。

规则：
- 最多创建一条 project 笔记。
- 该笔记只属于当前项目。
- 记录持久的项目事实：项目是什么、稳定范围、目标、关键进展、阻塞、风险、重要决策和重要后续步骤。
- 不要把笔记简化成含糊的状态句。
- 不要聚焦于高度易变的百分比、临时排期或琐碎的短期更新，除非它们揭示了持久的阻塞、风险或事实。
- 可见输出的语言必须跟随焦点用户轮次及相邻用户轮次中的主要语言。
- 如果上下文混合使用多种语言，优先采用焦点用户轮次的语言，其次采用最近相邻用户轮次的语言。
- 标题/name、description、Markdown 标题和 Markdown 正文都必须一致遵循该语言规则。
- 保持笔记为可读的 Markdown。
- 适合时优先使用有意义的标题，例如：## 摘要、## 当前阶段、## 约束、## 阻塞、## 后续步骤、## 时间线、## 备注。
- 只返回 JSON。

严格使用以下 JSON 结构：
{
  "skip": false,
  "reason": "",
  "name": "简短的 project 记忆标题",
  "description": "单行描述",
  "markdown": "Markdown 正文"
}`,

    feedback: `你根据一个焦点用户轮次创建一条仅追加的 feedback 记忆笔记。

规则：
- 最多创建一条 feedback 笔记。
- 该笔记只属于当前项目。
- feedback 用于记录协作规则、交付顺序、风格约束、标题/正文模板规则、已确认的输出预期、语言规则及文件/工具边界。
- 可见输出的语言必须跟随焦点用户轮次及相邻用户轮次中的主要语言。
- 如果上下文混合使用多种语言，优先采用焦点用户轮次的语言，其次采用最近相邻用户轮次的语言。
- 标题/name、description、Markdown 标题和 Markdown 正文都必须一致遵循该语言规则。
- 保持笔记为可读的 Markdown。
- 适合时优先使用有意义的标题，尤其是：## 规则、## 原因、## 应用方式、## 备注。
- 只返回 JSON。

严格使用以下 JSON 结构：
{
  "skip": false,
  "reason": "",
  "name": "简短的 feedback 记忆标题",
  "description": "单行描述",
  "markdown": "Markdown 正文"
}`,
  },
};
