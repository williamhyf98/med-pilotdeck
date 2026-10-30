import { TRAUMA_RAG_TOPIC, TRAUMA_RAG_TOP_K, type TraumaRagClient, type TraumaRagHit } from "./client.js";
import type { RetrievalQuery } from "./queryPlan.js";

export async function runBaselineRetrieval(input: {
  queries: RetrievalQuery[];
  rag: TraumaRagClient;
  signal?: AbortSignal;
}): Promise<Array<{
  query: RetrievalQuery;
  chunks: TraumaRagHit[];
  backend: "remote" | "local";
}>> {
  return Promise.all(input.queries.map(async (query) => {
    const result = await input.rag.query({
      query: query.query,
      top_k: TRAUMA_RAG_TOP_K,
      topic: TRAUMA_RAG_TOPIC,
      signal: input.signal,
    });
    if (input.signal?.aborted) {
      throw new DOMException("The operation was aborted", "AbortError");
    }
    return { query, chunks: result.chunks, backend: result.retrieval_backend };
  }));
}
