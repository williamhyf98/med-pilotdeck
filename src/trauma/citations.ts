import type { CitationMetadata } from "./types.js";

/** Keep prompt indexes as identities; persist a separate first-appearance display order. */
export function numberAnswerCitations(answer: string, candidates: CitationMetadata[]): CitationMetadata[] {
  const known = new Map(candidates.map(c => [c.index, c]));
  const used = new Map<number, CitationMetadata>();
  const body = answer.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, "")
    .replace(/```[\s\S]*?(?:```|$)/g, "").replace(/`[^`\n]*`/g, "");
  for (const match of body.matchAll(/\[(\d{1,3})\]/g)) {
    const index = Number(match[1]);
    const citation = known.get(index);
    if (citation && !used.has(index)) used.set(index, { ...citation, displayIndex: used.size + 1 });
  }
  return [...used.values()];
}
