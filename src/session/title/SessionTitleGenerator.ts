import type { ModelRuntime } from "../../model/index.js";
import type { PilotAgentModelSelection } from "../../pilot/config/types.js";

export const SESSION_TITLE_MAX_INPUT_CHARS = 1200;
export const SESSION_TITLE_MAX_OUTPUT_CHARS = 80;
export const SESSION_TITLE_TIMEOUT_MS = 30_000;

const SESSION_TITLE_SYSTEM_PROMPT = `请根据本次会话的主要主题或目标，生成一个简洁、易识别的简体中文标题。

要求：
- 标题只能使用简体中文，可包含阿拉伯数字；不要使用英文字母，即使原文包含英文产品名或技术缩写，也要改写成自然的中文主题。
- 建议 4 至 12 个汉字，不要超过 20 个汉字。
- 不要添加引号、句号、冒号、书名号或“关于”等无意义前缀。

只返回包含一个 "title" 字段的 JSON。

正确示例：
{"title": "优化移动端登录"}
{"title": "接入开放授权认证"}
{"title": "排查构建失败"}
{"title": "分析胸部影像"}

错误示例：
{"title": "Fix login button"}
{"title": "问题处理"}
{"title": "关于用户提出的移动端登录按钮无法响应问题的分析与修改"}

不要输出 Markdown、代码围栏、解释、分析、思考文本、<think> 标签或额外字段。`;

export type SessionTitleGeneratorInput = {
  text: string;
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
};

export type SessionTitleGenerator = (input: SessionTitleGeneratorInput) => Promise<string | null>;

export type CreateSessionTitleGeneratorOptions = {
  modelRuntime: Pick<ModelRuntime, "complete">;
  agentModel: PilotAgentModelSelection;
  timeoutMs?: number;
};

export function createSessionTitleGenerator(
  options: CreateSessionTitleGeneratorOptions,
): SessionTitleGenerator {
  const timeoutMs = options.timeoutMs ?? SESSION_TITLE_TIMEOUT_MS;
  return async ({ text, sessionId, turnId, signal }) => {
    const prompt = normalizeSessionTitleInput(text);
    if (!prompt) {
      return null;
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

    try {
      const response = await options.modelRuntime.complete(
        {
          provider: options.agentModel.provider,
          model: options.agentModel.model,
          systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          ],
          maxOutputTokens: 4096,
          temperature: 0,
          metadata: {
            purpose: "session_title_generation",
            sessionId,
            turnId,
          },
        },
        { signal: combinedSignal },
      );

      return parseGeneratedTitle(response.content);
    } catch (error) {
      logSessionTitleFailure("provider_error", error);
      return null;
    }
  };
}

export function normalizeSessionTitleInput(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > SESSION_TITLE_MAX_INPUT_CHARS
    ? normalized.slice(0, SESSION_TITLE_MAX_INPUT_CHARS)
    : normalized;
}

function parseGeneratedTitle(content: Awaited<ReturnType<ModelRuntime["complete"]>>["content"]): string | null {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (!text) {
    logSessionTitleFailure("empty_content");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch (error) {
    logSessionTitleFailure("invalid_json", error);
    return null;
  }

  if (
    typeof parsed !== "object"
    || parsed === null
    || typeof (parsed as { title?: unknown }).title !== "string"
  ) {
    logSessionTitleFailure("missing_title");
    return null;
  }
  return sanitizeGeneratedTitle((parsed as { title: string }).title);
}

function stripJsonFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  return (match?.[1] ?? text).trim();
}

function sanitizeGeneratedTitle(title: string): string | null {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    logSessionTitleFailure("missing_title");
    return null;
  }
  if (!/\p{Script=Han}/u.test(normalized) || /\p{Script=Latin}/u.test(normalized)) {
    logSessionTitleFailure("non_chinese_title");
    return null;
  }
  return normalized.length > SESSION_TITLE_MAX_OUTPUT_CHARS
    ? normalized.slice(0, SESSION_TITLE_MAX_OUTPUT_CHARS)
    : normalized;
}

function logSessionTitleFailure(reason: string, error?: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const suffix = message ? `: ${message.slice(0, 200)}` : "";
  console.debug(`[session-title] generation skipped (${reason})${suffix}`);
}
