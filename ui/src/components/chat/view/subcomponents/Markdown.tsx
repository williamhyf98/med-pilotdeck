import React, { useMemo, useRef } from 'react';
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
import { CitationPopover } from '../../utils/CitationPopover';
import type { CitationMetadata } from '../../types/types';

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
  onFileOpen?: (filePath: string) => void,
  citations?: CitationMetadata[],
): Components {
  return {
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
    cite: (props: Record<string, unknown>) => (
      <CitationPopover
        data-citation-index={props['data-citation-index'] as string}
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

  const components = useMemo(
    () => createMarkdownComponents(onFileOpen, resolvedCitations),
    [onFileOpen, resolvedCitations],
  );
  const remarkPlugins = useMemo(() => {
    if (isStreaming) return [remarkGfm];
    const base = [remarkGfm, remarkMath];
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
    </div>
  );
}
