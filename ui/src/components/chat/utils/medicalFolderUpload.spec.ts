// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { collectMedicalFilesFromFileList } from './medicalFolderUpload';

describe('folder upload collection', () => {
  it('keeps nested paths for accepted files inside a picked folder', () => {
    const report = new File(['note'], 'report.pdf', { type: 'application/pdf' });
    const scan = new File(['data'], 'scan.dcm', { type: 'application/dicom' });
    const unsupported = new File(['data'], 'debug.exe');
    Object.defineProperty(report, 'webkitRelativePath', { value: 'case-001/reports/report.pdf' });
    Object.defineProperty(scan, 'webkitRelativePath', { value: 'case-001/images/scan.dcm' });
    Object.defineProperty(unsupported, 'webkitRelativePath', { value: 'case-001/debug.exe' });

    const result = collectMedicalFilesFromFileList([report, scan, unsupported], { treatAsFolder: true });
    expect(result.hasDirectory).toBe(true);
    expect(result.rootName).toBe('case-001');
    expect(result.entries.map((entry) => entry.relativePath)).toEqual([
      'case-001/reports/report.pdf',
      'case-001/images/scan.dcm',
    ]);
    expect(result.unsupportedCount).toBe(1);
  });
});
