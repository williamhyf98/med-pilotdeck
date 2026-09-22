/**
 * Establishes the per-request data scope.
 *
 * Runs immediately after `authenticateToken`, so `req.user` is the live
 * DB row. Everything downstream that resolves a path — projects,
 * sessions, memory, skills, uploads — lands inside that user's private
 * home without knowing users exist.
 *
 * Two deliberate exemptions:
 *
 *   - Bypass / platform mode keeps the global home. With login disabled
 *     there is exactly one operator and no data to separate, so the
 *     single-user install behaves byte-for-byte as it did before.
 *   - An admin may inspect another user's data by sending
 *     `X-PilotDeck-User-Scope: <id>`. The header is ignored for
 *     non-admins, which is what keeps it from being a privilege
 *     escalation rather than a convenience.
 */
import { IS_PLATFORM, DISABLE_LOCAL_AUTH } from '../constants/config.js';
import { userDb } from '../database/db.js';
import { runWithUserScope } from '../utils/userScope.js';
import { ensureUserHome } from '../services/userHomes.js';

export const USER_SCOPE_HEADER = 'x-pilotdeck-user-scope';

/** True when per-user isolation is active at all. */
export function isolationEnabled() {
  return !IS_PLATFORM && !DISABLE_LOCAL_AUTH;
}

/**
 * Resolve which user's data a caller is allowed to touch.
 *
 * @param {{ id: number, username: string, role?: string }} actor
 * @param {string|undefined} requestedScopeId Raw header value.
 * @returns {{ userId: number, username: string, role: 'admin'|'user', impersonated: boolean } | null}
 */
export function resolveScopeTarget(actor, requestedScopeId) {
  if (!actor?.id) return null;
  const role = actor.role === 'user' ? 'user' : 'admin';
  const requested = Number(requestedScopeId);

  if (
    role === 'admin'
    && Number.isInteger(requested)
    && requested > 0
    && requested !== actor.id
  ) {
    const target = userDb.getManagedUser(requested);
    if (target) {
      return {
        userId: target.id,
        username: target.username,
        role,
        impersonated: true,
      };
    }
  }

  return {
    userId: actor.id,
    username: actor.username,
    role,
    impersonated: false,
  };
}

/** Express middleware. Mount after `authenticateToken`. */
export async function withUserScope(req, res, next) {
  if (!isolationEnabled()) {
    next();
    return;
  }
  const target = resolveScopeTarget(req.user, req.get?.(USER_SCOPE_HEADER));
  if (!target) {
    next();
    return;
  }

  let pilotHome;
  try {
    pilotHome = await ensureUserHome(target.userId);
  } catch (error) {
    console.error(`[user-scope] could not prepare home for user ${target.userId}:`, error);
    res.status(500).json({ error: 'Failed to prepare user workspace' });
    return;
  }

  req.userScope = { ...target, pilotHome };
  runWithUserScope({ ...target, pilotHome }, () => next());
}

/**
 * Same resolution for the WebSocket upgrade path, which has a
 * `req.user` but no Express middleware chain. The scope travels as a
 * query parameter there because browsers cannot set headers on a
 * WebSocket handshake.
 *
 * @param {{ id: number, userId?: number, username: string, role?: string }} user
 * @param {string|undefined} requestedScopeId
 * @returns {Promise<import('../utils/userScope.js').UserScope | null>}
 */
export async function buildUserScopeFor(user, requestedScopeId) {
  if (!isolationEnabled()) return null;
  // The WS handshake path stores the id under `userId`; REST uses `id`.
  const actor = user && !user.id && user.userId ? { ...user, id: user.userId } : user;
  const target = resolveScopeTarget(actor, requestedScopeId);
  if (!target) return null;
  const pilotHome = await ensureUserHome(target.userId);
  return { ...target, pilotHome };
}
