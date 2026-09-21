import test from 'node:test';
import assert from 'node:assert/strict';
import { numberAnswerCitations } from '../../src/trauma/citations.js';

test('continuous citation numbers follow first appearance and retain original identity and text', () => {
  const candidates = [1, 2, 3].map(index => ({ index, title: `文献${index}`, section: '章节', chunkId: `chunk-${index}`, text: `原文${index}` }));
  const result = numberAnswerCitations('先[3]，再[1]，又[3]。`[2]`\n```\n[2]\n```\n<details>[2]</details>', candidates);
  assert.deepEqual(result.map(c => [c.index, c.displayIndex, c.chunkId, c.text]), [[3, 1, 'chunk-3', '原文3'], [1, 2, 'chunk-1', '原文1']]);
  assert.deepEqual(numberAnswerCitations('先[3]', candidates), [result[0]]);
});
