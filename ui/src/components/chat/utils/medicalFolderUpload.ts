/** Medical multi-source folder collection for chat attachments (301-aligned). */

export const MEDICAL_ATTACHMENT_EXTENSIONS = new Set([
  'cda', 'xml', 'xml1', 'json', 'txt', 'md', 'markdown', 'pdf',
  'png', 'jpg', 'jpeg', 'bmp',
  'dcm', 'dicom',
  'ecg', 'wfdb', 'hea', 'dat', 'atr', 'qrs', 'edf', 'scp',
]);

export const MEDICAL_FOLDER_MAX_FILES = 64;
export const MEDICAL_FOLDER_MAX_DEPTH = 8;
export const MEDICAL_FOLDER_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MEDICAL_FOLDER_MAX_BATCH_BYTES = 256 * 1024 * 1024;
/** Safety cap while walking huge trees; exceeding this fails the hard count check. */
export const MEDICAL_FOLDER_SCAN_CAP = 512;

export type MedicalFolderEntry = {
  file: File;
  relativePath: string;
};

export type CollectMedicalFolderResult = {
  entries: MedicalFolderEntry[];
  hasDirectory: boolean;
  rootName: string | null;
  /** Soft warnings only (unsupported types, deep paths). */
  warnings: string[];
  unsupportedCount: number;
  /** True when more medical files existed than MEDICAL_FOLDER_SCAN_CAP. */
  scanOverflow: boolean;
};

export type AttachmentBatchValidation = {
  ok: boolean;
  errors: string[];
};

export function formatSizeMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

export function totalFileBytes(files: ArrayLike<{ size: number }> | { size: number }[]): number {
  return Array.from(files as ArrayLike<{ size: number }>).reduce(
    (sum, file) => sum + (typeof file.size === 'number' ? file.size : 0),
    0,
  );
}

/**
 * Hard limits for composer / Files uploads.
 * Count and batch size are evaluated against existing + incoming (cumulative).
 * Any single incoming file over the per-file cap fails the whole batch.
 */
export function validateAttachmentBatch(options: {
  existingCount?: number;
  existingBytes?: number;
  incoming: Array<{ name?: string; size: number }>;
  scanOverflow?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  maxBatchBytes?: number;
}): AttachmentBatchValidation {
  const maxFiles = options.maxFiles ?? MEDICAL_FOLDER_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? MEDICAL_FOLDER_MAX_FILE_BYTES;
  const maxBatchBytes = options.maxBatchBytes ?? MEDICAL_FOLDER_MAX_BATCH_BYTES;
  const existingCount = Math.max(0, options.existingCount ?? 0);
  const existingBytes = Math.max(0, options.existingBytes ?? 0);
  const incoming = options.incoming || [];
  const errors: string[] = [];

  if (options.scanOverflow) {
    errors.push(
      `可选医学文件过多（扫描超过 ${MEDICAL_FOLDER_SCAN_CAP} 个），单次最多 ${maxFiles} 个，请缩小范围后重试`,
    );
  }

  const totalCount = existingCount + incoming.length;
  if (totalCount > maxFiles) {
    errors.push(
      `文件数量 ${totalCount} 超过上限 ${maxFiles}`
        + (existingCount > 0 ? `（已选 ${existingCount} 个，本次拟添加 ${incoming.length} 个）` : ''),
    );
  }

  const oversized = incoming.filter((file) => typeof file.size === 'number' && file.size > maxFileBytes);
  if (oversized.length > 0) {
    const names = oversized
      .slice(0, 3)
      .map((file) => `“${safeFilename(file.name || '未命名文件')}”`)
      .join('、');
    const more = oversized.length > 3 ? ` 等 ${oversized.length} 个` : '';
    errors.push(
      `单文件大小超过 ${formatSizeMb(maxFileBytes)}MB：${names}${more}`,
    );
  }

  const incomingBytes = totalFileBytes(incoming);
  const totalBytes = existingBytes + incomingBytes;
  if (totalBytes > maxBatchBytes) {
    errors.push(
      `附件总大小 ${formatSizeMb(totalBytes)}MB 超过上限 ${formatSizeMb(maxBatchBytes)}MB`
        + (existingBytes > 0
          ? `（已选 ${formatSizeMb(existingBytes)}MB，本次 ${formatSizeMb(incomingBytes)}MB）`
          : ''),
    );
  }

  return { ok: errors.length === 0, errors };
}

export function formatAttachmentLimitErrors(errors: string[]): string {
  if (errors.length === 0) return '';
  return `上传失败：${errors.join('；')}。请减少文件数量、去掉超大文件或拆成多批后再上传。`;
}

/** Ensure server/network failure copy also leads with 上传失败. */
export function ensureUploadFailedMessage(message: string): string {
  const text = String(message || '').trim();
  if (!text) return '上传失败：请稍后重试。';
  if (text.startsWith('上传失败')) return text;
  return `上传失败：${text}`;
}

function safeFilename(value: string): string {
  const parts = String(value || '').split(/[\\/]/);
  return parts[parts.length - 1] || '未命名文件';
}

export function fileExtension(filename: string): string {
  const name = safeFilename(filename).toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : '';
}

export function isMedicalAttachmentFilename(filename: string): boolean {
  return MEDICAL_ATTACHMENT_EXTENSIONS.has(fileExtension(filename));
}

export function normalizeRelativePath(value: string, fallbackName: string): string {
  const parts = String(value || fallbackName || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part && part !== '.' && part !== '..');
  return parts.join('/') || safeFilename(fallbackName);
}

function joinRelativePath(parentPath: string, name: string): string {
  return normalizeRelativePath(parentPath ? `${parentPath}/${name}` : name, name);
}

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (success: (file: File) => void, error?: (err: DOMException) => void) => void;
  createReader?: () => {
    readEntries: (
      success: (entries: FileSystemEntryLike[]) => void,
      error?: (err: DOMException) => void,
    ) => void;
  };
};

type DataTransferItemWithEntry = DataTransferItem & {
  webkitGetAsEntry?: () => FileSystemEntryLike | null;
};

function readDirectoryEntries(reader: {
  readEntries: (
    success: (entries: FileSystemEntryLike[]) => void,
    error?: (err: DOMException) => void,
  ) => void;
}): Promise<FileSystemEntryLike[]> {
  return new Promise((resolve, reject) => {
    try {
      reader.readEntries(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

function readFileEntry(entry: FileSystemEntryLike): Promise<File> {
  return new Promise((resolve, reject) => {
    if (typeof entry.file !== 'function') {
      reject(new Error('Not a file entry'));
      return;
    }
    try {
      entry.file(resolve, reject);
    } catch (error) {
      reject(error);
    }
  });
}

type CollectionState = {
  entries: MedicalFolderEntry[];
  warnings: string[];
  warningKeys: Set<string>;
  unsupportedCount: number;
  scanOverflow: boolean;
  hasDirectory: boolean;
  maxDepth: number;
  scanCap: number;
};

function addWarning(state: CollectionState, key: string, text: string) {
  if (state.warningKeys.has(key)) return;
  state.warningKeys.add(key);
  if (state.warnings.length < 8) state.warnings.push(text);
}

function addCollectedFile(state: CollectionState, file: File, relativePath: string) {
  const normalized = normalizeRelativePath(relativePath, file.name);
  const directoryDepth = normalized.split('/').length - 1;
  if (directoryDepth > state.maxDepth) {
    addWarning(state, 'depth-limit', `目录层级超过 ${state.maxDepth} 层，过深内容已跳过`);
    return;
  }
  if (!isMedicalAttachmentFilename(normalized)) {
    state.unsupportedCount += 1;
    return;
  }
  if (state.entries.length >= state.scanCap) {
    state.scanOverflow = true;
    return;
  }
  state.entries.push({ file, relativePath: normalized });
}

async function walkFileSystemEntry(
  entry: FileSystemEntryLike,
  parentPath: string,
  state: CollectionState,
): Promise<void> {
  const relativePath = joinRelativePath(parentPath, entry.name);
  if (entry.isFile) {
    try {
      const file = await readFileEntry(entry);
      addCollectedFile(state, file, relativePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      addWarning(state, `file:${relativePath}`, `无法读取文件“${safeFilename(relativePath)}”：${message}`);
    }
    return;
  }

  if (!entry.isDirectory || typeof entry.createReader !== 'function') {
    addWarning(state, `entry:${relativePath}`, `无法识别拖入项目“${safeFilename(relativePath)}”`);
    return;
  }

  state.hasDirectory = true;
  const directoryDepth = relativePath.split('/').length;
  if (directoryDepth > state.maxDepth) {
    addWarning(state, 'depth-limit', `目录层级超过 ${state.maxDepth} 层，过深内容已跳过`);
    return;
  }

  const reader = entry.createReader();
  while (!state.scanOverflow) {
    const children = await readDirectoryEntries(reader);
    if (children.length === 0) break;
    for (const child of children) {
      await walkFileSystemEntry(child, relativePath, state);
      if (state.scanOverflow) break;
    }
  }
}

function inferRootName(entries: MedicalFolderEntry[]): string | null {
  if (entries.length === 0) return null;
  const first = entries[0].relativePath.split('/')[0];
  if (!first) return null;
  const allShare = entries.every((entry) => entry.relativePath === first || entry.relativePath.startsWith(`${first}/`));
  return allShare ? first : null;
}

function createCollectionState(hasDirectory: boolean): CollectionState {
  return {
    entries: [],
    warnings: [],
    warningKeys: new Set(),
    unsupportedCount: 0,
    scanOverflow: false,
    hasDirectory,
    maxDepth: MEDICAL_FOLDER_MAX_DEPTH,
    scanCap: MEDICAL_FOLDER_SCAN_CAP,
  };
}

function finalizeCollection(state: CollectionState): CollectMedicalFolderResult {
  if (state.unsupportedCount > 0) {
    addWarning(state, 'unsupported', `已跳过 ${state.unsupportedCount} 个暂不支持的文件`);
  }
  return {
    entries: state.entries,
    hasDirectory: state.hasDirectory,
    rootName: inferRootName(state.entries),
    warnings: state.warnings,
    unsupportedCount: state.unsupportedCount,
    scanOverflow: state.scanOverflow,
  };
}

/** Normalize a FileList / File[] from webkitdirectory or multi-file picker. */
export function collectMedicalFilesFromFileList(
  files: ArrayLike<File> | File[],
  options?: { treatAsFolder?: boolean },
): CollectMedicalFolderResult {
  const list = Array.from(files || []);
  const state = createCollectionState(Boolean(options?.treatAsFolder));

  for (const file of list) {
    const withPath = file as File & { webkitRelativePath?: string };
    const relative = withPath.webkitRelativePath || file.name;
    if (withPath.webkitRelativePath) state.hasDirectory = true;
    addCollectedFile(state, file, relative);
  }

  return finalizeCollection(state);
}

/** Collect medical files from a drag-and-drop DataTransfer (supports folders). */
export async function collectMedicalFilesFromDataTransfer(
  dataTransfer: DataTransfer | null | undefined,
): Promise<CollectMedicalFolderResult> {
  const state = createCollectionState(false);

  const items = Array.from(dataTransfer?.items || []) as DataTransferItemWithEntry[];
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .map((entry) => entry as unknown as FileSystemEntryLike);

  if (entries.length > 0) {
    for (const entry of entries) {
      await walkFileSystemEntry(entry, '', state);
    }
  } else {
    return collectMedicalFilesFromFileList(Array.from(dataTransfer?.files || []));
  }

  return finalizeCollection(state);
}

export function stripCommonRootPrefix(relativePaths: string[]): {
  rootName: string | null;
  stripped: string[];
} {
  if (relativePaths.length === 0) return { rootName: null, stripped: [] };
  const partsList = relativePaths.map((path) => path.split('/').filter(Boolean));
  if (partsList.some((parts) => parts.length === 0)) {
    return { rootName: null, stripped: relativePaths };
  }
  const first = partsList[0][0];
  const allShare = partsList.every((parts) => parts[0] === first);
  if (!allShare || partsList.every((parts) => parts.length === 1)) {
    return { rootName: allShare ? first : null, stripped: relativePaths };
  }
  return {
    rootName: first,
    stripped: partsList.map((parts) => parts.slice(1).join('/')),
  };
}
