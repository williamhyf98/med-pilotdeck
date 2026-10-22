// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: any) => o?.defaultValue ?? k }),
}));

const logout = vi.fn();
let authState: any;
vi.mock('../auth/context/AuthContext', () => ({ useAuth: () => authState }));

import SidebarAccountArea from './SidebarAccountArea';

afterEach(() => {
  cleanup();
  logout.mockReset();
});

describe('SidebarAccountArea', () => {
  it('asks for confirmation before signing out and allows cancellation', async () => {
    authState = { user: { id: 2, username: 'alice', role: 'user' }, isAdmin: false, logout, authDisabled: false };
    const onOpenSettings = vi.fn();
    render(<SidebarAccountArea onOpenSettings={onOpenSettings} />);
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('sidebar:account.roleUser')).toBeTruthy();
    expect(screen.getByText('alice').closest('button')).toBeNull();
    fireEvent.click(screen.getByText('alice'));
    expect(onOpenSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    const logoutButton = screen.getByRole('button', { name: 'sidebar:account.logout' });
    expect(logoutButton.querySelector('svg')).toBeTruthy();
    expect(logoutButton.textContent).toBe('');
    expect(logoutButton.className).toContain('rounded-full');
    fireEvent.click(logoutButton);
    expect(logout).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Sign out?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(logout).not.toHaveBeenCalled();
    fireEvent.click(logoutButton);
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'sidebar:account.logout' }));
    await waitFor(() => expect(logout).toHaveBeenCalledOnce());
  });

  it('dismisses the confirmation with Escape without signing out', () => {
    authState = { user: { id: 2, username: 'alice', role: 'user' }, isAdmin: false, logout, authDisabled: false };
    render(<SidebarAccountArea onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'sidebar:account.logout' }));
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(logout).not.toHaveBeenCalled();
  });

  it('shows the admin badge for administrators', () => {
    authState = { user: { id: 1, username: 'root', role: 'admin' }, isAdmin: true, logout, authDisabled: false };
    render(<SidebarAccountArea onOpenSettings={() => {}} />);
    expect(screen.getByText('sidebar:account.roleAdmin').closest('button')).toBeNull();
    const accountRow = screen.getByText('root').closest('div.flex.items-center');
    expect(accountRow?.className).toContain('py-4');
  });

  it('shows the local-mode badge and no logout button when login is disabled', () => {
    authState = { user: { id: 'local', username: 'local', role: 'admin' }, isAdmin: true, logout, authDisabled: true };
    render(<SidebarAccountArea onOpenSettings={() => {}} />);
    expect(screen.getByText('sidebar:account.localMode')).toBeTruthy();
    expect(screen.queryByText('sidebar:account.roleAdmin')).toBeNull();
    expect(screen.queryByRole('button', { name: 'sidebar:account.logout' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy();
  });
});
