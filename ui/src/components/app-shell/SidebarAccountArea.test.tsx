// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  it('shows username, role badge and a working logout', () => {
    authState = { user: { id: 2, username: 'alice', role: 'user' }, isAdmin: false, logout, authDisabled: false };
    render(<SidebarAccountArea onOpenAccount={() => {}} />);
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.getByText('sidebar:account.roleUser')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'sidebar:account.logout' }));
    expect(logout).toHaveBeenCalled();
  });

  it('shows the admin badge for administrators', () => {
    authState = { user: { id: 1, username: 'root', role: 'admin' }, isAdmin: true, logout, authDisabled: false };
    render(<SidebarAccountArea onOpenAccount={() => {}} />);
    expect(screen.getByText('sidebar:account.roleAdmin')).toBeTruthy();
  });

  it('shows the local-mode badge and no logout button when login is disabled', () => {
    authState = { user: { id: 'local', username: 'local', role: 'admin' }, isAdmin: true, logout, authDisabled: true };
    render(<SidebarAccountArea onOpenAccount={() => {}} />);
    expect(screen.getByText('sidebar:account.localMode')).toBeTruthy();
    expect(screen.queryByText('sidebar:account.roleAdmin')).toBeNull();
    expect(screen.queryByRole('button', { name: 'sidebar:account.logout' })).toBeNull();
  });

  it('opens the account page when the user row is clicked', () => {
    authState = { user: { id: 2, username: 'alice', role: 'user' }, isAdmin: false, logout, authDisabled: false };
    const onOpenAccount = vi.fn();
    render(<SidebarAccountArea onOpenAccount={onOpenAccount} />);
    fireEvent.click(screen.getByText('alice'));
    expect(onOpenAccount).toHaveBeenCalled();
  });
});
