/**
 * 把 RAG 工具返回的 chunks 还原成结构化引用元数据。
 *
 * 在这之前 `message.citations` 从来没有被赋过值（只在 types.ts 里声明、在
 * MessageComponent 里读），所以 `Markdown.tsx` 永远走正则去刮模型自己写的
 * `<details>` 散文。那条路拿不到 chunk 原文、拿不到 chunk_id，也就无法判断
 * 模型是不是引错了文献。这里把结构化的那一路接上，正则退化成兜底。
 */

import type { CitationMetadata } from '../types/types';

/** 工具名里带这些片段就认为是检索类工具（MCP 名字带 `mcp__med-tools__` 前缀）。 */
const RAG_TOOL_NAME_RE = /rag_query|rag_search|stage_plan/i;

/** chunk 原文截断上限。远程服务默认每条 1800 字符，这里给足余量。 */
const MAX_CHUNK_TEXT = 4000;

type RawChunk = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * MCP 的工具结果可能是 payload 本身的 JSON、也可能被包成 content block 数组
 * （`[{ type: 'text', text: '{...}' }]`）。两种都要吃得下，解析失败就放弃，
 * 绝不能因为一条脏结果把整轮渲染搞崩。
 */
function parseToolPayload(content: unknown): RawChunk | null {
  let value: unknown = content;

  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
      try {
        value = JSON.parse(trimmed);
      } catch {
        return null;
      }
      continue;
    }
    if (Array.isArray(value)) {
      // content block 数组：取第一个带 text 的块继续解。
      const block = value.find(
        (item) => item && typeof item === 'object' && 'text' in (item as object),
      ) as { text?: unknown } | undefined;
      if (!block) return null;
      value = block.text;
      continue;
    }
    if (value && typeof value === 'object') {
      return value as RawChunk;
    }
    return null;
  }
  return null;
}

/** 正文里已经能读到的骨架（`卷：`/`章节：`/`【章节：…】`）对用户是噪声，剥掉。 */
export function stripChunkPreamble(text: string): string {
  const lines = text.split('\n');
  let start = 0;
  while (start < lines.length) {
    const line = lines[start].trim();
    if (!line || line.startsWith('卷：') || line.startsWith('章节：')) {
      start += 1;
      continue;
    }
    break;
  }
  let body = lines.slice(start).join('\n').trim();
  while (body.startsWith('【')) {
    const end = body.indexOf('】');
    if (end < 0) break;
    body = body.slice(end + 1).trimStart();
  }
  return body || text.trim();
}

/** 截断要留个记号，否则弹窗里那句半截话会被当成语料本身就是这样。 */
function clampChunkText(text: string): string {
  const body = stripChunkPreamble(text);
  if (body.length <= MAX_CHUNK_TEXT) return body;
  return `${body.slice(0, MAX_CHUNK_TEXT)}…（原文已截断）`;
}

function chunkToCitation(chunk: RawChunk, fallbackQuery: string): CitationMetadata | null {
  // 编号由 query.py 的 `_apply_citations` 下发，轮内唯一。老版本的 payload 没有
  // 这个字段，退回 rank —— 那种情况下多次检索仍可能撞号，但至少能显示。
  const index = asNumber(chunk.citation_index) ?? asNumber(chunk.rank);
  if (index === undefined || index <= 0) return null;

  const rawText = asString(chunk.text) || asString(chunk.preview);
  const title = asString(chunk.title).trim();
  const section = asString(chunk.section).trim();

  return {
    index: Math.trunc(index),
    title,
    section,
    ...(asString(chunk.display_label).trim() ? { label: asString(chunk.display_label).trim() } : {}),
    ...(asString(chunk.chunk_id).trim() ? { chunkId: asString(chunk.chunk_id).trim() } : {}),
    ...(rawText ? { text: clampChunkText(rawText) } : {}),
    ...(asString(chunk.evidence_grade).trim() ? { evidenceGrade: asString(chunk.evidence_grade).trim() } : {}),
    ...(asString(chunk.evidence_quality).trim() ? { evidenceQuality: asString(chunk.evidence_quality).trim() } : {}),
    ...(fallbackQuery ? { query: fallbackQuery } : {}),
    ...(asNumber(chunk.score) !== undefined ? { score: asNumber(chunk.score) } : {}),
  };
}

/** 单个工具结果里的 chunks → 引用元数据；不是检索结果就返回空数组。 */
export function extractCitationsFromToolResult(
  toolName: string | undefined,
  toolResultContent: unknown,
): CitationMetadata[] {
  const payload = parseToolPayload(toolResultContent);
  if (!payload) return [];

  const chunks = payload.chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) return [];

  // 名字对不上时看 payload 形状：`chunks` + `generation_owner` 是 med-tools 的
  // 检索响应特征，够用来避免把别的工具结果误当引用。
  const namedRag = RAG_TOOL_NAME_RE.test(String(toolName ?? ''))
    || RAG_TOOL_NAME_RE.test(asString(payload.tool));
  if (!namedRag && !asString(payload.generation_owner)) return [];

  const query = asString(payload.query).trim();
  const citations: CitationMetadata[] = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    const citation = chunkToCitation(chunk as RawChunk, query);
    if (citation) citations.push(citation);
  }
  return citations;
}

/**
 * 标签按第一个 `>` 拆成文献名 + 章节；没有 `>` 就整条当文献名。
 *
 * 后端 `_base_label` 就是按 `文献 > 章节` 拼的，区分用的 `·「正文首句…」` 后缀挂在
 * 尾部，所以跟着章节走 —— 这正是我们要的：两条同文献同章节的引用，靠章节行后面
 * 那句原文区分开。
 */
export function splitCitationLabel(label: string): { title: string; section: string } {
  const separator = label.indexOf('>');
  if (separator < 0) return { title: label.trim(), section: '' };
  return {
    title: label.slice(0, separator).trim(),
    section: label.slice(separator + 1).trim(),
  };
}

/**
 * 去掉标签末尾的「（A级/高质量）」。
 *
 * `_apply_citations` 把证据等级拼进了 display_label，但卡片里这两项另有徽标，
 * 不去掉就要读两遍。拼法固定是 `（{'/'.join(marks)}）`，对不上就原样返回。
 */
export function stripGradeSuffix(label: string, marks: string[]): string {
  const present = marks.filter((mark) => mark);
  if (present.length === 0) return label;
  const suffix = `（${present.join('/')}）`;
  return label.endsWith(suffix) ? label.slice(0, -suffix.length).trimEnd() : label;
}

/**
 * 合并一轮里多次检索的引用。
 *
 * 编号是后端全局分配的，同号即同 chunk，所以按 index 去重即可；先到的那条
 * 胜出，与后端「同一编号永远沿用首次标签」的行为保持一致。
 */
export function mergeCitations(groups: CitationMetadata[][]): CitationMetadata[] {
  const byIndex = new Map<number, CitationMetadata>();
  for (const group of groups) {
    for (const citation of group) {
      const existing = byIndex.get(citation.index);
      if (!existing) {
        byIndex.set(citation.index, citation);
        continue;
      }
      // 同号但先到的那条缺原文（例如老 payload 只有 preview），补上更完整的。
      if (!existing.text && citation.text) {
        byIndex.set(citation.index, { ...existing, text: citation.text });
      }
    }
  }
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

/** 会话足够长时旧轮次的缓存留着没用，给个上限按插入顺序淘汰。 */
const MERGE_CACHE_LIMIT = 200;
const mergeCache = new Map<string, { signature: string; value: CitationMetadata[] }>();

/**
 * `mergeCitations` 的稳定引用版本。
 *
 * 引用数组每次重算都会产生新引用，而 `Markdown.tsx` 用它作 `useMemo` 依赖来决定
 * 要不要重建 remark 插件 —— 引用一变就整条 markdown 重新解析。内容没变时必须还
 * 给同一个数组。
 */
export function mergeCitationsStable(
  turnKey: string,
  groups: CitationMetadata[][],
): CitationMetadata[] {
  const merged = mergeCitations(groups);
  const signature = merged
    .map((c) => `${c.index}:${c.chunkId ?? ''}:${c.label ?? ''}:${c.text?.length ?? 0}`)
    .join('|');

  const cached = mergeCache.get(turnKey);
  if (cached && cached.signature === signature) return cached.value;

  mergeCache.set(turnKey, { signature, value: merged });
  while (mergeCache.size > MERGE_CACHE_LIMIT) {
    const oldest = mergeCache.keys().next();
    if (oldest.done) break;
    mergeCache.delete(oldest.value);
  }
  return merged;
}
