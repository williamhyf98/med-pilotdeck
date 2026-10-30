import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { IS_PLATFORM } from '../../../constants/config';
import { api } from '../../../utils/api';
import { flushUserPreferenceSaves, USER_PREFERENCES_FLUSH_EVENT } from '../userPreferenceSaveQueue';
import { clearSessionStorageForUser, getStorageUserId, setStorageUserId, setStorageUserRole } from '../../../utils/safeStorage';
import { AUTH_ERROR_MESSAGES, AUTH_TOKEN_STORAGE_KEY } from '../constants';
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
} from '../types';
import { parseJsonSafely, resolveApiErrorMessage } from '../utils';

const AuthContext = createContext<AuthContextValue | null>(null);

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

const EXPECTED_REVOKE_WINDOW_MS = 5000;
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

      if (!readStoredToken()) {
        applyUser(null);
        return;
      }

      const userResponse = await api.auth.user();
      if (!userResponse.ok) {
        clearSession();
        return;
      }

      const userPayload = await parseJsonSafely<AuthUserPayload>(userResponse);
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

  // Server-side session end (401 with a revoked code, WebSocket 4401) and
  // silently refreshed tokens arrive as window events from non-React code.
  useEffect(() => {
    const onRevoked = (event: Event) => {
      if (Date.now() < expectedRevokeUntilRef.current) return;
      const code = (event as CustomEvent<{ code?: string }>).detail?.code ?? 'TOKEN_REVOKED';
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
