import { describe, expect, it } from 'vitest';
import {
  SPREADSHEET_READONLY_BLOCKED_COMMAND_IDS,
  SPREADSHEET_UNIVER_SHEETS_UI_CONFIG,
  SPREADSHEET_UNIVER_UI_CONFIG,
  shouldBlockSpreadsheetPreviewCommand,
} from './spreadsheetUniverConfig';

describe('spreadsheet Univer focus configuration', () => {
  it('protects surrounding DOM focus while preserving internal sheet focus for wheel scrolling', () => {
    expect(SPREADSHEET_UNIVER_UI_CONFIG.disableAutoFocus).toBe(true);
    expect('disableAutoFocus' in SPREADSHEET_UNIVER_SHEETS_UI_CONFIG).toBe(false);
  });

  it('keeps the interactive preview read-only, including column resize', () => {
    expect(SPREADSHEET_UNIVER_SHEETS_UI_CONFIG.disableEdit).toBe(true);
    expect(SPREADSHEET_READONLY_BLOCKED_COMMAND_IDS.size).toBeGreaterThan(0);
    expect(shouldBlockSpreadsheetPreviewCommand('sheet.command.set-col-width')).toBe(true);
    expect(shouldBlockSpreadsheetPreviewCommand('sheet.command.paste')).toBe(true);
    expect(shouldBlockSpreadsheetPreviewCommand('sheet.command.set-range-values')).toBe(false);
    expect(shouldBlockSpreadsheetPreviewCommand('sheet.command.copy')).toBe(false);
  });
});
