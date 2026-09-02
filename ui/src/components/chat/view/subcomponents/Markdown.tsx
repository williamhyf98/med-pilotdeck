import React, { useMemo, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
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

const fullRehypePlugins = [rehypeKatex];

const linkClassName = 'text-blue-600 hover:underline dark:text-blue-400';

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

  const components = useMemo(
    () => createMarkdownComponents(onFileOpen, citations),
    [onFileOpen, citations],
  );
  const remarkPlugins = useMemo(() => {
    if (isStreaming) return [remarkGfm];
    const base = [remarkGfm, remarkMath];
    if (citations && citations.length > 0) {
      base.push(createRemarkCitationPlugin(citations));
    }
    if (artifactFiles !== undefined) {
      base.push(createRemarkArtifactFileTextPlugin(artifactFiles));
    }
    return base;
  }, [artifactFiles, citations, isStreaming]);

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
