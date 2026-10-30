import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";
import type { PilotDeckToolValidationResult } from "../protocol/schema.js";
import { validateHtmlPreview } from "../elicitation/validateHtmlPreview.js";
import type {
  PilotDeckElicitationChannel,
  PilotDeckElicitationRequest,
} from "../elicitation/PilotDeckElicitationChannel.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";
/**
 * Header chip width — mirrors legacy
 * `ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12` (prompt.ts).
 */
export const ASK_USER_QUESTION_HEADER_MAX = 12;
/** Max questions in one ask_user_question call. */
export const ASK_USER_QUESTION_MAX_QUESTIONS = 4;
/** Min / max choices per question. Six trauma stages fit in one card when this is ≥ 6. */
export const ASK_USER_QUESTION_MIN_OPTIONS = 2;
export const ASK_USER_QUESTION_MAX_OPTIONS = 8;

const ASK_USER_QUESTION_DESCRIPTION =
  "在执行过程中需要向用户提出一个或多个选择题时使用本工具。" +
  "适用于收集偏好或需求、澄清含糊的指令、就实现方案做出取舍，" +
  "或给用户几个具体方向供其选择。" +
  "使用说明：一次提供 1-4 个问题，每题 2-8 个选项；某题允许多选时把 multiSelect 设为 true；" +
  "选项内容由你自己拟定，不要用本工具做开放式的自由问答。" +
  "在计划模式下，用 ask_user_question 澄清需求或在几种做法之间取舍，然后再定稿计划。" +
  "不要用它来征求对计划的批准；应展示计划并等待用户退出计划模式。";

export type AskUserQuestionOption = {
  label: string;
  description: string;
  preview?: string;
};

export type AskUserQuestionItem = {
  question: string;
  header: string;
  options: AskUserQuestionOption[];
  multiSelect?: boolean;
};

export type AskUserQuestionInput = {
  questions: AskUserQuestionItem[];
  /** Optional pre-supplied answers (echoed back to the model). */
  answers?: Record<string, string | string[]>;
  /** Optional per-question annotations (preview / notes). */
  annotations?: Record<string, { preview?: string; notes?: string }>;
  /** Optional analytics metadata; not displayed to the user. */
  metadata?: { source?: string };
};

export type AskUserQuestionOutput = {
  questions: AskUserQuestionItem[];
  answers: Record<string, string | string[]>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
};

/**
 * Permission stage runs on the tool runtime; this is the moment we ask the
 * host to surface the multiple-choice dialog. The actual dispatch happens
 * via `runtimeContext.elicitation.askUser`.
 *
 * Behaviour alignment with `AskUserQuestionTool.tsx` (E1..E10 in §5.1.6):
 *   E1 schema: questions ≥ 1, ≤ ASK_USER_QUESTION_MAX_QUESTIONS.
 *   E2 each question.options ≥ ASK_USER_QUESTION_MIN_OPTIONS, ≤ ASK_USER_QUESTION_MAX_OPTIONS.
 *   E3 question texts unique within the call; option labels unique within
 *      each question (legacy `UNIQUENESS_REFINE`).
 *   E4 header.length ≤ ASK_USER_QUESTION_HEADER_MAX.
 *   E5 shouldDefer: true (legacy buildTool flag).
 *   E6 isReadOnly / isConcurrencySafe / requiresUserInteraction = true.
 *   E7 HTML preview validation (legacy `validateHtmlPreview`).
 *   E8 maxResultBytes = 100_000 (legacy `maxResultSizeChars`).
 *   E9 result mapping uses the legacy boilerplate format.
 *   E10 cancellation surfaces as `unsupported_tool` so the agent recovery
 *       loop can route back to the user via a fresh elicitation.
 */
export function createAskUserQuestionTool(): PilotDeckToolDefinition<
  AskUserQuestionInput,
  AskUserQuestionOutput
> {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    aliases: ["AskUserQuestion"],
    description: ASK_USER_QUESTION_DESCRIPTION,
    kind: "session",
    shouldDefer: true,
    maxResultBytes: 100_000,
    inputSchema: {
      type: "object",
      required: ["questions"],
      additionalProperties: false,
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: ASK_USER_QUESTION_MAX_QUESTIONS,
          description:
            `要向用户提出的问题。必须是问题对象组成的 JSON 数组（不能是字符串）。一次提供 1-${ASK_USER_QUESTION_MAX_QUESTIONS} 个选择题。`,
          items: {
            type: "object",
            required: ["question", "header", "options"],
            additionalProperties: false,
            properties: {
              question: {
                type: "string",
                description:
                  "展示给用户的完整问题。表述要清楚、具体；若 multiSelect 为 true，请写成多选题的口吻。",
              },
              header: {
                type: "string",
                maxLength: ASK_USER_QUESTION_HEADER_MAX,
                description:
                  `该问题的极简标签，用于界面上的小标签（最多 ${ASK_USER_QUESTION_HEADER_MAX} 个字符）。`,
              },
              options: {
                type: "array",
                minItems: ASK_USER_QUESTION_MIN_OPTIONS,
                maxItems: ASK_USER_QUESTION_MAX_OPTIONS,
                description:
                  `该问题的可选项。提供 ${ASK_USER_QUESTION_MIN_OPTIONS}-${ASK_USER_QUESTION_MAX_OPTIONS} 个互不重复的选项；除非 multiSelect 为 true，各选项之间应互斥。`,
                items: {
                  type: "object",
                  required: ["label", "description"],
                  additionalProperties: false,
                  properties: {
                    label: {
                      type: "string",
                      description:
                        "选项的简短展示文字，也就是用户实际点选的内容。",
                    },
                    description: {
                      type: "string",
                      description:
                        "说明该选项的含义，或选择它意味着什么。",
                    },
                    preview: {
                      type: "string",
                      description:
                        "可选，与该选项关联、由宿主决定如何使用的预览内容。宿主可能把它展示在选项旁边，并在 annotations 中回传所选预览。",
                    },
                  },
                },
              },
              multiSelect: {
                type: "boolean",
                description:
                  "设为 true 时，该问题允许用户选择多个选项，而不是只选一个。",
              },
            },
          },
        },
        // Records keyed by free-form question text — schema validator only
        // checks the outer object shape; per-key types are enforced by
        // `validateInput` below.
        answers: {
          type: "object",
          description:
            "可选，以问题文本为键预先给出的答案。取值可以是单个字符串；多选题也可以是字符串数组。",
        },
        annotations: {
          type: "object",
          description:
            "可选，以问题文本为键的逐题标注数据，例如所选预览文本，或宿主回传的用户自由填写内容。",
        },
        metadata: {
          type: "object",
          additionalProperties: false,
          description:
            "可选，随本次询问请求一并转发给宿主的元数据，不会展示给用户。",
          properties: {
            source: {
              type: "string",
              description:
                "可选标识，说明本次提问的来由，供宿主侧统计或路由使用。",
            },
          },
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => true,
    validateInput: async (input): Promise<PilotDeckToolValidationResult> => {
      // E1: 1 ≤ questions ≤ MAX. Schema minItems/maxItems are also enforced here.
      if (!Array.isArray(input.questions) || input.questions.length < 1) {
        return {
          ok: false,
          issues: [
            {
              path: "questions",
              code: "invalid_schema",
              message: `Provide 1-${ASK_USER_QUESTION_MAX_QUESTIONS} questions`,
            },
          ],
        };
      }
      if (input.questions.length > ASK_USER_QUESTION_MAX_QUESTIONS) {
        return {
          ok: false,
          issues: [
            {
              path: "questions",
              code: "invalid_schema",
              message: `At most ${ASK_USER_QUESTION_MAX_QUESTIONS} questions allowed`,
            },
          ],
        };
      }

      // E2: MIN ≤ options ≤ MAX per question.
      for (const q of input.questions) {
        if (
          !Array.isArray(q.options) ||
          q.options.length < ASK_USER_QUESTION_MIN_OPTIONS ||
          q.options.length > ASK_USER_QUESTION_MAX_OPTIONS
        ) {
          return {
            ok: false,
            issues: [
              {
                path: "questions[].options",
                code: "invalid_schema",
                message: `Question "${q.question}" must have ${ASK_USER_QUESTION_MIN_OPTIONS}-${ASK_USER_QUESTION_MAX_OPTIONS} options`,
              },
            ],
          };
        }
      }

      // E3 uniqueness + E4 header length + E7 HTML preview validation.
      const seenQuestions = new Set<string>();
      for (const q of input.questions) {
        if (seenQuestions.has(q.question)) {
          return {
            ok: false,
            issues: [
              {
                path: "questions",
                code: "invalid_schema",
                message: `Question texts must be unique: "${q.question}"`,
              },
            ],
          };
        }
        seenQuestions.add(q.question);

        if (q.header.length > ASK_USER_QUESTION_HEADER_MAX) {
          return {
            ok: false,
            issues: [
              {
                path: "questions[].header",
                code: "invalid_schema",
                message: `header for "${q.question}" exceeds ${ASK_USER_QUESTION_HEADER_MAX} chars`,
              },
            ],
          };
        }

        const seenLabels = new Set<string>();
        for (const opt of q.options) {
          if (seenLabels.has(opt.label)) {
            return {
              ok: false,
              issues: [
                {
                  path: "questions[].options",
                  code: "invalid_schema",
                  message: `Option labels must be unique within question "${q.question}"`,
                },
              ],
            };
          }
          seenLabels.add(opt.label);

          const htmlError = validateHtmlPreview(opt.preview);
          if (htmlError !== null) {
            return {
              ok: false,
              issues: [
                {
                  path: "questions[].options[].preview",
                  code: "invalid_schema",
                  message: `Option "${opt.label}" in question "${q.question}": ${htmlError}`,
                },
              ],
            };
          }
        }
      }
      return { ok: true, input };
    },
    // No `checkPermissions` override: the elicitation channel itself IS the
    // user-consent gate (legacy behaviour — ask_user_question's `checkPermissions`
    // returns `behavior: "ask"` and the host renders the question UI directly).
    // PilotDeck would otherwise add a redundant "approve to ask" step in front
    // of the actual question dialog. The tool is read-only, so the runtime's
    // default mode allows it through.
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<AskUserQuestionOutput>> => {
      const channel = (context as PilotDeckToolRuntimeContext & {
        elicitation?: PilotDeckElicitationChannel;
      }).elicitation;
      if (!channel) {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          "ask_user_question requires a host elicitation channel (none registered).",
        );
      }

      // Pre-supplied answers short-circuit the channel call (legacy behaviour:
      // the schema accepts answers in input and the call() returns them as-is).
      if (input.answers && Object.keys(input.answers).length > 0) {
        const data: AskUserQuestionOutput = {
          questions: input.questions,
          answers: input.answers,
          ...(input.annotations && { annotations: input.annotations }),
        };
        return {
          content: [
            { type: "text", text: formatAnswersForModel(input.answers, input.annotations) },
          ],
          data,
        };
      }

      const request: PilotDeckElicitationRequest = {
        toolCallId: context.turnId,
        toolName: ASK_USER_QUESTION_TOOL_NAME,
        questions: input.questions,
        ...(input.metadata && { metadata: input.metadata }),
        ...(context.abortSignal && { signal: context.abortSignal }),
      };
      const answer = await channel.askUser(request);

      if (answer.type === "cancelled") {
        throw new PilotDeckToolRuntimeError(
          "unsupported_tool",
          `User declined to answer questions${answer.reason ? ` (${answer.reason})` : ""}`,
        );
      }

      const data: AskUserQuestionOutput = {
        questions: input.questions,
        answers: answer.answers,
        ...(answer.annotations && { annotations: answer.annotations }),
      };
      return {
        content: [
          { type: "text", text: formatAnswersForModel(answer.answers, answer.annotations) },
        ],
        data,
      };
    },
  };
}

/**
 * Reproduces legacy `mapToolResultToToolResultBlockParam` byte-for-byte
 * (E9): "User has answered your questions: ...". The model uses this exact
 * phrasing as a routing hint.
 */
function formatAnswersForModel(
  answers: Record<string, string | string[]>,
  annotations?: Record<string, { preview?: string; notes?: string }>,
): string {
  const entries = Object.entries(answers).map(([questionText, answer]) => {
    const annotation = annotations?.[questionText];
    const display = Array.isArray(answer) ? answer.join(", ") : answer;
    const parts = [`"${questionText}"="${display}"`];
    if (annotation?.preview) {
      parts.push(`selected preview:\n${annotation.preview}`);
    }
    if (annotation?.notes) {
      parts.push(`user notes: ${annotation.notes}`);
    }
    return parts.join(" ");
  });
  return `User has answered your questions: ${entries.join(", ")}. You can now continue with the user's answers in mind.`;
}
