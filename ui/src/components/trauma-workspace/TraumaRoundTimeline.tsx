import { Activity, ClipboardList } from 'lucide-react';
import { Markdown } from '../chat/view/subcomponents/Markdown';
import { subStageLabel, toChineseDisplayText } from './domain/displayLabels';
import type { CaseSnapshot, NarrativeEntry, VitalItemKey } from './domain/types';

type TraumaRoundTimelineProps = {
  snapshots: CaseSnapshot[];
  loading?: boolean;
};

const vitalLabels: Record<VitalItemKey, { label: string; unit: string }> = {
  respiratoryRate: { label: '呼吸', unit: '次/分' },
  systolicBloodPressure: { label: '收缩压', unit: 'mmHg' },
  heartRate: { label: '心率', unit: '次/分' },
  temperature: { label: '体温', unit: '℃' },
};

function entriesAtRound(entries: NarrativeEntry[], round: number): string[] {
  return entries.filter((entry) => entry.round === round).map((entry) => entry.text);
}

export default function TraumaRoundTimeline({
  snapshots,
  loading = false,
}: TraumaRoundTimelineProps) {
  const turns = snapshots
    .filter((snapshot) => snapshot.eventType === 'agent_turn')
    .sort((left, right) => left.round - right.round);

  return (
    <section aria-label="推演轮次时间线" className="min-h-0 overflow-y-auto">
      {turns.length === 0 ? (
        <div className="flex min-h-48 flex-col items-center justify-center px-6 text-center">
          <ClipboardList className="h-7 w-7 text-neutral-300 dark:text-neutral-700" />
          <p className="mt-3 text-xs font-medium text-neutral-600 dark:text-neutral-300">
            {loading ? '正在读取病例记录…' : '尚无推演轮次'}
          </p>
          <p className="mt-1 text-[10px] leading-4 text-neutral-400">填写下方表单后，本轮输入摘要与系统研判将显示在这里。</p>
        </div>
      ) : (
        <ol className="space-y-4 p-4">
          {turns.map((snapshot) => {
            const state = snapshot.state;
            const round = snapshot.round;
            const sections = snapshot.form
              ? [
                ['伤情', snapshot.form.injuryNarrative ? [snapshot.form.injuryNarrative] : []],
                ['已做处置', snapshot.form.treatmentNarrative ? [snapshot.form.treatmentNarrative] : []],
                ['后送条件', snapshot.form.evacuationNarrative ? [snapshot.form.evacuationNarrative] : []],
                ['补充说明', snapshot.form.note ? [snapshot.form.note] : []],
              ] as const
              : [
                ['伤情', entriesAtRound(state.injuryNarratives, round)],
                ['已做处置', entriesAtRound(state.treatmentNarratives, round)],
                ['后送条件', entriesAtRound(state.evacuationNarratives, round)],
                ['补充说明', entriesAtRound(state.notes, round)],
              ] as const;
            const vitalValues = snapshot.form
              ? [snapshot.form.vitals]
              : state.vitalSignsHistory
                .filter((record) => record.round === round)
                .map((record) => record.values);
            const vitals = vitalValues
              .flatMap((values) => Object.entries(values))
              .filter((entry): entry is [VitalItemKey, number] =>
                entry[0] in vitalLabels && typeof entry[1] === 'number');
            const subStage = snapshot.form?.statedSubStage ?? null;

            return (
              <li key={`${snapshot.triggerMessageId}-${round}`} className="relative pl-5">
                <span className="absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-teal-600 ring-1 ring-teal-200 dark:border-neutral-950 dark:ring-teal-900" />
                <article className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm dark:border-neutral-800 dark:bg-neutral-950">
                  <header className="flex items-center justify-between gap-3 border-b border-neutral-200 bg-neutral-50/80 px-3 py-2 dark:border-neutral-800 dark:bg-neutral-900/50">
                    <h3 className="text-[11px] font-semibold">第 {round} 轮提交</h3>
                    <time className="text-[9px] text-neutral-400">
                      {new Date(snapshot.createdAt).toLocaleString()}
                    </time>
                  </header>
                  <div className="space-y-1.5 px-3 py-2.5 text-[10px] leading-5 text-neutral-600 dark:text-neutral-300">
                    <p>明示级别：{subStage ? subStageLabel(subStage) : '由系统判定'}</p>
                    {sections.flatMap(([label, entries]) =>
                      entries.map((text, index) => <p key={`${label}-${index}`}>{label}：{text}</p>))}
                    {vitals.length > 0 ? (
                      <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="inline-flex items-center gap-1 font-medium text-neutral-700 dark:text-neutral-200">
                          <Activity className="h-3 w-3 text-teal-600" />
                          本轮实测：
                        </span>
                        {vitals.map(([key, value]) => (
                          <span key={key}>{vitalLabels[key].label} {value} {vitalLabels[key].unit}</span>
                        ))}
                      </p>
                    ) : null}
                  </div>
                  <div className="border-t border-neutral-200 px-3 py-3 dark:border-neutral-800">
                    <p className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-teal-700 dark:text-teal-300">系统研判</p>
                    <Markdown className="prose prose-sm prose-neutral max-w-none text-[11px] leading-5 dark:prose-invert prose-headings:mb-1 prose-headings:mt-3 prose-p:my-1.5 prose-ol:my-1.5 prose-ul:my-1.5">
                      {snapshot.response?.naturalLanguageAnswer
                        ? toChineseDisplayText(snapshot.response.naturalLanguageAnswer)
                        : '本轮研判结果尚未生成。'}
                    </Markdown>
                  </div>
                </article>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
