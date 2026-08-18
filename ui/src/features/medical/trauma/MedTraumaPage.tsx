import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CircleAlert,
  CircleDot,
  Download,
  FileImage,
  GripVertical,
  Loader2,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { cn } from '../../../lib/utils.js';
import {
  MEDICAL_SAFETY_NOTE,
  TRAUMA_RESULT_SECTIONS,
  TRAUMA_STAGES,
} from '../shared/constants';
import type {
  TraumaImageCategoryId,
  TraumaResultSectionId,
  TraumaStageId,
  TraumaStreamState,
  MedicalPresetInfo,
} from '../shared/types';
import { fetchMedicalPresetInfo } from '../shared/medicalApi';
import { useMedicalModels } from '../shared/useMedicalModels';
import {
  loadTraumaDemoCase,
  loadTraumaDemoIndex,
  MedicalApiError,
  parseTraumaResultSections,
  probeTraumaModel,
  reorderImages,
  stopTraumaAnalysis,
  streamTraumaAnalysis,
} from './traumaApi';
import type {
  OrderedTraumaImage,
  TraumaDemoSummary,
  TraumaMode,
} from './traumaApi';
import './MedTraumaPage.css';

export type MedTraumaPageProps = {
  onOpenDialogue: () => void;
};

type LegacySkin = 'military' | 'field' | 'dark';

type Echelon = {
  id: 'e1' | 'e2' | 'e3' | 'e4';
  level: string;
  name: string;
  span: string;
  detail: string;
};

const EMPTY_RESULTS = Object.fromEntries(
  TRAUMA_RESULT_SECTIONS.map((section) => [section.id, '']),
) as Record<TraumaResultSectionId, string>;

const RECOVERY_KEY = 'pilotdeck.med-trauma.last-result.v1';
const SKIN_KEY = 'pilotdeck.med-trauma.skin.v1';

const CATEGORY_ORDER: TraumaImageCategoryId[] = ['wound', 'ecg', 'xray', 'ct', 'other'];
const CATEGORY_LABELS: Record<TraumaImageCategoryId, string> = {
  wound: '创面照片',
  ecg: '心电图',
  xray: 'X光',
  ct: 'CT',
  other: '其他',
};

const STAGE_ORDER: TraumaStageId[] = [
  'point-of-injury',
  'field-triage',
  'decontamination',
  'reception-treatment',
  'critical-care',
  'surgery',
];

const STAGE_MARKS: Record<TraumaStageId, string> = {
  'point-of-injury': '救',
  'field-triage': '检',
  decontamination: '消',
  'reception-treatment': '收',
  'critical-care': '重',
  surgery: '术',
};

const ECHELONS: Echelon[] = [
  {
    id: 'e1',
    level: 'Ⅰ',
    name: '战现场急救',
    span: '负伤地点 · 简易快速',
    detail: '检伤评估、止血、通气、包扎固定与搬运，并完成核生化个人防护。',
  },
  {
    id: 'e2',
    level: 'Ⅱ',
    name: '早期救治',
    span: '控制伤情 · 维持功能',
    detail: '紧急处置、外科复苏、辅助检查、生命支持及损伤控制手术评估。',
  },
  {
    id: 'e3',
    level: 'Ⅲ',
    name: '专科治疗',
    span: '消除危害 · 恢复功能',
    detail: '开展野战专科救治、确定性专科治疗，并系统防治战伤并发症。',
  },
  {
    id: 'e4',
    level: 'Ⅳ',
    name: '康复治疗',
    span: '生理心理恢复',
    detail: '完成功能测定、物理治疗、功能训练、心理支持与康复工程。',
  },
];

const SKINS: Array<{ id: LegacySkin; label: string; short: string }> = [
  { id: 'military', label: '军绿', short: '◐' },
  { id: 'field', label: '战地', short: '◒' },
  { id: 'dark', label: '指挥台', short: '◑' },
];

function initialSkin(): LegacySkin {
  try {
    const saved = localStorage.getItem(SKIN_KEY);
    if (saved === 'military' || saved === 'field' || saved === 'dark') return saved;
  } catch {
    // The military skin remains the deterministic fallback without storage.
  }
  return 'military';
}

function fileSizeLabel(size?: number): string {
  if (!size) return '演示资料';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function stageById(stageId: TraumaStageId) {
  return TRAUMA_STAGES.find((stage) => stage.id === stageId) ?? TRAUMA_STAGES[0];
}

function activeEchelonFor(stageId: TraumaStageId): Echelon['id'] {
  return stageId === 'point-of-injury' ? 'e1' : 'e2';
}

export default function MedTraumaPage({ onOpenDialogue }: MedTraumaPageProps) {
  const [stageId, setStageId] = useState<TraumaStageId>('point-of-injury');
  const [activeCategory, setActiveCategory] = useState<TraumaImageCategoryId>('wound');
  const [description, setDescription] = useState('');
  const [images, setImages] = useState<OrderedTraumaImage[]>([]);
  const [demoLoaded, setDemoLoaded] = useState(false);
  const [demoCases, setDemoCases] = useState<TraumaDemoSummary[]>([]);
  const [selectedDemoId, setSelectedDemoId] = useState('');
  const [demoLoading, setDemoLoading] = useState(false);
  const [historicalEvaluation, setHistoricalEvaluation] = useState(false);
  const [mode, setMode] = useState<TraumaMode>('eval');
  const [probeState, setProbeState] = useState<'idle' | 'loading' | 'ok' | 'error'>('idle');
  const [probeMessage, setProbeMessage] = useState('');
  const [streamState, setStreamState] = useState<TraumaStreamState>('idle');
  const [streamOrigin, setStreamOrigin] = useState<'static' | 'gateway' | null>(null);
  const [activeResultId, setActiveResultId] = useState<TraumaResultSectionId | null>(null);
  const [results, setResults] = useState<Record<TraumaResultSectionId, string>>({
    ...EMPTY_RESULTS,
  });
  const [streamError, setStreamError] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [skin, setSkin] = useState<LegacySkin>(initialSkin);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [flowExpanded, setFlowExpanded] = useState(false);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [branding, setBranding] = useState<MedicalPresetInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchMedicalPresetInfo().then((info) => {
      if (!cancelled) setBranding(info);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const streamedTextRef = useRef('');
  const imagesRef = useRef<OrderedTraumaImage[]>([]);
  const sessionIdRef = useRef('');
  const draggedIndexRef = useRef<number | null>(null);
  const { options, selectedModel, selectedLabel, setSelectedModel, isLoading } =
    useMedicalModels();

  const activeStage = stageById(stageId);
  const activeEchelon = activeEchelonFor(stageId);
  const hasResults = Object.values(results).some((value) => Boolean(value.trim()));
  const showResults = streamState !== 'idle' || hasResults;

  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    try {
      localStorage.setItem(SKIN_KEY, skin);
    } catch {
      // Theme changes remain active for the current page without storage.
    }
  }, [skin]);

  useEffect(() => {
    if (streamState !== 'complete') return;
    try {
      localStorage.setItem(RECOVERY_KEY, JSON.stringify({
        savedAt: new Date().toISOString(),
        stageId,
        mode,
        results,
        historicalEvaluation,
      }));
    } catch {
      // A completed result remains visible when browser storage is unavailable.
    }
  }, [historicalEvaluation, mode, results, stageId, streamState]);

  useEffect(() => () => {
    streamAbortRef.current?.abort();
    imagesRef.current.forEach((image) => {
      if (image.previewUrl && image.file) URL.revokeObjectURL(image.previewUrl);
    });
  }, []);

  const stopStream = (nextState: TraumaStreamState = 'stopped') => {
    if (streamAbortRef.current) {
      streamAbortRef.current.abort();
      streamAbortRef.current = null;
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId) void stopTraumaAnalysis(activeSessionId).catch(() => undefined);
    }
    setActiveResultId(null);
    setStreamState((current) => current === 'streaming' ? nextState : current);
  };

  const startAnalysis = async () => {
    stopStream('idle');
    setResults({ ...EMPTY_RESULTS });
    setStreamError('');
    setActiveResultId('imaging');
    setStreamState('streaming');
    setStreamOrigin('gateway');
    setHistoricalEvaluation(false);
    streamedTextRef.current = '';

    const controller = new AbortController();
    streamAbortRef.current = controller;
    try {
      await streamTraumaAnalysis({
        stage: stageId,
        description: description.trim(),
        images,
        mode,
        model: selectedModel || undefined,
        sessionId: sessionIdRef.current || undefined,
        signal: controller.signal,
        onEvent: ({ event, data }) => {
          if (data.sessionId) {
            sessionIdRef.current = data.sessionId;
            setSessionId(data.sessionId);
          }
          if (event === 'delta' && data.text) {
            streamedTextRef.current += data.text;
            const parsed = parseTraumaResultSections(streamedTextRef.current);
            setResults(parsed);
            const active = [...TRAUMA_RESULT_SECTIONS]
              .reverse()
              .find((section) => Boolean(parsed[section.id]))?.id ?? 'imaging';
            setActiveResultId(active);
          } else if (event === 'done') {
            setActiveResultId(null);
            if (data.reason === 'stopped') {
              setStreamState('stopped');
            } else {
              const parsed = parseTraumaResultSections(streamedTextRef.current);
              const completedSections = TRAUMA_RESULT_SECTIONS.filter(
                (section) => Boolean(parsed[section.id].trim()),
              ).length;
              if (completedSections < TRAUMA_RESULT_SECTIONS.length) {
                setStreamError(
                  `模型输出未满足五段结构（已识别 ${completedSections}/${TRAUMA_RESULT_SECTIONS.length}），请重试或切换模型。`,
                );
                setStreamState('stopped');
              } else {
                setStreamState('complete');
              }
            }
          } else if (event === 'error') {
            setStreamError(data.message || '战创伤研判失败。');
            setActiveResultId(null);
            setStreamState('stopped');
          }
        },
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setStreamError(
          error instanceof MedicalApiError ? error.message : '战创伤研判请求失败。',
        );
        setActiveResultId(null);
        setStreamState('stopped');
      }
    } finally {
      if (streamAbortRef.current === controller) streamAbortRef.current = null;
    }
  };

  const fetchDemoIndex = async () => {
    setDemoLoading(true);
    setStreamError('');
    try {
      const cases = await loadTraumaDemoIndex();
      setDemoCases(cases);
      setSelectedDemoId((current) => current || cases[0]?.id || '');
      if (!cases.length) setStreamError('后端演示索引为空，未使用内置伪案例替代。');
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : '后端演示索引不可用。');
    } finally {
      setDemoLoading(false);
    }
  };

  const loadDemo = async () => {
    if (!selectedDemoId) {
      await fetchDemoIndex();
      return;
    }
    setDemoLoading(true);
    setStreamError('');
    try {
      const demo = await loadTraumaDemoCase(selectedDemoId);
      stopStream('idle');
      images.forEach((image) => {
        if (image.previewUrl && image.file) URL.revokeObjectURL(image.previewUrl);
      });
      setStageId(demo.stage);
      setActiveCategory(demo.images[0]?.category ?? 'wound');
      setDescription(demo.description || '');
      setImages([...demo.images].sort((left, right) => left.index - right.index));
      setResults({ ...EMPTY_RESULTS, ...demo.results });
      setStreamState(demo.results ? 'complete' : 'idle');
      setStreamOrigin(demo.results ? 'static' : null);
      setHistoricalEvaluation(Boolean(demo.historicalEvaluation && demo.results));
      setActiveResultId(null);
      setDemoLoaded(true);
    } catch (error) {
      setStreamError(error instanceof Error ? error.message : '后端演示案例不可用。');
    } finally {
      setDemoLoading(false);
    }
  };

  const probeModel = async () => {
    setProbeState('loading');
    setProbeMessage('');
    try {
      setProbeMessage(await probeTraumaModel(selectedModel || undefined));
      setProbeState('ok');
    } catch (error) {
      setProbeMessage(error instanceof Error ? error.message : '模型探活失败。');
      setProbeState('error');
    }
  };

  const restoreResult = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(RECOVERY_KEY) || '') as {
        stageId?: TraumaStageId;
        mode?: TraumaMode;
        results?: Partial<Record<TraumaResultSectionId, string>>;
        historicalEvaluation?: boolean;
      };
      if (!saved.results) throw new Error();
      setStageId(saved.stageId || 'point-of-injury');
      setMode(saved.mode === 'plain' ? 'plain' : 'eval');
      setResults({ ...EMPTY_RESULTS, ...saved.results });
      setHistoricalEvaluation(Boolean(saved.historicalEvaluation));
      setStreamOrigin(saved.historicalEvaluation ? 'static' : 'gateway');
      setStreamState('complete');
      setStreamError('');
    } catch {
      setStreamError('没有可恢复的本地研判结果。');
    }
  };

  const downloadResult = () => {
    const body = [
      '# Med-trauma 结构化研判结果',
      `模式：${mode}`,
      `阶段：${activeStage.label}`,
      historicalEvaluation ? '标识：历史静态评测' : '标识：当前研判结果',
      '',
      ...TRAUMA_RESULT_SECTIONS.flatMap((section) => [
        `## ${section.index}. ${section.title}`,
        results[section.id] || '（无输出）',
        '',
      ]),
      MEDICAL_SAFETY_NOTE,
    ].join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `med-trauma-${new Date().toISOString().slice(0, 10)}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const moveImage = (from: number, to: number) => {
    setImages((current) => reorderImages(current, from, to));
    setDemoLoaded(false);
  };

  const updateImage = (
    id: string,
    patch: Partial<Pick<OrderedTraumaImage, 'label' | 'category'>>,
  ) => {
    setImages((current) => current.map((image) => (
      image.id === id ? { ...image, ...patch } : image
    )));
    setDemoLoaded(false);
  };

  const addFiles = (files: FileList | null) => {
    if (!files?.length) return;
    const nextImages = Array.from(files).map((file, index): OrderedTraumaImage => {
      const imageId = `${Date.now()}-${index}-${file.name}`;
      return {
        id: imageId,
        image_id: imageId,
        name: file.name,
        category: activeCategory,
        label: file.name,
        index: images.length + index,
        size: file.size,
        file,
        previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        dicom: file.type === 'application/dicom' || /\.(?:dcm|dicom)$/iu.test(file.name),
      };
    });
    setImages((previous) => [...previous, ...nextImages]);
    setDemoLoaded(false);
    setResults({ ...EMPTY_RESULTS });
    setStreamState('idle');
    setStreamOrigin(null);
    setStreamError('');
    if (inputRef.current) inputRef.current.value = '';
  };

  const removeImage = (id: string) => {
    setImages((previous) => previous
      .filter((image) => {
        if (image.id !== id) return true;
        if (image.previewUrl && image.file) URL.revokeObjectURL(image.previewUrl);
        return false;
      })
      .map((image, index) => ({ ...image, index })));
    setDemoLoaded(false);
  };

  const reset = () => {
    stopStream('idle');
    images.forEach((image) => {
      if (image.previewUrl && image.file) URL.revokeObjectURL(image.previewUrl);
    });
    setImages([]);
    setDescription('');
    setResults({ ...EMPTY_RESULTS });
    setStreamState('idle');
    setActiveResultId(null);
    setDemoLoaded(false);
    setHistoricalEvaluation(false);
    setStreamOrigin(null);
    setStreamError('');
    setToolMenuOpen(false);
  };

  const statusLabel = streamState === 'streaming'
    ? '正在分析'
    : streamState === 'complete'
      ? '研判完成'
      : streamState === 'stopped'
        ? '分析已停止'
        : '待输入';

  const resultSubtitle = streamState === 'streaming'
    ? '正在通过 PilotDeck Gateway 按五段模板流式生成'
    : streamState === 'complete'
      ? streamOrigin === 'static'
        ? '已加载后端提供的历史静态评测，不是本次模型生成'
        : '研判结果已生成，请结合现场信息复核'
      : streamError || '研判生成已停止';

  const renderAttachments = () => images.length > 0 ? (
    <div className="mt-attachments" aria-label="已上传影像">
      {images.map((image, imageIndex) => (
        <div
          key={image.id}
          draggable
          className="mt-attachment-row"
          onDragStart={() => {
            draggedIndexRef.current = imageIndex;
          }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => {
            if (draggedIndexRef.current !== null) {
              moveImage(draggedIndexRef.current, imageIndex);
            }
            draggedIndexRef.current = null;
          }}
        >
          <GripVertical className="mt-drag-handle" aria-hidden="true" />
          {image.previewUrl ? (
            <img className="mt-attachment-preview" src={image.previewUrl} alt="" />
          ) : (
            <span className="mt-attachment-placeholder">
              <FileImage aria-hidden="true" />
            </span>
          )}
          <input
            className="mt-attachment-label"
            aria-label={`图像标签 ${image.name}`}
            title={`${image.name} · ${fileSizeLabel(image.size)}${image.dicom ? ' · DICOM 安全降级' : ''}`}
            value={image.label}
            onChange={(event) => updateImage(image.id, { label: event.target.value })}
          />
          <select
            className="mt-attachment-category"
            aria-label={`图像类别 ${image.name}`}
            value={image.category}
            onChange={(event) => updateImage(image.id, {
              category: event.target.value as TraumaImageCategoryId,
            })}
          >
            {CATEGORY_ORDER.map((categoryId) => (
              <option key={categoryId} value={categoryId}>{CATEGORY_LABELS[categoryId]}</option>
            ))}
          </select>
          <div className="mt-attachment-actions">
            <button
              type="button"
              className="mt-icon-button"
              aria-label={`上移 ${image.name}`}
              disabled={imageIndex === 0}
              onClick={() => moveImage(imageIndex, imageIndex - 1)}
            >
              <ArrowUp />
            </button>
            <button
              type="button"
              className="mt-icon-button"
              aria-label={`下移 ${image.name}`}
              disabled={imageIndex === images.length - 1}
              onClick={() => moveImage(imageIndex, imageIndex + 1)}
            >
              <ArrowDown />
            </button>
            <button
              type="button"
              className="mt-icon-button mt-icon-button--danger"
              aria-label={`移除 ${image.name}`}
              onClick={() => removeImage(image.id)}
            >
              <Trash2 />
            </button>
          </div>
        </div>
      ))}
    </div>
  ) : null;

  const renderToolbox = () => (
    <div className="mt-toolbox">
      <button
        type="button"
        className="mt-pill-button mt-toolbox-trigger"
        aria-label="更多研判工具"
        aria-expanded={toolMenuOpen}
        onClick={() => setToolMenuOpen((open) => !open)}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {toolMenuOpen ? (
        <div className="mt-toolbox-panel" role="dialog" aria-label="研判工具">
          {demoCases.length ? (
            <select
              className="mt-select"
              aria-label="演示案例"
              value={selectedDemoId}
              onChange={(event) => setSelectedDemoId(event.target.value)}
            >
              {demoCases.map((demo) => (
                <option key={demo.id} value={demo.id}>{demo.title}</option>
              ))}
            </select>
          ) : null}
          <div className="mt-toolbox-row">
            <button
              type="button"
              className="mt-pill-button"
              disabled={demoLoading}
              onClick={() => void loadDemo()}
            >
              {demoLoading ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {demoCases.length ? '载入所选案例' : '获取演示索引'}
            </button>
            <button
              type="button"
              className="mt-pill-button"
              disabled={probeState === 'loading' || isLoading}
              onClick={() => void probeModel()}
            >
              {probeState === 'loading' ? <Loader2 className="animate-spin" /> : <CircleDot />}
              {probeState === 'ok' ? '模型在线' : probeState === 'error' ? '探活失败' : '模型探活'}
            </button>
          </div>
          <div className="mt-toolbox-row">
            <button type="button" className="mt-pill-button" onClick={restoreResult}>
              <RotateCcw />
              恢复结果
            </button>
            <button
              type="button"
              className="mt-pill-button"
              disabled={!hasResults}
              onClick={downloadResult}
            >
              <Download />
              下载结果
            </button>
          </div>
          {probeMessage || demoLoaded ? (
            <div className="mt-toolbox-message">
              {probeMessage || '后端演示资料已就绪'}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const renderComposer = (compact = false) => (
    <section className={cn('mt-composer', compact && 'mt-composer--compact')}>
      <div className="mt-composer-clip">
        <span className="mt-composer-rail" aria-hidden="true" />
        <div className="mt-composer-main">
          <textarea
            className="mt-composer-textarea"
            value={description}
            maxLength={4000}
            aria-label="伤情描述"
            placeholder={'描述受伤经过、伤情表现与生命体征（如伤员意识、呼吸、循环）…\n可上传相关的战创伤影像做进一步分析'}
            onChange={(event) => {
              setDescription(event.target.value);
              if (demoLoaded) setDemoLoaded(false);
            }}
          />
          {renderAttachments()}
          <div className="mt-toolbar">
            <input
              ref={inputRef}
              type="file"
              multiple
              accept="image/*,.dcm,application/dicom"
              className="sr-only"
              aria-label="上传影像文件"
              onChange={(event) => addFiles(event.target.files)}
            />
            <div className="mt-category-tabs" aria-label="救治阶段">
              {STAGE_ORDER.map((id) => {
                const stage = stageById(id);
                return (
                  <button
                    key={id}
                    type="button"
                    className={cn(
                      'mt-category-button',
                      stageId === id && 'mt-category-button--active',
                    )}
                    aria-label={stage.label}
                    aria-pressed={stageId === id}
                    title={stage.description}
                    onClick={() => setStageId(id)}
                  >
                    <span>{STAGE_MARKS[id]}</span>
                    <span>{stage.label}</span>
                  </button>
                );
              })}
            </div>
            <span className="mt-toolbar-divider" aria-hidden="true" />
            <select
              className="mt-select mt-model-select"
              aria-label="选择模型"
              value={selectedModel}
              disabled={isLoading}
              onChange={(event) => setSelectedModel(event.target.value)}
            >
              {options.map((option) => (
                <option key={option.value || 'pilotdeck-route'} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="mt-mode-switch" aria-label="研判模式">
              {(['eval', 'plain'] as const).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={cn(
                    'mt-mode-button',
                    mode === item && 'mt-mode-button--active',
                  )}
                  onClick={() => setMode(item)}
                >
                  {item === 'eval' ? '评测模式' : '普通模式'}
                </button>
              ))}
            </div>
            <span className="mt-toolbar-spacer" />
            {renderToolbox()}
            <button
              type="button"
              className="mt-pill-button"
              onClick={() => inputRef.current?.click()}
            >
              <UploadCloud aria-hidden="true" />
              上传影像
            </button>
            {streamState !== 'streaming' ? (
              <button type="button" className="mt-pill-button" onClick={reset}>
                新建伤员
              </button>
            ) : null}
            {streamState === 'streaming' ? (
              <button
                type="button"
                className="mt-pill-button mt-pill-button--stop"
                onClick={() => stopStream('stopped')}
              >
                <Square aria-hidden="true" />
                停止
              </button>
            ) : (
              <button
                type="button"
                className="mt-pill-button mt-pill-button--primary"
                aria-label="开始研判"
                title={description.trim() ? '通过 PilotDeck Gateway 开始研判' : '请先填写伤情描述'}
                disabled={!description.trim()}
                onClick={() => void startAnalysis()}
              >
                <Play aria-hidden="true" />
                {showResults ? '重新分析' : '开始分析'}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );

  const flow = (
    <section className="mt-flow" aria-label="救治流程">
      <div className="mt-flow-head">
        <div className="mt-flow-title-group">
          <span className="mt-context-label">救治流程</span>
          <span className="mt-flow-title">战伤救治规则 · 救治分级</span>
        </div>
        <button
          type="button"
          className="mt-flow-more"
          aria-expanded={flowExpanded}
          onClick={() => setFlowExpanded((expanded) => !expanded)}
        >
          {flowExpanded ? '收起详细说明' : '查看完整流程'}
        </button>
      </div>
      <div className="mt-flow-grid">
        {ECHELONS.map((echelon) => (
          <div
            key={echelon.id}
            className={cn(
              'mt-flow-step',
              echelon.id === activeEchelon && 'mt-flow-step--active',
            )}
            aria-current={echelon.id === activeEchelon ? 'step' : undefined}
          >
            <div className="mt-flow-step-top">
              <span className="mt-flow-level">{echelon.level}</span>
              <span className="mt-flow-name">{echelon.name}</span>
            </div>
            <span className="mt-flow-state">
              {echelon.id === activeEchelon ? '当前分级' : echelon.span}
            </span>
          </div>
        ))}
      </div>
      {flowExpanded ? (
        <div className="mt-flow-detail-grid">
          {ECHELONS.map((echelon) => (
            <div key={echelon.id} className="mt-flow-detail">
              <strong>{echelon.level} · {echelon.name}</strong>
              {echelon.detail}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );

  const landing = (
    <div className="mt-landing">
      <div className="mt-landing-inner">
        <header className="mt-hero">
          <span className="mt-hero-logo-spacer" aria-hidden="true" />
          <h1 className="mt-hero-title">
            您好，我是<span className="mt-hero-accent">{branding?.branding?.traumaName ?? '九格创伤辅助救治助手'}</span>
          </h1>
          <p className="mt-hero-subtitle">
            可读取伤情表现与多元模态影像，为您生成分诊研判、立即处置与后送建议。
          </p>
        </header>
        {renderComposer()}
        {streamError ? (
          <div className="mt-error" role="alert">
            <CircleAlert aria-hidden="true" />
            <span>{streamError}</span>
          </div>
        ) : null}
        {flow}
      </div>
    </div>
  );

  const resultsView = (
    <div className="mt-results-shell">
      <header className="mt-results-heading">
        <span className="mt-results-heading-icon">
          {streamState === 'streaming' ? (
            <Loader2 className="animate-spin" aria-hidden="true" />
          ) : streamState === 'complete' ? (
            <CheckCircle2 aria-hidden="true" />
          ) : (
            <ShieldCheck aria-hidden="true" />
          )}
        </span>
        <div className="mt-results-heading-copy">
          <h1 className="mt-results-title">结构化战创伤研判</h1>
          <p className="mt-results-subtitle">{resultSubtitle}</p>
        </div>
        {historicalEvaluation ? (
          <span className="mt-history-badge">历史静态评测</span>
        ) : null}
      </header>
      {renderComposer(true)}
      <div className="mt-result-overview">
        <strong>{activeStage.label}</strong>
        <span>{activeStage.description}</span>
        <span>模型：{selectedLabel || '跟随 PilotDeck 路由'}</span>
        <span className="mt-toolbar-spacer" />
        <button type="button" className="mt-pill-button" onClick={restoreResult}>
          <RotateCcw aria-hidden="true" />
          恢复
        </button>
        <button
          type="button"
          className="mt-pill-button"
          disabled={!hasResults}
          onClick={downloadResult}
        >
          <Download aria-hidden="true" />
          下载
        </button>
      </div>
      {streamError ? (
        <div className="mt-error" role="alert">
          <CircleAlert aria-hidden="true" />
          <span>{streamError}</span>
        </div>
      ) : null}
      <div className="mt-results-list">
        {TRAUMA_RESULT_SECTIONS.map((section) => {
          const Icon = section.icon;
          const content = results[section.id];
          const active = activeResultId === section.id;
          const complete = Boolean(content) && !active;
          return (
            <article
              key={section.id}
              className={cn('mt-result-card', active && 'mt-result-card--active')}
            >
              <div className="mt-result-card-head">
                <span className="mt-result-card-icon">
                  {complete ? <CheckCircle2 aria-hidden="true" /> : <Icon aria-hidden="true" />}
                </span>
                <div className="mt-result-card-copy">
                  <h2 className="mt-result-card-title">
                    {section.index}. {section.title}
                  </h2>
                  <p className="mt-result-card-description">{section.description}</p>
                </div>
                {active ? (
                  <span className="mt-result-state">
                    <span className="mt-result-state-dot" />
                    生成中
                  </span>
                ) : null}
              </div>
              <div className="mt-result-card-body">
                {content ? (
                  <>
                    {content}
                    {active ? <span className="mt-cursor" /> : null}
                  </>
                ) : (
                  <span className="mt-result-empty">等待输出</span>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <div className="mt-results-safety">
        <CircleAlert aria-hidden="true" />
        <span><strong>安全提示：</strong>{MEDICAL_SAFETY_NOTE}</span>
      </div>
    </div>
  );

  const page = (
    <div
      data-testid="medical-trauma-page"
      data-skin={skin}
      className="med-trauma-legacy"
    >
      <div className="mt-shell">
        {mobileSidebarOpen ? (
          <button
            type="button"
            className="mt-sidebar-backdrop"
            aria-label="关闭菜单"
            onClick={() => setMobileSidebarOpen(false)}
          />
        ) : null}
        <aside
          className={cn(
            'mt-sidebar',
            sidebarCollapsed && 'mt-sidebar--collapsed',
            mobileSidebarOpen && 'mt-sidebar--mobile-open',
          )}
        >
          <div className="mt-sidebar-top">
            <div className="mt-sidebar-brand">
              <span className="mt-brand-spacer" aria-hidden="true" />
              <div className="mt-brand-copy">
                <div className="mt-brand-title">{branding?.branding?.traumaName ?? '九格创伤救治助手'}</div>
                <div className="mt-brand-subtitle">战创伤辅助救治</div>
              </div>
            </div>
            <button
              type="button"
              className="mt-sidebar-toggle"
              aria-label={sidebarCollapsed ? '展开菜单' : '收起菜单'}
              title={sidebarCollapsed ? '展开菜单' : '收起菜单'}
              onClick={() => {
                if (window.innerWidth <= 900) {
                  setMobileSidebarOpen(false);
                } else {
                  setSidebarCollapsed((collapsed) => !collapsed);
                }
              }}
            >
              {sidebarCollapsed ? '›' : '‹'}
            </button>
          </div>
          <div className="mt-status-rail" role="status" aria-live="polite">
            <span
              className={cn(
                'mt-status-dot',
                streamState === 'streaming' && 'mt-status-dot--busy',
              )}
            />
            <span className="mt-status-label">{statusLabel}</span>
          </div>
          <div className="mt-side-label">工作入口</div>
          <button type="button" className="mt-work-entry" onClick={onOpenDialogue}>
            <MessageSquare aria-hidden="true" />
            <span>医学辅助对话助手</span>
          </button>
          <div className="mt-sidebar-spacer" />
          <div className="mt-sidebar-footer">
            <div className="mt-side-label">界面风格</div>
            <div className="mt-theme-row">
              {SKINS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={cn(
                    'mt-theme-button',
                    skin === item.id && 'mt-theme-button--active',
                  )}
                  title={item.label}
                  aria-pressed={skin === item.id}
                  onClick={() => setSkin(item.id)}
                >
                  {sidebarCollapsed ? item.short : item.label}
                </button>
              ))}
            </div>
          </div>
        </aside>
        <main className="mt-main">
          <button
            type="button"
            className="mt-mobile-menu"
            aria-label="打开菜单"
            onClick={() => setMobileSidebarOpen(true)}
          >
            <Menu aria-hidden="true" />
          </button>
          <div className="mt-main-scroll">
            {showResults ? resultsView : landing}
          </div>
          <footer className="mt-footer">
            本系统输出内容由 AI 模型生成，仅供辅助参考，不能替代专业临床医生判断，请结合医护经验与实际情况综合决策。
          </footer>
        </main>
      </div>
    </div>
  );

  return typeof document === 'undefined' ? page : createPortal(page, document.body);
}
