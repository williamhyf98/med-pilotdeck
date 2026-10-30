import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Contrast,
  Download,
  Maximize2,
  Move,
  RefreshCw,
  RotateCcw,
  Search,
  Shrink,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../../utils/api';
import type { CodeEditorFile } from '../../types/types';

type DicomMetadata = {
  ok: boolean;
  modality: string;
  bodyPart: string;
  rows: number;
  columns: number;
  totalFrames: number;
  pixelDataAvailable?: boolean;
  warnings: string[];
  errorCode?: string;
};

type CornerstoneResources = {
  renderingEngine: import('@cornerstonejs/core').RenderingEngine;
  viewport?: import('@cornerstonejs/core').StackViewport;
  toolGroupId: string;
  toolGroupCreated: boolean;
  fileIndex: number;
  host: HTMLDivElement;
  eventName?: string;
  onNewImage?: EventListener;
};

type CornerstoneRuntime = CornerstoneResources & {
  viewport: import('@cornerstonejs/core').StackViewport;
};

type PrimaryTool = 'windowLevel' | 'pan' | 'zoom';

let cornerstoneInitPromise: Promise<void> | null = null;
let viewerSequence = 0;
const DICOM_LOAD_TIMEOUT_MS = 30_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (reason) => {
        window.clearTimeout(timer);
        reject(reason);
      },
    );
  });
}

async function initializeCornerstone() {
  if (!cornerstoneInitPromise) {
    cornerstoneInitPromise = (async () => {
      const cornerstone = await import('@cornerstonejs/core');
      const dicomLoader = await import('@cornerstonejs/dicom-image-loader');
      const tools = await import('@cornerstonejs/tools');
      cornerstone.init();
      dicomLoader.init({ maxWebWorkers: Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)) });
      tools.init();
      for (const tool of [
        tools.WindowLevelTool,
        tools.PanTool,
        tools.ZoomTool,
        tools.StackScrollTool,
      ]) {
        try {
          tools.addTool(tool);
        } catch {
          // Tool classes are process-global and may already be registered.
        }
      }
    })().catch((error) => {
      cornerstoneInitPromise = null;
      throw error;
    });
  }
  return cornerstoneInitPromise;
}

async function readErrorResponse(response: Response): Promise<Error> {
  try {
    const body = await response.json();
    const warning = Array.isArray(body?.warnings) ? body.warnings[0] : '';
    return new Error(body?.error || warning || body?.code || `HTTP ${response.status}`);
  } catch {
    return new Error(`HTTP ${response.status}`);
  }
}

async function disposeCornerstoneResources(resources: CornerstoneResources) {
  if (resources.eventName && resources.onNewImage) {
    resources.host.removeEventListener(resources.eventName, resources.onNewImage);
  }

  const [tools, dicomLoader] = await Promise.all([
    import('@cornerstonejs/tools'),
    import('@cornerstonejs/dicom-image-loader'),
  ]);
  if (resources.toolGroupCreated) {
    try {
      tools.ToolGroupManager.destroyToolGroup(resources.toolGroupId);
    } catch {
      // The group may already have been released by Cornerstone shutdown.
    }
  }
  try {
    dicomLoader.wadouri.fileManager.remove(resources.fileIndex);
  } catch {
    // Ignore already-removed local file handles.
  }
  try {
    resources.renderingEngine.destroy();
  } catch {
    // Ignore already-destroyed engines during rapid file switches.
  }
}

function iconButtonClass(active = false) {
  return [
    'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
    active
      ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
      : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
  ].join(' ');
}

export default function DicomPreview({
  projectName,
  file,
  isFullscreen,
  onToggleFullscreen,
}: {
  projectName?: string;
  file: CodeEditorFile;
  isFullscreen: boolean;
  onToggleFullscreen?: (() => void) | null;
}) {
  const { t } = useTranslation('codeEditor');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<CornerstoneRuntime | null>(null);
  const [metadata, setMetadata] = useState<DicomMetadata | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [frameIndex, setFrameIndex] = useState(0);
  const [primaryTool, setPrimaryTool] = useState<PrimaryTool>('windowLevel');
  const [reloadKey, setReloadKey] = useState(0);

  const activatePrimaryTool = useCallback(async (tool: PrimaryTool) => {
    setPrimaryTool(tool);
    const runtime = runtimeRef.current;
    if (!runtime) return;
    const tools = await import('@cornerstonejs/tools');
    const group = tools.ToolGroupManager.getToolGroup(runtime.toolGroupId);
    if (!group) return;
    const toolNames = {
      windowLevel: tools.WindowLevelTool.toolName,
      pan: tools.PanTool.toolName,
      zoom: tools.ZoomTool.toolName,
    };
    Object.values(toolNames).forEach((name) => group.setToolPassive(name, { removeAllBindings: true }));
    group.setToolActive(toolNames[tool], {
      bindings: [{ mouseButton: tools.Enums.MouseBindings.Primary }],
    });
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !projectName) {
      setLoading(false);
      setError(t('dicomPreview.projectUnavailable'));
      return undefined;
    }

    const controller = new AbortController();
    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let ownedResources: CornerstoneResources | null = null;

    const releaseOwnedResources = () => {
      const resources = ownedResources;
      ownedResources = null;
      if (!resources) return;
      if (runtimeRef.current === resources) runtimeRef.current = null;
      void disposeCornerstoneResources(resources);
    };

    setLoading(true);
    setError(null);
    setMetadata(null);
    setFrameIndex(0);

    const start = async () => {
      const [metadataResponse, fileResponse] = await withTimeout(
        Promise.all([
          api.dicomPreviewMetadata(projectName, file.path, {
            maxFrames: 12,
            cacheKey: reloadKey,
            signal: controller.signal,
          }),
          api.readFileBlob(projectName, file.path, {
            cacheKey: reloadKey,
            signal: controller.signal,
          }),
        ]),
        DICOM_LOAD_TIMEOUT_MS,
        t('dicomPreview.requestTimedOut'),
      );
      let nextMetadata: DicomMetadata;
      try {
        nextMetadata = await metadataResponse.json() as DicomMetadata;
      } catch {
        throw new Error(t('dicomPreview.invalidMetadataResponse'));
      }
      if (disposed) return;
      setMetadata(nextMetadata);
      if (!metadataResponse.ok) {
        throw new Error(
          nextMetadata.warnings?.[0]
          || nextMetadata.errorCode
          || `HTTP ${metadataResponse.status}`,
        );
      }
      if (!fileResponse.ok) throw await readErrorResponse(fileResponse);
      if (!nextMetadata.pixelDataAvailable) {
        throw new Error(nextMetadata.warnings?.[0] || t('dicomPreview.noPixelData'));
      }
      const blob = await fileResponse.blob();
      if (disposed) return;

      await withTimeout(
        initializeCornerstone(),
        DICOM_LOAD_TIMEOUT_MS,
        t('dicomPreview.initializeTimedOut'),
      );
      const cornerstone = await import('@cornerstonejs/core');
      const dicomLoader = await import('@cornerstonejs/dicom-image-loader');
      const tools = await import('@cornerstonejs/tools');
      if (disposed) return;

      const instanceId = ++viewerSequence;
      const renderingEngineId = `dicom-rendering-${instanceId}`;
      const viewportId = `dicom-viewport-${instanceId}`;
      const toolGroupId = `dicom-tools-${instanceId}`;
      const baseImageId = dicomLoader.wadouri.fileManager.add(blob);
      const fileIndex = Number(baseImageId.split(':')[1]);
      const totalFrames = Math.max(1, Number(nextMetadata.totalFrames) || 1);
      const imageIds = totalFrames === 1
        ? [baseImageId]
        : Array.from({ length: totalFrames }, (_, index) => `${baseImageId}?frame=${index + 1}`);

      const renderingEngine = new cornerstone.RenderingEngine(renderingEngineId);
      ownedResources = {
        renderingEngine,
        toolGroupId,
        toolGroupCreated: false,
        fileIndex,
        host,
      };
      renderingEngine.enableElement({
        viewportId,
        type: cornerstone.Enums.ViewportType.STACK,
        element: host,
        defaultOptions: { background: [0, 0, 0] },
      });
      const viewport = renderingEngine.getViewport(viewportId) as import('@cornerstonejs/core').StackViewport;
      ownedResources.viewport = viewport;
      const toolGroup = tools.ToolGroupManager.createToolGroup(toolGroupId);
      if (!toolGroup) throw new Error(t('dicomPreview.initializeFailed'));
      ownedResources.toolGroupCreated = true;
      toolGroup.addTool(tools.WindowLevelTool.toolName);
      toolGroup.addTool(tools.PanTool.toolName);
      toolGroup.addTool(tools.ZoomTool.toolName);
      toolGroup.addTool(tools.StackScrollTool.toolName);
      toolGroup.addViewport(viewportId, renderingEngineId);
      toolGroup.setToolActive(tools.WindowLevelTool.toolName, {
        bindings: [{ mouseButton: tools.Enums.MouseBindings.Primary }],
      });
      toolGroup.setToolActive(tools.StackScrollTool.toolName, {
        bindings: [{ mouseButton: tools.Enums.MouseBindings.Wheel }],
      });

      const onNewImage: EventListener = (event) => {
        const detail = (event as CustomEvent<{ imageIdIndex?: number }>).detail;
        if (typeof detail?.imageIdIndex === 'number') setFrameIndex(detail.imageIdIndex);
        else setFrameIndex(viewport.getCurrentImageIdIndex());
      };
      const eventName = cornerstone.Enums.Events.STACK_NEW_IMAGE;
      host.addEventListener(eventName, onNewImage);
      ownedResources.eventName = eventName;
      ownedResources.onNewImage = onNewImage;
      runtimeRef.current = ownedResources as CornerstoneRuntime;
      await withTimeout(
        viewport.setStack(imageIds, 0),
        DICOM_LOAD_TIMEOUT_MS,
        t('dicomPreview.renderTimedOut'),
      );
      viewport.render();
      resizeObserver = new ResizeObserver(() => renderingEngine.resize(true, false));
      resizeObserver.observe(host);
      setLoading(false);
    };

    start().catch((nextError: Error & { name?: string }) => {
      controller.abort();
      releaseOwnedResources();
      if (disposed) return;
      setError(nextError.message || t('dicomPreview.failed'));
      setLoading(false);
    });

    return () => {
      disposed = true;
      controller.abort();
      resizeObserver?.disconnect();
      releaseOwnedResources();
    };
  }, [file.path, projectName, reloadKey, t]);

  const goToFrame = useCallback((next: number) => {
    const total = Math.max(1, metadata?.totalFrames || 1);
    const bounded = Math.max(0, Math.min(total - 1, next));
    setFrameIndex(bounded);
    void runtimeRef.current?.viewport.setImageIdIndex(bounded);
  }, [metadata?.totalFrames]);

  const resetViewport = useCallback(() => {
    const viewport = runtimeRef.current?.viewport;
    if (!viewport) return;
    viewport.resetProperties();
    viewport.resetCamera();
    viewport.render();
  }, []);

  const totalFrames = Math.max(1, metadata?.totalFrames || 1);
  const dimensions = metadata?.columns && metadata?.rows
    ? `${metadata.columns} x ${metadata.rows}`
    : t('dicomPreview.unknown');

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-black">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-950 px-3 py-1.5">
        <div className="flex min-w-0 items-center gap-2 text-[12px] text-neutral-300">
          <span className="font-medium text-white">{metadata?.modality || 'DICOM'}</span>
          <span className="text-neutral-600">|</span>
          <span>{metadata?.bodyPart || t('dicomPreview.unknown')}</span>
          <span className="text-neutral-600">|</span>
          <span>{dimensions}</span>
          <span className="text-neutral-600">|</span>
          <span>{t('dicomPreview.frameCount', { count: totalFrames })}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" className={iconButtonClass(primaryTool === 'windowLevel')} onClick={() => void activatePrimaryTool('windowLevel')} title={t('dicomPreview.windowLevel')} aria-label={t('dicomPreview.windowLevel')}>
            <Contrast className="h-4 w-4" />
          </button>
          <button type="button" className={iconButtonClass(primaryTool === 'pan')} onClick={() => void activatePrimaryTool('pan')} title={t('dicomPreview.pan')} aria-label={t('dicomPreview.pan')}>
            <Move className="h-4 w-4" />
          </button>
          <button type="button" className={iconButtonClass(primaryTool === 'zoom')} onClick={() => void activatePrimaryTool('zoom')} title={t('dicomPreview.zoom')} aria-label={t('dicomPreview.zoom')}>
            <Search className="h-4 w-4" />
          </button>
          <button type="button" className={iconButtonClass()} onClick={resetViewport} title={t('dicomPreview.reset')} aria-label={t('dicomPreview.reset')}>
            <RotateCcw className="h-4 w-4" />
          </button>
          <button type="button" className={iconButtonClass()} onClick={() => setReloadKey((value) => value + 1)} title={t('dicomPreview.refresh')} aria-label={t('dicomPreview.refresh')}>
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onToggleFullscreen ? (
            <button type="button" className={iconButtonClass()} onClick={onToggleFullscreen} title={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')} aria-label={isFullscreen ? t('actions.exitFullscreen') : t('actions.fullscreen')}>
              {isFullscreen ? <Shrink className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          ) : null}
          {projectName ? (
            <a className={iconButtonClass()} href={api.fileDownloadUrl(projectName, file.path)} download={file.name} title={t('actions.download')} aria-label={t('actions.download')}>
              <Download className="h-4 w-4" />
            </a>
          ) : null}
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <div ref={hostRef} className="h-full min-h-[240px] w-full touch-none select-none" />
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/85 text-[13px] text-neutral-300">
            {t('dicomPreview.loading')}
          </div>
        ) : null}
        {error ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950 px-6 text-center">
            <p className="text-[14px] font-medium text-neutral-100">{t('dicomPreview.failed')}</p>
            <p className="max-w-lg text-[12px] text-neutral-400">{error}</p>
            <div className="flex gap-2">
              <button type="button" onClick={() => setReloadKey((value) => value + 1)} className="rounded-md border border-neutral-700 px-3 py-1.5 text-[12px] text-neutral-200 hover:bg-neutral-800">
                {t('dicomPreview.retry')}
              </button>
              {projectName ? (
                <a href={api.fileDownloadUrl(projectName, file.path)} download={file.name} className="rounded-md border border-neutral-700 px-3 py-1.5 text-[12px] text-neutral-200 hover:bg-neutral-800">
                  {t('actions.download')}
                </a>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>

      {!error && !loading ? (
        <div className="flex min-h-12 shrink-0 items-center gap-3 border-t border-neutral-800 bg-neutral-950 px-3">
          <button type="button" className={iconButtonClass()} onClick={() => goToFrame(frameIndex - 1)} disabled={frameIndex <= 0} title={t('dicomPreview.previousFrame')} aria-label={t('dicomPreview.previousFrame')}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <input
            type="range"
            min={0}
            max={totalFrames - 1}
            value={frameIndex}
            onChange={(event) => goToFrame(Number(event.target.value))}
            className="min-w-0 flex-1 accent-blue-500"
            aria-label={t('dicomPreview.frameSlider')}
          />
          <span className="w-24 shrink-0 text-center text-[12px] tabular-nums text-neutral-300">
            {frameIndex + 1} / {totalFrames}
          </span>
          <button type="button" className={iconButtonClass()} onClick={() => goToFrame(frameIndex + 1)} disabled={frameIndex >= totalFrames - 1} title={t('dicomPreview.nextFrame')} aria-label={t('dicomPreview.nextFrame')}>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      {metadata?.warnings?.length ? (
        <div className="shrink-0 border-t border-amber-900/60 bg-amber-950/60 px-3 py-2 text-[11px] text-amber-200">
          {metadata.warnings.join(' ')}
        </div>
      ) : null}
    </div>
  );
}
