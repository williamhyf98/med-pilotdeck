import { describe, expect, it } from 'vitest';
import { isBinaryFile, isDicomFile, isImageFile, isNiftiFile, isOfficeFile, isSpreadsheetFile } from './binaryFile';

describe('NIfTI file recognition', () => {
  it.each(['abdomen.nii.gz', 'CHEST.NII.GZ', 'volume.nii', 'volume.nii(2).gz', 'volume(2).nii.gz'])(
    'opens %s as a binary image preview',
    (fileName) => {
      expect(isNiftiFile(fileName)).toBe(true);
      expect(isBinaryFile(fileName)).toBe(true);
    },
  );

  it('keeps unrelated gzip archives out of the image viewer', () => {
    expect(isNiftiFile('notes.tar.gz')).toBe(false);
    expect(isNiftiFile('notes.nii(2).zip')).toBe(false);
  });
});

describe('DICOM file recognition', () => {
  it.each(['scan.dcm', 'scan.DICOM', 'slice.ima'])(
    'treats %s as a DICOM binary preview',
    (fileName) => {
      expect(isDicomFile(fileName)).toBe(true);
      expect(isBinaryFile(fileName)).toBe(true);
    },
  );

  it('does not treat ordinary images as DICOM', () => {
    expect(isDicomFile('scan.png')).toBe(false);
  });
});

describe('WPS Office file recognition', () => {
  it.each(['proposal.wps', 'budget.et', 'briefing.dps'])(
    'treats %s as an Office binary that uses converted preview',
    (fileName) => {
      expect(isOfficeFile(fileName)).toBe(true);
      expect(isBinaryFile(fileName)).toBe(true);
    },
  );
});

describe('spreadsheet file recognition', () => {
  it.each(['report.xlsx', 'legacy.XLS', 'budget.et', 'sheet.ods'])(
    'treats %s as a spreadsheet preview',
    (fileName) => {
      expect(isSpreadsheetFile(fileName)).toBe(true);
    },
  );

  it.each(['report.docx', 'slides.pptx', 'notes.pdf'])(
    'does not treat %s as a spreadsheet preview',
    (fileName) => {
      expect(isSpreadsheetFile(fileName)).toBe(false);
    },
  );
});

describe('diagram image recognition', () => {
  it('treats SVG diagrams as binary image previews', () => {
    expect(isImageFile('救治流程.svg')).toBe(true);
    expect(isBinaryFile('救治流程.svg')).toBe(true);
  });
});
