// @vitest-environment jsdom
/**
 * Task 8 —— iframe URL 的拼装。
 *
 * 面板的职责到 URL 为止；URL **被消费之后**的行为（作用域冻结、
 * 跨项目写入拦截）在 edgeclaw-memory-core 子包的 dashboardScope 测试里覆盖。
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project, ProjectSession } from '../../../../types/app';
import MemoryPanel, { buildMemoryDashboardUrl } from './MemoryPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'zh-CN' } }),
}));

vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

function project(overrides: Partial<Project> = {}): Project {
  return {
    name: 'trauma_med-abc123',
    displayName: '战创伤演练',
    fullPath: '/home/u/.pilotdeck/workspaces/trauma_med/trauma_med-abc123',
    projectType: 'war_trauma',
    ...overrides,
  } as Project;
}

function session(id: string): ProjectSession {
  return { id };
}

function queryOf(url: string | null): URLSearchParams {
  expect(url).not.toBeNull();
  return new URLSearchParams((url as string).split('?')[1]);
}

describe('buildMemoryDashboardUrl', () => {
  it('以稳定 projectId 作为寻址键', () => {
    const query = queryOf(buildMemoryDashboardUrl(project(), session('web:s1'), 'zh', 'light', null));
    expect(query.get('projectId')).toBe('trauma_med-abc123');
    expect(query.get('projectType')).toBe('war_trauma');
    expect(query.get('sessionId')).toBe('web:s1');
  });

  it('projectPath 仍然传，但只是展示参数', () => {
    const query = queryOf(buildMemoryDashboardUrl(project(), null, 'zh', 'light', null));
    expect(query.get('projectPath')).toBe('/home/u/.pilotdeck/workspaces/trauma_med/trauma_med-abc123');
    // 展示参数不能反过来成为唯一身份：projectId 必须同时在场。
    expect(query.get('projectId')).toBe('trauma_med-abc123');
  });

  it('没有 projectId 时返回 null——绝不回落到 projectPath', () => {
    expect(buildMemoryDashboardUrl(project({ name: '' }), null, 'zh', 'light', null)).toBeNull();
    expect(buildMemoryDashboardUrl(project({ name: '   ' }), null, 'zh', 'light', null)).toBeNull();
  });

  it('没有 session 时不写 sessionId', () => {
    expect(queryOf(buildMemoryDashboardUrl(project(), null, 'zh', 'light', null)).has('sessionId')).toBe(false);
    expect(queryOf(buildMemoryDashboardUrl(project(), session('  '), 'zh', 'light', null)).has('sessionId')).toBe(false);
  });

  it('projectType 回落到旧字段 type', () => {
    const query = queryOf(
      buildMemoryDashboardUrl(
        project({ projectType: undefined, type: 'general_medicine' }),
        null,
        'zh',
        'light',
        null,
      ),
    );
    expect(query.get('projectType')).toBe('general_medicine');
  });

  it('带上 locale / theme / token', () => {
    const query = queryOf(buildMemoryDashboardUrl(project(), null, 'en', 'dark', 'tok-1'));
    expect(query.get('locale')).toBe('en');
    expect(query.get('theme')).toBe('dark');
    expect(query.get('token')).toBe('tok-1');
  });

  it('没有 token 时不写 token 参数', () => {
    expect(queryOf(buildMemoryDashboardUrl(project(), null, 'zh', 'light', null)).has('token')).toBe(false);
  });
});

describe('MemoryPanel', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
  });

  it('iframe src 携带 projectId / projectType / sessionId', () => {
    render(<MemoryPanel selectedProject={project()} selectedSession={session('web:s1')} />);
    const src = screen.getByTitle('Memory 面板').getAttribute('src');
    const query = queryOf(src);
    expect((src as string).startsWith('/memory-dashboard/index.html?')).toBe(true);
    expect(query.get('projectId')).toBe('trauma_med-abc123');
    expect(query.get('projectType')).toBe('war_trauma');
    expect(query.get('sessionId')).toBe('web:s1');
  });

  it('换 session 时 iframe 重挂，避免旧作用域继续存活', () => {
    const { rerender } = render(
      <MemoryPanel selectedProject={project()} selectedSession={session('web:s1')} />,
    );
    const first = screen.getByTitle('Memory 面板');
    rerender(<MemoryPanel selectedProject={project()} selectedSession={session('web:s2')} />);
    const second = screen.getByTitle('Memory 面板');
    expect(second).not.toBe(first);
    expect(queryOf(second.getAttribute('src')).get('sessionId')).toBe('web:s2');
  });

  it('项目缺稳定 id 时给出不可用提示而不是渲染 iframe', () => {
    render(<MemoryPanel selectedProject={project({ name: '' })} selectedSession={null} />);
    expect(screen.queryByTitle('Memory 面板')).toBeNull();
    expect(screen.getByText('身份验证和项目上下文准备完成后，Memory 面板才可用。')).toBeTruthy();
  });

  it('未选项目时提示选择项目', () => {
    render(<MemoryPanel selectedProject={null} />);
    expect(screen.getByText('请选择一个项目查看 Memory。')).toBeTruthy();
  });
});
