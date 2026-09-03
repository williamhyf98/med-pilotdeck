// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initialUiCaseState } from './testFixtures';
import StageOverrideDialog from './detail/StageOverrideDialog';

afterEach(cleanup);

describe('StageOverrideDialog', () => {
  it('lists only later substages', () => {
    render(
      <StageOverrideDialog
        state={initialUiCaseState()}
        onClose={() => {}}
        onSubmit={() => {}}
      />,
    );
    const select = screen.getByLabelText('目标阶段') as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.text)).toEqual([
      '高级急救',
      '紧急救治',
      '紧急手术复苏',
      '野战专科治疗',
      '确定性专科治疗',
      '功能恢复',
      '身心康复',
    ]);
    expect(Array.from(select.options).some((option) => option.text === '初级急救')).toBe(false);
  });

  it('requires a second acknowledgement while BLOCKED', async () => {
    const submit = vi.fn();
    const state = initialUiCaseState();
    state.transport.gateStatus = 'BLOCKED';
    render(<StageOverrideDialog state={state} onClose={() => {}} onSubmit={submit} />);

    fireEvent.change(screen.getByLabelText('调整理由'), { target: { value: '现场指挥调整' } });
    fireEvent.click(screen.getByLabelText(/我已知晓人工阶段调整/));
    expect((screen.getByRole('button', { name: '确认调整' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByLabelText(/我再次确认承担未解决风险/));
    fireEvent.click(screen.getByRole('button', { name: '确认调整' }));
    expect(submit).toHaveBeenCalledOnce();
    expect(submit.mock.calls[0]?.[0].blockedOverrideConfirmed).toBe(true);
  });
});
