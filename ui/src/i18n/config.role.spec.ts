// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStorageUserRole } from '../utils/safeStorage';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../utils/api', () => ({ authenticatedFetch: fetchMock }));

describe('i18n always-on language sync is admin-only', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ json: async () => ({ raw: '' }) });
  });
  afterEach(() => setStorageUserRole(null));

  it('does not request /api/config on language change for a normal user', async () => {
    const { default: i18n } = await import('./config.js');
    setStorageUserRole('user');
    fetchMock.mockClear();
    await i18n.changeLanguage(i18n.language === 'en' ? 'zh-CN' : 'en');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('requests /api/config on language change for an admin', async () => {
    const { default: i18n } = await import('./config.js');
    setStorageUserRole('admin');
    fetchMock.mockClear();
    await i18n.changeLanguage(i18n.language === 'en' ? 'zh-CN' : 'en');
    expect(fetchMock).toHaveBeenCalledWith('/api/config');
  });
});
