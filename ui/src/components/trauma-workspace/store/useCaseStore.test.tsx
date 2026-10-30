// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCaseStore } from './useCaseStore';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it('sends the session token with the case-status request', async () => {
  localStorage.setItem('auth-token', 'tok-1');
  const fetchMock = vi.fn(async () => ({
    ok: true,
    headers: new Headers(),
    json: async () => ({ current: null, snapshots: [] }),
  }));
  vi.stubGlobal('fetch', fetchMock);

  renderHook(() => useCaseStore('trauma_med-demo', 'web:s_demo'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toContain('/api/trauma/cases/web%3As_demo');
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
});

it('refreshes the matching trauma case immediately when its agent turn completes', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    headers: new Headers(),
    json: async () => ({ current: null, snapshots: [] }),
  }));
  vi.stubGlobal('fetch', fetchMock);

  renderHook(() => useCaseStore('trauma_med-demo', 'web:s_demo'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  act(() => {
    window.dispatchEvent(new CustomEvent('pilotdeck:agent-turn-complete', {
      detail: {
        sessionId: 'web:s_demo',
        projectName: 'trauma_med-demo',
        projectPath: '/pilot/workspaces/trauma_med/trauma_med-demo',
      },
    }));
  });

  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
});

it('ignores completion events for another session', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    headers: new Headers(),
    json: async () => ({ current: null, snapshots: [] }),
  }));
  vi.stubGlobal('fetch', fetchMock);

  renderHook(() => useCaseStore('trauma_med-demo', 'web:s_demo'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

  act(() => {
    window.dispatchEvent(new CustomEvent('pilotdeck:agent-turn-complete', {
      detail: {
        sessionId: 'web:s_other',
        projectName: 'trauma_med-demo',
      },
    }));
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
