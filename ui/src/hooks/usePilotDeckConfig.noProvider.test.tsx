// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

describe('usePilotDeckConfig without a provider (normal user)', () => {
  it('returns a read-only empty state and never fetches /api/config', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { usePilotDeckConfig } = await import('./usePilotDeckConfig');
    const { result } = renderHook(() => usePilotDeckConfig());
    expect(result.current).toMatchObject({ raw: null, loading: false, readOnly: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
