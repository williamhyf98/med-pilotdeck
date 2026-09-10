import { ChevronDown, Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';
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
  onSubmit: (form: TurnFormInput, rawInput: string, extract?: boolean) => void | Promise<void>;
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
  projectKey: _projectKey,
  sessionId: _sessionId,
  caseHistory: _caseHistory = '',
  previousSubStage,
  onSubmit,
  submitting = false,
}: TraumaComposerProps) {
  const [state, setState] = useState<ComposerState>({ phase: 'idle' });
  const [rawText, setRawText] = useState('');
  const [manualOpen, setManualOpen] = useState(false);
  const [freeSubStage, setFreeSubStage] = useState<SubStage | null>(null);

  const isExtracting = state.phase === 'extracting';
  const busy = submitting || isExtracting;

  // Once a submission starts, clear the draft and collapse back to the free-text
  // surface. The parent drives the next round; we don't keep stale text around.
  const wasSubmitting = useRef(false);
  useEffect(() => {
    if (submitting && !wasSubmitting.current) {
      setState({ phase: 'idle' });
      setRawText('');
      setManualOpen(false);
      setFreeSubStage(null);
    }
    wasSubmitting.current = submitting;
  }, [submitting]);

  async function handleExtract() {
    const trimmed = rawText.trim();
    if (!trimmed || busy) return;
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
    }, trimmed, true);
  }

  async function handleManualSubmit(form: TurnFormInput) {
    await onSubmit(form, rawText.trim());
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
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          <LevelRadios
            previousSubStage={previousSubStage}
            value={freeSubStage}
            onChange={setFreeSubStage}
            disabled={busy}
          />
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
