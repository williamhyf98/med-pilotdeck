/**
 * Quota-aware localStorage wrapper that namespaces every key by the signed-in
 * user (`u<id>:key`, or `anon:key` before login) so several accounts sharing a
 * browser never see each other's preferences, drafts or model choices.
 *
 * `auth-token` is intentionally unscoped: it is read before the user is known
 * and by plain fetch helpers outside React.
 */

type StorageUserId = string | number | null;

export const STORAGE_USER_CHANGED_EVENT = 'pilotdeck:storage-user-changed';
export const UI_PREFERENCE_CHANGED_EVENT = 'pilotdeck:ui-preference-changed';
export const PERSISTED_UI_KEYS = new Set([
  'themeMode', 'userLanguage', 'uiPreferences', 'pilotdeck-settings',
  'codeEditorWordWrap', 'codeEditorShowMinimap', 'codeEditorLineNumbers', 'codeEditorFontSize',
]);

// Unscoped marker of the last signed-in user. It lets the pre-React theme
// script in index.html and the very first render read the right namespace
// after a page reload, before /api/auth/user has answered.
const LAST_USER_KEY = 'pilotdeck-storage-user';
// Set once pre-upgrade (unprefixed) keys have been moved into a user namespace.
const LEGACY_MIGRATED_KEY = 'pilotdeck-storage-migrated-v1';
const UNSCOPED_KEYS = new Set(['auth-token', LAST_USER_KEY, LEGACY_MIGRATED_KEY]);
const SCOPED_KEY_PATTERN = /^(anon:|u(\d+|local|platform):)/;


const readLastUserId = (): StorageUserId => {
  try {
    return localStorage.getItem(LAST_USER_KEY) || null;
  } catch {
    return null;
  }
};

let storageUserId: StorageUserId = readLastUserId();

const prefixFor = (id: StorageUserId | undefined): string => (id == null ? 'anon:' : `u${id}:`);

export const scopedStorageKey = (key: string): string =>
  UNSCOPED_KEYS.has(key) ? key : `${prefixFor(storageUserId)}${key}`;

export const getStorageUserId = (): StorageUserId => storageUserId;

// Role of the signed-in user, kept in memory only (never persisted) so callers
// outside React can skip admin-only requests that a normal user would get a
// 403 for. It is unknown (`null`) until the auth context has resolved the user.
let storageUserRole: string | null = null;

export const setStorageUserRole = (role: string | null | undefined): void => {
  storageUserRole = role ?? null;
};

export const getStorageUserRole = (): string | null => storageUserRole;

// Keys written before namespacing existed belong to the single pre-upgrade
// user; the first account to sign in afterwards takes them over, once.
const migrateLegacyKeys = (id: string | number) => {
  if (localStorage.getItem(LEGACY_MIGRATED_KEY)) return;
  const userPrefix = prefixFor(id);
  for (const k of Object.keys(localStorage)) {
    if (UNSCOPED_KEYS.has(k) || SCOPED_KEY_PATTERN.test(k)) continue;
    const value = localStorage.getItem(k);
    if (value !== null) localStorage.setItem(`${userPrefix}${k}`, value);
    localStorage.removeItem(k);
  }
  localStorage.setItem(LEGACY_MIGRATED_KEY, '1');
};

export const setStorageUserId = (id: StorageUserId): void => {
  const normalized = id ?? null;
  const unchanged =
    normalized === storageUserId ||
    (normalized !== null && storageUserId !== null && String(normalized) === String(storageUserId));
  if (unchanged) return;
  storageUserId = normalized;
  try {
    if (normalized === null) {
      localStorage.removeItem(LAST_USER_KEY);
    } else {
      localStorage.setItem(LAST_USER_KEY, String(normalized));
      migrateLegacyKeys(normalized);
    }
  } catch (error) {
    console.error('localStorage user namespace error:', error);
  }
  window.dispatchEvent(new CustomEvent(STORAGE_USER_CHANGED_EVENT, { detail: { userId: normalized } }));
};

/**
 * Removes every key in a user's namespace. A missing id is a no-op (it must
 * never fall through to the anon namespace); wiping anon needs the explicit
 * `'anon'` sentinel.
 */
export const clearStorageForUser = (id: StorageUserId | 'anon' | undefined): void => {
  if (id == null) return;
  const prefix = id === 'anon' ? 'anon:' : prefixFor(id);
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(prefix)) localStorage.removeItem(k);
    }
  } catch (error) {
    console.error('localStorage clear error:', error);
  }
};

/** Remove session drafts and model choices while keeping long-lived UI choices. */
export const clearSessionStorageForUser = (id: StorageUserId | undefined): void => {
  if (id == null) return;
  const prefix = prefixFor(id);
  try {
    for (const key of Object.keys(localStorage)) {
      if (!key.startsWith(prefix)) continue;
      if (!PERSISTED_UI_KEYS.has(key.slice(prefix.length))) localStorage.removeItem(key);
    }
  } catch (error) {
    console.error('localStorage session clear error:', error);
  }
};

/** True when a `storage` event key refers to `key` in the current user namespace. */
export const isScopedStorageKey = (eventKey: string | null, key: string): boolean =>
  eventKey === scopedStorageKey(key);

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    const scopedKey = scopedStorageKey(key);
    const ownerId = storageUserId;
    try {
      if (localStorage.getItem(scopedKey) === value) return;
      localStorage.setItem(scopedKey, value);
      if (PERSISTED_UI_KEYS.has(key)) {
        queueMicrotask(() => {
          window.dispatchEvent(new CustomEvent(UI_PREFERENCE_CHANGED_EVENT, {
            detail: { userId: ownerId, key },
          }));
        });
      }
    } catch (error: any) {
      if (error?.name === 'QuotaExceededError') {
        console.warn('localStorage quota exceeded, clearing old data');

        const draftPrefix = scopedStorageKey('draft_input_');
        const draftKeys = Object.keys(localStorage).filter((k) => k.startsWith(draftPrefix));
        draftKeys.forEach((k) => {
          localStorage.removeItem(k);
        });

        try {
          localStorage.setItem(scopedKey, value);
        } catch (retryError) {
          console.error('Failed to save to localStorage even after cleanup:', retryError);
        }
      } else {
        console.error('localStorage error:', error);
      }
    }
  },
  getItem: (key: string): string | null => {
    try {
      return localStorage.getItem(scopedStorageKey(key));
    } catch (error) {
      console.error('localStorage getItem error:', error);
      return null;
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(scopedStorageKey(key));
    } catch (error) {
      console.error('localStorage removeItem error:', error);
    }
  },
};
