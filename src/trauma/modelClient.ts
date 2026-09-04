import type { ModelRuntime } from "../model/ModelRuntime.js";
import type { CanonicalModelRequest } from "../model/protocol/canonical.js";
import { extractStructuredOutput } from "../model/structuredOutput/extractStructuredOutput.js";

export type CompleteJsonInput<T> = {
  name: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  validate: (value: unknown) => value is T;
};

export type StructuredModelClient = {
  completeJson<T>(input: CompleteJsonInput<T>): Promise<T>;
};

export type CreateStructuredModelClientOptions = {
  complete: ModelRuntime["complete"];
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
  return {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      const request: CanonicalModelRequest = {
        provider: options.provider,
        model: options.model,
        systemPrompt: input.system,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: input.user }],
          },
        ],
        temperature: 0,
        outputSchema: {
          name: input.name,
          schema: input.schema,
          strict: true,
        },
        metadata: { purpose: "trauma_structured", station: input.name },
      };
      const response = await options.complete(request);
      const extracted = extractStructuredOutput(response);
      if (!extracted.ok) {
        throw new StructuredOutputSchemaError(`schema validation failed: ${extracted.reason}`);
      }
      const value = stripNulls(extracted.value);
      if (!input.validate(value)) {
        throw new StructuredOutputSchemaError("schema validation failed: schema_mismatch");
      }
      return value;
    },
  };
}
