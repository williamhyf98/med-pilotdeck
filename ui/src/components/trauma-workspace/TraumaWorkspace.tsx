import { ShieldAlert } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { cn } from '../../lib/utils';
import { TRAUMA_STAGES } from './demoCase';
import StageOverrideDialog from './detail/StageOverrideDialog';
import { snapshotsToRounds } from './domain/snapshotAdapter';
import type { TurnFormInput } from './domain/types';
import { SUBSTAGE_ORDER, SUBSTAGE_TO_MAIN } from './domain/stageConfig';
import MemoDetailPanel from './MemoDetailPanel';
import { useCaseStore } from './store/useCaseStore';
import TraumaComposer from './TraumaComposer';
import TreatmentTree, { type TreePosition } from './TreatmentTree';

const INITIAL_POSITION: TreePosition = {
  stageId: TRAUMA_STAGES[0]!.id,
  substepIndex: 0,
  round: null,
  unplaced: true,
};

type TraumaWorkspaceProps = {
  resetKey: string;
  projectKey?: string;
  sessionId?: string;
  onSubmitForm?: (
    form: TurnFormInput,
    rawInput: string,
    traumaExtract?: boolean,
    attachments?: Array<{ path: string; name: string }>,
  ) => void | Promise<void>;
  onAbortTurn?: () => void;
  submitting?: boolean;
  pendingRun?: {
    runId: string;
    mainStage?: string;
    subStage?: string;
    round?: number;
  } | null;
  onNavigateToChatMessage?: (runId: string) => void | Promise<void>;
  runtimePanel?: ReactNode;
};

export default function TraumaWorkspace({
  resetKey,
  projectKey,
  sessionId,
  onSubmitForm = () => undefined,
  onAbortTurn,
  submitting = false,
  pendingRun = null,
  onNavigateToChatMessage,
  runtimePanel,
}: TraumaWorkspaceProps) {
  const [selectedMemoId, setSelectedMemoId] = useState<string | null>(null);
  const [showStageOverride, setShowStageOverride] = useState(false);
  const autoOpenedPendingRunRef = useRef<string | null>(null);
  const caseStore = useCaseStore(projectKey, sessionId);
  const rounds = useMemo(
    () => snapshotsToRounds(caseStore.snapshots, caseStore.current),
    [caseStore.current, caseStore.snapshots],
  );
  const hasLiveCase = Boolean(caseStore.current && rounds.length > 0);
  const currentRoundIndex = Math.max(0, rounds.length - 1);
  const currentRound = rounds.at(-1);
  const position: TreePosition = currentRound
    ? {
      stageId: currentRound.stageId,
      substepIndex: currentRound.substepIndex,
      round: currentRound.round,
      blocked: currentRound.gate.status === 'BLOCKED',
      transferPending: currentRound.transitionTone === 'warning',
      unplaced: Boolean(currentRound.unplaced || !caseStore.current?.currentSubStage),
    }
    : INITIAL_POSITION;
  const stage = TRAUMA_STAGES.find((item) => item.id === position.stageId);
  const substep = position.substepIndex === null ? undefined : stage?.substeps[position.substepIndex];
  const selectedMemo = useMemo(
    () => rounds.find((round) => round.id === selectedMemoId) ?? null,
    [rounds, selectedMemoId],
  );
  const pendingMemo = useMemo(() => {
    if (!pendingRun) return null;
    return rounds.find((round) => round.triggerMessageId === pendingRun.runId)
      ?? (pendingRun.round
        ? rounds.find((round) => round.round === pendingRun.round)
        : null);
  }, [pendingRun, rounds]);
  const pendingPosition = useMemo(() => {
    if (!pendingRun || pendingMemo) return null;
    const mainStage = TRAUMA_STAGES.some((item) => item.id === pendingRun.mainStage)
      ? pendingRun.mainStage as TreePosition['stageId']
      : null;
    const subStage = SUBSTAGE_ORDER.some((item) => item === pendingRun.subStage)
      ? pendingRun.subStage as typeof SUBSTAGE_ORDER[number]
      : null;
    if (mainStage && subStage && SUBSTAGE_TO_MAIN[subStage] === mainStage) {
      return {
        runId: pendingRun.runId,
        stageId: mainStage,
        substepIndex: SUBSTAGE_ORDER
          .filter((item) => SUBSTAGE_TO_MAIN[item] === mainStage)
          .indexOf(subStage),
        round: pendingRun.round,
      };
    }
    if (currentRound && currentRound.stageId && currentRound.substepIndex !== null) {
      return {
        runId: pendingRun.runId,
        stageId: currentRound.stageId,
        substepIndex: currentRound.substepIndex,
        round: pendingRun.round,
      };
    }
    // 级别还没确认时不猜位置。后端在判不出级别时也拒绝回退到Ⅰ级初级急救
    // （见 src/trauma/placement.ts 的注释），前端不该替它做这个假设。
    return null;
  }, [currentRound, pendingRun, pendingMemo]);
  const viewingHistoricalSnapshot = Boolean(
    selectedMemo?.snapshotVersion
    && selectedMemo.snapshotVersion !== caseStore.current?.version,
  );

  useEffect(() => {
    setSelectedMemoId(null);
    setShowStageOverride(false);
    autoOpenedPendingRunRef.current = null;
  }, [resetKey]);

  useEffect(() => {
    const pendingRunKey = pendingMemo?.triggerMessageId ?? pendingRun?.runId ?? null;
    if (pendingMemo && autoOpenedPendingRunRef.current !== pendingRunKey) {
      setSelectedMemoId(pendingMemo.id);
      autoOpenedPendingRunRef.current = pendingRunKey;
    }
  }, [pendingMemo, pendingRun?.runId]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-neutral-50/50 dark:bg-neutral-950">
      <div className="grid shrink-0 grid-cols-2 gap-x-3 gap-y-1 border-b border-neutral-200 bg-white px-3 py-2 dark:border-neutral-800 dark:bg-neutral-950 sm:grid-cols-4">
        <StatusCell label="病例进度" value={caseStore.current ? `第 ${caseStore.current.round} 轮` : '等待首轮提交'} />
        <StatusCell
          label="当前位置"
          value={caseStore.current?.currentSubStage && caseStore.current.currentFacility
            ? caseStore.current.currentFacility.name
            : '未定级'}
          tone="info"
        />
        <StatusCell
          label="当前阶段"
          value={caseStore.current?.currentSubStage ? `${stage?.index} · ${substep?.name}` : '由系统判定'}
        />
        <StatusCell
          label="阶段转换"
          value={currentRound?.transitionLabel ?? '待首轮推演'}
          tone={currentRound?.transitionTone}
        />
      </div>

      <div className={cn(
        'grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] gap-2 overflow-hidden p-2',
        selectedMemo
          ? 'lg:grid-cols-[minmax(0,54fr)_minmax(0,46fr)] lg:grid-rows-1'
          : 'lg:grid-cols-[minmax(0,1fr)_300px] lg:grid-rows-1 2xl:grid-cols-[minmax(0,80fr)_minmax(0,20fr)]',
      )}
      >
        <section
          aria-label="伤情推演工作区"
          className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950"
        >
          <div className="min-h-0 overflow-hidden bg-white dark:bg-neutral-950">
            {runtimePanel ? (
              <div
                role="region"
                aria-label="推演对话"
                className="h-full min-h-0 overflow-hidden"
              >
                {runtimePanel}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center px-6 text-center text-[12px] text-neutral-400 dark:text-neutral-500">
                等待对话区初始化…
              </div>
            )}
          </div>
          <div className="max-h-[58vh] overflow-y-auto border-t border-neutral-200 bg-neutral-50/50 p-4 dark:border-neutral-800 dark:bg-neutral-900/20">
            <TraumaComposer
              key={`${caseStore.current?.caseId ?? 'unpersisted'}:${resetKey}`}
              projectKey={projectKey}
              sessionId={sessionId}
              previousSubStage={caseStore.current?.currentSubStage ?? null}
              onSubmit={onSubmitForm}
              onAbort={onAbortTurn}
              submitting={submitting}
            />
          </div>
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
            <span className="text-[9px] text-neutral-500">
              {hasLiveCase ? `实时病例 · R${position.round}` : '等待首轮推演'}
            </span>
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
                  {hasLiveCase
                    ? '当前流程树由真实病例快照驱动；阶段转换建议不会自动执行，救治级别落位确认与带审计人工覆盖仍按独立流程处理。'
                    : '新建病例尚无轮次纪要。请提交本轮伤情表单，系统将按分级定义判定应处级别。'}
                </p>
              </div>
              {caseStore.error ? (
                <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[10px] text-red-700 dark:border-red-900 dark:bg-red-950/25 dark:text-red-300">
                  病例状态加载失败：{caseStore.error}
                </div>
              ) : (
                <TreatmentTree
                  stages={TRAUMA_STAGES}
                  rounds={rounds}
                  currentRoundIndex={currentRoundIndex}
                  position={position}
                  pendingRound={pendingPosition}
                  selectedMemoId={selectedMemoId}
                  onSelectMemo={(memoId) => {
                    setSelectedMemoId((current) => current === memoId ? null : memoId);
                    const memo = rounds.find((item) => item.id === memoId);
                    if (memo?.triggerMessageId) {
                      void onNavigateToChatMessage?.(memo.triggerMessageId);
                    }
                  }}
                  onRequestStageOverride={hasLiveCase ? () => setShowStageOverride(true) : undefined}
                  canOverrideStage={!viewingHistoricalSnapshot}
                />
              )}
              {showStageOverride && caseStore.current && !viewingHistoricalSnapshot ? (
                <div className="mt-3">
                  <StageOverrideDialog
                    state={caseStore.current}
                    onClose={() => setShowStageOverride(false)}
                    onSubmit={async (override) => {
                      const response = await fetch(
                        `/api/trauma/cases/${encodeURIComponent(sessionId ?? '')}/override`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ projectKey, actorId: 'web-user', ...override }),
                        },
                      );
                      if (!response.ok) throw new Error('阶段调整失败');
                      setShowStageOverride(false);
                      await caseStore.refresh();
                    }}
                  />
                </div>
              ) : null}
            </div>

            {selectedMemo ? (
              <aside aria-label="轮次纪要详情" className="min-h-0 min-w-0 overflow-y-auto overflow-x-hidden bg-neutral-50/60 p-3 dark:bg-neutral-900/25">
                <MemoDetailPanel
                  memo={selectedMemo}
                  isLatest={selectedMemo.round === position.round}
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
}: {
  label: string;
  value: string;
  tone?: 'info' | 'warning' | 'danger' | 'success';
}) {
  return (
    <div className="min-w-0">
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
