import { describe, expect, it } from 'vitest';
import { buildCitationDisplayMap, orderCitationsForSources } from './ragCitations';
import { normalizedToChatMessages } from '../hooks/useChatMessages';
import type { NormalizedMessage } from '../../../stores/useSessionStore';

describe('merged citation numbering', () => {
  const citations = [1, 2, 3].map(index => ({ index, title: `文献${index}`, section: '', chunkId: `c${index}`, text: `原文${index}` }));
  it('appends display numbers in first-appearance order without jumping during streaming', () => {
    expect([...buildCitationDisplayMap('先[3]', citations)]).toEqual([[3, 1]]);
    const map = buildCitationDisplayMap('先[3]后[1]再[3]，`[2]`', citations);
    expect([...map]).toEqual([[3, 1], [1, 2]]);
    expect(orderCitationsForSources(map, citations).map(c => [c.citation.index, c.display, c.citedInline])).toEqual([[3, 1, true], [1, 2, true], [2, 3, false]]);
  });
  it('preserves a stored turn map across split answer bubbles', () => {
    expect([...buildCitationDisplayMap('本段[1]', [{ ...citations[2], displayIndex: 1 }, { ...citations[0], displayIndex: 2 }])]).toEqual([[3, 1], [1, 2]]);
  });
  it('direct trauma metadata gets a source footer without a visible tool result', () => {
    const messages = normalizedToChatMessages([
      { id: 'u', kind: 'text', role: 'user', content: '病例', timestamp: '2026-09-21', turnId: 't' },
      { id: 'a', kind: 'text', role: 'assistant', content: '处理[3]', timestamp: '2026-09-21', turnId: 't', citations: [{ ...citations[2], displayIndex: 1 }] },
    ] as NormalizedMessage[]);
    expect(messages.at(-1)?.citationsFooter).toBe(true);
    expect(messages.at(-1)?.citations?.[0]).toMatchObject({ index: 3, displayIndex: 1, text: '原文3' });
  });
});
