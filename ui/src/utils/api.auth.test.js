// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('authenticatedFetch auth handling', () => {
  let events;
  let listener;
  beforeEach(() => {
    localStorage.setItem('auth-token', 'old');
    events = [];
    listener = (e) => events.push(e.detail);
    window.addEventListener('pilotdeck:auth-revoked', listener);
    vi.resetModules();
  });
  afterEach(() => {
    window.removeEventListener('pilotdeck:auth-revoked', listener);
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('clears the token and dispatches on a revoked 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'x', code: 'TOKEN_REVOKED' }), { status: 401 })));
    const { authenticatedFetch } = await import('./api.js');
    const res = await authenticatedFetch('/api/projects');
    expect(res.status).toBe(401);
    expect(localStorage.getItem('auth-token')).toBeNull();
    expect(events).toEqual([{ code: 'TOKEN_REVOKED' }]);
  });

  it('leaves the token alone on an unrelated 401 (e.g. BAD_CREDENTIALS)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'BAD_CREDENTIALS' }), { status: 401 })));
    const { authenticatedFetch } = await import('./api.js');
    await authenticatedFetch('/api/auth/password', { method: 'POST' });
    expect(localStorage.getItem('auth-token')).toBe('old');
    expect(events).toEqual([]);
  });

  it('leaves the token alone on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'ADMIN_REQUIRED' }), { status: 403 })));
    const { authenticatedFetch } = await import('./api.js');
    await authenticatedFetch('/api/config');
    expect(localStorage.getItem('auth-token')).toBe('old');
    expect(events).toEqual([]);
  });

  it('does not delete a newer token when a stale-token request is revoked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      // A password change stored a fresh token while this request was in flight.
      localStorage.setItem('auth-token', 'new');
      return new Response(JSON.stringify({ code: 'TOKEN_REVOKED' }), { status: 401 });
    }));
    const { authenticatedFetch } = await import('./api.js');
    await authenticatedFetch('/api/projects');
    expect(localStorage.getItem('auth-token')).toBe('new');
    expect(events).toEqual([]);
  });

  it('does not delete the current token when the 401 answers an explicitly overridden stale token', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'TOKEN_REVOKED' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const { authenticatedFetch } = await import('./api.js');
    await authenticatedFetch('/api/user/preferences', {
      method: 'PATCH',
      headers: { Authorization: 'Bearer stale' },
    });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer stale');
    expect(localStorage.getItem('auth-token')).toBe('old');
    expect(events).toEqual([]);
  });

  it('still signs out when the revoked 401 answers the request token that is current', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ code: 'TOKEN_REVOKED' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const { authenticatedFetch } = await import('./api.js');
    await authenticatedFetch('/api/projects');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer old');
    expect(localStorage.getItem('auth-token')).toBeNull();
    expect(events).toEqual([{ code: 'TOKEN_REVOKED' }]);
  });

  it('ignores X-Refreshed-Token from a request that used a stale token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
      status: 200,
      headers: { 'X-Refreshed-Token': 'stale-refresh' },
    })));
    const { authenticatedFetch } = await import('./api.js');
    await authenticatedFetch('/api/projects', { headers: { authorization: 'Bearer stale' } });
    expect(localStorage.getItem('auth-token')).toBe('old');
  });

  it('does not replace a fresh session with an older refreshed token from a cached response', async () => {
    const jwt = (claims) => `header.${btoa(JSON.stringify(claims))}.signature`;
    const fresh = jwt({ userId: 1, tokenVersion: 8, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 });
    const stale = jwt({ userId: 1, tokenVersion: 7, iat: Math.floor(Date.now() / 1000) - 8 * 86400, exp: Math.floor(Date.now() / 1000) - 86400 });
    localStorage.setItem('auth-token', fresh);
    const refreshed = [];
    const listener = (e) => refreshed.push(e.detail.token);
    window.addEventListener('pilotdeck:token-refreshed', listener);
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', {
        status: 200,
        headers: { 'X-Refreshed-Token': stale },
      })));
      const { authenticatedFetch } = await import('./api.js');
      await authenticatedFetch('/api/projects/trauma/sessions/web%3As_123/token-usage?provider=pilotdeck');
      expect(localStorage.getItem('auth-token')).toBe(fresh);
      expect(refreshed).toEqual([]);
    } finally {
      window.removeEventListener('pilotdeck:token-refreshed', listener);
    }
  });

  it('bypasses the browser cache for authenticated requests', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { authenticatedFetch } = await import('./api.js');
    await authenticatedFetch('/api/projects/trauma/sessions/web%3As_123/token-usage?provider=pilotdeck');
    expect(fetchMock.mock.calls[0][1].cache).toBe('no-store');
  });

  it('keeps the response body readable after a 401 was inspected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ code: 'NO_TOKEN', error: 'nope' }), { status: 401 })));
    const { authenticatedFetch } = await import('./api.js');
    const res = await authenticatedFetch('/api/projects');
    expect(await res.json()).toEqual({ code: 'NO_TOKEN', error: 'nope' });
  });

  it('dispatches token-refreshed when the header is present', async () => {
    const refreshed = [];
    const onRefreshed = (e) => refreshed.push(e.detail.token);
    window.addEventListener('pilotdeck:token-refreshed', onRefreshed);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'X-Refreshed-Token': 'new' } })));
    const { authenticatedFetch } = await import('./api.js');
    await authenticatedFetch('/api/projects');
    window.removeEventListener('pilotdeck:token-refreshed', onRefreshed);
    expect(localStorage.getItem('auth-token')).toBe('new');
    expect(refreshed).toEqual(['new']);
  });

  it('api.auth.changePassword posts to /api/auth/password', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { api } = await import('./api.js');
    await api.auth.changePassword('a', 'b');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/password');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ currentPassword: 'a', newPassword: 'b' });
  });
});
