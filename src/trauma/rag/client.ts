export const TRAUMA_RAG_TOOL_NAME = "mcp__med-tools__med_trauma_rag_query";
export const TRAUMA_RAG_TOP_K = 8;

export type TraumaRagHit = {
  chunk_id: string;
  text: string;
  score: number;
  doc_id?: string;
  title?: string;
  article?: string;
  retrieval_backend: "remote" | "local";
};

export type TraumaRagClient = {
  query(input: { query: string; top_k: number; topic?: string }): Promise<{
    retrieval_backend: "remote" | "local";
    chunks: TraumaRagHit[];
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asBackend(value: unknown): "remote" | "local" {
  return value === "local" ? "local" : "remote";
}

export function normalizeRagPayload(payload: unknown): {
  retrieval_backend: "remote" | "local";
  chunks: TraumaRagHit[];
} {
  const parsed = typeof payload === "string" ? JSON.parse(payload) as unknown : payload;
  // 解析不出对象说明工具返回形态与约定不符，属于故障而非「检索到 0 条」。
  // 静默返回空结果会让推演在没有任何证据的情况下继续，必须显式失败。
  if (!isRecord(parsed)) {
    throw new Error(
      `trauma RAG payload is not an object (got ${Array.isArray(parsed) ? "array" : typeof parsed})`,
    );
  }
  const backend = asBackend(parsed.retrieval_backend);
  const rawChunks = Array.isArray(parsed.chunks) ? parsed.chunks : [];
  const chunks: TraumaRagHit[] = rawChunks.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const text = typeof item.text === "string" ? item.text : "";
    const score = typeof item.score === "number" ? item.score : 0;
    return [{
      chunk_id: String(item.chunk_id ?? `chunk-${index}`),
      text,
      score,
      doc_id: typeof item.doc_id === "string" ? item.doc_id : undefined,
      title: typeof item.title === "string" ? item.title : undefined,
      article: typeof item.article === "string" ? item.article : undefined,
      retrieval_backend: asBackend(item.retrieval_backend ?? backend),
    }];
  });
  return { retrieval_backend: backend, chunks };
}

export const TRAUMA_RAG_TOPIC = "战创伤";

export function createMcpTraumaRagClient(
  callTool: (name: string, input: unknown) => Promise<unknown>,
): TraumaRagClient {
  return {
    async query({ query, top_k, topic = TRAUMA_RAG_TOPIC }) {
      const raw = await callTool(TRAUMA_RAG_TOOL_NAME, { query, top_k, topic });
      return normalizeRagPayload(payloadFromTool(raw));
    },
  };
}

/** 把 MCP 内容块数组里的 text 片段拼起来；没有可用文本时返回空串。 */
function textFromContentBlocks(blocks: unknown[]): string {
  return blocks
    .map((block) => (
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? block.text
        : ""
    ))
    .join("");
}

/**
 * MCP 工具的结果可能是 JSON 字符串、`{ content: "..." }`，也可能是标准的
 * `PilotDeckToolResultContent[]` 内容块数组（非流式工具的 `data` 就是它）。
 * 三种形态都要还原成同一个 payload 对象。
 */
export function payloadFromTool(raw: unknown): unknown {
  if (typeof raw === "string") return JSON.parse(raw);
  if (Array.isArray(raw)) {
    const text = textFromContentBlocks(raw);
    if (text) return JSON.parse(text);
    return raw;
  }
  if (isRecord(raw)) {
    if (typeof raw.content === "string") return JSON.parse(raw.content);
    if (Array.isArray(raw.content)) return payloadFromTool(raw.content);
  }
  return raw;
}
