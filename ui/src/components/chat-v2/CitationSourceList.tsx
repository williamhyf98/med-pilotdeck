import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { CitationMetadata } from '../chat/types/types';

/**
 * 正文下方的「参考来源」折叠列表。
 *
 * 数据来自消息上的 `citations`，由网关在正文流式输出结束的瞬间随
 * `assistant_text_end` 一并下发，因此不必等整轮推演（含右侧细节页面）跑完。
 * 编号沿用本轮 promptChunks 的顺序，与正文角标、右侧「知识块依据」三方一致。
 */
export default function CitationSourceList({
  citations,
  isStreaming,
}: {
  citations?: CitationMetadata[];
  isStreaming?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // 流式期间消息上挂的是本轮候选引用（promptChunks 全量），正文还没写完，
  // 列不出「实际引用了哪些」。等 stream_end 带回最终列表再整块出现。
  if (isStreaming) return null;
  if (!citations || citations.length === 0) return null;

  return (
    <div className="mt-3 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] font-medium text-neutral-600 transition hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
      >
        <span>参考来源 · {citations.length} 条</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open ? (
        <ul className="space-y-1.5 border-t border-neutral-200 px-3 py-2.5 dark:border-neutral-800">
          {citations.map((citation) => (
            <li key={citation.index} className="flex gap-2 text-[12px] leading-5">
              <span className="mt-0.5 shrink-0 rounded bg-blue-100 px-1 text-[11px] font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                [{citation.index}]
              </span>
              <span className="min-w-0 text-neutral-600 dark:text-neutral-300">
                <span className="font-medium text-neutral-800 dark:text-neutral-100">
                  {citation.title}
                </span>
                {citation.section ? (
                  <span className="text-neutral-500 dark:text-neutral-400"> › {citation.section}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
