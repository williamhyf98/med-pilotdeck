import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import {
  ArrowLeft,
  ArrowRightLeft,
  Folder,
  Globe,
  Loader2,
  PencilLine,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
} from 'lucide-react';
import type { Project } from '../../types/app';
import { authenticatedFetch } from '../../utils/api';
import { useTheme } from '../../contexts/ThemeContext';
import { zincDarkTheme, zincLightTheme } from '../code-editor/utils/zincThemes';
import { cn } from '../../lib/utils.js';

type SkillsV2Props = {
  selectedProject: Project | null;
  projects: Project[];
  compact?: boolean;
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

export default function SkillsV2({ selectedProject, projects, compact = false }: SkillsV2Props) {
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

  // ------------------------------------------------------------------------

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t('skillsTab.pickProject', { defaultValue: 'Open a project to manage its skills.' })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-white dark:bg-neutral-950">
      <Header
        cwd={cwd}
        generalCwd={generalCwd}
        loading={loading}
        onRefresh={refresh}
        compact={compact}
        t={t}
      />

      <div className="flex min-h-0 flex-1">
        {!compact || !activeSkill ? (
          <SkillsList
            skills={skills}
            loading={loading}
            activeSlug={activeSlug}
            activeScope={activeScope}
            generalCwd={generalCwd}
            onSelect={handleSelect}
            selectedSkill={activeSkill}
            effectiveProjectPath={effectiveProjectPath}
            projects={projects}
            refresh={refresh}
            flashToast={flashToast}
            setActiveSlug={setActiveSlug}
            setActiveScope={setActiveScope}
            compact={compact}
            t={t}
          />
        ) : null}
        {!compact || activeSkill ? (
        <div className={cn(
          'flex min-h-0 flex-1 flex-col',
          !compact && 'border-l border-neutral-200 dark:border-neutral-800',
        )}>
          {compact && activeSkill ? (
            <button
              type="button"
              onClick={() => {
                if (isDirty && !window.confirm(t('skillsTab.discardUnsaved', { defaultValue: 'Discard unsaved changes?' }) as string)) return;
                setActiveSlug(null);
                setActiveScope(null);
              }}
              className="flex h-9 shrink-0 items-center gap-1.5 border-b border-neutral-200 px-3 text-[12px] font-medium text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
            >
              <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
              <span>{t('skillsTab.backToSkills', { defaultValue: 'Back to skills' })}</span>
            </button>
          ) : null}
          {activeSkill ? (
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
              compact={compact}
              t={t}
            />
          ) : (
            <EmptyState t={t} />
          )}
        </div>
        ) : null}
      </div>

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
  cwd,
  generalCwd,
  loading,
  onRefresh,
  compact,
  t,
}: {
  cwd: string | null;
  generalCwd: boolean;
  loading: boolean;
  onRefresh: () => void;
  compact: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className={cn(
      'flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 dark:border-neutral-800',
      compact ? 'px-3' : 'px-6',
    )}>
      <div className="flex min-w-0 items-center gap-2 truncate font-mono text-xxs text-neutral-500 dark:text-neutral-400">
        <Sparkles className="h-3.5 w-3.5 text-amber-500" strokeWidth={1.75} />
        {generalCwd ? (
          <span>{t('skillsTab.generalChat', { defaultValue: 'General chat — user-scope skills only' })}</span>
        ) : (
          <span className="truncate">{cwd}</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
          title={t('skillsTab.refresh', { defaultValue: 'Refresh' }) as string}
          aria-label={t('skillsTab.refresh', { defaultValue: 'Refresh' }) as string}
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
        </button>
      </div>
    </div>
  );
}

type MoveTarget = { scope: 'user'; projectPath: null } | { scope: 'project'; projectPath: string };

function SkillsList({
  skills,
  loading,
  activeSlug,
  activeScope,
  generalCwd,
  onSelect,
  selectedSkill,
  effectiveProjectPath,
  projects,
  refresh,
  flashToast,
  setActiveSlug,
  setActiveScope,
  compact,
  t,
}: {
  skills: SkillsListResponse | null;
  loading: boolean;
  activeSlug: string | null;
  activeScope: SkillScope | null;
  generalCwd: boolean;
  onSelect: (s: Skill) => void;
  selectedSkill: Skill | null;
  effectiveProjectPath: string | null;
  projects: Project[];
  refresh: () => Promise<void>;
  flashToast: (t: ToastState, ms?: number) => void;
  setActiveSlug: (slug: string | null) => void;
  setActiveScope: (scope: SkillScope | null) => void;
  compact: boolean;
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

  const handleMoveSkill = useCallback(async (skill: Skill, target: MoveTarget) => {
    if (skill.readonly) return;
    try {
      await api('/api/skills/import', {
        sourcePath: skill.skillDir,
        slug: skill.slug,
        scope: target.scope,
        projectPath: target.projectPath,
        mode: 'copy',
        force: false,
      });
      await api('/api/skills/delete', {
        skillPath: skill.skillDir,
        projectPath: effectiveProjectPath,
      });
      if (selectedSkill?.slug === skill.slug && selectedSkill?.scope === skill.scope) {
        setActiveScope(target.scope);
      }
      await refresh();
      const label = target.scope === 'user' ? 'User' : target.projectPath.split('/').pop() || 'Project';
      flashToast({
        kind: 'success',
        text: t('skillsTab.moveSuccess', {
          defaultValue: 'Moved "{{name}}" to {{scope}}',
          name: skill.name,
          scope: label,
        }) as string,
      });
    } catch (e) {
      flashToast({ kind: 'error', text: (e as Error).message });
    }
  }, [effectiveProjectPath, selectedSkill, refresh, flashToast, setActiveScope, t]);

  const moveTargets = useMemo((): { label: string; target: MoveTarget }[] => {
    const targets: { label: string; target: MoveTarget }[] = [];
    targets.push({ label: 'User (global)', target: { scope: 'user', projectPath: null } });
    for (const project of projects) {
      const path = project.fullPath || project.path || null;
      if (!path) continue;
      if (project.name === 'general' || project.displayName === 'general') continue;
      targets.push({
        label: project.displayName || project.name,
        target: { scope: 'project', projectPath: path },
      });
    }
    return targets;
  }, [projects]);

  return (
    <div className={cn(
      'flex shrink-0 flex-col',
      compact ? 'w-full' : 'w-72 border-r border-neutral-200 dark:border-neutral-800',
    )}>
      <div className="min-h-0 flex-1 overflow-y-auto py-2 text-[13px]">
        {loading && !skills ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xxs text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t('skillsTab.loading', { defaultValue: 'Loading…' })}</span>
          </div>
        ) : (
          <>
            {skills?.builtin && skills.builtin.length > 0 ? (
              <ListSection
                title={t('skillsTab.generalScope', { defaultValue: '通用技能' })}
                items={skills.builtin}
                activeSlug={activeScope === 'builtin' ? activeSlug : null}
                onSelect={onSelect}
                onDelete={handleDeleteSkill}
                onMove={handleMoveSkill}
                moveTargets={moveTargets}
                currentProjectPath={effectiveProjectPath}
                t={t}
              />
            ) : null}
            {skills?.user && skills.user.length > 0 ? (
              <ListSection
                title={t('skillsTab.userScope', { defaultValue: 'User Skills' })}
                items={skills.user}
                activeSlug={activeScope === 'user' ? activeSlug : null}
                onSelect={onSelect}
                onDelete={handleDeleteSkill}
                onMove={handleMoveSkill}
                moveTargets={moveTargets}
                currentProjectPath={effectiveProjectPath}
                t={t}
              />
            ) : null}
            {!generalCwd && skills?.project && skills.project.length > 0 ? (
              <ListSection
                title={t('skillsTab.projectScope', { defaultValue: 'Project Skills' })}
                items={skills.project}
                activeSlug={activeScope === 'project' ? activeSlug : null}
                onSelect={onSelect}
                onDelete={handleDeleteSkill}
                onMove={handleMoveSkill}
                moveTargets={moveTargets}
                currentProjectPath={effectiveProjectPath}
                t={t}
              />
            ) : null}
            {skills?.medical && skills.medical.length > 0 ? (
              <ListSection
                title={t('skillsTab.medicalScope', { defaultValue: '医学技能' })}
                items={skills.medical}
                activeSlug={activeScope === 'medical' ? activeSlug : null}
                onSelect={onSelect}
                onDelete={handleDeleteSkill}
                onMove={handleMoveSkill}
                moveTargets={moveTargets}
                currentProjectPath={effectiveProjectPath}
                t={t}
              />
            ) : null}
            {skills &&
            skills.builtin.length === 0 &&
            skills.user.length === 0 &&
            (skills.medical?.length ?? 0) === 0 &&
            (generalCwd || skills.project.length === 0) ? (
              <div className="px-4 py-6 text-center text-xxs text-neutral-500 dark:text-neutral-400">
                {t('skillsTab.empty', { defaultValue: 'No skills available.' })}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

type ContextMenuState = { skill: Skill; x: number; y: number } | null;

function ListSection({
  title,
  items,
  activeSlug,
  onSelect,
  onDelete,
  onMove,
  moveTargets,
  currentProjectPath,
  t,
}: {
  title: string;
  items: Skill[];
  activeSlug: string | null;
  onSelect: (s: Skill) => void;
  onDelete: (s: Skill) => void;
  onMove: (s: Skill, target: MoveTarget) => void;
  moveTargets: { label: string; target: MoveTarget }[];
  currentProjectPath: string | null;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState>(null);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!ctxMenu) return;
    const handleClose = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') {
        setCtxMenu(null);
        setShowMoveSubmenu(false);
        return;
      }
      if (e instanceof MouseEvent && menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setCtxMenu(null);
        setShowMoveSubmenu(false);
      }
    };
    document.addEventListener('mousedown', handleClose);
    document.addEventListener('keydown', handleClose);
    return () => {
      document.removeEventListener('mousedown', handleClose);
      document.removeEventListener('keydown', handleClose);
    };
  }, [ctxMenu]);

  const handleContextMenu = useCallback((e: React.MouseEvent, skill: Skill) => {
    if (skill.readonly) return;
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ skill, x: e.clientX, y: e.clientY });
    setShowMoveSubmenu(false);
  }, []);

  const filteredMoveTargets = useMemo(() => {
    if (!ctxMenu) return [];
    const skill = ctxMenu.skill;
    if (skill.readonly) return [];
    return moveTargets.filter((mt) => {
      if (skill.scope === 'user' && mt.target.scope === 'user') return false;
      if (skill.scope === 'project' && mt.target.scope === 'project' && mt.target.projectPath === currentProjectPath) return false;
      return true;
    });
  }, [ctxMenu, moveTargets, currentProjectPath]);

  return (
    <div className="mb-2">
      <div className="px-4 py-1 text-xxs uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
        {title} <span className="text-neutral-300 dark:text-neutral-600">· {items.length}</span>
      </div>
      <ul className="space-y-0.5 px-2">
        {items.map((s) => {
          const isActive = activeSlug === s.slug;
          return (
            <li key={`${s.scope}:${s.slug}`} className="group relative">
              <button
                type="button"
                onClick={() => onSelect(s)}
                onContextMenu={s.readonly ? undefined : (e) => handleContextMenu(e, s)}
                className={cn(
                  'block w-full truncate rounded-md px-2 py-1.5 pr-8 text-left text-[13px] transition-colors',
                  isActive
                    ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                    : 'text-neutral-700 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-900/60',
                )}
                title={s.description || s.name}
              >
                <div className="flex items-center gap-1.5 truncate font-medium">
                  <span className="truncate">{s.name}</span>
                  {s.version ? (
                    <span className="shrink-0 rounded bg-neutral-200 px-1 py-px text-[10px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-400">
                      v{s.version}
                    </span>
                  ) : null}
                  {s.overriddenBy ? (
                    <span className="shrink-0 rounded bg-neutral-200 px-1 py-px text-[10px] text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {t('skillsTab.overridden', { defaultValue: 'overridden' })}
                    </span>
                  ) : null}
                  {s.overridesBuiltin ? (
                    <span className="shrink-0 rounded bg-violet-100 px-1 py-px text-[10px] text-violet-700 dark:bg-violet-950/50 dark:text-violet-300">
                      {t('skillsTab.override', { defaultValue: 'override' })}
                    </span>
                  ) : null}
                </div>
                {s.description ? (
                  <div className="mt-0.5 line-clamp-1 text-xxs text-neutral-500 dark:text-neutral-400">
                    {s.description}
                  </div>
                ) : null}
              </button>
              {!s.readonly ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(s);
                  }}
                  className="absolute right-1.5 top-1/2 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-neutral-400 hover:bg-red-50 hover:text-red-600 group-hover:inline-flex dark:text-neutral-500 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                  title={t('skillsTab.delete', { defaultValue: 'Delete' }) as string}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>

      {ctxMenu ? (
        <div
          ref={menuRef}
          className="fixed z-[100] min-w-[180px] rounded-lg border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          {filteredMoveTargets.length > 0 ? (
            <div className="relative">
              <button
                type="button"
                onMouseEnter={() => setShowMoveSubmenu(true)}
                onClick={() => setShowMoveSubmenu(!showMoveSubmenu)}
                className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                <span className="flex items-center gap-2">
                  <ArrowRightLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
                  <span>{t('skillsTab.moveTo', { defaultValue: 'Move to…' })}</span>
                </span>
                <span className="text-neutral-400">›</span>
              </button>
              {showMoveSubmenu ? (
                <div
                  className="absolute left-full top-0 z-[101] ml-1 min-w-[160px] max-h-[240px] overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
                >
                  {filteredMoveTargets.map((mt) => (
                    <button
                      key={mt.target.scope + ':' + (mt.target.projectPath || 'user')}
                      type="button"
                      onClick={() => {
                        const skill = ctxMenu.skill;
                        setCtxMenu(null);
                        setShowMoveSubmenu(false);
                        onMove(skill, mt.target);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-neutral-700 hover:bg-neutral-100 dark:text-neutral-200 dark:hover:bg-neutral-800"
                    >
                      {mt.target.scope === 'user' ? (
                        <Globe className="h-3.5 w-3.5 shrink-0 text-amber-500" strokeWidth={1.75} />
                      ) : (
                        <Folder className="h-3.5 w-3.5 shrink-0 text-blue-500" strokeWidth={1.75} />
                      )}
                      <span className="truncate">{mt.label}</span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <button
            type="button"
            onClick={() => {
              const skill = ctxMenu.skill;
              setCtxMenu(null);
              setShowMoveSubmenu(false);
              onDelete(skill);
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            <span>{t('skillsTab.delete', { defaultValue: 'Delete' })}</span>
          </button>
        </div>
      ) : null}
    </div>
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
  compact,
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
  compact: boolean;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={cn(
        'shrink-0 border-b border-neutral-200 py-3 dark:border-neutral-800',
        compact ? 'px-4' : 'px-6',
      )}>
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
            {skill.name}
          </h2>
          <span
            className={cn(
              'rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider',
              skill.scope === 'medical'
                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                : skill.scope === 'project'
                ? 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
                : skill.scope === 'builtin'
                  ? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
            )}
          >
            {skill.scope === 'medical'
              ? t('skillsTab.scopeMedical', { defaultValue: '医学' })
              : skill.scope === 'builtin'
              ? t('skillsTab.scopeBuiltin', { defaultValue: 'Built-in' })
              : skill.scope === 'project'
                ? t('skillsTab.scopeProject', { defaultValue: 'Project' })
                : t('skillsTab.scopeUser', { defaultValue: 'User' })}
          </span>
          {skill.version ? (
            <span className="text-xxs text-neutral-500 dark:text-neutral-400">v{skill.version}</span>
          ) : null}
        </div>
        {skill.description ? (
          <p className="mt-1 text-xxs text-neutral-500 dark:text-neutral-400">{skill.description}</p>
        ) : null}
        <div className="mt-1 truncate font-mono text-[10px] text-neutral-400 dark:text-neutral-500">
          {skill.skillDir}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-xxs text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t('skillsTab.loading', { defaultValue: 'Loading…' })}</span>
          </div>
        ) : (
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
        )}
      </div>

      <div className={cn(
        'flex shrink-0 items-center justify-between gap-2 border-t border-neutral-200 py-2 dark:border-neutral-800',
        compact ? 'flex-wrap px-3' : 'px-6',
      )}>
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
