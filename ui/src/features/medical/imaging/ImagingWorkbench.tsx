import { useEffect, useState } from 'react';
import {
  Boxes,
  BrainCircuit,
  Loader2,
  ScanLine,
  Settings2,
} from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import GalleryPanel from './GalleryPanel';
import ImagingMetadataAdvanced from './ImagingMetadataAdvanced';
import {
  loadImagingBackendStatus,
} from './imagingApi';
import type {
  CapabilityAvailability,
  ImagingBackendStatus,
} from './imagingApi';
import M3dPanel from './M3dPanel';
import VolumePanel from './VolumePanel';

type ImagingPage = 'volume' | 'gallery' | 'm3d' | 'advanced';

const PAGES: Array<{
  id: ImagingPage;
  label: string;
  icon: typeof ScanLine;
}> = [
  { id: 'volume', label: 'Volume', icon: ScanLine },
  { id: 'gallery', label: 'Gallery', icon: Boxes },
  { id: 'm3d', label: 'M3D', icon: BrainCircuit },
  { id: 'advanced', label: '高级校验', icon: Settings2 },
];

export default function ImagingWorkbench() {
  const [page, setPage] = useState<ImagingPage>('volume');
  const [backend, setBackend] = useState<ImagingBackendStatus | null>(null);
  const [backendError, setBackendError] = useState('');
  const [selectedVolumeId, setSelectedVolumeId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void loadImagingBackendStatus(controller.signal)
      .then(setBackend)
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setBackendError(cause instanceof Error ? cause.message : '影像能力状态加载失败。');
        }
      });
    return () => controller.abort();
  }, []);

  return (
    <div className="space-y-4">
      <BackendStatus status={backend} error={backendError} />

      <nav className="grid grid-cols-4 rounded-lg border border-border bg-muted/30 p-1" aria-label="影像工作台">
        {PAGES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={cn(
              'flex items-center justify-center gap-1.5 rounded-md px-2 py-2 text-[10px] transition-colors',
              page === id
                ? 'bg-background font-medium shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => setPage(id)}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </nav>

      {page === 'volume' ? (
        <VolumePanel onSelectedVolume={setSelectedVolumeId} />
      ) : page === 'gallery' ? (
        <GalleryPanel />
      ) : page === 'm3d' ? (
        <M3dPanel selectedVolumeId={selectedVolumeId} />
      ) : (
        <ImagingMetadataAdvanced />
      )}
    </div>
  );
}

function BackendStatus({
  status,
  error,
}: {
  status: ImagingBackendStatus | null;
  error: string;
}) {
  if (error) {
    return (
      <div className="rounded-lg border border-destructive/20 bg-destructive/[0.06] px-3 py-2 text-[10px] text-destructive">
        {error}
      </div>
    );
  }
  if (!status) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[10px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        正在读取 /api/medical 影像能力…
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-[10px]">
      <CapabilityPill label="Sidecar" value={status.sidecar} reason={status.reasons.sidecar} />
      <CapabilityPill label="Volume" value={status.volume} reason={status.reasons.volume} />
      <CapabilityPill label="Gallery" value={status.gallery} reason={status.reasons.gallery} />
      <CapabilityPill label="M3D" value={status.m3d} reason={status.reasons.m3d} />
      <span className="ml-auto text-muted-foreground">各页仍以真实接口响应为准</span>
    </div>
  );
}

function CapabilityPill({
  label,
  value,
  reason,
}: {
  label: string;
  value: CapabilityAvailability;
  reason?: string;
}) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-1',
        value === true
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : value === false
            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
            : 'bg-muted text-muted-foreground',
      )}
      title={reason}
    >
      {label} · {value === true ? '可用' : value === false ? '不可用' : '未报告'}
    </span>
  );
}
