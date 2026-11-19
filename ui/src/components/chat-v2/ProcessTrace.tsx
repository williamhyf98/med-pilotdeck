import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { AgentTimeline } from './AgentTimeline';
import { getToolDisplayName } from '../chat/tools/configs/toolConfigs';

export type ProcessTraceStep = {
  id?: string;
  title?: string;
  detail?: string;
  /** Primary target shown after "Tool / …" (path, pattern, command). */
  target?: string;
  /** Secondary location, e.g. "in src/". */
  context?: string;
  /** Short result line, e.g. "Found 0 files". */
  resultDetail?: string;
  state?: string;
  severity?: string;
  phase?: string;
  toolName?: string;
};

type ProcessTraceProps = {
  label: string;
  collapsedDetail?: string;
  status?: string;
  steps?: ProcessTraceStep[];
  children?: ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  live?: boolean;
  showIcon?: boolean;
  className?: string;
};

export function ProcessRunHeader({
  label,
  className = '',
}: {
  label: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={`mb-3 border-b border-neutral-200/70 pb-1.5 text-[14px] leading-relaxed text-neutral-500 dark:border-neutral-800/80 dark:text-neutral-400 ${className}`}
    >
      <span className="tabular-nums">{label}</span>
    </div>
  );
}

export function ProcessRunPanel({
  label,
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  className = '',
}: {
  label: string;
  children?: ReactNode;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}) {
  const { t } = useTranslation('chat');
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const [isTall, setIsTall] = useState(false);
  const expanded = controlledExpanded ?? uncontrolledExpanded;
  const hasDetails = Boolean(children);
  const setExpanded = (nextExpanded: boolean | ((value: boolean) => boolean)) => {
    const resolvedExpanded = typeof nextExpanded === 'function'
      ? nextExpanded(expanded)
      : nextExpanded;
    if (controlledExpanded === undefined) {
      setUncontrolledExpanded(resolvedExpanded);
    }
    onExpandedChange?.(resolvedExpanded);
  };
  const processWindowHeightClass = isTall ? 'max-h-[560px]' : 'max-h-[280px]';
  const resizeLabel = isTall
    ? t('process.collapseWindow', { defaultValue: 'Restore process window' })
    : t('process.expandWindow', { defaultValue: 'Expand process window' });

  return (
    <div
      role="status"
      aria-live="polite"
      className={`process-run-panel mb-3 border-b border-neutral-200/70 pb-1.5 text-[14px] leading-relaxed text-neutral-500 dark:border-neutral-800/80 dark:text-neutral-400 ${className}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <button
          type="button"
          disabled={!hasDetails}
          aria-expanded={hasDetails ? expanded : undefined}
          onClick={() => {
            if (hasDetails) {
              setExpanded((value) => !value);
            }
          }}
          className="group inline-flex min-w-0 flex-1 items-center gap-2 text-left tabular-nums transition hover:text-neutral-700 disabled:cursor-default disabled:hover:text-neutral-500 dark:hover:text-neutral-300 dark:disabled:hover:text-neutral-400"
        >
          <span className="min-w-0 truncate">{label}</span>
          {hasDetails ? (
            expanded ? (
              <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400 transition group-hover:text-neutral-500 dark:text-neutral-500 dark:group-hover:text-neutral-300" strokeWidth={1.8} />
            ) : (
              <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400 transition group-hover:text-neutral-500 dark:text-neutral-500 dark:group-hover:text-neutral-300" strokeWidth={1.8} />
            )
          ) : null}
        </button>
        {hasDetails && expanded ? (
          <button
            type="button"
            aria-label={resizeLabel}
            title={resizeLabel}
            onClick={() => setIsTall((value) => !value)}
            className="group shrink-0 rounded p-0.5 text-neutral-400 transition hover:bg-neutral-100 hover:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400/60 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
          >
            {isTall ? (
              <Minimize2 className="h-4 w-4" strokeWidth={1.8} />
            ) : (
              <Maximize2 className="h-4 w-4" strokeWidth={1.8} />
            )}
          </button>
        ) : null}
      </div>
      {expanded && hasDetails ? (
        <div className={`mt-2 max-w-full space-y-1.5 overflow-y-auto pl-3 ${processWindowHeightClass}`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

export function ProcessLiveStatus({
  step,
  steps = [],
  children,
  compact = false,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  className = '',
}: {
  step: ProcessTraceStep;
  steps?: ProcessTraceStep[];
  children?: ReactNode;
  compact?: boolean;
  defaultExpanded?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  className?: string;
}) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const expanded = controlledExpanded ?? uncontrolledExpanded;
  const setExpanded = (nextExpanded: boolean | ((value: boolean) => boolean)) => {
    const resolvedExpanded = typeof nextExpanded === 'function'
      ? nextExpanded(expanded)
      : nextExpanded;
    if (controlledExpanded === undefined) {
      setUncontrolledExpanded(resolvedExpanded);
    }
    onExpandedChange?.(resolvedExpanded);
  };
  const Icon = getStepIcon(step);
  const title = step.title || (step.toolName ? getToolDisplayName(step.toolName) : '处理中');
  const isRunning = step.state !== 'failed' && step.state !== 'completed' && step.state !== 'cancelled';
  const hasStepList = steps.length > 0;
  const hasStepMetadata = Boolean(step.target || step.detail || step.resultDetail);
  const hasDetails = Boolean(children) || hasStepList || hasStepMetadata;
  const statusContent = (
    <>
      <Icon
        className={`mt-[0.28rem] h-3.5 w-3.5 shrink-0 ${getStepIconClass(step)} ${
          Icon === Loader2 && isRunning ? 'animate-spin' : ''
        }`}
        strokeWidth={1.8}
      />
      <div className="min-w-0">
        <div className="truncate">{title}</div>
      </div>
      {hasDetails ? (
        expanded ? (
          <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
        ) : (
          <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-neutral-400 dark:text-neutral-500" strokeWidth={1.8} />
        )
      ) : null}
    </>
  );

  return (
    <div
      role="status"
      aria-live="polite"
      className={`process-live-status ${compact ? 'py-0' : 'pb-1'} text-[14px] leading-relaxed text-neutral-400 dark:text-neutral-500 ${className}`}
    >
      {hasDetails ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className={`group inline-flex min-w-0 max-w-full items-start gap-2 text-left transition hover:text-neutral-600 dark:hover:text-neutral-300 ${
            isRunning ? 'animate-pulse' : ''
          }`}
        >
          {statusContent}
        </button>
      ) : (
        <div className={`inline-flex min-w-0 max-w-full items-start gap-2 ${isRunning ? 'animate-pulse' : ''}`}>
          {statusContent}
        </div>
      )}
      {expanded && hasDetails ? (
        <div className="mt-1.5 space-y-1.5 pl-5">
          {hasStepList ? (
            steps.length > 3 ? (
              <AgentTimeline steps={steps} />
            ) : (
              steps.map((item, index) => (
                <ProcessTraceLine key={item.id || `${item.title || 'process-step'}-${index}`} step={item} />
              ))
            )
          ) : null}
          {hasStepMetadata ? <ProcessTraceMetadata step={step} /> : null}
          {children}
        </div>
      ) : null}
    </div>
  );
}

function getStepIcon(step: ProcessTraceStep): LucideIcon {
  const haystack = `${step.phase || ''} ${step.toolName || ''} ${step.title || ''}`.toLowerCase();

  if (step.state === 'failed' || step.severity === 'error' || step.severity === 'warning') {
    return AlertCircle;
  }
  if (step.phase === 'rag' || /search|grep|glob|find|检索|搜索/.test(haystack)) {
    return Search;
  }
  if (/edit|write|patch|update|create|modify|修改|编辑|写入|创建/.test(haystack)) {
    return Pencil;
  }
  if (/bash|shell|terminal|command|exec|run|命令|运行/.test(haystack)) {
    return Terminal;
  }
  if (step.phase === 'tool' || step.phase === 'subtask' || step.toolName) {
    return Wrench;
  }
  if (step.state === 'completed') {
    return CheckCircle2;
  }
  if (step.state === 'running') {
    return Loader2;
  }
  return Activity;
}

function getStepIconClass(step: ProcessTraceStep): string {
  if (step.state === 'failed' || step.severity === 'error') {
    return 'text-amber-600 dark:text-amber-400';
  }
  if (step.severity === 'warning') {
    return 'text-amber-500 dark:text-amber-400';
  }
  if (step.state === 'running') {
    return 'text-neutral-400 dark:text-neutral-500';
  }
  return 'text-neutral-400 dark:text-neutral-500';
}

function ProcessTraceLine({ step }: { step: ProcessTraceStep }) {
  const Icon = getStepIcon(step);
  const isRunning = step.state === 'running';
  const title = step.title || (step.toolName ? getToolDisplayName(step.toolName) : '步骤');

  return (
    <div
      className={`pd-process-step inline-flex min-w-0 max-w-full items-start gap-2 text-[14px] leading-relaxed text-neutral-400 dark:text-neutral-500 ${
        isRunning ? 'animate-pulse' : ''
      }`}
    >
      <Icon
        className={`mt-[0.28rem] h-3.5 w-3.5 shrink-0 ${getStepIconClass(step)} ${
          Icon === Loader2 && isRunning ? 'animate-spin' : ''
        }`}
        strokeWidth={1.9}
      />
      <div className="min-w-0">
        <div className="truncate">{title}</div>
        {step.target && step.target !== title ? (
          <div className="pd-process-detail break-all text-[12px] leading-5 text-neutral-400/80 dark:text-neutral-500/80">
            {step.target}
          </div>
        ) : null}
        {step.detail && step.detail !== step.target && step.detail !== title ? (
          <div className="pd-process-detail break-all text-[12px] leading-5 text-neutral-400/80 dark:text-neutral-500/80">
            {step.detail}
          </div>
        ) : null}
        {step.resultDetail ? (
          <div className="pd-process-detail break-all text-[12px] leading-5 text-neutral-400/80 dark:text-neutral-500/80">
            {step.resultDetail}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ProcessTraceMetadata({ step }: { step: ProcessTraceStep }) {
  return (
    <div className="space-y-0.5 text-[12px] leading-5 text-neutral-400/80 dark:text-neutral-500/80">
      {step.target ? <div className="break-all">{step.target}</div> : null}
      {step.detail && step.detail !== step.target ? <div className="break-all">{step.detail}</div> : null}
      {step.resultDetail && step.resultDetail !== step.target && step.resultDetail !== step.detail ? (
        <div className="break-all">{step.resultDetail}</div>
      ) : null}
    </div>
  );
}

export function ProcessTrace({
  label,
  collapsedDetail,
  status = 'completed',
  steps = [],
  children,
  defaultExpanded = false,
  expanded: controlledExpanded,
  onExpandedChange,
  live = false,
  showIcon = true,
  className = '',
}: ProcessTraceProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const expanded = controlledExpanded ?? uncontrolledExpanded;
  const setExpanded = (nextExpanded: boolean | ((value: boolean) => boolean)) => {
    const resolvedExpanded = typeof nextExpanded === 'function'
      ? nextExpanded(expanded)
      : nextExpanded;
    if (controlledExpanded === undefined) {
      setUncontrolledExpanded(resolvedExpanded);
    }
    onExpandedChange?.(resolvedExpanded);
  };
  const hasDetails = steps.length > 0 || Boolean(children);
  const visibleCollapsedDetail = !expanded && collapsedDetail;
  const summaryIconStep = steps[0] || { title: label, state: status };
  const SummaryIcon = getStepIcon(summaryIconStep);
  const isRunning = status === 'running';

  return (
    <div
      role={live ? 'status' : undefined}
      aria-live={live ? 'polite' : undefined}
      className={`process-trace py-0 ${className}`}
    >
      <button
        type="button"
        aria-expanded={hasDetails ? expanded : undefined}
        onClick={() => {
          if (hasDetails) {
            setExpanded((value) => !value);
          }
        }}
        disabled={!hasDetails}
        className={`group inline-flex min-w-0 max-w-full items-center gap-2 text-left text-[14px] leading-relaxed text-neutral-400 transition hover:text-neutral-600 disabled:cursor-default disabled:hover:text-neutral-400 dark:text-neutral-500 dark:hover:text-neutral-300 dark:disabled:hover:text-neutral-500 ${
          isRunning ? 'animate-pulse' : ''
        }`}
      >
        {showIcon ? (
          <SummaryIcon
            className={`h-3.5 w-3.5 shrink-0 ${getStepIconClass(summaryIconStep)} ${
              SummaryIcon === Loader2 && isRunning ? 'animate-spin' : ''
            }`}
            strokeWidth={1.8}
          />
        ) : null}
        <span className="min-w-0 truncate tabular-nums">{label}</span>
        {visibleCollapsedDetail ? (
          <span className="pd-process-detail min-w-0 shrink truncate text-neutral-400/75 dark:text-neutral-500/75">
            {visibleCollapsedDetail}
          </span>
        ) : null}
        {hasDetails ? (
          expanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-neutral-400 transition group-hover:text-neutral-500 dark:text-neutral-500 dark:group-hover:text-neutral-300" strokeWidth={1.8} />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400 transition group-hover:text-neutral-500 dark:text-neutral-500 dark:group-hover:text-neutral-300" strokeWidth={1.8} />
          )
        ) : null}
      </button>

      {expanded ? (
        <div className="mt-1.5 space-y-1.5 pl-5">
          {steps.length > 3 ? (
            <AgentTimeline steps={steps} expandAll />
          ) : (
            steps.map((step, index) => (
              <ProcessTraceLine key={step.id || `${step.title || 'process-step'}-${index}`} step={step} />
            ))
          )}
          {children ? <div className="space-y-1.5 pt-0.5">{children}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
