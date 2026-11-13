import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eraser,
  File,
  FileImage,
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
import { authenticatedFetch } from '../../utils/api';
import { cn } from '../../lib/utils.js';

/**
 * 存储页（设置 → 存储）= **项目视角**（2026-11-12 重构）。
 *
 * 这一页只回答两个问题：
 *   1. 每个在用项目占了多少磁盘？（总量 / exports / inbox / scratch / 回收站 / 会话数）
 *   2. 想收空间时，整个项目怎么删？（真删，不可恢复，所以要手打项目名确认）
 *
 * 刻意不做的事：
 *   - 不再有「归档」tab —— 项目归档已下线，删项目就是物理删除；
 *   - 不再从这一页删单个文件 —— 文件级删除只属于工作区页的回收站（7 天后自动释放）。
 *   唯一的例外是**只读预览**：排查「这 300 MB 到底是什么」时，总得能点开看一眼。
 */

type PreviewKind = 'image' | 'pdf' | 'text';

type StorageFile = {
  path: string;
  name: string;
  sizeBytes: number;
  previewKind: PreviewKind | null;
};

type StorageUsage = {
  inboxBytes: number;
  exportsBytes: number;
  scratchBytes: number;
  totalBytes: number;
};

type StorageFolder = {
  name: string;
  fileCount: number;
  sizeBytes: number;
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
  files: StorageFile[];
  folders?: StorageFolder[];
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
  kind: PreviewKind;
  loading: boolean;
  content: string | null;
  objectUrl: string | null;
  truncated: boolean;
  error: string | null;
} | null;

const EMPTY_SNAPSHOT: StorageSnapshot = {
  totals: { totalBytes: 0, workspaceBytes: 0, trashBytes: 0, projectCount: 0 },
  projects: [],
};

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

/** 三个默认目录固定排在最前，和「工作区」页面看到的一致。 */
const DEFAULT_DIRS = ['inbox', 'exports', 'scratch'] as const;

function folderHint(name: string): string {
  if (name === 'inbox') return '上传的原件，agent 只读';
  if (name === 'exports') return '最终成品，可直接下载';
  if (name === 'scratch') return '中间产物，会自动清理';
  if (name.includes('.')) return '放在项目根目录的文件';
  return '自定义目录';
}

function FolderIcon({ name }: { name: string }) {
  if (name === 'inbox') return <Inbox className="h-4 w-4" />;
  if (name === 'scratch') return <Eraser className="h-4 w-4" />;
  if (name === 'exports') return <FolderOpen className="h-4 w-4" />;
  if (name.includes('.')) return <File className="h-4 w-4" />;
  return <Folder className="h-4 w-4" />;
}

/** `.pilotdeck` / `.trash` 之类不展示，和工作区页保持一致（后端也会过滤，这里是兜底）。 */
function topDirOf(filePath: string): string | null {
  const top = filePath.split('/')[0] ?? '';
  if (!top || top.startsWith('.')) return null;
  return top;
}

/**
 * 目录清单：优先用后端给的 `folders`（三个默认目录永远在 + 用户自建目录），
 * 缺字段时按文件路径兜底，保证老快照也能渲染。
 */
function resolveFolders(project: StorageProject): StorageFolder[] {
  if (Array.isArray(project.folders) && project.folders.length > 0) return project.folders;
  const counts = new Map<string, { fileCount: number; sizeBytes: number }>();
  for (const file of project.files) {
    const top = topDirOf(file.path);
    if (!top) continue;
    const current = counts.get(top) ?? { fileCount: 0, sizeBytes: 0 };
    current.fileCount += 1;
    current.sizeBytes += file.sizeBytes;
    counts.set(top, current);
  }
  const names = [...new Set([...DEFAULT_DIRS, ...counts.keys()])];
  return names.map((name) => ({
    name,
    fileCount: counts.get(name)?.fileCount ?? 0,
    sizeBytes: counts.get(name)?.sizeBytes ?? 0,
  }));
}

/** 顶层目录 → 该目录下的文件（已按路径排好序）。 */
function groupFilesByFolder(files: StorageFile[]): Map<string, StorageFile[]> {
  const map = new Map<string, StorageFile[]>();
  for (const file of files) {
    const top = topDirOf(file.path);
    if (!top) continue;
    const list = map.get(top);
    if (list) list.push(file);
    else map.set(top, [file]);
  }
  return map;
}

export default function StorageV2() {
  const [snapshot, setSnapshot] = useState<StorageSnapshot>(EMPTY_SNAPSHOT);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** key = `${project.id}:${folder.name}`；项目展开后再按目录逐层展开。 */
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<PreviewState>(null);
  const [notice, setNotice] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<StorageProject | null>(null);
  const [typedName, setTypedName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/storage');
      const data = await readJson<StorageSnapshot>(response);
      setSnapshot({ ...data, projects: data.projects ?? [] });
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

  const projects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return snapshot.projects;
    // 搜项目名、项目 id，也搜文件路径 —— 用户常常只记得文件名。
    return snapshot.projects.filter((project) => (
      `${project.displayName} ${project.id}`.toLocaleLowerCase().includes(normalized)
      || project.files.some((file) => file.path.toLocaleLowerCase().includes(normalized))
    ));
  }, [query, snapshot.projects]);

  const openPreview = async (project: StorageProject, file: StorageFile) => {
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
        typeKey: project.typeKey,
        groupId: project.id,
        path: file.path,
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
                <div className="hidden min-w-0 grid-cols-[minmax(0,1fr)_92px_72px_96px_104px_136px_168px] gap-3 border-b border-neutral-200 bg-neutral-50 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:border-neutral-800 dark:bg-neutral-950/40 md:grid">
                  <span>项目</span>
                  <span>类型</span>
                  <span className="text-right">会话</span>
                  <span className="text-right">占用</span>
                  <span className="text-right">回收站</span>
                  <span className="text-right">最后活动</span>
                  <span className="text-right">操作</span>
                </div>

                {projects.map((project) => {
                  const open = expanded.has(project.id);
                  const folders = resolveFolders(project);
                  const filesByFolder = groupFilesByFolder(project.files);
                  return (
                    <div key={`${project.typeKey}:${project.id}`} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
                      <div className="grid min-w-0 grid-cols-1 gap-2 px-4 py-3 md:grid-cols-[minmax(0,1fr)_92px_72px_96px_104px_136px_168px] md:items-center md:gap-3">
                        <button
                          type="button"
                          onClick={() => setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(project.id)) next.delete(project.id);
                            else next.add(project.id);
                            return next;
                          })}
                          className="flex min-w-0 items-center gap-2 text-left"
                          aria-expanded={open}
                        >
                          {open
                            ? <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400" />
                            : <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />}
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">{project.displayName}</span>
                            <span className="block truncate font-mono text-[11px] text-neutral-400">{project.id}</span>
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
                            onClick={() => setExpanded((current) => {
                              const next = new Set(current);
                              if (!next.has(project.id)) next.add(project.id);
                              return next;
                            })}
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
                            {folders.map((folder) => {
                              const folderKey = `${project.id}:${folder.name}`;
                              const folderOpen = openFolders.has(folderKey);
                              const files = filesByFolder.get(folder.name) ?? [];
                              return (
                                <div key={folderKey} className="border-b border-neutral-100 last:border-0 dark:border-neutral-800">
                                  <button
                                    type="button"
                                    onClick={() => setOpenFolders((current) => {
                                      const next = new Set(current);
                                      if (next.has(folderKey)) next.delete(folderKey);
                                      else next.add(folderKey);
                                      return next;
                                    })}
                                    aria-expanded={folderOpen}
                                    className="flex w-full items-center gap-2 px-3 py-2 text-left transition hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
                                  >
                                    {folderOpen
                                      ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
                                      : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-neutral-400" />}
                                    <span className="shrink-0 text-neutral-400"><FolderIcon name={folder.name} /></span>
                                    <span className="min-w-0 flex-1">
                                      <span className="block truncate text-sm font-medium">{folder.name}</span>
                                      <span className="block truncate text-[11px] text-neutral-400">{folderHint(folder.name)}</span>
                                    </span>
                                    <span className="shrink-0 font-mono text-xs text-neutral-500">
                                      {folder.fileCount} 个 · {formatBytes(folder.sizeBytes)}
                                    </span>
                                  </button>
                                  {folderOpen ? (
                                    <div className="border-t border-neutral-100 bg-neutral-50/50 dark:border-neutral-800 dark:bg-neutral-950/20">
                                      {files.length === 0 ? (
                                        <p className="px-3 py-2 text-xs text-neutral-400">空目录</p>
                                      ) : files.map((file) => (
                                        <div key={file.path} className="flex items-center gap-3 border-b border-neutral-100 px-3 py-2 last:border-0 dark:border-neutral-800">
                                          <span className="text-neutral-400"><FileKindIcon kind={file.previewKind} /></span>
                                          <button
                                            type="button"
                                            disabled={!file.previewKind}
                                            onClick={() => void openPreview(project, file)}
                                            className={cn('min-w-0 flex-1 text-left', file.previewKind && 'group cursor-pointer')}
                                            title={file.previewKind ? '点击预览（只读）' : '此类型暂不支持预览'}
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
                                      ))}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
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
