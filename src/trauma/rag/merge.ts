import type { EvidenceChunk, RagQueryKind, RetrievalTrace } from "../types.js";
import type { TraumaRagHit } from "./client.js";
import type { RetrievalQuery } from "./queryPlan.js";

const MAX_PROMPT_CHUNKS = 15;

export type MergeRetrievalInput = {
  queries: RetrievalQuery[];
  results: Array<{
    query: RetrievalQuery;
    chunks: TraumaRagHit[];
    backend: "remote" | "local";
  }>;
};

export type MergeRetrievalResult = {
  evidence: EvidenceChunk[];
  retrieval: RetrievalTrace;
  promptChunks: EvidenceChunk[];
};

function backendRank(backend: "remote" | "local"): number {
  return backend === "remote" ? 0 : 1;
}

function firstNonBlank(...values: Array<string | undefined>): string {
  return values.map((value) => value?.trim()).find(Boolean) ?? "";
}

function inferSectionFromText(text: string): string {
  const head = text.slice(0, 300);
  const article = head.match(/第[一二三四五六七八九十百〇零\d]+条[^\n。；;]*/u)?.[0];
  const chapter = head.match(/第[一二三四五六七八九十百〇零\d]+章[^\n。；;]*/u)?.[0];
  const section = head.match(/第[一二三四五六七八九十百〇零\d]+节[^\n。；;]*/u)?.[0];
  return firstNonBlank(article, section, chapter);
}

function toEvidence(
  hit: TraumaRagHit,
  tags: RagQueryKind[],
  selectedForPrompt: boolean,
): EvidenceChunk {
  const section = firstNonBlank(
    hit.section,
    hit.article,
    hit.heading,
    hit.chapter,
    hit.path,
    inferSectionFromText(`${hit.title ?? ""}\n${hit.text}`),
  );
  return {
    id: hit.chunk_id,
    knowledgeBase: "trauma",
    documentTitle: hit.title ?? hit.doc_id ?? hit.chunk_id,
    section,
    chapter: hit.chapter,
    heading: hit.heading,
    path: hit.path,
    article: hit.article,
    text: hit.text,
    retrievalScore: hit.score,
    coverageTags: tags,
    selectedForPrompt,
    usedInAnswer: false,
    retrievalBackend: hit.retrieval_backend,
  };
}

export function mergeRetrieval(input: MergeRetrievalInput): MergeRetrievalResult {
  const tagsById = new Map<string, Set<RagQueryKind>>();
  const hitsById = new Map<string, TraumaRagHit>();
  const chunkIdsByQuery = new Map<string, string[]>();

  for (const result of input.results) {
    const ids: string[] = [];
    for (const hit of result.chunks) {
      const existing = hitsById.get(hit.chunk_id);
      if (!existing || backendRank(hit.retrieval_backend) < backendRank(existing.retrieval_backend)) {
        hitsById.set(hit.chunk_id, hit);
      } else if (hit.score > existing.score && hit.retrieval_backend === existing.retrieval_backend) {
        hitsById.set(hit.chunk_id, hit);
      }
      const tags = tagsById.get(hit.chunk_id) ?? new Set<RagQueryKind>();
      tags.add(result.query.kind);
      tagsById.set(hit.chunk_id, tags);
      ids.push(hit.chunk_id);
    }
    chunkIdsByQuery.set(`${result.query.kind}:${result.query.query}`, ids);
  }

  const ranked = [...hitsById.values()].sort((left, right) => {
    const backendDiff = backendRank(left.retrieval_backend) - backendRank(right.retrieval_backend);
    if (backendDiff !== 0) return backendDiff;
    return right.score - left.score;
  });

  const selectedIds = new Set(ranked.slice(0, MAX_PROMPT_CHUNKS).map((hit) => hit.chunk_id));
  const evidence = ranked.map((hit) =>
    toEvidence(hit, [...(tagsById.get(hit.chunk_id) ?? [])], selectedIds.has(hit.chunk_id)),
  );
  const promptChunks = evidence.filter((chunk) => chunk.selectedForPrompt);

  const criticalCoverageGaps = input.queries
    .filter((query) => query.critical)
    .filter((query) => {
      const result = input.results.find((item) => item.query === query)
        ?? input.results.find((item) =>
          item.query.kind === query.kind && item.query.query === query.query);
      return !result || result.chunks.length === 0;
    })
    .map((query) => query.kind);

  const retrieval: RetrievalTrace = {
    queries: input.queries.map((query) => ({
      kind: query.kind,
      query: query.query,
      reason: query.reason,
      critical: query.critical,
      chunkIds: chunkIdsByQuery.get(`${query.kind}:${query.query}`) ?? [],
    })),
    totalCalls: input.results.length,
    allChunkIds: evidence.map((chunk) => chunk.id),
    promptChunkIds: promptChunks.map((chunk) => chunk.id),
    criticalCoverageGaps: [...new Set(criticalCoverageGaps)],
  };

  return { evidence, retrieval, promptChunks };
}
