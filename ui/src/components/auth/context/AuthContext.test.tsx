// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.resetModules();
  // The app defaults to no-login mode; these tests exercise the real login flow.
  vi.doMock('../../../constants/config', () => ({ IS_PLATFORM: false, DISABLE_LOCAL_AUTH: false }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.doUnmock('../../../constants/config');
});
const json = (status: number, body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  );

async function loadAuth() {
  const mod = await import('./AuthContext');
  function Probe() {
    const a = mod.useAuth();
    return (
      <div>
        {a.isLoading
          ? 'loading'
          : a.user
            ? `${a.user.username}:${a.user.role}:${a.isAdmin}`
            : `anon:${a.registrationOpen}`}
      </div>
    );
  }
  return { AuthProvider: mod.AuthProvider, Probe };
}

describe('AuthContext (multi-user)', () => {
  it('uses a local admin user in no-login mode', async () => {
    vi.doMock('../../../constants/config', () => ({ IS_PLATFORM: false, DISABLE_LOCAL_AUTH: true }));
    const { AuthProvider, Probe } = await loadAuth();
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('local-user:admin:true')).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes registrationOpen when logged out', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/api/auth/status') ? json(200, { authDisabled: false, registrationOpen: true }) : json(404, {}),
    );
    const { AuthProvider, Probe } = await loadAuth();
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('anon:true')).toBeTruthy());
  });

  it('loads role from /api/auth/user and flags admins', async () => {
    localStorage.setItem('auth-token', 't');
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/status')
        ? json(200, { registrationOpen: false })
        : json(200, { user: { id: 1, username: 'admin', role: 'admin' } }),
    );
    const { AuthProvider, Probe } = await loadAuth();
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('admin:admin:true')).toBeTruthy());
  });

  it('clears the session on pilotdeck:auth-revoked', async () => {
    localStorage.setItem('auth-token', 't');
    localStorage.setItem('u1:themeMode', 'dark');
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/status')
        ? json(200, {})
        : json(200, { user: { id: 1, username: 'alice', role: 'user' } }),
    );
    const { AuthProvider, Probe } = await loadAuth();
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('alice:user:false')).toBeTruthy());
    act(() => {
      window.dispatchEvent(new CustomEvent('pilotdeck:auth-revoked', { detail: { code: 'TOKEN_REVOKED' } }));
    });
    await waitFor(() => expect(screen.getByText(/^anon:/)).toBeTruthy());
    expect(localStorage.getItem('auth-token')).toBeNull();
    expect(localStorage.getItem('u1:themeMode')).toBeNull();
  });

  it('adopts a refreshed token from pilotdeck:token-refreshed', async () => {
    fetchMock.mockImplementation((url: string) => (url.endsWith('/status') ? json(200, {}) : json(404, {})));
    const { AuthProvider } = await loadAuth();
    const mod = await import('./AuthContext');
    let seen: string | null = null;
    function TokenProbe() {
      seen = mod.useAuth().token;
      return null;
    }
    render(<AuthProvider><TokenProbe /></AuthProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('pilotdeck:token-refreshed', { detail: { token: 'fresh' } }));
    });
    await waitFor(() => expect(seen).toBe('fresh'));
  });

  it('logout awaits the endpoint, announces auth-logout and clears user storage', async () => {
    localStorage.setItem('auth-token', 't');
    localStorage.setItem('u1:themeMode', 'dark');
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.endsWith('/status')) return json(200, {});
      if (url.endsWith('/api/auth/logout')) return json(200, { success: true });
      return json(200, { user: { id: 1, username: 'alice', role: 'user' } });
    });
    const logoutEvents: number[] = [];
    window.addEventListener('pilotdeck:auth-logout', () => logoutEvents.push(1));
    const mod = await import('./AuthContext');
    let logout: () => Promise<void> | void = () => {};
    function LogoutProbe() {
      const a = mod.useAuth();
      logout = a.logout;
      return <div>{a.user ? 'in' : 'out'}</div>;
    }
    render(<mod.AuthProvider><LogoutProbe /></mod.AuthProvider>);
    await waitFor(() => expect(screen.getByText('in')).toBeTruthy());
    await act(async () => { await logout(); });
    await waitFor(() => expect(screen.getByText('out')).toBeTruthy());
    expect(logoutEvents).toHaveLength(1);
    expect(localStorage.getItem('auth-token')).toBeNull();
    expect(localStorage.getItem('u1:themeMode')).toBeNull();
  });

  const revoke = () =>
    window.dispatchEvent(new CustomEvent('pilotdeck:auth-revoked', { detail: { code: 'TOKEN_REVOKED' } }));

  async function loadSession() {
    const mod = await import('./AuthContext');
    const handle: { auth: ReturnType<typeof mod.useAuth> | null } = { auth: null };
    function SessionProbe() {
      const a = mod.useAuth();
      handle.auth = a;
      return <div>{a.isLoading ? 'loading' : a.user ? `in:${a.sessionEndedCode ?? 'none'}` : `out:${a.sessionEndedCode ?? 'none'}`}</div>;
    }
    render(<mod.AuthProvider><SessionProbe /></mod.AuthProvider>);
    await waitFor(() => expect(screen.getByText(/^in:/)).toBeTruthy());
    return handle;
  }

  it('keeps the session and namespace when the server revokes the old token after a password change', async () => {
    localStorage.setItem('auth-token', 'old');
    localStorage.setItem('u1:themeMode', 'dark');
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/status')) return json(200, {});
      if (url.endsWith('/api/auth/password')) {
        // The gateway closes our own socket with 4401 before the response arrives.
        revoke();
        return json(200, { success: true, token: 'new' });
      }
      return json(200, { user: { id: 1, username: 'alice', role: 'user' } });
    });
    const handle = await loadSession();
    let result: unknown;
    await act(async () => { result = await handle.auth!.changePassword('a', 'b'); });
    expect(result).toEqual({ success: true });
    expect(screen.getByText('in:none')).toBeTruthy();
    expect(handle.auth!.token).toBe('new');
    expect(localStorage.getItem('auth-token')).toBe('new');
    expect(localStorage.getItem('u1:themeMode')).toBe('dark');
  });

  it('logout wipes only the user namespace and shows no revoked notice', async () => {
    localStorage.setItem('auth-token', 't');
    localStorage.setItem('u1:themeMode', 'dark');
    localStorage.setItem('anon:themeMode', 'warm');
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/status')) return json(200, {});
      if (url.endsWith('/api/auth/logout')) {
        revoke();
        return json(200, { success: true });
      }
      return json(200, { user: { id: 1, username: 'alice', role: 'user' } });
    });
    const handle = await loadSession();
    await act(async () => { await handle.auth!.logout(); });
    await waitFor(() => expect(screen.getByText('out:none')).toBeTruthy());
    expect(localStorage.getItem('u1:themeMode')).toBeNull();
    expect(localStorage.getItem('anon:themeMode')).toBe('warm');
    expect(localStorage.getItem('auth-token')).toBeNull();
  });

  it('still treats an unexpected revoke as a session end', async () => {
    localStorage.setItem('auth-token', 't');
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/status') ? json(200, {}) : json(200, { user: { id: 1, username: 'alice', role: 'user' } }));
    await loadSession();
    act(() => { revoke(); });
    await waitFor(() => expect(screen.getByText('out:TOKEN_REVOKED')).toBeTruthy());
  });
});
