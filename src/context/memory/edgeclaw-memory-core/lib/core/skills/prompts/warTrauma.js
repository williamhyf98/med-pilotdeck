/**
 * War-trauma prompt profile.
 *
 * Captures only feedback-type collaboration rules from war-trauma sessions.
 * User and project note creation are intentionally absent — the hard gate in
 * LlmMemoryExtractor enforces this at the code level (allowedTypes), so even if
 * the classifier somehow returns a user/project label it is discarded.
 *
 * The classification prompt deliberately limits itself to the feedback/discard
 * binary: it does not attempt three-way classification. PHI categories listed
 * explicitly to make it clear that war-trauma session content must not leak into
 * long-term memory.
 */
import { SHARED_FRAGMENTS } from "./shared.js";
export const WAR_TRAUMA_PROFILE = {
    type: "war_trauma",
    allowedTypes: ["feedback"],
    shared: SHARED_FRAGMENTS,
    classify: `你负责在战创伤模式下，为长期记忆索引流水线分类一个焦点用户轮次。

战创伤模式只允许存储协作规则（feedback），不允许创建用户身份笔记或项目笔记。

规则：
- 首先以焦点用户轮次作为判断依据。
- 只能使用相邻的用户/助手轮次来消除焦点轮次中的歧义。
- 助手文本仅作为上下文。绝不能分类仅存在于助手表述中的内容。
- 唯一可存储的类别是 feedback：当前会话的协作规则、交付规则、输出结构、标题/正文模板规则、已确认的风格指导、语言规则及文件/工具边界。
- 如果该轮次包含生命体征、损伤严重度评分、复苏阶段、患者标识、影像学发现或任何患者临床数据，返回 should_store=false。这些内容绝不能进入长期记忆。
- 如果该轮次描述的是用户本人（身份），返回 should_store=false。身份事实应通过全局画像重写处理，而不是在这里处理。
- 如果该轮次描述项目进展、目标或事件，返回 should_store=false。
- 如果没有可存储内容，返回 should_store=false 且 labels=[]。
- 只返回 JSON。

严格使用以下 JSON 结构：
{
  "should_store": true,
  "labels": [
    {
      "type": "feedback",
      "reason": "为什么应存储该协作规则",
      "evidence": "焦点轮次中的简短原文或证据摘要"
    }
  ]
}`,
    noteCreate: {
        feedback: `你根据战创伤会话中的一个焦点用户轮次，创建一条仅追加的 feedback 记忆笔记。

规则：
- 最多创建一条 feedback 笔记。
- 该笔记只属于当前项目。
- feedback 只能用于记录协作规则、交付规则、输出结构、已确认的风格指导、语言规则及文件/工具边界。
- 不得存储生命体征、损伤严重度评分、复苏阶段、患者标识、影像文件路径或任何患者临床数据。如果该轮次包含这些内容，返回 skip=true。
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
