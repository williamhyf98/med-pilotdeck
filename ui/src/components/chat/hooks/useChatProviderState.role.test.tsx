// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStorageUserId, setStorageUserRole } from '../../../utils/safeStorage';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../../../utils/api', () => ({ authenticatedFetch: fetchMock }));
vi.mock('../../../contexts/WebSocketContext', () => ({
  useWebSocket: () => ({ subscribe: () => () => {} }),
}));

import { useChatProviderState } from './useChatProviderState';

const urls = () => fetchMock.mock.calls.map((call) => call[0]);

describe('useChatProviderState /api/config read is admin-only', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
  });
  afterEach(() => {
    setStorageUserRole(null);
    setStorageUserId(null);
    localStorage.clear();
  });

  it('does not request /api/config for a normal user', async () => {
    setStorageUserRole('user');
    renderHook(() => useChatProviderState({ selectedSession: null }));
    await waitFor(() => expect(urls()).toContain('/api/agents/runtime-config'));
    expect(urls()).not.toContain('/api/config');
  });

  it('requests /api/config for an admin', async () => {
    setStorageUserRole('admin');
    renderHook(() => useChatProviderState({ selectedSession: null }));
    await waitFor(() => expect(urls()).toContain('/api/config'));
  });

  it('ignores a saved permission mode from an older browser session', async () => {
    setStorageUserRole('user');
    setStorageUserId(2);
    localStorage.setItem('u2:permissionMode-default', 'default');
    const { result } = renderHook(() => useChatProviderState({ selectedSession: null }));
    await waitFor(() => expect(urls()).toContain('/api/agents/runtime-config'));
    expect(result.current.permissionMode).toBe('bypassPermissions');
  });
});
