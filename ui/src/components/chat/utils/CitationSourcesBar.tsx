import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import {
  CitationChunkModal,
  EvidenceMarks,
  resolveHeadline,
  toExcerpt,
} from './CitationPopover';
import { orderCitationsForSources, type OrderedCitation } from './ragCitations';
import type { CitationMetadata } from '../types/types';

const citedBadgeClassName =
  'mt-0.5 shrink-0 rounded bg-blue-100 px-1 text-xs font-medium tabular-nums text-blue-700 dark:bg-blue-900 dark:text-blue-300';
const uncitedBadgeClassName =
  'mt-0.5 shrink-0 rounded bg-neutral-100 px-1 text-xs font-medium tabular-nums text-neutral-500 dark:bg-neutral-800 dark:text-neutral-400';

/**
 * 回答末尾的「参考来源」折叠条：模型不再手写来源列表（提示词已禁止、存量列表被
 * stripReferenceDetails 隐藏），来源改由这里根据检索结果自绘 —— 默认收起一行
 * 「参考来源 · N」，展开是干净的来源卡片，点卡片开与行内角标同一个全文弹窗。
 * 被正文引用过的来源在前、编号与角标一致，未被引用的检索命中续号排后（浅色徽标）。
 */
export function CitationSourcesBar({
  citations,
  displayMap,
}: {
  citations: CitationMetadata[];
  displayMap: Map<number, number>;
}) {
  const { t } = useTranslation('chat');
  const [openEntry, setOpenEntry] = useState<OrderedCitation | null>(null);
  const entries = useMemo(
    () => orderCitationsForSources(displayMap, citations),
    [displayMap, citations],
  );
  if (entries.length === 0) return null;

  return (
    <div className="not-prose mt-3">
      <details className="group">
        <summary className="flex w-fit cursor-pointer select-none items-center gap-1 rounded px-1 py-0.5 text-xs text-neutral-400 transition-colors [&::-webkit-details-marker]:hidden hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">
          <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" strokeWidth={2} />
          <span>
            {t('citations.summary', {
              total: entries.length,
              defaultValue: '参考来源 · {{total}}',
            })}
          </span>
        </summary>
        <ul className="mt-1.5 space-y-0.5 border-l-2 border-neutral-200 pl-3 dark:border-neutral-700">
          {entries.map((entry) => {
            const { title, section } = resolveHeadline(entry.citation);
            const excerpt = toExcerpt(entry.citation.text);
            return (
              <li key={entry.citation.chunkId ?? `index-${entry.citation.index}`}>
                <button
                  type="button"
                  onClick={() => setOpenEntry(entry)}
                  className="flex w-full items-start gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-neutral-800"
                >
                  <span className={entry.citedInline ? citedBadgeClassName : uncitedBadgeClassName}>
                    [{entry.display}]
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="break-words text-[13px] font-medium leading-snug text-neutral-800 dark:text-neutral-200">
                      {title}
                    </div>
                    {section && (
                      <div className="break-words text-xs text-neutral-500 dark:text-neutral-400">
                        {section}
                      </div>
                    )}
                    <EvidenceMarks cite={entry.citation} tone="modal" />
                    {excerpt && (
                      <div className="mt-0.5 break-words text-xs text-neutral-400 dark:text-neutral-500">
                        {excerpt}
                      </div>
                    )}
                  </div>
                  {entry.citation.score !== undefined && (
                    <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-neutral-400 dark:text-neutral-500">
                      {entry.citation.score.toFixed(4)}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      </details>
      {openEntry && (
        <CitationChunkModal
          cite={openEntry.citation}
          displayIndex={openEntry.display}
          onClose={() => setOpenEntry(null)}
        />
      )}
    </div>
  );
}
