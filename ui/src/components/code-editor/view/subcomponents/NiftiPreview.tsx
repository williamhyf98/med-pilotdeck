import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Contrast, Download, Maximize2, Move,
  RefreshCw, RotateCcw, Search, Shrink,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../../utils/api';
import type { CodeEditorFile } from '../../types/types';

type Viewport = import('@cornerstonejs/core').StackViewport;
type Resources = {
  engine: import('@cornerstonejs/core').RenderingEngine;
  viewport: Viewport;
  groupId: string;
  imageIds: string[];
  host: HTMLDivElement;
  onImage: EventListener;
};
type PrimaryTool = 'windowLevel' | 'pan' | 'zoom';

let initPromise: Promise<void> | null = null;
let nextId = 0;

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('影像加载超时，请重试。')), milliseconds);
    promise.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

async function initialize() {
  if (!initPromise) {
    initPromise = (async () => {
      const [core, nifti, tools] = await Promise.all([
        import('@cornerstonejs/core'),
        import('@cornerstonejs/nifti-volume-loader'),
        import('@cornerstonejs/tools'),
      ]);
      await core.init();
      nifti.init();
      core.registerImageLoader('nifti', nifti.cornerstoneNiftiImageLoader);
      await tools.init();
      for (const tool of [tools.WindowLevelTool, tools.PanTool, tools.ZoomTool, tools.StackScrollTool]) {
        try {
          tools.addTool(tool);
        } catch {
          // Other viewers may already have registered these global tools.
        }
      }
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
  }
  return initPromise;
}

async function release(resources: Resources) {
  const [core, tools] = await Promise.all([
    import('@cornerstonejs/core'), import('@cornerstonejs/tools'),
  ]);
  resources.host.removeEventListener(core.Enums.Events.STACK_NEW_IMAGE, resources.onImage);
  tools.ToolGroupManager.destroyToolGroup(resources.groupId);
  resources.engine.destroy();
  // The NIfTI loader retains the entire decoded volume while an image stays cached.
  for (const id of resources.imageIds) {
    if (core.cache.getImageLoadObject(id)) core.cache.removeImageLoadObject(id);
  }
}

export default function NiftiPreview({
  projectName, file, isFullscreen, onToggleFullscreen,
}: {
  projectName?: string;
  file: CodeEditorFile;
  isFullscreen: boolean;
  onToggleFullscreen?: (() => void) | null;
}) {
  const { t } = useTranslation('codeEditor');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const resourcesRef = useRef<Resources | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [count, setCount] = useState(0);
  const [dimensions, setDimensions] = useState('');
  const [primary, setPrimary] = useState<PrimaryTool>('windowLevel');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const host = hostRef.current;
    if (!projectName || !host) {
      setLoading(false);
      setError('无法访问项目文件。');
      return;
    }
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let owned: Resources | null = null;
    const dispose = () => {
      if (!owned) return;
      const current = owned;
      owned = null;
      if (resourcesRef.current === current) resourcesRef.current = null;
      void release(current);
    };
    setLoading(true);
    setError(null);
    setIndex(0);
    setCount(0);
    setDimensions('');

    const start = async () => {
      await initialize();
      const [core, nifti, tools] = await Promise.all([
        import('@cornerstonejs/core'),
        import('@cornerstonejs/nifti-volume-loader'),
        import('@cornerstonejs/tools'),
      ]);
      if (disposed) return;
      const url = new URL(api.niftiPreviewUrl(projectName, file.path, reloadKey), window.location.href).href;
      const imageIds = await withTimeout(nifti.createNiftiImageIdsAndCacheMetadata({ url }), 90_000);
      if (disposed) {
        return;
      }
      if (!imageIds?.length) throw new Error('文件不是可读取的三维 NIfTI 影像。');
      const niftiMetadata = core.metaData.get('niftiHeader', imageIds[0]) as {
        header?: { dims?: number[]; numBitsPerVoxel?: number };
      } | undefined;
      const header = niftiMetadata?.header;
      const dims = header?.dims;
      if (dims && (dims[0] !== 3 || dims[4] > 1)) {
        throw new Error('当前预览仅支持三维 NIfTI 影像。');
      }
      const decodedBytes = dims && header?.numBitsPerVoxel
        ? dims[1] * dims[2] * dims[3] * header.numBitsPerVoxel / 8
        : 0;
      if (decodedBytes > 256 * 1024 * 1024) {
        throw new Error('解压后的影像超过 256 MB，请使用较小的体积文件预览。');
      }
      const pixel = core.metaData.get(core.Enums.MetadataModules.IMAGE_PIXEL, imageIds[0]);
      setDimensions(`${pixel.columns} × ${pixel.rows}`);
      setCount(imageIds.length);
      const serial = ++nextId;
      const engineId = `nifti-engine-${serial}`;
      const viewportId = `nifti-viewport-${serial}`;
      const groupId = `nifti-tools-${serial}`;
      const engine = new core.RenderingEngine(engineId);
      engine.enableElement({
        viewportId, type: core.Enums.ViewportType.STACK, element: host,
        defaultOptions: { background: [0, 0, 0] },
      });
      const viewport = engine.getViewport(viewportId) as Viewport;
      const onImage: EventListener = (event) => {
        const detail = (event as CustomEvent<{ imageIdIndex?: number }>).detail;
        setIndex(detail?.imageIdIndex ?? viewport.getCurrentImageIdIndex());
      };
      owned = { engine, viewport, groupId, imageIds, host, onImage };
      const group = tools.ToolGroupManager.createToolGroup(groupId);
      if (!group) throw new Error('无法创建影像操作工具。');
      for (const tool of [tools.WindowLevelTool, tools.PanTool, tools.ZoomTool, tools.StackScrollTool]) {
        group.addTool(tool.toolName);
      }
      group.addViewport(viewportId, engineId);
      group.setToolActive(tools.WindowLevelTool.toolName, {
        bindings: [{ mouseButton: tools.Enums.MouseBindings.Primary }],
      });
      group.setToolActive(tools.StackScrollTool.toolName, {
        bindings: [{ mouseButton: tools.Enums.MouseBindings.Wheel }],
      });
      host.addEventListener(core.Enums.Events.STACK_NEW_IMAGE, onImage);
      resourcesRef.current = owned;
      await withTimeout(viewport.setStack(imageIds, Math.floor(imageIds.length / 2)), 120_000);
      viewport.render();
      observer = new ResizeObserver(() => engine.resize(true, false));
      observer.observe(host);
      setIndex(viewport.getCurrentImageIdIndex());
      setLoading(false);
    };
    start().catch((reason: Error) => {
      dispose();
      if (!disposed) {
        setError(reason.message || '无法加载 NIfTI 影像。');
        setLoading(false);
      }
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      dispose();
    };
  }, [file.path, projectName, reloadKey]);

  const selectTool = useCallback(async (tool: PrimaryTool) => {
    setPrimary(tool);
    const resources = resourcesRef.current;
    if (!resources) return;
    const tools = await import('@cornerstonejs/tools');
    const group = tools.ToolGroupManager.getToolGroup(resources.groupId);
    if (!group) return;
    const names = {
      windowLevel: tools.WindowLevelTool.toolName,
      pan: tools.PanTool.toolName,
      zoom: tools.ZoomTool.toolName,
    };
    Object.values(names).forEach((name) => group.setToolPassive(name, { removeAllBindings: true }));
    group.setToolActive(names[tool], {
      bindings: [{ mouseButton: tools.Enums.MouseBindings.Primary }],
    });
  }, []);

  const selectSlice = (value: number) => {
    const next = Math.max(0, Math.min(count - 1, value));
    setIndex(next);
    void resourcesRef.current?.viewport.setImageIdIndex(next);
  };
  const reset = () => {
    const viewport = resourcesRef.current?.viewport;
    if (!viewport) return;
    viewport.resetProperties();
    viewport.resetCamera();
    viewport.render();
  };
  const button = 'flex h-8 w-8 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800 disabled:opacity-40';
  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-black">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-950 px-3 py-1.5">
        <div className="flex items-center gap-2 text-xs text-neutral-300">
          <strong className="text-white">NIfTI</strong><span>|</span>
          <span>{dimensions || '—'}</span><span>|</span>
          <span>{count ? `${count} 层` : '—'}</span>
        </div>
        <div className="flex items-center gap-1">
          {([
            ['windowLevel', Contrast, '窗宽 / 窗位'],
            ['pan', Move, '平移'],
            ['zoom', Search, '缩放'],
          ] as const).map(([tool, Icon, label]) => (
            <button key={tool} type="button" className={`${button} ${primary === tool ? 'bg-neutral-100 text-neutral-900' : ''}`}
              onClick={() => void selectTool(tool)} title={label} aria-label={label}><Icon className="h-4 w-4" /></button>
          ))}
          <button type="button" className={button} onClick={reset} title="重置视图" aria-label="重置视图"><RotateCcw className="h-4 w-4" /></button>
          <button type="button" className={button} onClick={() => setReloadKey((key) => key + 1)} title="刷新影像" aria-label="刷新影像"><RefreshCw className="h-4 w-4" /></button>
          {onToggleFullscreen && (
            <button type="button" className={button} onClick={onToggleFullscreen} title={isFullscreen ? '退出全屏' : '全屏'} aria-label={isFullscreen ? '退出全屏' : '全屏'}>
              {isFullscreen ? <Shrink className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </button>
          )}
          <a className={button} href={api.fileDownloadUrl(projectName!, file.path)} download={file.name} title={t('actions.download')} aria-label={t('actions.download')}>
            <Download className="h-4 w-4" />
          </a>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden bg-black">
        <div ref={hostRef} className="h-full min-h-[240px] w-full touch-none select-none" />
        {loading && <div className="absolute inset-0 flex items-center justify-center bg-black/85 text-sm text-neutral-300">正在加载 NIfTI 影像…</div>}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-neutral-950 p-6 text-center text-sm text-neutral-200">
            <span>{error}</span>
            <button type="button" className="rounded border border-neutral-700 px-3 py-1" onClick={() => setReloadKey((key) => key + 1)}>重试</button>
          </div>
        )}
      </div>
      {!loading && !error && count > 0 && (
        <div className="flex min-h-12 shrink-0 items-center gap-3 border-t border-neutral-800 bg-neutral-950 px-3">
          <button type="button" className={button} onClick={() => selectSlice(index - 1)} disabled={index <= 0} aria-label="上一层"><ChevronLeft className="h-4 w-4" /></button>
          <input className="min-w-0 flex-1 accent-blue-500" type="range" min={0} max={count - 1} value={index}
            onChange={(event) => selectSlice(Number(event.target.value))} aria-label="NIfTI 切片" />
          <span className="w-24 shrink-0 text-center text-xs tabular-nums text-neutral-300">{index + 1} / {count}</span>
          <button type="button" className={button} onClick={() => selectSlice(index + 1)} disabled={index >= count - 1} aria-label="下一层"><ChevronRight className="h-4 w-4" /></button>
        </div>
      )}
    </div>
  );
}
