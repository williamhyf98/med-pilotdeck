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
 *
 * 解析失败时把剥到的原始文本一并带出来：截断的 JSON 还能打捞（见 salvageChunks）。
 */
type ParsedToolResult = { payload: RawChunk | null; rawText: string };

function parseToolPayload(content: unknown): ParsedToolResult {
  let value: unknown = content;
  let rawText = '';

  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof value === 'string') {
      rawText = value;
      const trimmed = value.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { payload: null, rawText };
      try {
        value = JSON.parse(trimmed);
      } catch {
        return { payload: null, rawText };
      }
      continue;
    }
    if (Array.isArray(value)) {
      // content block 数组：取第一个带 text 的块继续解。
      const block = value.find(
        (item) => item && typeof item === 'object' && 'text' in (item as object),
      ) as { text?: unknown } | undefined;
      if (!block) return { payload: null, rawText };
      value = block.text;
      continue;
    }
    if (value && typeof value === 'object') {
      return { payload: value as RawChunk, rawText };
    }
    return { payload: null, rawText };
  }
  return { payload: null, rawText };
}

/**
 * 从截断的 JSON 里打捞 chunk 对象。
 *
 * 网关和 UI 服务端各自把工具结果掐到 20000 字符（`InProcessGateway.ts:118` 的
 * `limitGatewayToolResultPreview`、`pilotdeck-bridge.js:149` 的
 * `limitToolResultPreview`），掐法是「留头留尾、中间塞一行标记」。`top_k` 调大时
 * 检索结果会超，`JSON.parse` 整个失败，这次检索的引用就全没了。
 *
 * 这里退一步：从 `"chunks": [` 往后按花括号配对逐个切对象、逐个解析，解不动的丢掉。
 * 截断发生在中间，所以头部那几条 chunk 是完整的，能救回来。
 */
function salvageChunks(text: string): RawChunk[] {
  const anchor = text.indexOf('"chunks"');
  if (anchor < 0) return [];
  const start = text.indexOf('[', anchor);
  if (start < 0) return [];

  const chunks: RawChunk[] = [];
  let depth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;

  for (let i = start + 1; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) objectStart = i;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try {
          const parsed = JSON.parse(text.slice(objectStart, i + 1));
          if (parsed && typeof parsed === 'object') chunks.push(parsed as RawChunk);
        } catch {
          // 半截对象，丢掉继续往后找。
        }
        objectStart = -1;
      }
      continue;
    }
    // 顶层的 `]` 说明 chunks 数组正常收尾了。
    if (char === ']' && depth === 0) break;
  }
  return chunks;
}

/** 打捞路径下捞一下检索式，没有就算了 —— 弹窗里少一行，不影响看原文。 */
function salvageQuery(text: string): string {
  const matched = /"query"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!matched) return '';
  try {
    return JSON.parse(`"${matched[1]}"`) as string;
  } catch {
    return '';
  }
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

function toCitations(chunks: unknown[], query: string): CitationMetadata[] {
  const citations: CitationMetadata[] = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    const citation = chunkToCitation(chunk as RawChunk, query);
    if (citation) citations.push(citation);
  }
  return citations;
}

/** 单个工具结果里的 chunks → 引用元数据；不是检索结果就返回空数组。 */
export function extractCitationsFromToolResult(
  toolName: string | undefined,
  toolResultContent: unknown,
): CitationMetadata[] {
  const namedRag = RAG_TOOL_NAME_RE.test(String(toolName ?? ''));
  const { payload, rawText } = parseToolPayload(toolResultContent);

  if (payload) {
    const chunks = payload.chunks;
    if (!Array.isArray(chunks) || chunks.length === 0) return [];
    // 名字对不上时看 payload 形状：`chunks` + `generation_owner` 是 med-tools 的
    // 检索响应特征，够用来避免把别的工具结果误当引用。
    if (!namedRag
      && !RAG_TOOL_NAME_RE.test(asString(payload.tool))
      && !asString(payload.generation_owner)) return [];
    return toCitations(chunks, asString(payload.query).trim());
  }

  // 解析失败最常见的原因是被掐到 20000 字符。打捞这条路没有完整 payload 可做形状
  // 校验，所以只认工具名 —— 宁可漏，也不要把别的工具的 JSON 当成引用。
  if (!namedRag || !rawText) return [];
  const salvaged = salvageChunks(rawText);
  if (salvaged.length === 0) return [];
  return toCitations(salvaged, salvageQuery(rawText));
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

const CODE_FENCE_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const CITATION_REF_RE = /\[(\d{1,3})\]/g;

/**
 * 原始编号 → 展示编号（1..N）。
 *
 * 后端编号在进程内全局递增，一轮检索回 24 条、模型只引用其中 16 条，末尾的参考
 * 来源就长成 `[2][4][6][7]…` 这种带洞的样子。编号全局唯一是防「两次检索都出 [1]」
 * 的前提，不能退回去，所以压缩放在展示层：正文里真正出现过的编号，压成自然序列。
 *
 * 压缩按**原始编号升序**，不是按正文首次出现顺序。模型写参考来源列表时是按编号
 * 升序排的，升序压缩才能保证那个列表是 1,2,3…；按首次出现排的话，正文里一旦先引
 * 了大号，列表顺序就乱了。查 chunk 仍然用原始编号，展示编号只进 UI。
 */
export function buildCitationDisplayMap(
  content: string,
  citations: CitationMetadata[],
): Map<number, number> {
  const known = new Set(citations.map((citation) => citation.index));
  // 代码块里的 [N] 不会被 remark 插件换成角标，预扫描也得跳过，
  // 否则它白占一个展示号，洞就又回来了。
  const scannable = content.replace(CODE_FENCE_RE, ' ').replace(INLINE_CODE_RE, ' ');

  const used = new Set<number>();
  CITATION_REF_RE.lastIndex = 0;
  let matched: RegExpExecArray | null;
  while ((matched = CITATION_REF_RE.exec(scannable)) !== null) {
    const index = parseInt(matched[1], 10);
    if (known.has(index)) used.add(index);
  }

  const display = new Map<number, number>();
  [...used]
    .sort((left, right) => left - right)
    .forEach((index, position) => display.set(index, position + 1));
  return display;
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
