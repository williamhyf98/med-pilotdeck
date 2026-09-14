import type { ModelRuntime } from "../model/ModelRuntime.js";
import type {
  CanonicalModelRequest,
  CanonicalModelResponse,
  CanonicalToolCall,
} from "../model/protocol/canonical.js";
import { extractStructuredOutput } from "../model/structuredOutput/extractStructuredOutput.js";
import { ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME } from "../model/providers/anthropic/request.js";
import { NaturalLanguageAnswerStreamExtractor } from "./streamingJson.js";

/** 送进多模态工位的图像；data 为裸 base64，不带 data: 前缀。 */
export type TraumaImageInput = {
  data: string;
  mimeType: string;
};

export type CompleteJsonInput<T> = {
  name: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  validate: (value: unknown) => value is T;
  /** Applied after null-stripping and before validate. Use to drop leaked extra keys. */
  normalize?: (value: unknown) => unknown;
  /** 仅多模态工位使用；其余工位不传，请求形态与改动前完全一致。 */
  images?: TraumaImageInput[];
  signal?: AbortSignal;
};

export type StructuredModelClient = {
  completeJson<T>(input: CompleteJsonInput<T>): Promise<T>;
  streamJson?<T>(
    input: CompleteJsonInput<T>,
    callbacks?: StructuredJsonStreamCallbacks,
  ): Promise<T>;
};

export type StructuredJsonStreamCallbacks = {
  onNaturalLanguageDelta?: (text: string) => void | Promise<void>;
  onNaturalLanguageEnd?: () => void | Promise<void>;
};

export type CreateStructuredModelClientOptions = {
  complete: ModelRuntime["complete"];
  stream: ModelRuntime["stream"];
  provider: string;
  model: string;
};

export class StructuredOutputSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StructuredOutputSchemaError";
  }
}

/**
 * strict 模式不允许可选字段，可选值只能声明为可空，模型因此会回填 null。
 * 校验前统一抹掉这些 null，让下游按「字段缺省」处理。
 */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripNulls);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null) continue;
    result[key] = stripNulls(item);
  }
  return result;
}

export function createStructuredModelClient(
  options: CreateStructuredModelClientOptions,
): StructuredModelClient {
  const buildRequest = <T>(input: CompleteJsonInput<T>, stream: boolean): CanonicalModelRequest => ({
    provider: options.provider,
    model: options.model,
    systemPrompt: input.system,
    messages: [
      {
        role: "user",
        content: [
          ...(input.images ?? []).map((image) => ({
            type: "image" as const,
            source: "base64" as const,
            data: image.data,
            mimeType: image.mimeType,
          })),
          { type: "text" as const, text: input.user },
        ],
      },
    ],
    temperature: 0,
    // Trauma answers are structured JSON and must stream their visible
    // naturalLanguageAnswer immediately. Qwen's inline-think holdback is
    // disabled by the explicit off mode in the stream normalizer.
    thinking: { enabled: false, mode: "off" },
    stream,
    outputSchema: {
      name: input.name,
      schema: input.schema,
      strict: true,
    },
    metadata: { purpose: "trauma_structured", station: input.name },
  });

  const validate = <T>(input: CompleteJsonInput<T>, response: CanonicalModelResponse): T => {
    const extracted = extractStructuredOutput(response);
    if (!extracted.ok) {
      throw new StructuredOutputSchemaError(`schema validation failed: ${extracted.reason}`);
    }
    const value = input.normalize
      ? input.normalize(stripNulls(extracted.value))
      : stripNulls(extracted.value);
    if (!input.validate(value)) {
      throw new StructuredOutputSchemaError("schema validation failed: schema_mismatch");
    }
    return value;
  };

  return {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      const request = buildRequest(input, false);
      const response = await options.complete(request, input.signal ? { signal: input.signal } : undefined);
      return validate(input, response);
    },

    async streamJson<T>(
      input: CompleteJsonInput<T>,
      callbacks: StructuredJsonStreamCallbacks = {},
    ): Promise<T> {
      const request = buildRequest(input, true);
      const answerExtractor = new NaturalLanguageAnswerStreamExtractor();
      const textParts: string[] = [];
      const toolCalls = new Map<string, CanonicalToolCall>();
      const toolCallOrder: string[] = [];
      let naturalLanguageEnded = false;

      const flushNaturalLanguageEnd = async () => {
        if (naturalLanguageEnded || !answerExtractor.isFinished()) return;
        naturalLanguageEnded = true;
        await callbacks.onNaturalLanguageEnd?.();
      };

      for await (const event of options.stream(request, input.signal ? { signal: input.signal } : undefined)) {
        if (event.type === "error") {
          throw new StructuredOutputSchemaError(`model stream failed: ${event.error.message}`);
        }
        if (event.type === "text_delta") {
          textParts.push(event.text);
          const delta = answerExtractor.accept(event.text);
          if (delta) await callbacks.onNaturalLanguageDelta?.(delta);
          await flushNaturalLanguageEnd();
          continue;
        }
        if (event.type === "tool_call_start") {
          toolCalls.set(event.id, { id: event.id, name: event.name, input: {} });
          toolCallOrder.push(event.id);
          continue;
        }
        if (event.type === "tool_call_delta") {
          const current = toolCalls.get(event.id);
          if (!current) continue;
          if (current.name === ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME) {
            const delta = answerExtractor.accept(event.delta);
            if (delta) await callbacks.onNaturalLanguageDelta?.(delta);
            await flushNaturalLanguageEnd();
          }
          const previousRaw = typeof current.input === "string" ? current.input : "";
          current.input = `${previousRaw}${event.delta}`;
          continue;
        }
        if (event.type === "tool_call_end") {
          toolCalls.set(event.toolCall.id, event.toolCall);
        }
      }

      // A complete response normally closes the JSON string. `finish()` is a
      // safe final flush for transports that omit only the closing delimiter;
      // schema validation below still rejects malformed JSON.
      const finalDelta = answerExtractor.finish();
      if (finalDelta) await callbacks.onNaturalLanguageDelta?.(finalDelta);
      await flushNaturalLanguageEnd();

      const content: CanonicalModelResponse["content"] = [];
      if (textParts.length > 0) {
        content.push({ type: "text", text: textParts.join("") });
      }
      for (const id of toolCallOrder) {
        const toolCall = toolCalls.get(id);
        if (toolCall) content.push({ type: "tool_call", ...toolCall });
      }
      return validate(input, {
        role: "assistant",
        content,
        finishReason: "stop",
      });
    },
  };
}
