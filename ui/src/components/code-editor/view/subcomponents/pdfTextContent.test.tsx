// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdfTextContent } from './pdfTextContent';

const asyncIteratorDescriptor = Object.getOwnPropertyDescriptor(ReadableStream.prototype, Symbol.asyncIterator);

afterEach(() => {
  if (asyncIteratorDescriptor) {
    Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, asyncIteratorDescriptor);
  }
});

function onePagePdf(): Uint8Array {
  const text = 'BT /F1 18 Tf 72 720 Td (Hello DOC) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf));
}

describe('PDF text content in browsers without stream async iteration', () => {
  it('reads a real PDF page including its text when ReadableStream has no async iterator', async () => {
    const loadingTask = pdfjs.getDocument({ data: onePagePdf() });
    try {
      const document = await loadingTask.promise;
      const page = await document.getPage(1);
      expect(asyncIteratorDescriptor?.configurable).toBe(true);
      Reflect.deleteProperty(ReadableStream.prototype, Symbol.asyncIterator);
      expect(Reflect.get(ReadableStream.prototype, Symbol.asyncIterator)).toBeUndefined();

      const content = await readPdfTextContent(page);
      expect(content.items.map((item) => ('str' in item ? item.str : '')).join('')).toBe('Hello DOC');
      expect(Object.keys(content.styles).length).toBeGreaterThan(0);
    } finally {
      await loadingTask.destroy();
    }
  });
});
