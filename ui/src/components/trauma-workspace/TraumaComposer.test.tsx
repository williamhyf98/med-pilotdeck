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
  it('extracts free text into a confirm card and submits the normalized form with the raw input', async () => {
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

    // Confirm card appears with the extracted draft and the source text.
    await waitFor(() => expect(screen.getByRole('button', { name: '确认推演' })).not.toBeNull());
    expect(screen.getByText(/右小腿开放伤，心率 118/)).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '确认推演' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        injuryNarrative: '右小腿开放伤',
        vitals: { heartRate: 118 },
        statedSubStage: null,
      }),
      '右小腿开放伤，心率 118',
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

  it('opens the manual disclosure with the source pre-filled when extraction fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'extractor not configured',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })));
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

    await waitFor(() => expect(screen.getByRole('alert')).not.toBeNull());
    // Manual form is auto-opened and pre-filled with the failing source text.
    expect((screen.getByLabelText('伤情描述') as HTMLTextAreaElement).value).toBe('左前臂裂伤');
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
    await waitFor(() => expect(screen.getByRole('button', { name: '确认推演' })).not.toBeNull());

    // 确认卡片里的级别 select 也被同步禁用。
    const select = screen.getByLabelText('救治级别') as HTMLSelectElement;
    expect(select.disabled).toBe(true);
    expect(select.value).toBe('surgical_resuscitation');
    expect(screen.getByText('仅剩外科复苏，级别已锁定')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '确认推演' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ statedSubStage: 'surgical_resuscitation' }),
      expect.any(String),
    );
  });
});
