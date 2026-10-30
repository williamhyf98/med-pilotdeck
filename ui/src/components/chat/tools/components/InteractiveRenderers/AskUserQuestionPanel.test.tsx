// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskUserQuestionPanel } from './AskUserQuestionPanel';

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    return window.setTimeout(() => callback(performance.now()), 0);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AskUserQuestionPanel IME behavior', () => {
  it('does not submit the Other input when Enter confirms IME composition', () => {
    const onDecision = vi.fn();
    const request = {
      requestId: 'request-1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Choose a path',
            options: [{ label: 'Default', description: 'Use the default path' }],
          },
        ],
      },
    };

    render(<AskUserQuestionPanel request={request} onDecision={onDecision} />);

    fireEvent.click(screen.getByText('其他…'));
    const otherInput = screen.getByPlaceholderText('请输入你的回答…');
    fireEvent.change(otherInput, { target: { value: 'nihao' } });

    fireEvent.keyDown(otherInput, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 229,
      which: 229,
    });
    expect(onDecision).not.toHaveBeenCalled();

    fireEvent.keyDown(otherInput, {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
    });

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision).toHaveBeenCalledWith(
      'request-1',
      expect.objectContaining({
        allow: true,
        updatedInput: expect.objectContaining({
          answers: { 'Choose a path': 'nihao' },
        }),
      }),
    );
  });
});

describe('AskUserQuestionPanel allowOther', () => {
  const renderPanel = (allowOther?: boolean) => {
    const onDecision = vi.fn();
    render(
      <AskUserQuestionPanel
        request={{
          requestId: 'request-1',
          toolName: 'AskUserQuestion',
          input: {
            questions: [{
              question: '请选择本轮后续推演采用的主级和子级',
              options: [{ label: '采用建议：Ⅱ级·早期救治 · 紧急处置', description: '符合定义' }],
              ...(allowOther === undefined ? {} : { allowOther }),
            }],
          },
        }}
        onDecision={onDecision}
      />,
    );
    return onDecision;
  };

  it('offers the free-text escape hatch by default', () => {
    renderPanel();
    expect(screen.queryByText('其他…')).not.toBeNull();
  });

  it('hides 其他… entirely when the question disallows it', () => {
    renderPanel(false);
    expect(screen.queryByText('其他…')).toBeNull();
    expect(screen.queryByPlaceholderText('请输入你的回答…')).toBeNull();
  });

  it('ignores the 0 shortcut when 其他… is disabled', () => {
    renderPanel(false);
    // 快捷键不能成为绕开 allowOther 的后门，否则又会走回自由填空的死路。
    fireEvent.keyDown(screen.getByText('请选择本轮后续推演采用的主级和子级'), { key: '0' });
    expect(screen.queryByPlaceholderText('请输入你的回答…')).toBeNull();
  });
});
