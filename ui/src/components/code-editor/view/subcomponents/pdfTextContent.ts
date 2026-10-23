import type { PDFPageProxy } from 'pdfjs-dist';

type TextContent = Awaited<ReturnType<PDFPageProxy['getTextContent']>>;

// PDF.js getTextContent() iterates a ReadableStream with `for await`, which
// fails in browsers that expose getReader() but not Symbol.asyncIterator.
export async function readPdfTextContent(page: PDFPageProxy): Promise<TextContent> {
  if (page.isPureXfa) return page.getTextContent();

  const reader = (page.streamTextContent() as ReadableStream<TextContent>).getReader();
  const content: TextContent = {
    items: [],
    styles: Object.create(null),
    lang: null,
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      content.lang ??= value.lang;
      Object.assign(content.styles, value.styles);
      content.items.push(...value.items);
    }
    return content;
  } finally {
    reader.releaseLock();
  }
}
