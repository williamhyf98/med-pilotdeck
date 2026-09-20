// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('renders inline citation badges while streaming when citations are provided', () => {
    render(
      <Markdown
        isStreaming
        className="prose"
        citations={[{ index: 1, title: '战伤救治规则', section: '第二章 分类救治' }]}
      >
        {'应先控制活动性出血[1]。'}
      </Markdown>,
    );

    expect(screen.getByText('[1]')).toBeTruthy();
    expect(screen.getByText('[1]').tagName.toLowerCase()).toBe('span');
  });

  it('renders inline citation badges while streaming even before metadata arrives', () => {
    // 候选引用还没送到时角标也必须立刻是蓝色上标，不能先当普通正文再跳变。
    render(
      <Markdown isStreaming className="prose">
        {'应先控制活动性出血[1]。'}
      </Markdown>,
    );

    expect(screen.getByText('[1]').tagName.toLowerCase()).toBe('span');
    expect(screen.getByText('[1]').closest('sup')).not.toBeNull();
  });

  it('withholds 参考来源 while streaming and shows it once the body ends', () => {
    const streaming: ChatMessage = {
      id: '__streaming_session_run',
      type: 'assistant',
      content: '应先控制活动性出血[1]。',
      timestamp: '2026-09-09T00:00:00.000Z',
      isStreaming: true,
      citations: [{ index: 1, title: '战伤救治规则', section: '第二章 分类救治' }],
    };
    const rowProps = {
      prevMessage: null,
      provider: 'pilotdeck' as const,
      selectedProject: null,
      createDiff: () => [],
      showAssistantActions: false,
    };

    const { rerender } = render(<MessageRowV2 message={streaming} {...rowProps} />);
    expect(screen.queryByText(/参考来源/)).toBeNull();

    rerender(<MessageRowV2 message={{ ...streaming, isStreaming: false }} {...rowProps} />);
    expect(screen.getByText('参考来源 · 1 条')).toBeTruthy();
  });

  it('renders extracted details citations as the trauma-style source list', () => {
    const message: ChatMessage = {
      id: 'assistant_with_details_citations',
      type: 'assistant',
      content: [
        '建议先评估气道和循环状态[1]。',
        '',
        '<details>',
        '<summary>参考来源</summary>',
        '',
        '- [1] 战伤救治规则 > 第二章 分类救治｜短引文：先救命后治伤',
        '</details>',
      ].join('\n'),
      timestamp: '2026-09-09T00:00:00.000Z',
      isStreaming: false,
    };

    const { container } = render(
      <MessageRowV2
        message={message}
        prevMessage={null}
        provider="pilotdeck"
        selectedProject={null}
        createDiff={() => []}
        showAssistantActions={false}
      />,
    );

    expect(container.querySelector('details')).toBeNull();
    expect(screen.getByText('参考来源 · 1 条')).toBeTruthy();

    fireEvent.click(screen.getByText('参考来源 · 1 条'));
    expect(screen.getByText('战伤救治规则')).toBeTruthy();
    expect(screen.getByText(/第二章 分类救治/)).toBeTruthy();
    expect(screen.getAllByText('[1]').some((node) => node.closest('sup'))).toBe(true);
  });
});
