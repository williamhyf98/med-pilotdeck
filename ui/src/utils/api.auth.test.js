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
