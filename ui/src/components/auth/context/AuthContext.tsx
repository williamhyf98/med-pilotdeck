import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { IS_PLATFORM } from '../../../constants/config';
import { api } from '../../../utils/api';
import { flushUserPreferenceSaves, USER_PREFERENCES_FLUSH_EVENT } from '../userPreferenceSaveQueue';
import { clearSessionStorageForUser, getStorageUserId, setStorageUserId, setStorageUserRole } from '../../../utils/safeStorage';
import { AUTH_ERROR_MESSAGES, AUTH_TOKEN_STORAGE_KEY } from '../constants';
import { isOlderTokenForSameUser } from '../../../utils/authToken';
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
} from '../types';
import { isJwtExpired, parseJsonSafely, readJwtExpiryMs, resolveApiErrorMessage } from '../utils';

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

const EXPECTED_REVOKE_WINDOW_MS = 5000;
// 回到前台时，若 token 距到期不足这个时长就顺手续一次（服务端会在响应头回新 token）。
// 目的：长期挂着不动的标签页不会"下一次点击才突然过期"。
const RENEW_BEFORE_EXPIRY_MS = 24 * 60 * 60 * 1000;
// No-login mode: the server answers every request as the administrator. The
// storage namespace keeps the stable id 'local' (preferences must not move when
// the admin is renamed); only the display name is taken from the server.
const LOCAL_ADMIN_USER: AuthUser = { id: 'local', username: 'local-user', role: 'admin' };
const PLATFORM_USER: AuthUser = { id: 'platform', username: 'platform-user', role: 'admin' };

/** No-login mode: ask the server which account it acts as, falling back to the placeholder. */
async function resolveLocalAdminUser(): Promise<AuthUser> {
  try {
    const response = await api.auth.user();
    if (!response.ok) return LOCAL_ADMIN_USER;
    const payload = await parseJsonSafely<AuthUserPayload>(response);
    const username = payload?.user?.username;
    return username ? { ...LOCAL_ADMIN_USER, username } : LOCAL_ADMIN_USER;
  } catch {
    return LOCAL_ADMIN_USER;
  }
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUserState] = useState<AuthUser | null>(null);
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(true);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [authDisabled, setAuthDisabled] = useState(false);
  const [sessionEndedCode, setSessionEndedCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Password change and logout make the server revoke the token (closing our own
  // socket with 4401). That revoke is self-inflicted, not a session end.
  const expectedRevokeUntilRef = useRef(0);
  const expectRevoke = useCallback(() => {
    expectedRevokeUntilRef.current = Date.now() + EXPECTED_REVOKE_WINDOW_MS;
  }, []);

  // The storage namespace must switch before any child renders with the new
  // user, otherwise their initial state would be read from the wrong prefix.
  const applyUser = useCallback((nextUser: AuthUser | null) => {
    // Role first: switching the namespace fires listeners (language sync) that
    // consult it.
    setStorageUserRole(nextUser?.role ?? null);
    setStorageUserId(nextUser?.id ?? null);
    setUserState(nextUser);
  }, []);

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    applyUser(nextUser);
    setToken(nextToken);
    persistToken(nextToken);
  }, [applyUser]);

  const clearSession = useCallback(() => {
    applyUser(null);
    setToken(null);
    clearStoredToken();
  }, [applyUser]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusPayload = await parseJsonSafely<AuthStatusPayload>(statusResponse);

      setRegistrationOpen(Boolean(statusPayload?.registrationOpen));

      if (statusPayload?.authDisabled) {
        setAuthDisabled(true);
        applyUser(await resolveLocalAdminUser());
        return;
      }

      setAuthDisabled(false);

      const storedToken = readStoredToken();
      if (!storedToken) {
        applyUser(null);
        return;
      }

      // token 已经过期就别再拿去请求了：那不是"网络错误"，而是会话确实结束。
      // 提前判定 + 清态，用户看到的是明确的一句"登录已失效"，而不是点进某个
      // 页面后突然被踢出来（服务端 401 才被动处理，体验上更莫名其妙）。
      if (isJwtExpired(storedToken)) {
        clearSessionStorageForUser(getStorageUserId());
        clearSession();
        setSessionEndedCode('INVALID_TOKEN');
        return;
      }

      const userResponse = await api.auth.user();
      // A login or another tab can replace the token while this request is in flight.
      if (readStoredToken() !== storedToken) return;
      if (!userResponse.ok) {
        // 401 才是"会话确实结束"；5xx / 网关错误只是后端暂时不可用
        // （比如刚重启服务的一两秒）。这时清掉 token 会把用户踢下线，
        // 而且连"刷新重试"的机会都没有。
        if (userResponse.status === 401) {
          clearSession();
        } else {
          setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
        }
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
      if (readStoredToken() !== storedToken) return;
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      applyUser(userPayload.user);
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
    } finally {
      setIsLoading(false);
    }
  }, [applyUser, clearSession]);

  useEffect(() => {
    if (IS_PLATFORM) {
      setAuthDisabled(true);
      applyUser(PLATFORM_USER);
      setIsLoading(false);
      return;
    }

    void checkAuthStatus();
  }, [applyUser, checkAuthStatus]);

  // 标签页长时间挂着不请求，token 不会自己续（服务端只在"过半程"的请求上回新 token）。
  // 所以回到前台时补一刀：剩余寿命不足 24 小时就发一个轻量请求，把新 token 拿回来。
  useEffect(() => {
    if (IS_PLATFORM) return;
    const renewIfNeeded = () => {
      const stored = readStoredToken();
      if (!stored) return;
      const expiry = readJwtExpiryMs(stored);
      if (expiry === null || expiry - Date.now() > RENEW_BEFORE_EXPIRY_MS) return;
      // 失败不用管：真过期的话 401 会走统一的 auth-revoked 流程。
      void api.auth.user().catch(() => {});
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') renewIfNeeded();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', renewIfNeeded);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', renewIfNeeded);
    };
  }, []);

  // Server-side session end (401 with a revoked code, WebSocket 4401) and
  // silently refreshed tokens arrive as window events from non-React code.
  useEffect(() => {
    const onRevoked = (event: Event) => {
      if (Date.now() < expectedRevokeUntilRef.current) return;
      const detail = (event as CustomEvent<{ code?: string; token?: string | null }>).detail ?? {};
      const code = detail.code ?? 'TOKEN_REVOKED';
      // 兜底：若事件来自一条用旧 token 建立的连接，而 localStorage 里已经是
      // 新的会话，就只是跟上新 token，不结束登录。
      const currentToken = readStoredToken();
      if (currentToken && detail.token && currentToken !== detail.token) {
        setToken(currentToken);
        return;
      }
      clearSessionStorageForUser(getStorageUserId());
      clearSession();
      setSessionEndedCode(code);
    };
    const onTokenRefreshed = (event: Event) => {
      const nextToken = (event as CustomEvent<{ token?: string }>).detail?.token;
      if (nextToken) setToken(nextToken);
    };
    window.addEventListener('pilotdeck:auth-revoked', onRevoked);
    window.addEventListener('pilotdeck:token-refreshed', onTokenRefreshed);
    return () => {
      window.removeEventListener('pilotdeck:auth-revoked', onRevoked);
      window.removeEventListener('pilotdeck:token-refreshed', onTokenRefreshed);
    };
  }, [clearSession]);

  // 同一个浏览器的多个标签页共用一份 localStorage：另一个标签页登录、主动
  // 退出或被服务端踢下线时，本标签页必须跟着换 token / 收摊，否则会继续拿着
  // 已经作废的 token 发请求，然后被 401 打断在半路上。
  useEffect(() => {
    if (IS_PLATFORM) return;
    // 一枚 token 是不是真的作废了，只有服务端说了算。别的标签页把 localStorage
    // 里的 token 删掉，可能是正常退出，也可能是"跑着旧代码的陈旧标签页"误删。
    // 后者不能让还在用它的标签页跟着下线，所以问一句再决定。
    const isTokenStillValid = async (value: string) => {
      try {
        const response = await fetch('/api/auth/user', {
          headers: { Authorization: `Bearer ${value}` },
        });
        return response.ok;
      } catch {
        // No server answer cannot establish that a removed token is still valid.
        return null;
      }
    };
    const onStorage = async (event: StorageEvent) => {
      if (event.key !== AUTH_TOKEN_STORAGE_KEY) return;
      if (event.storageArea && event.storageArea !== localStorage) return;
      if (event.newValue) {
        if (readStoredToken() !== event.newValue) return;
        if (token && !isJwtExpired(token) && isOlderTokenForSameUser(event.newValue, token)) {
          persistToken(token);
          return;
        }
        setToken(event.newValue);
        setSessionEndedCode(null);
        if (!user) void checkAuthStatus();
        return;
      }
      if (readStoredToken() !== null) return;
      const droppedToken = token;
      if (!droppedToken) {
        clearSession();
        return;
      }
      const valid = await isTokenStillValid(droppedToken);
      // Never overwrite a login completed while the validity probe was pending.
      if (readStoredToken() !== null) return;
      if (valid === true) {
        // 误删：把这枚仍然有效的 token 放回去（其它标签页也会跟着同步回来）。
        persistToken(droppedToken);
        setToken(droppedToken);
        setSessionEndedCode(null);
        return;
      }
      if (valid === null) return;
      clearSession();
      setSessionEndedCode('TOKEN_REVOKED');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [checkAuthStatus, clearSession, token, user]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.login(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSessionEndedCode(null);
        setSession(payload.user, payload.token);
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [setSession],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const response = await api.auth.register(username, password);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSessionEndedCode(null);
        setSession(payload.user, payload.token);
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        setError(AUTH_ERROR_MESSAGES.networkError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [setSession],
  );

  const changePassword = useCallback<AuthContextValue['changePassword']>(
    async (currentPassword, newPassword) => {
      try {
        expectRevoke();
        const response = await api.auth.changePassword(currentPassword, newPassword);
        const payload = await parseJsonSafely<AuthSessionPayload>(response);

        if (!response.ok || !payload?.token) {
          return {
            success: false,
            error: resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.passwordChangeFailed),
          };
        }

        // Changing the password bumps the token version; adopt the new token.
        setToken(payload.token);
        persistToken(payload.token);
        return { success: true };
      } catch (caughtError) {
        console.error('Change password error:', caughtError);
        return { success: false, error: AUTH_ERROR_MESSAGES.networkError };
      }
    },
    [expectRevoke],
  );

  const logout = useCallback<AuthContextValue['logout']>(async () => {
    const wipeId = getStorageUserId();
    window.dispatchEvent(new Event(USER_PREFERENCES_FLUSH_EVENT));
    await flushUserPreferenceSaves();
    if (readStoredToken()) {
      try {
        expectRevoke();
        await api.auth.logout();
      } catch (caughtError) {
        console.error('Logout endpoint error:', caughtError);
      }
    }

    window.dispatchEvent(new Event('pilotdeck:auth-logout'));
    clearSessionStorageForUser(wipeId);
    clearSession();
  }, [clearSession, expectRevoke]);

  const refreshOnboardingStatus = useCallback(async () => {
    // Onboarding LLM setup has been removed; kept as a no-op for API compatibility.
  }, []);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup: false,
      registrationOpen,
      authDisabled,
      isAdmin: user?.role === 'admin',
      sessionEndedCode,
      hasCompletedOnboarding: true,
      error,
      login,
      register,
      changePassword,
      logout,
      refreshOnboardingStatus,
    }),
    [
      authDisabled,
      changePassword,
      error,
      isLoading,
      login,
      logout,
      refreshOnboardingStatus,
      register,
      registrationOpen,
      sessionEndedCode,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
