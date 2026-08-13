import { useEffect, useRef, useState } from 'react';
import { Eye, FileUp, Loader2, Paperclip, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils.js';
import { prepareAttachments } from './dialogueApi';
import type { PreparedAttachment } from './dialogueTypes';

const MAX_FILES = 12;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function makeItem(file: File): PreparedAttachment {
  return {
    id: `${file.name}:${file.size}:${file.lastModified}:${crypto.randomUUID()}`,
    file,
    status: 'queued',
    previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
  };
}

export default function AttachmentManager({
  available,
  reason,
  items,
  onChange,
  onUseInComposer,
  composerTrigger = false,
}: {
  available: boolean;
  reason?: string;
  items: PreparedAttachment[];
  onChange: (items: PreparedAttachment[]) => void;
  onUseInComposer: (files: File[]) => void;
  composerTrigger?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => () => {
    items.forEach((item) => {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    });
  // Revoke the final snapshot only when the manager unmounts.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const addFiles = (files: File[]) => {
    setError('');
    if (!available) return;
    const remaining = Math.max(0, MAX_FILES - items.length);
    const accepted = files
      .filter((file) => {
        if (file.size > MAX_FILE_BYTES) {
          setError(`${file.name} 超过医疗解析 4 MB 限制。`);
          return false;
        }
        return true;
      })
      .slice(0, remaining);
    if (files.length > remaining) setError(`单批最多 ${MAX_FILES} 个附件。`);
    onChange([...items, ...accepted.map(makeItem)]);
  };

  const parseQueued = async () => {
    const queued = items.filter((item) => item.status === 'queued' || item.status === 'error');
    if (!queued.length) return;
    setError('');
    onChange(items.map((item) => queued.some(({ id }) => id === item.id)
      ? { ...item, status: 'parsing' as const, error: undefined }
      : item));
    try {
      const result = await prepareAttachments(queued);
      onChange(items.map((item) => queued.some(({ id }) => id === item.id)
        ? { ...item, status: 'ready' as const, result }
        : item));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '附件解析失败。';
      setError(message);
      onChange(items.map((item) => queued.some(({ id }) => id === item.id)
        ? { ...item, status: 'error' as const, error: message }
        : item));
    }
  };

  const clear = () => {
    items.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
    onChange([]);
  };

  return (
    <>
      <Button
        type="button"
        size={composerTrigger ? 'icon' : 'sm'}
        variant="outline"
        aria-label={composerTrigger ? '添加附件' : undefined}
        className={cn(
          composerTrigger
            ? 'medical-composer-add h-8 w-8 rounded-full p-0'
            : 'h-8 px-2.5 text-[11px]',
        )}
        disabled={!available}
        title={available ? '批量上传、解析和预览附件' : `附件解析未配置${reason ? `：${reason}` : ''}`}
        onClick={() => setOpen(true)}
      >
        {composerTrigger ? <Plus className="h-4 w-4" /> : <Paperclip className="h-3.5 w-3.5" />}
        {composerTrigger ? (
          items.length ? <span className="medical-composer-add-count">{items.length}</span> : null
        ) : `附件${items.length ? ` ${items.length}` : ''}`}
      </Button>
      {open ? (
        <div className="medical-attachment-overlay fixed inset-0 z-[70] flex justify-end bg-black/20 backdrop-blur-[1px]">
          <button type="button" aria-label="关闭附件面板" className="absolute inset-0" onClick={() => setOpen(false)} />
          <aside className="medical-attachment-drawer relative flex h-full w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl">
            <header className="medical-attachment-header flex h-14 items-center gap-3 border-b border-border px-4">
              <FileUp className="h-4 w-4" />
              <div className="mr-auto">
                <h2 className="text-sm font-semibold">多源附件</h2>
                <p className="text-[10px] text-muted-foreground">sidecar 真实解析 · 最多 12 个 · 单文件 4 MB</p>
              </div>
              <Button size="icon" variant="ghost" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              <input
                ref={inputRef}
                type="file"
                multiple
                className="hidden"
                accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.json,.dcm,.nii,.gz"
                onChange={(event) => {
                  addFiles(Array.from(event.target.files || []));
                  event.target.value = '';
                }}
              />
              <button
                type="button"
                className="flex w-full flex-col items-center rounded-xl border border-dashed border-border p-6 text-[11px] text-muted-foreground hover:bg-muted/30"
                onClick={() => inputRef.current?.click()}
              >
                <FileUp className="mb-2 h-5 w-5" />
                选择图片、PDF、Office、表格、文本或医学数据
              </button>
              {error ? <div className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-[11px] text-destructive">{error}</div> : null}
              <div className="mt-3 space-y-2">
                {items.map((item) => (
                  <article key={item.id} className={cn(
                    'flex items-center gap-3 rounded-lg border p-2.5',
                    item.status === 'degraded' ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30' :
                    item.status === 'unsupported' ? 'border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950/20' :
                    item.status === 'error' ? 'border-destructive/30 bg-destructive/5' :
                    'border-border',
                  )}>
                    {item.previewUrl ? (
                      <img src={item.previewUrl} alt="" className="h-10 w-10 rounded object-cover" />
                    ) : <Eye className="h-4 w-4 text-muted-foreground" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[11px] font-medium">{item.file.name}</div>
                      <div className={cn(
                        'text-[9px]',
                        item.status === 'error' ? 'text-destructive' :
                        item.status === 'degraded' ? 'text-amber-600 dark:text-amber-400' :
                        item.status === 'unsupported' ? 'text-neutral-500' :
                        'text-muted-foreground',
                      )}>
                        {item.status === 'queued' ? '等待解析' :
                         item.status === 'parsing' ? '正在解析…' :
                         item.status === 'ready' ? '解析完成并已缓存' :
                         item.status === 'degraded' ? `降级解析${item.parseNote ? `：${item.parseNote}` : ''}` :
                         item.status === 'unsupported' ? `格式不支持${item.parseNote ? `：${item.parseNote}` : ''}` :
                         item.error || '未知状态'}
                      </div>
                    </div>
                    {item.status === 'parsing' ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {(item.status === 'error' || item.status === 'degraded') && (
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 text-amber-600"
                        title="重试解析"
                        onClick={() => {
                          onChange(items.map((prev) =>
                            prev.id === item.id ? { ...prev, status: 'queued' as const, error: undefined, parseNote: undefined } : prev,
                          ));
                          // Trigger re-parse will happen in next effect
                        }}
                      ><RotateCcw className="h-3 w-3" /></Button>
                    )}
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => {
                        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
                        onChange(items.filter(({ id }) => id !== item.id));
                      }}
                    ><Trash2 className="h-3.5 w-3.5" /></Button>
                  </article>
                ))}
              </div>
            </div>
            <footer className="grid grid-cols-3 gap-2 border-t border-border p-4">
              <Button variant="outline" disabled={!items.length} onClick={clear}>清空缓存</Button>
              <Button variant="outline" disabled={!items.some((item) => item.status !== 'ready')} onClick={() => void parseQueued()}>
                解析附件
              </Button>
              <Button
                disabled={!items.some((item) => item.status === 'ready')}
                onClick={() => {
                  onUseInComposer(items.filter((item) => item.status === 'ready').map((item) => item.file));
                  setOpen(false);
                }}
              >
                加入输入区
              </Button>
            </footer>
          </aside>
        </div>
      ) : null}
    </>
  );
}
