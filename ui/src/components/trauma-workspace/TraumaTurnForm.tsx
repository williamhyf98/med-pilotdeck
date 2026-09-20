import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { RotateCcw, Send } from 'lucide-react';
import { cn } from '../../lib/utils';
import { SUBSTAGE_LABELS } from './domain/stageConfig';
import type {
  SubStage,
  TurnFormInput,
  VitalItemKey,
} from './domain/types';

type TraumaTurnFormProps = {
  onSubmit: (form: TurnFormInput) => void | Promise<void>;
  submitting?: boolean;
  /** Pre-filled values for confirm mode (from extraction draft). */
  initialValues?: TurnFormInput;
  /** Original free-text shown read-only above the form in confirm mode. */
  sourceText?: string;
  /** confirm = extraction review; manual = normal direct entry (default). */
  mode?: 'manual' | 'confirm';
  /** Called when user clicks 重新整理 in confirm mode. */
  onReExtract?: () => void;
  /** 锁定救治级别（如只剩外科复苏），禁用级别选择并强制使用该值。 */
  statedSubStageLocked?: boolean;
  /** 嵌入外层 composer 时使用更轻的表格外观，避免卡片套卡片。 */
  embedded?: boolean;
};

type NarrativeKey = 'injuryNarrative' | 'treatmentNarrative' | 'evacuationNarrative' | 'note';
type FormValues = Omit<TurnFormInput, 'vitals'> & Record<VitalItemKey, string>;
type FormErrors = Partial<Record<keyof FormValues | 'form', string>>;

const EMPTY_FORM: FormValues = {
  statedSubStage: null,
  injuryNarrative: '',
  treatmentNarrative: '',
  evacuationNarrative: '',
  note: '',
  respiratoryRate: '',
  systolicBloodPressure: '',
  heartRate: '',
  temperature: '',
};

const vitalFields: Array<{
  key: VitalItemKey;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: string;
}> = [
  { key: 'heartRate', label: '心率', unit: '次/分', min: 0, max: 300, step: '1' },
  { key: 'respiratoryRate', label: '呼吸频率', unit: '次/分', min: 0, max: 80, step: '1' },
  { key: 'systolicBloodPressure', label: '收缩压', unit: 'mmHg', min: 20, max: 300, step: '1' },
  { key: 'temperature', label: '体温', unit: '℃', min: 20, max: 45, step: '0.1' },
];

const narrativeFields: Array<{
  key: NarrativeKey;
  label: string;
  limit: number;
  placeholder: string;
}> = [
  {
    key: 'injuryNarrative',
    label: '伤情描述',
    limit: 1000,
    placeholder: '描述受伤部位、致伤原因与当前表现。如：爆炸胸部受创，右小腿伤口渗血，意识清楚可应答。',
  },
  {
    key: 'treatmentNarrative',
    label: '已做处置',
    limit: 800,
    placeholder: '已完成的救治措施、执行进度与效果。如：已于右大腿根部扎止血带，出血明显减少',
  },
  {
    key: 'evacuationNarrative',
    label: '后送条件',
    limit: 500,
    placeholder: '后送的可行性，涵盖交通运力、道路与天气、伤情稳定性等。如：有救护车，但伤口仍间断出血',
  },
  {
    key: 'note',
    label: '补充说明',
    limit: 500,
    placeholder: '其他有价值的信息。如：现场共 3 名伤员，可用血制品有限',
  },
];

const stageOptions: Array<{ value: SubStage | null; label: string }> = [
  { value: null, label: '由系统判定' },
  ...(Object.entries(SUBSTAGE_LABELS) as Array<[SubStage, string]>)
    .map(([value, label]) => ({ value, label })),
];

function validate(values: FormValues): FormErrors {
  const errors: FormErrors = {};
  for (const field of narrativeFields) {
    if (values[field.key].length > field.limit) {
      errors[field.key] = `${field.label}不能超过 ${field.limit} 字`;
    }
  }
  for (const field of vitalFields) {
    const raw = values[field.key].trim();
    if (!raw) continue;
    const number = Number(raw);
    const validPrecision = field.key === 'temperature'
      ? /^\d+(?:\.\d)?$/.test(raw)
      : /^\d+$/.test(raw);
    if (!validPrecision || !Number.isFinite(number) || number < field.min || number > field.max) {
      errors[field.key] = field.key === 'temperature'
        ? '请输入 20–45 且最多一位小数的数值'
        : `请输入 ${field.min}–${field.max} 的整数`;
    }
  }
  const hasNarrative = narrativeFields.some((field) => values[field.key].trim());
  const hasVital = vitalFields.some((field) => values[field.key].trim());
  if (!hasNarrative && !hasVital) {
    errors.form = '请至少填写一段叙述或一项本轮实测生命体征';
  }
  return errors;
}

function toInput(values: FormValues, statedSubStageLocked = false): TurnFormInput {
  const vitals: TurnFormInput['vitals'] = {};
  for (const field of vitalFields) {
    const raw = values[field.key].trim();
    if (raw) vitals[field.key] = Number(raw);
  }
  return {
    statedSubStage: statedSubStageLocked ? 'surgical_resuscitation' : values.statedSubStage,
    injuryNarrative: values.injuryNarrative.trim(),
    treatmentNarrative: values.treatmentNarrative.trim(),
    evacuationNarrative: values.evacuationNarrative.trim(),
    note: values.note.trim(),
    vitals,
  };
}

/** 气泡内的一条录入行：左侧固定标签列，右侧内容随文字增高并自动换行。 */
function BubbleRow({
  label,
  htmlFor,
  invalid = false,
  children,
}: {
  label: string;
  htmlFor?: string;
  invalid?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex gap-2 rounded-lg border-l-2 py-1.5 pl-2 pr-1 transition-colors',
        invalid
          ? 'border-l-red-400 bg-red-50/60 dark:bg-red-950/20'
          : 'border-l-transparent focus-within:border-l-teal-500 focus-within:bg-teal-50/40 dark:focus-within:bg-teal-950/20',
      )}
    >
      <label
        htmlFor={htmlFor}
        className="w-16 shrink-0 pt-px text-[11px] font-semibold leading-5 text-neutral-600 dark:text-neutral-300"
      >
        {label}：
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 单行起步、随内容增高的输入区，视觉上与气泡正文融为一体。 */
function AutoGrowTextarea({
  value,
  ...rest
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      {...rest}
      ref={ref}
      rows={1}
      value={value}
      className="block max-h-56 min-h-5 w-full resize-none overflow-y-auto border-0 bg-transparent p-0 text-xs leading-5 text-neutral-800 outline-none placeholder:text-neutral-400 dark:text-neutral-100 dark:placeholder:text-neutral-500"
    />
  );
}

export default function TraumaTurnForm({
  onSubmit,
  submitting = false,
  initialValues,
  sourceText,
  mode = 'manual',
  onReExtract,
  statedSubStageLocked = false,
  embedded = false,
}: TraumaTurnFormProps) {
  const [values, setValues] = useState<FormValues>(() => {
    if (initialValues) {
      return {
        statedSubStage: initialValues.statedSubStage,
        injuryNarrative: initialValues.injuryNarrative,
        treatmentNarrative: initialValues.treatmentNarrative,
        evacuationNarrative: initialValues.evacuationNarrative,
        note: initialValues.note,
        respiratoryRate: initialValues.vitals?.respiratoryRate !== undefined ? String(initialValues.vitals.respiratoryRate) : '',
        systolicBloodPressure: initialValues.vitals?.systolicBloodPressure !== undefined ? String(initialValues.vitals.systolicBloodPressure) : '',
        heartRate: initialValues.vitals?.heartRate !== undefined ? String(initialValues.vitals.heartRate) : '',
        temperature: initialValues.vitals?.temperature !== undefined ? String(initialValues.vitals.temperature) : '',
      };
    }
    return EMPTY_FORM;
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [pending, setPending] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const busy = submitting || pending;
  const vitalErrors = vitalFields.filter((field) => errors[field.key]);

  const update = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setValues((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined, form: undefined }));
    setSubmissionError(null);
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const nextErrors = validate(values);
    setErrors(nextErrors);
    if (Object.values(nextErrors).some(Boolean)) return;
    setPending(true);
    setSubmissionError(null);
    try {
      await onSubmit(toInput(values, statedSubStageLocked));
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : '提交失败，请重试');
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      aria-label="本轮伤情录入"
      onSubmit={(event) => void handleSubmit(event)}
      className={cn(
        embedded
          ? 'rounded-lg border border-border bg-transparent p-2'
          : 'rounded-2xl border border-border bg-transparent p-3',
      )}
      noValidate
    >
      {mode === 'confirm' && sourceText ? (
        <div className="mb-3 rounded-lg border border-teal-200 bg-teal-50/60 px-3 py-2 dark:border-teal-900/60 dark:bg-teal-950/20">
          <p className="mb-1 text-[10px] font-semibold text-teal-700 dark:text-teal-400">原始输入</p>
          <p className="whitespace-pre-wrap text-[11px] leading-5 text-neutral-700 dark:text-neutral-300">{sourceText}</p>
        </div>
      ) : null}
      <div className="space-y-0.5">
        <BubbleRow label="救治级别" htmlFor="trauma-statedSubStage">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <select
              id="trauma-statedSubStage"
              aria-label="救治级别"
              value={values.statedSubStage ?? ''}
              onChange={(event) => update(
                'statedSubStage',
                (event.target.value || null) as SubStage | null,
              )}
              disabled={statedSubStageLocked}
              className="rounded-md border border-input bg-background/35 px-2 py-0.5 text-xs leading-5 text-foreground outline-none transition focus:border-ring focus:ring-2 focus:ring-ring/15 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {stageOptions.map((option) => (
                <option key={option.value ?? 'system'} value={option.value ?? ''}>
                  {option.label}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-neutral-400">
              {statedSubStageLocked ? '仅剩外科复苏，级别已锁定' : '选择本身不构成本轮有效输入'}
            </span>
          </div>
        </BubbleRow>

        {narrativeFields.map((field) => {
          const errorId = `trauma-${field.key}-error`;
          const error = errors[field.key];
          return (
            <BubbleRow
              key={field.key}
              label={field.label}
              htmlFor={`trauma-${field.key}`}
              invalid={Boolean(error)}
            >
              <AutoGrowTextarea
                id={`trauma-${field.key}`}
                aria-label={field.label}
                value={values[field.key]}
                onChange={(event) => update(field.key, event.target.value)}
                placeholder={field.placeholder}
                maxLength={field.limit}
                aria-invalid={Boolean(error)}
                aria-describedby={error ? errorId : undefined}
              />
              {error ? (
                <span id={errorId} className="mt-1 block text-[10px] text-red-600">
                  {error}
                </span>
              ) : null}
            </BubbleRow>
          );
        })}

        <BubbleRow label="生命体征" invalid={vitalErrors.length > 0}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            {vitalFields.map((field) => {
              const error = errors[field.key];
              return (
                <span key={field.key} className="inline-flex items-baseline gap-1">
                  <span className="text-[11px] leading-5 text-neutral-500 dark:text-neutral-400">
                    {field.label}
                  </span>
                  <input
                    id={`trauma-${field.key}`}
                    aria-label={field.label}
                    type="number"
                    inputMode="decimal"
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    value={values[field.key]}
                    onChange={(event) => update(field.key, event.target.value)}
                    aria-invalid={Boolean(error)}
                    aria-describedby={error ? `trauma-${field.key}-error` : undefined}
                    className={cn(
                      'w-12 border-0 border-b bg-transparent px-0.5 py-0 text-center text-xs leading-5 tabular-nums text-neutral-800 outline-none transition focus:border-teal-500 dark:text-neutral-100',
                      error
                        ? 'border-b-red-400'
                        : 'border-b-neutral-300 dark:border-b-neutral-700',
                    )}
                  />
                  <span className="text-[10px] text-neutral-400">{field.unit}</span>
                </span>
              );
            })}
          </div>
          <p className="mt-1 text-[10px] text-neutral-400">可选填，本轮未测的项留空即可</p>
          {vitalErrors.length > 0 ? (
            <div className="mt-1 space-y-0.5">
              {vitalErrors.map((field) => (
                <span key={field.key} className="block text-[10px] text-red-600">
                  <span className="font-medium">{field.label}</span>
                  <span id={`trauma-${field.key}-error`} className="ml-1">
                    {errors[field.key]}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
        </BubbleRow>
      </div>

      {errors.form ? (
        <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[10px] text-red-700 dark:border-red-900 dark:bg-red-950/25 dark:text-red-300">
          {errors.form}
        </p>
      ) : null}
      {submissionError ? (
        <p role="alert" className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[10px] text-red-700 dark:border-red-900 dark:bg-red-950/25 dark:text-red-300">
          提交失败：{submissionError}
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between gap-3 border-t border-border pt-2">
        <p className="text-[9px] leading-4 text-neutral-400">提交后将进入分级、规则检索与研判流程。</p>
        {mode === 'confirm' ? (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onReExtract}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background/25 px-3 py-2 text-xs font-semibold text-foreground transition hover:bg-accent/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              重新整理
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {busy ? '提交中…' : '确认推演'}
            </button>
          </div>
        ) : (
          <button
            type="submit"
            disabled={busy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-teal-700 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-teal-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-3.5 w-3.5" />
            {busy ? '提交中…' : '提交本轮信息'}
          </button>
        )}
      </div>
    </form>
  );
}
