import type { ApiErrorPayload } from './types';

export async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  return payload.error ?? payload.message ?? fallback;
}

/** base64url → 字符串（payload 里可能有中文用户名，所以按 UTF-8 解）。 */
function decodeBase64UrlSegment(segment: string): string {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * 读 JWT 的 `exp`（毫秒时间戳）。**只解码不验签** —— 用途只是"别再拿一个
 * 明知过期的 token 去请求"，真正的校验永远在服务端。
 *
 * 解析不了（不是 JWT、没有 exp）返回 null，调用方按"未知"处理、不做任何拦截。
 */
export function readJwtExpiryMs(token: string | null | undefined): number | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const payload = JSON.parse(decodeBase64UrlSegment(parts[1])) as { exp?: unknown };
    const seconds = Number(payload?.exp);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/** token 已过期（或无法解析出 exp 时保守返回 false，交给服务端判定）。 */
export function isJwtExpired(token: string | null | undefined, now = Date.now()): boolean {
  const expiry = readJwtExpiryMs(token);
  return expiry !== null && expiry <= now;
}
