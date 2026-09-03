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
  query(input: { query: string; top_k: number }): Promise<{
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
  if (!isRecord(parsed)) {
    return { retrieval_backend: "local", chunks: [] };
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

export function createMcpTraumaRagClient(
  callTool: (name: string, input: unknown) => Promise<unknown>,
): TraumaRagClient {
  return {
    async query({ query, top_k }) {
      const raw = await callTool(TRAUMA_RAG_TOOL_NAME, { query, top_k });
      return normalizeRagPayload(payloadFromTool(raw));
    },
  };
}

function payloadFromTool(raw: unknown): unknown {
  if (typeof raw === "string") return JSON.parse(raw);
  if (isRecord(raw) && typeof raw.content === "string") return JSON.parse(raw.content);
  return raw;
}
