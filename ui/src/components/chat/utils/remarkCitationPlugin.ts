import type { CitationMetadata } from '../types/types';

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
  data?: Record<string, unknown>;
};

/** 匹配正文中的 [N] 引用标记（N 为 1-2 位数字） */
const INLINE_CITATION_RE = /\[(\d{1,2})\]/g;

/**
 * Remark 插件：在 markdown AST 的 text 节点中查找 [N] 引用标记，
 * 替换为自定义的 cite 节点（配合 react-markdown 的 components 渲染成 CitationPopover）。
 */
export function createRemarkCitationPlugin(citations: CitationMetadata[]) {
  const citationMap = new Map(citations.map((c) => [c.index, c]));

  return function remarkCitation() {
    return (tree: MarkdownAstNode) => {
      transformCitationNodes(tree, citationMap);
    };
  };
}

function transformCitationNodes(
  node: MarkdownAstNode,
  citationMap: Map<number, CitationMetadata>,
) {
  if (!node.children) return;

  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i];

    if (child.type === 'text' && child.value) {
      const parts = splitByCitation(child.value);
      if (parts.length > 1) {
        // 替换当前 text 节点为多个 text/cite 节点
        const replacements: MarkdownAstNode[] = parts.map((part) => {
          if (part.type === 'cite') {
            return {
              type: 'element',
              data: {
                hName: 'cite',
                hProperties: {
                  'data-citation-index': String(part.index),
                  className: 'inline-citation',
                },
              },
              children: [{ type: 'text', value: `[${part.index}]` }],
            };
          }
          return { type: 'text', value: part.text };
        });
        node.children.splice(i, 1, ...replacements);
        i += replacements.length - 1;
      }
      continue;
    }

    // 不处理 code / inlineCode 节点
    if (child.type === 'code' || child.type === 'inlineCode') continue;

    transformCitationNodes(child, citationMap);
  }
}

type CitationPart =
  | { type: 'text'; text: string }
  | { type: 'cite'; index: number };

function splitByCitation(text: string): CitationPart[] {
  const parts: CitationPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INLINE_CITATION_RE.lastIndex = 0;
  while ((match = INLINE_CITATION_RE.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    if (before) parts.push({ type: 'text', text: before });
    parts.push({ type: 'cite', index: parseInt(match[1], 10) });
    lastIndex = INLINE_CITATION_RE.lastIndex;
  }

  const remaining = text.slice(lastIndex);
  if (remaining) parts.push({ type: 'text', text: remaining });

  return parts;
}