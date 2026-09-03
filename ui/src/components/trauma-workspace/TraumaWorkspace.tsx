import { ChevronLeft, ChevronRight, RotateCcw, ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cn } from '../../lib/utils';
import DemoTranscript from './DemoTranscript';
import { DEMO_TRAUMA_ROUNDS, TRAUMA_STAGES } from './demoCase';
import MemoDetailPanel from './MemoDetailPanel';
import TreatmentTree from './TreatmentTree';

type TraumaWorkspaceProps = {
  resetKey: string;
};

export default function TraumaWorkspace({ resetKey }: TraumaWorkspaceProps) {
  const [currentRoundIndex, setCurrentRoundIndex] = useState(0);
  const [selectedMemoId, setSelectedMemoId] = useState<string | null>(null);

  useEffect(() => {
    setCurrentRoundIndex(0);
    setSelectedMemoId(null);
  }, [resetKey]);

  const currentRound = DEMO_TRAUMA_ROUNDS[currentRoundIndex];
  const stage = TRAUMA_STAGES.find((item) => item.id === currentRound.stageId);
  const substep = stage?.substeps[currentRound.substepIndex];
  const selectedMemo = useMemo(
    () => DEMO_TRAUMA_ROUNDS.find((round) => round.id === selectedMemoId) ?? null,
    [selectedMemoId],
  );

  const goToRound = (nextIndex: number) => {
    setCurrentRoundIndex(Math.max(0, Math.min(DEMO_TRAUMA_ROUNDS.length - 1, nextIndex)));
    setSelectedMemoId(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-neutral-50/50 dark:bg-neutral-950">
      <div className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-1 border-b border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950 sm:grid-cols-5">
        <StatusCell className="col-span-2 sm:col-span-1" label="案例概况" value="爆炸冲击后胸部损伤 · 右小腿开放伤" />
        <StatusCell label="当前位置" value={currentRound.facility} tone="info" />
        <StatusCell label="当前阶段" value={`${stage?.index} · ${substep?.name}`} />
        <StatusCell label="伤后时间" value={currentRound.elapsed} tone={currentRound.timing.warning ? 'warning' : undefined} />
        <StatusCell label="阶段转换" value={currentRound.transitionLabel} tone={currentRound.transitionTone} />
      </div>

      <div className={cn(
        'grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(420px,1fr)_minmax(420px,1fr)] gap-2 overflow-y-auto p-2 lg:grid-rows-1 lg:overflow-hidden',
        selectedMemo
          ? 'lg:grid-cols-[minmax(0,54fr)_minmax(0,46fr)]'
          : 'lg:grid-cols-[minmax(0,1fr)_300px] 2xl:grid-cols-[minmax(0,80fr)_minmax(0,20fr)]',
      )}
      >
        <section
          aria-label="伤情推演对话"
          className="min-h-0 min-w-0 overflow-hidden border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-950 lg:rounded-xl lg:border lg:shadow-sm"
        >
          <DemoTranscript rounds={DEMO_TRAUMA_ROUNDS} currentRoundIndex={currentRoundIndex} />
        </section>

        <section
          aria-labelledby="trauma-workflow-title"
          className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950"
        >
          <header className="flex min-h-12 min-w-0 items-center justify-between gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
            <div className="min-w-0">
              <h2 id="trauma-workflow-title" className="truncate text-[12px] font-semibold">分级救治全过程</h2>
              <p className="truncate text-[9px] text-neutral-400">主级 → 子级 → 轮次纪要</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => goToRound(0)}
                className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                aria-label="重新播放演示流程"
                title="重新播放演示流程"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => goToRound(currentRoundIndex - 1)}
                disabled={currentRoundIndex === 0}
                className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                aria-label="上一轮演示"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-9 text-center text-[9px] tabular-nums text-neutral-500">
                {currentRoundIndex + 1}/{DEMO_TRAUMA_ROUNDS.length}
              </span>
              <button
                type="button"
                onClick={() => goToRound(currentRoundIndex + 1)}
                disabled={currentRoundIndex === DEMO_TRAUMA_ROUNDS.length - 1}
                className="flex h-7 w-7 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                aria-label="下一轮演示"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </header>

          <div className={cn(
            'grid min-h-0 min-w-0 grid-cols-1 overflow-hidden',
            selectedMemo && 'grid-rows-[minmax(0,44%)_minmax(0,56%)] xl:grid-cols-[minmax(0,38fr)_minmax(0,62fr)] xl:grid-rows-1',
          )}
          >
            <div className={cn(
              'min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-3',
              selectedMemo && 'border-b border-neutral-200 dark:border-neutral-800 xl:border-b-0 xl:border-r',
            )}
            >
              <div className="mb-3 flex items-start gap-2 rounded-md border border-neutral-200 bg-neutral-50 px-2.5 py-2 dark:border-neutral-800 dark:bg-neutral-900">
                <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-neutral-400" />
                <p className="text-[9px] leading-4 text-neutral-500 dark:text-neutral-400">
                  第一期为演示样例：左侧对话与右侧状态均来自固定案例，真实会话将在第二期接入。
                </p>
              </div>
              <TreatmentTree
                stages={TRAUMA_STAGES}
                rounds={DEMO_TRAUMA_ROUNDS}
                currentRoundIndex={currentRoundIndex}
                selectedMemoId={selectedMemoId}
                onSelectMemo={(memoId) => setSelectedMemoId((current) => current === memoId ? null : memoId)}
              />
            </div>

            {selectedMemo ? (
              <aside aria-label="轮次纪要详情" className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden bg-neutral-50/60 p-3 dark:bg-neutral-900/25">
                <MemoDetailPanel
                  memo={selectedMemo}
                  isLatest={selectedMemo.round === currentRound.round}
                  onClose={() => setSelectedMemoId(null)}
                />
              </aside>
            ) : null}
          </div>
        </section>
      </div>

      <p className="hidden shrink-0 px-3 pb-1.5 text-right text-[9px] text-neutral-400 lg:block">
        推演结果仅供辅助，须由具备资质的医务人员结合现场情况复核。
      </p>
    </div>
  );
}

function StatusCell({
  label,
  value,
  tone,
  className,
}: {
  label: string;
  value: string;
  tone?: 'info' | 'warning' | 'danger' | 'success';
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <p className="text-[9px] text-neutral-400">{label}</p>
      <p className={cn(
        'truncate text-[10px] font-medium text-neutral-700 dark:text-neutral-200',
        tone === 'info' && 'text-teal-700 dark:text-teal-300',
        tone === 'warning' && 'text-amber-700 dark:text-amber-300',
        tone === 'danger' && 'text-red-700 dark:text-red-300',
        tone === 'success' && 'text-emerald-700 dark:text-emerald-300',
      )}
      >
        {value}
      </p>
    </div>
  );
}
