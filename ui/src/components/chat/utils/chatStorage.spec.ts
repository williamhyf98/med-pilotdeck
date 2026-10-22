// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearStorageForUser,
  getDraftInputStorageKey,
  safeLocalStorage,
  setStorageUserId,
} from './chatStorage';

describe('getDraftInputStorageKey', () => {
  it('scopes drafts to a project and conversation', () => {
    expect(getDraftInputStorageKey('general', 'session-a'))
      .toBe('draft_input_general:session-a');
    expect(getDraftInputStorageKey('general', 'session-b'))
      .toBe('draft_input_general:session-b');
  });

  it('uses a separate key for a new conversation', () => {
    expect(getDraftInputStorageKey('general', null))
      .toBe('draft_input_general:new');
  });
});

describe('safeLocalStorage user namespacing', () => {
  beforeEach(() => {
    localStorage.clear();
    setStorageUserId(null);
  });
  afterEach(() => {
    setStorageUserId(null);
    localStorage.clear();
  });

  it('writes under the u<id>: prefix and isolates users', () => {
    setStorageUserId(7);
    safeLocalStorage.setItem('themeMode', 'dark');
    expect(localStorage.getItem('u7:themeMode')).toBe('dark');
    expect(localStorage.getItem('themeMode')).toBeNull();
    expect(safeLocalStorage.getItem('themeMode')).toBe('dark');

    setStorageUserId(8);
    expect(safeLocalStorage.getItem('themeMode')).toBeNull();
  });

  it('uses the anon: prefix without a user', () => {
    safeLocalStorage.setItem('themeMode', 'warm');
    expect(localStorage.getItem('anon:themeMode')).toBe('warm');
  });

  it('never prefixes auth-token', () => {
    setStorageUserId(7);
    safeLocalStorage.setItem('auth-token', 'tok');
    expect(localStorage.getItem('auth-token')).toBe('tok');
    expect(safeLocalStorage.getItem('auth-token')).toBe('tok');
  });

  it('clearStorageForUser removes only that user prefix', () => {
    localStorage.setItem('u7:a', '1');
    localStorage.setItem('u7:b', '2');
    localStorage.setItem('u70:c', '3');
    localStorage.setItem('u8:a', '4');
    localStorage.setItem('anon:a', '5');
    localStorage.setItem('auth-token', 'tok');
    clearStorageForUser(7);
    expect(localStorage.getItem('u7:a')).toBeNull();
    expect(localStorage.getItem('u7:b')).toBeNull();
    expect(localStorage.getItem('u70:c')).toBe('3');
    expect(localStorage.getItem('u8:a')).toBe('4');
    expect(localStorage.getItem('anon:a')).toBe('5');
    expect(localStorage.getItem('auth-token')).toBe('tok');
  });

  it('does not give a new user the anonymous browser preferences', () => {
    localStorage.setItem('anon:themeMode', 'dark');
    localStorage.setItem('anon:userLanguage', 'en');
    localStorage.setItem('anon:userLanguageDefaultMigratedTo', 'zh-CN');
    localStorage.setItem('anon:pilotdeck-settings', '{"a":1}');
    localStorage.setItem('anon:codeEditorWordWrap', 'true');
    localStorage.setItem('anon:draft_input_x:new', 'secret');
    setStorageUserId(3);
    expect(localStorage.getItem('u3:themeMode')).toBeNull();
    expect(localStorage.getItem('u3:userLanguage')).toBeNull();
    expect(localStorage.getItem('u3:userLanguageDefaultMigratedTo')).toBeNull();
    expect(localStorage.getItem('u3:pilotdeck-settings')).toBeNull();
    expect(localStorage.getItem('u3:codeEditorWordWrap')).toBeNull();
    expect(localStorage.getItem('u3:draft_input_x:new')).toBeNull();
  });

  it('does not overwrite an existing user namespace with anon preferences', () => {
    localStorage.setItem('anon:themeMode', 'dark');
    localStorage.setItem('u3:themeMode', 'warm');
    setStorageUserId(3);
    expect(localStorage.getItem('u3:themeMode')).toBe('warm');
  });

  it('announces user changes', () => {
    const seen: unknown[] = [];
    const h = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('pilotdeck:storage-user-changed', h);
    setStorageUserId(5);
    setStorageUserId(5);
    setStorageUserId(null);
    window.removeEventListener('pilotdeck:storage-user-changed', h);
    expect(seen).toEqual([{ userId: 5 }, { userId: null }]);
  });

  it('clearStorageForUser(null) is a no-op; anon needs the explicit sentinel', () => {
    localStorage.setItem('anon:themeMode', 'dark');
    localStorage.setItem('u1:themeMode', 'warm');
    clearStorageForUser(null);
    clearStorageForUser(undefined);
    expect(localStorage.getItem('anon:themeMode')).toBe('dark');
    expect(localStorage.getItem('u1:themeMode')).toBe('warm');
    clearStorageForUser('anon');
    expect(localStorage.getItem('anon:themeMode')).toBeNull();
    expect(localStorage.getItem('u1:themeMode')).toBe('warm');
  });

  describe('pre-upgrade unprefixed keys', () => {
    it('moves them to the first user once, then never again', () => {
      localStorage.setItem('draft_input_x:new', 'hello');
      localStorage.setItem('themeMode', 'dark');
      localStorage.setItem('pilotdeck:customSessionTitles', '{"s":"t"}');
      localStorage.setItem('auth-token', 'tok');
      localStorage.setItem('u9:keep', '1');
      setStorageUserId(1);
      expect(localStorage.getItem('u1:draft_input_x:new')).toBe('hello');
      expect(localStorage.getItem('u1:themeMode')).toBe('dark');
      expect(localStorage.getItem('u1:pilotdeck:customSessionTitles')).toBe('{"s":"t"}');
      expect(localStorage.getItem('draft_input_x:new')).toBeNull();
      expect(localStorage.getItem('themeMode')).toBeNull();
      expect(localStorage.getItem('pilotdeck:customSessionTitles')).toBeNull();
      expect(localStorage.getItem('auth-token')).toBe('tok');
      expect(localStorage.getItem('u9:keep')).toBe('1');
      expect(localStorage.getItem('pilotdeck-storage-migrated-v1')).toBe('1');

      setStorageUserId(2);
      expect(localStorage.getItem('u2:draft_input_x:new')).toBeNull();
      expect(localStorage.getItem('u2:themeMode')).toBeNull();
    });

    it('is a no-op once the marker is present', () => {
      localStorage.setItem('pilotdeck-storage-migrated-v1', '1');
      localStorage.setItem('themeMode', 'dark');
      setStorageUserId(1);
      expect(localStorage.getItem('u1:themeMode')).toBeNull();
      expect(localStorage.getItem('themeMode')).toBe('dark');
    });

    it('does not run for the anonymous namespace', () => {
      localStorage.setItem('themeMode', 'dark');
      setStorageUserId(null);
      expect(localStorage.getItem('themeMode')).toBe('dark');
      expect(localStorage.getItem('pilotdeck-storage-migrated-v1')).toBeNull();
    });
  });
});
