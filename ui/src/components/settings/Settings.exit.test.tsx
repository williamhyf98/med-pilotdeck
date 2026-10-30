// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Settings from './Settings';

vi.mock('../auth/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: false, authDisabled: false }),
}));
vi.mock('./view/SettingsSidebar', () => ({
  default: ({ onClose }: { onClose: () => void }) =>
    <button type="button" onClick={onClose}>返回应用</button>,
  getSelectableMenuKeys: () => ['general'],
}));
vi.mock('./view/SettingsContent', () => ({
  default: () => <div>设置内容</div>,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Settings exit', () => {
  it('fades out before telling the shell to unmount', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const view = render(<Settings isOpen onClose={onClose} projects={[]} />);
    fireEvent.click(screen.getByRole('button', { name: '返回应用' }));
    expect(view.container.querySelector('.pd-settings-dialog-exit')).not.toBeNull();
    expect(view.container.querySelector('.pd-settings-backdrop-exit')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(579));
    expect(onClose).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
