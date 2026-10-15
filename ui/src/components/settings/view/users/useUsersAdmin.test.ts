// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<[string, unknown]> = [];
vi.mock('../../../../utils/api', () => ({
  api: { admin: {
    listUsers: () => (calls.push(['list', undefined]), Promise.resolve(new Response(JSON.stringify({ users: [{ id: 1, username: 'admin', role: 'admin', isActive: true, storageBytes: 10 }, { id: 2, username: 'alice', role: 'user', isActive: true, storageBytes: 20 }] })))),
    getRegistration: () => Promise.resolve(new Response(JSON.stringify({ allowPublicRegistration: true }))),
    patchUser: (id: number, patch: unknown) => (calls.push([`patch:${id}`, patch]), Promise.resolve(new Response(JSON.stringify({ error: 'x', code: 'LAST_ADMIN' }), { status: 409 }))),
    resetPassword: () => Promise.resolve(new Response(JSON.stringify({ password: 'Abc123XyZ987' }))),
    createUser: () => Promise.resolve(new Response(JSON.stringify({ user: { id: 3, username: 'bob', role: 'user', isActive: true } }), { status: 201 })),
    deleteUser: () => Promise.resolve(new Response(JSON.stringify({ archived: true }))),
    setRegistration: () => Promise.resolve(new Response(JSON.stringify({ allowPublicRegistration: false }))),
  } },
}));
import { useUsersAdmin } from './useUsersAdmin';

describe('useUsersAdmin', () => {
  beforeEach(() => { calls.length = 0; });

  it('loads users and registration flag', async () => {
    const { result } = renderHook(() => useUsersAdmin());
    await waitFor(() => expect(result.current.users).toHaveLength(2));
    expect(result.current.registrationOpen).toBe(true);
  });

  it('surfaces LAST_ADMIN as a readable error and does not mutate local state', async () => {
    const { result } = renderHook(() => useUsersAdmin());
    await waitFor(() => expect(result.current.users).toHaveLength(2));
    let outcome: Awaited<ReturnType<typeof result.current.setRole>> | undefined;
    await act(async () => { outcome = await result.current.setRole(1, 'user'); });
    expect(outcome).toMatchObject({ ok: false, code: 'LAST_ADMIN' });
    expect(result.current.users.find((u) => u.id === 1)?.role).toBe('admin');
  });

  it('returns the one-time password on reset', async () => {
    const { result } = renderHook(() => useUsersAdmin());
    await waitFor(() => expect(result.current.users).toHaveLength(2));
    let outcome: Awaited<ReturnType<typeof result.current.resetPassword>> | undefined;
    await act(async () => { outcome = await result.current.resetPassword(2); });
    expect(outcome).toMatchObject({ ok: true, data: { password: 'Abc123XyZ987' } });
  });

  it('refreshes the list after a successful mutation but not after a failed one', async () => {
    const { result } = renderHook(() => useUsersAdmin());
    await waitFor(() => expect(result.current.users).toHaveLength(2));
    const listCallsBefore = calls.filter(([k]) => k === 'list').length;
    await act(async () => { await result.current.setRole(1, 'user'); });
    expect(calls.filter(([k]) => k === 'list').length).toBe(listCallsBefore);
    await act(async () => { await result.current.createUser('bob', 'pw123456', 'user'); });
    expect(calls.filter(([k]) => k === 'list').length).toBe(listCallsBefore + 1);
  });

  it('reports a network failure as a failed result instead of throwing', async () => {
    const { result } = renderHook(() => useUsersAdmin());
    await waitFor(() => expect(result.current.users).toHaveLength(2));
    const { api } = await import('../../../../utils/api');
    const original = api.admin.deleteUser;
    api.admin.deleteUser = () => Promise.reject(new Error('offline'));
    let outcome: Awaited<ReturnType<typeof result.current.deleteUser>> | undefined;
    await act(async () => { outcome = await result.current.deleteUser(2); });
    api.admin.deleteUser = original;
    expect(outcome).toMatchObject({ ok: false, code: 'NETWORK', message: 'offline' });
  });
});
