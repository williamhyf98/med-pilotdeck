import { type ReactNode, lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import {
  Loader2,
  PencilLine,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from 'lucide-react';
import type { Project } from '../../types/app';
import { authenticatedFetch } from '../../utils/api';
import { useTheme } from '../../contexts/ThemeContext';
import { zincDarkTheme, zincLightTheme } from '../code-editor/utils/zincThemes';
import { cn } from '../../lib/utils.js';

// React Flow (+ its stylesheet) only loads when the flow editor opens.
const SkillFlowEditor = lazy(() => import('./SkillFlowEditor'));

type SkillsV2Props = {
  selectedProject: Project | null;
};

type SkillScope = 'builtin' | 'user' | 'project' | 'medical';
type Skill = {
  slug: string;
  name: string;
  description: string;
  version: string | null;
  skillFile: string;
  skillDir: string;
  scope: SkillScope;
  readonly: boolean;
  overriddenBy?: 'user' | 'project';
  overridesBuiltin?: boolean;
  mtime: number | null;
  /** Optional `department:` frontmatter — free-form clinical specialty. */
  department?: string | null;
  /** Optional `category:` frontmatter — coarse kind ("role", "document", …). */
  category?: string | null;
};

type SkillsListResponse = {
  builtin: Skill[];
  user: Skill[];
  project: Skill[];
  medical: Skill[];
  projectPath: string | null;
  isGeneralCwd: boolean;
};

type ToastState = { kind: 'success' | 'error' | 'info'; text: string } | null;

/**
 * Pretty names for the `department:` frontmatter axis. The field is free-form
 * on purpose — departments differ per hospital — so an unknown value renders
 * as-is rather than being dropped; this map only labels the ones we ship.
 */
const DEPARTMENT_LABELS: Record<string, string> = {
  emergency: '急诊科',
  'critical-care': '重症医学科',
  orthopedics: '骨科',
  radiology: '影像科',
  laboratory: '检验科',
  burn: '烧伤科',
};

function departmentLabel(
  department: string,
  t: ReturnType<typeof useTranslation>['t'],
): string {
  const known = DEPARTMENT_LABELS[department];
  if (!known) return department;
  return t(`skillsTab.departments.${department}`, { defaultValue: known }) as string;
}

// ---------------------------------------------------------------------------

const SKILL_DISPLAY_NAMES: Record<string, string> = {
  '1password': '密码与密钥管理',
  'apple-notes': '苹果备忘录管理',
  'apple-reminders': '苹果提醒事项管理',
  'bear-notes': 'Bear 笔记管理',
  blogwatcher: '博客与订阅监控',
  'diagram-maker': '图示制作',
  docx: 'Word 文档处理',
  'find-skills': '技能发现与安装',
  'frontend-design': '前端界面设计',
  'frontend-slides': '网页演示制作',
  github: 'GitHub 协作管理',
  gog: 'Google 工作区管理',
  himalaya: '邮件收发与管理',
  'karpathy-guidelines': '稳健编码指南',
  'med-case-report': '结构化病例报告',
  'med-role-emergency': '急诊科诊疗助手',
  'med-role-critical-care': '重症医学诊疗助手',
  'med-role-orthopedics': '骨科诊疗助手',
  'med-role-radiology': '影像科判读助手',
  'med-role-laboratory': '检验结果分析助手',
  'med-role-burn': '烧伤科诊疗助手',
  'med-medical': '医疗附件解析',
  'med-trauma-assist': '战创伤知识问答',
  'med-trauma-stage-plan': '战创伤分阶段救治方案',
  'meeting-recorder-assistant': '会议录音与纪要',
  'minimax-pdf': '精美 PDF 制作',
  notion: 'Notion 内容管理',
  obsidian: 'Obsidian 知识库管理',
  pdf: 'PDF 文档处理',
  'pilotdeck-skills-migration': '技能迁移',
  pptx: 'PowerPoint 演示文稿处理',
  'react-next-best-practices': 'React 与 Next.js 开发实践',
  'skill-creator': '技能创建与优化',
  spreadsheets: '电子表格处理',
  spike: '可行性快速验证',
  summarize: '内容总结与转录',
  tmux: '终端会话管理',
  trello: 'Trello 任务管理',
  weather: '天气查询',
  'web-design-guidelines': '网页界面质量审查',
};

function skillDisplayName(skill: Pick<Skill, 'slug' | 'name'>): string {
  const mapped = SKILL_DISPLAY_NAMES[skill.slug.toLowerCase()];
  if (mapped) return mapped;
  if (/\p{Script=Han}/u.test(skill.name)) return skill.name;
  return `自定义技能：${skill.name}`;
}

// ---------------------------------------------------------------------------

function projectCwd(p: Project | null): string | null {
  if (!p) return null;
  return p.fullPath || p.path || null;
}

function isGeneralProject(p: Project | null): boolean {
  if (!p) return false;
  return p.name === 'general' || p.displayName === 'general';
}

async function api<T>(url: string, body: unknown): Promise<T> {
  const r = await authenticatedFetch(url, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = (data as { error?: string; message?: string }).error ||
      (data as { message?: string }).message || `Request failed (${r.status})`;
    throw new Error(message);
  }
  return data as T;
}

// ---------------------------------------------------------------------------

export default function SkillsV2({ selectedProject }: SkillsV2Props) {
  const { t } = useTranslation();
  const { isDarkMode } = useTheme() as { isDarkMode: boolean };

  const cwd = projectCwd(selectedProject);
  const localGeneralCwd = isGeneralProject(selectedProject);

  const [skills, setSkills] = useState<SkillsListResponse | null>(null);
  const [serverGeneralCwdPath, setServerGeneralCwdPath] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [activeScope, setActiveScope] = useState<SkillScope | null>(null);
  const [editorContent, setEditorContent] = useState<string>('');
  const [originalContent, setOriginalContent] = useState<string>('');
  const [editorLoading, setEditorLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showNewSkill, setShowNewSkill] = useState(false);
  const [showFlowEditor, setShowFlowEditor] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);

  const serverGeneralCwd = Boolean(cwd && serverGeneralCwdPath === cwd);
  const generalCwd = localGeneralCwd || serverGeneralCwd;
  const effectiveProjectPath = generalCwd ? null : cwd;

  const flashToast = useCallback((toastValue: ToastState, ms = 2400) => {
    setToast(toastValue);
    if (toastValue) {
      window.setTimeout(() => setToast(null), ms);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<SkillsListResponse>('/api/skills/list', {
        projectPath: effectiveProjectPath,
      });
      setSkills(data);
      setServerGeneralCwdPath((prev) => {
        if (!cwd) return null;
        if (data.isGeneralCwd) return cwd;
        if (effectiveProjectPath === null && (localGeneralCwd || prev === cwd)) return prev;
        return prev === cwd ? null : prev;
      });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }, [cwd, effectiveProjectPath, flashToast, localGeneralCwd]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (generalCwd && activeScope === 'project') {
      setActiveScope(null);
      setActiveSlug(null);
    }
  }, [activeScope, generalCwd]);

  const activeSkill = useMemo(() => {
    if (!skills || !activeSlug) return null;
    const list = activeScope === 'builtin'
      ? skills.builtin
      : activeScope === 'project'
        ? skills.project
        : activeScope === 'medical'
          ? (skills.medical ?? [])
          : skills.user;
    return list.find((s) => s.slug === activeSlug) ?? null;
  }, [skills, activeSlug, activeScope]);

  // Load SKILL.md when active skill changes
  useEffect(() => {
    if (!activeSkill) {
      setEditorContent('');
      setOriginalContent('');
      return;
    }
    let cancelled = false;
    setEditorLoading(true);
    api<{ content: string }>('/api/skills/read', {
      skillPath: activeSkill.skillDir,
      projectPath: effectiveProjectPath,
    })
      .then((data) => {
        if (cancelled) return;
        setEditorContent(data.content);
        setOriginalContent(data.content);
      })
      .catch((e) => {
        if (cancelled) return;
        flashToast({ kind: 'error', text: (e as Error).message });
        setEditorContent('');
        setOriginalContent('');
      })
      .finally(() => {
        if (!cancelled) setEditorLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSkill, effectiveProjectPath, flashToast]);

  const isDirty = editorContent !== originalContent;

  const handleSave = useCallback(async () => {
    if (!activeSkill) return;
    setSaving(true);
    try {
      const result = await api<{ ok: boolean; skill: Skill }>('/api/skills/write', {
        skillPath: activeSkill.skillDir,
        projectPath: effectiveProjectPath,
        content: editorContent,
      });
      setOriginalContent(editorContent);
      // Patch the skill in-place so list metadata (name/desc) refreshes.
      setSkills((prev) => {
        if (!prev) return prev;
        const updateIn = (list: Skill[]) =>
          list.map((s) => (s.slug === activeSkill.slug && s.scope === activeSkill.scope
            ? { ...s, ...result.skill, scope: activeSkill.scope }
            : s));
        return {
          ...prev,
          user: updateIn(prev.user),
          project: updateIn(prev.project),
        };
      });
      flashToast({ kind: 'success', text: t('skillsTab.savedSuccess', { defaultValue: 'Saved' }) });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }, [activeSkill, editorContent, effectiveProjectPath, flashToast, t]);

  const handleDelete = useCallback(async () => {
    if (!activeSkill || activeSkill.readonly) return;
    if (!window.confirm(t('skillsTab.confirmDelete', { defaultValue: 'Delete this skill? This will remove the entire folder.', name: activeSkill.name }) as string)) {
      return;
    }
    try {
      await api('/api/skills/delete', {
        skillPath: activeSkill.skillDir,
        projectPath: effectiveProjectPath,
      });
      setActiveSlug(null);
      setActiveScope(null);
      await refresh();
      flashToast({ kind: 'success', text: t('skillsTab.deletedSuccess', { defaultValue: 'Deleted' }) });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    }
  }, [activeSkill, effectiveProjectPath, refresh, flashToast, t]);

  const handleCreateUserOverride = useCallback(async () => {
    if (!activeSkill || activeSkill.scope !== 'builtin') return;
    try {
      const result = await api<{ skill: Skill }>('/api/skills/import', {
        sourcePath: activeSkill.skillDir,
        slug: activeSkill.slug,
        scope: 'user',
        projectPath: null,
        mode: 'copy',
        force: false,
      });
      await refresh();
      setActiveSlug(activeSkill.slug);
      setActiveScope('user');
      flashToast({
        kind: 'success',
        text: t('skillsTab.overrideCreated', { defaultValue: 'Created user override for "{{name}}"', name: result.skill?.name || activeSkill.name }) as string,
      });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    }
  }, [activeSkill, flashToast, refresh, t]);

  const handleSkillCreated = useCallback(async (created: Skill) => {
    setShowNewSkill(false);
    await refresh();
    setActiveSlug(created.slug);
    setActiveScope(created.scope);
    flashToast({
      kind: 'success',
      text: t('skillsTab.createdSuccess', { defaultValue: '已创建「{{name}}」', name: created.name }) as string,
    });
  }, [flashToast, refresh, t]);

  const handleFlowSkillCreated = useCallback(async (created: {
    slug: string;
    name: string;
    scope: 'user' | 'project';
  }) => {
    setShowFlowEditor(false);
    await refresh();
    setActiveSlug(created.slug);
    setActiveScope(created.scope);
    flashToast({
      kind: 'success',
      text: t('skillsTab.createdSuccess', { defaultValue: '已创建「{{name}}」', name: created.name }) as string,
    });
  }, [flashToast, refresh, t]);

  const handleSelect = useCallback((skill: Skill) => {
    if (isDirty) {
      if (!window.confirm(t('skillsTab.discardUnsaved', { defaultValue: 'Discard unsaved changes?' }) as string)) {
        return;
      }
    }
    setActiveSlug(skill.slug);
    setActiveScope(skill.scope);
  }, [isDirty, t]);

  const handleCloseDetail = useCallback(() => {
    if (isDirty && !window.confirm(t('skillsTab.discardUnsaved', { defaultValue: 'Discard unsaved changes?' }) as string)) {
      return;
    }
    setActiveSlug(null);
    setActiveScope(null);
  }, [isDirty, t]);

  useEffect(() => {
    if (!activeSkill) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleCloseDetail();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSkill, handleCloseDetail]);

  // ------------------------------------------------------------------------

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t('skillsTab.pickProject', { defaultValue: 'Open a project to manage its skills.' })}
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-neutral-50/60 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <Header
        generalCwd={generalCwd}
        loading={loading}
        onRefresh={refresh}
        onNewSkill={() => setShowNewSkill(true)}
        onFlowSkill={() => setShowFlowEditor(true)}
        t={t}
      />

      <SkillsList
        skills={skills}
        loading={loading}
        activeSlug={activeSlug}
        activeScope={activeScope}
        onSelect={handleSelect}
        selectedSkill={activeSkill}
        effectiveProjectPath={effectiveProjectPath}
        refresh={refresh}
        flashToast={flashToast}
        setActiveSlug={setActiveSlug}
        setActiveScope={setActiveScope}
        t={t}
      />

      {activeSkill ? (
        <div className="absolute inset-0 z-40 flex justify-end overflow-hidden">
          <button
            type="button"
            className="absolute inset-0 cursor-default bg-black/10 backdrop-blur-[1px] dark:bg-black/30"
            aria-label={t('skillsTab.closeDetail', { defaultValue: '关闭技能详情' }) as string}
            onClick={handleCloseDetail}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={`${skillDisplayName(activeSkill)} ${t('skillsTab.promptContent', { defaultValue: '提示词内容' })}`}
            className="skill-detail-drawer relative z-10 flex h-full w-full max-w-[760px] flex-col border-l border-neutral-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-950"
          >
            <SkillDetail
              skill={activeSkill}
              content={editorContent}
              onChange={setEditorContent}
              isDirty={isDirty}
              loading={editorLoading}
              saving={saving}
              isDarkMode={isDarkMode}
              onSave={handleSave}
              onDelete={handleDelete}
              onCreateUserOverride={handleCreateUserOverride}
              onRevert={() => setEditorContent(originalContent)}
              onClose={handleCloseDetail}
              t={t}
            />
          </aside>
        </div>
      ) : null}

      {showNewSkill ? (
        <NewSkillModal
          effectiveProjectPath={effectiveProjectPath}
          onClose={() => setShowNewSkill(false)}
          onCreated={handleSkillCreated}
          t={t}
        />
      ) : null}

      {showFlowEditor ? (
        <Suspense
          fallback={createPortal(
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-white/80 dark:bg-neutral-950/80">
              <Loader2 className="h-6 w-6 animate-spin text-neutral-400" strokeWidth={1.75} />
            </div>,
            document.body,
          )}
        >
          <SkillFlowEditor
            projectPath={cwd}
            effectiveProjectPath={effectiveProjectPath}
            onClose={() => setShowFlowEditor(false)}
            onCreated={handleFlowSkillCreated}
          />
        </Suspense>
      ) : null}

      {toast ? (
        <div
          className={cn(
            'pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md px-3 py-1.5 text-[12px] shadow-lg',
            toast.kind === 'success' && 'bg-emerald-600 text-white',
            toast.kind === 'error' && 'bg-red-600 text-white',
            toast.kind === 'info' && 'bg-neutral-800 text-white',
          )}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header({
  generalCwd,
  loading,
  onRefresh,
  onNewSkill,
  onFlowSkill,
  t,
}: {
  generalCwd: boolean;
  loading: boolean;
  onRefresh: () => void;
  onNewSkill: () => void;
  onFlowSkill: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <header className="shrink-0 border-b border-neutral-200 bg-white px-6 py-5 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-4">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-amber-600 dark:text-amber-400">
            <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
            {t('skillsTab.library', { defaultValue: '技能库' })}
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            {t('skillsTab.title', { defaultValue: '技能' })}
          </h1>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {generalCwd
              ? t('skillsTab.generalChat', { defaultValue: '通用聊天 — 内置技能和用户技能' })
              : t('skillsTab.description', { defaultValue: '查看和管理当前项目可使用的技能提示词。' })}
          </p>
        </div>
        <div className="flex items-center gap-2">
        <button type="button" onClick={onNewSkill} className="rounded-lg border px-3 py-2 text-sm" title="新建技能" aria-label="新建技能">
          <Plus className="h-4 w-4" />
        </button>
        <button type="button" onClick={onFlowSkill} className="rounded-lg border px-3 py-2 text-sm" title="流程图创建" aria-label="流程图创建">
          <Workflow className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
        >
          <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} strokeWidth={1.75} />
          {t('skillsTab.refresh', { defaultValue: '刷新' })}
        </button>
        </div>
      </div>
    </header>
  );
}

function SkillsList({
  skills,
  loading,
  activeSlug,
  activeScope,
  onSelect,
  selectedSkill,
  effectiveProjectPath,
  refresh,
  flashToast,
  setActiveSlug,
  setActiveScope,
  t,
}: {
  skills: SkillsListResponse | null;
  loading: boolean;
  activeSlug: string | null;
  activeScope: SkillScope | null;
  onSelect: (s: Skill) => void;
  selectedSkill: Skill | null;
  effectiveProjectPath: string | null;
  refresh: () => Promise<void>;
  flashToast: (t: ToastState, ms?: number) => void;
  setActiveSlug: (slug: string | null) => void;
  setActiveScope: (scope: SkillScope | null) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const handleDeleteSkill = useCallback(async (skill: Skill) => {
    if (skill.readonly) return;
    if (!window.confirm(t('skillsTab.confirmUninstall', { defaultValue: 'Uninstall "{{name}}"? This will remove the entire skill folder.', name: skill.name }) as string)) {
      return;
    }
    try {
      await api('/api/skills/delete', {
        skillPath: skill.skillDir,
        projectPath: effectiveProjectPath,
      });
      if (selectedSkill?.slug === skill.slug && selectedSkill?.scope === skill.scope) {
        setActiveSlug(null);
        setActiveScope(null);
      }
      await refresh();
      flashToast({ kind: 'success', text: t('skillsTab.uninstallSuccess', { defaultValue: 'Uninstalled "{{name}}"', name: skill.name }) as string });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    }
  }, [effectiveProjectPath, selectedSkill, refresh, flashToast, setActiveSlug, setActiveScope, t]);

  const allSkills = useMemo(
    () => skills
      ? [...skills.builtin, ...skills.user, ...skills.medical, ...skills.project]
      : [],
    [skills],
  );
  const [departmentFilter, setDepartmentFilter] = useState<string | null>(null);
  const departments = useMemo(() => [...new Set(allSkills.map(s => s.department?.trim()).filter((d): d is string => Boolean(d)))].sort(), [allSkills]);
  useEffect(() => {
    if (departmentFilter && !departments.includes(departmentFilter)) setDepartmentFilter(null);
  }, [departmentFilter, departments]);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-6xl text-[13px]">
        {departments.length > 0 && <div className="mb-4 flex flex-wrap gap-2">
          <DepartmentChip label="全部科室" active={departmentFilter === null} onClick={() => setDepartmentFilter(null)} />
          {departments.map(dep => <DepartmentChip key={dep} label={departmentLabel(dep, t)} active={departmentFilter === dep} onClick={() => setDepartmentFilter(dep)} />)}
        </div>}
        {loading && !skills ? (
          <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
            <span>{t('skillsTab.loading', { defaultValue: 'Loading…' })}</span>
          </div>
        ) : (
          <>
            <SkillsGrid
              items={departmentFilter ? allSkills.filter(s => s.department?.trim() === departmentFilter) : allSkills}
              activeSlug={activeSlug}
              activeScope={activeScope}
              onSelect={onSelect}
              onDelete={handleDeleteSkill}
              t={t}
            />
            {skills &&
            skills.builtin.length === 0 &&
            skills.user.length === 0 &&
            (skills.medical?.length ?? 0) === 0 &&
            skills.project.length === 0 ? (
              <div className="px-4 py-6 text-center text-xxs text-neutral-500 dark:text-neutral-400">
                {t('skillsTab.empty', { defaultValue: 'No skills available.' })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}

function SkillsGrid({
  items,
  activeSlug,
  activeScope,
  onSelect,
  onDelete,
  t,
}: {
  items: Skill[];
  activeSlug: string | null;
  activeScope: SkillScope | null;
  onSelect: (s: Skill) => void;
  onDelete: (s: Skill) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className="mb-6">
      <ul className="grid auto-rows-[132px] grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
        {items.map((s) => {
          const isActive = activeSlug === s.slug && activeScope === s.scope;
          return (
            <li key={`${s.scope}:${s.slug}`} className="group relative h-full min-w-0">
              <button
                type="button"
                onClick={() => onSelect(s)}
                aria-pressed={isActive}
                className={cn(
                  'flex h-full w-full flex-col overflow-hidden rounded-lg border bg-white p-4 pr-11 text-left shadow-sm transition-[border-color,background-color,box-shadow,transform] duration-150 dark:bg-neutral-900',
                  isActive
                    ? 'border-blue-400 bg-blue-50 text-neutral-900 ring-2 ring-blue-500/10 dark:border-blue-600 dark:bg-blue-950/35 dark:text-neutral-100'
                    : 'border-neutral-200 text-neutral-800 hover:-translate-y-px hover:border-neutral-300 hover:shadow-md dark:border-neutral-800 dark:text-neutral-200 dark:hover:border-neutral-700',
                )}
              >
                <span className="line-clamp-2 text-sm font-semibold leading-5">{skillDisplayName(s)}</span>
                {s.department && <span className="mt-1 text-xs text-sky-700 dark:text-sky-300">{departmentLabel(s.department, t)}</span>}
                <span className="mt-2 line-clamp-3 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
                  {s.description || t('skillsTab.noDescription', { defaultValue: '暂无技能介绍' })}
                </span>
              </button>
              {!s.readonly ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(s);
                  }}
                  className="absolute right-3 top-3 hidden h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-600 focus:inline-flex group-hover:inline-flex dark:text-neutral-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  title={t('skillsTab.delete', { defaultValue: 'Delete' }) as string}
                  aria-label={t('skillsTab.delete', { defaultValue: 'Delete' }) as string}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function DepartmentChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'h-6 shrink-0 rounded-full border px-2 text-[11px] transition-colors',
        active
          ? 'border-sky-500 bg-sky-500 text-white dark:border-sky-500 dark:bg-sky-600'
          : 'border-neutral-200 text-neutral-600 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900',
      )}
    >
      {label}
    </button>
  );
}

function EmptyState({ t }: { t: ReturnType<typeof useTranslation>['t'] }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-[13px] text-neutral-500 dark:text-neutral-400">
      <Sparkles className="h-8 w-8 text-neutral-300 dark:text-neutral-700" strokeWidth={1.5} />
      <div>{t('skillsTab.selectHint', { defaultValue: 'Pick a skill on the left to view or edit its SKILL.md.' })}</div>
    </div>
  );
}

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

/**
 * Create-from-scratch entry point. The offline pass hid this modal together
 * with the ClawHub online installer; only the local branch comes back —
 * nothing here reaches the network beyond our own `/api/skills/create`.
 */
function NewSkillModal({
  effectiveProjectPath,
  onClose,
  onCreated,
  t,
}: {
  effectiveProjectPath: string | null;
  onClose: () => void;
  onCreated: (skill: Skill) => Promise<void>;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const canUseProjectScope = Boolean(effectiveProjectPath);
  const [slug, setSlug] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const [scope, setScope] = useState<'user' | 'project'>('user');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedSlug = slug.trim();
  const slugValid = SLUG_RE.test(trimmedSlug);
  const canSubmit = slugValid && description.trim().length > 0 && !creating;

  const submit = async () => {
    if (!canSubmit) return;
    setCreating(true);
    setError(null);
    try {
      const result = await api<{ skill?: Skill }>('/api/skills/create', {
        slug: trimmedSlug,
        name: name.trim() || trimmedSlug,
        description: description.trim(),
        body: body.trim(),
        scope: canUseProjectScope ? scope : 'user',
        projectPath: effectiveProjectPath,
      });
      await onCreated(result.skill ?? {
        slug: trimmedSlug,
        name: name.trim() || trimmedSlug,
        scope: canUseProjectScope ? scope : 'user',
      } as Skill);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4 dark:bg-black/60"
      onClick={(event) => {
        if (event.target === event.currentTarget && !creating) onClose();
      }}
    >
      <div
        className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-950"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !creating) onClose();
        }}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {t('skillsTab.newTitle', { defaultValue: '新建技能' })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-900"
            aria-label={t('skillsTab.close', { defaultValue: '关闭' }) as string}
          >
            <X className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          <Field
            label={t('skillsTab.fieldSlug', { defaultValue: '目录名（slug）' }) as string}
            hint={t('skillsTab.slugHint', { defaultValue: '字母或数字开头，可含 . _ -；创建后不可改' }) as string}
          >
            <input
              autoFocus
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="cardiology-consult"
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-[13px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
            {trimmedSlug && !slugValid ? (
              <span className="mt-1 block text-[11px] text-red-600 dark:text-red-400">
                {t('skillsTab.slugInvalid', { defaultValue: 'slug 只能使用字母、数字、点、下划线和连字符，且须以字母或数字开头' })}
              </span>
            ) : null}
          </Field>

          <Field label={t('skillsTab.fieldName', { defaultValue: '名称' }) as string}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('skillsTab.fieldNamePlaceholder', { defaultValue: '留空则用 slug' }) as string}
              className="w-full rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[13px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </Field>

          <Field
            label={t('skillsTab.fieldDescription', { defaultValue: '描述' }) as string}
            hint={t('skillsTab.descHint', { defaultValue: '写清「什么时候该用这个技能」；模型靠这句话决定是否加载，也是推荐的依据' }) as string}
          >
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 text-[13px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </Field>

          <Field
            label={t('skillsTab.fieldBody', { defaultValue: '正文' }) as string}
            hint={t('skillsTab.bodyHint', { defaultValue: '可留空，创建后在右侧编辑器继续写' }) as string}
          >
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={6}
              className="w-full resize-y rounded-md border border-neutral-300 bg-white px-2 py-1.5 font-mono text-[12px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
            />
          </Field>

          {canUseProjectScope ? (
            <div>
              <span className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
                {t('skillsTab.scope', { defaultValue: '归属' })}
              </span>
              <div className="flex gap-2">
                {([
                  { value: 'user' as const, label: t('skillsTab.scopeUser', { defaultValue: 'User' }) as string },
                  { value: 'project' as const, label: t('skillsTab.scopeProject', { defaultValue: 'Project' }) as string },
                ]).map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setScope(option.value)}
                    className={cn(
                      'h-7 rounded-md border px-2.5 text-[12px] transition',
                      scope === option.value
                        ? 'border-neutral-900 bg-neutral-900 text-white dark:border-neutral-100 dark:bg-neutral-100 dark:text-neutral-900'
                        : 'border-neutral-300 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-900',
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {error ? (
            <p className="text-[12px] text-red-600 dark:text-red-400">{error}</p>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-neutral-200 px-4 py-2.5 dark:border-neutral-800">
          <button
            type="button"
            onClick={onClose}
            disabled={creating}
            className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
          >
            {t('skillsTab.close', { defaultValue: '关闭' })}
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : null}
            <span>{creating ? t('skillsTab.creating', { defaultValue: '创建中…' }) : t('skillsTab.create', { defaultValue: '创建' })}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1 block text-[11px] text-neutral-500 dark:text-neutral-400">{hint}</span>
      ) : null}
    </label>
  );
}
function SkillDetail({
  skill,
  content,
  onChange,
  isDirty,
  loading,
  saving,
  isDarkMode,
  onSave,
  onDelete,
  onCreateUserOverride,
  onRevert,
  onClose,
  t,
}: {
  skill: Skill;
  content: string;
  onChange: (v: string) => void;
  isDirty: boolean;
  loading: boolean;
  saving: boolean;
  isDarkMode: boolean;
  onSave: () => void;
  onDelete: () => void;
  onCreateUserOverride: () => void;
  onRevert: () => void;
  onClose: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-neutral-200 px-6 py-4 dark:border-neutral-800">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-blue-600 dark:text-blue-400">
              {t('skillsTab.promptContent', { defaultValue: '提示词内容' })}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                {skillDisplayName(skill)}
              </h2>
              {skill.version ? (
                <span className="text-xxs text-neutral-500 dark:text-neutral-400">v{skill.version}</span>
              ) : null}
            </div>
            {skill.description ? (
              <p className="mt-1 text-xs leading-5 text-neutral-500 dark:text-neutral-400">{skill.description}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            aria-label={t('skillsTab.closeDetail', { defaultValue: '关闭技能详情' }) as string}
            title={t('skillsTab.closeDetail', { defaultValue: '关闭技能详情' }) as string}
          >
            <X className="h-4 w-4" strokeWidth={1.8} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 bg-neutral-50/80 p-3 dark:bg-neutral-900/45 sm:p-5">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white text-xxs text-neutral-500 shadow-sm dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t('skillsTab.loading', { defaultValue: 'Loading…' })}</span>
          </div>
        ) : (
          <div className="h-full overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm ring-1 ring-black/[0.02] dark:border-neutral-700 dark:bg-neutral-950 dark:ring-white/[0.03]">
            <CodeMirror
              value={content}
              onChange={onChange}
              editable={!skill.readonly}
              extensions={[markdown(), EditorView.lineWrapping]}
              theme={isDarkMode ? zincDarkTheme : zincLightTheme}
              height="100%"
              style={{ height: '100%', fontSize: '13px' }}
              basicSetup={{
                lineNumbers: false,
                foldGutter: false,
                highlightActiveLine: false,
                indentOnInput: true,
                autocompletion: false,
                searchKeymap: true,
              }}
            />
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-neutral-200 px-6 py-3 dark:border-neutral-800">
        {skill.readonly ? (
          <span className="text-[11px] text-neutral-500 dark:text-neutral-400">
            {skill.overriddenBy
              ? t('skillsTab.builtinOverriddenBy', {
                  defaultValue: 'Read-only · overridden by {{scope}} skill',
                  scope: skill.overriddenBy === 'project'
                    ? t('skillsTab.scopeProject', { defaultValue: 'Project' })
                    : t('skillsTab.scopeUser', { defaultValue: 'User' }),
                })
              : t('skillsTab.builtinReadOnly', {
                  defaultValue: skill.scope === 'medical'
                    ? 'Read-only medical skill'
                    : 'Read-only built-in skill',
                })}
          </span>
        ) : (
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t('skillsTab.delete', { defaultValue: 'Delete' })}</span>
          </button>
        )}
        <div className="flex items-center gap-1.5">
          {skill.readonly && skill.scope === 'builtin' && !skill.overriddenBy ? (
            <button
              type="button"
              onClick={onCreateUserOverride}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 text-[12px] font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              <PencilLine className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>{t('skillsTab.createOverride', { defaultValue: 'Create user override' })}</span>
            </button>
          ) : null}
          {!skill.readonly && isDirty ? (
            <button
              type="button"
              onClick={onRevert}
              className="inline-flex h-7 items-center rounded-md px-2.5 text-[12px] text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              {t('skillsTab.revert', { defaultValue: 'Revert' })}
            </button>
          ) : null}
          {!skill.readonly ? (
            <button
              type="button"
              onClick={onSave}
              disabled={!isDirty || saving}
              className="inline-flex h-7 items-center gap-1.5 rounded-md bg-neutral-900 px-2.5 text-[12px] font-medium text-white transition hover:bg-neutral-700 disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} /> : <Save className="h-3.5 w-3.5" strokeWidth={1.75} />}
              <span>{saving ? t('skillsTab.saving', { defaultValue: 'Saving…' }) : t('skillsTab.save', { defaultValue: 'Save' })}</span>
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
