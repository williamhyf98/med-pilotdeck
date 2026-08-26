// Keep the workbench from taking DOM focus when a preview mounts. This protects
// surrounding inputs, such as the chat composer, without disabling sheet focus.
export const SPREADSHEET_UNIVER_UI_CONFIG = {
  header: false,
  toolbar: false,
  footer: false,
  contextMenu: false,
  headerMenu: false,
  disableAutoFocus: true,
} as const;

// Univer's wheel controller only scrolls while its internal FOCUSING_SHEET
// context is active, so sheet auto-focus must remain enabled here.
export const SPREADSHEET_UNIVER_SHEETS_UI_CONFIG = {
  formulaBar: false,
  footer: false,
  disableEdit: true,
  protectedRangeShadow: false,
} as const;

// Preview is view-only. Header-drag / F2 still emit these commands even when
// disableEdit is true, so the sheet runtime cancels them before they apply.
export const SPREADSHEET_READONLY_BLOCKED_COMMAND_IDS = new Set([
  'sheet.command.delta-column-width',
  'sheet.command.set-col-width',
  'sheet.command.delta-row-height',
  'sheet.command.set-row-height',
  'sheet.command.set-worksheet-col-is-auto-width',
  'sheet.command.set-worksheet-row-is-auto-height',
  'sheet.operation.set-cell-edit-visible',
  'sheet.operation.set-cell-edit-visible-f2',
]);

export function shouldBlockSpreadsheetPreviewCommand(commandId: string) {
  if (SPREADSHEET_READONLY_BLOCKED_COMMAND_IDS.has(commandId)) return true;
  if (commandId.includes('sheet.command.paste') || commandId.includes('sheet.command.cut')) {
    return true;
  }
  return false;
}
