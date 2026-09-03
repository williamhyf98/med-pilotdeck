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
      const extracted = extractStructuredOutput(response, { validate: input.validate });
      if (!extracted.ok) {
        throw new StructuredOutputSchemaError(`schema validation failed: ${extracted.reason}`);
      }
      if (!input.validate(extracted.value)) {
        throw new StructuredOutputSchemaError("schema validation failed");
      }
      return extracted.value;
    },
  };
}
