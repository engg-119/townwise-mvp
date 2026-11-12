import { formatCount, formatDate } from '../../format';
import type { FileKind } from '../../files/api';
import { formatSize } from '../../files/copy';
import type { ViewerErrorReason } from '../../viewer/errors';
import { VIEW_LIMITS } from '../../viewer/limits';
import type { DataItem } from '../api';
import { DATA, daysLine, kindLabel, stateLine, VIA_LINE } from '../copy';

// Every word of an item's page (P27, D28). Like Your data's list, a figure prints only as a count, a size or a date
// range, and a name only where the API sends one (never under view-as). Each line that stands in for the content says
// why there is none, in plain words.

export const ITEM = {
  back: 'Back to Your data',
  loading: 'Loading this item',
  gone: 'This item isn’t here anymore. It may have been deleted, or replaced when someone saved an edit of it.',
  show: 'Show',
  days: 'Days',
  original: 'Original file',
  clean: 'Cleaned copy',
  loadingDays: 'Loading its days',
  daysOff: 'This upload is turned off, so its days are left out of your numbers and aren’t shown here. Turn it on in Your data to see them.',
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
