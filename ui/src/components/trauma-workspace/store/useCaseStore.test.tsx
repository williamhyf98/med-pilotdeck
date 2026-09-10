// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useCaseStore } from './useCaseStore';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('refreshes the matching trauma case immediately when its agent turn completes', async () => {
  const fetchMock = vi.fn(async () => ({
    ok: true,
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
