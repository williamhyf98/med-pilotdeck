import { useMemo, useState } from 'react';
import { laterSubStages, SUBSTAGE_LABELS, SUBSTAGE_TO_MAIN } from '../domain/stageConfig';
import type { CaseState, SubStage } from '../domain/types';

type StageOverrideDialogProps = {
  state: CaseState;
  onClose: () => void;
  onSubmit: (input: {
    toStage: CaseState['currentStage'];
    toSubStage: SubStage;
    reason: string;
    riskAcknowledged: true;
    blockedOverrideConfirmed?: boolean;
  }) => Promise<void> | void;
};

export default function StageOverrideDialog({
  state,
  onClose,
  onSubmit,
}: StageOverrideDialogProps) {
  const options = useMemo(() => laterSubStages(state.currentSubStage), [state.currentSubStage]);
  const [target, setTarget] = useState<SubStage | ''>(options[0] ?? '');
  const [reason, setReason] = useState('');
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [blockedConfirmed, setBlockedConfirmed] = useState(false);

  const canSubmit = Boolean(
    target
    && reason.trim()
    && riskAcknowledged
    && (state.transport.gateStatus !== 'BLOCKED' || blockedConfirmed),
  );

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="stage-override-title" className="rounded-lg border border-neutral-200 bg-white p-4 shadow-lg dark:border-neutral-800 dark:bg-neutral-950">
      <h2 id="stage-override-title" className="text-sm font-semibold">调整救治阶段</h2>
      <p className="mt-1 text-[10px] text-neutral-500">人工覆盖只允许选择当前子级之后的救治阶段，并会写入审计记录。</p>

      <label className="mt-3 block text-[10px] font-medium">
        目标阶段
        <select
          aria-label="目标阶段"
          value={target}
          onChange={(event) => setTarget(event.target.value as SubStage)}
          className="mt-1 w-full rounded-md border border-neutral-300 bg-white px-2 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
        >
          {options.map((substage) => (
            <option key={substage} value={substage}>{SUBSTAGE_LABELS[substage]}</option>
          ))}
        </select>
      </label>

      <label className="mt-3 block text-[10px] font-medium">
        调整理由
        <textarea
          aria-label="调整理由"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="mt-1 min-h-16 w-full rounded-md border border-neutral-300 bg-white px-2 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
        />
      </label>

      <label className="mt-2 flex items-start gap-2 text-[10px] text-neutral-600 dark:text-neutral-300">
        <input
          type="checkbox"
          checked={riskAcknowledged}
          onChange={(event) => setRiskAcknowledged(event.target.checked)}
        />
        我已知晓人工阶段调整可能绕过当前 Gate 建议
      </label>

      {state.transport.gateStatus === 'BLOCKED' ? (
        <label className="mt-2 flex items-start gap-2 text-[10px] text-red-700 dark:text-red-300">
          <input
            type="checkbox"
            checked={blockedConfirmed}
            onChange={(event) => setBlockedConfirmed(event.target.checked)}
          />
          当前处于阻塞状态，我再次确认承担未解决风险
        </label>
      ) : null}

      <div className="mt-4 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-neutral-500">取消</button>
        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => {
            if (!target || !canSubmit) return;
            void onSubmit({
              toStage: SUBSTAGE_TO_MAIN[target],
              toSubStage: target,
              reason: reason.trim(),
              riskAcknowledged: true,
              blockedOverrideConfirmed: state.transport.gateStatus === 'BLOCKED'
                ? blockedConfirmed
                : undefined,
            });
          }}
          className="rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white disabled:opacity-40 dark:bg-neutral-100 dark:text-neutral-900"
        >
          确认调整
        </button>
      </div>
    </div>
  );
}
