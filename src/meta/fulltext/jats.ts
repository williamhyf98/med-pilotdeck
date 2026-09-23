/**
 * JATS（PMC 全文 XML）解析与渲染。纯函数，不联网，便于测试。
 *
 * 为什么按"章节 + 段序"定位证据，而不是页码：
 *   efetch 返回的是 JATS XML，段落没有页码，但每个 <sec> 带 sec-type
 *   （intro / methods / results / discussion）。"methods#3" 这种定位器
 *   语义明确、跨渲染稳定，比 PDF 页码更适合做证据校验。
 *
 * 旧文献常见"只有封面元数据、没有 <body>"的情况（扫描件），hasBody=false，
 * 上游要把它当成全文不可得，而不是当成一篇空文章去判断。
 */
import { decodeHtmlEntities } from "../benchmark/load.js";

export type FullTextSection = {
  /** 定位器前缀，例如 "methods"、"participants"、"abstract"。文内唯一。 */
  key: string;
  /** JATS sec-type，可能为空。 */
  type: string;
  /** 带父级路径的标题，例如 "Methods > Participants"。 */
  title: string;
  paragraphs: string[];
};

export type FullTextTable = {
  id: string;
  label: string;
  caption: string;
  /** 按行拼平的单元格文本，列之间用 " | "。 */
  text: string;
};

export type FullTextDocument = {
  pmid: string;
  pmcid: string;
  title: string;
  sections: FullTextSection[];
  tables: FullTextTable[];
  hasBody: boolean;
};

function stripTags(fragment: string): string {
  return decodeHtmlEntities(fragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function slug(text: string): string {
  const out = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out.slice(0, 24) || "sec";
}

type Frame = {
  type: string;
  title: string;
  paragraphs: string[];
  titled: boolean;
  order: number;
};

export function parseJats(xml: string, ids: { pmid: string; pmcid: string }): FullTextDocument {
  const titleMatch = xml.match(/<article-title[^>]*>([\s\S]*?)<\/article-title>/);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";

  const used = new Map<string, number>();
  const uniqueKey = (base: string): string => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n === 0 ? base : `${base}-${n + 1}`;
  };

  const ordered: { order: number; section: FullTextSection }[] = [];

  // 摘要单独取；结构化摘要里的嵌套 <sec> 一律并入同一个 abstract 节。
  const abstractMatch = xml.match(/<abstract(?![-\w])[^>]*>([\s\S]*?)<\/abstract>/);
  if (abstractMatch) {
    const paragraphs = [...abstractMatch[1].matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
      .map((m) => stripTags(m[1]))
      .filter(Boolean);
    if (paragraphs.length > 0) {
      ordered.push({
        order: -1,
        section: { key: uniqueKey("abstract"), type: "abstract", title: "Abstract", paragraphs },
      });
    }
  }

  const tables: FullTextTable[] = [];
  let hasBody = false;
  const bodyMatch = xml.match(/<body[^>]*>([\s\S]*?)<\/body>/);

  if (bodyMatch) {
    let body = bodyMatch[1];

    // 表格先摘出来单独保存，避免表格里的 <p> 被当成正文段落。
    body = body.replace(
      /<table-wrap\b([^>]*)>([\s\S]*?)<\/table-wrap>/g,
      (_whole, attrs: string, inner: string) => {
        const id = attrs.match(/\bid="([^"]+)"/)?.[1] ?? `T${tables.length + 1}`;
        const label = stripTags(inner.match(/<label[^>]*>([\s\S]*?)<\/label>/)?.[1] ?? "");
        const caption = stripTags(inner.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)?.[1] ?? "");
        const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
          [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)]
            .map((cell) => stripTags(cell[1]))
            .join(" | "));
        tables.push({ id, label, caption, text: rows.join("\n") });
        return "";
      },
    );
    // 图注不是证据来源，去掉以免混进段落。
    body = body.replace(/<fig\b[^>]*>[\s\S]*?<\/fig>/g, "");

    const stack: Frame[] = [];
    let bodyFrame: Frame | null = null;
    const tokenRe = /<(\/?)(sec|p|title)\b([^>]*)>/g;
    let pDepth = 0;
    let pStart = -1;
    let titleStart = -1;

    const flush = (frame: Frame, path: string[]) => {
      if (frame.paragraphs.length === 0) return;
      hasBody = true;
      const base = frame.type || slug(frame.title);
      ordered.push({
        order: frame.order,
        section: {
          key: uniqueKey(base),
          type: frame.type,
          title: [...path, frame.title].filter(Boolean).join(" > "),
          paragraphs: frame.paragraphs,
        },
      });
    };

    let match: RegExpExecArray | null;
    while ((match = tokenRe.exec(body))) {
      const closing = match[1] === "/";
      const name = match[2];
      const attrs = match[3];
      const tagEnd = match.index + match[0].length;

      if (name === "sec") {
        if (!closing) {
          if (attrs.trim().endsWith("/")) continue;
          stack.push({
            type: attrs.match(/sec-type="([^"]+)"/)?.[1] ?? "",
            title: "",
            paragraphs: [],
            titled: false,
            order: match.index,
          });
        } else {
          const frame = stack.pop();
          if (frame) flush(frame, stack.map((f) => f.title));
        }
        continue;
      }

      if (name === "title") {
        if (!closing) {
          titleStart = tagEnd;
        } else if (titleStart >= 0) {
          const top = stack[stack.length - 1];
          if (top && !top.titled && top.paragraphs.length === 0 && pDepth === 0) {
            top.title = stripTags(body.slice(titleStart, match.index));
            top.titled = true;
          }
          titleStart = -1;
        }
        continue;
      }

      // name === "p"：用深度计数，段落里嵌套的列表段不会把外层段截断。
      if (!closing) {
        if (pDepth === 0) pStart = tagEnd;
        pDepth += 1;
      } else if (pDepth > 0) {
        pDepth -= 1;
        if (pDepth === 0 && pStart >= 0) {
          const text = stripTags(body.slice(pStart, match.index));
          pStart = -1;
          if (!text) continue;
          const top = stack[stack.length - 1];
          if (top) {
            top.paragraphs.push(text);
          } else {
            if (!bodyFrame) {
              bodyFrame = { type: "", title: "Body", paragraphs: [], titled: true, order: match.index };
            }
            bodyFrame.paragraphs.push(text);
          }
        }
      }
    }
    while (stack.length > 0) {
      const frame = stack.pop()!;
      flush(frame, stack.map((f) => f.title));
    }
    if (bodyFrame) flush(bodyFrame, []);
  }

  ordered.sort((a, b) => a.order - b.order);
  return {
    pmid: ids.pmid,
    pmcid: ids.pmcid,
    title,
    sections: ordered.map((item) => item.section),
    tables,
    hasBody,
  };
}

// ---- 渲染给模型看的文本，同时产出定位器表供校验 ---------------------------

export type RenderedDocument = {
  text: string;
  /** 定位器 → 该段落（或表格）的原文。校验引用时用。 */
  locators: Map<string, string>;
  truncated: boolean;
  omittedParagraphs: number;
};

export type RenderOptions = {
  maxParagraphs?: number;
  maxChars?: number;
  maxTableChars?: number;
};

export function renderDocument(doc: FullTextDocument, options: RenderOptions = {}): RenderedDocument {
  const maxParagraphs = options.maxParagraphs ?? 400;
  const maxChars = options.maxChars ?? 100_000;
  const maxTableChars = options.maxTableChars ?? 4_000;

  const lines: string[] = [];
  const locators = new Map<string, string>();
  let chars = 0;
  let paragraphs = 0;
  let omitted = 0;
  let truncated = false;

  lines.push(`<document pmid="${doc.pmid}" pmcid="${doc.pmcid}">`);
  if (doc.title) lines.push(`# ${doc.title}`);

  for (const section of doc.sections) {
    lines.push(`## [${section.key}] ${section.title}`);
    section.paragraphs.forEach((paragraph, index) => {
      const locator = `${section.key}#${index + 1}`;
      if (truncated || paragraphs >= maxParagraphs || chars + paragraph.length > maxChars) {
        truncated = true;
        omitted += 1;
        return;
      }
      lines.push(`[${locator}] ${paragraph}`);
      locators.set(locator, paragraph);
      paragraphs += 1;
      chars += paragraph.length;
    });
  }

  for (const table of doc.tables) {
    const locator = `table:${table.id}`;
    const head = [table.label, table.caption].filter(Boolean).join(". ");
    const body = table.text.length > maxTableChars
      ? `${table.text.slice(0, maxTableChars)} …`
      : table.text;
    lines.push(`## [${locator}] ${head || table.id}`);
    lines.push(`[${locator}] ${body}`);
    locators.set(locator, `${head} ${body}`);
  }

  if (truncated) lines.push(`[document truncated: ${omitted} paragraphs omitted]`);
  lines.push("</document>");
  return { text: lines.join("\n"), locators, truncated, omittedParagraphs: omitted };
}
