import React, { useCallback, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { normalizeDetailsBlocks, normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { resolveMarkdownFileHref } from '../../utils/resolveMarkdownFileHref';
import {
  createRemarkArtifactFileTextPlugin,
  type MarkdownArtifactFile,
} from '../../utils/remarkArtifactFileText';
import { createRemarkCitationPlugin } from '../../utils/remarkCitationPlugin';
import { remarkGroupImageParagraphs } from '../../utils/remarkGroupImages';
import { collectMarkdownImages } from '../../utils/markdownImages';
import { CitationPopover } from '../../utils/CitationPopover';
import { buildCitationDisplayMap, splitCitationLabel } from '../../utils/ragCitations';
import type { CitationMetadata } from '../../types/types';
import ImageLightbox, { type LightboxImage } from './ImageLightbox';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  projectName?: string;
  isStreaming?: boolean;
  onFileOpen?: (filePath: string) => void;
  artifactFiles?: MarkdownArtifactFile[];
  citations?: CitationMetadata[];
};

const fullRehypePlugins = [rehypeKatex, rehypeRaw];

const linkClassName = 'text-blue-600 hover:underline dark:text-blue-400';

// Retrieved figures arrive at full resolution, so they are shown as
// proportionally scaled thumbnails and opened in the lightbox on click.
const imageThumbnailClassName = 'block h-auto max-h-[180px] w-auto max-w-[min(240px,100%)] object-contain';
const imageButtonClassName = 'not-prose m-0 inline-block cursor-zoom-in overflow-hidden rounded-md border border-neutral-200 bg-neutral-50 p-0 align-top focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:border-neutral-700 dark:bg-neutral-800';
const imageRowClassName = 'not-prose my-3 flex flex-wrap items-start gap-2';

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
};

const isBlankHastText = (node: HastNode): boolean => (
  node.type === 'text' && !(node.value ?? '').trim()
);

const isHastImage = (node: HastNode): boolean => {
  if (node.tagName === 'img') return true;
  if (node.tagName !== 'a' || !Array.isArray(node.children)) return false;
  const meaningful = node.children.filter((child) => !isBlankHastText(child));
  return meaningful.length > 0 && meaningful.every((child) => child.tagName === 'img');
};

/** True when a paragraph holds nothing but images, so it can become an image row. */
const isImageOnlyParagraph = (node: unknown): boolean => {
  const children = (node as HastNode | undefined)?.children;
  if (!Array.isArray(children)) return false;
  const meaningful = children.filter((child) => !isBlankHastText(child));
  return meaningful.length > 0 && meaningful.every(isHastImage);
};

/**
 * 兜底路径：从 <details> 块里刮 `- [N] 文献名 > 章节` 这样的行。
 *
 * 只有在结构化 citations 缺席时才会走到这里（旧会话、或者不是 med-tools 检索），
 * 刮出来的引用没有 chunk 原文，点开也只能看到文献名。
 *
 * section 必须可选：远程语料的 `section_title` 经常为空，而原来的正则强制要求
 * `>` 分隔符，于是没有章节的那一条整行匹配不上、根本进不了引用表 —— 表现就是
 * 「大部分角标有 hover，偶尔一个没有」。
 */
const CITATION_LINE_RE = /^\s*[-*]\s*\[(\d{1,3})\]\s+(.+?)\s*$/;
const DETAILS_BLOCK_RE = /<details\b[^>]*>[\s\S]*?<\/details>/gi;

function extractCitationsFromContent(text: string): CitationMetadata[] {
  const citations: CitationMetadata[] = [];
  const seen = new Set<number>();

  DETAILS_BLOCK_RE.lastIndex = 0;
  let block: RegExpExecArray | null;
  while ((block = DETAILS_BLOCK_RE.exec(text)) !== null) {
    for (const line of block[0].split('\n')) {
      const matched = line.match(CITATION_LINE_RE);
      if (!matched) continue;
      const index = parseInt(matched[1], 10);
      if (seen.has(index)) continue;
      seen.add(index);
      const label = matched[2].trim();
      citations.push({ index, ...splitCitationLabel(label), label });
    }
  }
  return citations;
}

function createMarkdownComponents(
  onImageZoom: (src: string) => void,
  onFileOpen?: (filePath: string) => void,
  citations?: CitationMetadata[],
): Components {
  return {
    p: ({ children, node, ...props }) => {
      if (isImageOnlyParagraph(node)) {
        return <div className={imageRowClassName}>{children}</div>;
      }
      return <p {...props}>{children}</p>;
    },
    img: ({ src, alt, node: _node, ...props }) => {
      const source = typeof src === 'string' ? src.trim() : '';
      if (!source) return null;
      const caption = typeof alt === 'string' ? alt.trim() : '';
      return (
        <button
          type="button"
          className={imageButtonClassName}
          title={caption || undefined}
          aria-label={caption ? `Preview ${caption}` : 'Preview image'}
          onClick={() => onImageZoom(source)}
        >
          <img
            {...props}
            src={source}
            alt={caption}
            loading="lazy"
            className={imageThumbnailClassName}
          />
        </button>
      );
    },
    a: ({ href, children, ...props }) => {
      const filePath = resolveMarkdownFileHref(href);
      if (filePath && onFileOpen) {
        return (
          <a
            href={href}
            className={`${linkClassName} cursor-pointer`}
            onClick={(event) => {
              event.preventDefault();
              onFileOpen(filePath);
            }}
            {...props}
          >
            {children}
          </a>
        );
      }

      const isExternal = Boolean(href && /^https?:\/\//i.test(href));
      return (
        <a
          href={href}
          className={linkClassName}
          {...(isExternal ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
          {...props}
        >
          {children}
        </a>
      );
    },
    // children 要透传：rehypeRaw 会放行模型自己写在正文里的字面 <cite> 标签，
    // 那种节点没有 data-citation-index，对不上任何一条引用，原文得留着。
    cite: ({ children, ...props }) => {
      const attributes = props as Record<string, unknown>;
      return (
        <CitationPopover
          data-citation-index={attributes['data-citation-index'] as string}
          data-citation-display={attributes['data-citation-display'] as string}
          citations={citations}
        >
          {children}
        </CitationPopover>
      );
    },
  };
}

export function Markdown({
  children,
  className,
  isStreaming,
  onFileOpen,
  artifactFiles,
  citations,
}: MarkdownProps) {
  const content = useMemo(
    () => normalizeDetailsBlocks(normalizeInlineCodeFences(String(children ?? ''))),
    [children],
  );

  // 优先用外部传入的 citations，否则从 content 自动提取
  const resolvedCitations = useMemo(
    () => citations && citations.length > 0 ? citations : extractCitationsFromContent(content),
    [citations, content],
  );

  // 编号压缩要拿最终正文算，所以放在 resolvedCitations 之后、插件构建之前。
  const citationDisplayMap = useMemo(
    () => buildCitationDisplayMap(content, resolvedCitations),
    [content, resolvedCitations],
  );

  const [zoomedSrc, setZoomedSrc] = useState<string | null>(null);
  const handleImageZoom = useCallback((src: string) => setZoomedSrc(src), []);

  const lightboxImages = useMemo<LightboxImage[]>(
    () => collectMarkdownImages(content).map((image) => ({
      data: image.url,
      name: image.caption || undefined,
    })),
    [content],
  );
  const zoomIndex = zoomedSrc
    ? lightboxImages.findIndex((image) => image.data === zoomedSrc)
    : -1;
  const activeLightboxImages = zoomIndex >= 0
    ? lightboxImages
    : (zoomedSrc ? [{ data: zoomedSrc }] : []);

  const components = useMemo(
    () => createMarkdownComponents(handleImageZoom, onFileOpen, resolvedCitations),
    [handleImageZoom, onFileOpen, resolvedCitations],
  );
  const remarkPlugins = useMemo(() => {
    if (isStreaming) return [remarkGfm, remarkGroupImageParagraphs];
    const base = [remarkGfm, remarkMath, remarkGroupImageParagraphs];
    if (resolvedCitations && resolvedCitations.length > 0) {
      base.push(createRemarkCitationPlugin(resolvedCitations, citationDisplayMap));
    }
    if (artifactFiles !== undefined) {
      base.push(createRemarkArtifactFileTextPlugin(artifactFiles));
    }
    return base;
  }, [artifactFiles, resolvedCitations, citationDisplayMap, isStreaming]);

  return (
    <div className={className}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={isStreaming ? undefined : fullRehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
      {activeLightboxImages.length > 0 ? (
        <ImageLightbox
          images={activeLightboxImages}
          startIndex={zoomIndex >= 0 ? zoomIndex : 0}
          onClose={() => setZoomedSrc(null)}
        />
      ) : null}
    </div>
  );
}
