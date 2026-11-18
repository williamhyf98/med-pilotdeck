import { lazy, Suspense, useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  ChevronRight,
  Eraser,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  HardDrive,
  Inbox,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { api, authenticatedFetch } from '../../utils/api';
import { cn } from '../../lib/utils.js';
import { WORKSPACE_FILE_MENTION_DRAG_MIME } from '../../utils/workspaceFileMention';
import {
  WorkspaceDeleteDialog,
  WorkspaceFileContextMenu,
  type WorkspaceActionEntry,
} from './WorkspaceFileActions';

const CodeEditorBinaryFile = lazy(() => import('../code-editor/view/subcomponents/CodeEditorBinaryFile'));

/**
 * 存储页（设置 → 存储）= **项目视角**（2026-11-12 重构）。
 *
 * 这一页只回答两个问题：
 *   1. 每个在用项目占了多少磁盘？（总量 / exports / inbox / scratch / 回收站 / 会话数）
 *   2. 想收空间时，整个项目怎么删？（真删，不可恢复，所以要手打项目名确认）
 *
 * 刻意不做的事：
 *   - 不再有「归档」tab —— 项目归档已下线，删项目就是物理删除；
 *   - 文件级删除和下载使用与工作区页相同的接口和回收站语义。
 *   唯一的例外是**只读预览**：排查「这 300 MB 到底是什么」时，总得能点开看一眼。
 */

type PreviewKind = 'image' | 'pdf' | 'office' | 'text' | 'none';

type StorageUsage = {
  inboxBytes: number;
  exportsBytes: number;
  scratchBytes: number;
  totalBytes: number;
};

type StorageProject = {
  id: string;
  displayName: string;
  projectType: 'general_medicine' | 'war_trauma';
  typeKey: string;
  sizeBytes: number;
  usage?: StorageUsage;
  trashBytes?: number;
  trashCount?: number;
  sessionCount?: number;
  lastActivityAt?: string | null;
  files: Array<{ path: string; name: string; sizeBytes: number }>;
};

type StorageSortKey = 'project' | 'type' | 'sessionCount' | 'sizeBytes' | 'trashCount' | 'lastActivityAt';
type StorageSortDirection = 'asc' | 'desc';
type StorageSort = {
  key: StorageSortKey;
  direction: StorageSortDirection;
};

type StorageSnapshot = {
  totals: {
    totalBytes: number;
    workspaceBytes: number;
    trashBytes?: number;
    projectCount?: number;
  };
  projects: StorageProject[];
};

type PreviewState = {
  title: string;
  path: string;
  projectName: string;
  kind: PreviewKind;
  loading: boolean;
  text: string | null;
  truncated: boolean;
  error: string | null;
} | null;

type WorkspaceEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number | null;
  modified: string | null;
};

type DirectoryListing = {
  entries: WorkspaceEntry[];
  truncated: boolean;
};

function treeKey(projectId: string, relativePath: string): string {
  return `${projectId}:${relativePath}`;
}

type StorageTreeBranchProps = {
  projectId: string;
  projectName?: string;
  entries: WorkspaceEntry[];
  depth: number;
  expandedPaths: Set<string>;
  loadingPaths: Set<string>;
  listings: Record<string, DirectoryListing>;
  onToggleDirectory: (entry: WorkspaceEntry) => void;
  onPreview: (entry: WorkspaceEntry) => void;
  onContextMenu: (event: MouseEvent, entry: WorkspaceEntry) => void;
};

function StorageTreeBranch({
  projectId,
  projectName,
  entries,
  depth,
  expandedPaths,
  loadingPaths,
  listings,
  onToggleDirectory,
  onPreview,
  onContextMenu,
}: StorageTreeBranchProps) {
  return (
    <>
      {entries.map((entry) => {
        const isDirectory = entry.type === 'directory';
        const entryKey = treeKey(projectId, entry.path);
        const open = isDirectory && expandedPaths.has(entryKey);
        const listing = listings[entryKey];
        const loading = loadingPaths.has(entryKey);
        const kind = isDirectory ? null : previewKindOf(entry.name);
        return (
          <div key={entry.path}>
            <button
              type="button"
              draggable
              onDragStart={(event) => {
                event.stopPropagation();
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.setData(
                  WORKSPACE_FILE_MENTION_DRAG_MIME,
                  JSON.stringify({
                    projectName: projectName || projectId,
                    relativePath: entry.path,
                    kind: entry.type,
                  }),
                );
                event.dataTransfer.setData('text/plain', entry.path);
              }}
              onClick={() => (isDirectory ? onToggleDirectory(entry) : onPreview(entry))}
              onContextMenu={(event) => onContextMenu(event, entry)}
              aria-expanded={isDirectory ? open : undefined}
              title={isDirectory ? entry.path : entry.name}
              className="group flex w-full items-center gap-1.5 rounded-md py-1.5 pr-3 text-left transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800/60"
              style={{ paddingLeft: 12 + depth * 18 }}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-400">
                {isDirectory
                  ? <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
                  : null}
              </span>
              <span className={cn(
                'shrink-0',
                isDirectory ? 'text-amber-500' : 'text-neutral-400',
              )}
              >
                {isDirectory
                  ? <FolderIcon name={entry.name} open={open} />
                  : <FileKindIcon name={entry.name} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn(
                  'block truncate text-sm leading-5',
                  !isDirectory && kind !== 'none' && 'group-hover:text-blue-600 dark:group-hover:text-blue-400',
                )}>
                  {entry.name}
                </span>
                <span className="block truncate text-[10px] leading-4 text-neutral-400">
                  {isDirectory
                    ? (open ? `${listing?.entries.length ?? ''} 项` : '目录')
                    : formatBytes(entry.size ?? 0)}
                  {entry.modified ? ` · ${formatWhen(entry.modified)}` : ''}
                </span>
              </span>
              {loading ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" /> : null}
            </button>
            {open ? (
              listing ? (
                listing.entries.length > 0 ? (
                  <>
                    <StorageTreeBranch
                      projectId={projectId}
                      projectName={projectName}
                      entries={listing.entries}
                      depth={depth + 1}
                      expandedPaths={expandedPaths}
                      loadingPaths={loadingPaths}
                      listings={listings}
                      onToggleDirectory={onToggleDirectory}
                      onPreview={onPreview}
                      onContextMenu={onContextMenu}
                    />
                    {listing.truncated ? (
                      <p
                        className="py-1 text-[10px] text-neutral-400"
                        style={{ paddingLeft: 42 + depth * 18 }}
                      >
                        仅显示前 500 项，完整内容请下载
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p
                    className="py-1 text-[10px] text-neutral-400"
                    style={{ paddingLeft: 42 + depth * 18 }}
                  >
                    空目录
                  </p>
                )
              ) : null
            ) : null}
          </div>
        );
      })}
    </>
  );
}

const EMPTY_SNAPSHOT: StorageSnapshot = {
  totals: { totalBytes: 0, workspaceBytes: 0, trashBytes: 0, projectCount: 0 },
  projects: [],
};

const DEFAULT_STORAGE_SORT: StorageSort = {
  key: 'lastActivityAt',
  direction: 'desc',
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'wps', 'ppt', 'pptx', 'dps', 'xls', 'xlsx', 'et', 'odt', 'odp', 'ods']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'csv', 'tsv',
  'log', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'sh', 'sql',
]);
const MAX_TEXT_PREVIEW_CHARS = 200_000;

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / (1024 ** index);
  return `${scaled >= 100 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function projectTypeLabel(type: StorageProject['projectType']): string {
  return type === 'war_trauma' ? '战创伤医学' : '通用医学';
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function compareProjectNames(
  left: StorageProject,
  right: StorageProject,
  collator: Intl.Collator,
): number {
  // Keep Latin names before Chinese names, then let the locale collator
  // handle English letters and Chinese pinyin within each group.
  const leftStartsWithLatin = /^[A-Za-z0-9]/.test(left.displayName);
  const rightStartsWithLatin = /^[A-Za-z0-9]/.test(right.displayName);
  if (leftStartsWithLatin !== rightStartsWithLatin) {
    return leftStartsWithLatin ? -1 : 1;
  }
  return collator.compare(left.displayName, right.displayName)
    || collator.compare(left.id, right.id);
}

function compareStorageProjects(
  left: StorageProject,
  right: StorageProject,
  key: StorageSortKey,
  collator: Intl.Collator,
): number {
  if (key === 'project') {
    return compareProjectNames(left, right, collator);
  }
  if (key === 'type') {
    return collator.compare(projectTypeLabel(left.projectType), projectTypeLabel(right.projectType))
      || collator.compare(left.displayName, right.displayName);
  }
  if (key === 'sessionCount') {
    return (left.sessionCount ?? 0) - (right.sessionCount ?? 0);
  }
  if (key === 'sizeBytes') {
    return left.sizeBytes - right.sizeBytes;
  }
  if (key === 'trashCount') {
    return (left.trashCount ?? 0) - (right.trashCount ?? 0);
  }

  const leftTime = left.lastActivityAt ? new Date(left.lastActivityAt).getTime() : 0;
  const rightTime = right.lastActivityAt ? new Date(right.lastActivityAt).getTime() : 0;
  return (Number.isFinite(leftTime) ? leftTime : 0)
    - (Number.isFinite(rightTime) ? rightTime : 0);
}

function sortDirectionLabel(direction: StorageSortDirection): string {
  return direction === 'asc' ? '升序' : '降序';
}

function SortableHeader({
  label,
  sortKey,
  activeSort,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: StorageSortKey;
  activeSort: StorageSort;
  onSort: (key: StorageSortKey) => void;
  align?: 'left' | 'right';
}) {
  const active = activeSort.key === sortKey;
  const direction = activeSort.direction;
  const Icon = active ? (direction === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  const directionText = active ? `，当前${sortDirectionLabel(direction)}` : '，点击排序';
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn(
        'inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 transition hover:text-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:text-neutral-400 dark:hover:text-neutral-100',
        align === 'right' && 'ml-auto justify-end',
      )}
      aria-label={`${label}${directionText}`}
      title={`按${label}${active ? `（${sortDirectionLabel(direction)}）` : ''}排序`}
    >
      <span>{label}</span>
      <Icon className={cn('h-3.5 w-3.5 shrink-0', active && 'text-blue-600 dark:text-blue-400')} strokeWidth={2} />
    </button>
  );
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error || `请求失败（${response.status}）`);
  }
  return body as T;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index + 1).toLowerCase() : '';
}

function previewKindOf(name: string): PreviewKind {
  const extension = extensionOf(name);
  if (IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension === 'pdf') return 'pdf';
  if (OFFICE_EXTENSIONS.has(extension)) return 'office';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return 'none';
}

function FileKindIcon({ name }: { name: string }) {
  const kind = previewKindOf(name);
  if (kind === 'image') return <FileImage className="h-4 w-4" />;
  if (kind === 'office') return <FileSpreadsheet className="h-4 w-4" />;
  if (kind === 'text' || kind === 'pdf') return <FileText className="h-4 w-4" />;
  return <File className="h-4 w-4" />;
}

function FolderIcon({ name, open = false }: { name: string; open?: boolean }) {
  if (name === 'inbox') return <Inbox className="h-4 w-4" />;
  if (name === 'scratch') return <Eraser className="h-4 w-4" />;
  if (open) return <FolderOpen className="h-4 w-4" />;
  if (name === 'exports') return <FolderOpen className="h-4 w-4" />;
  return <Folder className="h-4 w-4" />;
}

export default function StorageV2() {
  const [snapshot, setSnapshot] = useState<StorageSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sort, setSort] = useState<StorageSort>(DEFAULT_STORAGE_SORT);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [listings, setListings] = useState<Record<string, DirectoryListing>>({});
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewState>(null);
  const [previewFullscreen, setPreviewFullscreen] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<StorageProject | null>(null);
  const [typedName, setTypedName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    project: StorageProject;
    entry: WorkspaceActionEntry;
    x: number;
    y: number;
  } | null>(null);
  const [deleteFileTarget, setDeleteFileTarget] = useState<{
    project: StorageProject;
    entry: WorkspaceActionEntry;
  } | null>(null);
  const [deletingFile, setDeletingFile] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/storage');
      const data = await readJson<StorageSnapshot>(response);
      setSnapshot({ ...data, projects: data.projects ?? [] });
      setExpanded(new Set());
      setListings({});
      setExpandedPaths(new Set());
      setLoadingPaths(new Set());
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const projects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const filtered = !normalized
      ? snapshot.projects
      : snapshot.projects.filter((project) => (
      `${project.displayName} ${project.id}`.toLocaleLowerCase().includes(normalized)
      || project.files.some((file) => file.path.toLocaleLowerCase().includes(normalized))
      ));
    const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
    const direction = sort.direction === 'asc' ? 1 : -1;
    return filtered
      .map((project, index) => ({ project, index }))
      .sort((left, right) => (
        direction * compareStorageProjects(left.project, right.project, sort.key, collator)
        || left.index - right.index
      ))
      .map(({ project }) => project);
  }, [query, snapshot.projects, sort]);

  const toggleSort = useCallback((key: StorageSortKey) => {
    setSort((current) => (
      current.key === key
        ? {
            key,
            direction: current.direction === 'asc' ? 'desc' : 'asc',
          }
        : {
            key,
            direction: key === 'lastActivityAt' ? 'desc' : 'asc',
          }
    ));
  }, []);

  const workspaceProjectName = useCallback((project: StorageProject) => project.id, []);

  const loadDirectory = useCallback(async (project: StorageProject, relativePath: string) => {
    const key = treeKey(project.id, relativePath);
    if (listings[key] || loadingPaths.has(key)) return;
    setLoadingPaths((current) => new Set(current).add(key));
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(workspaceProjectName(project))}/files/list?path=${encodeURIComponent(relativePath)}`,
      );
      const data = await readJson<DirectoryListing>(response);
      setListings((current) => ({
        ...current,
        [key]: { entries: data.entries ?? [], truncated: Boolean(data.truncated) },
      }));
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message });
    } finally {
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    }
  }, [listings, loadingPaths, workspaceProjectName]);

  const toggleDirectory = useCallback((project: StorageProject, entry: WorkspaceEntry) => {
    const key = treeKey(project.id, entry.path);
    const shouldOpen = !expandedPaths.has(key);
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (shouldOpen) void loadDirectory(project, entry.path);
  }, [expandedPaths, loadDirectory]);

  const openPreview = useCallback(async (project: StorageProject, entry: WorkspaceEntry) => {
    const kind = previewKindOf(entry.name);
    const projectName = workspaceProjectName(project);
    setPreviewFullscreen(false);
    if (kind === 'none') {
      setPreview({
        title: entry.name,
        path: entry.path,
        projectName,
        kind,
        loading: false,
        text: null,
        truncated: false,
        error: '这个文件类型暂不支持预览，可下载或直接在编辑器中打开。',
      });
      return;
    }
    setPreview({
      title: entry.name,
      path: entry.path,
      projectName,
      kind,
      loading: kind === 'text',
      text: null,
      truncated: false,
      error: null,
    });
    if (kind !== 'text') return;
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/file?filePath=${encodeURIComponent(entry.path)}`,
      );
      const data = await readJson<{ content?: string }>(response);
      const content = data.content ?? '';
      setPreview((current) => current?.path === entry.path ? {
          ...current,
          loading: false,
          text: content.slice(0, MAX_TEXT_PREVIEW_CHARS),
          truncated: content.length > MAX_TEXT_PREVIEW_CHARS,
        } : current);
    } catch (error) {
      setPreview((current) => current?.path === entry.path
        ? { ...current, loading: false, error: (error as Error).message }
        : current);
    }
  }, [workspaceProjectName]);

  const closePreview = useCallback(() => {
    setPreview(null);
    setPreviewFullscreen(false);
  }, []);

  const isProtectedRoot = useCallback((entry: WorkspaceEntry) => (
    entry.type === 'directory'
    && !entry.path.includes('/')
    && ['exports', 'inbox', 'scratch'].includes(entry.name)
  ), []);

  const openContextMenu = useCallback((
    project: StorageProject,
    event: MouseEvent,
    entry: WorkspaceEntry,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    if (isProtectedRoot(entry)) {
      setContextMenu(null);
      return;
    }
    setContextMenu({
      project,
      entry: { name: entry.name, path: entry.path, type: entry.type },
      x: event.clientX,
      y: event.clientY,
    });
  }, [isProtectedRoot]);

  const downloadEntry = useCallback(async (project: StorageProject, entry: WorkspaceActionEntry) => {
    const anchor = document.createElement('a');
    if (entry.type === 'file') {
      anchor.href = api.fileDownloadUrl(project.id, entry.path);
      anchor.download = entry.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      return;
    }

    const response = await authenticatedFetch(
      api.workspaceDirectoryDownloadUrl(project.id, entry.path),
      { suppressServerErrorToast: true },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `目录下载失败（${response.status}）`);
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/zip')) {
      throw new Error('服务器返回的不是有效 ZIP 文件');
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    anchor.href = objectUrl;
    anchor.download = `${entry.name}.zip`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }, []);

  const trashFileEntry = useCallback(async (
    project: StorageProject,
    entry: WorkspaceActionEntry,
  ) => {
    setDeletingFile(true);
    setNotice(null);
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(project.id)}/files/trash`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: entry.path }),
        },
      );
      await readJson(response);
      setDeleteFileTarget(null);
      setContextMenu(null);
      if (preview?.projectName === project.id
        && (preview.path === entry.path || preview.path.startsWith(`${entry.path}/`))) {
        closePreview();
      }
      setNotice({ kind: 'success', text: `已移入回收站：${entry.path}` });
      await refresh();
    } catch (error) {
      setNotice({ kind: 'error', text: (error as Error).message });
    } finally {
      setDeletingFile(false);
    }
  }, [closePreview, preview, refresh]);

  const requestDelete = (project: StorageProject) => {
    setDeleteError(null);
    setTypedName('');
    setDeleteTarget(project);
  };

  const closeDelete = () => {
    if (deleting) return;
    setDeleteTarget(null);
    setTypedName('');
    setDeleteError(null);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleting(true);
    setDeleteError(null);
    try {
      const params = new URLSearchParams({ force: 'true', confirmName: typedName.trim() });
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(target.id)}?${params}`,
        { method: 'DELETE' },
      );
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        throw new Error(body.error || `删除失败（${response.status}）`);
      }
      setDeleteTarget(null);
      setTypedName('');
      setNotice({
        kind: 'success',
        text: `已永久删除「${target.displayName}」，释放 ${formatBytes(target.sizeBytes + (target.trashBytes ?? 0))}。`,
      });
      await refresh();
    } catch (error) {
      setDeleteError((error as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const totalBytes = snapshot.totals.totalBytes ?? 0;
  const workspaceBytes = snapshot.totals.workspaceBytes ?? 0;
  const trashBytes = snapshot.totals.trashBytes ?? 0;
  const projectCount = snapshot.totals.projectCount ?? snapshot.projects.length;
  const workspaceShare = totalBytes > 0 ? (workspaceBytes / totalBytes) * 100 : 0;

  const matchesName = Boolean(
    deleteTarget && typedName.trim() === deleteTarget.displayName.trim(),
  );

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
              按项目查看占用，可只读预览文件，或永久删除整个项目（不可恢复）。
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
            <div className="grid gap-px bg-neutral-200 dark:bg-neutral-800 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: '总占用', value: formatBytes(totalBytes), icon: <HardDrive className="h-4 w-4" /> },
                { label: '当前文件', value: formatBytes(workspaceBytes), icon: <FolderOpen className="h-4 w-4" /> },
                {
                  label: '回收站',
                  value: formatBytes(trashBytes),
                  icon: <Trash2 className="h-4 w-4" />,
                  hint: '仍在磁盘上，7 天后自动释放',
                },
                {
                  label: '在用项目',
                  value: `${projectCount} 个`,
                  icon: <FolderOpen className="h-4 w-4" />,
                  hint: '删除项目 = 直接物理删除',
                },
              ].map(({ label, value, icon, hint }) => (
                <div key={label} className="bg-white px-5 py-4 dark:bg-neutral-900">
                  <div className="flex items-center gap-2 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    {icon}
                    {label}
                  </div>
                  <div className="mt-2 font-mono text-2xl font-semibold tracking-tight">{value}</div>
                  {hint ? (
                    <div className="mt-1 text-[11px] leading-4 text-neutral-400 dark:text-neutral-500">{hint}</div>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="flex h-1.5 w-full bg-amber-400/80 dark:bg-amber-500/70" aria-label="当前文件与回收站占用比例">
              <div className="bg-blue-600 transition-[width]" style={{ width: `${workspaceShare}%` }} />
            </div>
          </section>

          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-medium text-neutral-600 dark:text-neutral-300">
              项目清单
              <span className="ml-1.5 font-mono text-xs text-neutral-400">{projects.length}</span>
            </div>
            <label className="relative min-w-56 max-w-sm flex-1 sm:flex-none">
              <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-neutral-400" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索项目名或文件"
                className="h-9 w-full rounded-lg border border-neutral-200 bg-white pl-9 pr-3 text-sm outline-none transition placeholder:text-neutral-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-500/10 dark:border-neutral-700 dark:bg-neutral-900 dark:focus:border-blue-600"
              />
            </label>
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

          <section className="mt-4 pb-8">
            {loading ? (
              <div className="flex min-h-52 items-center justify-center text-sm text-neutral-500">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                正在计算磁盘占用…
              </div>
            ) : projects.length === 0 ? (
              <div className="flex min-h-52 flex-col items-center justify-center rounded-2xl border border-dashed border-neutral-300 bg-white/70 text-center dark:border-neutral-700 dark:bg-neutral-900/60">
                <FolderOpen className="mb-3 h-8 w-8 text-neutral-300 dark:text-neutral-600" />
                <p className="text-sm font-medium">{query ? '没有匹配的项目' : '还没有项目'}</p>
                <p className="mt-1 text-xs text-neutral-500">
                  {query ? '换一个项目名或文件名试试。' : '创建项目并产生文件后，占用会显示在这里。'}
                </p>
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                <div className="hidden min-w-0 grid-cols-[minmax(0,1fr)_92px_72px_96px_104px_136px_168px] gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 dark:border-neutral-800 dark:bg-neutral-950/40 md:grid">
                  <SortableHeader label="项目" sortKey="project" activeSort={sort} onSort={toggleSort} />
                  <SortableHeader label="类型" sortKey="type" activeSort={sort} onSort={toggleSort} />
                  <SortableHeader label="会话" sortKey="sessionCount" activeSort={sort} onSort={toggleSort} align="right" />
                  <SortableHeader label="占用" sortKey="sizeBytes" activeSort={sort} onSort={toggleSort} align="right" />
                  <SortableHeader label="回收站" sortKey="trashCount" activeSort={sort} onSort={toggleSort} align="right" />
                  <SortableHeader label="最后活动" sortKey="lastActivityAt" activeSort={sort} onSort={toggleSort} align="right" />
                  <span className="text-right">操作</span>
                </div>

                {projects.map((project) => {
                  const open = expanded.has(project.id);
                  const rootKey = treeKey(project.id, '');
                  const rootListing = listings[rootKey];
                  const rootLoading = loadingPaths.has(rootKey);
                  return (
                    <div key={`${project.typeKey}:${project.id}`} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
                      <div className="grid min-w-0 grid-cols-1 gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_92px_72px_96px_104px_136px_168px] md:items-center md:gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            const nextOpen = !expanded.has(project.id);
                            setExpanded((current) => {
                              const next = new Set(current);
                              if (nextOpen) next.add(project.id);
                              else next.delete(project.id);
                              return next;
                            });
                            if (nextOpen) void loadDirectory(project, '');
                          }}
                          className="flex min-w-0 items-center gap-2 text-left"
                          aria-expanded={open}
                        >
                          {open
                            ? <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" />
                            : <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />}
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{project.displayName}</span>
                          </span>
                        </button>
                        <span className="text-xs text-neutral-500 md:text-sm md:text-neutral-600 dark:md:text-neutral-300">
                          {projectTypeLabel(project.projectType)}
                        </span>
                        <span className="font-mono text-xs text-neutral-500 md:text-right">{project.sessionCount ?? 0}</span>
                        <span className="font-mono text-sm font-medium md:text-right">{formatBytes(project.sizeBytes)}</span>
                        <span className="font-mono text-xs text-neutral-500 md:text-right">
                          {project.trashCount ? `${project.trashCount} 个` : '—'}
                        </span>
                        <span className="text-xs text-neutral-500 md:text-right">{formatWhen(project.lastActivityAt)}</span>
                        <span className="flex items-center gap-2 md:justify-end">
                          <button
                            type="button"
                            onClick={() => {
                              setExpanded((current) => new Set(current).add(project.id));
                              void loadDirectory(project, '');
                            }}
                            className="inline-flex h-8 items-center rounded-md border border-neutral-200 px-2.5 text-xs font-medium text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                          >
                            查看
                          </button>
                          <button
                            type="button"
                            onClick={() => requestDelete(project)}
                            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-red-200 px-2.5 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            删除项目
                          </button>
                        </span>
                      </div>

                      {open ? (
                        <div className="border-t border-neutral-100 bg-neutral-50/60 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950/30">
                          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                            <span>exports {formatBytes(project.usage?.exportsBytes ?? 0)}</span>
                            <span>inbox {formatBytes(project.usage?.inboxBytes ?? 0)}</span>
                            <span>scratch {formatBytes(project.usage?.scratchBytes ?? 0)}</span>
                            <span>回收站 {formatBytes(project.trashBytes ?? 0)}（{project.trashCount ?? 0} 个文件）</span>
                            <span className="text-neutral-400">预览只读；要删单个文件请去工作区页的回收站</span>
                          </div>
                          <div className="overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
                            {!rootListing && rootLoading ? (
                              <div className="flex items-center gap-2 px-3 py-4 text-xs text-neutral-400">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                正在读取目录…
                              </div>
                            ) : rootListing?.entries.length ? (
                              <StorageTreeBranch
                                projectId={project.id}
                                projectName={project.id}
                                entries={rootListing.entries}
                                depth={0}
                                expandedPaths={expandedPaths}
                                loadingPaths={loadingPaths}
                                listings={listings}
                                onToggleDirectory={(entry) => toggleDirectory(project, entry)}
                                onPreview={(entry) => void openPreview(project, entry)}
                                onContextMenu={(event, entry) => openContextMenu(project, event, entry)}
                              />
                            ) : (
                              <p className="px-3 py-4 text-xs text-neutral-400">空目录</p>
                            )}
                            {rootListing?.truncated ? (
                              <p className="px-3 py-2 text-[10px] text-neutral-400">
                                仅显示前 500 项，完整内容请下载
                              </p>
                            ) : null}
                          </div>
                          {project.trashCount ? (
                            <p className="mt-2 text-[11px] text-neutral-400">
                              回收站里还有 {project.trashCount} 个文件（{formatBytes(project.trashBytes ?? 0)}），7 天后自动释放
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>
      </main>

      {deleteTarget ? (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="storage-delete-project-title"
            className="w-full max-w-md rounded-2xl border border-neutral-200 bg-white p-5 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400">
              <Trash2 className="h-5 w-5" />
            </div>
            <h2 id="storage-delete-project-title" className="mt-4 text-base font-semibold">
              永久删除项目「{deleteTarget.displayName}」？
            </h2>
            <p className="mt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-300">
              这一步<strong className="font-semibold text-red-600 dark:text-red-400">直接从磁盘删除</strong>
              且<strong className="font-semibold">无法恢复</strong>。
            </p>
            <div className="mt-4 space-y-1.5">
              <label htmlFor="storage-delete-confirm-name" className="block text-xs font-medium text-neutral-600 dark:text-neutral-300">
                输入项目名 <span className="font-mono text-neutral-900 dark:text-white">{deleteTarget.displayName}</span> 以确认
              </label>
              <input
                id="storage-delete-confirm-name"
                autoFocus
                value={typedName}
                onChange={(event) => setTypedName(event.target.value)}
                disabled={deleting}
                autoComplete="off"
                spellCheck={false}
                className="h-9 w-full rounded-lg border border-neutral-200 bg-white px-3 font-mono text-sm outline-none transition focus:border-red-400 focus:ring-2 focus:ring-red-500/10 disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-950"
              />
            </div>
            {deleteError ? (
              <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                {deleteError}
              </div>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={closeDelete}
                disabled={deleting}
                className="h-9 rounded-lg border border-neutral-200 px-4 text-sm font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmDelete()}
                disabled={deleting || !matchesName}
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40"
              >
                {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                永久删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div
          className={cn(
            'fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 backdrop-blur-sm',
            !previewFullscreen && 'p-4',
          )}
          onMouseDown={closePreview}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="storage-preview-title"
            className={cn(
              'flex w-full flex-col overflow-hidden bg-white shadow-2xl dark:bg-neutral-900',
              previewFullscreen ? 'h-full' : 'h-[min(82vh,760px)] max-w-5xl rounded-2xl',
            )}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 px-4 dark:border-neutral-800">
              <div className="min-w-0">
                <h2 id="storage-preview-title" className="truncate text-sm font-semibold">{preview.title}</h2>
                {preview.truncated ? <p className="text-[11px] text-amber-600">文件较大，仅显示前 200,000 个字符</p> : null}
              </div>
              <button type="button" onClick={() => setPreview(null)} className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" aria-label="关闭预览">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className={cn(
              'min-h-0 flex-1 bg-neutral-100 dark:bg-neutral-950',
              preview.kind === 'office' || preview.kind === 'image' || preview.kind === 'pdf'
                ? 'flex flex-col overflow-hidden'
                : 'overflow-auto',
            )}>
              {preview.loading ? (
                <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />正在载入预览…
                </div>
              ) : preview.error ? (
                <div className="flex h-full items-center justify-center p-8 text-sm text-red-600">{preview.error}</div>
              ) : preview.kind === 'text' ? (
                <pre className="min-h-full whitespace-pre-wrap break-words bg-white p-5 font-mono text-xs leading-6 text-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">{preview.text}</pre>
              ) : preview.kind === 'image' || preview.kind === 'pdf' || preview.kind === 'office' ? (
                <Suspense fallback={<div className="flex h-full items-center justify-center text-sm text-neutral-500">正在载入预览…</div>}>
                  <CodeEditorBinaryFile
                    key={`${preview.projectName}:${preview.path}`}
                    file={{ name: preview.title, path: preview.path }}
                    projectName={preview.projectName}
                    isSidebar
                    compactHeader
                    headerPrefix={<div className="hidden" />}
                    isFullscreen={false}
                    isExpanded={previewFullscreen}
                    onClose={closePreview}
                    onToggleFullscreen={() => setPreviewFullscreen((value) => !value)}
                    onToggleExpand={() => setPreviewFullscreen((value) => !value)}
                    title={preview.title}
                    message="无法预览该文件"
                  />
                </Suspense>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {contextMenu ? (
        <WorkspaceFileContextMenu
          entry={contextMenu.entry}
          x={contextMenu.x}
          y={contextMenu.y}
          onDownload={() => {
            void downloadEntry(contextMenu.project, contextMenu.entry).catch((error) => {
              setNotice({ kind: 'error', text: (error as Error).message });
            });
          }}
          onDelete={() => setDeleteFileTarget(contextMenu)}
          onClose={() => setContextMenu(null)}
        />
      ) : null}
      <WorkspaceDeleteDialog
        entry={deleteFileTarget?.entry ?? null}
        busy={deletingFile}
        onCancel={() => {
          if (!deletingFile) setDeleteFileTarget(null);
        }}
        onConfirm={() => {
          if (deleteFileTarget) {
            void trashFileEntry(deleteFileTarget.project, deleteFileTarget.entry);
          }
        }}
      />
    </div>
  );
}
