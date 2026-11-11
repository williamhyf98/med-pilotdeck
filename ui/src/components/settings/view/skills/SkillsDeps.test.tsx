// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options === 'object' ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const fetchDeps = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));
vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: fetchDeps.authenticatedFetch,
}));

import SkillsDeps from './index';

const PAYLOAD = {
  skill: 'data-analysis',
  readOnly: true,
  runtime: {
    status: 'missing_dependencies',
    usable: false,
    path: '/home/u/.cache/pilotdeck-analysis/runtime',
    requirementsHash: 'abc',
    bootstrappedAt: '2026-11-11T02:00:00.000Z',
    stampMatches: false,
  },
  environment: { cacheRoot: '/home/u/.cache/pilotdeck-analysis', skillRoot: '/srv/app/skills/data-analysis', pythonOverride: null },
  counts: { total: 3, installed: 1, byTier: { base: 2, medical: 1 } },
  packages: [
    { name: 'pandas', extras: '', specifier: '>=2.2,<3', tier: 'base', installed: '2.2.3' },
    { name: 'scipy', extras: '', specifier: '>=1.11,<2', tier: 'base', installed: null },
    { name: 'pydicom', extras: '', specifier: '>=2.4.0', tier: 'medical', installed: null },
  ],
};

function okResponse(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body };
}

describe('SkillsDeps', () => {
  beforeEach(() => {
    fetchDeps.authenticatedFetch.mockReset();
  });
  afterEach(() => cleanup());

  it('把状态、已装数量和依赖表渲染出来', async () => {
    fetchDeps.authenticatedFetch.mockResolvedValue(okResponse(PAYLOAD));
    render(<SkillsDeps title="扩展 / 技能依赖" />);

    expect(screen.getByText('扩展 / 技能依赖')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('pandas')).toBeTruthy());
    expect(screen.getByText('settingsPage.skills.status.missing')).toBeTruthy();
    expect(
      screen.getByText('settingsPage.skills.installedCount:{"installed":1,"total":3}'),
    ).toBeTruthy();
    expect(screen.getByText('2.2.3')).toBeTruthy();
    // 未安装的包显示 "-"
    expect(screen.getAllByText('-').length).toBeGreaterThanOrEqual(2);
    expect(fetchDeps.authenticatedFetch).toHaveBeenCalledWith('/api/admin/skills/data-analysis/deps');
  });

  it('接口失败时给出错误而不是空白页', async () => {
    fetchDeps.authenticatedFetch.mockResolvedValue({ ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) });
    render(<SkillsDeps title="扩展 / 技能依赖" />);

    await waitFor(() => expect(screen.getByText(/settingsPage\.skills\.loadFailed/)).toBeTruthy());
    expect(fetchDeps.authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it('点刷新会重新请求', async () => {
    fetchDeps.authenticatedFetch.mockResolvedValue(okResponse(PAYLOAD));
    render(<SkillsDeps title="扩展 / 技能依赖" />);
    await waitFor(() => expect(fetchDeps.authenticatedFetch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText('settingsPage.skills.refresh'));
    await waitFor(() => expect(fetchDeps.authenticatedFetch).toHaveBeenCalledTimes(2));
  });
});
