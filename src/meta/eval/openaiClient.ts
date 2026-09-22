import type { CompleteJsonInput, StructuredModelClient } from "../../trauma/modelClient.js";

/**
 * 评测回放专用的最小 OpenAI 兼容客户端。
 *
 * 不复用 ModelRuntime，是为了让 replay 能脱离网关与配置文件独立跑；
 * 线上工位仍走 src/trauma/modelClient.ts 的 createStructuredModelClient。
 */
export type OpenAiCompatibleOptions = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
};

type ChatCompletionResponse = {
  choices?: { message?: { content?: string | null } }[];
};

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (typeof value !== "object" || value === null) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null) continue;
    result[key] = stripNulls(item);
  }
  return result;
}

/** 本地模型偶尔在 JSON 前后带 ```json 围栏或解释文字。 */
function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    const start = body.indexOf("{");
    const end = body.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(body.slice(start, end + 1)) as unknown;
    }
    throw new Error("response is not valid JSON");
  }
}

export function createOpenAiCompatibleClient(
  options: OpenAiCompatibleOptions,
): StructuredModelClient {
  const endpoint = `${options.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxRetries = options.maxRetries ?? 2;

  async function callOnce<T>(input: CompleteJsonInput<T>, signal: AbortSignal): Promise<T> {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: options.model,
        temperature: 0,
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.user },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: input.name, strict: true, schema: input.schema },
        },
        // vLLM 上的 Qwen 默认开思维链，会把 JSON 包在解释里。
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`model http ${response.status}: ${body.slice(0, 200)}`);
    }
    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("model returned empty content");
    }
    const value = input.normalize
      ? input.normalize(stripNulls(extractJson(content)))
      : stripNulls(extractJson(content));
    if (!input.validate(value)) throw new Error("schema validation failed: schema_mismatch");
    return value;
  }

  return {
    async completeJson<T>(input: CompleteJsonInput<T>): Promise<T> {
      let lastError: unknown;
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        input.signal?.addEventListener("abort", onAbort, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          return await callOnce(input, controller.signal);
        } catch (error) {
          lastError = error;
          if (input.signal?.aborted) throw error;
          if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
          }
        } finally {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    },
  };
}
