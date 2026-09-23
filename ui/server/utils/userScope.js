/**
 * Request-scoped "which user am I acting for" context.
 *
 * Every durable path in PilotDeck is a pure function of `pilotHome`
 * (see `utils/pilotPaths.js`), so isolating users is a matter of making
 * `resolvePilotHome()` answer differently per request instead of
 * threading a `pilotHome` argument through ~30 modules. An
 * `AsyncLocalStorage` carries that answer across awaits for the whole
 * lifetime of a request / WebSocket message.
 *
 * Outside any scope (background daemons, startup, bypass mode) the
 * store is empty and callers fall back to the global `PILOT_HOME` —
 * i.e. single-user behaviour is byte-for-byte what it was before.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * @typedef {object} UserScope
 * @property {number} userId        Owner of the data being touched.
 * @property {string} username
 * @property {'admin'|'user'} role  Role of the authenticated owner.
 * @property {string} pilotHome     Absolute per-user PILOT_HOME.
 * @property {boolean} impersonated Compatibility field; overrides are disabled.
 */

/** @type {AsyncLocalStorage<UserScope>} */
const storage = new AsyncLocalStorage();

/** @returns {UserScope | undefined} */
export function getUserScope() {
  return storage.getStore();
}

/**
 * Run `fn` with `scope` visible to every `resolvePilotHome()` call it
 * makes, transitively, including across awaits.
 *
 * @template T
 * @param {UserScope | null | undefined} scope
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithUserScope(scope, fn) {
  if (!scope) return fn();
  return storage.run(scope, fn);
}

/**
 * Bind `fn` to the scope active *right now*, so a callback invoked
 * later (event handler, timer, stream listener) still resolves paths
 * for the right user. Returns `fn` unchanged when no scope is active.
 *
 * @template {(...args: any[]) => any} F
 * @param {F} fn
 * @returns {F}
 */
export function bindUserScope(fn) {
  const scope = storage.getStore();
  if (!scope) return fn;
  // @ts-expect-error -- preserving the original signature is the point.
  return (...args) => storage.run(scope, () => fn(...args));
}
