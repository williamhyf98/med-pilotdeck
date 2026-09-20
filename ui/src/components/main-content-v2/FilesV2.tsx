import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  File,
  FileImage,
  FileSpreadsheet,
  FileText,
  FolderOutput,
  Inbox,
  Loader2,
  RefreshCw,
  Upload,
  X,
} from 'lucide-react';
import type { Project } from '../../types/app';
import { cn } from '../../lib/utils.js';
import { api } from '../../utils/api';
import { useFileTreeData } from '../file-tree/hooks/useFileTreeData';
import type { FileTreeNode } from '../file-tree/types/types';
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

type VisibleFile = {
  name: string;
  path: string;
  relativePath: string;
  size: number;
  modified: string | null;
};

const FILE_KIND_STYLES = {
  image: 'bg-violet-50 text-violet-600 dark:bg-violet-950/45 dark:text-violet-300',
  document: 'bg-blue-50 text-blue-600 dark:bg-blue-950/45 dark:text-blue-300',
  sheet: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/45 dark:text-emerald-300',
  default: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800 dark:text-neutral-300',
} as const;

function flattenFiles(root: FileTreeNode | undefined): VisibleFile[] {
  if (!root) return [];
  const output: VisibleFile[] = [];
  const visit = (nodes: FileTreeNode[], parents: string[]) => {
    nodes.forEach((node) => {
      if (node.type === 'directory') {
        visit(node.children ?? [], [...parents, node.name]);
        return;
      }
      output.push({
        name: node.name,
        path: node.path,
        relativePath: [...parents, node.name].join('/'),
        size: typeof node.size === 'number' ? node.size : 0,
        modified: typeof node.modified === 'string' ? node.modified : null,
      });
    });
  };
  visit(root.children ?? [], []);
  return output.sort((left, right) => {
    const byTime = Date.parse(right.modified ?? '') - Date.parse(left.modified ?? '');
    return Number.isFinite(byTime) && byTime !== 0
      ? byTime
      : left.relativePath.localeCompare(right.relativePath, 'zh-CN');
  });
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  const scaled = value / (1024 ** index);
  return `${scaled >= 100 || index === 0 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
}

function fileKind(name: string): keyof typeof FILE_KIND_STYLES {
  const extension = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'dcm'].includes(extension)) return 'image';
  if (['xls', 'xlsx', 'csv', 'tsv', 'et'].includes(extension)) return 'sheet';
  if (['pdf', 'doc', 'docx', 'ppt', 'pptx', 'md', 'txt', 'rtf'].includes(extension)) return 'document';
  return 'default';
}

function FileKindIcon({ name }: { name: string }) {
  const kind = fileKind(name);
  if (kind === 'image') return <FileImage className="h-4 w-4" strokeWidth={1.8} />;
  if (kind === 'sheet') return <FileSpreadsheet className="h-4 w-4" strokeWidth={1.8} />;
  if (kind === 'document') return <FileText className="h-4 w-4" strokeWidth={1.8} />;
  return <File className="h-4 w-4" strokeWidth={1.8} />;
}

function FileSection({
  title,
  description,
  icon,
  files,
  activeFilePath,
  emptyText,
  onOpen,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  files: VisibleFile[];
  activeFilePath?: string | null;
  emptyText: string;
  onOpen: (file: VisibleFile) => void;
}) {
  return (
    <section className="min-h-0">
      <div className="mb-2 flex items-center justify-between gap-3 px-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-muted-foreground">{icon}</span>
          <div className="min-w-0">
            <h3 className="text-[12px] font-semibold leading-4 text-foreground">{title}</h3>
            <p className="truncate text-[10px] leading-4 text-muted-foreground">{description}</p>
          </div>
        </div>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {files.length}
        </span>
      </div>

      {files.length > 0 ? (
        <div className="grid grid-cols-1 gap-1.5">
          {files.map((file) => {
            const active = activeFilePath === file.path;
            return (
              <button
                key={file.path}
                type="button"
                onClick={() => onOpen(file)}
                title={file.relativePath}
                aria-pressed={active}
                className={cn(
                  'group flex min-h-[52px] w-full items-center gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors',
                  active
                    ? 'border-blue-300 bg-blue-50/90 shadow-sm dark:border-blue-700 dark:bg-blue-950/55'
                    : 'border-border/75 bg-background/65 hover:border-border hover:bg-accent/70',
                )}
              >
                <span className={cn(
                  'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                  FILE_KIND_STYLES[fileKind(file.name)],
                )}
                >
                  <FileKindIcon name={file.name} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] font-medium text-foreground">{file.name}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                    {formatBytes(file.size)}{file.relativePath !== file.name ? ` · ${file.relativePath}` : ''}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border/80 px-3 py-5 text-center text-[11px] leading-5 text-muted-foreground">
          {emptyText}
        </div>
      )}
    </section>
  );
}

export default function FilesV2({
  selectedProject,
  onFileOpen,
  activeFilePath,
  onClose,
}: FilesV2Props) {
  const { files, loading, refreshFiles } = useFileTreeData(selectedProject);
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setNotice(null);
  }, [selectedProject?.name]);

  useEffect(() => {
    const handleFileUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectName?: string }>).detail;
      if (!detail?.projectName || detail.projectName === selectedProject?.name) {
        refreshFiles();
      }
    };
    window.addEventListener('pilotdeck:file-updated', handleFileUpdated);
    window.addEventListener('pilotdeck:files-changed', handleFileUpdated);
    return () => {
      window.removeEventListener('pilotdeck:file-updated', handleFileUpdated);
      window.removeEventListener('pilotdeck:files-changed', handleFileUpdated);
    };
  }, [refreshFiles, selectedProject?.name]);

  const uploadedFiles = useMemo(
    () => flattenFiles(files.find((node) => node.type === 'directory' && node.name === 'inbox')),
    [files],
  );
  const generatedFiles = useMemo(
    () => flattenFiles(files.find((node) => node.type === 'directory' && node.name === 'exports')),
    [files],
  );

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
      refreshFiles();
      setNotice({ tone: 'success', text: `已上传 ${selectedFiles.length} 个文件` });
    } catch (error) {
      setNotice({
        tone: 'error',
        text: ensureUploadFailedMessage(error instanceof Error ? error.message : '未知错误'),
      });
    } finally {
      setUploading(false);
    }
  }, [refreshFiles, selectedProject?.name]);

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-muted-foreground">
        请先选择一个项目
      </div>
    );
  }

  return (
    <div className="workspace-panel-surface flex h-full min-h-0 flex-col overflow-hidden bg-background/82 backdrop-blur-sm">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold text-foreground">项目文件</h2>
          <p className="truncate text-[10px] text-muted-foreground">{selectedProject.displayName || selectedProject.name}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[11px] font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
          >
            {uploading
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Upload className="h-3.5 w-3.5" />}
            上传
          </button>
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
          <button
            type="button"
            onClick={refreshFiles}
            disabled={loading}
            aria-label="刷新文件"
            title="刷新文件"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭项目文件"
              title="关闭项目文件"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
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

        <div className="space-y-5">
          <FileSection
            title="上传文件"
            description="由你添加到当前项目的资料"
            icon={<Inbox className="h-4 w-4" strokeWidth={1.8} />}
            files={uploadedFiles}
            activeFilePath={activeFilePath}
            emptyText="还没有上传文件"
            onOpen={(file) => onFileOpen?.(file.path)}
          />
          <FileSection
            title="生成文件"
            description="由 Agent 输出到 exports 的文件"
            icon={<FolderOutput className="h-4 w-4" strokeWidth={1.8} />}
            files={generatedFiles}
            activeFilePath={activeFilePath}
            emptyText="还没有生成文件"
            onOpen={(file) => onFileOpen?.(file.path)}
          />
        </div>
      </div>
    </div>
  );
}
