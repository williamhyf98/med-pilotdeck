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

export type MedicalFolderEntry = {
  file: File;
  relativePath: string;
};

export type CollectMedicalFolderResult = {
  entries: MedicalFolderEntry[];
  hasDirectory: boolean;
  rootName: string | null;
  warnings: string[];
  unsupportedCount: number;
  overflowCount: number;
  oversizedCount: number;
};

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
  oversizedCount: number;
  hasDirectory: boolean;
  maxFiles: number;
  maxDepth: number;
  maxFileBytes: number;
  maxBatchBytes: number;
  batchBytes: number;
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
  if (file.size > state.maxFileBytes) {
    state.oversizedCount += 1;
    addWarning(
      state,
      `size:${normalized}`,
      `已跳过超大文件“${safeFilename(normalized)}”（单文件上限 ${Math.round(state.maxFileBytes / (1024 * 1024))}MB）`,
    );
    return;
  }
  if (state.batchBytes + file.size > state.maxBatchBytes) {
    addWarning(
      state,
      'batch-size',
      `单批总大小超过 ${Math.round(state.maxBatchBytes / (1024 * 1024))}MB，其余文件已跳过`,
    );
    return;
  }
  if (state.entries.length >= state.maxFiles) {
    addWarning(state, 'file-limit', `单批最多 ${state.maxFiles} 个医学文件，其余已跳过`);
    return;
  }
  state.entries.push({ file, relativePath: normalized });
  state.batchBytes += file.size;
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
  while (state.entries.length < state.maxFiles) {
    const children = await readDirectoryEntries(reader);
    if (children.length === 0) break;
    for (const child of children) {
      await walkFileSystemEntry(child, relativePath, state);
      if (state.entries.length >= state.maxFiles) break;
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

/** Normalize a FileList / File[] from webkitdirectory or multi-file picker. */
export function collectMedicalFilesFromFileList(
  files: ArrayLike<File> | File[],
  options?: { treatAsFolder?: boolean },
): CollectMedicalFolderResult {
  const list = Array.from(files || []);
  const state: CollectionState = {
    entries: [],
    warnings: [],
    warningKeys: new Set(),
    unsupportedCount: 0,
    oversizedCount: 0,
    hasDirectory: Boolean(options?.treatAsFolder),
    maxFiles: MEDICAL_FOLDER_MAX_FILES,
    maxDepth: MEDICAL_FOLDER_MAX_DEPTH,
    maxFileBytes: MEDICAL_FOLDER_MAX_FILE_BYTES,
    maxBatchBytes: MEDICAL_FOLDER_MAX_BATCH_BYTES,
    batchBytes: 0,
  };

  const beforeLimit = list.filter((file) => {
    const withPath = file as File & { webkitRelativePath?: string };
    const relative = withPath.webkitRelativePath || file.name;
    if (withPath.webkitRelativePath) state.hasDirectory = true;
    return true;
  });

  let overflowCount = 0;
  for (const file of beforeLimit) {
    const withPath = file as File & { webkitRelativePath?: string };
    const relative = withPath.webkitRelativePath || file.name;
    const before = state.entries.length;
    addCollectedFile(state, file, relative);
    if (before === state.entries.length && isMedicalAttachmentFilename(relative) && file.size <= state.maxFileBytes) {
      // skipped due to batch/file limit
      if (state.warningKeys.has('file-limit') || state.warningKeys.has('batch-size')) {
        overflowCount += 1;
      }
    }
  }

  if (state.unsupportedCount > 0) {
    addWarning(state, 'unsupported', `已跳过 ${state.unsupportedCount} 个暂不支持的文件`);
  }
  if (state.oversizedCount > 0) {
    addWarning(state, 'oversized-summary', `已跳过 ${state.oversizedCount} 个超大文件`);
  }

  return {
    entries: state.entries,
    hasDirectory: state.hasDirectory,
    rootName: inferRootName(state.entries),
    warnings: state.warnings,
    unsupportedCount: state.unsupportedCount,
    overflowCount,
    oversizedCount: state.oversizedCount,
  };
}

/** Collect medical files from a drag-and-drop DataTransfer (supports folders). */
export async function collectMedicalFilesFromDataTransfer(
  dataTransfer: DataTransfer | null | undefined,
): Promise<CollectMedicalFolderResult> {
  const state: CollectionState = {
    entries: [],
    warnings: [],
    warningKeys: new Set(),
    unsupportedCount: 0,
    oversizedCount: 0,
    hasDirectory: false,
    maxFiles: MEDICAL_FOLDER_MAX_FILES,
    maxDepth: MEDICAL_FOLDER_MAX_DEPTH,
    maxFileBytes: MEDICAL_FOLDER_MAX_FILE_BYTES,
    maxBatchBytes: MEDICAL_FOLDER_MAX_BATCH_BYTES,
    batchBytes: 0,
  };

  const items = Array.from(dataTransfer?.items || []) as DataTransferItemWithEntry[];
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntryLike => Boolean(entry));

  if (entries.length > 0) {
    for (const entry of entries) {
      await walkFileSystemEntry(entry, '', state);
    }
  } else {
    return collectMedicalFilesFromFileList(Array.from(dataTransfer?.files || []));
  }

  if (state.unsupportedCount > 0) {
    addWarning(state, 'unsupported', `已跳过 ${state.unsupportedCount} 个暂不支持的文件`);
  }
  if (state.oversizedCount > 0) {
    addWarning(state, 'oversized-summary', `已跳过 ${state.oversizedCount} 个超大文件`);
  }

  return {
    entries: state.entries,
    hasDirectory: state.hasDirectory,
    rootName: inferRootName(state.entries),
    warnings: state.warnings,
    unsupportedCount: state.unsupportedCount,
    overflowCount: state.warningKeys.has('file-limit') || state.warningKeys.has('batch-size')
      ? Math.max(0, state.unsupportedCount === 0 ? 1 : 0)
      : 0,
    oversizedCount: state.oversizedCount,
  };
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
