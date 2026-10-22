// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({
  user: { id: 1, username: 'alice', role: 'user' } as
    | { id: number; username: string; role: string }
    | null,
}));
const setThemeMode = vi.hoisted(() => vi.fn());
vi.mock('./context/AuthContext', () => ({ useAuth: () => ({ user: auth.user, isLoading: false }) }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ setThemeMode }) }));
vi.mock('../../i18n/config.js', () => ({ default: { changeLanguage: vi.fn(async () => {}) } }));
vi.mock('../../constants/config', () => ({ IS_PLATFORM: false }));

import { setStorageUserId, safeLocalStorage } from '../../utils/safeStorage';
import UserPreferenceSync from './UserPreferenceSync';
import { flushUserPreferenceSaves, USER_PREFERENCES_FLUSH_EVENT } from './userPreferenceSaveQueue';

const fetchMock = vi.fn();
const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
const requests = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');

beforeEach(() => {
  localStorage.clear();
  auth.user = { id: 1, username: 'alice', role: 'user' };
  setStorageUserId(1);
  localStorage.setItem('auth-token', 'alice-token');
  setThemeMode.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
  cleanup();
  await flushUserPreferenceSaves();
  setStorageUserId(null);
  vi.unstubAllGlobals();
});

describe('UI preferences across logins', () => {
  it('creates preferences for a new account, including the first browser default', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(json(init?.method === 'PATCH'
        ? { preferences: JSON.parse(String(init.body)) } : { preferences: null })));

    render(<UserPreferenceSync><div>ready</div></UserPreferenceSync>);
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    await waitFor(() => expect(requests()).toHaveLength(1));
    expect(JSON.parse(requests()[0][1].body)).toMatchObject({
      themeMode: 'warm', projectSortOrder: 'date', codeEditorFontSize: '14',
    });
    expect(requests()[0][1].headers.Authorization).toBe('Bearer alice-token');
  });

  it('restores remote values over a stale browser cache without saving stale values back', async () => {
    safeLocalStorage.setItem('themeMode', 'warm');
    safeLocalStorage.setItem('codeEditorFontSize', '20');
    fetchMock.mockResolvedValue(json({
      preferences: { themeMode: 'dark', projectSortOrder: 'name', codeEditorFontSize: '16', showThinking: false },
    }));

    render(<UserPreferenceSync><div>restored</div></UserPreferenceSync>);
    await waitFor(() => expect(screen.getByText('restored')).toBeTruthy());
    expect(setThemeMode).toHaveBeenCalledWith('dark');
    expect(safeLocalStorage.getItem('themeMode')).toBe('dark');
    expect(safeLocalStorage.getItem('codeEditorFontSize')).toBe('16');
    expect(JSON.parse(safeLocalStorage.getItem('pilotdeck-settings')!)).toMatchObject({ projectSortOrder: 'name' });
    expect(requests()).toHaveLength(0);
  });

  it('ignores an old account response after switching accounts', async () => {
    let resolveOld!: (response: Response) => void;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? Promise.resolve(json({ preferences: {} }))
        : fetchMock.mock.calls.filter(([, options]) => !options?.method).length === 1
          ? new Promise<Response>((resolve) => { resolveOld = resolve; })
          : Promise.resolve(json({ preferences: { themeMode: 'light' } })));
    const renderForAccount = () => (
      <UserPreferenceSync key={auth.user!.id}><div>account {auth.user!.id}</div></UserPreferenceSync>
    );
    const view = render(renderForAccount());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    act(() => {
      setStorageUserId(2);
      localStorage.setItem('auth-token', 'bob-token');
      auth.user = { id: 2, username: 'bob', role: 'user' };
      view.rerender(renderForAccount());
    });
    await waitFor(() => expect(screen.getByText('account 2')).toBeTruthy());
    await act(async () => { resolveOld(json({ preferences: { themeMode: 'dark' } })); });
    expect(safeLocalStorage.getItem('themeMode')).toBe('light');
    expect(localStorage.getItem('u1:themeMode')).toBeNull();
    expect(requests()).toHaveLength(0);
  });

  it('saves a changed theme before logout and restores it in a new browser', async () => {
    let remote: Record<string, unknown> | null = null;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') remote = JSON.parse(String(init.body));
      return Promise.resolve(json({ preferences: remote }));
    });
    const view = render(<UserPreferenceSync><div>ready</div></UserPreferenceSync>);
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    await flushUserPreferenceSaves();
    act(() => {
      safeLocalStorage.setItem('themeMode', 'dark');
    });
    // The logout path fires this event then awaits the queued write.
    await act(async () => {
      await Promise.resolve();
      window.dispatchEvent(new Event(USER_PREFERENCES_FLUSH_EVENT));
      await flushUserPreferenceSaves();
    });
    expect(remote).toMatchObject({ themeMode: 'dark' });
    view.unmount();
    localStorage.clear();
    setStorageUserId(null);
    setStorageUserId(1);
    localStorage.setItem('auth-token', 'alice-token');
    render(<UserPreferenceSync><div>restored</div></UserPreferenceSync>);
    await waitFor(() => expect(screen.getByText('restored')).toBeTruthy());
    expect(safeLocalStorage.getItem('themeMode')).toBe('dark');
  });

  it('does not save a previous account snapshot under the next account after switching', async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH' && !finish) {
        return new Promise<Response>((resolve) => { finish = resolve; });
      }
      return Promise.resolve(json({ preferences: init?.method === 'PATCH' ? {} : { themeMode: 'warm' } }));
    });
    const renderForAccount = () => (
      <UserPreferenceSync key={auth.user!.id}><div>account {auth.user!.id}</div></UserPreferenceSync>
    );
    const view = render(renderForAccount());
    await waitFor(() => expect(screen.getByText('account 1')).toBeTruthy());
    act(() => safeLocalStorage.setItem('themeMode', 'dark'));
    await waitFor(() => expect(requests()).toHaveLength(1));
    act(() => {
      setStorageUserId(2);
      localStorage.setItem('auth-token', 'bob-token');
      auth.user = { id: 2, username: 'bob', role: 'user' };
      view.rerender(renderForAccount());
    });
    await waitFor(() => expect(screen.getByText('account 2')).toBeTruthy());
    await act(async () => { finish(json({ preferences: {} })); });
    expect(requests()).toHaveLength(1);
    expect(requests()[0][1].headers.Authorization).toBe('Bearer alice-token');
    expect(safeLocalStorage.getItem('themeMode')).toBe('warm');
  });

  it('initializes exactly once under React strict effect replay', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      Promise.resolve(json({ preferences: init?.method === 'PATCH' ? {} : null })));
    render(<StrictMode><UserPreferenceSync><div>ready</div></UserPreferenceSync></StrictMode>);
    await waitFor(() => expect(screen.getByText('ready')).toBeTruthy());
    await flushUserPreferenceSaves();
    expect(requests()).toHaveLength(1);
  });
});
