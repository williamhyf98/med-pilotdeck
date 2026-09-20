import { useTranslation } from 'react-i18next';
import type { Project, ProjectSession } from '../../../../types/app';
import { AUTH_TOKEN_STORAGE_KEY } from '../../../auth/constants';
import { useTheme } from '../../../../contexts/ThemeContext';

type MemoryPanelProps = {
  selectedProject: Project | null;
  selectedSession?: ProjectSession | null;
};

function normalizeMemoryLocale(language: string | undefined): 'zh' | 'en' {
  return language === 'zh-CN' ? 'zh' : 'en';
}

function normalizeMemoryTheme(isDarkMode: boolean): 'light' | 'dark' {
  return isDarkMode ? 'dark' : 'light';
}

const MEMORY_PANEL_TEXT: Record<'zh' | 'en', {
  emptyProject: string;
  unavailable: string;
  title: string;
}> = {
  zh: {
    emptyProject: '请选择一个项目查看 Memory。',
    unavailable: '身份验证和项目上下文准备完成后，Memory 面板才可用。',
    title: 'Memory 面板',
  },
  en: {
    emptyProject: 'Select a project to inspect memory.',
    unavailable: 'Memory dashboard is unavailable until auth and project context are ready.',
    title: 'Memory Dashboard',
  },
};

/**
 * 面板绑定的身份（Task 8）。
 *
 * 之前只传 `projectPath`，而它是**可变的展示路径**：项目改名、工作区迁移、
 * 链接仓库搬家都会改变它，但记忆数据是按稳定 projectId 存的——于是
 * 「面板指着 A、写入落到 B」在结构上是可能的。现在寻址键换成 projectId，
 * projectPath 降级为兼容参数，不再显示，也不参与服务端定位。
 *
 * `project.name` 就是服务端分配的稳定 storage id（见 `ui/server/projects.js`
 * 的 allocateSystemProjectId / createProjectId），所以这里不需要异步取身份，
 * URL 可以同步拼出来。
 */
export function buildMemoryDashboardUrl(
  project: Project,
  session: ProjectSession | null | undefined,
  locale: 'zh' | 'en',
  theme: 'light' | 'dark',
  token: string | null,
): string | null {
  const projectId = (project.name || '').trim();
  // 没有稳定 id 就不渲染面板。回落到 projectPath 正是 Task 8 要消灭的那个 bug。
  if (!projectId) {
    return null;
  }

  const params = new URLSearchParams({ projectId, locale, theme });

  const projectType = project.projectType || project.type;
  if (projectType) {
    params.set('projectType', projectType);
  }

  // sessionId 从 Task 9 起是**寻址参数**而不只是展示：病例状态页按它定位
  // `cases/<session>` 目录。没有 session 时不能编一个，面板会显示「未选择
  // session」而不是拿别的病例顶上。
  const sessionId = (session?.id || '').trim();
  if (sessionId) {
    params.set('sessionId', sessionId);
  }

  // 兼容旧接口的请求参数；服务端不得用它取代 projectId 定位项目。
  const projectPath = project.fullPath || project.path;
  if (projectPath) {
    params.set('projectPath', projectPath);
  }

  if (token) {
    params.set('token', token);
  }

  return `/memory-dashboard/index.html?${params.toString()}`;
}

export default function MemoryPanel({ selectedProject, selectedSession = null }: MemoryPanelProps) {
  const { i18n } = useTranslation();
  const { isDarkMode } = useTheme();
  const memoryLocale = normalizeMemoryLocale(i18n.language);
  const memoryTheme = normalizeMemoryTheme(isDarkMode);
  const text = MEMORY_PANEL_TEXT[memoryLocale];

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-[13px] text-muted-foreground">
        {text.emptyProject}
      </div>
    );
  }

  const dashboardUrl = buildMemoryDashboardUrl(
    selectedProject,
    selectedSession,
    memoryLocale,
    memoryTheme,
    localStorage.getItem(AUTH_TOKEN_STORAGE_KEY),
  );
  if (!dashboardUrl) {
    return (
      <div className="flex h-full items-center justify-center bg-background text-[13px] text-muted-foreground">
        {text.unavailable}
      </div>
    );
  }

  // Outer shell mirrors MainAreaV2's chrome (white / neutral-950) so the
  // iframe blends seamlessly when the V2 dashboard is rendered full-screen
  // — avoids the dark-mode "two-tone" line + legacy overlap that showed up
  // when Memory was previously paired with chat in a split pane.
  return (
    <div className="h-full w-full bg-background">
      <iframe
        // 按身份重挂 iframe：切项目或切 session 都要重新引导，
        // 否则旧作用域的 app.js 会继续活着（它在模块加载时冻结作用域）。
        key={`${selectedProject.name}:${selectedSession?.id ?? ''}:${memoryLocale}:${memoryTheme}`}
        title={text.title}
        src={dashboardUrl}
        className="block h-full w-full border-0 bg-background"
      />
    </div>
  );
}
