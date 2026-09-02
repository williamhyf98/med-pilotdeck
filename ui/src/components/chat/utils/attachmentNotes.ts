import type { ChatAttachment } from '../types/types';
import {
  DOCUMENT_SELECTION_ATTACHMENT_KIND,
  parseDocumentSelectionPromptBlock,
  type DocumentSelectionReference,
} from '../../../types/documentSelection';
import {
  CONTENT_REFERENCE_ATTACHMENT_KIND,
  parseContentReferencePromptBlock,
  type ContentReference,
} from '../../../types/contentReference';

const ATTACHMENT_NOTE_MARKER = '[Files attached by user and available for reading in the project:]';
const ATTACHMENT_NOTE_END_MARKER = '[End files attached by user]';
const MEDICAL_FOLDER_NOTE_MARKER = '[Medical materials folder attached — parse with med_parse_medical on the folder path:]';
const MEDICAL_FOLDER_NOTE_END_MARKER = '[End medical materials folder]';
// Older transcripts have no end marker. Their next canonical text block may
// be concatenated directly onto the final path during history projection.
const LEGACY_ATTACHMENT_NOTE_TERMINATORS = [
  ATTACHMENT_NOTE_END_MARKER,
  MEDICAL_FOLDER_NOTE_END_MARKER,
  MEDICAL_FOLDER_NOTE_MARKER,
  '[Attachment diagnostics]',
  '[Registered attachment files in this session:]',
  '[PDF attachment:',
  '<attachment ',
];

type AttachmentPathNoteFile = {
  name: string;
  path: string;
  relativePath?: string;
};

export type MedicalFolderPathNote = {
  folderPath: string;
  rootName?: string | null;
  fileCount?: number;
  sampleRelativePaths?: string[];
};

export function buildMedicalFolderPathNote(folder: MedicalFolderPathNote): string {
  if (!folder?.folderPath) return '';
  const lines = [
    `- folder: ${folder.folderPath}`,
  ];
  if (folder.rootName) lines.push(`- name: ${folder.rootName}`);
  if (typeof folder.fileCount === 'number') lines.push(`- files: ${folder.fileCount}`);
  if (Array.isArray(folder.sampleRelativePaths) && folder.sampleRelativePaths.length > 0) {
    lines.push('- sample:');
    for (const sample of folder.sampleRelativePaths.slice(0, 8)) {
      lines.push(`  - ${sample}`);
    }
  }
  lines.push(
    '- instruction: Call mcp__med-tools__med_parse_medical with path set to the folder above (not individual files). Do not use read_file on DICOM/PDF/CDA/ECG binaries. For pure interpretation use continuation_mode="terminal" (default) and do not rewrite a non-empty report. If this parse is only one step of a larger planned task (case report / HTML / care plan), use continuation_mode="material" and continue unfinished steps after the streamed report.',
  );
  return `\n\n${MEDICAL_FOLDER_NOTE_MARKER}\n${lines.join('\n')}\n${MEDICAL_FOLDER_NOTE_END_MARKER}\n`;
}

export function buildAttachmentPathNote(
  files: AttachmentPathNoteFile[],
  options?: { medicalFolder?: MedicalFolderPathNote | null },
): string {
  const folderNote = options?.medicalFolder
    ? buildMedicalFolderPathNote(options.medicalFolder)
    : '';
  if (files.length === 0) return folderNote;

  const lines = files.map((file) => {
    if (file.relativePath && file.relativePath !== file.name) {
      return `- ${file.name} (${file.relativePath}): ${file.path}`;
    }
    return `- ${file.name}: ${file.path}`;
  });
  return `${folderNote}\n\n${ATTACHMENT_NOTE_MARKER}\n${lines.join('\n')}\n${ATTACHMENT_NOTE_END_MARKER}\n`;
}

function sliceBeforeFirstMarker(value: string, markers: string[]): string {
  let endIndex = value.length;
  for (const marker of markers) {
    const markerIndex = value.indexOf(marker);
    if (markerIndex >= 0 && markerIndex < endIndex) {
      endIndex = markerIndex;
    }
  }
  return value.slice(0, endIndex);
}

function inferAttachmentMimeType(name: string, filePath: string): string | undefined {
  const source = `${name} ${filePath}`.toLowerCase();
  if (source.endsWith('.pdf')) return 'application/pdf';
  if (source.endsWith('.doc')) return 'application/msword';
  if (source.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (source.endsWith('.xls')) return 'application/vnd.ms-excel';
  if (source.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (source.endsWith('.ppt')) return 'application/vnd.ms-powerpoint';
  if (source.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (source.endsWith('.txt')) return 'text/plain';
  if (source.endsWith('.md') || source.endsWith('.markdown')) return 'text/markdown';
  if (source.endsWith('.json')) return 'application/json';
  if (source.endsWith('.csv')) return 'text/csv';
  if (source.endsWith('.xml') || source.endsWith('.cda') || source.endsWith('.xml1')) return 'application/xml';
  if (source.endsWith('.dcm') || source.endsWith('.dicom')) return 'application/dicom';
  if (source.endsWith('.png')) return 'image/png';
  if (source.endsWith('.jpg') || source.endsWith('.jpeg')) return 'image/jpeg';
  if (source.endsWith('.gif')) return 'image/gif';
  if (source.endsWith('.webp')) return 'image/webp';
  if (source.endsWith('.svg') || source.endsWith('.svgz')) return 'image/svg+xml';
  if (source.endsWith('.bmp')) return 'image/bmp';
  return undefined;
}

function isImageAttachmentMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.toLowerCase().startsWith('image/'));
}

export function parseUserAttachmentNote(content: unknown): {
  content: string;
  attachments: ChatAttachment[];
} {
  const parsedContentReferences = parseContentReferencePromptBlock(content);
  const parsedSelections = parseDocumentSelectionPromptBlock(parsedContentReferences.content);
  let text = parsedSelections.content;
  const selectionAttachments = [
    ...parsedSelections.references.map(documentSelectionToAttachment),
    ...parsedContentReferences.references.map(contentReferenceToAttachment),
  ];

  const folderMarkerIndex = text.indexOf(MEDICAL_FOLDER_NOTE_MARKER);
  if (folderMarkerIndex >= 0) {
    const before = text.slice(0, folderMarkerIndex);
    const afterMarker = text.slice(folderMarkerIndex + MEDICAL_FOLDER_NOTE_MARKER.length);
    const endIndex = afterMarker.indexOf(MEDICAL_FOLDER_NOTE_END_MARKER);
    const remainder = endIndex >= 0
      ? afterMarker.slice(endIndex + MEDICAL_FOLDER_NOTE_END_MARKER.length)
      : '';
    text = `${before}${remainder}`.trimEnd();
  }

  const markerIndex = text.indexOf(ATTACHMENT_NOTE_MARKER);
  if (markerIndex < 0) {
    return { content: text, attachments: selectionAttachments };
  }

  const visibleContent = text.slice(0, markerIndex).trimEnd();
  const note = sliceBeforeFirstMarker(
    text.slice(markerIndex + ATTACHMENT_NOTE_MARKER.length),
    LEGACY_ATTACHMENT_NOTE_TERMINATORS,
  );
  const attachments: ChatAttachment[] = [];

  for (const rawLine of note.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('- ')) continue;
    const separator = line.indexOf(': ');
    if (separator < 0) continue;

    const name = line.slice(2, separator).trim();
    const filePath = line.slice(separator + 2).trim();
    if (!name || !filePath) continue;
    const mimeType = inferAttachmentMimeType(name, filePath);
    if (isImageAttachmentMime(mimeType)) continue;

    attachments.push({
      name,
      path: filePath,
      mimeType,
    });
  }

  return { content: visibleContent, attachments: [...attachments, ...selectionAttachments] };
}

function attachmentIdentity(attachment: ChatAttachment): string {
  const kind = attachment.kind || 'file';
  const filePath = attachment.path || attachment.filePath || '';

  if (kind === DOCUMENT_SELECTION_ATTACHMENT_KIND) {
    return [
      kind,
      filePath,
      attachment.createdAt || '',
      attachment.occurrenceIndex ?? '',
    ].join('\0');
  }

  if (kind === CONTENT_REFERENCE_ATTACHMENT_KIND) {
    return [
      kind,
      attachment.contentReference?.id || '',
      filePath,
      attachment.createdAt || '',
    ].join('\0');
  }

  return [kind, filePath || attachment.name].join('\0');
}

export function mergeUserAttachments(
  preferred: ChatAttachment[],
  fallback: ChatAttachment[],
): ChatAttachment[] {
  const merged: ChatAttachment[] = [];
  const seen = new Set<string>();

  for (const attachment of [...preferred, ...fallback]) {
    const identity = attachmentIdentity(attachment);
    if (seen.has(identity)) continue;
    seen.add(identity);
    merged.push(attachment);
  }

  return merged;
}

function contentReferenceToAttachment(reference: ContentReference): ChatAttachment {
  return {
    kind: CONTENT_REFERENCE_ATTACHMENT_KIND,
    name: reference.source.fileName,
    path: reference.source.relativePath,
    fileName: reference.source.fileName,
    filePath: reference.source.relativePath,
    contentReference: reference,
    createdAt: reference.createdAt,
    mimeType: 'application/vnd.pilotdeck.content-reference+json',
  };
}

function documentSelectionToAttachment(reference: DocumentSelectionReference): ChatAttachment {
  return {
    kind: DOCUMENT_SELECTION_ATTACHMENT_KIND,
    name: reference.fileName,
    path: reference.filePath,
    fileName: reference.fileName,
    filePath: reference.filePath,
    source: reference.source,
    pageNumbers: reference.pageNumbers,
    selectedText: reference.selectedText,
    surroundingText: reference.surroundingText,
    occurrenceIndex: reference.occurrenceIndex,
    createdAt: reference.createdAt,
    truncated: reference.truncated,
    mimeType: 'application/vnd.pilotdeck.document-selection',
  };
}
