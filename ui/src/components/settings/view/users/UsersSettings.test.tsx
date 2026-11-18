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
  refreshStorage: vi.fn(async (..._a: unknown[]) => undefined),
  restoreUser: vi.fn(async (..._a: unknown[]) => ({ ok: true as const })),
}));
const archived = vi.hoisted(() => [
  {
    id: 99,
    username: 'ghost',
    role: 'user',
    isActive: false,
    archived: true,
    archivedAt: '2026-11-01T00:00:00.000Z',
    expiresAt: '2026-12-01T00:00:00.000Z',
    storageBytes: 0,
    inboxBytes: 0,
    archivedBytes: 8192,
  },
  ...Array.from({ length: 5 }, (_, index) => ({
    id: 100 + index,
    username: `archived${index + 1}`,
    role: 'user' as const,
    isActive: false,
    archived: true,
    archivedAt: `2026-10-${String(31 - index).padStart(2, '0')}T00:00:00.000Z`,
    expiresAt: `2026-11-${String(30 - index).padStart(2, '0')}T00:00:00.000Z`,
    storageBytes: 0,
    inboxBytes: 0,
    archivedBytes: (index + 1) * 1024,
  })),
]);
vi.mock('./useUsersAdmin', () => ({
  useUsersAdmin: () => ({
    users: [
      { id: 1, username: 'admin', role: 'admin', isActive: true, createdAt: '2026-10-01', lastLogin: null, storageBytes: 4096, inboxBytes: 1024, archivedBytes: 0 },
      { id: 2, username: 'alice', role: 'user', isActive: true, createdAt: '2026-10-02', lastLogin: null, storageBytes: 2048, inboxBytes: 512, archivedBytes: 0 },
      { id: 3, username: 'user3', role: 'user', isActive: true, createdAt: '2026-10-03', lastLogin: null, storageBytes: 1024, inboxBytes: 256, archivedBytes: 0 },
      { id: 4, username: 'user4', role: 'user', isActive: true, createdAt: '2026-10-04', lastLogin: null, storageBytes: 512, inboxBytes: 128, archivedBytes: 0 },
      { id: 5, username: 'user5', role: 'user', isActive: true, createdAt: '2026-10-05', lastLogin: null, storageBytes: 256, inboxBytes: 64, archivedBytes: 0 },
      { id: 6, username: 'user6', role: 'user', isActive: true, createdAt: '2026-10-06', lastLogin: null, storageBytes: 128, inboxBytes: 32, archivedBytes: 0 },
      { id: 7, username: 'user7', role: 'user', isActive: true, createdAt: '2026-10-07', lastLogin: null, storageBytes: 64, inboxBytes: 16, archivedBytes: 0 },
      { id: 8, username: 'user8', role: 'user', isActive: true, createdAt: '2026-10-08', lastLogin: null, storageBytes: 32, inboxBytes: 8, archivedBytes: 0 },
      { id: 9, username: 'user9', role: 'user', isActive: true, createdAt: '2026-10-09', lastLogin: null, storageBytes: 16, inboxBytes: 4, archivedBytes: 0 },
      { id: 10, username: 'user10', role: 'user', isActive: true, createdAt: '2026-10-10', lastLogin: null, storageBytes: 8, inboxBytes: 2, archivedBytes: 0 },
      { id: 11, username: 'user11', role: 'user', isActive: true, createdAt: '2026-10-11', lastLogin: null, storageBytes: 4, inboxBytes: 1, archivedBytes: 0 },
    ],
    archivedUsers: archived,
    storage: { totalBytes: 6144, totalInboxBytes: 1536, archivedBytes: 0, userTotalWarningBytes: 20 * 1024 ** 3 },
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

  it('shows the deployment total, sorts by storage and offers a manual refresh', async () => {
    render(<UsersSettings />);
    expect(screen.getByText(/settingsPage\.users\.summary:11/)).toBeTruthy();

    // Default order is descending by bytes, so admin (4 KB) sits above alice (2 KB).
    const bodyRows = () => screen.getAllByRole('row').slice(1);
    expect(bodyRows()[0].textContent).toContain('admin');

    fireEvent.click(screen.getByRole('button', {
      name: 'settingsPage.users.storage · settingsPage.users.descending',
    }));
    expect(bodyRows()[0].textContent).toContain('user11');

    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.users.refresh' }));
    await waitFor(() => expect(hook.refreshStorage).toHaveBeenCalled());
  });

  it('searches by username and shows at most ten users per page', () => {
    render(<UsersSettings />);
    expect(screen.queryByText('user11')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'settingsPage.users.nextPage' })[0]);
    expect(screen.getByText('user11')).toBeTruthy();
    expect(screen.queryByText('admin')).toBeNull();

    const search = screen.getByRole('searchbox', { name: 'settingsPage.users.searchUsername' });
    fireEvent.change(search, { target: { value: 'alice' } });
    expect(screen.getByText('alice')).toBeTruthy();
    expect(screen.queryByText('user11')).toBeNull();
    expect(screen.queryByText('admin')).toBeNull();
  });
  it('lists archived accounts separately and restores one after confirmation', async () => {
    render(<UsersSettings />);
    // 归档账号不在主表里，只在独立的区块出现，并且带归档/到期时间。
    expect(screen.getByText('settingsPage.users.archivedTitle')).toBeTruthy();
    expect(screen.getByText('ghost')).toBeTruthy();
    expect(screen.getAllByText('settingsPage.users.archivedTag').length).toBeGreaterThan(0);
    expect(screen.getByText('settingsPage.users.expiresAt')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'settingsPage.users.restore' })[0]);
    expect(screen.getByText('settingsPage.users.restoreHint')).toBeTruthy();
    expect(hook.restoreUser).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'settingsPage.users.confirm' }));
    await waitFor(() => expect(hook.restoreUser).toHaveBeenCalledWith(99));
  });

  it('searches, sorts and paginates archived accounts separately', () => {
    render(<UsersSettings />);
    expect(screen.getByText('ghost')).toBeTruthy();
    expect(screen.queryByText('archived5')).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: 'settingsPage.users.nextPage' })[1]);
    expect(screen.getByText('archived5')).toBeTruthy();
    expect(screen.queryByText('ghost')).toBeNull();

    const search = screen.getByRole('searchbox', { name: 'settingsPage.users.searchArchivedUsername' });
    fireEvent.change(search, { target: { value: 'ghost' } });
    expect(screen.getByText('ghost')).toBeTruthy();
    expect(screen.queryByText('archived1')).toBeNull();
  });
});
