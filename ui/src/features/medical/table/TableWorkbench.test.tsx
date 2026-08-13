import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TableWorkbench from './TableWorkbench';

const apiMocks = vi.hoisted(() => ({
  loadStatus: vi.fn(),
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
  createDocument: vi.fn(),
  updateDocument: vi.fn(),
  deleteDocument: vi.fn(),
  fetchCsv: vi.fn(),
  prepareTable: vi.fn(),
  runOcr: vi.fn(),
}));

vi.mock('./tableApi', () => ({
  loadTableBackendStatus: apiMocks.loadStatus,
  listTableDocuments: apiMocks.listDocuments,
  getTableDocument: apiMocks.getDocument,
  createTableDocument: apiMocks.createDocument,
  updateTableDocument: apiMocks.updateDocument,
  deleteTableDocument: apiMocks.deleteDocument,
  fetchSafeTableCsv: apiMocks.fetchCsv,
  prepareTable: apiMocks.prepareTable,
  runTableOcr: apiMocks.runOcr,
}));

describe('TableWorkbench', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:table-preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
    apiMocks.loadStatus.mockResolvedValue({
      sidecarAvailable: true,
      tableAvailable: true,
      documentStorageAvailable: true,
      directOcrGenerationAvailable: true,
      generationStatus: 'not_probed',
    });
    apiMocks.listDocuments.mockResolvedValue([]);
  });

  afterEach(cleanup);

  it('renders the real empty document state without a synthetic success', async () => {
    render(<TableWorkbench onUseTableMode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /文档与安全 CSV/u }));

    expect(await screen.findByText('还没有表格文档。')).toBeTruthy();
    expect(screen.queryByText('文档已创建。')).toBeNull();
    expect(apiMocks.listDocuments).toHaveBeenCalledOnce();
  });

  it('uploads selected images once and opens the created document for review', async () => {
    apiMocks.runOcr.mockResolvedValue({
      status: 'complete',
      parserStatus: 'parsed',
      contractVersion: 'table-ocr.v1',
      imageCount: 1,
      reviewRequired: true,
      document: {
        docId: 'tableDoc_12345678',
        title: 'OCR 检验表',
        table: { columns: ['项目', '结果'], rows: [['白细胞', '6.2']] },
        warnings: ['第 1 行待复核'],
        formulaInjectionProtection: true,
        rowCount: 1,
        columnCount: 2,
        version: 1,
      },
    });
    render(<TableWorkbench onUseTableMode={vi.fn()} />);

    const file = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      'table.png',
      { type: 'image/png' },
    );
    fireEvent.change(screen.getByLabelText('选择表格图片'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: '一键 OCR 并创建文档' }));

    expect(await screen.findByDisplayValue('OCR 检验表')).toBeTruthy();
    expect(screen.getByText('OCR 文档已创建。视觉识别结果必须由人工逐格复核后再使用。')).toBeTruthy();
    expect(screen.getByText('第 1 行待复核')).toBeTruthy();
    expect(screen.getByText(/已收到真实 sidecar 校验结果/u)).toBeTruthy();
    expect(screen.getByText(/人工复核：对照原图逐格检查/u)).toBeTruthy();
    expect(screen.getByAltText('OCR 原图 1')).toBeTruthy();
    await waitFor(() => {
      expect(apiMocks.runOcr).toHaveBeenCalledWith({
        images: [{
          mimeType: 'image/png',
          data: expect.any(String),
        }],
        language: 'zh-CN',
      });
    });
  });

  it('shows the real OCR backend error instead of a synthetic result', async () => {
    apiMocks.runOcr.mockRejectedValue(
      new Error('The selected PilotDeck model does not support image input.'),
    );
    render(<TableWorkbench onUseTableMode={vi.fn()} />);
    const file = new File(
      [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
      'table.png',
      { type: 'image/png' },
    );

    fireEvent.change(screen.getByLabelText('选择表格图片'), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole('button', { name: '一键 OCR 并创建文档' }));

    expect(await screen.findByText(
      'The selected PilotDeck model does not support image input.',
    )).toBeTruthy();
    expect(screen.queryByDisplayValue('OCR 检验表')).toBeNull();
  });
});
