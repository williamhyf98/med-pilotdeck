import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Database,
  Download,
  FileImage,
  FilePlus2,
  FileSpreadsheet,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Input } from '../../../components/ui/input';
import { cn } from '../../../lib/utils.js';
import {
  createTableDocument,
  deleteTableDocument,
  fetchSafeTableCsv,
  getTableDocument,
  listTableDocuments,
  loadTableBackendStatus,
  prepareTable,
  runTableOcr,
  updateTableDocument,
} from './tableApi';
import type {
  MedicalTable,
  PreparedTable,
  TableBackendStatus,
  TableCell,
  TableDocument,
  TableDocumentSummary,
} from './tableApi';

type PageId = 'ocr' | 'documents';
type OcrProgress = 'idle' | 'encoding' | 'processing';
type OcrImage = {
  id: string;
  file: File;
  previewUrl?: string;
};

const MAX_OCR_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
const EMPTY_TABLE: MedicalTable = {
  columns: ['列1', '列2'],
  rows: [['', '']],
};

export default function TableWorkbench(_props: {
  onUseTableMode?: () => void;
}) {
  const [page, setPage] = useState<PageId>('ocr');
  const [backend, setBackend] = useState<TableBackendStatus | null>(null);
  const [backendError, setBackendError] = useState('');
  const [documents, setDocuments] = useState<TableDocumentSummary[]>([]);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [documentsError, setDocumentsError] = useState('');
  const [currentDocument, setCurrentDocument] = useState<TableDocument | null>(null);
  const [title, setTitle] = useState('');
  const [columns, setColumns] = useState([...EMPTY_TABLE.columns]);
  const [rows, setRows] = useState<TableCell[][]>(EMPTY_TABLE.rows.map((row) => [...row]));
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editorError, setEditorError] = useState('');
  const [editorNotice, setEditorNotice] = useState('');
  const [documentAction, setDocumentAction] = useState<'load' | 'save' | 'delete' | 'csv' | 'validate' | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState(false);
  const [validation, setValidation] = useState<PreparedTable | null>(null);
  const [ocrImages, setOcrImages] = useState<OcrImage[]>([]);
  const [reviewImages, setReviewImages] = useState<OcrImage[]>([]);
  const [imageError, setImageError] = useState('');
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<OcrProgress>('idle');
  const [ocrError, setOcrError] = useState('');
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrlsRef = useRef(new Set<string>());

  const loadDocuments = useCallback(async (signal?: AbortSignal) => {
    setDocumentsLoading(true);
    setDocumentsError('');
    try {
      setDocuments(await listTableDocuments(signal));
    } catch (cause) {
      if (!signal?.aborted) {
        setDocumentsError(errorMessage(cause, '表格文档列表加载失败。'));
      }
    } finally {
      if (!signal?.aborted) setDocumentsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadTableBackendStatus(controller.signal)
      .then(setBackend)
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setBackendError(errorMessage(cause, '医疗能力状态加载失败。'));
        }
      });
    void loadDocuments(controller.signal);
    return () => controller.abort();
  }, [loadDocuments]);

  useEffect(() => () => {
    objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    objectUrlsRef.current.clear();
  }, []);

  const currentTable = useMemo<MedicalTable>(() => ({ columns, rows }), [columns, rows]);
  const columnTemplate = useMemo(() => columns.map(() => ''), [columns]);

  const clearReviewImages = () => {
    setReviewImages((current) => {
      current.forEach((item) => {
        if (item.previewUrl) {
          URL.revokeObjectURL(item.previewUrl);
          objectUrlsRef.current.delete(item.previewUrl);
        }
      });
      return [];
    });
  };

  const startNewDocument = () => {
    clearReviewImages();
    setCurrentDocument(null);
    setTitle('');
    setColumns([...EMPTY_TABLE.columns]);
    setRows(EMPTY_TABLE.rows.map((row) => [...row]));
    setWarnings([]);
    setValidation(null);
    setEditorError('');
    setEditorNotice('');
    setDeleteConfirmation(false);
  };

  const openDocument = async (docId: string) => {
    clearReviewImages();
    setDocumentAction('load');
    setEditorError('');
    setEditorNotice('');
    setDeleteConfirmation(false);
    try {
      const document = await getTableDocument(docId);
      setCurrentDocument(document);
      setTitle(document.title);
      setColumns([...document.table.columns]);
      setRows(document.table.rows.map((row) => [...row]));
      setWarnings([...document.warnings]);
      setValidation(null);
    } catch (cause) {
      setEditorError(errorMessage(cause, '表格文档加载失败。'));
    } finally {
      setDocumentAction(null);
    }
  };

  const saveDocument = async () => {
    if (!title.trim()) {
      setEditorError('请输入文档标题。');
      return;
    }
    setDocumentAction('save');
    setEditorError('');
    setEditorNotice('');
    try {
      const saved = currentDocument
        ? await updateTableDocument({
          docId: currentDocument.docId,
          version: currentDocument.version,
          title: title.trim(),
          table: currentTable,
          warnings,
        })
        : await createTableDocument({
          title: title.trim(),
          table: currentTable,
          warnings,
        });
      setCurrentDocument(saved);
      setTitle(saved.title);
      setColumns([...saved.table.columns]);
      setRows(saved.table.rows.map((row) => [...row]));
      setWarnings([...saved.warnings]);
      setEditorNotice(currentDocument ? '文档已按最新版本更新。' : '文档已创建。');
      await loadDocuments();
    } catch (cause) {
      setEditorError(errorMessage(cause, '表格文档保存失败。'));
    } finally {
      setDocumentAction(null);
    }
  };

  const removeDocument = async () => {
    if (!currentDocument) return;
    setDocumentAction('delete');
    setEditorError('');
    setEditorNotice('');
    try {
      await deleteTableDocument(currentDocument.docId);
      startNewDocument();
      setEditorNotice('文档已删除。');
      await loadDocuments();
    } catch (cause) {
      setEditorError(errorMessage(cause, '表格文档删除失败。'));
    } finally {
      setDocumentAction(null);
    }
  };

  const validateCurrentTable = async () => {
    setDocumentAction('validate');
    setEditorError('');
    setEditorNotice('');
    setValidation(null);
    try {
      const prepared = await prepareTable(currentTable);
      setValidation(prepared);
      setColumns([...prepared.table.columns]);
      setRows(prepared.table.rows.map((row) => [...row]));
    } catch (cause) {
      setEditorError(errorMessage(cause, '表格 sidecar 校验失败。'));
    } finally {
      setDocumentAction(null);
    }
  };

  const downloadCsv = async () => {
    if (!currentDocument) return;
    setDocumentAction('csv');
    setEditorError('');
    try {
      const blob = await fetchSafeTableCsv(currentDocument.docId);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${safeDownloadName(currentDocument.title)}.csv`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setEditorError(errorMessage(cause, '安全 CSV 下载失败。'));
    } finally {
      setDocumentAction(null);
    }
  };

  const addOcrImages = (files: File[]) => {
    setImageError('');
    const remaining = MAX_OCR_IMAGES - ocrImages.length;
    if (remaining <= 0) {
      setImageError(`单次最多选择 ${MAX_OCR_IMAGES} 张图片。`);
      return;
    }
    const currentBytes = ocrImages.reduce((sum, item) => sum + item.file.size, 0);
    let acceptedBytes = currentBytes;
    const accepted: OcrImage[] = [];
    for (const file of files.slice(0, remaining)) {
      if (!isSupportedOcrImage(file)) {
        setImageError(`${file.name} 不是受支持的 JPEG、PNG 或 WebP 图片。`);
        continue;
      }
      if (file.size < 1 || file.size > MAX_IMAGE_BYTES) {
        setImageError(`${file.name} 超过单文件 4 MB 限制或为空。`);
        continue;
      }
      if (acceptedBytes + file.size > MAX_TOTAL_IMAGE_BYTES) {
        setImageError('所选图片总大小不能超过 12 MB。');
        break;
      }
      const previewUrl = URL.createObjectURL(file);
      objectUrlsRef.current.add(previewUrl);
      acceptedBytes += file.size;
      accepted.push({
        id: `${file.name}:${file.size}:${file.lastModified}:${crypto.randomUUID()}`,
        file,
        previewUrl,
      });
    }
    if (files.length > remaining) {
      setImageError(`单次最多选择 ${MAX_OCR_IMAGES} 张图片。`);
    }
    setOcrImages((current) => [...current, ...accepted]);
  };

  const removeOcrImage = (id: string) => {
    setOcrImages((current) => current.filter((item) => {
      if (item.id !== id) return true;
      if (item.previewUrl) {
        URL.revokeObjectURL(item.previewUrl);
        objectUrlsRef.current.delete(item.previewUrl);
      }
      return false;
    }));
  };

  const startTableOcr = async () => {
    if (ocrImages.length === 0) {
      setOcrError('请先选择至少一张表格图片。');
      return;
    }
    setOcrLoading(true);
    setOcrProgress('encoding');
    setOcrError('');
    try {
      const images = await Promise.all(ocrImages.map(async ({ file }) => {
        const mimeType = ocrImageMimeType(file);
        if (!mimeType) throw new Error(`${file.name} 不是受支持的 JPEG、PNG 或 WebP 图片。`);
        return {
          mimeType,
          data: await fileToBase64(file),
        };
      }));
      setOcrProgress('processing');
      const result = await runTableOcr({ images, language: 'zh-CN' });
      const { document } = result;
      setCurrentDocument(document);
      setTitle(document.title);
      setColumns([...document.table.columns]);
      setRows(document.table.rows.map((row) => [...row]));
      setWarnings([...document.warnings]);
      setValidation({
        table: document.table,
        formulaInjectionProtection: document.formulaInjectionProtection,
        warnings: document.warnings,
      });
      setEditorError('');
      setEditorNotice(
        result.parserStatus === 'needs_review'
          ? 'OCR 文档已创建，但解析器标记为待复核；请逐格核对原图后再使用。'
          : 'OCR 文档已创建。视觉识别结果必须由人工逐格复核后再使用。',
      );
      setReviewImages((current) => {
        current.forEach((item) => {
          if (item.previewUrl) {
            URL.revokeObjectURL(item.previewUrl);
            objectUrlsRef.current.delete(item.previewUrl);
          }
        });
        return ocrImages;
      });
      setOcrImages([]);
      await loadDocuments();
      setPage('documents');
    } catch (cause) {
      setOcrError(errorMessage(cause, '表格 OCR 失败。'));
    } finally {
      setOcrLoading(false);
      setOcrProgress('idle');
    }
  };

  return (
    <div className="space-y-4">
      <BackendStatus status={backend} error={backendError} />

      <div className="flex rounded-lg border border-border bg-muted/30 p-1">
        <PageButton active={page === 'ocr'} onClick={() => setPage('ocr')}>
          <FileImage className="h-3.5 w-3.5" />
          图片 OCR 工作流
        </PageButton>
        <PageButton active={page === 'documents'} onClick={() => setPage('documents')}>
          <Database className="h-3.5 w-3.5" />
          文档与安全 CSV
          {!documentsLoading ? <span className="text-[9px] opacity-70">{documents.length}</span> : null}
        </PageButton>
      </div>

      {page === 'ocr' ? (
        <section className="space-y-3">
          <article className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-start gap-3">
              <StepNumber value={1} />
              <div className="min-w-0 flex-1">
                <h3 className="text-[12px] font-semibold">选择待数字化图片</h3>
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  最多 4 张 JPEG、PNG 或 WebP；单张 4 MB，总计 12 MB。点击识别后才会安全上传。
                </p>
                <input
                  ref={imageInputRef}
                  type="file"
                  multiple
                  accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                  className="hidden"
                  aria-label="选择表格图片"
                  onChange={(event) => {
                    addOcrImages(Array.from(event.target.files || []));
                    event.target.value = '';
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3 h-8 text-[11px]"
                  onClick={() => imageInputRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" />
                  选择图片
                </Button>
                {imageError ? <InlineError className="mt-3">{imageError}</InlineError> : null}
                {ocrImages.length ? (
                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    {ocrImages.map((item, index) => (
                      <article key={item.id} className="flex items-center gap-2 rounded-lg border border-border p-2">
                        <img src={item.previewUrl} alt="" className="h-12 w-12 rounded object-cover" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[10px] font-medium">{index + 1}. {item.file.name}</p>
                          <p className="text-[9px] text-muted-foreground">{formatBytes(item.file.size)}</p>
                        </div>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-label={`移除 ${item.file.name}`}
                          onClick={() => removeOcrImage(item.id)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </article>
                    ))}
                  </div>
                ) : (
                  <p className="mt-3 rounded-lg border border-dashed border-border px-3 py-4 text-center text-[10px] text-muted-foreground">
                    尚未选择图片。
                  </p>
                )}
              </div>
            </div>
          </article>

          <article className="rounded-xl border border-border bg-background p-4">
            <div className="flex items-start gap-3">
              <StepNumber value={2} />
              <div className="min-w-0 flex-1">
                <h3 className="text-[12px] font-semibold">一键识别、解析并创建文档</h3>
                <p className="mt-1 text-[10px] leading-4 text-muted-foreground">
                  后端会调用 Sidecar 生成受信 OCR 提示并重编码图片，再通过 PilotDeck Gateway
                  调用视觉模型、解析结构化结果并创建当前用户的表格文档。
                </p>
                {ocrError ? <InlineError className="mt-3">{ocrError}</InlineError> : null}
                {ocrProgress !== 'idle' ? (
                  <div
                    className="mt-3 flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-[10px] text-muted-foreground"
                    role="status"
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {ocrProgress === 'encoding'
                      ? '正在读取并编码所选图片…'
                      : '后台正在安全重编码、视觉识别、Sidecar 解析并创建文档…'}
                  </div>
                ) : null}
                <Button
                  type="button"
                  className="mt-3 w-full"
                  disabled={ocrLoading || ocrImages.length === 0}
                  onClick={() => void startTableOcr()}
                >
                  {ocrLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                  一键 OCR 并创建文档
                </Button>
                <p className="mt-2 text-[9px] leading-4 text-muted-foreground">
                  不支持视觉的模型或不可用的 Sidecar 会返回真实错误，不会生成模拟结果。
                </p>
              </div>
            </div>
          </article>
        </section>
      ) : (
        <section className="grid gap-3 lg:grid-cols-[230px_minmax(0,1fr)]">
          <aside className="rounded-xl border border-border bg-background p-3">
            <div className="mb-3 flex items-center gap-2">
              <div className="mr-auto">
                <h3 className="text-[12px] font-semibold">表格文档</h3>
                <p className="text-[9px] text-muted-foreground">用户隔离存储 · 乐观版本</p>
              </div>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                aria-label="刷新文档"
                disabled={documentsLoading}
                onClick={() => void loadDocuments()}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', documentsLoading && 'animate-spin')} />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="outline"
                className="h-7 w-7"
                aria-label="新建文档"
                onClick={startNewDocument}
              >
                <FilePlus2 className="h-3.5 w-3.5" />
              </Button>
            </div>
            {documentsLoading ? (
              <StateMessage icon={<Loader2 className="animate-spin" />}>正在读取文档列表…</StateMessage>
            ) : documentsError ? (
              <StateMessage tone="error" icon={<AlertTriangle />}>{documentsError}</StateMessage>
            ) : documents.length === 0 ? (
              <StateMessage icon={<FileSpreadsheet />}>还没有表格文档。</StateMessage>
            ) : (
              <div className="max-h-[480px] space-y-1.5 overflow-y-auto">
                {documents.map((document) => (
                  <button
                    key={document.docId}
                    type="button"
                    className={cn(
                      'w-full rounded-lg border p-2.5 text-left transition-colors',
                      currentDocument?.docId === document.docId
                        ? 'border-cyan-500/40 bg-cyan-500/[0.06]'
                        : 'border-border hover:bg-muted/40',
                    )}
                    onClick={() => void openDocument(document.docId)}
                  >
                    <p className="truncate text-[10px] font-medium">{document.title}</p>
                    <p className="mt-1 text-[9px] text-muted-foreground">
                      {document.rowCount} 行 × {document.columnCount} 列 · v{document.version}
                    </p>
                  </button>
                ))}
              </div>
            )}
          </aside>

          <div className="min-w-0 space-y-3">
            <article className="rounded-xl border border-border bg-background p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  placeholder="文档标题"
                  aria-label="文档标题"
                  className="h-8 min-w-44 flex-1 text-[11px]"
                  maxLength={300}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 text-[10px]"
                  disabled={documentAction !== null}
                  onClick={() => void validateCurrentTable()}
                >
                  {documentAction === 'validate'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <ShieldCheck className="h-3.5 w-3.5" />}
                  sidecar 校验
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="h-8 text-[10px]"
                  disabled={documentAction !== null}
                  onClick={() => void saveDocument()}
                >
                  {documentAction === 'save'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Save className="h-3.5 w-3.5" />}
                  {currentDocument ? '更新文档' : '创建文档'}
                </Button>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px]"
                  onClick={() => {
                    setColumns((current) => [...current, `列${current.length + 1}`]);
                    setRows((current) => current.map((row) => [...row, '']));
                    setValidation(null);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  增加列
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-[10px]"
                  onClick={() => {
                    setRows((current) => [...current, [...columnTemplate]]);
                    setValidation(null);
                  }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  增加行
                </Button>
                <span className="ml-auto text-[9px] text-muted-foreground">
                  {rows.length} 行 × {columns.length} 列
                  {currentDocument ? ` · v${currentDocument.version}` : ' · 未保存'}
                </span>
              </div>

              <TableGrid
                columns={columns}
                rows={rows}
                onColumnsChange={(next) => {
                  setColumns(next);
                  setValidation(null);
                }}
                onRowsChange={(next) => {
                  setRows(next);
                  setValidation(null);
                }}
              />
            </article>

            {editorError ? <InlineError>{editorError}</InlineError> : null}
            {editorNotice ? (
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-[10px] text-emerald-700 dark:text-emerald-300">
                {editorNotice}
              </div>
            ) : null}
            {reviewImages.length && currentDocument ? (
              <div className="rounded-lg border border-cyan-500/20 bg-cyan-500/[0.05] p-3">
                <div className="flex items-start gap-2">
                  <FileImage className="mt-0.5 h-4 w-4 shrink-0 text-cyan-700 dark:text-cyan-300" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-medium text-cyan-800 dark:text-cyan-200">
                      人工复核：对照原图逐格检查列名、数值、单位和空白项
                    </p>
                    <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                      {reviewImages.map((item, index) => (
                        <figure key={item.id} className="w-24 shrink-0">
                          <img
                            src={item.previewUrl}
                            alt={`OCR 原图 ${index + 1}`}
                            className="h-20 w-24 rounded border border-border bg-background object-contain"
                          />
                          <figcaption className="mt-1 truncate text-[9px] text-muted-foreground">
                            {index + 1}. {item.file.name}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 text-[9px]"
                    onClick={() => {
                      clearReviewImages();
                      setEditorNotice('本次原图对照已结束；如有修订，请更新文档后再使用。');
                    }}
                  >
                    完成复核
                  </Button>
                </div>
              </div>
            ) : null}
            {warnings.length ? (
              <div className="rounded-lg border border-amber-500/20 bg-amber-500/[0.06] p-3">
                <p className="flex items-center gap-1.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {warnings.length} 条复核提示
                </p>
                <ul className="mt-1.5 list-disc space-y-1 pl-4 text-[9px] leading-4 text-muted-foreground">
                  {warnings.map((warning) => <li key={warning}>{warning}</li>)}
                </ul>
              </div>
            ) : null}
            {validation ? (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-[10px] text-emerald-700 dark:text-emerald-300">
                <ShieldCheck className="h-4 w-4" />
                <span className="mr-auto">
                  已收到真实 sidecar 校验结果
                  {validation.formulaInjectionProtection ? '，公式注入防护已报告启用。' : '；尚未报告公式注入防护。'}
                </span>
              </div>
            ) : null}
            {currentDocument ? (
              <div className="flex flex-wrap gap-2 rounded-xl border border-border bg-background p-3">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-8 flex-1 text-[10px]"
                  disabled={documentAction !== null}
                  onClick={() => void downloadCsv()}
                >
                  {documentAction === 'csv'
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    : <Download className="h-3.5 w-3.5" />}
                  从后端下载安全 CSV
                </Button>
                {!deleteConfirmation ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 text-[10px] text-destructive"
                    disabled={documentAction !== null}
                    onClick={() => setDeleteConfirmation(true)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    删除文档
                  </Button>
                ) : (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="h-8 text-[10px]"
                      onClick={() => setDeleteConfirmation(false)}
                    >
                      取消
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      className="h-8 text-[10px]"
                      disabled={documentAction !== null}
                      onClick={() => void removeDocument()}
                    >
                      {documentAction === 'delete'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        : <Trash2 className="h-3.5 w-3.5" />}
                      确认删除
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </section>
      )}
    </div>
  );
}

function BackendStatus({
  status,
  error,
}: {
  status: TableBackendStatus | null;
  error: string;
}) {
  if (error) {
    return <InlineError>{error}</InlineError>;
  }
  if (!status) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-[10px] text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        正在读取 /api/medical 能力…
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-[10px]">
      <StatusPill ready={status.sidecarAvailable} label="Sidecar" />
      <StatusPill ready={status.tableAvailable} label="表格解析" reason={status.tableReason} />
      <StatusPill ready={status.documentStorageAvailable} label="文档存储" />
      <span className="ml-auto text-muted-foreground">
        {status.directOcrGenerationAvailable
          ? '一键 OCR 已就绪'
          : '一键 OCR 未就绪；调用时会返回真实错误'}
      </span>
    </div>
  );
}

function StatusPill({
  ready,
  label,
  reason,
}: {
  ready: boolean | null;
  label: string;
  reason?: string;
}) {
  return (
    <span
      className={cn(
        'rounded-full px-2 py-1',
        ready === true
          ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
          : ready === false
            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
            : 'bg-muted text-muted-foreground',
      )}
      title={reason}
    >
      {label} · {ready === true ? '可用' : ready === false ? '不可用' : '未报告'}
    </span>
  );
}

function PageButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[10px] transition-colors',
        active ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function StepNumber({ value }: { value: number }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-500/10 text-[11px] font-semibold text-cyan-700 dark:text-cyan-300">
      {value}
    </span>
  );
}

function TableGrid({
  columns,
  rows,
  onColumnsChange,
  onRowsChange,
}: {
  columns: string[];
  rows: TableCell[][];
  onColumnsChange: (columns: string[]) => void;
  onRowsChange: (rows: TableCell[][]) => void;
}) {
  return (
    <div className="mt-3 max-h-[390px] overflow-auto rounded-lg border border-border">
      <table className="min-w-full border-collapse text-[10px]">
        <thead className="sticky top-0 z-10 bg-muted">
          <tr>
            {columns.map((column, columnIndex) => (
              <th key={`column-${columnIndex}`} className="min-w-32 border-b border-r border-border p-1.5">
                <div className="flex items-center gap-1">
                  <Input
                    value={column}
                    aria-label={`第 ${columnIndex + 1} 列名称`}
                    onChange={(event) => onColumnsChange(columns.map(
                      (item, index) => index === columnIndex ? event.target.value : item,
                    ))}
                    className="h-7 min-w-24 bg-background px-2 text-[10px] font-semibold"
                  />
                  {columns.length > 1 ? (
                    <button
                      type="button"
                      aria-label={`删除第 ${columnIndex + 1} 列`}
                      onClick={() => {
                        onColumnsChange(columns.filter((_, index) => index !== columnIndex));
                        onRowsChange(rows.map((row) => row.filter((_, index) => index !== columnIndex)));
                      }}
                      className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  ) : null}
                </div>
              </th>
            ))}
            <th className="w-10 border-b border-border bg-muted" />
          </tr>
        </thead>
        <tbody>
          {rows.length ? rows.map((row, rowIndex) => (
            <tr key={`row-${rowIndex}`} className="odd:bg-muted/20">
              {columns.map((_, columnIndex) => (
                <td key={`cell-${rowIndex}-${columnIndex}`} className="border-b border-r border-border p-1.5">
                  <Input
                    value={displayCell(row[columnIndex])}
                    aria-label={`第 ${rowIndex + 1} 行第 ${columnIndex + 1} 列`}
                    onChange={(event) => onRowsChange(rows.map(
                      (item, index) => index === rowIndex
                        ? item.map((cell, cellIndex) => (
                          cellIndex === columnIndex ? event.target.value : cell
                        ))
                        : item,
                    ))}
                    className="h-7 min-w-24 border-transparent bg-transparent px-2 text-[10px] focus:border-border"
                  />
                </td>
              ))}
              <td className="border-b border-border p-1.5">
                <button
                  type="button"
                  aria-label={`删除第 ${rowIndex + 1} 行`}
                  onClick={() => onRowsChange(rows.filter((_, index) => index !== rowIndex))}
                  className="flex h-7 w-7 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </td>
            </tr>
          )) : (
            <tr>
              <td colSpan={columns.length + 1} className="p-6 text-center text-[10px] text-muted-foreground">
                当前表格没有数据行，可点击“增加行”。
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StateMessage({
  icon,
  tone = 'muted',
  children,
}: {
  icon: React.ReactElement;
  tone?: 'muted' | 'error';
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-3 py-6 text-center text-[10px]',
      tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
    )}>
      {icon}
      {children}
    </div>
  );
}

function InlineError({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn(
      'rounded-lg border border-destructive/20 bg-destructive/[0.06] px-3 py-2 text-[10px] leading-4 text-destructive',
      className,
    )}>
      {children}
    </div>
  );
}

function isSupportedOcrImage(file: File): boolean {
  return ocrImageMimeType(file) !== null;
}

function ocrImageMimeType(file: File): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const declared = file.type.toLowerCase();
  if (declared === 'image/jpeg' || declared === 'image/png' || declared === 'image/webp') {
    return declared;
  }
  if (declared) return null;
  if (/\.jpe?g$/iu.test(file.name)) return 'image/jpeg';
  if (/\.png$/iu.test(file.name)) return 'image/png';
  if (/\.webp$/iu.test(file.name)) return 'image/webp';
  return null;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = typeof reader.result === 'string' ? reader.result : '';
      const separator = value.indexOf(',');
      if (separator < 0 || !value.slice(separator + 1)) {
        reject(new Error(`${file.name} 读取失败。`));
        return;
      }
      resolve(value.slice(separator + 1));
    };
    reader.onerror = () => reject(new Error(`${file.name} 读取失败。`));
    reader.onabort = () => reject(new Error(`${file.name} 读取已取消。`));
    reader.readAsDataURL(file);
  });
}

function displayCell(value: TableCell | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function safeDownloadName(value: string): string {
  const normalized = value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '_').slice(0, 80);
  return normalized || 'medical-table';
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
