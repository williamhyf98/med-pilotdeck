import { ChevronDown, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import { TRAUMA_STAGES } from './demoCase';
import type { GateStatus, RoundMemo, Trend } from './types';

type MemoDetailPanelProps = {
  memo: RoundMemo;
  isLatest: boolean;
  onClose: () => void;
};

const trendMarks: Record<Trend, string> = {
  up: '↑',
  down: '↓',
  flat: '→',
  unknown: '',
};

function Card({
  title,
  meta,
  className,
  children,
}: {
  title: string;
  meta?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={cn('rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950', className)}>
      <header className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[12px] font-semibold">
          <span className="h-3 w-0.5 rounded-full bg-teal-500" />
          {title}
        </h3>
        {meta ? <div className="text-[10px] text-neutral-400">{meta}</div> : null}
      </header>
      {children}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'info' | 'warning' | 'danger' | 'success' }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-dashed border-neutral-200 py-1.5 last:border-0 dark:border-neutral-800">
      <span className="text-[10px] text-neutral-500 dark:text-neutral-400">{label}</span>
      <span className={cn(
        'text-right text-[11px] font-medium',
        tone === 'info' && 'text-teal-700 dark:text-teal-300',
        tone === 'warning' && 'text-amber-700 dark:text-amber-300',
        tone === 'danger' && 'text-red-700 dark:text-red-300',
        tone === 'success' && 'text-emerald-700 dark:text-emerald-300',
      )}
      >
        {value}
      </span>
    </div>
  );
}

function GateBadge({ status }: { status: GateStatus }) {
  return (
    <span className={cn(
      'rounded-full border px-2 py-0.5 text-[9px] font-semibold',
      status === 'ASSESSING' && 'border-neutral-300 text-neutral-500 dark:border-neutral-700 dark:text-neutral-400',
      status === 'READY' && 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300',
      status === 'BLOCKED' && 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300',
      status === 'COMPLETED' && 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300',
    )}
    >
      {status}
    </span>
  );
}

export default function MemoDetailPanel({ memo, isLatest, onClose }: MemoDetailPanelProps) {
  const stage = TRAUMA_STAGES.find((item) => item.id === memo.stageId);
  const substep = stage?.substeps[memo.substepIndex];

  return (
    <div className="space-y-2.5 pb-4">
      <section className="rounded-lg border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-950">
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-[9px] text-neutral-400">
              {stage?.index} {stage?.name} › {substep?.name} › Round {memo.round}
            </p>
            <h2 className="mt-0.5 text-[14px] font-semibold">{memo.title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="收起轮次详情"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </header>
        <Metric label="快照时间" value={`${memo.time} · 伤后 ${memo.elapsed}`} />
        <Metric label="快照类型" value={isLatest ? '本轮最新状态' : '历史轮次快照'} tone={isLatest ? 'info' : undefined} />
        <Metric label="下一医学目标" value={memo.nextTarget} />
      </section>

      <Card title="当前伤员状态" meta={memo.patient.updatedAt}>
        <div className="mb-2.5 border-b border-neutral-200 pb-2.5 dark:border-neutral-800">
          <p className="text-[9px] text-neutral-400">意识</p>
          <p className="mt-0.5 text-[11px] font-medium">{memo.patient.consciousness}</p>
        </div>

        <p className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-neutral-400">生命体征</p>
        <div className="grid grid-cols-2 gap-1.5">
          {memo.patient.vitals.map((vital) => (
            <div
              key={vital.label}
              className={cn(
                'rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 dark:border-neutral-800 dark:bg-neutral-900',
                vital.abnormal && 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/25',
              )}
            >
              <p className="text-[9px] text-neutral-400">{vital.label}</p>
              <p className={cn('mt-0.5 text-[11px] font-semibold', vital.abnormal && 'text-amber-700 dark:text-amber-300')}>
                {vital.value} <span className="text-[9px]">{trendMarks[vital.trend]}</span>
              </p>
            </div>
          ))}
        </div>

        <p className="mb-1.5 mt-3 text-[9px] font-semibold uppercase tracking-wider text-neutral-400">伤情</p>
        <ul className="space-y-1.5">
          {memo.patient.injuries.map((injury) => (
            <li key={`${injury.label}-${injury.certainty}`} className="rounded-md border border-neutral-200 bg-neutral-50 px-2 py-1.5 text-[10px] dark:border-neutral-800 dark:bg-neutral-900">
              <p>{injury.label}</p>
              <div className="mt-1 flex gap-1">
                <span className={cn(
                  'rounded border px-1.5 py-0.5 text-[8px]',
                  injury.certainty === '已确认' && 'border-teal-200 text-teal-700 dark:border-teal-900 dark:text-teal-300',
                  injury.certainty === '疑似' && 'border-amber-200 text-amber-700 dark:border-amber-900 dark:text-amber-300',
                  injury.certainty === '已排除' && 'border-neutral-200 text-neutral-500 dark:border-neutral-700',
                )}
                >
                  {injury.certainty}
                </span>
                <span className="rounded border border-neutral-200 px-1.5 py-0.5 text-[8px] text-neutral-500 dark:border-neutral-700">{injury.status}</span>
              </div>
            </li>
          ))}
        </ul>

        <p className="mb-1.5 mt-3 text-[9px] font-semibold uppercase tracking-wider text-neutral-400">已实施处置</p>
        <ul className="space-y-1 text-[10px] text-neutral-600 dark:text-neutral-300">
          {memo.patient.treatments.map((item) => <li key={item}>· {item}</li>)}
        </ul>

        <div className="mt-3">
          <Metric label="当前机构" value={memo.facility} />
          <Metric label="机构能力" value={memo.capability} tone="info" />
        </div>

        <p className="mb-1.5 mt-3 text-[9px] font-semibold uppercase tracking-wider text-neutral-400">待补充信息</p>
        <div className="flex flex-wrap gap-1">
          {memo.patient.missingInformation.map((item) => (
            <span key={item} className="rounded-full border border-dashed border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[9px] text-amber-700 dark:border-amber-800 dark:bg-amber-950/25 dark:text-amber-300">
              {item}
            </span>
          ))}
        </div>
      </Card>

      <Card title="本轮纪要" meta="输入与输出要点">
        <p className="mb-1 text-[9px] font-semibold text-neutral-400">输入要点</p>
        <ul className="space-y-1 text-[10px] text-neutral-600 dark:text-neutral-300">
          {memo.inputPoints.map((item) => <li key={item}>· {item}</li>)}
        </ul>
        <p className="mb-1 mt-2.5 text-[9px] font-semibold text-neutral-400">处置要点</p>
        <ul className="space-y-1 text-[10px] text-neutral-600 dark:text-neutral-300">
          {memo.actionPoints.map((item) => <li key={item}>· {item}</li>)}
        </ul>
        <p className="mt-2.5 border-l-2 border-teal-500 pl-2 text-[10px] font-medium">{memo.conclusion}</p>
      </Card>

      <div className="grid grid-cols-2 gap-2.5">
        <Card title="动态分类" meta={memo.classification.label}>
          <Metric label="伤势状态" value={memo.classification.severity} />
          <Metric label="救治优先级" value={memo.classification.treatmentPriority} />
          <Metric label="后送优先级" value={memo.classification.transportPriority} />
        </Card>
        <Card title="时效提示" meta="软约束" className={memo.timing.warning ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/20' : undefined}>
          <Metric label="伤后时间" value={memo.elapsed} tone={memo.timing.warning ? 'warning' : undefined} />
          <Metric label="当前状态" value={memo.timing.status} tone={memo.timing.warning ? 'warning' : undefined} />
          <p className="mt-2 text-[9px] leading-4 text-neutral-500">{memo.timing.window}。时间不单独触发阶段转换。</p>
        </Card>
      </div>

      <Card
        title="阶段转换 Gate"
        meta={<GateBadge status={memo.gate.status} />}
        className={cn(
          memo.gate.status === 'BLOCKED' && 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/20',
          memo.gate.status === 'COMPLETED' && 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/20',
        )}
      >
        <p className="text-[11px] font-semibold">{memo.gate.title}</p>
        <p className="mt-1 text-[10px] leading-4 text-neutral-500 dark:text-neutral-400">{memo.gate.description}</p>
        <div className="mt-2 rounded-md border border-neutral-200 bg-white/70 px-2 py-1.5 text-[9px] leading-4 text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950/50 dark:text-neutral-300">
          <strong>用户确认：</strong>{memo.gate.confirmation}
        </div>
      </Card>

      <Card title="当前行动计划" meta="限定于当前级别">
        <ol className="space-y-2">
          {memo.actions.map((action, index) => (
            <li key={action} className="flex gap-2 text-[10px] leading-4 text-neutral-600 dark:text-neutral-300">
              <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-teal-50 text-[9px] font-semibold text-teal-700 dark:bg-teal-950 dark:text-teal-300">
                {index + 1}
              </span>
              {action}
            </li>
          ))}
        </ol>
        <p className="mt-2.5 rounded-md bg-neutral-50 px-2 py-1.5 text-[9px] leading-4 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400">
          下一阶段所需能力：{memo.nextStageCapability}
        </p>
      </Card>

      <details className="group overflow-hidden rounded-lg border border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-[11px] font-semibold">
          知识库依据 · {memo.evidence.length} 个 RAG Chunk
          <ChevronDown className="h-3.5 w-3.5 text-neutral-400 transition group-open:rotate-180" />
        </summary>
        <div className="space-y-2 border-t border-neutral-200 p-2.5 dark:border-neutral-800">
          {memo.evidence.map((evidence) => (
            <article key={evidence.id} className="rounded-md border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
              <div className="flex flex-wrap items-center justify-between gap-1.5">
                <p className="text-[9px] font-semibold">{evidence.title}</p>
                <span className="text-[8px] text-teal-700 dark:text-teal-300">{evidence.score}</span>
              </div>
              <p className="mt-1 text-[8px] text-neutral-400">{evidence.source} · {evidence.used ? '本轮已使用' : '未使用'}</p>
              <p className="mt-1.5 text-[9px] leading-4 text-neutral-600 dark:text-neutral-300">{evidence.text}</p>
            </article>
          ))}
        </div>
      </details>
    </div>
  );
}
