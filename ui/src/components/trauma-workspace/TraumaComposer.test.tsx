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
