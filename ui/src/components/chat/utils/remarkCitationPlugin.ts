import type { CitationMetadata } from '../types/types';

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
  data?: Record<string, unknown>;
};

/**
 * 匹配正文中的 [N] 引用标记。
 *
 * 上限跟着 med-tools 的 `_CITATION_MAX`（999）走。原来只认 1-2 位数字，编号一旦
 * 上三位，那个角标就完全不会被替换成 <cite>，在页面上表现为一段裸文本。
 */
const INLINE_CITATION_RE = /\[(\d{1,3})\]/g;

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
      const parts = splitByCitation(child.value, citationMap);
      // 判据是「切出了 cite」，不是「切出了多段」。文本节点恰好只有一个角标时
      // （`**要点**[1]`、`` `SBP<90` [1] ``、`[文献](url)[1]` —— 角标紧跟在加粗/
      // 行内代码/链接后面，就会单独成节点）parts.length === 1，按旧判据整节点不
      // 替换，那个角标就没有 hover。这是「偶尔一个渲染失败」的另一半原因。
      if (parts.some((part) => part.type === 'cite')) {
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

function splitByCitation(
  text: string,
  citationMap: Map<number, CitationMetadata>,
): CitationPart[] {
  const parts: CitationPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INLINE_CITATION_RE.lastIndex = 0;
  while ((match = INLINE_CITATION_RE.exec(text)) !== null) {
    const index = parseInt(match[1], 10);
    // 对不上任何一条引用的 [N] 留成普通文本。以前一律换成 <cite>，没匹配上的
    // 就渲染成一个灰色、点不动的死角标 —— 看起来正是「这个编号渲染失败了」。
    // 正文里本来就有的方括号数字（脚注、量表评分）也会被误吃掉。
    if (!citationMap.has(index)) continue;
    const before = text.slice(lastIndex, match.index);
    if (before) parts.push({ type: 'text', text: before });
    parts.push({ type: 'cite', index });
    lastIndex = INLINE_CITATION_RE.lastIndex;
  }

  const remaining = text.slice(lastIndex);
  if (remaining) parts.push({ type: 'text', text: remaining });

  return parts;
}