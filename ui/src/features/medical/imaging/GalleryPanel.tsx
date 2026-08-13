import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Boxes,
  ChevronLeft,
  ChevronRight,
  Database,
  FileImage,
  FolderOpen,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils.js';
import {
  getGalleryCase,
  getGallerySlice,
  isUnavailableError,
  listGalleryCases,
  listGalleryDatasets,
} from './imagingApi';
import type {
  GalleryCase,
  GalleryCaseDetail,
  GalleryDataset,
  GalleryDatasetCollection,
  MedicalImageSlice,
} from './imagingApi';

export default function GalleryPanel() {
  const [collection, setCollection] = useState<GalleryDatasetCollection | null>(null);
  const [datasetsLoading, setDatasetsLoading] = useState(true);
  const [datasetsError, setDatasetsError] = useState('');
  const [unavailableReason, setUnavailableReason] = useState('');
  const [selectedDataset, setSelectedDataset] = useState<GalleryDataset | null>(null);
  const [cases, setCases] = useState<GalleryCase[]>([]);
  const [casesLoading, setCasesLoading] = useState(false);
  const [casesError, setCasesError] = useState('');
  const [caseWarnings, setCaseWarnings] = useState<string[]>([]);
  const [selectedCase, setSelectedCase] = useState<GalleryCaseDetail | null>(null);
  const [caseLoading, setCaseLoading] = useState(false);
  const [caseError, setCaseError] = useState('');
  const [slice, setSlice] = useState<MedicalImageSlice | null>(null);
  const [sliceIndex, setSliceIndex] = useState(0);
  const [sliceLoading, setSliceLoading] = useState(false);

  const refreshDatasets = useCallback(async (signal?: AbortSignal) => {
    setDatasetsLoading(true);
    setDatasetsError('');
    setUnavailableReason('');
    try {
      const next = await listGalleryDatasets(signal);
      setCollection(next);
      if (!next.available) setUnavailableReason(next.reason || 'gallery_unavailable');
    } catch (cause) {
      if (!signal?.aborted) {
        if (isUnavailableError(cause)) {
          setUnavailableReason(cause.reason || cause.message);
        } else {
          setDatasetsError(errorMessage(cause, 'Gallery 数据集加载失败。'));
        }
      }
    } finally {
      if (!signal?.aborted) setDatasetsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refreshDatasets(controller.signal);
    return () => controller.abort();
  }, [refreshDatasets]);

  const openDataset = async (dataset: GalleryDataset) => {
    if (!dataset.available) return;
    setSelectedDataset(dataset);
    setCases([]);
    setSelectedCase(null);
    setSlice(null);
    setCasesLoading(true);
    setCasesError('');
    setCaseError('');
    setCaseWarnings([]);
    try {
      const result = await listGalleryCases(dataset.datasetId);
      setCases(result.cases);
      setCaseWarnings(result.warnings);
    } catch (cause) {
      setCasesError(errorMessage(cause, 'Gallery 病例列表加载失败。'));
    } finally {
      setCasesLoading(false);
    }
  };

  const loadSlice = async (
    detail: GalleryCaseDetail,
    requestedIndex: number,
  ) => {
    const maximum = Math.max(0, detail.sliceCount - 1);
    const normalized = Math.min(maximum, Math.max(0, Math.trunc(requestedIndex)));
    setSliceIndex(normalized);
    setSliceLoading(true);
    setCaseError('');
    try {
      setSlice(await getGallerySlice(detail.datasetId, detail.caseId, normalized));
    } catch (cause) {
      setSlice(null);
      setCaseError(errorMessage(cause, 'Gallery 切片加载失败。'));
    } finally {
      setSliceLoading(false);
    }
  };

  const openCase = async (medicalCase: GalleryCase) => {
    setCaseLoading(true);
    setCaseError('');
    setSlice(null);
    try {
      const detail = await getGalleryCase(medicalCase.datasetId, medicalCase.caseId);
      setSelectedCase(detail);
      setSliceIndex(detail.thumbnailIndex);
      await loadSlice(detail, detail.thumbnailIndex);
    } catch (cause) {
      setSelectedCase(null);
      setCaseError(errorMessage(cause, 'Gallery 病例详情加载失败。'));
    } finally {
      setCaseLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <article className="rounded-xl border border-border bg-background p-3">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700 dark:text-violet-300">
            <Boxes className="h-4 w-4" />
          </span>
          <div className="mr-auto">
            <h3 className="text-[12px] font-semibold">3D Gallery</h3>
            <p className="text-[10px] text-muted-foreground">配置数据集 · 病例目录 · 非诊断级切片</p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 text-[10px]"
            disabled={datasetsLoading}
            onClick={() => void refreshDatasets()}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', datasetsLoading && 'animate-spin')} />
            刷新数据集
          </Button>
        </div>
      </article>

      {datasetsLoading ? (
        <StateCard icon={<Loader2 className="animate-spin" />}>正在读取 Gallery 数据集…</StateCard>
      ) : unavailableReason ? (
        <StateCard tone="warning" icon={<AlertTriangle />}>
          Gallery 不可用：{humanReason(unavailableReason)}
        </StateCard>
      ) : datasetsError ? (
        <StateCard tone="error" icon={<AlertTriangle />}>{datasetsError}</StateCard>
      ) : !collection?.datasets.length ? (
        <StateCard icon={<Database />}>后端未配置 Gallery 数据集。</StateCard>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[190px_190px_minmax(0,1fr)]">
          <aside className="rounded-xl border border-border bg-background p-3">
            <h3 className="mb-2 text-[11px] font-semibold">数据集</h3>
            <div className="max-h-[520px] space-y-1.5 overflow-y-auto">
              {collection.datasets.map((dataset) => (
                <button
                  key={dataset.datasetId}
                  type="button"
                  disabled={!dataset.available}
                  className={cn(
                    'w-full rounded-lg border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-55',
                    selectedDataset?.datasetId === dataset.datasetId
                      ? 'border-violet-500/40 bg-violet-500/[0.06]'
                      : 'border-border hover:bg-muted/40',
                  )}
                  onClick={() => void openDataset(dataset)}
                >
                  <p className="truncate text-[10px] font-medium">{dataset.label}</p>
                  <p className="mt-1 text-[9px] text-muted-foreground">
                    {dataset.modality} · {dataset.caseCount ?? '未知'} 病例
                  </p>
                  <p className="mt-1 truncate text-[9px] text-muted-foreground">
                    {dataset.available ? `${dataset.version} · ${dataset.licenseId}` : '数据集目录不可用'}
                  </p>
                </button>
              ))}
            </div>
          </aside>

          <aside className="rounded-xl border border-border bg-background p-3">
            <h3 className="mb-2 text-[11px] font-semibold">病例</h3>
            {!selectedDataset ? (
              <SmallState icon={<FolderOpen />}>请先选择数据集。</SmallState>
            ) : casesLoading ? (
              <SmallState icon={<Loader2 className="animate-spin" />}>正在读取病例…</SmallState>
            ) : casesError ? (
              <SmallState tone="error" icon={<AlertTriangle />}>{casesError}</SmallState>
            ) : cases.length === 0 ? (
              <SmallState icon={<FolderOpen />}>该数据集没有可浏览病例。</SmallState>
            ) : (
              <div className="max-h-[520px] space-y-1.5 overflow-y-auto">
                {cases.map((medicalCase) => (
                  <button
                    key={medicalCase.caseId}
                    type="button"
                    className={cn(
                      'w-full rounded-lg border p-2.5 text-left transition-colors',
                      selectedCase?.caseId === medicalCase.caseId
                        ? 'border-violet-500/40 bg-violet-500/[0.06]'
                        : 'border-border hover:bg-muted/40',
                    )}
                    onClick={() => void openCase(medicalCase)}
                  >
                    <p className="truncate text-[10px] font-medium">{medicalCase.caseId}</p>
                    <p className="mt-1 text-[9px] text-muted-foreground">
                      {medicalCase.sliceCount} 切片 · {medicalCase.modality}
                    </p>
                  </button>
                ))}
              </div>
            )}
            {caseWarnings.length ? (
              <p className="mt-2 text-[9px] leading-4 text-amber-700 dark:text-amber-300">
                {caseWarnings.join('；')}
              </p>
            ) : null}
          </aside>

          <article className="min-w-0 rounded-xl border border-border bg-background p-3">
            {caseLoading && !selectedCase ? (
              <StateCard compact icon={<Loader2 className="animate-spin" />}>正在加载病例详情…</StateCard>
            ) : !selectedCase ? (
              <StateCard compact icon={<FileImage />}>选择病例后浏览切片。</StateCard>
            ) : (
              <div className="space-y-3">
                <div>
                  <h3 className="text-[12px] font-semibold">{selectedCase.caseId}</h3>
                  <p className="mt-1 text-[9px] text-muted-foreground">
                    {selectedCase.datasetId} · {selectedCase.modality} · {selectedCase.sliceCount} 切片
                    {selectedCase.reportAvailable ? ' · 报告存在但正文不暴露' : ''}
                  </p>
                </div>

                <div className="overflow-hidden rounded-lg border border-border bg-black/90">
                  <div className="flex min-h-72 items-center justify-center">
                    {sliceLoading ? (
                      <div className="flex flex-col items-center gap-2 text-[10px] text-white/70">
                        <Loader2 className="h-5 w-5 animate-spin" />
                        正在读取 Gallery 切片…
                      </div>
                    ) : slice ? (
                      <img
                        src={`data:${slice.mediaType};base64,${slice.data}`}
                        alt={`Gallery 切片 ${slice.index}`}
                        className="max-h-[430px] max-w-full object-contain"
                        onError={() => setCaseError(
                          'Gallery 切片图片无法解码；请检查后端代理是否截断了 sidecar 的 base64 预览。',
                        )}
                      />
                    ) : (
                      <span className="text-[10px] text-white/60">尚未加载切片</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 border-t border-white/10 bg-black/80 p-2">
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      className="h-7 w-7"
                      aria-label="上一 Gallery 切片"
                      disabled={sliceLoading || sliceIndex <= 0}
                      onClick={() => void loadSlice(selectedCase, sliceIndex - 1)}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <span className="text-[9px] text-white/70">
                      {slice?.index ?? sliceIndex} / {Math.max(0, selectedCase.sliceCount - 1)}
                    </span>
                    <Button
                      type="button"
                      size="icon"
                      variant="secondary"
                      className="ml-auto h-7 w-7"
                      aria-label="下一 Gallery 切片"
                      disabled={sliceLoading || sliceIndex >= selectedCase.sliceCount - 1}
                      onClick={() => void loadSlice(selectedCase, sliceIndex + 1)}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>

                {caseError ? <Message tone="error">{caseError}</Message> : null}
                {[...selectedCase.warnings, ...(slice?.warnings || [])].length ? (
                  <Message tone="warning">
                    {[...selectedCase.warnings, ...(slice?.warnings || [])].join('；')}
                  </Message>
                ) : (
                  <p className="text-[9px] leading-4 text-muted-foreground">
                    Gallery 切片会由 sidecar 重新编码，未评估烧录文字或 PHI，不用于诊断。
                  </p>
                )}
              </div>
            )}
          </article>
        </div>
      )}
    </div>
  );
}

function StateCard({
  icon,
  tone = 'muted',
  compact = false,
  children,
}: {
  icon: React.ReactElement;
  tone?: 'muted' | 'warning' | 'error';
  compact?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border p-5 text-center text-[10px]',
      compact ? 'min-h-64' : 'min-h-32',
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

function SmallState({
  icon,
  tone = 'muted',
  children,
}: {
  icon: React.ReactElement;
  tone?: 'muted' | 'error';
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'flex min-h-28 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border p-3 text-center text-[9px]',
      tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
    )}>
      {icon}
      {children}
    </div>
  );
}

function Message({
  tone,
  children,
}: {
  tone: 'warning' | 'error';
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'rounded-lg border px-3 py-2 text-[9px] leading-4',
      tone === 'warning'
        ? 'border-amber-500/20 bg-amber-500/[0.06] text-amber-700 dark:text-amber-300'
        : 'border-destructive/20 bg-destructive/[0.06] text-destructive',
    )}>
      {children}
    </div>
  );
}

function humanReason(reason: string): string {
  const known: Record<string, string> = {
    feature_disabled: '功能未启用',
    data_root_not_configured: 'data.root 未配置',
    gallery_root_unreadable: 'Gallery 根目录不可读',
    gallery_unavailable: 'Gallery 未就绪',
    not_configured: 'Sidecar 未配置',
    not_supported: '当前 Sidecar 不支持',
  };
  return known[reason] || reason;
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
