import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView } from '@codemirror/view';
import {
  ArrowLeft,
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
import {
  availabilityBucket,
  nextSkillAvailability,
  type SkillAvailability,
} from './skillAvailability';

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
  availability: SkillAvailability[];
  availabilityMutable: boolean;
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

export default function SkillsV2({ selectedProject, compact = false }: SkillsV2Props) {
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

  const handleAvailabilityChange = useCallback(async (
    skill: Skill,
    availability: SkillAvailability[],
  ) => {
    if (!skill.availabilityMutable) return;
    setSaving(true);
    try {
      const result = await api<{ skill: Skill }>('/api/skills/availability', {
        skillPath: skill.skillDir,
        projectPath: effectiveProjectPath,
        availability,
      });
      setSkills((prev) => {
        if (!prev) return prev;
        const updateIn = (list: Skill[]) => list.map((entry) =>
          entry.slug === skill.slug && entry.scope === skill.scope
            ? { ...entry, ...result.skill }
            : entry);
        return {
          ...prev,
          builtin: updateIn(prev.builtin),
          user: updateIn(prev.user),
          project: updateIn(prev.project),
          medical: updateIn(prev.medical),
        };
      });
      flashToast({
        kind: 'success',
        text: t('skillsTab.availabilitySaved', { defaultValue: '技能归属已更新' }),
      });
    } catch (error) {
      flashToast({ kind: 'error', text: (error as Error).message });
    } finally {
      setSaving(false);
    }
  }, [effectiveProjectPath, flashToast, t]);

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
            onSelect={handleSelect}
            selectedSkill={activeSkill}
            effectiveProjectPath={effectiveProjectPath}
            refresh={refresh}
            flashToast={flashToast}
            setActiveSlug={setActiveSlug}
            setActiveScope={setActiveScope}
            compact={compact}
            onAvailabilityChange={handleAvailabilityChange}
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
              onAvailabilityChange={handleAvailabilityChange}
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
  compact,
  onAvailabilityChange,
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
  compact: boolean;
  onAvailabilityChange: (skill: Skill, availability: SkillAvailability[]) => Promise<void>;
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

  const groupedSkills = useMemo(() => {
    const groups: Record<SkillAvailability, Skill[]> = {
      global: [],
      general_medicine: [],
      war_trauma: [],
    };
    if (!skills) return groups;
    for (const skill of [...skills.builtin, ...skills.user, ...skills.medical]) {
      groups[availabilityBucket(skill.availability)].push(skill);
    }
    return groups;
  }, [skills]);

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
            <ListSection
              title={t('skillsTab.globalSkills', { defaultValue: '全局技能' })}
              availability="global"
              items={groupedSkills.global}
              activeSlug={activeSlug}
              activeScope={activeScope}
              onSelect={onSelect}
              onDelete={handleDeleteSkill}
              onAvailabilityChange={onAvailabilityChange}
              t={t}
            />
            <ListSection
              title={t('skillsTab.generalMedicineSkills', { defaultValue: '通用医学技能' })}
              availability="general_medicine"
              items={groupedSkills.general_medicine}
              activeSlug={activeSlug}
              activeScope={activeScope}
              onSelect={onSelect}
              onDelete={handleDeleteSkill}
              onAvailabilityChange={onAvailabilityChange}
              t={t}
            />
            <ListSection
              title={t('skillsTab.warTraumaSkills', { defaultValue: '战创伤医学技能' })}
              availability="war_trauma"
              items={groupedSkills.war_trauma}
              activeSlug={activeSlug}
              activeScope={activeScope}
              onSelect={onSelect}
              onDelete={handleDeleteSkill}
              onAvailabilityChange={onAvailabilityChange}
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
    </div>
  );
}

function ListSection({
  title,
  availability,
  items,
  activeSlug,
  activeScope,
  onSelect,
  onDelete,
  onAvailabilityChange,
  t,
}: {
  title: string;
  availability: SkillAvailability;
  items: Skill[];
  activeSlug: string | null;
  activeScope: SkillScope | null;
  onSelect: (s: Skill) => void;
  onDelete: (s: Skill) => void;
  onAvailabilityChange: (skill: Skill, availability: SkillAvailability[]) => Promise<void>;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div
      className={cn(
        'mb-2 rounded-lg border border-transparent transition-colors',
        isDragOver && 'border-blue-300 bg-blue-50/70 dark:border-blue-700 dark:bg-blue-950/20',
      )}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('application/x-pilotdeck-skill')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setIsDragOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDragOver(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragOver(false);
        try {
          const skill = JSON.parse(
            event.dataTransfer.getData('application/x-pilotdeck-skill'),
          ) as Skill;
          if (skill.availabilityMutable) {
            void onAvailabilityChange(skill, [availability]);
          }
        } catch {
          // Ignore malformed external drag payloads.
        }
      }}
    >
      <div className="px-4 py-1 text-xxs uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
        {title} <span className="text-neutral-300 dark:text-neutral-600">· {items.length}</span>
      </div>
      <ul className="space-y-0.5 px-2">
        {items.map((s) => {
          const isActive = activeSlug === s.slug && activeScope === s.scope;
          return (
            <li key={`${s.scope}:${s.slug}`} className="group relative">
              <button
                type="button"
                onClick={() => onSelect(s)}
                draggable={s.availabilityMutable}
                onDragStart={(event) => {
                  if (!s.availabilityMutable) {
                    event.preventDefault();
                    return;
                  }
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData(
                    'application/x-pilotdeck-skill',
                    JSON.stringify(s),
                  );
                }}
                className={cn(
                  'block w-full truncate rounded-md px-2 py-1.5 pr-8 text-left text-[13px] transition-colors',
                  s.availabilityMutable && 'cursor-grab active:cursor-grabbing',
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

const AVAILABILITY_OPTIONS: Array<{ value: SkillAvailability; label: string }> = [
  { value: 'global', label: '全局' },
  { value: 'general_medicine', label: '通用医学' },
  { value: 'war_trauma', label: '战创伤医学' },
];

function AvailabilityControl({
  skill,
  saving,
  onChange,
}: {
  skill: Skill;
  saving: boolean;
  onChange: (availability: SkillAvailability[]) => void;
}) {
  const selected = new Set(skill.availability);
  const label = selected.has('global')
    ? '全局'
    : selected.has('general_medicine')
      ? '仅通用医学'
      : '仅战创伤医学';

  if (!skill.availabilityMutable) {
    return (
      <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>技能归属</span>
        <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-medium text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300">
          {label}
        </span>
        <span>只读</span>
      </div>
    );
  }

  const toggle = (value: SkillAvailability) => {
    const next = nextSkillAvailability(skill.availability, value);
    if (next.length !== skill.availability.length || next[0] !== skill.availability[0]) {
      onChange(next);
    }
  };

  return (
    <fieldset className="mt-3" disabled={saving}>
      <legend className="mb-1.5 text-[11px] font-medium text-neutral-600 dark:text-neutral-300">
        技能归属
      </legend>
      <div className="flex flex-wrap gap-3">
        {AVAILABILITY_OPTIONS.map((option) => (
          <label
            key={option.value}
            className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-neutral-700 dark:text-neutral-300"
          >
            <input
              type="checkbox"
              checked={selected.has(option.value)}
              onChange={() => toggle(option.value)}
              className="h-3.5 w-3.5 rounded border-neutral-300 accent-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
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
  onAvailabilityChange,
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
  onAvailabilityChange: (skill: Skill, availability: SkillAvailability[]) => Promise<void>;
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
        <AvailabilityControl
          skill={skill}
          saving={saving}
          onChange={(availability) => onAvailabilityChange(skill, availability)}
        />
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
