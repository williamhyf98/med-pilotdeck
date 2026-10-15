// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: Record<string, unknown>) => (o && typeof o === 'object' && 'count' in o ? `${k}:${o.count}` : k),
  }),
}));
vi.mock('../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'admin', role: 'admin' }, isAdmin: true }),
}));

const hook = vi.hoisted(() => ({
  setActive: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
  setRole: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
  deleteUser: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
  resetPassword: vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { password: 'Abc123XyZ987' } })),
  createUser: vi.fn(async (..._a: unknown[]): Promise<{ ok: true } | { ok: false; code: string; message: string }> => ({ ok: true })),
  setRegistration: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
}));
vi.mock('./useUsersAdmin', () => ({
  useUsersAdmin: () => ({
    users: [
      { id: 1, username: 'admin', role: 'admin', isActive: true, createdAt: '2026-10-01', lastLogin: null, storageBytes: 1024 },
      { id: 2, username: 'alice', role: 'user', isActive: true, createdAt: '2026-10-02', lastLogin: null, storageBytes: 2048 },
    ],
    loading: false, error: null, registrationOpen: true, refresh: vi.fn(), ...hook,
  }),
}));
import UsersSettings from './index';

describe('UsersSettings', () => {
  beforeEach(() => { Object.values(hook).forEach((m) => m.mockClear()); });
  afterEach(() => cleanup());

  it('renders rows and asks for confirmation before deactivating yourself', async () => {
    render(<UsersSettings />);
    expect(screen.getByText('alice')).toBeTruthy();
    const toggles = screen.getAllByRole('switch', { name: 'settingsPage.users.active' });
    fireEvent.click(toggles[1]);
    await waitFor(() => expect(hook.setActive).toHaveBeenCalledWith(2, false));
    fireEvent.click(toggles[0]);
    expect(screen.getByText('settingsPage.users.selfLockoutWarning')).toBeTruthy();
    expect(hook.setActive).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.users.confirm' }));
    await waitFor(() => expect(hook.setActive).toHaveBeenCalledWith(1, false));
  });

  it('shows the self-lockout confirm only for the own row when demoting', async () => {
    render(<UsersSettings />);
    const selects = screen.getAllByRole('combobox', { name: 'settingsPage.users.role' });
    fireEvent.change(selects[1], { target: { value: 'admin' } });
    await waitFor(() => expect(hook.setRole).toHaveBeenCalledWith(2, 'admin'));
    expect(screen.queryByText('settingsPage.users.selfLockoutWarning')).toBeNull();
    fireEvent.change(selects[0], { target: { value: 'user' } });
    expect(screen.getByText('settingsPage.users.selfLockoutWarning')).toBeTruthy();
    expect(hook.setRole).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.users.cancel' }));
    expect(screen.queryByText('settingsPage.users.selfLockoutWarning')).toBeNull();
    expect(hook.setRole).toHaveBeenCalledTimes(1);
  });

  it('disables deleting yourself and confirms deleting others', async () => {
    render(<UsersSettings />);
    const deletes = screen.getAllByRole('button', { name: 'settingsPage.users.delete' });
    expect((deletes[0] as HTMLButtonElement).disabled).toBe(true);
    expect(deletes[0].getAttribute('title')).toBe('settingsPage.users.cannotDeleteSelf');
    fireEvent.click(deletes[1]);
    expect(screen.getByText('settingsPage.users.deleteExplain')).toBeTruthy();
    expect(hook.deleteUser).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.users.confirm' }));
    await waitFor(() => expect(hook.deleteUser).toHaveBeenCalledWith(2));
  });

  it('shows the one-time password read-only after a reset', async () => {
    render(<UsersSettings />);
    fireEvent.click(screen.getAllByRole('button', { name: 'settingsPage.users.resetPassword' })[1]);
    const input = (await screen.findByDisplayValue('Abc123XyZ987')) as HTMLInputElement;
    expect(input.readOnly).toBe(true);
    expect(screen.getByText('settingsPage.users.resetDone')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settingsPage.users.copy' })).toBeTruthy();
  });

  it('maps create errors to localized messages', async () => {
    hook.createUser.mockResolvedValueOnce({ ok: false, code: 'RESERVED_USERNAME', message: 'reserved' });
    render(<UsersSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.users.newUser' }));
    fireEvent.change(screen.getByLabelText('settingsPage.users.username'), { target: { value: 'root' } });
    fireEvent.change(screen.getByLabelText('settingsPage.users.password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.users.create' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('settingsPage.users.errors.RESERVED_USERNAME');
  });

  it('falls back to the generic error with the server message for unknown codes', async () => {
    hook.createUser.mockResolvedValueOnce({ ok: false, code: 'HTTP_500', message: 'boom' });
    render(<UsersSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.users.newUser' }));
    fireEvent.change(screen.getByLabelText('settingsPage.users.username'), { target: { value: 'bob' } });
    fireEvent.change(screen.getByLabelText('settingsPage.users.password'), { target: { value: 'pw123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.users.create' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('settingsPage.users.errors.generic');
    expect(alert.textContent).toContain('boom');
  });

  it('toggles public registration', async () => {
    render(<UsersSettings />);
    fireEvent.click(screen.getByRole('switch', { name: 'settingsPage.users.registration' }));
    await waitFor(() => expect(hook.setRegistration).toHaveBeenCalledWith(false));
  });
});
