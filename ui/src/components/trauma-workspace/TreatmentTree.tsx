import { Check, Circle, LockKeyhole, MoveRight } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { MainStageId, RoundMemo, StageDefinition, WorkflowStatus } from './types';

type TreatmentTreeProps = {
  stages: StageDefinition[];
  rounds: RoundMemo[];
  currentRoundIndex: number;
  selectedMemoId: string | null;
  onSelectMemo: (memoId: string) => void;
};

function statusLabel(status: WorkflowStatus): string {
  return {
    future: '未开始',
    current: '当前',
    done: '已完成',
    transfer: '转运准备',
    blocked: '阻塞',
  }[status];
}

/** 叶子节点用蓝色表示「当前」，与主级/子级的青色区分开。 */
type CurrentTone = 'teal' | 'blue';

function nodeClasses(status: WorkflowStatus, currentTone: CurrentTone = 'teal'): string {
  return cn(
    'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950',
    status === 'future' && 'opacity-45',
    status === 'current' && (currentTone === 'blue'
      ? 'border-blue-300 bg-blue-50/70 dark:border-blue-800 dark:bg-blue-950/30'
      : 'border-teal-300 bg-teal-50/70 dark:border-teal-800 dark:bg-teal-950/30'),
    status === 'done' && 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/20',
    status === 'transfer' && 'border-amber-300 bg-amber-50/70 dark:border-amber-800 dark:bg-amber-950/25',
    status === 'blocked' && 'border-red-300 bg-red-50/70 dark:border-red-900 dark:bg-red-950/25',
  );
}

function StatusBadge({ status, currentTone = 'teal' }: { status: WorkflowStatus; currentTone?: CurrentTone }) {
  const Icon = status === 'done'
    ? Check
    : status === 'blocked'
      ? LockKeyhole
      : status === 'transfer'
        ? MoveRight
        : Circle;
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-medium',
      status === 'future' && 'border-neutral-200 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500',
      status === 'current' && (currentTone === 'blue'
        ? 'border-blue-300 text-blue-700 dark:border-blue-800 dark:text-blue-300'
        : 'border-teal-300 text-teal-700 dark:border-teal-800 dark:text-teal-300'),
      status === 'done' && 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-300',
      status === 'transfer' && 'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300',
      status === 'blocked' && 'border-red-300 text-red-700 dark:border-red-800 dark:text-red-300',
    )}
    >
      <Icon className="h-2.5 w-2.5" strokeWidth={2} />
      {statusLabel(status)}
    </span>
  );
}

function getMainStatus(
  stages: StageDefinition[],
  stageId: MainStageId,
  currentRound: RoundMemo,
): WorkflowStatus {
  const index = stages.findIndex((stage) => stage.id === stageId);
  const currentIndex = stages.findIndex((stage) => stage.id === currentRound.stageId);
  if (index < currentIndex) return 'done';
  if (index > currentIndex) return 'future';
  return 'current';
}

function getSubStatus(
  mainStatus: WorkflowStatus,
  stageId: MainStageId,
  substepIndex: number,
  currentRound: RoundMemo,
): WorkflowStatus {
  if (mainStatus === 'done') return 'done';
  if (mainStatus === 'future') return 'future';
  if (substepIndex < currentRound.substepIndex) return 'done';
  if (substepIndex > currentRound.substepIndex) return 'future';
  if (currentRound.gate.status === 'BLOCKED') return 'blocked';
  if (currentRound.transitionTone === 'warning') return 'transfer';
  return 'current';
}

function getMemoStatus(memo: RoundMemo, currentRound: RoundMemo): WorkflowStatus {
  if (memo.round !== currentRound.round) return 'done';
  if (memo.gate.status === 'BLOCKED') return 'blocked';
  if (memo.transitionTone === 'warning') return 'transfer';
  return 'current';
}

export default function TreatmentTree({
  stages,
  rounds,
  currentRoundIndex,
  selectedMemoId,
  onSelectMemo,
}: TreatmentTreeProps) {
  const visibleRounds = rounds.slice(0, currentRoundIndex + 1);
  const currentRound = rounds[currentRoundIndex];

  return (
    <div className="space-y-2 pb-4">
      {stages.map((stage) => {
        const mainStatus = getMainStatus(stages, stage.id, currentRound);
        return (
          <section key={stage.id}>
            <div
              aria-disabled="true"
              className={cn('rounded-lg border px-2.5 py-2', nodeClasses(mainStatus))}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-semibold text-neutral-800 dark:text-neutral-100">
                    <span className="mr-1.5 text-[10px] text-neutral-400">{stage.index}</span>
                    {stage.name}
                  </div>
                  <p className="truncate text-[9px] text-neutral-500 dark:text-neutral-400">{stage.note}</p>
                </div>
                <StatusBadge status={mainStatus} />
              </div>
            </div>

            <div className="ml-3 border-l border-neutral-200 pl-3 pt-1.5 dark:border-neutral-800">
              {stage.substeps.map((substep, substepIndex) => {
                const subStatus = getSubStatus(mainStatus, stage.id, substepIndex, currentRound);
                const memos = subStatus === 'future'
                  ? []
                  : visibleRounds.filter(
                    (round) => round.stageId === stage.id && round.substepIndex === substepIndex,
                  );
                return (
                  <div className="relative mb-1.5" key={`${stage.id}-${substep.name}`}>
                    <span className="absolute -left-3 top-4 w-3 border-t border-neutral-200 dark:border-neutral-800" />
                    <div
                      aria-disabled="true"
                      className={cn('rounded-md border px-2.5 py-1.5', nodeClasses(subStatus))}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-medium">{substep.name}</p>
                          <p className="truncate text-[9px] text-neutral-500 dark:text-neutral-400">{substep.note}</p>
                        </div>
                        <StatusBadge status={subStatus} />
                      </div>
                    </div>

                    {memos.length > 0 ? (
                      <div className="ml-3 border-l border-dashed border-neutral-300 pl-3 pt-1.5 dark:border-neutral-700">
                        {memos.map((memo) => {
                          const selected = selectedMemoId === memo.id;
                          const memoStatus = getMemoStatus(memo, currentRound);
                          const isCurrentMemo = memo.round === currentRound.round;
                          return (
                            <div className="relative mb-1.5" key={memo.id}>
                              <span className="absolute -left-3 top-4 w-3 border-t border-dashed border-neutral-300 dark:border-neutral-700" />
                              <button
                                type="button"
                                aria-expanded={selected}
                                onClick={() => onSelectMemo(memo.id)}
                                className={cn(
                                  'w-full rounded-md border px-2.5 py-2 text-left transition',
                                  nodeClasses(memoStatus, 'blue'),
                                  'hover:border-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400',
                                  'dark:hover:border-neutral-600',
                                  selected && 'ring-1 ring-neutral-400 dark:ring-neutral-500',
                                )}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <p className="min-w-0 truncate text-[10px] font-semibold">
                                    <span className="mr-1 text-neutral-400">R{memo.round}</span>
                                    {memo.title}
                                  </p>
                                  {isCurrentMemo ? (
                                    <StatusBadge status={memoStatus} currentTone="blue" />
                                  ) : (
                                    <span className="shrink-0 text-[9px] text-neutral-400">{memo.time}</span>
                                  )}
                                </div>
                                <p className="mt-1 line-clamp-2 text-[9px] leading-4 text-neutral-500 dark:text-neutral-400">
                                  {memo.inputPoints[0]} · {memo.conclusion}
                                </p>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
