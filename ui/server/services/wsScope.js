// ui/server/services/wsScope.js
//
// WebSocket connections are long-lived and shared by every user of the server,
// so the two rules that keep them apart (Review Focus 1 and 2 of the
// multi-user design) are extracted here to be testable on their own:
//
//   1. Every inbound frame runs inside the scope of the user who opened THAT
//      connection — the scope is bound once, per connection, from the
//      authenticated `request.user`, never read from a shared variable that a
//      later connection could overwrite. `runWithUserScope` uses
//      AsyncLocalStorage, so two listeners running concurrently each see their
//      own scope.
//   2. When a user's tokens are revoked, exactly that user's sockets are closed
//      with 4401 TOKEN_REVOKED, and nobody else's.
import { runWithUserScope } from '../middleware/userScope.js';

/** The user id a socket was opened for; also what `closeUserSockets` matches on. */
export const SOCKET_USER_ID = '__pilotdeckUserId';

/**
 * Freeze the scope of an authenticated upgrade request. Returns null when the
 * request carries no user — the caller must then reject the connection
 * (`verifyClient` is the actual gate; this is the belt-and-braces check).
 */
export function bindConnectionScope(request) {
  const userId = request?.user?.id ?? request?.user?.userId ?? null;
  if (userId === null || userId === undefined || String(userId).trim() === '') return null;
  return { userId: String(userId), role: request?.user?.role ?? 'user' };
}

/**
 * Build the `ws.on('message')` listener: every frame is handled inside `scope`.
 * `handler` may be async; its rejection is handed to `onError` (default: log)
 * rather than becoming an unhandled rejection.
 */
export function runMessageInScope(scope, handler, { onError } = {}) {
  return (message, ...rest) => {
    let result;
    try {
      result = runWithUserScope(scope, () => handler(message, ...rest));
    } catch (error) {
      report(error, onError);
      return undefined;
    }
    if (result && typeof result.then === 'function') {
      // `ws` ignores the listener's return value, so a rejection here would
      // become an unhandled rejection and take the server down.
      return result.then(() => undefined, (error) => report(error, onError));
    }
    return undefined;
  };
}

function report(error, onError) {
  if (onError) onError(error);
  else console.error('[ws] message handler failed:', error instanceof Error ? error.message : error);
}

/**
 * Close every open socket belonging to `userId`, and only those. Sockets that
 * are already closing/closed, and sockets of other users, are left alone.
 */
export function closeUserSockets(clients, userId, { code = 4401, reason = 'TOKEN_REVOKED' } = {}) {
  const id = String(userId);
  let closed = 0;
  for (const client of clients ?? []) {
    if (String(client?.[SOCKET_USER_ID]) !== id) continue;
    // 0 = CONNECTING, 1 = OPEN; 2/3 are CLOSING/CLOSED and need no close frame.
    if (client.readyState !== undefined && client.readyState !== 0 && client.readyState !== 1) continue;
    try { client.close(code, reason); closed += 1; } catch { /* already gone */ }
  }
  return closed;
}
