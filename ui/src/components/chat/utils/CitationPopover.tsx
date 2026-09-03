import type { ReactNode } from 'react';
import Tooltip from '../../../shared/view/ui/Tooltip';
import type { CitationMetadata } from '../types/types';

type CitationPopoverProps = {
  citations: CitationMetadata[];
  className?: string;
};

/**
 * 为 remark 插件拦截的 <cite> 节点提供渲染组件。
 * 接受自定义 data-* 属性（由 remark 插件注入），hover 显示引用详情卡片。
 */
export function CitationPopover({
  'data-citation-index': index,
  citations,
  className,
  ...rest
}: {
  'data-citation-index'?: string;
  citations?: CitationMetadata[];
  className?: string;
  [key: string]: unknown;
}) {
  const citeIndex = parseInt(index ?? '', 10);
  const cite = citations?.find((c) => c.index === citeIndex);

  if (!cite) {
    return (
      <sup className="inline-flex items-center">
        <span className="cursor-default rounded bg-gray-200 px-1 text-xs font-medium text-gray-500 dark:bg-gray-700 dark:text-gray-400">
          [{index ?? '?'}]
        </span>
      </sup>
    );
  }

  const tooltipContent: ReactNode = (
    <div className="max-w-xs whitespace-normal text-left leading-relaxed">
      <div className="font-semibold text-sm mb-1">{cite.title}</div>
      {cite.section && (
        <div className="text-xs opacity-80 mb-1">{cite.section}</div>
      )}
      {(cite.evidenceGrade || cite.evidenceQuality) && (
        <div className="text-xs mt-1 flex gap-2">
          {cite.evidenceGrade && (
            <span className="rounded bg-white/20 px-1 py-0.5">
              证据等级: {cite.evidenceGrade}
            </span>
          )}
          {cite.evidenceQuality && (
            <span className="rounded bg-white/20 px-1 py-0.5">
              质量: {cite.evidenceQuality}
            </span>
          )}
        </div>
      )}
    </div>
  );

  return (
    <Tooltip content={tooltipContent} position="top" delay={200}>
      <sup className="inline-flex items-center">
        <span className="cursor-pointer rounded bg-blue-100 px-1 text-xs font-medium text-blue-700 hover:bg-blue-200 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800">
          [{cite.index}]
        </span>
      </sup>
    </Tooltip>
  );
}