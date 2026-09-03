import React, { useCallback, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import { normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { resolveMarkdownFileHref } from '../../utils/resolveMarkdownFileHref';
import {
  createRemarkArtifactFileTextPlugin,
  type MarkdownArtifactFile,
} from '../../utils/remarkArtifactFileText';
import { createRemarkCitationPlugin } from '../../utils/remarkCitationPlugin';
import { remarkGroupImageParagraphs } from '../../utils/remarkGroupImages';
import { collectMarkdownImages } from '../../utils/markdownImages';
import { CitationPopover } from '../../utils/CitationPopover';
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

/** 从回答文本中提取 <details> 内的引用信息：- [N] title > section */
const CITATION_LINE_RE = /^\s*-\s*\[(\d+)\]\s+(.+?)\s*>\s*(.+?)\s*$/;

function extractCitationsFromContent(text: string): CitationMetadata[] {
  // 找到 <details> ... </details> 块
  const detailsMatch = text.match(/<details>[\s\S]*?<\/details>/i);
  if (!detailsMatch) return [];
  const detailsBlock = detailsMatch[0];

  const citations: CitationMetadata[] = [];
  const lines = detailsBlock.split('\n');
  for (const line of lines) {
    const m = line.match(CITATION_LINE_RE);
    if (m) {
      citations.push({
        index: parseInt(m[1], 10),
        title: m[2].trim(),
        section: m[3].trim(),
      });
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
    cite: (props) => (
      <CitationPopover
        data-citation-index={(props as Record<string, unknown>)['data-citation-index'] as string}
        citations={citations}
      />
    ),
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
    () => normalizeInlineCodeFences(String(children ?? '')),
    [children],
  );

  // 优先用外部传入的 citations，否则从 content 自动提取
  const resolvedCitations = useMemo(
    () => citations && citations.length > 0 ? citations : extractCitationsFromContent(content),
    [citations, content],
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
      base.push(createRemarkCitationPlugin(resolvedCitations));
    }
    if (artifactFiles !== undefined) {
      base.push(createRemarkArtifactFileTextPlugin(artifactFiles));
    }
    return base;
  }, [artifactFiles, resolvedCitations, isStreaming]);

  // Only apply streaming-fade-in on the initial mount while streaming.
  // Once streaming ends, never re-apply it — prevents old content from
  // briefly re-animating when sibling messages cause a re-render.
  const wasStreamingRef = useRef(!!isStreaming);
  if (!isStreaming) wasStreamingRef.current = false;
  const showFadeIn = isStreaming && wasStreamingRef.current;

  return (
    <div className={`${className || ''} ${showFadeIn ? 'streaming-fade-in' : ''}`.trim()}>
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
