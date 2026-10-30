export function decodeHtmlEntities(text: string) {
  if (!text) return text;
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function normalizeInlineCodeFences(text: string) {
  if (!text || typeof text !== 'string') return text;
  try {
    return text.replace(/```\s*([^\n\r]+?)\s*```/g, '`$1`');
  } catch {
    return text;
  }
}

/**
 * 参考来源列表包在 <details> 里，而 CommonMark 规定原始 HTML 块一直延伸到下一个
 * 空行。模型偶尔漏写 </summary> 之后的空行，整个列表就被吞进 HTML 块：渲染成
 * 无格式的裸文本，行内 [N] 也不再经过 remark 引用插件——编号压缩和 hover 全部
 * 失效。这里确定性地补上空行（</summary> 之后、</details> 之前），不赌模型每次
 * 都写对。围栏代码里的内容不动。
 */
export function normalizeDetailsBlocks(text: string): string {
  if (!text || typeof text !== 'string') return text;
  if (!/<\/(summary|details)>/i.test(text)) return text;

  const lines = text.split('\n');
  const out: string[] = [];
  let fenceMarker: '`' | '~' | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fence = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1][0] as '`' | '~';
      if (!fenceMarker) fenceMarker = marker;
      else if (marker === fenceMarker) fenceMarker = null;
    }
    const inFence = fenceMarker !== null;
    if (!inFence
      && /^\s*<\/details>\s*$/i.test(line)
      && out.length > 0
      && out[out.length - 1].trim() !== '') {
      out.push('');
    }
    out.push(line);
    if (!inFence && /<\/summary>\s*$/i.test(line)) {
      const next = lines[i + 1];
      if (next !== undefined && next.trim() !== '') out.push('');
    }
  }
  return out.join('\n');
}

/** 只剥「来源清单」性质的 details，模型自写的其他折叠块一律不动。 */
const REFERENCE_SUMMARY_RE = /参考来源|参考文献|引用来源|references?/i;
const REFERENCE_DETAILS_RE =
  /<details\b[^>]*>\s*<summary\b[^>]*>([\s\S]*?)<\/summary>[\s\S]*?(?:<\/details>|$)/gi;

/**
 * 隐藏回答末尾的「参考来源」<details> 列表。来源改由界面自绘折叠条展示
 * （CitationSourcesBar），这份模型手写的列表不再渲染 —— 但老会话的引用数据只存在
 * 于这个列表里，兜底抓取（extractCitationsFromContent）必须在剥离**之前**跑。
 * 流式期间块尚未闭合时删到文末，避免打字过程中列表闪现又消失。
 */
export function stripReferenceDetails(text: string): string {
  if (!text || typeof text !== 'string' || !/<details/i.test(text)) return text;
  const stripped = text.replace(REFERENCE_DETAILS_RE, (block, summary: string) =>
    (REFERENCE_SUMMARY_RE.test(summary) ? '' : block));
  if (stripped === text) return text;
  return stripped.replace(/\n{3,}/g, '\n\n').trimEnd();
}

export function unescapeWithMathProtection(text: string) {
  if (!text || typeof text !== 'string') return text;

  const mathBlocks: string[] = [];
  const placeholderPrefix = '__MATH_BLOCK_';
  const placeholderSuffix = '__';

  let processedText = text.replace(/\$\$([\s\S]*?)\$\$|\$([^\$\n]+?)\$/g, (match) => {
    const index = mathBlocks.length;
    mathBlocks.push(match);
    return `${placeholderPrefix}${index}${placeholderSuffix}`;
  });

  processedText = processedText.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');

  processedText = processedText.replace(
    new RegExp(`${placeholderPrefix}(\\d+)${placeholderSuffix}`, 'g'),
    (match, index) => {
      return mathBlocks[parseInt(index, 10)];
    },
  );

  return processedText;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function formatUsageLimitText(text: string) {
  try {
    if (typeof text !== 'string') return text;
    return text.replace(/PilotDeck usage limit reached\|(\d{10,13})/g, (match, ts) => {
      let timestampMs = parseInt(ts, 10);
      if (!Number.isFinite(timestampMs)) return match;
      if (timestampMs < 1e12) timestampMs *= 1000;
      const reset = new Date(timestampMs);

      const timeStr = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(reset);

      const offsetMinutesLocal = -reset.getTimezoneOffset();
      const sign = offsetMinutesLocal >= 0 ? '+' : '-';
      const abs = Math.abs(offsetMinutesLocal);
      const offH = Math.floor(abs / 60);
      const offM = abs % 60;
      const gmt = `GMT${sign}${offH}${offM ? ':' + String(offM).padStart(2, '0') : ''}`;
      const tzId = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      const cityRaw = tzId.split('/').pop() || '';
      const city = cityRaw
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (char) => char.toUpperCase());
      const tzHuman = city ? `${gmt} (${city})` : gmt;

      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateReadable = `${reset.getDate()} ${months[reset.getMonth()]} ${reset.getFullYear()}`;

      return `Usage limit reached. Your limit will reset at **${timeStr} ${tzHuman}** - ${dateReadable}`;
    });
  } catch {
    return text;
  }
}
