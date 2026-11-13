export const AUTH_TOKEN_STORAGE_KEY = 'auth-token';

export const readAuthToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

/** Ignore a delayed token from the same account when a newer login is already active. */
export const isOlderTokenForSameUser = (candidate: string, current: string): boolean => {
  try {
    const decode = (value: string) =>
      JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const incoming = decode(candidate);
    const active = decode(current);
    if (incoming.userId == null || String(incoming.userId) !== String(active.userId)) return false;
    const incomingVersion = Number(incoming.tokenVersion);
    const activeVersion = Number(active.tokenVersion);
    const incomingIssued = Number(incoming.iat);
    const activeIssued = Number(active.iat);
    if (![incomingVersion, activeVersion, incomingIssued, activeIssued].every(Number.isFinite)) return false;
    return incomingVersion < activeVersion
      || (incomingVersion === activeVersion && incomingIssued < activeIssued);
  } catch {
    return false;
  }
};

/**
 * 一枚已经作废的 token，不该有权限结束"更新的那次登录"。
 *
 * 典型场景：A 标签页还停在 11-04 的旧 token 上（页面里存的是内存态，不会自己变），
 * B 标签页刚登录拿到新 token 写进了 localStorage。这时 A 的 WebSocket 被服务端
 * 以 4401 关掉，如果照旧"清 token + 跳登录页"，就会把 B 的**有效**会话一起干掉。
 */
export const isSupersededToken = (tokenUsed?: string | null): boolean => {
  const current = readAuthToken();
  return Boolean(current && tokenUsed && current !== tokenUsed);
};

/** 让 React 层跟上 localStorage 里更新的 token（会触发 WebSocket 用新 token 重连）。 */
export const adoptStoredToken = (token: string) => {
  window.dispatchEvent(new CustomEvent('pilotdeck:token-refreshed', { detail: { token } }));
};

