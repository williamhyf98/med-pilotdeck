import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { authenticatedFetch } from '../../../../utils/api';
import { normalizeInlineCodeFences } from '../../utils/chatFormatting';
import { resolveMarkdownFileHref } from '../../utils/resolveMarkdownFileHref';
import {
  createRemarkArtifactFileTextPlugin,
  type MarkdownArtifactFile,
} from '../../utils/remarkArtifactFileText';

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  projectName?: string;
  isStreaming?: boolean;
  onFileOpen?: (filePath: string) => void;
  artifactFiles?: MarkdownArtifactFile[];
};

const fullRehypePlugins = [rehypeKatex];

const linkClassName = 'text-blue-600 hover:underline dark:text-blue-400';
const ragAssetPrefix = '/api/plugins/med-tools/rag-assets/';
const ragAssetFilePrefix = `${ragAssetPrefix}assets/`;

function isRagAssetUrl(src?: string): src is string {
  return typeof src === 'string' && src.trim().startsWith(ragAssetFilePrefix);
}

function isAllowedMarkdownImageUrl(src?: string): src is string {
  if (typeof src !== 'string') return false;
  const trimmed = src.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith(ragAssetPrefix) && !trimmed.startsWith(ragAssetFilePrefix)) {
    return false;
  }
  return (
    isRagAssetUrl(trimmed)
    || /^https?:\/\//i.test(trimmed)
    || /^data:image\//i.test(trimmed)
    || /^blob:/i.test(trimmed)
    || trimmed.startsWith('/')
  );
}

function AuthenticatedRagImage({
  src,
  alt,
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!isRagAssetUrl(src)) return undefined;

    let cancelled = false;
    let createdObjectUrl: string | null = null;
    setObjectUrl(null);
    setFailed(false);

    authenticatedFetch(src, { suppressServerErrorToast: true })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to load RAG image: ${response.status}`);
        }
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        createdObjectUrl = URL.createObjectURL(blob);
        setObjectUrl(createdObjectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (createdObjectUrl) URL.revokeObjectURL(createdObjectUrl);
    };
  }, [src]);

  if (!isAllowedMarkdownImageUrl(src)) {
    return (
      <span className="my-2 block text-xs text-amber-700 dark:text-amber-300">
        图片未展示：{alt || '缺少有效图片地址'}
      </span>
    );
  }

  if (!isRagAssetUrl(src)) {
    return <img src={src} alt={alt || ''} {...props} />;
  }

  if (failed) {
    return (
      <span className="my-2 block text-xs text-red-600 dark:text-red-400">
        图片加载失败：{alt || 'RAG image'}
      </span>
    );
  }

  if (!objectUrl) {
    return (
      <span className="my-2 block text-xs text-neutral-500 dark:text-neutral-400">
        图片加载中：{alt || 'RAG image'}
      </span>
    );
  }

  return <img src={objectUrl} alt={alt || ''} {...props} />;
}

function createMarkdownComponents(onFileOpen?: (filePath: string) => void): Components {
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
    img: ({ src, alt, ...props }) => (
      <AuthenticatedRagImage src={src} alt={alt} {...props} />
    ),
  };
}

export function Markdown({
  children,
  className,
  isStreaming,
  onFileOpen,
  artifactFiles,
}: MarkdownProps) {
  const content = useMemo(
    () => normalizeInlineCodeFences(String(children ?? '')),
    [children],
  );

  const components = useMemo(
    () => createMarkdownComponents(onFileOpen),
    [onFileOpen],
  );
  const remarkPlugins = useMemo(() => {
    if (isStreaming) return [remarkGfm];
    if (artifactFiles === undefined) return [remarkGfm, remarkMath];
    return [remarkGfm, remarkMath, createRemarkArtifactFileTextPlugin(artifactFiles)];
  }, [artifactFiles, isStreaming]);

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
