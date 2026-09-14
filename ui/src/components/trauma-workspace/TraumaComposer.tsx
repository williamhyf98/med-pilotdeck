import { ChevronDown, Loader2, Sparkles, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
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
import { SUBSTAGE_LABELS, SUBSTAGE_ORDER } from './domain/stageConfig';
import type { SubStage, TurnFormInput } from './domain/types';
import TraumaTurnForm from './TraumaTurnForm';

// ─── Types ─────────────────────────────────────────────────────────────────────

type ComposerState =
  | { phase: 'idle' }
  | { phase: 'extracting' };

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
    attachments?: Array<{ path: string; name: string }>,
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
  sessionId: _sessionId,
  caseHistory: _caseHistory = '',
  previousSubStage,
  onSubmit,
  onAbort,
  submitting = false,
}: TraumaComposerProps) {
  const [state, setState] = useState<ComposerState>({ phase: 'idle' });
  const [rawText, setRawText] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [freeSubStage, setFreeSubStage] = useState<SubStage | null>(null);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isExtracting = state.phase === 'extracting';
  const busy = submitting || isExtracting || uploading;

  // Once a submission starts, clear the draft and collapse back to the free-text
  // surface. The parent drives the next round; we don't keep stale text around.
  const wasSubmitting = useRef(false);
  useEffect(() => {
    if (submitting && !wasSubmitting.current) {
      setState({ phase: 'idle' });
      setRawText('');
      setManualOpen(false);
      setFreeSubStage(null);
      setPendingFiles([]);
      setAttachmentError(null);
    }
    wasSubmitting.current = submitting;
  }, [submitting]);

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
  async function uploadPendingFiles(): Promise<Array<{ path: string; name: string }> | null> {
    if (pendingFiles.length === 0) return [];
    if (!projectKey) {
      setAttachmentError('上传失败：当前没有可用的项目。');
      return null;
    }
    const formData = new FormData();
    pendingFiles.forEach((file) => {
      formData.append('attachments', file);
    });
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
        .map((file: { path: string; name: string }) => ({ path: file.path, name: file.name }));
    } catch (error) {
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
    const attachments = await uploadPendingFiles();
    if (!attachments) return;
    // 抽取在同一个 runner turn 内异步执行；先把原始自由语句交给聊天区，
    // 网关随后负责模型抽取，失败时自动使用原文 injuryNarrative fallback。
    setState({ phase: 'extracting' });
    await onSubmit({
      statedSubStage: freeSubStage,
      // Keep the transport-safe draft within the form limit; the complete
      // free text is carried separately in rawInput for extraction/audit.
      injuryNarrative: trimmed.slice(0, 1000),
      treatmentNarrative: '',
      evacuationNarrative: '',
      note: '',
      vitals: {},
    }, trimmed, true, attachments);
  }

  async function handleManualSubmit(form: TurnFormInput) {
    const attachments = await uploadPendingFiles();
    if (!attachments) return;
    await onSubmit(form, rawText.trim(), false, attachments);
  }

  return (
    <div className="space-y-3">
      {/* ── Free-text input ─────────────────────────────────────────── */}
      <div className="rounded-2xl border border-neutral-200 bg-white p-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <textarea
          value={rawText}
          onChange={(e) => {
            setRawText(e.target.value);
          }}
          disabled={isExtracting}
          placeholder="用自然语言描述本轮伤情、处置与后送情况，点「整理」后自动抽取并开始本轮推演。"
          rows={4}
          className="block w-full resize-none bg-transparent text-xs leading-5 text-neutral-800 outline-none placeholder:text-neutral-400 disabled:opacity-60 dark:text-neutral-100 dark:placeholder:text-neutral-500"
          aria-label="本轮伤情自由输入"
        />
        {pendingFiles.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {pendingFiles.map((file, index) => (
              <span
                key={`${file.name}:${index}`}
                className="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
              >
                {file.name}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPendingFiles((current) => current.filter((_, at) => at !== index))}
                  className="text-neutral-400 hover:text-neutral-700 disabled:opacity-50 dark:hover:text-neutral-100"
                  aria-label={`移除附件 ${file.name}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        {attachmentError && (
          <p className="mt-1 text-[11px] text-red-600 dark:text-red-400">{attachmentError}</p>
        )}
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          <LevelRadios
            previousSubStage={previousSubStage}
            value={freeSubStage}
            onChange={setFreeSubStage}
            disabled={busy}
          />
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
            className="shrink-0 rounded-lg border border-neutral-200 px-2 py-1 text-[11px] text-neutral-600 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            {uploading ? '上传中…' : '+ 添加医学附件'}
          </button>
          {submitting && onAbort ? (
            <button
              type="button"
              onClick={onAbort}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-3.5 py-2 text-xs font-semibold text-red-700 transition hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:ring-offset-2 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300"
            >
              <Square className="h-3 w-3 fill-current" />
              停止本轮推演
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleExtract()}
              disabled={busy || !rawText.trim()}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isExtracting
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Sparkles className="h-3.5 w-3.5" />}
              {isExtracting ? '整理中…' : '整理'}
            </button>
          )}
        </div>
      </div>

      {/* ── 精确录入 disclosure ───────────────────────────────────────── */}
      <div className="rounded-2xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
        <button
          type="button"
          onClick={() => setManualOpen((open) => !open)}
          className="flex w-full items-center justify-between rounded-2xl px-3 py-2.5 text-left text-[11px] font-semibold text-neutral-600 transition hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-500 dark:text-neutral-400 dark:hover:bg-neutral-800/50"
          aria-expanded={manualOpen}
        >
          <span>精确录入</span>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 text-neutral-400 transition-transform duration-200',
              manualOpen && 'rotate-180',
            )}
          />
        </button>
        {manualOpen ? (
          <div className="border-t border-neutral-200 p-3 pt-0 dark:border-neutral-800">
            <TraumaTurnForm
              mode="manual"
              onSubmit={(form) => void handleManualSubmit(form)}
              submitting={submitting}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
