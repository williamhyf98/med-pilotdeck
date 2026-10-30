import { useLayoutEffect, useState, type ReactNode } from 'react';
import i18n from '../../i18n/config.js';
import { IS_PLATFORM } from '../../constants/config';
import { useTheme } from '../../contexts/ThemeContext';
import { authenticatedFetch } from '../../utils/api';
import {
  PERSISTED_UI_KEYS,
  UI_PREFERENCE_CHANGED_EVENT,
  getStorageUserId,
  safeLocalStorage,
} from '../../utils/safeStorage';
import { useAuth } from './context/AuthContext';
import { enqueueUserPreferenceSave, USER_PREFERENCES_FLUSH_EVENT } from './userPreferenceSaveQueue';

export const UI_PREFERENCES_HYDRATED_EVENT = 'pilotdeck:ui-preferences-hydrated';
type Preferences = Record<string, boolean | string>;
const UI_KEYS = [
  'showProcessTrace', 'autoExpandTools', 'showRawParameters', 'showThinking',
  'inlineThinking', 'autoScrollToBottom', 'sendByCtrlEnter', 'sidebarVisible',
] as const;
const EDITOR_KEYS = ['codeEditorWordWrap', 'codeEditorShowMinimap', 'codeEditorLineNumbers'] as const;
const FONT_SIZES = new Set(['10', '11', '12', '13', '14', '15', '16', '18', '20']);

function readLocal(): Preferences {
  const result: Preferences = {};
  const theme = safeLocalStorage.getItem('themeMode');
  if (['light', 'dark', 'warm', 'command'].includes(theme || '')) result.themeMode = theme!;
  const language = safeLocalStorage.getItem('userLanguage');
  if (['zh-CN', 'en'].includes(language || '')) result.userLanguage = language!;
  try {
    const settings = JSON.parse(safeLocalStorage.getItem('pilotdeck-settings') || '{}');
    if (settings.projectSortOrder === 'name' || settings.projectSortOrder === 'date') {
      result.projectSortOrder = settings.projectSortOrder;
    }
  } catch { /* ignore invalid local cache */ }
  try {
    const ui = JSON.parse(safeLocalStorage.getItem('uiPreferences') || '{}');
    for (const key of UI_KEYS) if (typeof ui[key] === 'boolean') result[key] = ui[key];
  } catch { /* ignore invalid local cache */ }
  for (const key of EDITOR_KEYS) {
    const value = safeLocalStorage.getItem(key);
    if (value === 'true' || value === 'false') result[key] = value === 'true';
  }
  const fontSize = safeLocalStorage.getItem('codeEditorFontSize');
  if (FONT_SIZES.has(fontSize || '')) result.codeEditorFontSize = fontSize!;
  return result;
}

function applyRemote(preferences: Preferences, setThemeMode: (mode: string) => void) {
  safeLocalStorage.setItem('uiPreferencesInitialized', 'true');
  const theme = typeof preferences.themeMode === 'string' ? preferences.themeMode : 'warm';
  safeLocalStorage.setItem('themeMode', theme);
  setThemeMode(theme);
  const language = typeof preferences.userLanguage === 'string' ? preferences.userLanguage : 'zh-CN';
  safeLocalStorage.setItem('userLanguage', language);
  void i18n.changeLanguage(language);
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(safeLocalStorage.getItem('pilotdeck-settings') || '{}'); } catch { /* reset */ }
  safeLocalStorage.setItem('pilotdeck-settings', JSON.stringify({
    ...settings, projectSortOrder: preferences.projectSortOrder || 'date',
    projectSortDefaultVersion: 1,
  }));
  window.dispatchEvent(new Event('pilotdeck-settings-changed'));
  const ui = Object.fromEntries(UI_KEYS
    .filter((key) => typeof preferences[key] === 'boolean')
    .map((key) => [key, preferences[key]]));
  safeLocalStorage.setItem('uiPreferences', JSON.stringify(ui));
  for (const key of EDITOR_KEYS) {
    const defaultValue = key === 'codeEditorWordWrap' ? false : true;
    safeLocalStorage.setItem(key, String(preferences[key] ?? defaultValue));
  }
  safeLocalStorage.setItem('codeEditorFontSize', String(preferences.codeEditorFontSize || '14'));
  window.dispatchEvent(new Event('codeEditorSettingsChanged'));
  window.dispatchEvent(new CustomEvent(UI_PREFERENCES_HYDRATED_EVENT, { detail: ui }));
}

/** One synchronizer per signed-in account; backend is authoritative after loading. */
export default function UserPreferenceSync({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const { setThemeMode } = useTheme() as { setThemeMode: (value: string) => void };
  const [readyUser, setReadyUser] = useState<string | null>(null);
  const accountId = user?.id;
  useLayoutEffect(() => {
    if (accountId == null || getStorageUserId() === null || IS_PLATFORM) return;
    const userId = String(accountId);
    const beforeLoad = readLocal();
    let active = true;
    let hydrated = false;
    let applying = false;
    let lastPersisted = '';
    let timer: ReturnType<typeof setTimeout> | undefined;

    const persist = () => {
      if (!active || String(getStorageUserId()) !== userId) return;
      const snapshot = readLocal();
      if (!Object.keys(snapshot).length) return;
      const serialized = JSON.stringify(snapshot);
      if (serialized === lastPersisted) return;
      lastPersisted = serialized;
      // A queued save must never pick up the next account's token.
      const token = localStorage.getItem('auth-token');
      void enqueueUserPreferenceSave(async () => {
        if (!active || String(getStorageUserId()) !== userId) return;
        const response = await authenticatedFetch('/api/user/preferences', {
          method: 'PATCH',
          body: JSON.stringify(snapshot),
          ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        });
        if (!response.ok) throw new Error('Unable to save UI preferences');
      }).catch((error) => {
        if (active && lastPersisted === serialized) lastPersisted = '';
        console.error('UI preferences sync failed:', error);
      });
    };
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<{ userId: string | number | null; key: string }>).detail;
      if (String(detail?.userId) !== userId || !PERSISTED_UI_KEYS.has(detail.key) || applying) return;
      if (!hydrated) return;
      clearTimeout(timer);
      timer = setTimeout(persist, 120);
    };
    window.addEventListener(UI_PREFERENCE_CHANGED_EVENT, onChange);
    const flush = () => {
      clearTimeout(timer);
      if (hydrated) persist();
    };
    window.addEventListener(USER_PREFERENCES_FLUSH_EVENT, flush);

    void (async () => {
      try {
        const response = await authenticatedFetch('/api/user/preferences');
        if (!response.ok) throw new Error('Unable to load UI preferences');
        const payload = await response.json();
        if (!active || String(getStorageUserId()) !== userId) return;
        applying = true;
        if (payload.preferences) applyRemote(payload.preferences, setThemeMode);
        else applyRemote(beforeLoad, setThemeMode);
        applying = false;
        hydrated = true;
        if (payload.preferences) lastPersisted = JSON.stringify(readLocal());
        else persist();
      } catch (error) {
        applying = false;
        hydrated = true;
        lastPersisted = '';
        console.error('UI preferences load failed:', error);
      } finally {
        if (active) setReadyUser(userId);
      }
    })();
    return () => {
      active = false;
      clearTimeout(timer);
      window.removeEventListener(UI_PREFERENCE_CHANGED_EVENT, onChange);
      window.removeEventListener(USER_PREFERENCES_FLUSH_EVENT, flush);
    };
  }, [accountId, setThemeMode]);
  if (isLoading || !user || IS_PLATFORM) return <>{children}</>;
  return readyUser === String(user.id) ? <>{children}</> : null;
}
