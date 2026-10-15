import type { ReactNode } from 'react';

export type AuthRole = 'admin' | 'user';

export type AuthUser = {
  id: number | string;
  username: string;
  role: AuthRole;
};

export type AuthActionResult = { success: true } | { success: false; error: string };

export type AuthSessionPayload = {
  token?: string;
  user?: AuthUser;
  error?: string;
  message?: string;
};

export type AuthStatusPayload = {
  needsSetup?: boolean;
  authDisabled?: boolean;
  registrationOpen?: boolean;
};

export type AuthUserPayload = {
  user?: AuthUser;
};

export type OnboardingStatusPayload = {
  hasCompletedOnboarding?: boolean;
};

export type ApiErrorPayload = {
  error?: string;
  message?: string;
};

export type AuthContextValue = {
  user: AuthUser | null;
  token: string | null;
  isLoading: boolean;
  /** Always false: kept for compatibility, first-run setup no longer exists. */
  needsSetup: boolean;
  registrationOpen: boolean;
  /** True when the server runs without login (no-login mode / platform). */
  authDisabled: boolean;
  isAdmin: boolean;
  /** Code of the last server-side session end (TOKEN_REVOKED, USER_DISABLED, ...). */
  sessionEndedCode: string | null;
  hasCompletedOnboarding: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<AuthActionResult>;
  logout: () => Promise<void>;
  refreshOnboardingStatus: () => Promise<void>;
};

export type AuthProviderProps = {
  children: ReactNode;
};
