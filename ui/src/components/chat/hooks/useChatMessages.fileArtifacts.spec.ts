import { describe, expect, it } from 'vitest';
import type { NormalizedMessage } from '../../../stores/useSessionStore';
import { normalizedToChatMessages } from './useChatMessages';
import { buildAttachmentPathNote } from '../utils/attachmentNotes';

const base = {
  sessionId: 'session-1',
  provider: 'pilotdeck' as const,
};

it('renders carried-over upload placeholders exactly like refreshed history', () => {
  const file = { name: 'MR_多帧_10帧.dcm', path: '/project/inbox/run/MR_多帧_10帧.dcm' };
  const persisted: NormalizedMessage = { ...base, id: 'accepted-input', kind: 'text', role: 'user', timestamp: '2026-09-22T00:00:00Z', content: `分析附件${buildAttachmentPathNote([file])}` };
  const live = normalizedToChatMessages([{ ...persisted, attachments: [{ name: file.name }] }]);
  const refreshed = normalizedToChatMessages([persisted]);
  expect(live[0].attachments).toHaveLength(1);
  expect(live[0].attachments).toEqual(refreshed[0].attachments);
  expect(live[0].attachments?.[0].path).toBe('/project/inbox/run/MR_多帧_10帧.dcm');
});

describe('file artifact message grouping', () => {
  it('attaches artifacts to the preceding final assistant reply', () => {
    const messages: NormalizedMessage[] = [
      {
        ...base,
        id: 'assistant-1',
        timestamp: '2026-07-21T10:00:00.000Z',
        kind: 'text',
        role: 'assistant',
        content: 'Finished.',
      },
      {
        ...base,
        id: 'artifacts-1',
        timestamp: '2026-07-21T10:00:01.000Z',
        kind: 'file_artifacts',
        artifacts: [{
          id: 'artifact-1',
          name: 'report.xlsx',
          path: 'report.xlsx',
          operation: 'created',
          source: 'workspace_diff',
          status: 'complete',
          size: 42,
          sha256: 'a'.repeat(64),
          createdAt: '2026-07-21T10:00:01.000Z',
        }],
      },
    ];

    const result = normalizedToChatMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe('Finished.');
    expect(result[0].artifacts?.[0]?.path).toBe('report.xlsx');
  });

  it('keeps artifacts visible when a failed turn has no final assistant reply', () => {
    const messages: NormalizedMessage[] = [{
      ...base,
      id: 'artifacts-1',
      timestamp: '2026-07-21T10:00:01.000Z',
      kind: 'file_artifacts',
      artifacts: [{
        id: 'artifact-1',
        name: 'partial.docx',
        path: 'partial.docx',
        operation: 'created',
        source: 'workspace_diff',
        status: 'incomplete',
        size: 12,
        sha256: 'b'.repeat(64),
        createdAt: '2026-07-21T10:00:01.000Z',
      }],
    }];

    const result = normalizedToChatMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0].artifacts?.[0]?.status).toBe('incomplete');
  });

  it('attaches an early realtime artifact frame to the final reply in the same turn', () => {
    const messages: NormalizedMessage[] = [
      {
        ...base,
        id: 'previous-assistant',
        timestamp: '2026-07-21T09:59:00.000Z',
        kind: 'text',
        role: 'assistant',
        content: 'Previous turn.',
        runId: 'turn-previous',
      },
      {
        ...base,
        id: 'artifacts-current',
        timestamp: '2026-07-21T10:00:01.000Z',
        kind: 'file_artifacts',
        runId: 'turn-current',
        artifacts: [{
          id: 'artifact-current',
          name: 'report.xlsx',
          path: 'report.xlsx',
          operation: 'created',
          source: 'workspace_diff',
          status: 'complete',
          size: 42,
          sha256: 'c'.repeat(64),
          createdAt: '2026-07-21T10:00:01.000Z',
        }],
      },
      {
        ...base,
        id: 'final-current',
        timestamp: '2026-07-21T10:00:02.000Z',
        kind: 'text',
        role: 'assistant',
        content: 'Current turn finished.',
        runId: 'turn-current',
      },
    ];

    const result = normalizedToChatMessages(messages);

    expect(result).toHaveLength(2);
    expect(result[0].content).toBe('Previous turn.');
    expect(result[0].artifacts).toBeUndefined();
    expect(result[1].content).toBe('Current turn finished.');
    expect(result[1].artifacts?.[0]?.path).toBe('report.xlsx');
  });
});
