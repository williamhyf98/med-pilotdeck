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
  vi.doMock('../../../constants/config', () => ({ IS_PLATFORM: false }));
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
  it('takes no-login mode from /api/auth/status and shows the server account name', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/api/auth/status')
        ? json(200, { authDisabled: true, registrationOpen: false })
        : json(200, { user: { id: 1, username: 'admin', role: 'admin' } }),
    );
    const { AuthProvider, Probe } = await loadAuth();
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('admin:admin:true')).toBeTruthy());
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/auth/user'))).toBe(true);
    // the storage namespace stays 'local' regardless of the admin's name
    expect(localStorage.getItem('pilotdeck-storage-user')).toBe('local');
  });

  it('falls back to the placeholder name when /api/auth/user fails in no-login mode', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/api/auth/status') ? json(200, { authDisabled: true }) : json(500, {}),
    );
    const { AuthProvider, Probe } = await loadAuth();
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('local-user:admin:true')).toBeTruthy());
  });

  it('shows the login screen when the server requires login, whatever the build flags say', async () => {
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/api/auth/status') ? json(200, { authDisabled: false, registrationOpen: true }) : json(401, {}),
    );
    const { AuthProvider, Probe } = await loadAuth();
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('anon:true')).toBeTruthy());
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
    expect(localStorage.getItem('u1:themeMode')).toBe('dark');
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
    expect(localStorage.getItem('u1:themeMode')).toBe('dark');
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

  it('logout clears temporary user data, preserves their preferences and shows no revoked notice', async () => {
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
    expect(localStorage.getItem('u1:themeMode')).toBe('dark');
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

  it('keeps the token when /api/auth/user fails with a server error', async () => {
    localStorage.setItem('auth-token', 't');
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/status') ? json(200, {}) : json(502, { error: 'bad gateway' }));
    const mod = await import('./AuthContext');
    function Probe() {
      const a = mod.useAuth();
      return <div>{a.isLoading ? 'loading' : a.user ? 'in' : 'out'}</div>;
    }
    render(<mod.AuthProvider><Probe /></mod.AuthProvider>);
    await waitFor(() => expect(screen.getByText('out')).toBeTruthy());
    // 后端暂时不可用不等于会话结束：token 必须留着，刷新后能直接恢复。
    expect(localStorage.getItem('auth-token')).toBe('t');
  });

  it('ignores an old auth check that answers after a new token is stored', async () => {
    localStorage.setItem('auth-token', 'old');
    let finishUser!: (response: Response) => void;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/status')) return json(200, {});
      return new Promise<Response>((resolve) => { finishUser = resolve; });
    });
    const mod = await import('./AuthContext');
    const handle: { auth: ReturnType<typeof mod.useAuth> | null } = { auth: null };
    function Probe() {
      const auth = mod.useAuth();
      handle.auth = auth;
      return <div>{auth.isLoading ? 'loading' : auth.user ? 'in' : 'out'}</div>;
    }
    render(<mod.AuthProvider><Probe /></mod.AuthProvider>);
    await waitFor(() => expect(finishUser).toBeTypeOf('function'));
    await act(async () => {
      localStorage.setItem('auth-token', 'new');
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', oldValue: 'old', newValue: 'new' }));
      finishUser(new Response(JSON.stringify({ code: 'INVALID_TOKEN' }), { status: 401 }));
    });
    expect(localStorage.getItem('auth-token')).toBe('new');
    expect(handle.auth?.token).toBe('new');
    expect(handle.auth?.sessionEndedCode).toBeNull();
  });

  it('adopts a token written by another tab', async () => {
    localStorage.setItem('auth-token', 't');
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/status') ? json(200, {}) : json(200, { user: { id: 1, username: 'alice', role: 'user' } }));
    const mod = await import('./AuthContext');
    let seen: string | null = null;
    function Probe() {
      const a = mod.useAuth();
      seen = a.token;
      return <div>{a.user ? 'in' : 'out'}</div>;
    }
    render(<mod.AuthProvider><Probe /></mod.AuthProvider>);
    await waitFor(() => expect(screen.getByText('in')).toBeTruthy());
    localStorage.setItem('auth-token', 'other-tab');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', newValue: 'other-tab' }));
    });
    await waitFor(() => expect(seen).toBe('other-tab'));
  });

  it('does not replace a newer login when an older removal probe finishes', async () => {
    localStorage.setItem('auth-token', 'old');
    let finishProbe!: (response: Response) => void;
    let userCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/status')) return json(200, {});
      if (++userCalls === 1) {
        return json(200, { user: { id: 1, username: 'alice', role: 'user' } });
      }
      return new Promise<Response>((resolve) => { finishProbe = resolve; });
    });
    const handle = await loadSession();
    localStorage.removeItem('auth-token');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', oldValue: 'old', newValue: null }));
    });
    await waitFor(() => expect(finishProbe).toBeTypeOf('function'));
    await act(async () => {
      localStorage.setItem('auth-token', 'new');
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', oldValue: null, newValue: 'new' }));
      finishProbe(new Response(JSON.stringify({ user: { id: 1, username: 'alice', role: 'user' } }), { status: 200 }));
    });
    expect(localStorage.getItem('auth-token')).toBe('new');
    expect(handle.auth?.token).toBe('new');
    expect(screen.getByText('in:none')).toBeTruthy();
  });

  it('does not sign out a newer login when an older removal probe is rejected', async () => {
    localStorage.setItem('auth-token', 'old');
    let finishProbe!: (response: Response) => void;
    let userCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/status')) return json(200, {});
      if (++userCalls === 1) return json(200, { user: { id: 1, username: 'alice', role: 'user' } });
      return new Promise<Response>((resolve) => { finishProbe = resolve; });
    });
    const handle = await loadSession();
    localStorage.removeItem('auth-token');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', oldValue: 'old', newValue: null }));
    });
    await waitFor(() => expect(finishProbe).toBeTypeOf('function'));
    await act(async () => {
      localStorage.setItem('auth-token', 'new');
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', oldValue: null, newValue: 'new' }));
      finishProbe(new Response(JSON.stringify({ code: 'TOKEN_REVOKED' }), { status: 401 }));
    });
    expect(localStorage.getItem('auth-token')).toBe('new');
    expect(handle.auth?.token).toBe('new');
    expect(screen.getByText('in:none')).toBeTruthy();
  });

  it('does not restore a token when its removal probe cannot reach the server', async () => {
    localStorage.setItem('auth-token', 'old');
    let userCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/status')) return json(200, {});
      return ++userCalls === 1
        ? json(200, { user: { id: 1, username: 'alice', role: 'user' } })
        : Promise.reject(new Error('offline'));
    });
    await loadSession();
    localStorage.removeItem('auth-token');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', oldValue: 'old', newValue: null }));
    });
    await waitFor(() => expect(userCalls).toBe(2));
    expect(localStorage.getItem('auth-token')).toBeNull();
  });

  it('rejects an older same-account token written by another tab', async () => {
    const enc = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const tokenFor = (version: number, issued: number) =>
      `${enc({ alg: 'HS256' })}.${enc({ userId: 1, tokenVersion: version, iat: issued, exp: issued + 604800 })}.sig`;
    const fresh = tokenFor(8, Math.floor(Date.now() / 1000));
    const stale = tokenFor(7, Math.floor(Date.now() / 1000) - 86400);
    localStorage.setItem('auth-token', fresh);
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/status') ? json(200, {}) : json(200, { user: { id: 1, username: 'alice', role: 'user' } }));
    const handle = await loadSession();
    localStorage.setItem('auth-token', stale);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', oldValue: fresh, newValue: stale }));
    });
    expect(localStorage.getItem('auth-token')).toBe(fresh);
    expect(handle.auth?.token).toBe(fresh);
  });

  it('ignores a delayed storage event if the stored token has since changed', async () => {
    localStorage.setItem('auth-token', 'old');
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/status') ? json(200, {}) : json(200, { user: { id: 1, username: 'alice', role: 'user' } }));
    const handle = await loadSession();
    localStorage.setItem('auth-token', 'new');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', oldValue: 'old', newValue: null }));
    });
    expect(handle.auth?.token).toBe('old');
    expect(localStorage.getItem('auth-token')).toBe('new');
  });

  it('signs out when another tab drops the token', async () => {
    localStorage.setItem('auth-token', 't');
    let userCalls = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/status')) return json(200, {});
      userCalls += 1;
      // The second call is the post-removal "is this token really dead?" probe.
      return userCalls === 1
        ? json(200, { user: { id: 1, username: 'alice', role: 'user' } })
        : json(401, { code: 'TOKEN_REVOKED' });
    });
    await loadSession();
    localStorage.removeItem('auth-token');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', newValue: null }));
    });
    await waitFor(() => expect(screen.getByText('out:TOKEN_REVOKED')).toBeTruthy());
    expect(localStorage.getItem('auth-token')).toBeNull();
  });

  it('restores a token that another tab removed but the server still accepts', async () => {
    localStorage.setItem('auth-token', 't');
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/status') ? json(200, {}) : json(200, { user: { id: 1, username: 'alice', role: 'user' } }));
    await loadSession();
    localStorage.removeItem('auth-token');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'auth-token', newValue: null }));
    });
    await waitFor(() => expect(localStorage.getItem('auth-token')).toBe('t'));
    expect(screen.getByText(/^in:/)).toBeTruthy();
  });

  // 形如 JWT 的假 token：只需要 payload 里的 exp，前端不解签名。
  const jwtWithExpiry = (expSeconds: number) => {
    const enc = (value: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      let binary = '';
      bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    };
    return `${enc({ alg: 'HS256' })}.${enc({ userId: 1, exp: expSeconds })}.sig`;
  };

  it('过期的 token 不再拿去请求，直接按会话结束处理', async () => {
    localStorage.setItem('auth-token', jwtWithExpiry(Math.floor(Date.now() / 1000) - 60));
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/status') ? json(200, {}) : json(200, { user: { id: 1, username: 'alice', role: 'user' } }));
    const mod = await import('./AuthContext');
    function SessionProbe() {
      const a = mod.useAuth();
      return <div>{a.isLoading ? 'loading' : a.user ? 'in' : `out:${a.sessionEndedCode ?? 'none'}`}</div>;
    }
    render(<mod.AuthProvider><SessionProbe /></mod.AuthProvider>);
    await waitFor(() => expect(screen.getByText('out:INVALID_TOKEN')).toBeTruthy());
    expect(localStorage.getItem('auth-token')).toBeNull();
    // 关键：明知过期就别再打 /api/auth/user，少一次无意义 401
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/auth/user'))).toBe(false);
  });

  it('回到前台时若 token 快到期，会静默续一次', async () => {
    localStorage.setItem('auth-token', jwtWithExpiry(Math.floor(Date.now() / 1000) + 3600));
    fetchMock.mockImplementation((url: string) =>
      url.endsWith('/status') ? json(200, {}) : json(200, { user: { id: 1, username: 'alice', role: 'user' } }));
    await loadSession();
    const userCalls = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/user')).length;
    expect(userCalls()).toBe(1);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await waitFor(() => expect(userCalls()).toBe(2));
  });
});
