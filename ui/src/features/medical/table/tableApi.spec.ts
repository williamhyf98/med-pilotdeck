import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTableDocument,
  fetchSafeTableCsv,
  parseOcrOutputWithSidecar,
  parseStructuredOcrJson,
  runTableOcr,
  updateTableDocument,
} from './tableApi';

const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: fetchMock,
}));

describe('tableApi', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('extracts the versioned OCR table JSON and review warnings', () => {
    const parsed = parseStructuredOcrJson([
      '```json',
      JSON.stringify({
        title: '检验表',
        columns: ['项目', '结果'],
        rows: [['白细胞', 6.2]],
        notes: ['单位需要人工确认'],
        uncertain_cells: [{ row: 0, column: 1, reason: '小数点较模糊' }],
      }),
      '```',
    ].join('\n'));

    expect(parsed).toEqual({
      title: '检验表',
      table: {
        columns: ['项目', '结果'],
        rows: [['白细胞', 6.2]],
      },
      warnings: [
        '单位需要人工确认',
        '第 1 行、第 2 列待复核：小数点较模糊',
      ],
    });
  });

  it('uses the OCR parser route and then the real table prepare route', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        result: {
          status: 'parsed',
          table: {
            title: '解析表',
            columns: ['A'],
            rows: [['1']],
            warnings: [],
            format: 'json',
          },
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        result: {
          status: 'prepared',
          table: { columns: ['A'], rows: [['1']] },
          csv: '\uFEFF"A"\r\n"1"',
          formula_injection_protection: true,
        },
      }));

    const imported = await parseOcrOutputWithSidecar('markdown or model JSON');

    expect(imported).toMatchObject({
      title: '解析表',
      parser: 'sidecar',
      needsReview: false,
      formulaInjectionProtection: true,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/medical/tables/ocr/parse',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/medical/sidecar/tables/prepare',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('falls back honestly for structured JSON when the OCR proxy is absent', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        ok: false,
        error: {
          code: 'MEDICAL_ROUTE_NOT_FOUND',
          message: 'Medical API route not found.',
        },
      }, 404))
      .mockResolvedValueOnce(jsonResponse({
        result: {
          table: { columns: ['A'], rows: [['1']] },
          formula_injection_protection: true,
        },
      }));

    const imported = await parseOcrOutputWithSidecar(
      '{"title":"结构化输出","columns":["A"],"rows":[["1"]]}',
    );

    expect(imported.parser).toBe('structured-json-fallback');
    expect(imported.needsReview).toBe(true);
    expect(imported.warnings.join(' ')).toContain('未暴露 OCR parse 路由');
  });

  it('runs one-click OCR and returns the created review document', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      ok: true,
      result: {
        status: 'complete',
        parserStatus: 'parsed',
        contractVersion: 'table-ocr.v1',
        imageCount: 1,
        reviewRequired: true,
      },
      document: {
        docId: 'tableDoc_12345678',
        title: 'OCR 检验表',
        table: { columns: ['项目', '结果'], rows: [['白细胞', '6.2']] },
        warnings: ['逐格复核'],
        formulaInjectionProtection: true,
        version: 1,
      },
    }, 201));

    const result = await runTableOcr({
      images: [{
        name: 'table.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
      }],
      language: 'zh-CN',
    });

    expect(result).toMatchObject({
      status: 'complete',
      parserStatus: 'parsed',
      reviewRequired: true,
      document: {
        docId: 'tableDoc_12345678',
        title: 'OCR 检验表',
        rowCount: 1,
        columnCount: 2,
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/medical/tables/ocr',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      images: [{
        name: 'table.png',
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
      }],
      language: 'zh-CN',
    });
  });

  it('uses optimistic versions for document updates and downloads backend CSV', async () => {
    const document = {
      docId: 'tableDoc_12345678',
      title: '检验表',
      table: { columns: ['A'], rows: [['1']] },
      warnings: [],
      formulaInjectionProtection: true,
      version: 1,
      createdAt: '2026-08-06T00:00:00.000Z',
      updatedAt: '2026-08-06T00:00:00.000Z',
      expiresAt: null,
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ document }, 201))
      .mockResolvedValueOnce(jsonResponse({
        document: { ...document, title: '更新表', version: 2 },
      }))
      .mockResolvedValueOnce(new Response('\uFEFF"A"\r\n"\'=1+1"', {
        status: 200,
        headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      }));

    const created = await createTableDocument({
      title: '检验表',
      table: document.table,
    });
    await updateTableDocument({
      docId: created.docId,
      version: created.version,
      title: '更新表',
      table: document.table,
    });
    const csv = await fetchSafeTableCsv(created.docId);

    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toMatchObject({
      version: 1,
      title: '更新表',
    });
    expect(await csv.text()).toContain("'=1+1");
    expect(fetchMock.mock.calls[2][0]).toBe(
      '/api/medical/tables/tableDoc_12345678/export.csv',
    );
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
