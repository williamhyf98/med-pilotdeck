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

/** 打捞检索模式。`mode` 在 payload 头部（chunks 之前），截断掐的是中间，一般还在。 */
function salvageMode(text: string): string {
  const matched = /"mode"\s*:\s*"([a-z-]+)"/.exec(text);
  return matched ? matched[1] : '';
}

/** 正文里已经能读到的骨架（`书名：`/`卷：`/`章节：`/`【章节：…】`）对用户是噪声，剥掉。 */
export function stripChunkPreamble(text: string): string {
  const lines = text.split('\n');
  let start = 0;
  while (start < lines.length) {
    const line = lines[start].trim();
    if (!line || line.startsWith('卷：') || line.startsWith('章节：') || line.startsWith('书名：')) {
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

function chunkToCitation(
  chunk: RawChunk,
  fallbackQuery: string,
  retrievalMode: string,
): CitationMetadata | null {
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
    ...(asNumber(chunk.rerank_score) !== undefined ? { rerankScore: asNumber(chunk.rerank_score) } : {}),
    ...(retrievalMode ? { retrievalMode } : {}),
  };
}

function toCitations(chunks: unknown[], query: string, retrievalMode: string): CitationMetadata[] {
  const citations: CitationMetadata[] = [];
  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue;
    const citation = chunkToCitation(chunk as RawChunk, query, retrievalMode);
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
    return toCitations(chunks, asString(payload.query).trim(), asString(payload.mode).trim());
  }

  // 解析失败最常见的原因是被掐到 20000 字符。打捞这条路没有完整 payload 可做形状
  // 校验，所以只认工具名 —— 宁可漏，也不要把别的工具的 JSON 当成引用。
  if (!namedRag || !rawText) return [];
  const salvaged = salvageChunks(rawText);
  if (salvaged.length === 0) return [];
  return toCitations(salvaged, salvageQuery(rawText), salvageMode(rawText));
}

/**
 * 用户可见的统一「相关度」（0–1），没有可信值时返回 null。
 *
 * 三种原始分只有两种有相似度语义：重排分（远程，交叉编码器 sigmoid）和余弦
 * （本地向量回退），两者都是 0–1、越大越相关，可以直接当同一个指标展示。
 * 远程的 `score` 是 RRF 名次融合值（上限约 0.04），词法回退是 BM25 词频量
 * （无上界）——都不是相关度，硬换算成百分比等于造假，所以返回 null 不显示数字。
 * 0.05 这个界与两个量纲天然分离（RRF ≤0.041，余弦下限 0.35），老 payload 缺
 * `retrievalMode` 时也能凭它分开。
 */
export function relevanceOf(citation: CitationMetadata): number | null {
  if (citation.rerankScore !== undefined) {
    return Math.min(1, Math.max(0, citation.rerankScore));
  }
  if (isLexicalMatch(citation)) return null;
  const score = citation.score;
  if (score === undefined || score <= 0.05 || score > 1) return null;
  return score;
}

/** 词法（BM25）命中：分数无相似度语义，卡片上用「关键词匹配」标签代替数字。 */
export function isLexicalMatch(citation: CitationMetadata): boolean {
  return citation.retrievalMode !== undefined && citation.retrievalMode.startsWith('lexical');
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
 * 去掉章节尾部的 `·「正文首句…」` 消歧后缀。
 *
 * 后端在 display_label 撞车时追加这段摘录（`_apply_citations`），塞在抬头里只会
 * 让「书名 > 章节」读成一长串重复文本。摘录本身不丢：弹窗正文和折叠条卡片的
 * 摘录行都能看到原文。
 */
export function stripDisambiguationSuffix(value: string): string {
  const marker = value.indexOf('·「');
  if (marker < 0) return value;
  return value.slice(0, marker).trimEnd();
}

/**
 * 把 chunk 原文按「相关图示：」拆成正文和图注两块。
 *
 * 军事医学语料把图注（①②③… 连排）直接拼在段尾，弹窗里混在正文中读不出层次。
 * 标记保留在 text 里（stripChunkPreamble 不剥它），渲染层据此拆出独立小节。
 * 标记后的内容整体视为图注 —— 语料里它总在 chunk 尾部。
 */
export function splitFigureBlock(text: string): { body: string; figures: string } {
  const matched = /(?:^|\n)\s*相关图示：/.exec(text);
  if (!matched) return { body: text, figures: '' };
  const start = matched.index;
  const figures = text
    .slice(start)
    .replace(/^\s*相关图示：/, '')
    .trim();
  return { body: text.slice(0, start).trimEnd(), figures };
}

export type OrderedCitation = {
  citation: CitationMetadata;
  display: number;
  citedInline: boolean;
};

/** 与卡片摘录（CitationPopover 的 EXCERPT_LIMIT）保持一致：前 120 字相同即视觉重复。 */
const CONTENT_KEY_LIMIT = 120;

/**
 * 内容级去重键：文献名 + 章节 + 正文前 120 字（压平空白）。
 *
 * 语料库里存在同一文档重复入库的镜像 chunk（chunk_id 只差批次前缀、文本逐字节
 * 相同），还有相邻 chunk 共享同一段「相关图示」图注 —— 它们 chunk_id 不同、全文
 * 指纹不同，后端会各给一个引用号，折叠条里就是两张一模一样的卡。这里按「用户
 * 实际看到的内容」（抬头 + 摘录）判重。没有正文的旧条目返回 null，不参与判重。
 */
function contentKeyOf(citation: CitationMetadata): string | null {
  const flat = (citation.text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const title = (citation.title ?? '').trim();
  const section = (citation.section ?? '').trim();
  return `${title} ${section} ${flat.slice(0, CONTENT_KEY_LIMIT)}`;
}

/**
 * 折叠条的展示顺序：被正文引用过的来源按压缩后的展示号升序排前（与角标一致），
 * 未被引用的来源续号排后（按原始编号升序）。条目按 chunkId 去重（缺 chunkId 用
 * 原始编号兜底）；同一 chunk 被引用多号时，卡片只留最小展示号那条。
 *
 * 在此之上做内容级去重：被引用的条目永远保留（正文角标必须有对应卡片）；未被
 * 引用的条目若与某条被引用条目内容相同则丢弃，未引用条目彼此内容相同时只留
 * score 最高的一条。纯前端 O(n) 计算，条目数量级几十，无可感知延迟。
 */
export function orderCitationsForSources(
  displayMap: Map<number, number>,
  citations: CitationMetadata[],
): OrderedCitation[] {
  const sorted = [...citations].sort((left, right) => left.index - right.index);
  const keyOf = (citation: CitationMetadata) => citation.chunkId || `index:${citation.index}`;

  const seen = new Set<string>();
  const citedContentKeys = new Set<string>();
  const cited: OrderedCitation[] = [];
  // 先收被引用的，去重时才不会被靠前的未引用同 chunk 条目挤掉展示号。
  for (const citation of sorted) {
    const display = displayMap.get(citation.index);
    if (display === undefined) continue;
    const key = keyOf(citation);
    if (seen.has(key)) continue;
    seen.add(key);
    const contentKey = contentKeyOf(citation);
    if (contentKey) citedContentKeys.add(contentKey);
    cited.push({ citation, display, citedInline: true });
  }
  cited.sort((left, right) => left.display - right.display);

  // 未引用条目：按内容分组，与已引用内容重复的整组丢弃，组内留最高分。
  const uncitedBest = new Map<string, CitationMetadata>();
  const uncitedPlain: CitationMetadata[] = [];
  for (const citation of sorted) {
    const key = keyOf(citation);
    if (seen.has(key)) continue;
    seen.add(key);
    const contentKey = contentKeyOf(citation);
    if (!contentKey) {
      uncitedPlain.push(citation);
      continue;
    }
    if (citedContentKeys.has(contentKey)) continue;
    const existing = uncitedBest.get(contentKey);
    if (
      !existing ||
      (citation.score ?? Number.NEGATIVE_INFINITY) > (existing.score ?? Number.NEGATIVE_INFINITY)
    ) {
      uncitedBest.set(contentKey, citation);
    }
  }

  const ordered = [...cited];
  let next = cited.length > 0 ? cited[cited.length - 1].display : 0;
  const survivors = [...uncitedBest.values(), ...uncitedPlain].sort(
    (left, right) => left.index - right.index,
  );
  for (const citation of survivors) {
    next += 1;
    ordered.push({ citation, display: next, citedInline: false });
  }
  return ordered;
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
