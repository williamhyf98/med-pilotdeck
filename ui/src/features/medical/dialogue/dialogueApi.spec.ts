import { describe, expect, it } from 'vitest';
import {
  buildManagedContext,
  normalizeCapabilities,
  samplingToTurnOverrides,
} from './dialogueApi';
import { MANAGED_PROMPTS } from './dialogueTypes';

describe('Dialogue API helpers', () => {
  it('only marks explicitly advertised capabilities available', () => {
    expect(normalizeCapabilities({
      capabilities: {
        dialogue: { available: true },
        ragCorpora: { available: false, reason: 'not_configured' },
        attachments: { available: true },
      },
    })).toEqual({
      dialogue: true,
      rag: false,
      attachments: true,
      tables: false,
      imaging: false,
      reasons: {
        rag: 'not_configured',
        attachments: undefined,
        tables: undefined,
        imaging: undefined,
      },
    });
  });

  it('builds bounded managed context with real corpus selections', () => {
    const context = buildManagedContext({
      taskLabel: '深度搜索',
      taskHint: '检索证据。',
      prompt: MANAGED_PROMPTS[1],
      customPrompt: '用中文回答',
      ragEnabled: true,
      selectedCorpora: [{ id: 'guides', name: '临床指南', ready: true }],
      ragTopK: 7,
      preparedAttachments: [],
    });
    expect(context).toContain('受管 Prompt：证据优先');
    expect(context).toContain('语料=临床指南；Top-K=7');
    expect(context).toContain('不得虚构引用');
  });

  it('maps sampling controls to supported Gateway overrides', () => {
    expect(samplingToTurnOverrides({
      temperature: 0.3,
      topP: 0.85,
      maxOutputTokens: 2048,
    })).toEqual({
      temperature: 0.3,
      topP: 0.85,
      maxOutputTokens: 2048,
      metadata: { surface: 'medical-dialogue' },
    });
  });
});
