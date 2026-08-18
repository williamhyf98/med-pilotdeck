import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MEDICAL_FOLDER_MAX_BATCH_BYTES,
  MEDICAL_FOLDER_MAX_FILE_BYTES,
  collectMedicalFilesFromFileList,
  ensureUploadFailedMessage,
  formatAttachmentLimitErrors,
  validateAttachmentBatch,
} from '../../ui/src/components/chat/utils/medicalFolderUpload.ts';

function fakeFile(name: string, size: number): File {
  return {
    name,
    size,
    type: 'application/octet-stream',
  } as File;
}

test('validateAttachmentBatch accepts within limits', () => {
  const result = validateAttachmentBatch({
    existingCount: 2,
    existingBytes: 1024,
    incoming: [
      { name: 'a.png', size: 2048 },
      { name: 'b.pdf', size: 4096 },
    ],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test('validateAttachmentBatch hard-fails on cumulative file count', () => {
  const result = validateAttachmentBatch({
    existingCount: 60,
    existingBytes: 0,
    incoming: Array.from({ length: 5 }, (_, index) => ({
      name: `extra-${index}.png`,
      size: 10,
    })),
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('；'), /文件数量 65 超过上限 64/);
  assert.match(formatAttachmentLimitErrors(result.errors), /上传失败：/);
  assert.match(formatAttachmentLimitErrors(result.errors), /请减少文件数量/);
});

test('ensureUploadFailedMessage prefixes once', () => {
  assert.equal(ensureUploadFailedMessage('网络错误'), '上传失败：网络错误');
  assert.equal(ensureUploadFailedMessage('上传失败：已有前缀'), '上传失败：已有前缀');
});

test('validateAttachmentBatch hard-fails on oversized single file', () => {
  const result = validateAttachmentBatch({
    incoming: [
      { name: 'ok.png', size: 1024 },
      { name: 'huge.pdf', size: MEDICAL_FOLDER_MAX_FILE_BYTES + 1 },
    ],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('；'), /单文件大小超过 64MB/);
  assert.match(result.errors.join('；'), /huge\.pdf/);
});

test('validateAttachmentBatch hard-fails on cumulative batch size', () => {
  const result = validateAttachmentBatch({
    existingCount: 1,
    existingBytes: MEDICAL_FOLDER_MAX_BATCH_BYTES - 10,
    incoming: [{ name: 'more.png', size: 20 }],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('；'), /附件总大小/);
});

test('collectMedicalFilesFromFileList soft-skips unsupported extensions', () => {
  const result = collectMedicalFilesFromFileList([
    fakeFile('note.txt', 12),
    fakeFile('secret.exe', 12),
    fakeFile('shot.png', 20),
  ]);
  assert.equal(result.entries.length, 2);
  assert.equal(result.unsupportedCount, 1);
  assert.ok(result.warnings.some((warning) => warning.includes('暂不支持')));
  assert.equal(result.scanOverflow, false);
});

test('collectMedicalFilesFromFileList keeps oversized files for hard validation', () => {
  const result = collectMedicalFilesFromFileList([
    fakeFile('ok.png', 100),
    fakeFile('big.dcm', MEDICAL_FOLDER_MAX_FILE_BYTES + 5),
  ]);
  assert.equal(result.entries.length, 2);
  const validation = validateAttachmentBatch({
    incoming: result.entries.map((entry) => ({
      name: entry.relativePath,
      size: entry.file.size,
    })),
  });
  assert.equal(validation.ok, false);
});
