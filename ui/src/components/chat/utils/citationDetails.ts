import type { CitationMetadata } from '../types/types';

const DETAILS_BLOCK_RE = /<details\b[^>]*>[\s\S]*?<\/details>/gi;
const CITATION_LINE_RE = /^\s*-\s*\[(\d+)\]\s+(.+?)\s*>\s*(.+?)\s*$/;
const QUOTE_SPLIT_RE = /\s*[|｜]\s*短引文[:：]\s*/u;
const CHUNK_COMMENT_RE = /<!--[\s\S]*?-->/g;

export function extractCitationsFromContent(text: string): CitationMetadata[] {
  const citations: CitationMetadata[] = [];
  for (const detailsMatch of text.matchAll(DETAILS_BLOCK_RE)) {
    const detailsBlock = detailsMatch[0];
    for (const line of detailsBlock.split('\n')) {
      const match = line.match(CITATION_LINE_RE);
      if (!match) continue;
      const [, rawIndex, rawTitle, rawSection] = match;
      const [section, quote] = rawSection.replace(CHUNK_COMMENT_RE, '').trim().split(QUOTE_SPLIT_RE);
      citations.push({
        index: parseInt(rawIndex, 10),
        title: rawTitle.trim(),
        section: section.trim(),
        ...(quote?.trim() ? { quote: quote.trim() } : {}),
      });
    }
  }
  return citations;
}

export function stripCitationDetailsBlocks(text: string): string {
  return text.replace(DETAILS_BLOCK_RE, (detailsBlock) => (
    detailsBlock.split('\n').some((line) => CITATION_LINE_RE.test(line)) ? '' : detailsBlock
  )).trim();
}
