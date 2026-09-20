import type { StructuredModelClient } from "../../trauma/modelClient.js";

/**
 * 从一段用户与助手的完整对话中，用一次结构化模型调用萃取出可复用的
 * 技能草稿（SKILL.md 的 name/slug/description/body 四要素）。
 *
 * 结构与 `src/trauma/stations/extractor.ts` 保持一致：纯"文本进、JSON 出"，
 * 模型客户端由调用方注入（见 createLocalGateway 的 ProjectRuntimeRegistry）。
 */

export interface SkillDraft {
  name: string;
  slug: string;
  description: string;
  body: string;
}

/**
 * 草稿素材的来源：`conversation` 为聊天会话全文（默认），`flow` 为用户在
 * 流程图画布上绘制的工作流的文字化描述（节点 + 连线）。两者共用同一套
 * schema/校验/归一化，仅提示词与用户消息的措辞不同。
 */
export type SkillDraftSource = "conversation" | "flow";

export interface SkillDraftInput {
  conversation: string;
  existingSlugs?: string[];
  source?: SkillDraftSource;
}

export interface SkillDraftStation {
  generate(input: SkillDraftInput): Promise<SkillDraft>;
}

/** 与 SkillManager 的 SLUG_RE 保持同一规则（目录名安全、防路径穿越）。 */
export const SKILL_SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

/** strict 模式：additionalProperties:false 且 required 覆盖全部字段。 */
export const SKILL_DRAFT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "slug", "description", "body"],
  properties: {
    name: {
      type: "string",
      description: "技能的人类可读名称，简短（建议不超过 20 个字），一眼看出用途",
    },
    slug: {
      type: "string",
      description:
        "技能目录名：仅字母、数字、点、下划线、连字符，以字母或数字开头，全小写，长度不超过 100",
    },
    description: {
      type: "string",
      description: "一段话说明何时应使用该技能及其产出，助手仅凭这段话决定是否加载",
    },
    body: {
      type: "string",
      description:
        "Markdown 正文：用途概述、适用场景、所需输入、操作步骤、输出格式、注意事项",
    },
  },
} as const;

export const SKILL_DRAFT_SYSTEM_PROMPT = `你是 PilotDeck（医疗 AI 工作台）的"技能萃取"助手。你的任务是：阅读一段用户与 AI 助手的完整对话，从中提炼出一个可复用的技能（Skill），供 AI 助手在今后遇到同类任务时自动加载并遵循。

## 什么是技能
技能是一份写给 AI 助手看的操作手册（SKILL.md），描述"在什么情况下、用什么方法、按什么步骤完成某一类任务"。它不是本次对话的会议纪要，也不是对本次结论的复述。你要把本次对话中体现出来的做事方法抽象、泛化成下次可以照着执行的流程。

## 判断与取舍
- 只保留可迁移、可复用的方法论；剔除本次特有的具体数据、临时上下文与闲聊。
- 不要臆造对话中没有依据的步骤或事实；在忠于对话的前提下做合理归纳。
- 若对话中出现明确的输入要求、判断标准、输出格式、注意事项或禁忌，请显式写入。

## 输出字段
- name：技能的人类可读名称，简短（建议不超过 20 个字），能一眼看出用途。
- slug：技能目录名，仅允许字母、数字、点、下划线、连字符，必须以字母或数字开头，全小写，长度不超过 100（例如 discharge-summary、ct-triage）。不得与"已存在的技能标识"列表重复。
- description：一段话（建议 20–1024 字，单段、不含换行），说明何时应该使用该技能以及它能做什么。AI 助手会仅凭这段话判断是否加载该技能，因此要写清触发场景/关键词与产出。
- body：Markdown 正文，结构建议包含：用途概述、适用场景、所需输入、操作步骤（有序列表）、输出格式、注意事项与禁忌。用祈使句写给执行者看。

## 语言
输出语言与对话语言保持一致（对话为中文则用中文；slug 始终用英文小写）。

## 严格要求
- 仅输出符合给定 JSON Schema 的对象，不要输出任何多余文字或解释。
- 四个字段都必须非空。`;

export const SKILL_FLOW_SYSTEM_PROMPT = `你是 PilotDeck（医疗 AI 工作台）的"技能编写"助手。用户在流程图画布上绘制了自己的工作流程（下文以"节点 + 连线"的文字形式给出），你的任务是把这张流程图整理成一个可复用的技能（Skill），供 AI 助手在今后遇到同类任务时自动加载并按此流程执行。

## 什么是技能
技能是一份写给 AI 助手看的操作手册（SKILL.md），描述"在什么情况下、用什么方法、按什么步骤完成某一类任务"。它不是流程图的逐字转写：你要把节点串成连贯、可执行的操作步骤，把"判断"节点写成明确的条件分支（如果……则……；否则……）。

## 判断与取舍
- 忠实于用户画出的流程：不要发明用户没有画出的步骤，不要更改分支走向。
- 节点文字过于简略处，可以用通用措辞适度补全成完整祈使句，但不得虚构具体业务规则、数值或标准。
- 连线未标注含义时按执行先后理解；"是/否"分支必须在步骤中显式写出两条路径各自做什么。
- 若流程图中出现输入要求、输出格式、注意事项，请显式写入对应小节。

## 输出字段
- name：技能的人类可读名称，简短（建议不超过 20 个字），能一眼看出用途。
- slug：技能目录名，仅允许字母、数字、点、下划线、连字符，必须以字母或数字开头，全小写，长度不超过 100（例如 discharge-summary、ct-triage）。不得与"已存在的技能标识"列表重复。
- description：一段话（建议 20–1024 字，单段、不含换行），说明何时应该使用该技能以及它能做什么。AI 助手会仅凭这段话判断是否加载该技能，因此要写清触发场景/关键词与产出。
- body：Markdown 正文，结构建议包含：用途概述、适用场景、所需输入、操作步骤（有序列表，条件分支用缩进子项表达）、输出格式、注意事项与禁忌。用祈使句写给执行者看。

## 语言
输出语言与流程图节点文字的语言保持一致（节点为中文则用中文；slug 始终用英文小写）。

## 严格要求
- 仅输出符合给定 JSON Schema 的对象，不要输出任何多余文字或解释。
- 四个字段都必须非空。`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 故意只做"非空字符串"校验：slug 的具体格式由 normalize 阶段修复并强制，
 * 这样模型输出的轻微越界（大写、非法字符）不会直接判为 schema 失败。
 */
export function validateSkillDraft(value: unknown): value is SkillDraft {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string" || value.name.trim() === "") return false;
  if (typeof value.slug !== "string" || value.slug.trim() === "") return false;
  if (typeof value.description !== "string" || value.description.trim() === "") return false;
  if (typeof value.body !== "string" || value.body.trim() === "") return false;
  return true;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^[^a-z0-9]+/u, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 100);
}

function dedupeSlug(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) return slug;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${slug.slice(0, 96)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return slug;
}

export function buildSkillDraftUserMessage(
  conversation: string,
  existingSlugs: string[],
): string {
  return [
    "以下是一段用户与 AI 助手的完整对话。请据此提炼一个可复用的技能。",
    "",
    "<已存在的技能标识>",
    existingSlugs.length > 0 ? existingSlugs.join("、") : "（无）",
    "</已存在的技能标识>",
    "",
    "<对话>",
    conversation,
    "</对话>",
    "",
    "请仅输出技能草稿 JSON。",
  ].join("\n");
}

export function buildSkillFlowUserMessage(
  flowDescription: string,
  existingSlugs: string[],
): string {
  return [
    "以下是用户在流程图画布上绘制的工作流程（节点与连线的文字描述）。请据此整理一个可复用的技能。",
    "",
    "<已存在的技能标识>",
    existingSlugs.length > 0 ? existingSlugs.join("、") : "（无）",
    "</已存在的技能标识>",
    "",
    "<流程图>",
    flowDescription,
    "</流程图>",
    "",
    "请仅输出技能草稿 JSON。",
  ].join("\n");
}

export function createSkillDraftStation(model: StructuredModelClient): SkillDraftStation {
  return {
    async generate(input: SkillDraftInput): Promise<SkillDraft> {
      const source: SkillDraftSource = input.source ?? "conversation";
      const taken = new Set(
        (input.existingSlugs ?? []).map((slug) => slug.toLowerCase()),
      );
      const fallbackSlug = source === "flow" ? "workflow-skill" : "conversation-skill";
      const normalize = (value: unknown): unknown => {
        if (!isRecord(value)) return value;
        const name = typeof value.name === "string" ? value.name.trim() : "";
        let slug = typeof value.slug === "string" ? slugify(value.slug) : "";
        if (!slug || !SKILL_SLUG_RE.test(slug)) {
          slug = slugify(name);
        }
        if (!slug || !SKILL_SLUG_RE.test(slug)) {
          slug = fallbackSlug;
        }
        slug = dedupeSlug(slug, taken);
        return {
          name: name || slug,
          slug,
          description:
            typeof value.description === "string" ? value.description.trim() : "",
          body: typeof value.body === "string" ? value.body.trim() : "",
        };
      };
      return model.completeJson<SkillDraft>({
        name: "skill_generate_draft",
        system: source === "flow" ? SKILL_FLOW_SYSTEM_PROMPT : SKILL_DRAFT_SYSTEM_PROMPT,
        user:
          source === "flow"
            ? buildSkillFlowUserMessage(input.conversation, input.existingSlugs ?? [])
            : buildSkillDraftUserMessage(input.conversation, input.existingSlugs ?? []),
        schema: SKILL_DRAFT_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        validate: validateSkillDraft,
        normalize,
      });
    },
  };
}
