// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../chat/types/types';
import MessageRowV2 from './MessageRowV2';
import { Markdown } from '../chat/view/subcomponents/Markdown';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

afterEach(cleanup);

describe('streaming assistant presentation', () => {
  it('shows received assistant text immediately without a typewriter delay', () => {
    const message: ChatMessage = {
      id: '__streaming_session_run',
      type: 'assistant',
      content: '已收到的流式内容',
      timestamp: '2026-09-09T00:00:00.000Z',
      isStreaming: true,
    };

    render(
      <MessageRowV2
        message={message}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
        showAssistantActions={false}
      />,
    );

    expect(screen.getByText('已收到的流式内容')).toBeTruthy();
  });

  it('does not apply the low-opacity streaming fade animation', () => {
    const { container } = render(
      <Markdown isStreaming className="prose">
        {'流式正文'}
      </Markdown>,
    );

    expect(container.querySelector('.streaming-fade-in')).toBeNull();
    expect(container.textContent).toContain('流式正文');
  });
});
