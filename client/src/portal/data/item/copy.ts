import { ApiError } from '../../../api/client';
import { COPY as SHARED, hasCode } from '../../errors';
import { formatCount, formatDate, plural } from '../../format';
import type { FileKind } from '../../files/api';
import { formatSize, uploadError } from '../../files/copy';
import type { ViewerErrorReason } from '../../viewer/errors';
import { VIEW_LIMITS } from '../../viewer/limits';
import type { DataItem } from '../api';
import { DATA, dataError, daysLine, kindLabel, stateLine, VIA_LINE } from '../copy';

// Every word of an item's page (P27, D28). Like Your data's list, a figure prints only as a count, a size or a date
// range, and a name only where the API sends one (never under view-as). Each line that stands in for the content says
// why there is none, in plain words.

export const ITEM = {
  back: 'Back to Your data',
  /** The heading of the section that holds Delete original and Delete. */
  deletes: 'Delete this item',
  loading: 'Loading this item',
  gone: 'This item isn’t here anymore. It may have been deleted, or replaced when someone saved an edit of it.',
  /** A calendar's page (`c_`) for a calendar that isn't there: calendars are removed, never replaced by an edit. */
  calendarGone: 'This calendar isn’t here anymore. It may have been removed.',
  /** Under a calendar's status: Refresh and Remove live in the Calendar's Your calendars. */
  manageCalendars: 'Manage it on the Calendar',
  show: 'Show',
  days: 'Days',
  original: 'Original file',
  clean: 'Cleaned copy',
  loadingDays: 'Loading its days',
  daysOff: 'This upload is turned off, so its days are left out of your numbers and aren’t shown here. Turn it on above to see them.',
  noDaysLeft: 'Later uploads replaced every day this upload sent, so it holds none now.',
  nativeFile: 'Open this file from a computer at townwise.tech.',
  nativeFileViews: 'Its original file and cleaned copy open from a computer at townwise.tech.',
  viewAs: 'Files don’t open during view-as.',
  filesOff: 'File storage is off right now, so this file can’t be opened.',
  uploading: 'This file is still uploading. Open it again when it’s done.',
  rawGone: 'Its file was deleted, so there’s nothing left to show.',
  notAllowed: 'Only the person who added it or an org admin can open the original.',
  notImage: 'This file is named like a picture, but it isn’t a PNG, JPEG, GIF or WebP picture, so Townwise doesn’t show it.',
  fetchingClean: 'Downloading the cleaned copy…',
  openFailed: 'Townwise couldn’t open this file.',
  emptyFile: 'This file is empty.',
  emptySheet: 'This sheet is empty.',
  sheets: 'Sheets',
  pdfLine: 'A PDF opens in a new tab, in your browser’s own PDF viewer.',
  openPdf: 'Open PDF',
  /** Added after a line that shows no content, when the person may download the original. */
  download: 'Use Download original to open it on your computer.',
} as const;

/** What the item is, how big, and how it arrived: “Excel file · 3 MB · Read by Townwise”. */
export function kindLine(item: Pick<DataItem, 'kind' | 'sizeBytes' | 'via'>): string {
  const size = item.sizeBytes === null ? DATA.noFileKept : formatSize(item.sizeBytes);
  return `${kindLabel(item.kind)} · ${size} · ${VIA_LINE[item.via]}`;
}

export function addedByLine(item: Pick<DataItem, 'addedAt' | 'addedByEmail'>): string {
  return `Added ${formatDate(item.addedAt)} by ${item.addedByEmail}`;
}

/** Null when no edit ever replaced the item's content. */
export function editedLine(item: Pick<DataItem, 'editedAt' | 'editedByEmail'>): string | null {
  if (item.editedAt === null) return null;
  return `Edited ${formatDate(item.editedAt)} by ${item.editedByEmail ?? DATA.none}`;
}

export function statusLine(item: Pick<DataItem, 'enabled' | 'state' | 'outcome'>): string {
  return `${item.enabled ? DATA.on : DATA.off} · ${stateLine(item)}`;
}

/** Null for an item with no days (a stored file). */
export function itemDaysLine(item: Pick<DataItem, 'days'>): string | null {
  return item.days === null ? null : `Days: ${daysLine(item.days)}`;
}

/** A line that shows no content, and how to open the file instead when the person may download it. */
export function withDownload(line: string, canDownload: boolean): string {
  return canDownload ? `${line} ${ITEM.download}` : line;
}

function extensionOf(name: string | null): string {
  const dot = name?.lastIndexOf('.') ?? -1;
  return name === null || dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** A kind the page can't draw: the old binary Office formats, Numbers, ZIP, and any other file that isn't a picture. */
export function cantShowLine(kind: FileKind, name: string | null): string {
  if (kind === 'xls') return 'Townwise can’t show old Excel files (.xls) here. Save it as .xlsx and add it again to see it here.';
  if (kind === 'doc') return 'Townwise can’t show old Word files (.doc) here. Save it as .docx and add it again to see it here.';
  if (kind === 'zip') return 'Townwise can’t show what’s inside a ZIP here.';
  if (extensionOf(name) === 'numbers') return 'Townwise can’t show Numbers files here. Export it as CSV or Excel and add it again to see it here.';
  return 'Townwise can’t show this kind of file here.';
}

export function tooLargeLine(sizeBytes: number): string {
  return `This file is ${formatSize(sizeBytes)}. Townwise shows files up to ${formatSize(VIEW_LIMITS.originalBytes)} here.`;
}

export const VIEWER_ERROR: Readonly<Record<ViewerErrorReason, string>> = {
  too_big: 'This file unpacks to more than Townwise opens here, so it can’t be shown.',
  damaged: 'This file looks damaged, so Townwise can’t show it.',
  encrypted: 'This file has a password, so Townwise can’t show it.',
  unsupported: 'This file is saved in a way Townwise can’t open here, or this browser can’t unpack it.',
};

export function fetchingLine(sizeBytes: number): string {
  return `Downloading ${formatSize(sizeBytes)} to show it…`;
}

export function openingLine(sizeBytes: number): string {
  return `Opening ${formatSize(sizeBytes)} file…`;
}

export function cutLine(shown: number, total: number, unit: 'rows' | 'days'): string {
  return `Showing the first ${formatCount(shown)} of ${formatCount(total)} ${unit}.`;
}

const READ = `${formatCount(VIEW_LIMITS.sheetRows)} rows and ${formatCount(VIEW_LIMITS.sheetColumns)} columns`;

export const TRUNCATED = {
  sheet: `Townwise reads the first ${READ} of a sheet, so the rest of this one is left out.`,
  delimited: `Townwise reads the first ${READ} of a file, so the rest of this one is left out.`,
  sheets: `Townwise reads the first ${formatCount(VIEW_LIMITS.sheets)} sheets of a workbook, so the rest are left out.`,
  document: `Townwise reads the first ${formatCount(VIEW_LIMITS.documentBlocks)} paragraphs and table rows of a document, so the rest is left out.`,
} as const;

export function daysTableLabel(item: string): string {
  return `Days in ${item}`;
}

// ---- Renaming and editing an item kept for reference (owner request, 2026-11-11) ----------------------------------

export const EDIT = {
  rename: 'Rename',
  edit: 'Edit',
  nameLabel: 'Name',
  nameMissing: 'Add a name.',
  save: 'Save',
  saveCopy: 'Save as a copy',
  saving: 'Saving…',
  cancel: 'Cancel',
  close: 'Close',
  tryAgain: 'Try again',
  tryingAgain: 'Trying again…',
  discardTitle: 'Discard your changes?',
  discardBody: 'Nothing you changed here has been saved. This can’t be undone.',
  discardConfirm: 'Discard changes',
  saved: 'Saved.',
  savedCopy: 'Saved a copy. The original is still on Your data.',
  copyNote: 'Saving makes a new Excel file beside this one. The copy keeps each cell’s value; formatting, formulas and charts stay only in the original.',
  addRow: 'Add a row',
  addColumn: 'Add a column',
  deleteRow: 'Delete',
  atLimit: `Townwise edits tables up to ${formatCount(VIEW_LIMITS.editRows)} rows and ${formatCount(VIEW_LIMITS.editColumns)} columns.`,
  stillHere: 'Your changes are still here.',
  openKept: 'Open it',
  itemChanged: 'Someone else saved an edit of this item first. Yours is kept on Your data as a new item.',
  notReplaced: 'Townwise saved your edit, but couldn’t put it in this item’s place. Try again. If you leave, your edit stays on Your data as a new item.',
  keptAsNew: 'Your edit is kept on Your data as a new item.',
  itemBusy: 'This item is changing right now, maybe because someone is saving an edit of it. Try again in a moment.',
  renameRefused: 'Townwise couldn’t rename this item. Try another name, or go back to Your data in case its file was deleted.',
} as const;

/** A name as its part before the last dot and the rest (“.txt”), as the API keeps the extension on a rename. */
export function splitName(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.');
  return dot === -1 ? { base: name, extension: '' } : { base: name.slice(0, dot), extension: name.slice(dot) };
}

/** An edited workbook's copy: “Sales (edited).xlsx”. */
export function copyName(name: string): string {
  return `${splitName(name).base} (edited).xlsx`;
}

export function nameHelp(extension: string): string {
  return `The name keeps its ${extension} ending.`;
}

export function renamedLine(name: string): string {
  return `Renamed to ${name}.`;
}

export function charsLeftLine(left: number): string {
  return `${plural(left, 'character', 'characters')} left.`;
}

/** A cell input's accessible name: “Row 3, column B” in a workbook, “Row 3, column 2” in a CSV. */
export function cellLabel(row: number, column: string): string {
  return `Row ${String(row)}, column ${column}`;
}

/** Why an item that could be edited can't be here: it is longer or wider than the editor takes. */
export function tooBigToEditLine(kind: 'text' | 'table' | 'workbook'): string {
  const rows = `${formatCount(VIEW_LIMITS.editRows)} rows and ${formatCount(VIEW_LIMITS.editColumns)} columns`;
  const limit = kind === 'text'
    ? `This file is too long to edit here: Townwise edits text up to ${formatCount(VIEW_LIMITS.editTextChars)} characters.`
    : kind === 'table'
      ? `This file is too big to edit here: Townwise edits tables up to ${rows}.`
      : `This workbook is too big to edit here: Townwise edits up to ${formatCount(VIEW_LIMITS.sheets)} sheets of ${rows}.`;
  return `${limit} Download it, edit it on your computer, and add it again.`;
}

/**
 * A rename's or an edit's refusal: Your data's words, with this page's own for 409 item_busy, which the API answers
 * while Townwise is still reading the item or an edit of it is being saved (a rename then waits for the edit).
 */
function editError(error: unknown): string {
  return hasCode(error, 409, 'item_busy') ? EDIT.itemBusy : dataError(error);
}

/**
 * A rename's refusal. A 400 is a title that makes no file name or an item that can't be renamed anymore (its original
 * deleted since the page opened), so its words fit either.
 */
export function renameError(error: unknown): string {
  return hasCode(error, 400, 'invalid_request') ? EDIT.renameRefused : editError(error);
}

/** Upload refusals as an edit meets them (the queue's words say “drop the file again”, which an edit can't). */
const STORE_ERROR: Readonly<Record<string, string>> = {
  storage_full: 'Your organization’s file storage is full, and saving an edit needs room for both copies until the old one is removed. Delete some files on Your data, then save again.',
  daily_upload_limit: 'Your organization reached today’s upload limit, so this edit can’t be saved until tomorrow.',
  too_many_uploading: 'Too many files are uploading for this location. Wait for some to finish, then save again.',
  file_duplicate: 'This is the same as another item on Your data, so there’s nothing new to save.',
  file_empty: 'Townwise can’t save an empty file. Add something to it, or delete the item on Your data instead.',
  files_unavailable: 'File storage is off right now, so this edit can’t be saved.',
};
/** Codes whose upload words fit an edit too. */
const STORE_SHARED: ReadonlySet<string> = new Set(['network', 'signed_out', 'file_too_large', 'forbidden', 'view_as_read_only', 'no_access']);

/** An edit whose upload was refused or failed: nothing changed, and the editor stays open. */
export function storeErrorLine(code: string, detail: Readonly<Record<string, unknown>> | null): string {
  const line = Object.hasOwn(STORE_ERROR, code) ? STORE_ERROR[code] : STORE_SHARED.has(code) ? uploadError(code, detail) : SHARED.server;
  return `${line ?? SHARED.server} ${EDIT.stillHere}`;
}

/** Whether putting a stored edit in the item's place is worth trying again: the request may not have arrived. */
export function replaceRetryable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.kind === 'http') return error.status >= 500 || error.status === 429;
  return error.kind !== 'signed_out';
}

/** An edit stored as its own item that can't take the item's place (another edit came first, or it can't now). */
export function keptLine(error: unknown): string {
  return hasCode(error, 409, 'item_changed') ? EDIT.itemChanged : `${editError(error)} ${EDIT.keptAsNew}`;
}
