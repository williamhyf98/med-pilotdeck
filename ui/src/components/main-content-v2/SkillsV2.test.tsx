// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SkillsV2 from './SkillsV2';

const authenticatedFetch = vi.hoisted(() => vi.fn());

vi.mock('../../utils/api', () => ({ authenticatedFetch }));
vi.mock('../../contexts/ThemeContext', () => ({ useTheme: () => ({ isDarkMode: false }) }));
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value }: { value: string }) => <textarea aria-label="技能提示词" readOnly value={value} />,
}));
vi.mock('@codemirror/lang-markdown', () => ({ markdown: () => [] }));
vi.mock('@codemirror/view', () => ({ EditorView: { lineWrapping: {} } }));
vi.mock('../code-editor/utils/zincThemes', () => ({ zincDarkTheme: [], zincLightTheme: [] }));

const project = {
  name: 'general_med-demo',
  displayName: '通用医学演示',
  fullPath: '/workspace/general_med-demo',
};

const skill = {
  slug: 'clinical-summary',
  name: '病例摘要',
  description: '将病历信息整理为清晰的临床摘要。',
  version: '1.0.0',
  skillFile: '/workspace/general_med-demo/.skills/clinical-summary/SKILL.md',
  skillDir: '/workspace/general_med-demo/.skills/clinical-summary',
  scope: 'project',
  readonly: false,
  mtime: 1,
  availability: ['global'],
  availabilityMutable: false,
};

const englishSkill = {
  ...skill,
  slug: 'weather',
  name: 'weather',
  description: 'Current weather and forecasts.',
  scope: 'user',
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

describe('SkillsV2', () => {
  beforeEach(() => {
    authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === '/api/skills/read') return jsonResponse({ content: '# 病例摘要\n请生成结构化摘要。' });
      return jsonResponse({
        builtin: [],
        user: [],
        medical: [],
        project: [skill],
        projectPath: project.fullPath,
        isGeneralCwd: false,
      });
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows skills as cards and opens prompt content in a right-side detail panel', async () => {
    render(<SkillsV2 selectedProject={project} />);

    const skillCard = await screen.findByRole('button', { name: /病例摘要/ });
    expect(screen.getByText('将病历信息整理为清晰的临床摘要。')).toBeTruthy();
    expect(screen.queryByText('全局技能')).toBeNull();
    expect(screen.queryByText('通用医学技能')).toBeNull();
    expect(screen.queryByText('战创伤医学技能')).toBeNull();
    expect(skillCard.className).toContain('h-full');
    expect(screen.queryByText(skill.skillDir)).toBeNull();

    fireEvent.click(skillCard);

    const detail = await screen.findByRole('dialog', { name: /病例摘要.*提示词内容/ });
    expect(detail.className).toContain('skill-detail-drawer');
    expect(screen.getByRole('textbox', { name: '技能提示词' }).parentElement?.className)
      .toContain('rounded-lg');
    await waitFor(() => {
      expect((screen.getByRole('textbox', { name: '技能提示词' }) as HTMLTextAreaElement).value)
        .toContain('请生成结构化摘要');
    });
    expect(screen.queryByText(skill.skillDir)).toBeNull();

    fireEvent.click(screen.getAllByRole('button', { name: '关闭技能详情' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows a functional Chinese display name without changing the skill identity', async () => {
    authenticatedFetch.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/skills/read') return jsonResponse({ content: '# Weather' });
      const request = JSON.parse(String(options?.body ?? '{}')) as { projectPath?: string };
      expect(request.projectPath).toBe(project.fullPath);
      return jsonResponse({
        builtin: [],
        user: [englishSkill],
        medical: [],
        project: [],
        projectPath: project.fullPath,
        isGeneralCwd: false,
      });
    });

    render(<SkillsV2 selectedProject={project} />);

    const card = await screen.findByRole('button', { name: /天气查询/ });
    expect(screen.queryByText(/^weather$/)).toBeNull();
    fireEvent.click(card);
    expect(await screen.findByRole('dialog', { name: /天气查询.*提示词内容/ })).toBeTruthy();
  });
});
