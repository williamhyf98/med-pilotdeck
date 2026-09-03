export type MarkdownImageRef = {
  url: string;
  caption: string;
};

// Either `![alt](url "title")` or a raw `<img …>` tag, in document order.
const IMAGE_TOKEN_PATTERN = /!\[([^\]]*)\]\(([^)]+)\)|<img\b[^>]*>/gi;
const HTML_SRC_PATTERN = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const HTML_ALT_PATTERN = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

const readHtmlAttribute = (tag: string, pattern: RegExp): string => {
  const match = tag.match(pattern);
  if (!match) return '';
  return (match[1] ?? match[2] ?? match[3] ?? '').trim();
};

/** Strip an optional Markdown title so only the destination remains. */
const parseDestination = (raw: string): string => {
  const trimmed = raw.trim();
  if (trimmed.startsWith('<')) {
    const end = trimmed.indexOf('>');
    return (end > 0 ? trimmed.slice(1, end) : trimmed.slice(1)).trim();
  }
  const match = trimmed.match(/^(\S+)/u);
  return match ? match[1] : '';
};

/**
 * List the images referenced by a Markdown string. Used to give the lightbox
 * the full set so users can page through every figure in one answer.
 */
export function collectMarkdownImages(content: string): MarkdownImageRef[] {
  const images: MarkdownImageRef[] = [];
  const seen = new Set<string>();
  const pattern = new RegExp(IMAGE_TOKEN_PATTERN);

  let match = pattern.exec(content);
  while (match !== null) {
    const isMarkdown = match[2] !== undefined;
    const url = isMarkdown ? parseDestination(match[2]) : readHtmlAttribute(match[0], HTML_SRC_PATTERN);
    const caption = isMarkdown
      ? (match[1] ?? '').trim()
      : readHtmlAttribute(match[0], HTML_ALT_PATTERN);
    if (url && !seen.has(url)) {
      seen.add(url);
      images.push({ url, caption });
    }
    match = pattern.exec(content);
  }

  return images;
}
