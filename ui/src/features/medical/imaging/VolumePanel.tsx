import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  FileArchive,
  Loader2,
  RefreshCw,
  ScanLine,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { cn } from '../../../lib/utils.js';
import {
  deleteVolume,
  getVolume,
  getVolumeSlice,
  isUnavailableError,
  listVolumes,
  uploadVolume,
} from './imagingApi';
import type {
  MedicalImageSlice,
  VolumeCollection,
  VolumeRecord,
} from './imagingApi';

export default function VolumePanel({
  onSelectedVolume,
}: {
  onSelectedVolume?: (volumeId: string | null) => void;
}) {
  const [collection, setCollection] = useState<VolumeCollection | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [unavailableReason, setUnavailableReason] = useState('');
  const [selectedVolume, setSelectedVolume] = useState<VolumeRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [slice, setSlice] = useState<MedicalImageSlice | null>(null);
  const [sliceIndex, setSliceIndex] = useState(0);
  const [sliceLoading, setSliceLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [maxSlices, setMaxSlices] = useState('8');
  const [ttlSeconds, setTtlSeconds] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [notice, setNotice] = useState('');
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setListLoading(true);
    setListError('');
    setUnavailableReason('');
    try {
      const next = await listVolumes(signal);
      setCollection(next);
      if (!next.available) setUnavailableReason(next.reason || 'volume_unavailable');
    } catch (cause) {
      if (!signal?.aborted) {
        if (isUnavailableError(cause)) {
          setUnavailableReason(cause.reason || cause.message);
        } else {
          setListError(errorMessage(cause, 'Volume 列表加载失败。'));
        }
      }
    } finally {
      if (!signal?.aborted) setListLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const loadSlice = async (volume: VolumeRecord, requestedIndex: number) => {
    const maximum = Math.max(0, (volume.originalShape[0] || 1) - 1);
    const normalized = Math.min(maximum, Math.max(0, Math.trunc(requestedIndex)));
    setSliceIndex(normalized);
    setSliceLoading(true);
    setDetailError('');
    try {
      setSlice(await getVolumeSlice(volume.volumeId, normalized));
    } catch (cause) {
      setSlice(null);
      setDetailError(errorMessage(cause, 'Volume 切片加载失败。'));
    } finally {
      setSliceLoading(false);
    }
  };

  const openVolume = async (volumeId: string) => {
    setDetailLoading(true);
    setDetailError('');
    setNotice('');
    setDeleteConfirmation(false);
    setSlice(null);
    try {
      const detail = await getVolume(volumeId);
      setSelectedVolume(detail);
      onSelectedVolume?.(detail.volumeId);
      const initialIndex = defaultSliceIndex(detail);
      setSliceIndex(initialIndex);
      await loadSlice(detail, initialIndex);
    } catch (cause) {
      setSelectedVolume(null);
      onSelectedVolume?.(null);
      setDetailError(errorMessage(cause, 'Volume 详情加载失败。'));
    } finally {
      setDetailLoading(false);
    }
  };

  const handleUpload = async () => {
    if (!file) {
      setUploadError('请先选择 Volume 文件。');
      return;
    }
    const parsedSlices = Number(maxSlices);
    const parsedTtl = ttlSeconds.trim() ? Number(ttlSeconds) : undefined;
    if (!Number.isSafeInteger(parsedSlices) || parsedSlices < 1 || parsedSlices > 64) {
      setUploadError('预览切片数必须是 1 到 64 的整数。');
      return;
    }
    if (
      parsedTtl !== undefined
      && (!Number.isSafeInteger(parsedTtl) || parsedTtl < 1 || parsedTtl > 86_400)
    ) {
      setUploadError('TTL 必须是 1 到 86400 秒的整数，或留空使用后端默认值。');
      return;
    }

    setUploading(true);
    setUploadError('');
    setNotice('');
    try {
      const uploaded = await uploadVolume(file, {
        maxSlices: parsedSlices,
        ttlSeconds: parsedTtl,
      });
      const ttlNotice = uploaded.ttlOverrideAccepted === false
        ? '当前 /api/medical 未接受自定义 TTL，已使用 sidecar 默认 TTL。'
        : uploaded.retention.ttlSeconds
          ? `TTL ${uploaded.retention.ttlSeconds} 秒。`
          : 'TTL 由 sidecar 默认策略决定。';
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      await refresh();
      await openVolume(uploaded.volume.volumeId);
      setNotice(`Volume 已由后端接收。${ttlNotice}`);
    } catch (cause) {
      setUploadError(errorMessage(cause, 'Volume 上传失败。'));
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedVolume) return;
    setDeleting(true);
    setDetailError('');
    try {
      await deleteVolume(selectedVolume.volumeId);
      setSelectedVolume(null);
      setSlice(null);
      setDeleteConfirmation(false);
      onSelectedVolume?.(null);
      setNotice('Volume 已从后端删除。');
      await refresh();
    } catch (cause) {
      setDetailError(errorMessage(cause, 'Volume 删除失败。'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-3">
      <article className="rounded-xl border border-border bg-background p-4">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
            <Upload className="h-4 w-4" />
          </span>
          <div className="mr-auto">
            <h3 className="text-[12px] font-semibold">上传 Volume</h3>
            <p className="text-[10px] text-muted-foreground">.npy / .nii / .nii.gz · 最大 12 MB · TTL 存储</p>
          </div>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".npy,.nii,.nii.gz,application/octet-stream"
          className="hidden"
          aria-label="选择 Volume 文件"
          onChange={(event) => {
            setFile(event.target.files?.[0] || null);
            setUploadError('');
          }}
        />
        <button
          type="button"
          className="mt-3 flex w-full items-center gap-3 rounded-lg border border-dashed border-border p-3 text-left hover:bg-muted/30"
          onClick={() => fileInputRef.current?.click()}
        >
          <FileArchive className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[10px] font-medium">
              {file ? file.name : '选择 Volume 文件'}
            </span>
            <span className="block text-[9px] text-muted-foreground">
              {file ? formatBytes(file.size) : '文件仅在点击上传后发送到医疗后端'}
            </span>
          </span>
        </button>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-[9px] text-muted-foreground">
            预览切片数（1–64）
            <Input
              type="number"
              min={1}
              max={64}
              value={maxSlices}
              onChange={(event) => setMaxSlices(event.target.value)}
              className="mt-1 h-8 text-[10px]"
            />
          </label>
          <label className="text-[9px] text-muted-foreground">
            自定义 TTL 秒数（可留空）
            <Input
              type="number"
              min={1}
              max={86_400}
              value={ttlSeconds}
              onChange={(event) => setTtlSeconds(event.target.value)}
              placeholder="后端默认 900"
              className="mt-1 h-8 text-[10px]"
            />
          </label>
        </div>
        {uploadError ? <Message tone="error" className="mt-3">{uploadError}</Message> : null}
        <Button
          type="button"
          className="mt-3 w-full"
          disabled={!file || uploading || Boolean(unavailableReason)}
          onClick={() => void handleUpload()}
        >
          {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
          上传到 TTL Volume 存储
        </Button>
      </article>

      {notice ? <Message tone="success">{notice}</Message> : null}

      <div className="grid gap-3 lg:grid-cols-[250px_minmax(0,1fr)]">
        <aside className="rounded-xl border border-border bg-background p-3">
          <div className="mb-3 flex items-center gap-2">
            <div className="mr-auto">
              <h3 className="text-[12px] font-semibold">Volume 列表</h3>
              <p className="text-[9px] text-muted-foreground">
                {collection?.storage ? `存储模式：${collection.storage}` : '由后端报告存储状态'}
              </p>
            </div>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              aria-label="刷新 Volume"
              disabled={listLoading}
              onClick={() => void refresh()}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', listLoading && 'animate-spin')} />
            </Button>
          </div>
          {listLoading ? (
            <EmptyState icon={<Loader2 className="animate-spin" />}>正在读取 Volume…</EmptyState>
          ) : unavailableReason ? (
            <EmptyState tone="warning" icon={<AlertTriangle />}>
              Volume 不可用：{humanReason(unavailableReason)}
            </EmptyState>
          ) : listError ? (
            <EmptyState tone="error" icon={<AlertTriangle />}>{listError}</EmptyState>
          ) : !collection?.volumes.length ? (
            <EmptyState icon={<Database />}>后端当前没有 Volume。</EmptyState>
          ) : (
            <div className="max-h-[520px] space-y-1.5 overflow-y-auto">
              {collection.volumes.map((volume) => (
                <button
                  key={volume.volumeId}
                  type="button"
                  className={cn(
                    'w-full rounded-lg border p-2.5 text-left transition-colors',
                    selectedVolume?.volumeId === volume.volumeId
                      ? 'border-cyan-500/40 bg-cyan-500/[0.06]'
                      : 'border-border hover:bg-muted/40',
                  )}
                  onClick={() => void openVolume(volume.volumeId)}
                >
                  <p className="truncate text-[10px] font-medium">{volume.filename}</p>
                  <p className="mt-1 text-[9px] text-muted-foreground">
                    {shapeLabel(volume.originalShape)} · {formatBytes(volume.byteSize)}
                  </p>
                  {volume.expiresAt ? (
                    <p className="mt-1 flex items-center gap-1 text-[9px] text-muted-foreground">
                      <Clock3 className="h-3 w-3" />
                      到期 {formatTimestamp(volume.expiresAt)}
                    </p>
                  ) : null}
                </button>
              ))}
            </div>
          )}
        </aside>

        <article className="min-w-0 rounded-xl border border-border bg-background p-3">
          {detailLoading && !selectedVolume ? (
            <EmptyState icon={<Loader2 className="animate-spin" />}>正在加载 Volume 详情…</EmptyState>
          ) : !selectedVolume ? (
            <EmptyState icon={<ScanLine />}>从左侧选择 Volume 查看详情与切片。</EmptyState>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-start gap-2">
                <div className="mr-auto min-w-0">
                  <h3 className="truncate text-[12px] font-semibold">{selectedVolume.filename}</h3>
                  <p className="mt-1 text-[9px] text-muted-foreground">
                    {selectedVolume.volumeId} · {selectedVolume.modality} · {selectedVolume.extension}
                  </p>
                </div>
                {!deleteConfirmation ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 text-[10px] text-destructive"
                    onClick={() => setDeleteConfirmation(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-7 text-[10px]"
                      onClick={() => setDeleteConfirmation(false)}
                    >
                      取消
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className="h-7 text-[10px]"
                      disabled={deleting}
                      onClick={() => void handleDelete()}
                    >
                      {deleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      确认删除
                    </Button>
                  </>
                )}
              </div>

              <dl className="grid grid-cols-2 gap-2 text-[9px] sm:grid-cols-3 xl:grid-cols-6">
                <Metric label="Shape" value={shapeLabel(selectedVolume.originalShape)} />
                <Metric label="Spacing" value={shapeLabel(selectedVolume.spacing || []) || '未报告'} />
                <Metric
                  label="强度范围"
                  value={valueRangeLabel(selectedVolume.valueRange)}
                />
                <Metric label="预览切片" value={String(selectedVolume.previewSlices)} />
                <Metric label="大小" value={formatBytes(selectedVolume.byteSize)} />
                <Metric
                  label="保留"
                  value={selectedVolume.expiresAt ? formatTimestamp(selectedVolume.expiresAt) : '未报告'}
                />
              </dl>

              <div className="overflow-hidden rounded-lg border border-border bg-black/90">
                <div className="flex min-h-72 items-center justify-center">
                  {sliceLoading ? (
                    <div className="flex flex-col items-center gap-2 text-[10px] text-white/70">
                      <Loader2 className="h-5 w-5 animate-spin" />
                      正在读取轴位切片…
                    </div>
                  ) : slice ? (
                    <img
                      src={`data:${slice.mediaType};base64,${slice.data}`}
                      alt={`Volume 轴位切片 ${slice.sourceIndex}`}
                      className="max-h-[430px] max-w-full object-contain"
                      onError={() => setDetailError(
                        'Volume 切片图片无法解码；请检查后端代理是否截断了 sidecar 的 base64 预览。',
                      )}
                    />
                  ) : (
                    <span className="text-[10px] text-white/60">尚未加载切片</span>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-white/10 bg-black/80 p-2">
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="h-7 w-7"
                    aria-label="上一切片"
                    disabled={sliceLoading || sliceIndex <= 0}
                    onClick={() => void loadSlice(selectedVolume, sliceIndex - 1)}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Input
                    type="number"
                    min={0}
                    max={Math.max(0, (selectedVolume.originalShape[0] || 1) - 1)}
                    value={sliceIndex}
                    onChange={(event) => setSliceIndex(Number(event.target.value))}
                    aria-label="Volume 切片索引"
                    className="h-7 w-24 border-white/20 bg-white/10 text-[10px] text-white"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    className="h-7 text-[10px]"
                    disabled={sliceLoading}
                    onClick={() => void loadSlice(selectedVolume, sliceIndex)}
                  >
                    读取切片
                  </Button>
                  <span className="text-[9px] text-white/60">
                    轴位 {slice?.sourceIndex ?? sliceIndex} / {Math.max(0, (selectedVolume.originalShape[0] || 1) - 1)}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="secondary"
                    className="ml-auto h-7 w-7"
                    aria-label="下一切片"
                    disabled={
                      sliceLoading
                      || sliceIndex >= Math.max(0, (selectedVolume.originalShape[0] || 1) - 1)
                    }
                    onClick={() => void loadSlice(selectedVolume, sliceIndex + 1)}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              {detailError ? <Message tone="error">{detailError}</Message> : null}
              {slice?.warnings.length ? (
                <Message tone="warning">{slice.warnings.join('；')}</Message>
              ) : (
                <p className="text-[9px] leading-4 text-muted-foreground">
                  切片由后端归一化，仅用于工作流预览，不具备诊断级质量。
                </p>
              )}
            </div>
          )}
        </article>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/40 p-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-medium">{value}</dd>
    </div>
  );
}

function valueRangeLabel(value: number[] | null): string {
  if (!value || value.length < 2) return '未报告';
  return `${formatMetricNumber(value[0])} – ${formatMetricNumber(value[1])}`;
}

function formatMetricNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function EmptyState({
  icon,
  tone = 'muted',
  children,
}: {
  icon: React.ReactElement;
  tone?: 'muted' | 'warning' | 'error';
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-4 text-center text-[10px]',
      tone === 'error'
        ? 'text-destructive'
        : tone === 'warning'
          ? 'text-amber-700 dark:text-amber-300'
          : 'text-muted-foreground',
    )}>
      {icon}
      {children}
    </div>
  );
}

function Message({
  tone,
  className,
  children,
}: {
  tone: 'success' | 'warning' | 'error';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 text-[10px] leading-4',
      tone === 'success'
        ? 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-700 dark:text-emerald-300'
        : tone === 'warning'
          ? 'border-amber-500/20 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300'
          : 'border-destructive/20 bg-destructive/[0.06] text-destructive',
      className,
    )}>
      {children}
    </div>
  );
}

function defaultSliceIndex(volume: VolumeRecord): number {
  const fromPreview = volume.sourceSliceIndices[volume.thumbnailIndex];
  if (Number.isSafeInteger(fromPreview)) return fromPreview;
  return Math.max(0, Math.floor((volume.originalShape[0] || 1) / 2));
}

function shapeLabel(values: number[]): string {
  return values.length ? values.join(' × ') : '';
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未报告';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(value: string): string {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

function humanReason(reason: string): string {
  const known: Record<string, string> = {
    feature_disabled: '功能未启用',
    not_configured: 'Sidecar 未配置',
    not_supported: '当前 Sidecar 不支持',
    volume_unavailable: 'Volume 存储未就绪',
    request_failed: 'Sidecar 请求失败',
  };
  return known[reason] || reason;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
