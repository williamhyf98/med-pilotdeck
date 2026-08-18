import { authenticatedFetch } from '../../../utils/api';

export type TableCell = string | number | boolean | null;

export type MedicalTable = {
  columns: string[];
  rows: TableCell[][];
};

export type TableDocumentSummary = {
  docId: string;
  title: string;
  columnCount: number;
  rowCount: number;
  version: number;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string | null;
};

export type TableDocument = TableDocumentSummary & {
  table: MedicalTable;
  warnings: string[];
  formulaInjectionProtection: boolean;
  sourceArtifactId?: string | null;
};

export type TableBackendStatus = {
  sidecarAvailable: boolean;
  tableAvailable: boolean;
  tableReason?: string;
  documentStorageAvailable: boolean | null;
  directOcrGenerationAvailable: boolean;
  generationStatus: string;
};

export type PreparedTable = {
  table: MedicalTable;
  csv?: string;
  formulaInjectionProtection: boolean;
  warnings: string[];
};

export type ImportedOcrTable = PreparedTable & {
  title: string;
  parser: 'sidecar' | 'structured-json-fallback';
  needsReview: boolean;
};

export type TableOcrImage = {
  name?: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  data: string;
};

export type TableOcrResult = {
  document: TableDocument;
  status: string;
  parserStatus: 'parsed' | 'needs_review';
  contractVersion: string;
  imageCount: number;
  reviewRequired: boolean;
};

type UnknownRecord = Record<string, unknown>;

export class TableApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly reason?: string;

  constructor(code: string, message: string, status = 500, reason?: string) {
    super(message);
    this.name = 'TableApiError';
    this.code = code;
    this.status = status;
    this.reason = reason;
  }
}

export async function loadTableBackendStatus(signal?: AbortSignal): Promise<TableBackendStatus> {
  const body = await requestJson('/api/medical/health', {
    suppressServerErrorToast: true,
    signal,
  }, '医疗能力状态加载失败');
  const capabilities = record(body.capabilities);
  const tables = record(capabilities.tables);
  const documents = record(capabilities.tableDocuments);
  const directGeneration = record(
    capabilities.tableOcrGeneration ?? capabilities.tableGeneration,
  );
  const sidecar = record(body.sidecar);
  const generation = record(body.generation);
  return {
    sidecarAvailable: sidecar.available === true,
    tableAvailable: tables.available === true,
    tableReason: stringValue(tables.reason) || stringValue(sidecar.reason) || undefined,
    documentStorageAvailable: documents.available === true
      ? true
      : documents.available === false
        ? false
        : null,
    directOcrGenerationAvailable: directGeneration.available === true,
    generationStatus: stringValue(generation.status) || 'unknown',
  };
}

export async function listTableDocuments(signal?: AbortSignal): Promise<TableDocumentSummary[]> {
  const body = await requestJson('/api/medical/tables?limit=100', {
    suppressServerErrorToast: true,
    signal,
  }, '表格文档列表加载失败');
  const documents = Array.isArray(body.documents) ? body.documents : [];
  return documents.flatMap((value) => {
    const document = record(value);
    const docId = stringValue(document.docId);
    if (!docId) return [];
    return [{
      docId,
      title: stringValue(document.title) || '未命名表格',
      columnCount: nonNegativeInteger(document.columnCount),
      rowCount: nonNegativeInteger(document.rowCount),
      version: positiveInteger(document.version, 1),
      createdAt: optionalString(document.createdAt),
      updatedAt: optionalString(document.updatedAt),
      expiresAt: nullableString(document.expiresAt),
    }];
  });
}

export async function getTableDocument(
  docId: string,
  signal?: AbortSignal,
): Promise<TableDocument> {
  const body = await requestJson(`/api/medical/tables/${encodeURIComponent(docId)}`, {
    suppressServerErrorToast: true,
    signal,
  }, '表格文档加载失败');
  return normalizeDocument(body.document);
}

export async function createTableDocument(input: {
  title: string;
  table: MedicalTable;
  warnings?: string[];
  ttlSeconds?: number;
}): Promise<TableDocument> {
  const body = await requestJson('/api/medical/tables', {
    method: 'POST',
    suppressServerErrorToast: true,
    body: JSON.stringify({
      title: input.title,
      table: input.table,
      ...(input.warnings?.length ? { warnings: input.warnings } : {}),
      ...(input.ttlSeconds ? { ttlSeconds: input.ttlSeconds } : {}),
    }),
  }, '表格文档创建失败');
  return normalizeDocument(body.document);
}

export async function updateTableDocument(input: {
  docId: string;
  version: number;
  title: string;
  table: MedicalTable;
  warnings?: string[];
  ttlSeconds?: number;
}): Promise<TableDocument> {
  const body = await requestJson(`/api/medical/tables/${encodeURIComponent(input.docId)}`, {
    method: 'PUT',
    suppressServerErrorToast: true,
    body: JSON.stringify({
      version: input.version,
      title: input.title,
      table: input.table,
      ...(input.warnings?.length ? { warnings: input.warnings } : {}),
      ...(input.ttlSeconds ? { ttlSeconds: input.ttlSeconds } : {}),
    }),
  }, '表格文档更新失败');
  return normalizeDocument(body.document);
}

export async function deleteTableDocument(docId: string): Promise<void> {
  await requestJson(`/api/medical/tables/${encodeURIComponent(docId)}`, {
    method: 'DELETE',
    suppressServerErrorToast: true,
  }, '表格文档删除失败');
}

export async function fetchSafeTableCsv(docId: string): Promise<Blob> {
  const response = await authenticatedFetch(
    `/api/medical/tables/${encodeURIComponent(docId)}/export.csv`,
    { suppressServerErrorToast: true },
  );
  if (!response.ok) {
    throw await responseError(response, '安全 CSV 下载失败');
  }
  return response.blob();
}

export async function prepareTable(table: MedicalTable): Promise<PreparedTable> {
  const body = await requestJson('/api/medical/sidecar/tables/prepare', {
    method: 'POST',
    suppressServerErrorToast: true,
    body: JSON.stringify({ table }),
  }, '表格 sidecar 校验失败');
  const result = record(body.result);
  const preparedTable = tableValue(record(result.table), table);
  return {
    table: preparedTable,
    csv: optionalString(result.csv),
    formulaInjectionProtection: result.formula_injection_protection === true
      || result.formulaInjectionProtection === true,
    warnings: stringList(result.warnings),
  };
}

export async function runTableOcr(input: {
  images: TableOcrImage[];
  language?: string;
  model?: string;
  ttlSeconds?: number;
}): Promise<TableOcrResult> {
  const body = await requestJson('/api/medical/tables/ocr', {
    method: 'POST',
    suppressServerErrorToast: true,
    body: JSON.stringify({
      images: input.images,
      language: input.language || 'zh-CN',
      ...(input.model ? { model: input.model } : {}),
      ...(input.ttlSeconds ? { ttlSeconds: input.ttlSeconds } : {}),
    }),
  }, '表格 OCR 失败');
  const result = record(body.result);
  const parserStatus = stringValue(result.parserStatus);
  if (parserStatus !== 'parsed' && parserStatus !== 'needs_review') {
    throw new TableApiError(
      'MEDICAL_OCR_RESPONSE_INVALID',
      '表格 OCR 响应缺少有效的解析状态。',
      502,
    );
  }
  return {
    document: normalizeDocument(body.document),
    status: stringValue(result.status) || 'complete',
    parserStatus,
    contractVersion: stringValue(result.contractVersion) || 'table-ocr.v1',
    imageCount: nonNegativeInteger(result.imageCount),
    reviewRequired: result.reviewRequired !== false,
  };
}

export async function parseOcrOutputWithSidecar(modelOutput: string): Promise<ImportedOcrTable> {
  const trimmed = modelOutput.trim();
  if (!trimmed) {
    throw new TableApiError(
      'MEDICAL_OCR_OUTPUT_REQUIRED',
      '请粘贴 PilotDeck 表格任务返回的 OCR 输出。',
      400,
    );
  }

  try {
    const body = await requestJson('/api/medical/tables/ocr/parse', {
      method: 'POST',
      suppressServerErrorToast: true,
      body: JSON.stringify({ modelOutput: trimmed, includeRaw: false }),
    }, 'OCR 输出解析失败');
    const imported = importedTableFromParserResponse(body);
    const prepared = await prepareTable(imported.table);
    return {
      ...imported,
      ...prepared,
      warnings: uniqueStrings([...imported.warnings, ...prepared.warnings]),
    };
  } catch (error) {
    if (
      !(error instanceof TableApiError)
      || (error.status !== 404 && error.code !== 'MEDICAL_ROUTE_NOT_FOUND')
    ) {
      throw error;
    }
  }

  const imported = parseStructuredOcrJson(trimmed);
  if (!imported) {
    throw new TableApiError(
      'MEDICAL_OCR_PARSE_PROXY_UNAVAILABLE',
      '当前 /api/medical 未暴露 OCR parse 路由。请先在 PilotDeck“表格数字化”任务中调用 medical_sidecar_parse_table_ocr，再粘贴它返回的 JSON。',
      503,
      'ocr_parse_route_unavailable',
    );
  }
  const prepared = await prepareTable(imported.table);
  return {
    ...prepared,
    title: imported.title || 'OCR 表格',
    warnings: uniqueStrings([
      ...imported.warnings,
      ...prepared.warnings,
      '当前后端未暴露 OCR parse 路由；本次仅对已结构化 JSON 执行 sidecar 表格校验。',
    ]),
    parser: 'structured-json-fallback',
    needsReview: true,
  };
}

export function parseStructuredOcrJson(value: string): {
  title: string;
  table: MedicalTable;
  warnings: string[];
} | null {
  const parsed = parseJsonCandidate(value);
  if (!isRecord(parsed)) return null;
  const root = isRecord(parsed.result) ? parsed.result : parsed;
  const parserTable = isRecord(root.table) ? root.table : root;
  if (!Array.isArray(parserTable.columns) || !Array.isArray(parserTable.rows)) return null;

  const table = tableValue(parserTable);
  const uncertain = Array.isArray(parserTable.uncertain_cells)
    ? parserTable.uncertain_cells
    : Array.isArray(root.uncertain_cells)
      ? root.uncertain_cells
      : [];
  const uncertaintyWarnings = uncertain.flatMap((value) => {
    const item = record(value);
    const row = Number(item.row);
    const column = Number(item.column);
    const reason = stringValue(item.reason);
    if (!Number.isSafeInteger(row) || !Number.isSafeInteger(column) || !reason) return [];
    return [`第 ${row + 1} 行、第 ${column + 1} 列待复核：${reason}`];
  });
  return {
    title: stringValue(parserTable.title) || stringValue(root.title),
    table,
    warnings: uniqueStrings([
      ...stringList(root.warnings),
      ...stringList(parserTable.warnings),
      ...stringList(parserTable.notes),
      ...uncertaintyWarnings,
    ]),
  };
}

function importedTableFromParserResponse(body: UnknownRecord): ImportedOcrTable {
  const root = isRecord(body.result) ? body.result : body;
  const parsed = parseStructuredOcrJson(JSON.stringify(root));
  if (!parsed) {
    throw new TableApiError(
      'MEDICAL_OCR_RESPONSE_INVALID',
      'OCR parser 返回了无法识别的表格结构。',
      502,
    );
  }
  const status = stringValue(root.status);
  return {
    title: parsed.title || 'OCR 表格',
    table: parsed.table,
    warnings: parsed.warnings,
    formulaInjectionProtection: true,
    parser: 'sidecar',
    needsReview: status === 'needs_review'
      || stringValue(record(root.table).format) === 'raw',
  };
}

function normalizeDocument(value: unknown): TableDocument {
  const document = record(value);
  const docId = stringValue(document.docId);
  if (!docId) {
    throw new TableApiError(
      'MEDICAL_TABLE_RESPONSE_INVALID',
      '表格文档响应缺少 docId。',
      502,
    );
  }
  const table = tableValue(record(document.table));
  return {
    docId,
    title: stringValue(document.title) || '未命名表格',
    table,
    warnings: stringList(document.warnings),
    formulaInjectionProtection: document.formulaInjectionProtection === true,
    sourceArtifactId: nullableString(document.sourceArtifactId),
    columnCount: table.columns.length,
    rowCount: table.rows.length,
    version: positiveInteger(document.version, 1),
    createdAt: optionalString(document.createdAt),
    updatedAt: optionalString(document.updatedAt),
    expiresAt: nullableString(document.expiresAt),
  };
}

function tableValue(value: UnknownRecord, fallback?: MedicalTable): MedicalTable {
  const columnsValue = Array.isArray(value.columns) ? value.columns : fallback?.columns;
  const rowsValue = Array.isArray(value.rows) ? value.rows : fallback?.rows;
  if (!columnsValue || !rowsValue || columnsValue.length === 0) {
    throw new TableApiError(
      'MEDICAL_TABLE_RESPONSE_INVALID',
      '表格结构缺少列或行数组。',
      502,
    );
  }
  const columns = columnsValue.map((column, index) => {
    const normalized = String(column ?? '').trim();
    if (!normalized) {
      throw new TableApiError(
        'MEDICAL_TABLE_INVALID',
        `第 ${index + 1} 列名称不能为空。`,
        400,
      );
    }
    return normalized;
  });
  const rows = rowsValue.map((row, rowIndex) => {
    if (!Array.isArray(row) || row.length !== columns.length) {
      throw new TableApiError(
        'MEDICAL_TABLE_INVALID',
        `第 ${rowIndex + 1} 行必须包含 ${columns.length} 个单元格。`,
        400,
      );
    }
    return row.map((cell) => {
      if (
        cell === null
        || typeof cell === 'string'
        || typeof cell === 'boolean'
        || (typeof cell === 'number' && Number.isFinite(cell))
      ) {
        return cell;
      }
      return JSON.stringify(cell);
    });
  });
  return { columns, rows };
}

async function requestJson(
  url: string,
  options: RequestInit & { suppressServerErrorToast?: boolean },
  fallback: string,
): Promise<UnknownRecord> {
  const response = await authenticatedFetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw await responseError(response, fallback, body);
  if (!isRecord(body)) {
    throw new TableApiError(
      'MEDICAL_RESPONSE_INVALID',
      `${fallback}：后端返回了无效 JSON。`,
      502,
    );
  }
  return body;
}

async function responseError(
  response: Response,
  fallback: string,
  knownBody?: unknown,
): Promise<TableApiError> {
  const body = isRecord(knownBody)
    ? knownBody
    : await response.json().catch(() => ({}));
  const error = record(body.error);
  return new TableApiError(
    stringValue(error.code) || 'MEDICAL_REQUEST_FAILED',
    stringValue(error.message) || `${fallback}（HTTP ${response.status}）。`,
    response.status,
    stringValue(error.reason) || undefined,
  );
}

function parseJsonCandidate(value: string): unknown {
  const candidates = [
    value.trim(),
    ...Array.from(value.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu), (match) => match[1].trim()),
  ];
  const firstBrace = value.indexOf('{');
  const lastBrace = value.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(value.slice(firstBrace, lastBrace + 1));
  }
  for (const candidate of uniqueStrings(candidates)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next bounded JSON candidate.
    }
  }
  return null;
}

function record(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const normalized = stringValue(value);
  return normalized || undefined;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return optionalString(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringValue).filter(Boolean)
    : [];
}

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
