import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import {
  Loader2,
  PencilLine,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { Project } from '../../types/app';
import { authenticatedFetch } from '../../utils/api';
import { useTheme } from '../../contexts/ThemeContext';
import { zincDarkTheme, zincLightTheme } from '../code-editor/utils/zincThemes';
import { cn } from '../../lib/utils.js';

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
            aria-label={`${activeSkill.name} ${t('skillsTab.promptContent', { defaultValue: '提示词内容' })}`}
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
  t,
}: {
  generalCwd: boolean;
  loading: boolean;
  onRefresh: () => void;
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

  return (
    <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
      <div className="mx-auto max-w-6xl text-[13px]">
        {loading && !skills ? (
          <div className="flex min-h-52 items-center justify-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.75} />
            <span>{t('skillsTab.loading', { defaultValue: 'Loading…' })}</span>
          </div>
        ) : (
          <>
            <SkillsGrid
              items={allSkills}
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
                <span className="line-clamp-2 text-sm font-semibold leading-5">{s.name}</span>
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
                {skill.name}
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
