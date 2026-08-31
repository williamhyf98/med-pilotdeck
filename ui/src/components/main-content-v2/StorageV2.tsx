import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ChevronDown,
  ChevronRight,
  File,
  FileImage,
  FileText,
  FolderOpen,
  HardDrive,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { authenticatedFetch } from '../../utils/api';
import { cn } from '../../lib/utils.js';

type StorageScope = 'workspace' | 'archive';
type PreviewKind = 'image' | 'pdf' | 'text';

type StorageFile = {
  path: string;
  name: string;
  sizeBytes: number;
  previewKind: PreviewKind | null;
};

type WorkspaceGroup = {
  id: string;
  projectId: string;
  displayName: string;
  projectType: 'general_medicine' | 'war_trauma';
  typeKey: string;
  sizeBytes: number;
  files: StorageFile[];
};

type ArchiveGroup = {
  id: string;
  projectId: string;
  archivedAt: string | null;
  sizeBytes: number;
  files: StorageFile[];
};

type StorageSnapshot = {
  totals: {
    totalBytes: number;
    workspaceBytes: number;
    archiveBytes: number;
  };
  workspaces: WorkspaceGroup[];
  archives: ArchiveGroup[];
};

type FileTarget = {
  kind: 'file';
  scope: StorageScope;
  groupId: string;
  typeKey?: string;
  path: string;
};

type GroupTarget =
  | { kind: 'workspace'; scope: 'workspace'; groupId: string; typeKey: string }
  | { kind: 'archive'; scope: 'archive'; groupId: string };

type DeleteTarget = FileTarget | GroupTarget;

type ConfirmState = {
  targets: DeleteTarget[];
  title: string;
  detail: string;
  bytes: number;
} | null;

type PreviewState = {
  title: string;
  kind: PreviewKind;
  loading: boolean;
  content: string | null;
  objectUrl: string | null;
  truncated: boolean;
  error: string | null;
} | null;

const EMPTY_SNAPSHOT: StorageSnapshot = {
  totals: { totalBytes: 0, workspaceBytes: 0, archiveBytes: 0 },
  workspaces: [],
  archives: [],
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / (1024 ** index);
  return `${scaled >= 100 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function targetKey(target: DeleteTarget): string {
  return [
    target.kind,
    target.scope,
    'typeKey' in target ? target.typeKey ?? '' : '',
    target.groupId,
    'path' in target ? target.path : '',
  ].join('\u0000');
}

function fileTarget(
  scope: StorageScope,
  group: WorkspaceGroup | ArchiveGroup,
  file: StorageFile,
): FileTarget {
  return {
    kind: 'file',
    scope,
    groupId: group.id,
    ...('typeKey' in group ? { typeKey: group.typeKey } : {}),
    path: file.path,
  };
}

function archiveGroupTarget(group: ArchiveGroup): GroupTarget {
  return { kind: 'archive', scope: 'archive', groupId: group.id };
}

function projectTypeLabel(type: WorkspaceGroup['projectType']): string {
  return type === 'war_trauma' ? '战创伤医学' : '通用医学';
}

function formatArchiveTime(value: string | null): string {
  if (!value) return '归档时间未知';
  const match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
  if (!match) return value;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`);
  return date.toLocaleString('zh-CN', { hour12: false });
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error || `请求失败（${response.status}）`);
  }
  return body as T;
}

function FileKindIcon({ kind }: { kind: PreviewKind | null }) {
  if (kind === 'image') return <FileImage className="h-4 w-4" />;
  if (kind === 'text' || kind === 'pdf') return <FileText className="h-4 w-4" />;
  return <File className="h-4 w-4" />;
}

export default function StorageV2() {
  const [snapshot, setSnapshot] = useState<StorageSnapshot>(EMPTY_SNAPSHOT);
  const [activeScope, setActiveScope] = useState<StorageScope>('workspace');
  const [loading, setLoading] = useState(true);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Map<string, DeleteTarget>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [preview, setPreview] = useState<PreviewState>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/storage');
      const data = await readJson<StorageSnapshot>(response);
      setSnapshot(data);
      setSelected(new Map());
      setExpanded((current) => {
        if (current.size > 0) return current;
        const first = data.workspaces[0]?.id ?? data.archives[0]?.id;
        return first ? new Set([first]) : current;
      });
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => () => {
    if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
  }, [preview?.objectUrl]);

  const groups = activeScope === 'workspace' ? snapshot.workspaces : snapshot.archives;
  const filteredGroups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return groups;
    return groups.flatMap((group) => {
      const groupLabel = activeScope === 'workspace'
        ? `${(group as WorkspaceGroup).displayName} ${group.projectId}`
        : `${group.id} ${group.projectId}`;
      const groupMatches = groupLabel.toLocaleLowerCase().includes(normalized);
      const files = groupMatches
        ? group.files
        : group.files.filter((file) => file.path.toLocaleLowerCase().includes(normalized));
      return groupMatches || files.length > 0 ? [{ ...group, files }] : [];
    });
  }, [activeScope, groups, query]);

  const selectedBytes = useMemo(() => {
    let total = 0;
    const sizes = new Map<string, number>();
    snapshot.workspaces.forEach((group) => group.files.forEach((file) => {
      sizes.set(targetKey(fileTarget('workspace', group, file)), file.sizeBytes);
    }));
    snapshot.archives.forEach((group) => group.files.forEach((file) => {
      sizes.set(targetKey(fileTarget('archive', group, file)), file.sizeBytes);
    }));
    snapshot.archives.forEach((group) => {
      sizes.set(targetKey(archiveGroupTarget(group)), group.sizeBytes);
    });
    selected.forEach((_target, key) => { total += sizes.get(key) ?? 0; });
    return total;
  }, [selected, snapshot]);

  const toggleFile = useCallback((target: FileTarget) => {
    const key = targetKey(target);
    setSelected((current) => {
      const next = new Map(current);
      if (target.scope === 'archive') {
        next.delete(targetKey({
          kind: 'archive',
          scope: 'archive',
          groupId: target.groupId,
        }));
      }
      if (next.has(key)) next.delete(key);
      else next.set(key, target);
      return next;
    });
  }, []);

  const toggleGroupSelection = useCallback((
    scope: StorageScope,
    group: WorkspaceGroup | ArchiveGroup,
  ) => {
    if (scope === 'archive') {
      const archiveTarget = archiveGroupTarget(group as ArchiveGroup);
      const key = targetKey(archiveTarget);
      setSelected((current) => {
        const next = new Map(current);
        group.files.forEach((file) => {
          next.delete(targetKey(fileTarget('archive', group, file)));
        });
        if (next.has(key)) next.delete(key);
        else next.set(key, archiveTarget);
        return next;
      });
      return;
    }

    const targets = group.files.map((file) => fileTarget(scope, group, file));
    const allSelected = targets.length > 0 && targets.every((target) => selected.has(targetKey(target)));
    setSelected((current) => {
      const next = new Map(current);
      targets.forEach((target) => {
        if (allSelected) next.delete(targetKey(target));
        else next.set(targetKey(target), target);
      });
      return next;
    });
  }, [selected]);

  const requestSelectedDelete = () => {
    if (selected.size === 0) return;
    setConfirm({
      targets: [...selected.values()],
      title: `删除选中的 ${selected.size} 项？`,
      detail: '选中的文件或归档文件夹将被永久删除，但在用项目和对话不会被删除。',
      bytes: selectedBytes,
    });
  };

  const requestGroupDelete = (
    scope: StorageScope,
    group: WorkspaceGroup | ArchiveGroup,
  ) => {
    const target: GroupTarget = scope === 'workspace'
      ? {
        kind: 'workspace',
        scope: 'workspace',
        groupId: group.id,
        typeKey: (group as WorkspaceGroup).typeKey,
      }
      : { kind: 'archive', scope: 'archive', groupId: group.id };
    setConfirm({
      targets: [target],
      title: scope === 'workspace' ? '清空这个项目的工作区？' : '删除整包归档？',
      detail: scope === 'workspace'
        ? 'inbox、exports 和 scratch 中的文件将被永久删除，项目和对话会保留。'
        : '归档包及其中全部文件将被永久删除。',
      bytes: group.sizeBytes,
    });
  };

  const performDelete = async () => {
    if (!confirm) return;
    setDeleting(true);
    try {
      const response = await authenticatedFetch('/api/storage/delete', {
        method: 'POST',
        body: JSON.stringify({ targets: confirm.targets }),
      });
      const body = await response.json().catch(() => ({})) as {
        error?: string;
        failed?: Array<{ error: string }>;
        snapshot?: StorageSnapshot;
      };
      if (!response.ok && response.status !== 207) {
        throw new Error(body.error || `删除失败（${response.status}）`);
      }
      if (body.snapshot) setSnapshot(body.snapshot);
      setSelected(new Map());
      setConfirm(null);
      if (body.failed?.length) {
        setNotice({
          kind: 'error',
          text: `部分文件未能删除：${body.failed.map((item) => item.error).join('；')}`,
        });
      } else {
        setNotice({ kind: 'success', text: '已删除，存储占用已更新。' });
      }
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message });
    } finally {
      setDeleting(false);
    }
  };

  const openPreview = async (
    scope: StorageScope,
    group: WorkspaceGroup | ArchiveGroup,
    file: StorageFile,
  ) => {
    if (!file.previewKind) return;
    setPreview({
      title: file.name,
      kind: file.previewKind,
      loading: true,
      content: null,
      objectUrl: null,
      truncated: false,
      error: null,
    });
    try {
      const params = new URLSearchParams({
        scope,
        groupId: group.id,
        path: file.path,
        ...('typeKey' in group ? { typeKey: group.typeKey } : {}),
      });
      const response = await authenticatedFetch(`/api/storage/preview?${params}`);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `预览失败（${response.status}）`);
      }
      if (file.previewKind === 'text') {
        const content = await response.text();
        setPreview((current) => current ? {
          ...current,
          loading: false,
          content,
          truncated: response.headers.get('X-Preview-Truncated') === 'true',
        } : current);
      } else {
        const objectUrl = URL.createObjectURL(await response.blob());
        setPreview((current) => current ? { ...current, loading: false, objectUrl } : current);
      }
    } catch (error) {
      setPreview((current) => current
        ? { ...current, loading: false, error: (error as Error).message }
        : current);
    }
  };

  const workspaceShare = snapshot.totals.totalBytes > 0
    ? (snapshot.totals.workspaceBytes / snapshot.totals.totalBytes) * 100
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-50/60 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="shrink-0 border-b border-neutral-200 bg-white px-6 py-5 dark:border-neutral-800 dark:bg-neutral-950">
        <div className="mx-auto flex max-w-6xl flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-blue-600 dark:text-blue-400">
              <HardDrive className="h-3.5 w-3.5" />
              磁盘管理
            </div>
            <h1 className="text-xl font-semibold tracking-tight">工作区存储</h1>
            <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
              查看在用项目与已删除项目归档占用，按需清理本机文件。
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm font-medium shadow-sm transition hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:bg-neutral-800"
          >
            <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
            重新计算
          </button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-6xl">
          <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <div className="grid gap-px bg-neutral-200 dark:bg-neutral-800 sm:grid-cols-3">
              {[
                { label: '总占用', bytes: snapshot.totals.totalBytes, icon: <HardDrive className="h-4 w-4" /> },
                { label: '在用工作区', bytes: snapshot.totals.workspaceBytes, icon: <FolderOpen className="h-4 w-4" /> },
                { label: '归档残留', bytes: snapshot.totals.archiveBytes, icon: <Archive className="h-4 w-4" /> },
              ].map(({ label, bytes, icon }) => (
                <div key={label} className="bg-white px-5 py-4 dark:bg-neutral-900">
                  <div className="flex items-center gap-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    {icon}
                    {label}
                  </div>
                  <div className="mt-2 font-mono text-2xl font-semibold tracking-tight">
                    {formatBytes(bytes)}
                  </div>
                </div>
              ))}
            </div>
            <div className="flex h-1.5 w-full bg-amber-400/80 dark:bg-amber-500/70" aria-label="在用与归档占用比例">
              <div className="bg-blue-600 transition-[width]" style={{ width: `${workspaceShare}%` }} />
            </div>
          </section>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex rounded-lg bg-neutral-200/70 p-1 dark:bg-neutral-800">
              {([
                ['workspace', '在用', snapshot.workspaces.length],
                ['archive', '归档', snapshot.archives.length],
              ] as const).map(([scope, label, count]) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => {
                    setActiveScope(scope);
                    setQuery('');
                  }}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-sm font-medium transition',
                    activeScope === scope
                      ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                      : 'text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-white',
                  )}
                >
                  {label}
                  <span className="ml-1.5 font-mono text-xs text-neutral-400">{count}</span>
                </button>
              ))}
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
              <label className="relative min-w-52 max-w-sm flex-1">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-neutral-400" />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索项目、归档或文件"
                  className="h-9 w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-3 text-sm outline-none transition placeholder:text-neutral-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-blue-600"
                />
              </label>
              <button
                type="button"
                onClick={requestSelectedDelete}
                disabled={selected.size === 0}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-red-600 px-3 text-sm font-medium text-white transition hover:bg-red-700 disabled:bg-neutral-200 disabled:text-neutral-400 dark:disabled:bg-neutral-800"
              >
                <Trash2 className="h-4 w-4" />
                删除选中
                {selected.size > 0 ? ` · ${selected.size} / ${formatBytes(selectedBytes)}` : ''}
              </button>
            </div>
          </div>

          {notice ? (
            <div className={cn(
              'mt-4 flex items-center justify-between rounded-lg border px-3 py-2 text-sm',
              notice.kind === 'error'
                ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
            )}>
              <span>{notice.text}</span>
              <button type="button" onClick={() => setNotice(null)} aria-label="关闭提示">
                <X className="h-4 w-4" />
              </button>
            </div>
          ) : null}

          <section className="mt-4 space-y-3 pb-8">
            {loading ? (
              <div className="flex min-h-52 items-center justify-center text-sm text-neutral-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在计算磁盘占用…
              </div>
            ) : filteredGroups.length === 0 ? (
              <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-neutral-300 bg-white/70 text-center dark:border-neutral-700 dark:bg-neutral-900/60">
                {activeScope === 'workspace'
                  ? <FolderOpen className="mb-3 h-8 w-8 text-neutral-300 dark:text-neutral-600" />
                  : <Archive className="mb-3 h-8 w-8 text-neutral-300 dark:text-neutral-600" />}
                <p className="text-sm font-medium">{query ? '没有匹配项' : '这里还没有文件'}</p>
                <p className="mt-1 text-xs text-neutral-500">
                  {query ? '换一个项目名、归档名或文件名试试。' : '产生文件后，占用会显示在这里。'}
                </p>
              </div>
            ) : filteredGroups.map((group) => {
              const scope = activeScope;
              const open = expanded.has(group.id);
              const targets = group.files.map((file) => fileTarget(scope, group, file));
              const archiveTarget = scope === 'archive'
                ? archiveGroupTarget(group as ArchiveGroup)
                : null;
              const allSelected = archiveTarget
                ? selected.has(targetKey(archiveTarget))
                : targets.length > 0
                  && targets.every((target) => selected.has(targetKey(target)));
              const groupDeleteDisabled = scope === 'workspace' && group.files.length === 0;
              const bySection = new Map<string, StorageFile[]>();
              group.files.forEach((file) => {
                const section = file.path.split('/')[0] || 'files';
                bySection.set(section, [...(bySection.get(section) ?? []), file]);
              });
              const title = scope === 'workspace'
                ? (group as WorkspaceGroup).displayName
                : group.id;

              return (
                <article key={`${scope}:${group.id}`} className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                  <div className="flex items-center gap-3 px-4 py-3">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => toggleGroupSelection(scope, group)}
                      disabled={groupDeleteDisabled}
                      aria-label={scope === 'archive'
                        ? `选择归档 ${title} 整包`
                        : `选择 ${title} 的全部文件`}
                      className="h-4 w-4 rounded border-neutral-300 accent-blue-600"
                    />
                    <button
                      type="button"
                      onClick={() => setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(group.id)) next.delete(group.id);
                        else next.add(group.id);
                        return next;
                      })}
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      {open
                        ? <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" />
                        : <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-semibold">{title}</span>
                        <span className="mt-0.5 block truncate text-xs text-neutral-500 dark:text-neutral-400">
                          {scope === 'workspace'
                            ? `${projectTypeLabel((group as WorkspaceGroup).projectType)} · ${group.projectId}`
                            : `${group.projectId} · ${formatArchiveTime((group as ArchiveGroup).archivedAt)}`}
                        </span>
                      </span>
                    </button>
                    <span className="shrink-0 font-mono text-sm font-medium">{formatBytes(group.sizeBytes)}</span>
                    <button
                      type="button"
                      onClick={() => requestGroupDelete(scope, group)}
                      disabled={groupDeleteDisabled}
                      className="rounded-md p-2 text-neutral-400 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-30 dark:hover:bg-red-950/40 dark:hover:text-red-400"
                      aria-label={scope === 'workspace' ? `清空 ${title} 工作区` : `删除归档 ${title}`}
                      title={scope === 'workspace' ? '清空工作区文件' : '删除整包归档'}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>

                  {open ? (
                    <div className="border-t border-neutral-100 dark:border-neutral-800">
                      {group.files.length === 0 ? (
                        <div className="px-12 py-5 text-sm text-neutral-400">
                          {scope === 'workspace' ? '工作区为空' : '归档文件夹为空，可删除整包归档'}
                        </div>
                      ) : [...bySection.entries()].map(([section, files]) => (
                        <div key={section}>
                          <div className="border-b border-neutral-100 bg-neutral-50 px-12 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-neutral-400 dark:border-neutral-800 dark:bg-neutral-950/40">
                            {section} · {files.length}
                          </div>
                          {files.map((file) => {
                            const target = fileTarget(scope, group, file);
                            const key = targetKey(target);
                            return (
                              <div key={file.path} className="flex items-center gap-3 border-b border-neutral-100 px-4 py-2.5 last:border-0 dark:border-neutral-800">
                                <input
                                  type="checkbox"
                                  checked={selected.has(key)}
                                  onChange={() => toggleFile(target)}
                                  aria-label={`选择 ${file.name}`}
                                  className="h-4 w-4 rounded border-neutral-300 accent-blue-600"
                                />
                                <span className="text-neutral-400"><FileKindIcon kind={file.previewKind} /></span>
                                <button
                                  type="button"
                                  disabled={!file.previewKind}
                                  onClick={() => void openPreview(scope, group, file)}
                                  className={cn(
                                    'min-w-0 flex-1 text-left',
                                    file.previewKind && 'group cursor-pointer',
                                  )}
                                  title={file.previewKind ? '点击预览' : '此类型暂不支持预览'}
                                >
                                  <span className={cn(
                                    'block truncate text-sm',
                                    file.previewKind && 'group-hover:text-blue-600 dark:group-hover:text-blue-400',
                                  )}>
                                    {file.name}
                                  </span>
                                  <span className="block truncate font-mono text-[11px] text-neutral-400">{file.path}</span>
                                </button>
                                <span className="shrink-0 font-mono text-xs text-neutral-500">{formatBytes(file.sizeBytes)}</span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </section>
        </div>
      </main>

      {confirm ? (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm">
          <div role="alertdialog" aria-modal="true" aria-labelledby="storage-delete-title" className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400">
              <Trash2 className="h-5 w-5" />
            </div>
            <h2 id="storage-delete-title" className="mt-4 text-base font-semibold">{confirm.title}</h2>
            <p className="mt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-300">{confirm.detail}</p>
            <div className="mt-4 rounded-lg bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-800">
              预计释放 <span className="font-mono font-semibold">{formatBytes(confirm.bytes)}</span>
            </div>
            <p className="mt-3 text-xs font-medium text-red-600 dark:text-red-400">此操作不可恢复。</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirm(null)} disabled={deleting} className="h-9 rounded-lg border border-neutral-200 px-4 text-sm font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-800">
                取消
              </button>
              <button type="button" onClick={() => void performDelete()} disabled={deleting} className="inline-flex h-9 items-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-60">
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                永久删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" onMouseDown={() => setPreview(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="storage-preview-title" className="flex h-[min(82vh,760px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-neutral-900" onMouseDown={(event) => event.stopPropagation()}>
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 px-4 dark:border-neutral-800">
              <div className="min-w-0">
                <h2 id="storage-preview-title" className="truncate text-sm font-semibold">{preview.title}</h2>
                {preview.truncated ? <p className="text-[11px] text-amber-600">文件较大，仅显示前 512 KB</p> : null}
              </div>
              <button type="button" onClick={() => setPreview(null)} className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label="关闭预览">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-neutral-100 dark:bg-neutral-950">
              {preview.loading ? (
                <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />正在载入预览…
                </div>
              ) : preview.error ? (
                <div className="flex h-full items-center justify-center p-8 text-sm text-red-600">{preview.error}</div>
              ) : preview.kind === 'text' ? (
                <pre className="min-h-full whitespace-pre-wrap break-words bg-white p-5 font-mono text-xs leading-6 text-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">{preview.content}</pre>
              ) : preview.kind === 'image' && preview.objectUrl ? (
                <div className="flex min-h-full items-center justify-center p-5">
                  <img src={preview.objectUrl} alt={preview.title} className="max-h-full max-w-full rounded shadow-lg" />
                </div>
              ) : preview.objectUrl ? (
                <iframe src={preview.objectUrl} title={preview.title} className="h-full min-h-[60vh] w-full bg-white" />
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
