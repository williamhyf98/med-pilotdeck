import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ChevronRight,
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Inbox,
  Loader2,
  Eraser,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Project } from '../../types/app';
import { cn } from '../../lib/utils.js';
import { api, authenticatedFetch } from '../../utils/api';
import Tooltip from '../../shared/view/ui/Tooltip';
import {
  ensureUploadFailedMessage,
  formatAttachmentLimitErrors,
  validateAttachmentBatch,
} from '../chat/utils/medicalFolderUpload';

type FilesV2Props = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  activeFilePath?: string | null;
  onClose?: () => void;
};

type WorkspaceEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  size: number | null;
  modified: string | null;
};

/** 顶部提示停留时间：到点自动消失，不用手动关。 */
const NOTICE_TTL_MS = 4_000;

/** 工作区头部图标的统一样式（新建目录 / 上传 / 刷新）。 */
const HEADER_ICON_BUTTON = 'inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50';
/** 悬停提示：贴合主题（前景色气泡 + 背景色文字），不要灰色胶囊。 */
const HEADER_TIP_BUBBLE = 'border border-border/70 bg-foreground px-2 py-1 text-[10.5px] text-background shadow-md';
const HEADER_TIP_ARROW = 'top-full left-1/2 -translate-x-1/2 border-t-foreground';

type WorkspaceUsage = {
  inboxBytes: number;
  exportsBytes: number;
  scratchBytes: number;
  totalBytes: number;
};

type UsageThresholds = {
  workspaceWarnBytes: number;
  scratchWarnBytes: number;
};

type DirectoryListing = {
  entries: WorkspaceEntry[];
  truncated: boolean;
};

type TrashEntry = {
  path: string;
  originalPath: string;
  deletedAt: string;
  sizeBytes: number;
  kind?: 'file' | 'directory';
};

type TrashState = {
  entries: TrashEntry[];
  totals: { count: number; bytes: number };
  retentionDays: number;
};

const EMPTY_TRASH: TrashState = {
  entries: [],
  totals: { count: 0, bytes: 0 },
  retentionDays: 7,
};

type PreviewKind = 'image' | 'pdf' | 'office' | 'text' | 'none';

type PreviewState = {
  title: string;
  path: string;
  kind: PreviewKind;
  loading: boolean;
  error: string | null;
  objectUrl: string | null;
  text: string | null;
  truncated: boolean;
} | null;

const EMPTY_USAGE: WorkspaceUsage = {
  inboxBytes: 0,
  exportsBytes: 0,
  scratchBytes: 0,
  totalBytes: 0,
};

const DEFAULT_THRESHOLDS: UsageThresholds = {
  workspaceWarnBytes: 5 * 1024 ** 3,
  scratchWarnBytes: 1024 ** 3,
};

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'tsv', 'odt', 'odp', 'ods', 'rtf']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonl', 'xml', 'yaml', 'yml',
  'log', 'html', 'htm', 'css', 'js', 'jsx', 'ts', 'tsx', 'py', 'sh', 'sql',
]);
const MAX_TEXT_PREVIEW_CHARS = 200_000;

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
  if (kind === 'image') return <FileImage className="h-4 w-4" strokeWidth={1.8} />;
  if (kind === 'office') return <FileSpreadsheet className="h-4 w-4" strokeWidth={1.8} />;
  if (kind === 'text' || kind === 'pdf') return <FileText className="h-4 w-4" strokeWidth={1.8} />;
  return <File className="h-4 w-4" strokeWidth={1.8} />;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / (1024 ** index);
  return `${scaled >= 100 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function formatModified(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error((body as { error?: string }).error || `请求失败（${response.status}）`);
  }
  return body as T;
}

/** 一条用量条：纯提示，不拦截任何写入（设计书 §6.1）。 */
function UsageBar({
  label,
  valueText,
  note,
  ratio,
  warned,
}: {
  label: string;
  valueText: string;
  note?: ReactNode;
  ratio: number;
  warned?: boolean;
}) {
  const width = Math.max(0, Math.min(ratio, 1)) * 100;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-medium text-foreground">{label}</span>
        <span className="truncate tabular-nums text-muted-foreground">{valueText}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full transition-[width]', warned ? 'bg-amber-500' : 'bg-blue-500')}
          style={{ width: `${width}%` }}
        />
      </div>
      {note ? <div className="mt-1 text-[10px] text-muted-foreground">{note}</div> : null}
    </div>
  );
}

/** 三个默认目录各自是干什么的（替代原来的"可读/可写/只读"能力卡）。 */
function DirectoryLegend() {
  const rows: Array<{ icon: ReactNode; title: string; detail: string }> = [
    { icon: <Inbox className="h-3.5 w-3.5" />, title: 'inbox', detail: '上传的原件，agent 只读；不会自动清理' },
    { icon: <FolderOpen className="h-3.5 w-3.5" />, title: 'exports', detail: '最终成品，可直接下载；不会自动清理' },
    { icon: <Eraser className="h-3.5 w-3.5" />, title: 'scratch', detail: '中间产物，会自动清理，可手动立即清理' },
  ];
  return (
    <section className="rounded-lg border border-border/80 bg-background/60 px-2.5 py-2">
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.title} className="flex items-center gap-2 text-[10.5px] leading-4 text-muted-foreground">
            <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-muted text-foreground/70">
              {row.icon}
            </span>
            <span className="shrink-0 font-medium text-foreground/80">{row.title}</span>
            <span className="truncate">{row.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type TreeBranchProps = {
  entries: WorkspaceEntry[];
  depth: number;
  expanded: Set<string>;
  loadingPaths: Set<string>;
  listings: Record<string, DirectoryListing>;
  activeFilePath?: string | null;
  onToggle: (entry: WorkspaceEntry) => void;
  onPreview: (entry: WorkspaceEntry) => void;
  dragPath: string | null;
  dropTarget: string | null;
  canDrag: (entry: WorkspaceEntry, depth: number) => boolean;
  onDragStart: (entry: WorkspaceEntry) => void;
  onDragEnd: () => void;
  onHover: (path: string | null) => void;
  onDropInto: (entry: WorkspaceEntry) => void;
};

function TreeBranch({
  entries,
  depth,
  expanded,
  loadingPaths,
  listings,
  activeFilePath,
  onToggle,
  onPreview,
  dragPath,
  dropTarget,
  canDrag,
  onDragStart,
  onDragEnd,
  onHover,
  onDropInto,
}: TreeBranchProps) {
  return (
    <>
      {entries.map((entry) => {
        const isDirectory = entry.type === 'directory';
        const open = isDirectory && expanded.has(entry.path);
        const listing = listings[entry.path];
        const childLoading = loadingPaths.has(entry.path);
        const draggable = canDrag(entry, depth);
        return (
          <div
            key={entry.path}
            onDragOver={isDirectory ? (event) => {
              if (!dragPath || dragPath === entry.path) return;
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = 'move';
              onHover(entry.path);
            } : undefined}
            onDragLeave={isDirectory ? (event) => {
              if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
              onHover(null);
            } : undefined}
            onDrop={isDirectory ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onDropInto(entry);
            } : undefined}
            className={cn(
              draggable && 'cursor-grab active:cursor-grabbing',
              dropTarget === entry.path && isDirectory
                && 'rounded-md bg-blue-50/80 ring-1 ring-inset ring-blue-400/70 dark:bg-blue-950/40',
            )}
          >
            <button
              type="button"
              draggable={draggable}
              onDragStart={(event) => {
                // 子行的 dragstart 会冒泡到父行，只认真正被拖的那个元素
                event.stopPropagation();
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', entry.path);
                onDragStart(entry);
              }}
              onDragEnd={(event) => {
                event.stopPropagation();
                onDragEnd();
              }}
              onClick={() => (isDirectory ? onToggle(entry) : onPreview(entry))}
              title={entry.path}
              aria-expanded={isDirectory ? open : undefined}
              className={cn(
                'group flex w-full items-center gap-1.5 rounded-md py-1 pr-1.5 text-left transition-colors',
                activeFilePath === entry.path
                  ? 'bg-blue-50/90 dark:bg-blue-950/50'
                  : 'hover:bg-accent/70',
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">
                {isDirectory
                  ? <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
                  : null}
              </span>
              <span className={cn(
                'shrink-0',
                isDirectory ? 'text-amber-500' : 'text-muted-foreground',
              )}
              >
                {isDirectory
                  ? (open ? <FolderOpen className="h-3.5 w-3.5" /> : <Folder className="h-3.5 w-3.5" />)
                  : <FileKindIcon name={entry.name} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px] leading-4 text-foreground">{entry.name}</span>
                <span className="block truncate text-[9.5px] leading-3 text-muted-foreground">
                  {isDirectory ? (open ? `${listing?.entries.length ?? ''} 项` : '目录') : formatBytes(entry.size ?? 0)}
                  {entry.modified ? ` · ${formatModified(entry.modified)}` : ''}
                </span>
              </span>
              {childLoading ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" /> : null}
            </button>
            {open ? (
              listing ? (
                listing.entries.length > 0 ? (
                  <>
                    <TreeBranch
                      entries={listing.entries}
                      depth={depth + 1}
                      expanded={expanded}
                      loadingPaths={loadingPaths}
                      listings={listings}
                      activeFilePath={activeFilePath}
                      onToggle={onToggle}
                      onPreview={onPreview}
                      dragPath={dragPath}
                      dropTarget={dropTarget}
                      canDrag={canDrag}
                      onDragStart={onDragStart}
                      onDragEnd={onDragEnd}
                      onHover={onHover}
                      onDropInto={onDropInto}
                    />
                    {listing.truncated ? (
                      <p
                        className="py-1 text-[9.5px] text-muted-foreground"
                        style={{ paddingLeft: 20 + depth * 12 }}
                      >
                        仅显示前 500 项，完整内容请下载
                      </p>
                    ) : null}
                  </>
                ) : (
                  <p
                    className="py-1 text-[9.5px] text-muted-foreground"
                    style={{ paddingLeft: 20 + depth * 12 }}
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

export default function FilesV2({
  selectedProject,
  onFileOpen,
  activeFilePath,
  onClose,
}: FilesV2Props) {
  const [usage, setUsage] = useState<WorkspaceUsage>(EMPTY_USAGE);
  const [thresholds, setThresholds] = useState<UsageThresholds>(DEFAULT_THRESHOLDS);
  const [listings, setListings] = useState<Record<string, DirectoryListing>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [preview, setPreview] = useState<PreviewState>(null);
  const [trash, setTrash] = useState<TrashState>(EMPTY_TRASH);
  const [showTrash, setShowTrash] = useState(false);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [confirmScratch, setConfirmScratch] = useState(false);
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [trashHover, setTrashHover] = useState(false);
  const [moving, setMoving] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [trashBusy, setTrashBusy] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const [savingText, setSavingText] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const projectName = selectedProject?.name ?? '';

  const loadDirectory = useCallback(async (relativePath: string) => {
    if (!projectName) return;
    setLoadingPaths((current) => new Set(current).add(relativePath));
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/files/list?path=${encodeURIComponent(relativePath)}`,
      );
      const data = await readJson<{ entries: WorkspaceEntry[]; truncated?: boolean }>(response);
      setListings((current) => ({
        ...current,
        [relativePath]: { entries: data.entries ?? [], truncated: Boolean(data.truncated) },
      }));
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      setLoadingPaths((current) => {
        const next = new Set(current);
        next.delete(relativePath);
        return next;
      });
    }
  }, [projectName]);

  const loadTrash = useCallback(async () => {
    if (!projectName) return;
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/trash`,
      );
      const data = await readJson<TrashState>(response);
      setTrash({
        entries: data.entries ?? [],
        totals: data.totals ?? { count: 0, bytes: 0 },
        retentionDays: data.retentionDays ?? 7,
      });
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message });
    }
  }, [projectName]);

  const refresh = useCallback(async () => {
    if (!projectName) return;
    setLoading(true);
    setNotice(null);
    try {
      const usageResponse = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workspace/usage`,
      );
      const data = await readJson<{ usage?: WorkspaceUsage; thresholds?: UsageThresholds }>(usageResponse);
      setUsage({ ...EMPTY_USAGE, ...data.usage });
      setThresholds({ ...DEFAULT_THRESHOLDS, ...data.thresholds });
      setListings({});
      setExpanded(new Set());
      await Promise.all([loadDirectory(''), loadTrash()]);
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      setLoading(false);
    }
  }, [loadDirectory, loadTrash, projectName]);

  useEffect(() => {
    setNotice(null);
    setPreview(null);
    setUsage(EMPTY_USAGE);
    setTrash(EMPTY_TRASH);
    setShowTrash(false);
    setListings({});
    setExpanded(new Set());
    void refresh();
  }, [projectName, refresh]);

  useEffect(() => {
    const handleFileUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectName?: string }>).detail;
      if (!detail?.projectName || detail.projectName === projectName) {
        void refresh();
      }
    };
    window.addEventListener('pilotdeck:file-updated', handleFileUpdated);
    window.addEventListener('pilotdeck:files-changed', handleFileUpdated);
    return () => {
      window.removeEventListener('pilotdeck:file-updated', handleFileUpdated);
      window.removeEventListener('pilotdeck:files-changed', handleFileUpdated);
    };
  }, [projectName, refresh]);

  // 顶部提示 4 秒后自动消失（错误也一样，避免一直占着版面）。
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_TTL_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => () => {
    if (preview?.objectUrl) URL.revokeObjectURL(preview.objectUrl);
  }, [preview?.objectUrl]);

  const toggleDirectory = useCallback((entry: WorkspaceEntry) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entry.path)) next.delete(entry.path);
      else next.add(entry.path);
      return next;
    });
    if (!listings[entry.path]) void loadDirectory(entry.path);
  }, [listings, loadDirectory]);

  const openPreview = useCallback(async (entry: WorkspaceEntry) => {
    const kind = previewKindOf(entry.name);
    setEditingText(false);
    setTextDraft('');
    if (kind === 'none') {
      setPreview({
        title: entry.name,
        path: entry.path,
        kind,
        loading: false,
        error: '这个文件类型暂不支持预览，可下载或直接在编辑器中打开。',
        objectUrl: null,
        text: null,
        truncated: false,
      });
      return;
    }
    setPreview({
      title: entry.name,
      path: entry.path,
      kind,
      loading: true,
      error: null,
      objectUrl: null,
      text: null,
      truncated: false,
    });
    try {
      const encoded = encodeURIComponent(entry.path);
      if (kind === 'text') {
        const response = await authenticatedFetch(
          `/api/projects/${encodeURIComponent(projectName)}/file?filePath=${encoded}`,
        );
        const data = await readJson<{ content?: string }>(response);
        const content = data.content ?? '';
        setPreview((current) => current ? {
          ...current,
          loading: false,
          text: content.slice(0, MAX_TEXT_PREVIEW_CHARS),
          truncated: content.length > MAX_TEXT_PREVIEW_CHARS,
        } : current);
        return;
      }

      const url = kind === 'office'
        ? `/api/projects/${encodeURIComponent(projectName)}/files/preview/pdf?path=${encoded}`
        : `/api/projects/${encodeURIComponent(projectName)}/files/content?path=${encoded}`;
      const response = await authenticatedFetch(url);
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error || `预览失败（${response.status}）`);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      setPreview((current) => {
        if (!current) {
          URL.revokeObjectURL(objectUrl);
          return current;
        }
        if (current.objectUrl) URL.revokeObjectURL(current.objectUrl);
        return { ...current, loading: false, objectUrl };
      });
    } catch (error) {
      setPreview((current) => current ? {
        ...current,
        loading: false,
        error: (error as Error).message,
      } : current);
    }
  }, [projectName]);

  const closePreview = useCallback(() => {
    setPreview(null);
    setEditingText(false);
    setTextDraft('');
  }, []);

  const startEditing = useCallback(() => {
    if (!preview || preview.kind !== 'text') return;
    setTextDraft(preview.text ?? '');
    setEditingText(true);
  }, [preview]);

  /**
   * 保存文本编辑。后端 `PUT /file` 与新建目录共用同一套路径规则：
   * 相对路径、无 `..`、不落隐藏名/保留项、inbox 只读、拒绝软链。
   */
  const saveText = useCallback(async () => {
    if (!preview) return;
    setSavingText(true);
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/file`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filePath: preview.path, content: textDraft }),
        },
      );
      await readJson<{ success?: boolean }>(response);
      setPreview((current) => current ? { ...current, text: textDraft } : current);
      setEditingText(false);
      await refresh();
      // refresh() 会先清空 notice，所以成功提示必须放在它之后。
      setNotice({ tone: 'success', text: `已保存 ${preview.path}` });
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      setSavingText(false);
    }
  }, [preview, projectName, refresh, textDraft]);

  const restoreTrashEntry = useCallback(async (entry: TrashEntry) => {
    setTrashBusy(true);
    setNotice(null);
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/trash/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: entry.path }),
        },
      );
      await readJson(response);
      await refresh();
      setNotice({ tone: 'success', text: `已恢复到 ${entry.originalPath}` });
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      setTrashBusy(false);
    }
  }, [projectName, refresh]);

  const emptyTrashNow = useCallback(async () => {
    const { count, bytes } = trash.totals;
    setTrashBusy(true);
    setNotice(null);
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/trash/empty`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: true }),
        },
      );
      const result = await readJson<{ purged?: number; freedBytes?: number }>(response);
      setConfirmEmpty(false);
      await refresh();
      setNotice({
        tone: 'success',
        text: `已清空回收站，释放 ${formatBytes(result.freedBytes ?? bytes)}（${result.purged ?? count} 项）`,
      });
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      setTrashBusy(false);
    }
  }, [projectName, refresh, trash.totals]);

  const createFolder = useCallback(async () => {
    const path = newFolderName.trim();
    if (!path) return;
    setCreatingFolder(true);
    setNotice(null);
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/files/mkdir`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path }),
        },
      );
      const created = await readJson<{ path?: string }>(response);
      setNewFolderOpen(false);
      setNewFolderName('');
      await refresh();
      setNotice({ tone: 'success', text: `已创建目录 ${created.path ?? path}` });
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      setCreatingFolder(false);
    }
  }, [newFolderName, projectName, refresh]);

  const cleanScratchNow = useCallback(async () => {
    setConfirmScratch(false);
    setLoading(true);
    setNotice(null);
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/workspace/scratch/clean`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ force: true, confirm: true }),
        },
      );
      const result = await readJson<{ removed?: number; freedBytes?: number; skipped?: number }>(response);
      await refresh();
      const removed = result.removed ?? 0;
      setNotice({
        tone: 'success',
        text: removed > 0
          ? `已清理 ${removed} 项中间产物，释放 ${formatBytes(result.freedBytes ?? 0)}`
          : '没有可清理的内容（正在运行的回合、1 分钟内写入的、已钉住的不在此列）',
      });
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      setLoading(false);
    }
  }, [projectName, refresh]);

  const parentOf = (target: string) => (target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '');

  const moveEntry = useCallback(async (from: string, toDir: string) => {
    setDropTarget(null);
    setDragPath(null);
    setTrashHover(false);
    if (!from || parentOf(from) === toDir) return;
    setMoving(true);
    setNotice(null);
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/files/move`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, toDir }),
        },
      );
      const result = await readJson<{ to?: string }>(response);
      await refresh();
      const intoScratch = toDir === 'scratch' || toDir.startsWith('scratch/');
      setNotice({
        tone: 'success',
        text: intoScratch
          ? `已移入 ${toDir}（scratch 会被定期自动清理）：${result.to ?? from}`
          : `已移动到 ${toDir || '工作区根目录'}：${result.to ?? from}`,
      });
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      setMoving(false);
    }
  }, [projectName, refresh]);

  const trashEntry = useCallback(async (target: string) => {
    setDropTarget(null);
    setDragPath(null);
    setTrashHover(false);
    if (!target) return;
    setMoving(true);
    setNotice(null);
    try {
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectName)}/files/trash`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: target }),
        },
      );
      await readJson(response);
      await refresh();
      setNotice({ tone: 'success', text: `已移入回收站：${target}` });
    } catch (error) {
      setNotice({ tone: 'error', text: (error as Error).message });
    } finally {
      setMoving(false);
    }
  }, [projectName, refresh]);

  const canDrag = useCallback((entry: WorkspaceEntry, depth: number) => {
    if (moving) return false;
    // 只锁三个骨架目录本身，里面的内容照常可以拖。
    if (depth === 0 && ['exports', 'inbox', 'scratch'].includes(entry.name)) return false;
    return true;
  }, [moving]);

  const uploadSelectedFiles = useCallback(async (selection: FileList | null) => {
    if (!selectedProject?.name || !selection || selection.length === 0) return;
    const selectedFiles = Array.from(selection);
    const validation = validateAttachmentBatch({
      existingCount: 0,
      existingBytes: 0,
      incoming: selectedFiles.map((file) => ({ name: file.name, size: file.size })),
    });
    if (!validation.ok) {
      setNotice({ tone: 'error', text: formatAttachmentLimitErrors(validation.errors) });
      return;
    }

    const formData = new FormData();
    const batchId = String(Date.now());
    formData.append('targetPath', `inbox/uploads/${batchId}`);
    formData.append('relativePaths', JSON.stringify(selectedFiles.map((file) => file.name)));
    selectedFiles.forEach((file) => formData.append('files', file));

    try {
      setUploading(true);
      setNotice(null);
      const response = await api.uploadFiles(selectedProject.name, formData);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload?.error === 'string' ? payload.error : '上传失败，请稍后重试');
      }
      await refresh();
      setNotice({ tone: 'success', text: `已上传 ${selectedFiles.length} 个文件` });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: ensureUploadFailedMessage(error instanceof Error ? error.message : '未知错误'),
      });
    } finally {
      setUploading(false);
    }
  }, [refresh, selectedProject?.name]);

  const rootEntries = listings['']?.entries ?? [];
  const inboxShare = usage.totalBytes > 0 ? usage.inboxBytes / usage.totalBytes : 0;
  const workspaceWarned = usage.totalBytes >= thresholds.workspaceWarnBytes * 0.8;
  const scratchWarned = usage.scratchBytes >= thresholds.scratchWarnBytes * 0.8;
  const totalRatio = thresholds.workspaceWarnBytes > 0
    ? usage.totalBytes / thresholds.workspaceWarnBytes
    : 0;
  // 提示语随占用变化：只给建议，永不拦截写入（§8.2）。
  const totalNote = totalRatio >= 0.95
    ? '已接近提示上限，建议立即清理 scratch，或把不再需要的大文件移出工作区（仍不会拦截写入）'
    : totalRatio >= 0.8
      ? '占用偏高，建议清理 scratch，或删掉不需要的导出文件'
      : totalRatio >= 0.6
        ? '占用有所上升，可以留意一下体积较大的目录'
        : '占用正常；仅为提示，不会拦截写入';

  const usageBars = useMemo(() => [
    {
      key: 'total',
      label: '工作区总量',
      valueText: `${formatBytes(usage.totalBytes)} / 提示 ${formatBytes(thresholds.workspaceWarnBytes)}`,
      ratio: totalRatio,
      warned: workspaceWarned,
      note: totalNote,
    },
    {
      key: 'inbox',
      label: 'inbox',
      valueText: `${formatBytes(usage.inboxBytes)} · 占 ${(inboxShare * 100).toFixed(1)}%`,
      ratio: inboxShare,
      warned: false,
      note: '上传原件不会自动清理',
    },
    {
      key: 'scratch',
      label: 'scratch',
      valueText: `${formatBytes(usage.scratchBytes)} / 提示 ${formatBytes(thresholds.scratchWarnBytes)}`,
      ratio: thresholds.scratchWarnBytes > 0 ? usage.scratchBytes / thresholds.scratchWarnBytes : 0,
      warned: scratchWarned,
      // 小字按钮：下划线 + hover 变色，跟 inbox 那行说明同一字号
      note: (
        <button
          type="button"
          onClick={() => setConfirmScratch(true)}
          disabled={loading || usage.scratchBytes === 0}
          className="text-[10px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:text-muted-foreground"
        >
          立即清理 scratch
        </button>
      ),
    },
  ], [inboxShare, loading, scratchWarned, thresholds, totalNote, totalRatio, usage, workspaceWarned]);

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted-foreground">
        请先选择一个项目
      </div>
    );
  }

  return (
    <div className="workspace-panel-surface bg-background/82 relative flex h-full min-h-0 flex-col overflow-hidden backdrop-blur-sm">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold text-foreground">工作区</h2>
          <p className="truncate text-[10px] text-muted-foreground">{selectedProject.displayName || selectedProject.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip
            content="新建目录"
            position="top"
            className={HEADER_TIP_BUBBLE}
            arrowClassName={HEADER_TIP_ARROW}
          >
            <button
              type="button"
              onClick={() => {
                setNewFolderName('');
                setNewFolderOpen(true);
              }}
              aria-label="新建目录"
              className={HEADER_ICON_BUTTON}
            >
              <FolderPlus className="h-3.5 w-3.5" />
            </button>
          </Tooltip>
          <Tooltip
            content="上传文件"
            position="top"
            className={HEADER_TIP_BUBBLE}
            arrowClassName={HEADER_TIP_ARROW}
          >
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              aria-label="上传文件"
              className={HEADER_ICON_BUTTON}
            >
              {uploading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Upload className="h-3.5 w-3.5" />}
            </button>
          </Tooltip>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void uploadSelectedFiles(event.currentTarget.files);
              event.currentTarget.value = '';
            }}
          />
          <Tooltip
            content="刷新"
            position="top"
            className={HEADER_TIP_BUBBLE}
            arrowClassName={HEADER_TIP_ARROW}
          >
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label="刷新工作区"
              className={HEADER_ICON_BUTTON}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </button>
          </Tooltip>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭工作区"
              title="关闭工作区"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3">
        {notice ? (
          <div className={cn(
            'mb-3 rounded-md border px-2.5 py-2 text-[11px] leading-4',
            notice.tone === 'success'
              ? 'border-emerald-200 bg-emerald-50/90 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/35 dark:text-emerald-300'
              : 'border-red-200 bg-red-50/90 text-red-700 dark:border-red-900 dark:bg-red-950/35 dark:text-red-300',
          )}
          >
            {notice.text}
          </div>
        ) : null}

        <section className="space-y-2.5">
          {usageBars.map((bar) => (
            <UsageBar
              key={bar.key}
              label={bar.label}
              valueText={bar.valueText}
              note={bar.note}
              ratio={bar.ratio}
              warned={bar.warned}
            />
          ))}
        </section>

        <div className="mt-3">
          <DirectoryLegend />
        </div>

        <section className="mt-3">
          <div className="mb-1 flex items-center justify-between px-0.5">
            <h3 className="text-[11px] font-semibold text-foreground">目录</h3>
            {rootEntries.length > 0 ? (
              <span className="text-[10px] tabular-nums text-muted-foreground">
                {rootEntries.length} 项 · 拖拽可移动
              </span>
            ) : null}
          </div>
          {loading && rootEntries.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              正在读取工作区…
            </div>
          ) : rootEntries.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/80 px-3 py-6 text-center text-[11px] leading-5 text-muted-foreground">
              这个工作区还没有文件。Agent 生成的文件会出现在 exports/ 目录。
            </div>
          ) : (
            <div
              className={cn(
                'space-y-0.5 rounded-md',
                dropTarget === '' && 'bg-blue-50/60 ring-1 ring-inset ring-blue-300/70 dark:bg-blue-950/30',
              )}
              onDragOver={(event) => {
                if (!dragPath) return;
                // 只把列表的空白处当"工作区根"；落在文件行上不误判成移到根目录
                if (event.target !== event.currentTarget) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDropTarget('');
              }}
              onDragLeave={(event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                setDropTarget(null);
              }}
              onDrop={(event) => {
                if (event.target !== event.currentTarget) return;
                event.preventDefault();
                if (dragPath) void moveEntry(dragPath, '');
              }}
            >
              <TreeBranch
                entries={rootEntries}
                depth={0}
                expanded={expanded}
                loadingPaths={loadingPaths}
                listings={listings}
                activeFilePath={activeFilePath}
                onToggle={toggleDirectory}
                onPreview={(entry) => void openPreview(entry)}
                dragPath={dragPath}
                dropTarget={dropTarget}
                canDrag={canDrag}
                onDragStart={(entry) => setDragPath(entry.path)}
                onDragEnd={() => {
                  setDragPath(null);
                  setDropTarget(null);
                  setTrashHover(false);
                }}
                onHover={setDropTarget}
                onDropInto={(entry) => {
                  if (dragPath) void moveEntry(dragPath, entry.path);
                }}
              />
            </div>
          )}
        </section>

        {/* 回收站 + 下方空白一起当落点：整个面板底部都能把东西拖进回收站 */}
        <section
          className={cn(
            'mt-4 flex min-h-[96px] flex-1 flex-col rounded-md border-t border-border/70 pt-2.5 transition-colors',
            trashHover && 'bg-red-50/70 dark:bg-red-950/25',
          )}
          onDragOver={(event) => {
            if (!dragPath) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setDropTarget('__trash__');
            setTrashHover(true);
          }}
          onDragLeave={(event) => {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setTrashHover(false);
            setDropTarget(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setTrashHover(false);
            if (dragPath) void trashEntry(dragPath);
          }}
        >
          <div
            className={cn(
              'mb-1 flex items-center justify-between gap-2 rounded-md px-0.5',
              dropTarget === '__trash__' && 'bg-red-50/80 dark:bg-red-950/30',
            )}
          >
            <button
              type="button"
              onClick={() => setShowTrash((value) => !value)}
              aria-expanded={showTrash}
              className="flex min-w-0 items-center gap-1 text-[11px] font-semibold text-foreground"
            >
              <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', showTrash && 'rotate-90')} />
              <span className="shrink-0">回收站</span>
              <span className="truncate text-[10px] font-normal text-muted-foreground">
                {trash.totals.count} 项 · {formatBytes(trash.totals.bytes)} · {trash.retentionDays} 天后自动释放
              </span>
            </button>
            {trash.totals.count > 0 ? (
              <button
                type="button"
                onClick={() => setConfirmEmpty(true)}
                disabled={trashBusy}
                className="shrink-0 text-[10.5px] font-medium text-destructive transition hover:underline disabled:opacity-50"
              >
                清空
              </button>
            ) : null}
          </div>
          {showTrash ? (
            trash.entries.length === 0 ? (
              <p className="px-1 py-2 text-[10.5px] text-muted-foreground">回收站是空的。</p>
            ) : (
              <ul className="space-y-0.5">
                {trash.entries.map((entry) => (
                  <li
                    key={entry.path}
                    className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-accent/60"
                  >
                    <span className="shrink-0 text-muted-foreground">
                      {entry.kind === 'directory'
                        ? <Folder className="h-3.5 w-3.5 text-amber-500" />
                        : <FileKindIcon name={entry.originalPath} />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[11px] text-foreground" title={entry.originalPath}>
                        {entry.originalPath}
                      </span>
                      <span className="block truncate text-[9.5px] text-muted-foreground">
                        {formatBytes(entry.sizeBytes)} · 删除于 {formatModified(entry.deletedAt)}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => void restoreTrashEntry(entry)}
                      disabled={trashBusy}
                      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-foreground transition hover:bg-muted disabled:opacity-50"
                    >
                      <RotateCcw className="h-3 w-3" />
                      恢复
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </section>
      </div>

      {trashHover && dragPath ? (
        <div
          aria-hidden="true"
          data-testid="trash-drop-overlay"
          className="pointer-events-none absolute inset-x-0 bottom-0 z-[9999] flex h-[40%] max-h-[340px] min-h-[120px] items-center justify-center bg-gradient-to-t from-black/55 via-black/25 to-transparent transition-opacity duration-150"
        >
          <div className="flex h-14 w-14 animate-bounce items-center justify-center rounded-full bg-red-600 shadow-xl ring-4 ring-red-400/30">
            <Trash2 className="h-6 w-6 text-white" />
          </div>
        </div>
      ) : null}

      {newFolderOpen ? (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-4" onMouseDown={() => setNewFolderOpen(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-new-folder-title"
            className="w-full max-w-sm space-y-3 rounded-xl border border-border bg-background p-4 shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="workspace-new-folder-title" className="text-sm font-semibold text-foreground">新建目录</h2>
            <p className="text-[11px] leading-4 text-muted-foreground">
              可以写多级（如 我的资料/2026），上级目录需要已存在。
            </p>
            <input
              autoFocus
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createFolder();
              }}
              aria-label="目录名"
              placeholder="目录名"
              className="w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[12px] text-foreground"
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNewFolderOpen(false)}
                className="rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground hover:bg-muted"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void createFolder()}
                disabled={creatingFolder || newFolderName.trim() === ''}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {creatingFolder ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                创建
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmEmpty ? (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-4" onMouseDown={() => setConfirmEmpty(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-empty-trash-title"
            className="w-full max-w-sm space-y-3 rounded-xl border border-border bg-background p-4 shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="workspace-empty-trash-title" className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <Trash2 className="h-4 w-4" />
              清空回收站
            </h2>
            <p className="text-[11px] leading-5 text-foreground">
              回收站里的 {trash.totals.count} 项（{formatBytes(trash.totals.bytes)}）会被<strong>永久删除，无法恢复</strong>。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmEmpty(false)}
                className="rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground hover:bg-muted"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void emptyTrashNow()}
                disabled={trashBusy}
                className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-2.5 py-1 text-[11px] font-medium text-white hover:bg-destructive/90 disabled:opacity-50"
              >
                {trashBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                永久删除
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {confirmScratch ? (
        <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-4" onMouseDown={() => setConfirmScratch(false)}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-clean-scratch-title"
            className="w-full max-w-sm space-y-3 rounded-xl border border-border bg-background p-4 shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <h2 id="workspace-clean-scratch-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Eraser className="h-4 w-4" />
              清理 scratch
            </h2>
            <p className="text-[11px] leading-5 text-foreground">
              scratch 里的 {formatBytes(usage.scratchBytes)} 中间产物会被<strong>永久删除，无法恢复</strong>。
            </p>
            <ul className="space-y-1 text-[10.5px] leading-4 text-muted-foreground">
              <li>· 包括脚本、临时表、渲染图和草稿 spec；</li>
              <li>· exports、inbox、我的资料不受影响；</li>
              <li>· 正在运行的回合（1 分钟内写过）与已钉住的条目会跳过。</li>
            </ul>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmScratch(false)}
                className="rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground hover:bg-muted"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void cleanScratchNow()}
                disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-md bg-destructive px-2.5 py-1 text-[11px] font-medium text-white hover:bg-destructive/90 disabled:opacity-50"
              >
                {loading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Eraser className="h-3 w-3" />}
                清理
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {preview ? (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm"
          onMouseDown={closePreview}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="workspace-preview-title"
            className="flex h-[min(82vh,760px)] w-full max-w-5xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-neutral-900"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-neutral-200 px-4 dark:border-neutral-800">
              <div className="min-w-0">
                <h2 id="workspace-preview-title" className="truncate text-sm font-semibold">{preview.title}</h2>
                {preview.truncated ? <p className="text-[10px] text-amber-600">文件较大，仅显示前 200,000 个字符</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {preview.kind === 'text'
                  && !preview.loading
                  && !preview.error
                  && !preview.truncated
                  && (editingText ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void saveText()}
                        disabled={savingText}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-blue-600 px-2.5 text-[11px] font-medium text-white transition hover:bg-blue-700 disabled:opacity-50"
                      >
                        {savingText ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                        保存
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingText(false);
                          setTextDraft('');
                        }}
                        disabled={savingText}
                        className="h-8 rounded-md px-2.5 text-[11px] font-medium text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
                      >
                        取消
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={startEditing}
                      className="h-8 rounded-md px-2.5 text-[11px] font-medium text-blue-600 transition hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
                    >
                      编辑
                    </button>
                  ))}
                {onFileOpen ? (
                  <button
                    type="button"
                    onClick={() => {
                      onFileOpen(preview.path);
                      setPreview(null);
                    }}
                    className="h-8 rounded-md px-2.5 text-[11px] font-medium text-blue-600 transition hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40"
                  >
                    在编辑器中打开
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={closePreview}
                  aria-label="关闭预览"
                  className="rounded-md p-2 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-neutral-100 dark:bg-neutral-950">
              {preview.loading ? (
                <div className="flex h-full items-center justify-center text-sm text-neutral-500">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  正在载入预览…
                </div>
              ) : preview.error ? (
                <div className="flex h-full items-center justify-center p-8 text-center text-sm text-red-600">{preview.error}</div>
              ) : preview.kind === 'text' && editingText ? (
                <textarea
                  value={textDraft}
                  onChange={(event) => setTextDraft(event.target.value)}
                  spellCheck={false}
                  aria-label="编辑文件内容"
                  className="h-full min-h-[60vh] w-full resize-none bg-white p-5 font-mono text-xs leading-6 text-neutral-800 outline-none dark:bg-neutral-950 dark:text-neutral-200"
                />
              ) : preview.kind === 'text' ? (
                <pre className="min-h-full whitespace-pre-wrap break-words bg-white p-5 font-mono text-xs leading-6 text-neutral-800 dark:bg-neutral-950 dark:text-neutral-200">{preview.text}</pre>
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
