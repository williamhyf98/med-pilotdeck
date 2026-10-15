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

// Unscoped marker of the last signed-in user. It lets the pre-React theme
// script in index.html and the very first render read the right namespace
// after a page reload, before /api/auth/user has answered.
const LAST_USER_KEY = 'pilotdeck-storage-user';
const UNSCOPED_KEYS = new Set(['auth-token', LAST_USER_KEY]);

// Per-browser preferences chosen before login that a user keeps on first login.
const MIGRATED_KEYS = new Set([
  'themeMode',
  'userLanguage',
  'userLanguageDefaultMigratedTo',
  'pilotdeck-settings',
]);
const MIGRATED_PREFIXES = ['codeEditor'];

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

const shouldMigrate = (key: string) =>
  MIGRATED_KEYS.has(key) || MIGRATED_PREFIXES.some((prefix) => key.startsWith(prefix));

const migrateAnonPreferences = (id: string | number) => {
  const userPrefix = prefixFor(id);
  const keys = Object.keys(localStorage);
  if (keys.some((k) => k.startsWith(userPrefix))) return;
  const anonPrefix = prefixFor(null);
  for (const k of keys) {
    if (!k.startsWith(anonPrefix)) continue;
    const bare = k.slice(anonPrefix.length);
    if (!shouldMigrate(bare)) continue;
    const value = localStorage.getItem(k);
    if (value !== null) localStorage.setItem(`${userPrefix}${bare}`, value);
  }
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
      migrateAnonPreferences(normalized);
    }
  } catch (error) {
    console.error('localStorage user namespace error:', error);
  }
  window.dispatchEvent(new CustomEvent(STORAGE_USER_CHANGED_EVENT, { detail: { userId: normalized } }));
};

export const clearStorageForUser = (id: StorageUserId | undefined): void => {
  const prefix = prefixFor(id);
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(prefix)) localStorage.removeItem(k);
    }
  } catch (error) {
    console.error('localStorage clear error:', error);
  }
};

/** True when a `storage` event key refers to `key` in the current user namespace. */
export const isScopedStorageKey = (eventKey: string | null, key: string): boolean =>
  eventKey === scopedStorageKey(key);

export const safeLocalStorage = {
  setItem: (key: string, value: string) => {
    const scopedKey = scopedStorageKey(key);
    try {
      localStorage.setItem(scopedKey, value);
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
