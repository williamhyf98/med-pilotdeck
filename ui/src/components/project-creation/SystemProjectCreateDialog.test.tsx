// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SystemProjectCreateDialog from './SystemProjectCreateDialog';

afterEach(cleanup);

describe('SystemProjectCreateDialog', () => {
  it.each([
    ['general_medicine', '通用医学', '战创伤医学'],
    ['war_trauma', '战创伤医学', '通用医学'],
  ] as const)('preselects %s and animates its dialog and project type choices', (type, selected, other) => {
    render(<SystemProjectCreateDialog initialProjectType={type} onClose={vi.fn()} onCreated={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('pd-settings-dialog-enter');
    expect(dialog.parentElement?.className).toContain('pd-settings-backdrop-enter');
    expect(screen.getByRole('button', { name: new RegExp(selected) }).getAttribute('aria-pressed')).toBe('true');
    const otherType = screen.getByRole('button', { name: new RegExp(other) });
    expect(otherType.getAttribute('aria-pressed')).toBe('false');
    expect(otherType.className).toContain('pd-project-type-card');
    fireEvent.click(otherType);
    expect(otherType.getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByText('从本地路径添加（旧）')).toBeNull();
  });

  it('animates cancellation before unmounting the project dialog', () => {
    vi.useFakeTimers();
    try {
      const onClose = vi.fn();
      const view = render(<SystemProjectCreateDialog onClose={onClose} onCreated={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      expect(screen.getByRole('dialog').className).toContain('pd-settings-dialog-exit');
      expect(view.container.querySelector('.pd-settings-backdrop-exit')).not.toBeNull();
      expect(onClose).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(579));
      expect(onClose).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(1));
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
