import { createPortal } from 'react-dom';
import { Download, File, Folder, Trash2, X } from 'lucide-react';
import { useEffect } from 'react';

export type WorkspaceActionEntry = {
  name: string;
  path: string;
  type: 'directory' | 'file';
};

type WorkspaceFileContextMenuProps = {
  entry: WorkspaceActionEntry;
  x: number;
  y: number;
  onDownload: () => void;
  onDelete: () => void;
  onClose: () => void;
};

const MENU_WIDTH = 176;
const MENU_HEIGHT = 80;
const MENU_MARGIN = 8;

function clampMenuPosition(x: number, y: number) {
  return {
    x: Math.max(MENU_MARGIN, Math.min(x, window.innerWidth - MENU_WIDTH - MENU_MARGIN)),
    y: Math.max(MENU_MARGIN, Math.min(y, window.innerHeight - MENU_HEIGHT - MENU_MARGIN)),
  };
}

export function WorkspaceFileContextMenu({
  entry,
  x,
  y,
  onDownload,
  onDelete,
  onClose,
}: WorkspaceFileContextMenuProps) {
  const position = clampMenuPosition(x, y);

  useEffect(() => {
    const close = () => onClose();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [onClose]);

  return createPortal(
    <div
      role="menu"
      aria-label={`文件操作菜单：${entry.name}`}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      className="fixed z-[10001] w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
      style={{ left: position.x, top: position.y }}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onDownload();
        }}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800"
      >
        <Download className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
        <span>下载</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose();
          onDelete();
        }}
        className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
      >
        <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
        <span>删除</span>
      </button>
    </div>,
    document.body,
  );
}

type WorkspaceDeleteDialogProps = {
  entry: WorkspaceActionEntry | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function WorkspaceDeleteDialog({
  entry,
  busy,
  onCancel,
  onConfirm,
}: WorkspaceDeleteDialogProps) {
  if (!entry) return null;

  const Icon = entry.type === 'directory' ? Folder : File;
  return createPortal(
    <div
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/45 p-4"
      onMouseDown={onCancel}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="workspace-file-delete-title"
        className="w-full max-w-sm space-y-3 rounded-xl border border-border bg-background p-4 shadow-xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="workspace-file-delete-title" className="flex items-center gap-2 text-sm font-semibold text-destructive">
          <Trash2 className="h-4 w-4" />
          删除{entry.type === 'directory' ? '目录' : '文件'}
        </h2>
        <p className="flex items-center gap-2 text-[12px] leading-5 text-foreground">
          <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate" title={entry.path}>{entry.name}</span>
        </p>
        <p className="text-[11px] leading-5 text-muted-foreground">
          删除后会先移入回收站，7 天内可以恢复。
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-2.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" />
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive px-2.5 text-[11px] font-medium text-white hover:bg-destructive/90 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            {busy ? '处理中…' : '移入回收站'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
