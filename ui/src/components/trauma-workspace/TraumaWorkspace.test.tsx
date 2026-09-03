// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TraumaWorkspace from './TraumaWorkspace';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
  }),
}));

afterEach(cleanup);

describe('TraumaWorkspace demo workflow', () => {
  it('keeps stage nodes non-interactive and opens details only from memo leaves', () => {
    render(<TraumaWorkspace resetKey="trauma:session-1" />);

    expect(screen.queryByRole('button', { name: /战现场急救/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /初级急救/ })).toBeNull();

    const firstMemo = screen.getByRole('button', { name: /R1首次报告/ });
    fireEvent.click(firstMemo);
    expect(screen.getByRole('heading', { name: '当前伤员状态' })).not.toBeNull();
    expect(screen.getByText('清醒，能正常对答（GCS 15）')).not.toBeNull();
    expect(screen.getByText('本轮最新状态')).not.toBeNull();

    fireEvent.click(firstMemo);
    expect(screen.queryByRole('heading', { name: '当前伤员状态' })).toBeNull();
  });

  it('adds memo leaves under their historical substage as the demo advances', () => {
    render(<TraumaWorkspace resetKey="trauma:session-1" />);

    expect(screen.getAllByRole('button', { name: /^R\d/ })).toHaveLength(1);
    const nextButton = screen.getByRole('button', { name: '下一轮演示' });
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);

    expect(screen.getAllByRole('button', { name: /^R\d/ })).toHaveLength(5);
    expect(screen.getByText('Ⅱ级 · 紧急处置')).not.toBeNull();

    const earlyStageMemo = screen.getByRole('button', { name: /R5进入Ⅱ级/ });
    fireEvent.click(earlyStageMemo);
    const detail = screen.getByLabelText('轮次纪要详情');
    expect(within(detail).getByText('Ⅱ级 早期救治 › 紧急处置 › Round 5')).not.toBeNull();
    expect(within(detail).getByText('本轮最新状态')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /R2生命体征补充/ }));
    expect(within(detail).getByText('历史轮次快照')).not.toBeNull();
  });

  it('renders the demo conversation through the standard chat message rows', () => {
    render(<TraumaWorkspace resetKey="trauma:session-1" />);

    const transcript = screen.getByLabelText('演示案例对话');
    const userMessage = within(transcript).getByText(/爆炸后有一名伤员/);
    expect(userMessage.closest('.rounded-\\[22px\\]')).not.toBeNull();
    expect(within(transcript).queryByText(/呼吸大约每分钟32次/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '下一轮演示' }));
    expect(within(transcript).getByText(/呼吸大约每分钟32次/)).not.toBeNull();
    expect(within(transcript).getByText('是否确认将救治阶段转入「Ⅰ级 · 高级急救（营救护站）」？')).not.toBeNull();
    expect(within(transcript).getByText('确认转入高级急救')).not.toBeNull();
  });

  it('marks the current round leaf with its gate status', () => {
    render(<TraumaWorkspace resetKey="trauma:session-1" />);

    expect(screen.getByRole('button', { name: /R1首次报告.*当前/ })).not.toBeNull();

    const nextButton = screen.getByRole('button', { name: '下一轮演示' });
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);
    fireEvent.click(nextButton);

    expect(screen.getByRole('button', { name: /R4后送受阻.*阻塞/ })).not.toBeNull();
    expect(screen.getByRole('button', { name: /^R1首次报告/ }).textContent).not.toContain('当前');
  });
});
