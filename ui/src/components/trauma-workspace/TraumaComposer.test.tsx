// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TraumaComposer from './TraumaComposer';

function stubFetch(extracted?: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    extracted: extracted ?? {
      injuryNarratives: [{ text: '右小腿开放伤' }],
      treatmentNarratives: [],
      evacuationNarratives: [],
      notes: [],
      vitals: [{ field: 'heartRate', value: 118 }],
    },
  }), {
    headers: { 'Content-Type': 'application/json' },
  })));
}

beforeEach(() => {
  cleanup();
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TraumaComposer', () => {
  it('submits with Enter but preserves Shift+Enter and IME confirmation', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(<TraumaComposer projectKey="trauma_med-demo" sessionId="web:s_1" onSubmit={onSubmit} />);
    const input = screen.getByLabelText('本轮伤情自由输入');
    fireEvent.change(input, { target: { value: '右小腿开放伤' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(expect.any(Object), '右小腿开放伤', true);
  });

  it('does not submit Enter while a turn is running or input is empty', () => {
    const onSubmit = vi.fn();
    const { rerender } = render(<TraumaComposer onSubmit={onSubmit} />);
    fireEvent.keyDown(screen.getByLabelText('本轮伤情自由输入'), { key: 'Enter' });
    rerender(<TraumaComposer onSubmit={onSubmit} submitting />);
    fireEvent.change(screen.getByLabelText('本轮伤情自由输入'), { target: { value: '伤情更新' } });
    fireEvent.keyDown(screen.getByLabelText('本轮伤情自由输入'), { key: 'Enter' });
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it('auto-grows the free text area while retaining a max-height scroll cap', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'scrollHeight',
    );
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get() {
        return 168;
      },
    });

    render(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    const textarea = screen.getByLabelText('本轮伤情自由输入') as HTMLTextAreaElement;
    fireEvent.change(textarea, {
      target: { value: '第一行\n第二行\n第三行\n第四行' },
    });

    expect(textarea.style.height).toBe('168px');
    expect(textarea.className).toContain('max-h-[40vh]');
    expect(textarea.className).toContain('overflow-y-auto');

    if (originalDescriptor) {
      Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', originalDescriptor);
    } else {
      delete (HTMLTextAreaElement.prototype as unknown as { scrollHeight?: number }).scrollHeight;
    }
  });

  it('switches between free text and exact-entry modes', async () => {
    render(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByLabelText('本轮伤情自由输入')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '精确录入' }));
    expect(screen.getByRole('form', { name: '本轮伤情录入' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '自由对话' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '自由对话' }));
    await waitFor(() => {
      expect(screen.getByLabelText('本轮伤情自由输入')).not.toBeNull();
    });
  });

  it('submits the exact-entry form without asking the runner to extract', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '精确录入' }));
    fireEvent.change(screen.getByLabelText('伤情描述'), {
      target: { value: '右小腿开放伤，渗血' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交本轮信息' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        injuryNarrative: '右小腿开放伤，渗血',
      }),
      '',
      false,
    );
  });

  it('submits free text immediately and asks the runner to extract it', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('本轮伤情自由输入'), {
      target: { value: '右小腿开放伤，心率 118' },
    });
    fireEvent.click(screen.getByRole('button', { name: '整理' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        injuryNarrative: '右小腿开放伤，心率 118',
        vitals: {},
        statedSubStage: null,
      }),
      '右小腿开放伤，心率 118',
      true,
    );
  });

  it('clears the draft when a submission starts', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const { rerender } = render(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('本轮伤情自由输入'), {
      target: { value: '右侧胸壁擦伤' },
    });

    // Simulating the parent flipping `submitting` clears the draft.
    rerender(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        onSubmit={onSubmit}
        submitting
      />,
    );
    expect((screen.getByLabelText('本轮伤情自由输入') as HTMLTextAreaElement).value).toBe('');
  });

  it('does not open a confirmation card because extraction runs inside the turn', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('本轮伤情自由输入'), {
      target: { value: '左前臂裂伤' },
    });
    fireEvent.click(screen.getByRole('button', { name: '整理' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: '确认推演' })).toBeNull();
  });

  it('keeps the transport draft within the form limit while preserving full raw input', async () => {
    const onSubmit = vi.fn(async () => undefined);
    const rawInput = `右小腿开放伤，${'补充描述'.repeat(300)}`;
    render(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText('本轮伤情自由输入'), {
      target: { value: rawInput },
    });
    fireEvent.click(screen.getByRole('button', { name: '整理' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const call = onSubmit.mock.calls[0] as unknown as [
      { injuryNarrative: string },
      string,
      boolean,
    ];
    expect(call[0].injuryNarrative).toHaveLength(1000);
    expect(call[1]).toBe(rawInput);
    expect(call[2]).toBe(true);
  });

  it('shows all four levels plus 由系统判定 when there is no previous stage', () => {
    render(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    const group = screen.getByRole('radiogroup', { name: '本轮救治级别' });
    expect(group).not.toBeNull();
    for (const label of ['由系统判定', '初级急救', '高级急救', '紧急处置', '外科复苏']) {
      expect(screen.getByRole('radio', { name: label })).not.toBeNull();
    }
  });

  it('limits options to the previous stage and its later stages', () => {
    render(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        previousSubStage="emergency_treatment"
        onSubmit={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole('radio', { name: '由系统判定' })).not.toBeNull();
    // 之前的级别不再出现。
    expect(screen.queryByRole('radio', { name: '初级急救' })).toBeNull();
    expect(screen.queryByRole('radio', { name: '高级急救' })).toBeNull();
    // 该级及其后仍可选。
    expect(screen.getByRole('radio', { name: '紧急处置' })).not.toBeNull();
    expect(screen.getByRole('radio', { name: '外科复苏' })).not.toBeNull();
  });

  it('locks 外科复苏 and hides 由系统判定 when only it remains', async () => {
    const onSubmit = vi.fn(async () => undefined);
    render(
      <TraumaComposer
        projectKey="trauma_med-demo"
        sessionId="web:s_1"
        previousSubStage="surgical_resuscitation"
        onSubmit={onSubmit}
      />,
    );

    // 由系统判定 is not offered at all.
    expect(screen.queryByRole('radio', { name: '由系统判定' })).toBeNull();
    const surgical = screen.getByRole('radio', { name: '外科复苏' });
    expect((surgical as HTMLInputElement).checked).toBe(true);
    expect((surgical as HTMLInputElement).disabled).toBe(true);

    // The locked choice still flows into the submitted form.
    fireEvent.change(screen.getByLabelText('本轮伤情自由输入'), {
      target: { value: '已到外科，需复苏处理' },
    });
    fireEvent.click(screen.getByRole('button', { name: '整理' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ statedSubStage: 'surgical_resuscitation' }),
      expect.any(String),
      true,
    );
  });
});
