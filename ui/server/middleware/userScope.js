import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

export class UserScopeMissingError extends Error {
  constructor() {
    super('No user scope is active for this request. Refusing to fall back to a shared directory.');
    this.code = 'USER_SCOPE_MISSING';
  }
}

export function runWithUserScope({ userId, role }, fn) {
  if (userId === null || userId === undefined || String(userId).trim() === '') {
    throw new UserScopeMissingError();
  }
  return storage.run({ userId: String(userId), role: role ?? 'user' }, fn);
}

export function getUserScope() {
  return storage.getStore();
}

export function requireUserScope() {
  const scope = storage.getStore();
  if (!scope) throw new UserScopeMissingError();
  return scope;
}

// Multipart parsers invoke their completion callbacks from request stream
// resources created before the scope middleware runs. Re-enter the scope using
// only the identity already established by authentication.
export function runWithRequestUserScope(req, fn) {
  const userId = req.user?.id ?? req.user?.userId;
  return runWithUserScope({ userId, role: req.user?.role }, fn);
}

export function userScopeMiddleware(req, res, next) {
  const id = req.user?.id ?? req.user?.userId;
  if (id === null || id === undefined) {
    return res.status(500).json({ error: 'User scope missing', code: 'USER_SCOPE_MISSING' });
  }
  return runWithUserScope({ userId: id, role: req.user.role }, () => next());
}
