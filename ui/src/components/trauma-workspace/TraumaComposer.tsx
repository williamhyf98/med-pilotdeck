import { Loader2, Sparkles, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import ImageAttachment from '../chat/view/subcomponents/ImageAttachment';
import { cn } from '../../lib/utils';
import { authenticatedFetch } from '../../utils/api';
import {
  collectMedicalFilesFromFileList,
  ensureUploadFailedMessage,
  formatAttachmentLimitErrors,
  totalFileBytes,
  validateAttachmentBatch,
  MEDICAL_ATTACHMENT_EXTENSIONS,
} from '../chat/utils/medicalFolderUpload';
import { createPilotDeckSessionId, isTemporarySessionId } from '../chat/utils/sessionLauncher';
import { SUBSTAGE_LABELS, SUBSTAGE_ORDER } from './domain/stageConfig';
import type { SubStage, TurnFormInput } from './domain/types';
import TraumaTurnForm from './TraumaTurnForm';

// ─── Types ─────────────────────────────────────────────────────────────────────

type ComposerState =
  | { phase: 'idle' }
  | { phase: 'extracting' };

type InputMode = 'free' | 'manual';

type PanelTransitionDirection = 'forward' | 'backward';

type TraumaComposerProps = {
  projectKey?: string;
  sessionId?: string;
  caseHistory?: string;
  /** 上一轮推理后由工位 P 落定的救治级别；用于限定本轮可选级别。 */
  previousSubStage?: SubStage | null;
  onSubmit: (
    form: TurnFormInput,
    rawInput: string,
    extract?: boolean,
    attachments?: Array<{ path: string; name: string; previewUrl?: string }>,
    sessionId?: string,
  ) => void | Promise<void>;
  onAbort?: () => void;
  submitting?: boolean;
};

// ─── 救治级别单选组 ────────────────────────────────────────────────────────────

/**
 * 以上一轮落定的级别为基准，仅展示「该级别本身及其后」的可选项，外加「由系统判定」。
 * 若过滤后只剩外科复苏，则不显示「由系统判定」并把唯一选项锁定。
 */
function LevelRadios({
  previousSubStage,
  value,
  onChange,
  disabled,
}: {
  previousSubStage: SubStage | null | undefined;
  value: SubStage | null;
  onChange: (value: SubStage | null) => void;
  disabled: boolean;
}) {
  // 上一轮无落定级别时（首轮）展示全部；否则取该级及其后的级别。
  const baseOptions = previousSubStage
    ? SUBSTAGE_ORDER.slice(SUBSTAGE_ORDER.indexOf(previousSubStage))
    : [...SUBSTAGE_ORDER];
  const options: Array<{ value: SubStage | null; label: string }> = baseOptions.map((stage) => ({
    value: stage,
    label: SUBSTAGE_LABELS[stage],
  }));

  const onlySurgical = baseOptions.length === 1 && baseOptions[0] === 'surgical_resuscitation';
  if (!onlySurgical) {
    options.unshift({ value: null, label: '由系统判定' });
  }

  const selected = value;
  const locked = onlySurgical;
  const effective = locked ? 'surgical_resuscitation' : selected;

  // 锁定态下 radio 是禁用的（不会触发 onChange），这里把唯一可选项同步给父级状态。
  useEffect(() => {
    if (locked && value !== effective) onChange(effective);
  }, [locked, effective, value, onChange]);

  return (
    <div
      role="radiogroup"
      aria-label="本轮救治级别"
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
    >
      {options.map((option) => {
        const checked = option.value === effective;
        const isLocked = locked && option.value === 'surgical_resuscitation';
        return (
          <label
            key={option.value ?? 'system'}
            className={cn(
              'inline-flex items-center gap-1 rounded-md border border-neutral-300 px-2 py-0.5 text-[10px] leading-5 text-neutral-700 transition dark:border-neutral-700 dark:text-neutral-200',
              checked
                ? 'border-teal-600 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/30 dark:text-teal-300'
                : 'hover:border-teal-400 dark:hover:border-teal-600',
              disabled && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="radio"
              name="trauma-free-substage"
              value={option.value ?? 'system'}
              checked={checked}
              disabled={disabled || isLocked}
              onChange={() => onChange(option.value)}
              className="h-3 w-3 accent-teal-700"
            />
            {option.label}
          </label>
        );
      })}
    </div>
  );
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function TraumaComposer({
  projectKey,
  sessionId,
  caseHistory: _caseHistory = '',
  previousSubStage,
  onSubmit,
  onAbort,
  submitting = false,
}: TraumaComposerProps) {
  const [state, setState] = useState<ComposerState>({ phase: 'idle' });
  const [rawText, setRawText] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>('free');
  const [exitingPanel, setExitingPanel] = useState<{
    mode: InputMode;
    direction: PanelTransitionDirection;
  } | null>(null);
  const [enterDirection, setEnterDirection] = useState<PanelTransitionDirection>('forward');
  const [panelHeight, setPanelHeight] = useState<number | null>(null);
  const [freeSubStage, setFreeSubStage] = useState<SubStage | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadingImages] = useState<Map<string, number>>(new Map());
  const [imageErrors] = useState<Map<string, string>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const freeTextareaRef = useRef<HTMLTextAreaElement>(null);

  const isExtracting = state.phase === 'extracting';
  const busy = submitting || isExtracting || uploading;
  const transitionTimerRef = useRef<number | null>(null);
  const heightTimerRef = useRef<number | null>(null);
  const panelBodyRef = useRef<HTMLDivElement>(null);

  // Once a submission starts, clear the draft and collapse back to the free-text
  // surface. The parent drives the next round; we don't keep stale text around.
  const wasSubmitting = useRef(false);
  useEffect(() => {
    if (submitting && !wasSubmitting.current) {
      setState({ phase: 'idle' });
      setRawText('');
      setInputMode('free');
      setExitingPanel(null);
      setPanelHeight(null);
      setFreeSubStage(null);
      setPendingFiles([]);
      setAttachmentError(null);
    }
    wasSubmitting.current = submitting;
  }, [submitting]);

  useEffect(() => () => {
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
    if (heightTimerRef.current !== null) {
      window.clearTimeout(heightTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (panelHeight === null) return;
    const nextHeight = panelBodyRef.current?.offsetHeight ?? null;
    if (nextHeight === null) return;
    window.requestAnimationFrame(() => {
      setPanelHeight(nextHeight);
    });
    if (heightTimerRef.current !== null) {
      window.clearTimeout(heightTimerRef.current);
    }
    heightTimerRef.current = window.setTimeout(() => {
      setPanelHeight(null);
      heightTimerRef.current = null;
    }, 260);
  }, [inputMode, panelHeight]);

  useLayoutEffect(() => {
    if (inputMode !== 'free') return;
    resizeFreeTextarea(freeTextareaRef.current);
  }, [inputMode, rawText]);

  function resizeFreeTextarea(element: HTMLTextAreaElement | null) {
    if (!element) return;
    element.style.height = 'auto';
    if (element.value.trim()) {
      element.style.height = `${element.scrollHeight}px`;
    }
  }

  function switchInputMode(nextMode: InputMode) {
    if (nextMode === inputMode || busy) return;
    const direction: PanelTransitionDirection = nextMode === 'manual' ? 'forward' : 'backward';
    if (transitionTimerRef.current !== null) {
      window.clearTimeout(transitionTimerRef.current);
    }
    if (heightTimerRef.current !== null) {
      window.clearTimeout(heightTimerRef.current);
    }
    setPanelHeight(panelBodyRef.current?.offsetHeight ?? null);
    setExitingPanel({ mode: inputMode, direction });
    setEnterDirection(direction);
    setInputMode(nextMode);
    transitionTimerRef.current = window.setTimeout(() => {
      setExitingPanel(null);
      transitionTimerRef.current = null;
    }, 240);
  }

  function handleFilesPicked(list: FileList | null) {
    if (!list || list.length === 0) return;
    const collected = collectMedicalFilesFromFileList(list);
    const incoming = collected.entries.map((item) => item.file);
    const validation = validateAttachmentBatch({
      existingCount: pendingFiles.length,
      existingBytes: totalFileBytes(pendingFiles),
      incoming,
      scanOverflow: collected.scanOverflow,
    });
    if (!validation.ok) {
      setAttachmentError(formatAttachmentLimitErrors(validation.errors));
      return;
    }
    setAttachmentError(collected.warnings[0] ?? null);
    setPendingFiles((current) => [...current, ...incoming]);
  }

  // 上传在提交瞬间完成，而不是在 runner 运行期间等待——附件只对当前轮有效。
  function resolveUploadSessionId(): string | undefined {
    return sessionId && !isTemporarySessionId(sessionId)
      ? sessionId
      : createPilotDeckSessionId();
  }

  async function uploadPendingFiles(targetSessionId?: string): Promise<Array<{ path: string; name: string; previewUrl?: string }> | null> {
    if (pendingFiles.length === 0) return [];
    if (!projectKey) {
      setAttachmentError('上传失败：当前没有可用的项目。');
      return null;
    }
    // 为图片文件创建本地预览 URL，用于乐观消息气泡中的缩略图显示。
    // Blob URL 的生命周期与页面绑定，无需主动释放（消息泡一直可见期间有效）。
    const blobUrls = new Map<string, string>();
    for (const file of pendingFiles) {
      if (file.type.startsWith('image/')) {
        blobUrls.set(file.name, URL.createObjectURL(file));
      }
    }
    const formData = new FormData();
    pendingFiles.forEach((file) => {
      formData.append('attachments', file);
    });
    if (targetSessionId) {
      formData.append('sessionId', targetSessionId);
    }
    // 战创伤链路自己做预处理，不需要服务端回传 data-URL 图像。
    formData.append('pathOnlyIndexes', JSON.stringify(pendingFiles.map((_, index) => index)));
    try {
      setUploading(true);
      const response = await authenticatedFetch(
        `/api/projects/${encodeURIComponent(projectKey)}/upload-attachments`,
        { method: 'POST', headers: {}, body: formData },
      );
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(typeof payload?.error === 'string' ? payload.error : '附件上传失败，请稍后重试');
      }
      const result = await response.json();
      const files = [
        ...(Array.isArray(result.files) ? result.files : []),
        ...(Array.isArray(result.images) ? result.images : []),
      ];
      return files
        .filter((file: { path?: string }) => Boolean(file?.path))
        .map((file: { path: string; name: string }) => ({
          path: file.path,
          name: file.name,
          previewUrl: blobUrls.get(file.name),
        }));
    } catch (error) {
      for (const url of blobUrls.values()) URL.revokeObjectURL(url);
      setAttachmentError(ensureUploadFailedMessage(
        error instanceof Error ? error.message : '未知错误',
      ));
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function handleExtract() {
    const trimmed = rawText.trim();
    // 只传附件不写字也是有效输入——判读本身就是本轮的信息。
    if ((!trimmed && pendingFiles.length === 0) || busy) return;
    const targetSessionId = pendingFiles.length > 0 ? resolveUploadSessionId() : undefined;
    const attachments = await uploadPendingFiles(targetSessionId);
    if (!attachments) return;
    // 抽取在同一个 runner turn 内异步执行；先把原始自由语句交给聊天区，
    // 网关随后负责模型抽取，失败时自动使用原文 injuryNarrative fallback。
    setState({ phase: 'extracting' });
    const draft: TurnFormInput = {
      statedSubStage: freeSubStage,
      // Keep the transport-safe draft within the form limit; the complete
      // free text is carried separately in rawInput for extraction/audit.
      injuryNarrative: trimmed.slice(0, 1000),
      treatmentNarrative: '',
      evacuationNarrative: '',
      note: '',
      vitals: {},
    };
    if (attachments.length > 0 || targetSessionId) {
      await onSubmit(draft, trimmed, true, attachments, targetSessionId);
      return;
    }
    await onSubmit(draft, trimmed, true);
  }

  async function handleManualSubmit(form: TurnFormInput) {
    const targetSessionId = pendingFiles.length > 0 ? resolveUploadSessionId() : undefined;
    const attachments = await uploadPendingFiles(targetSessionId);
    if (!attachments) return;
    if (attachments.length > 0 || targetSessionId) {
      await onSubmit(form, rawText.trim(), false, attachments, targetSessionId);
      return;
    }
    await onSubmit(form, rawText.trim(), false);
  }

  const attachButton = (
    <>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={[...MEDICAL_ATTACHMENT_EXTENSIONS].map((ext) => `.${ext}`).join(',')}
        onChange={(event) => {
          handleFilesPicked(event.target.files);
          event.target.value = '';
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => fileInputRef.current?.click()}
        className="pd-composer-icon-button inline-flex h-7 shrink-0 items-center justify-center rounded-md border border-border px-2 text-[11px] font-medium text-muted-foreground transition hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        {uploading ? '上传中…' : '+ 添加医学附件'}
      </button>
    </>
  );

  const stopButton = submitting && onAbort ? (
    <button
      type="button"
      onClick={onAbort}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3 text-xs font-semibold text-red-700 transition hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300"
    >
      <Square className="h-3 w-3 fill-current" />
      停止本轮推演
    </button>
  ) : null;

  const freePanel = (
    <div className="space-y-2">
      <textarea
        ref={freeTextareaRef}
        value={rawText}
        onChange={(e) => {
          setRawText(e.target.value);
        }}
        onInput={(event) => resizeFreeTextarea(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey
            || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          event.preventDefault();
          if (!busy && !event.repeat) void handleExtract();
        }}
        disabled={isExtracting}
        placeholder="描述本轮伤情、处置与后送情况，Enter 发送，Shift+Enter 换行。"
        rows={2}
        className="block max-h-[40vh] min-h-[48px] w-full resize-none overflow-y-auto bg-transparent px-2 pt-1.5 text-[14px] leading-6 text-neutral-900 outline-none placeholder:text-neutral-400 disabled:opacity-60 dark:text-neutral-100 dark:placeholder:text-neutral-500"
        aria-label="本轮伤情自由输入"
      />
      <div className="pd-composer-control-row flex flex-wrap items-center justify-between gap-x-2 gap-y-1 px-1 pt-1">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <LevelRadios
            previousSubStage={previousSubStage}
            value={freeSubStage}
            onChange={setFreeSubStage}
            disabled={busy}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => switchInputMode('manual')}
            className="pd-composer-icon-button inline-flex h-7 shrink-0 items-center justify-center rounded-md px-2 text-[12px] font-medium text-muted-foreground transition hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            精确录入
          </button>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {attachButton}
          {stopButton ?? (
            <button
              type="button"
              onClick={() => void handleExtract()}
              disabled={busy || (!rawText.trim() && pendingFiles.length === 0)}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 text-xs font-semibold text-white transition hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isExtracting
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Sparkles className="h-3.5 w-3.5" />}
              {isExtracting ? '整理中…' : '整理'}
            </button>
          )}
        </div>
      </div>
    </div>
  );

  const manualPanel = (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="min-w-0">
          <p className="text-[12px] font-semibold text-foreground">精确录入</p>
          <p className="text-[10px] leading-4 text-muted-foreground">逐项填写本轮伤情、处置、后送条件与生命体征。</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => switchInputMode('free')}
            className="pd-composer-icon-button inline-flex h-7 items-center justify-center rounded-md px-2 text-[12px] font-medium text-muted-foreground transition hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-50"
          >
            自由对话
          </button>
          {attachButton}
          {stopButton}
        </div>
      </div>
      <div className="max-h-[42vh] overflow-y-auto overscroll-contain pr-1">
        <TraumaTurnForm
          mode="manual"
          embedded
          onSubmit={(form) => void handleManualSubmit(form)}
          submitting={submitting}
        />
      </div>
    </div>
  );

  function renderPanel(mode: InputMode) {
    return mode === 'free' ? freePanel : manualPanel;
  }

  return (
    <div className="pd-composer-container relative min-w-0">
      <div
        className={cn(
          'workspace-composer-surface group rounded-xl border p-2 transition-colors',
          'border-neutral-300/70 focus-within:border-neutral-400',
          'dark:border-neutral-700/80 dark:focus-within:border-neutral-600',
        )}
      >
        {pendingFiles.length > 0 && (
          <div className="pd-composer-attachment-panel mb-2 rounded-lg border border-border bg-transparent p-2">
            <div className="flex flex-wrap gap-2">
              {pendingFiles.map((file, index) => (
                <ImageAttachment
                  key={`${file.name}:${index}`}
                  file={file}
                  onRemove={() => setPendingFiles((current) => current.filter((_, at) => at !== index))}
                  uploadProgress={uploadingImages.get(file.name)}
                  error={imageErrors.get(file.name)}
                />
              ))}
            </div>
          </div>
        )}
        {attachmentError && (
          <p className="mb-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-600 dark:border-red-900/70 dark:bg-red-950/25 dark:text-red-400">{attachmentError}</p>
        )}
        <div
          className="relative overflow-hidden transition-[height] duration-200 ease-out"
          style={panelHeight === null ? undefined : { height: panelHeight }}
        >
          {exitingPanel ? (
            <div
              aria-hidden="true"
              className={cn(
                'pointer-events-none absolute inset-x-0 top-0 z-10',
                exitingPanel.direction === 'forward'
                  ? 'animate-[trauma-panel-exit-left_220ms_ease-in_forwards]'
                  : 'animate-[trauma-panel-exit-right_220ms_ease-in_forwards]',
              )}
            >
              {renderPanel(exitingPanel.mode)}
            </div>
          ) : null}
          <div
            ref={panelBodyRef}
            key={inputMode}
            className={cn(
              enterDirection === 'forward'
                ? 'animate-[trauma-panel-enter-right_220ms_ease-out]'
                : 'animate-[trauma-panel-enter-left_220ms_ease-out]',
            )}
          >
            {renderPanel(inputMode)}
          </div>
        </div>
      </div>
    </div>
  );
}
