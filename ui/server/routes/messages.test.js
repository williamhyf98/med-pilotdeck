import { describe, expect, it } from 'vitest';

import { mapWebMessageToNormalized } from './messages.js';

describe('mapWebMessageToNormalized', () => {
  it('drops persisted thinking messages from visible history', () => {
    const message = mapWebMessageToNormalized({
      id: 'm-thinking',
      kind: 'thinking',
      text: 'internal reasoning',
      createdAt: '2026-08-28T00:00:00.000Z',
    }, 'web:s_test');

    expect(message).toBeNull();
  });

  it('strips inline think blocks from persisted assistant text', () => {
    const message = mapWebMessageToNormalized({
      id: 'm-assistant',
      kind: 'text',
      role: 'assistant',
      text: '<think>hidden reasoning</think>Visible answer',
      createdAt: '2026-08-28T00:00:00.000Z',
    }, 'web:s_test');

    expect(message).toMatchObject({
      kind: 'text',
      role: 'assistant',
      content: 'Visible answer',
    });
  });

  it('preserves user text literally', () => {
    const message = mapWebMessageToNormalized({
      id: 'm-user',
      kind: 'text',
      role: 'user',
      text: '<think>quoted by user</think>',
      createdAt: '2026-08-28T00:00:00.000Z',
    }, 'web:s_test');

    expect(message).toMatchObject({
      kind: 'text',
      role: 'user',
      content: '<think>quoted by user</think>',
    });
  });
});
