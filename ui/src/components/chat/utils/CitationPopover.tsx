import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Tooltip from '../../../shared/view/ui/Tooltip';
import {
  splitCitationLabel,
  splitFigureBlock,
  stripDisambiguationSuffix,
  stripGradeSuffix,
} from './ragCitations';
import type { CitationMetadata } from '../types/types';

/**
 * hover 卡片里的原文摘要长度。Tooltip 宽 max-w-xs（320px），再长就糊成一整片，
 * 而且 Tooltip 的 portal 容器带 pointer-events-none，长文在里面既不能滚也不能选。
 * 想看全文走点击弹窗。
 */
const EXCERPT_LIMIT = 120;

const badgeClassName =
  'cursor-pointer rounded bg-blue-100 px-1 text-xs font-medium text-blue-700 transition-colors hover:bg-blue-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:bg-blue-900 dark:text-blue-300 dark:hover:bg-blue-800';

/** 摘要要压成一行一行的散文，chunk 原文里的换行在窄卡片里只会撑出锯齿。 */
export function toExcerpt(text: string | undefined): string {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_LIMIT) return flat;
  return `${flat.slice(0, EXCERPT_LIMIT)}…`;
}

/**
 * 卡片抬头：优先用工具下发的结构化 title/section，读起来干净；两者皆空才回退
 * 解析 display_label（老会话从尾部列表刮出来的引用只有 label）。无论哪条路，
 * 章节尾部的 `·「正文首句…」` 消歧后缀都剥掉 —— 同名条目的区分交给摘录行和
 * 弹窗正文，不再塞进抬头。
 */
export function resolveHeadline(cite: CitationMetadata): { title: string; section: string } {
  const structuredTitle = cite.title?.trim() ?? '';
  const structuredSection = stripDisambiguationSuffix(cite.section?.trim() ?? '');
  if (structuredTitle) return { title: structuredTitle, section: structuredSection };

  const label = cite.label?.trim();
  if (label) {
    const stripped = stripGradeSuffix(label, [cite.evidenceGrade ?? '', cite.evidenceQuality ?? '']);
    const parsed = splitCitationLabel(stripped);
    if (parsed.title) {
      return { title: parsed.title, section: stripDisambiguationSuffix(parsed.section) };
    }
  }
  return { title: '未标注文献', section: structuredSection };
}

export function EvidenceMarks({ cite, tone }: { cite: CitationMetadata; tone: 'tooltip' | 'modal' }) {
  if (!cite.evidenceGrade && !cite.evidenceQuality) return null;
  // Tooltip 在暗色主题下底色翻成浅灰（Tooltip.tsx:184 的 dark:bg-gray-100），
  // 只给 bg-white/20 的话徽标会糊在背景里看不见。
  const chipClassName = tone === 'tooltip'
    ? 'rounded bg-white/20 px-1 py-0.5 dark:bg-black/10'
    : 'rounded bg-blue-50 px-1.5 py-0.5 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
  return (
    <div className="mt-1 flex flex-wrap gap-2 text-xs">
      {cite.evidenceGrade && <span className={chipClassName}>证据等级: {cite.evidenceGrade}</span>}
      {cite.evidenceQuality && <span className={chipClassName}>质量: {cite.evidenceQuality}</span>}
    </div>
  );
}

/** 图注常是「①…②…③…」连排，圈号前断行让每条图注独立成行（U+2460-2473 连续）。 */
function breakFigureItems(text: string): string {
  return text.replace(/\s*([①-⑳])/g, '\n$1').replace(/^\n/, '');
}

/**
 * chunk 全文的分段渲染：按空行拆段（段内单换行仍由 pre-wrap 断行，枚举行不被
 * 过度拉开），`相关图示：` 之后的内容拆成独立小节。
 */
function ChunkBody({ text }: { text: string }) {
  const { body, figures } = splitFigureBlock(text);
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter(Boolean);
  return (
    <div className="space-y-2 text-sm leading-relaxed text-neutral-800 dark:text-neutral-200">
      {paragraphs.map((paragraph, position) => (
        <p key={position} className="whitespace-pre-wrap break-words">
          {paragraph}
        </p>
      ))}
      {figures && (
        <div className="rounded bg-neutral-50 px-3 py-2 dark:bg-neutral-800/60">
          <div className="mb-1 text-xs font-medium text-neutral-400 dark:text-neutral-500">相关图示</div>
          <p className="whitespace-pre-wrap break-words">{breakFigureItems(figures)}</p>
        </div>
      )}
    </div>
  );
}

/**
 * 点开角标后的 chunk 全文弹窗。
 *
 * 存在的理由是排查引用是否引错：看得到原文，才能判断「止血带那段引到呼吸道文献」
 * 是模型写错了编号，还是这条 chunk 本身就被检索错了 —— 后者还能顺带看到命中它的
 * 检索式。chunk_id 放在最底下的小灰字里，只作回溯语料用，不进正文也不进引用列表。
 */
export function CitationChunkModal({
  cite,
  displayIndex,
  onClose,
}: {
  cite: CitationMetadata;
  displayIndex: number;
  onClose: () => void;
}) {
  // 选中正文往外拖再松手，click 会落在遮罩上。只认「按下和抬起都在遮罩」的那一次，
  // 否则划词复制一段原文就会把弹窗关掉 —— 而看原文正是这个弹窗存在的理由。
  const pressedBackdrop = useRef(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // Keep the chat behind the modal from scrolling under the overlay.
  useEffect(() => {
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, []);

  if (typeof document === 'undefined') return null;

  const { title, section } = resolveHeadline(cite);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`引用 ${displayIndex} 原文`}
      className="fixed inset-0 z-[2147483646] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget || !pressedBackdrop.current) return;
        onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-white shadow-2xl dark:bg-neutral-900">
        <div className="flex items-start gap-3 border-b border-neutral-200 px-5 py-4 dark:border-neutral-700">
          <span className="mt-0.5 shrink-0 rounded bg-blue-100 px-1.5 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900 dark:text-blue-300">
            [{displayIndex}]
          </span>
          <div className="min-w-0 flex-1">
            <div className="break-words text-sm font-semibold text-neutral-900 dark:text-neutral-100">
              {title}
            </div>
            {section && (
              <div className="mt-0.5 break-words text-xs text-neutral-500 dark:text-neutral-400">
                {section}
              </div>
            )}
            <EvidenceMarks cite={cite} tone="modal" />
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {cite.text ? (
            <ChunkBody text={cite.text} />
          ) : (
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              这条引用是从回答末尾的参考来源列表里还原的，没有对应的 chunk 原文
              （历史会话，或者本轮检索不是 med-tools 发起的）。
            </p>
          )}
        </div>

        {(cite.query || cite.chunkId || cite.score !== undefined) && (
          <div className="space-y-1 border-t border-neutral-200 px-5 py-3 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500">
            {cite.query && <div className="break-words">检索式：{cite.query}</div>}
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {cite.chunkId && <span className="break-all font-mono">chunk：{cite.chunkId}</span>}
              {cite.score !== undefined && <span className="tabular-nums">score：{cite.score.toFixed(4)}</span>}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/**
 * 为 remark 插件拦截的 <cite> 节点提供渲染组件。
 * hover 出摘要卡片，点击弹出 chunk 全文。
 */
export function CitationPopover({
  'data-citation-index': index,
  'data-citation-display': display,
  citations,
  children,
  ...rest
}: {
  'data-citation-index'?: string;
  'data-citation-display'?: string;
  citations?: CitationMetadata[];
  children?: ReactNode;
  [key: string]: unknown;
}) {
  const citeIndex = parseInt(index ?? '', 10);
  const cite = citations?.find((c) => c.index === citeIndex);
  const [isOpen, setIsOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);

  // remark 插件只对能匹配上引用的 [N] 产出 <cite>，所以正常路径不会走到这里。
  // 兜底的是模型自己在正文里写了字面 <cite> 标签、被 rehypeRaw 放行的情况：
  // 那就当普通文字渲染，不要摆一个点不动的灰角标冒充引用。
  if (!cite) {
    return <>{children ?? (index ? `[${index}]` : null)}</>;
  }

  // 角标上印压缩后的编号（后端编号全局递增，直接印出来会是带洞的 [2][4][6]…）。
  // 缺这个属性时退回原始编号，至少不会印出个空号。
  const parsedDisplay = parseInt(display ?? '', 10);
  const displayIndex = Number.isFinite(parsedDisplay) && parsedDisplay > 0
    ? parsedDisplay
    : cite.index;

  const { title, section } = resolveHeadline(cite);
  const excerpt = toExcerpt(cite.text);

  const tooltipContent: ReactNode = (
    <div className="max-w-xs whitespace-normal text-left leading-relaxed">
      <div className="break-words text-sm font-semibold">{title}</div>
      {section && <div className="mt-0.5 break-words text-xs opacity-80">{section}</div>}
      <EvidenceMarks cite={cite} tone="tooltip" />
      {excerpt && <div className="mt-1.5 break-words text-xs opacity-90">{excerpt}</div>}
      <div className="mt-1.5 text-xs opacity-60">点击查看全文</div>
    </div>
  );

  return (
    <>
      {/* 弹窗开着时把 tooltip 的 content 撤掉，否则卡片会浮在遮罩上面。 */}
      <Tooltip content={isOpen ? undefined : tooltipContent} position="top" delay={200}>
        <sup className="inline-flex items-center">
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`查看引用 ${displayIndex} 的原文`}
            className={badgeClassName}
            onClick={() => setIsOpen(true)}
          >
            [{displayIndex}]
          </button>
        </sup>
      </Tooltip>
      {isOpen && <CitationChunkModal cite={cite} displayIndex={displayIndex} onClose={close} />}
    </>
  );
}
