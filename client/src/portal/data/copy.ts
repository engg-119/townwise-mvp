import { ApiError } from '../../api/client';
import { errorCopy } from '../errors';
import { formatCount, formatDate, plural } from '../format';
import { KEPT_REASON, KIND_LABEL, type KeptReason } from '../files/copy';
import type { DataItem } from './api';

// Every word of Your data (P26, D28). A figure prints only as a count or a date range; a name prints only where
// the organization sees its own list (the API sends null under view-as).

export const TEXT_MAX = 10_000;
export const TITLE_MAX = 120;

export const DATA = {
  kicker: 'Everything your team added',
  title: 'Your data',
  /** The kind of a calendar's row (D61). */
  calendarKind: 'Calendar',
  /** Under Organized while an older page is still to load (D61). */
  foldersSoFar: 'The folders count the items shown so far. Show older items below sorts in the rest.',
  /** An open folder with nothing in it (D61). */
  folderEmpty: 'Nothing in this folder yet.',
  /** Atop the open Not sorted yet folder (D61): how Townwise files an item. */
  unsortedHelp: 'Townwise files an item once it knows what it is: a sales upload, a calendar, pasted text, or a file TownwiseAI read. Let TownwiseAI read a file on its page to sort it.',
  show: 'Show',
  allLocations: 'All locations',
  uploadHistory: 'Upload sales history',
  nativeUpload: 'Upload from a computer at townwise.tech.',
  addFile: 'Add a file',
  pasteText: 'Paste text',
  addFileHelp: 'Any kind of file up to 200 MB, kept as it is for your team. Townwise doesn’t read it for sales; use Upload sales history for that. With the box above off, TownwiseAI reads a file only when you ask, in a chat or on the file’s page. With it on, TownwiseAI reads each file you add and uses what it finds.',
  ordering: 'Item sales, the ordering setup and counts live in Orders, under Ordering setup.',
  orderingLink: 'Open Ordering setup',
  pasteHeading: 'Paste text',
  titleLabel: 'Title',
  titleHelp: 'A few words your team will recognize. Leave out guests’ and staff names.',
  textLabel: 'Text',
  textHelp: 'Up to 10,000 characters.',
  save: 'Save',
  saving: 'Saving…',
  cancel: 'Cancel',
  titleMissing: 'Add a title.',
  textMissing: 'Paste some text.',
  textTooLong: 'Keep it to 10,000 characters.',
  loading: 'Loading your data',
  more: 'Show older items',
  loadingMore: 'Loading…',
  nativeDownload: 'Download from a computer at townwise.tech.',
  noFileKept: 'No file kept',
  none: 'None',
  dailyTotals: 'Daily totals',
  turnOff: 'Turn off',
  turnOn: 'Turn on',
  downloadRaw: 'Download original',
  downloadClean: 'Download cleaned CSV',
  deleteOriginal: 'Delete original',
  delete: 'Delete',
  deleting: 'Deleting…',
  deleteUploadTitle: 'Delete this upload',
  deleteUploadConfirm: 'Delete upload',
  deleteFileTitle: 'Delete this file',
  deleteFileConfirm: 'Delete file',
  on: 'On',
  off: 'Off',
} as const;

export const COLUMNS = {
  item: 'Item', location: 'Location', added: 'Added', kind: 'Kind', size: 'Size', status: 'Status', days: 'Days',
} as const;

export function lead(locationName: string): string {
  return `Sales uploads, calendars, files and text your team added for ${locationName}. Open an item to turn it off and leave it out of your numbers, forecasts and TownwiseAI without deleting it.`;
}

/** A folder's button's name (D61): “Sales, 3 items”. */
export function folderCountLine(folder: string, count: number): string {
  return `${folder}, ${plural(count, 'item', 'items')}`;
}

export function tableLabel(locationName: string | null): string {
  return locationName === null ? 'Your data for all locations' : `Your data for ${locationName}`;
}

export function empty(locationName: string): string {
  return `Nothing here yet. What your team uploads or adds for ${locationName} shows here.`;
}

export const VIA_LINE = {
  browser: 'Sent from a browser',
  file: 'Read by Townwise',
  staff: 'Added by Townwise staff',
  townwise_ai: 'Saved from TownwiseAI',
} as const satisfies Record<DataItem['via'], string>;

export function kindLabel(kind: DataItem['kind']): string {
  return kind === 'daily_totals' ? DATA.dailyTotals : KIND_LABEL[kind];
}

/** The name as the row shows it: else “Daily totals”, else the kind's label (under view-as, where the API sends no name). */
export function shownName(item: Pick<DataItem, 'name' | 'kind'>): string {
  return item.name ?? kindLabel(item.kind);
}

/**
 * The item in accessible names and notices. Without a name (every browser upload, and every item under view-as), the
 * kind with its days, “Daily totals, May 1, 2026 to May 10, 2026”, else with when it was added, “PDF, added Nov 5,
 * 2026”, so rows with no name still read apart.
 */
export function itemName(item: Pick<DataItem, 'name' | 'kind' | 'days' | 'addedAt'>): string {
  if (item.name !== null) return item.name;
  const kind = kindLabel(item.kind);
  if (item.days === null) return `${kind}, added ${formatDate(item.addedAt)}`;
  return `${kind}, ${formatDate(item.days.firstDate)} to ${formatDate(item.days.lastDate)}`;
}

export function addedLine(item: Pick<DataItem, 'addedAt' | 'addedByEmail'>): string {
  return `${formatDate(item.addedAt)}, ${item.addedByEmail}`;
}

export function daysLine(days: DataItem['days']): string {
  if (days === null) return DATA.none;
  return `${formatCount(days.inUse)} of ${formatCount(days.count)} in use, ${formatDate(days.firstDate)} to ${formatDate(days.lastDate)}`;
}

/** A stored file kept for reference: the original is the whole item, with no cleaned copy and no days. */
export function isReference(item: Pick<DataItem, 'ref' | 'outcome'>): boolean {
  return item.ref.startsWith('f_') && item.outcome === 'reference';
}

/** What Townwise did with the item, under On or Off. */
export function stateLine(item: Pick<DataItem, 'state' | 'outcome'>): string {
  switch (item.state) {
    case 'used':
      return 'Used';
    case 'kept': {
      if (item.outcome === 'reference') return 'Kept for reference';
      const reason = item.outcome !== null && Object.hasOwn(KEPT_REASON, item.outcome) ? KEPT_REASON[item.outcome as KeptReason] : null;
      return reason === null ? 'Kept, not used' : `Kept, not used: ${reason}`;
    }
    case 'failed':
      return 'Couldn’t read it';
    case 'reading':
      return 'Reading';
    case 'waiting':
      return 'Waiting for an answer';
    case 'uploading':
      return 'Uploading';
    case 'not_finished':
      return 'Didn’t finish';
  }
}

export function turnedOffLine(item: string, locationName: string): string {
  return `Turned off ${item}. ${locationName}’s numbers, forecasts and TownwiseAI leave it out until it’s turned on.`;
}

export function turnedOnLine(item: string): string {
  return `Turned on ${item}.`;
}

export function deletedUploadLine(days: number): string {
  return `Deleted the upload and ${plural(days, 'day', 'days')}.`;
}

export function deletedFileLine(item: string): string {
  return `Deleted ${item}.`;
}

export function deleteUploadBody(item: Pick<DataItem, 'days'>, locationName: string): string {
  const { days } = item;
  const held = days === null
    ? `the days this upload still holds for ${locationName}`
    : `the ${plural(days.inUse, 'day', 'days')} this upload still holds for ${locationName}, ${formatDate(days.firstDate)} to ${formatDate(days.lastDate)}`;
  return `This deletes ${held}, and its file, if it has one. Days a later upload replaced stay, and so do notes. To keep the days out of your numbers without deleting them, turn it off instead. This can’t be undone.`;
}

export function deleteFileBody(item: string): string {
  return `This deletes ${item} for everyone on your team. This can’t be undone.`;
}

/** An action's refusal on a row: this page's own words for the codes it can get, else the shared copy. */
export function dataError(error: unknown): string {
  if (error instanceof ApiError && error.kind === 'http') {
    if (error.status === 403) return 'Only the person who added it or an org admin can do that.';
    if (error.status === 409 && (error.code === 'item_busy' || error.code === 'file_busy')) {
      return 'Townwise is still reading this file. Try again when it’s done.';
    }
    if (error.status === 503 && error.code === 'files_unavailable') return 'File storage is off right now, so this can’t be done.';
    if (error.status === 404) return 'This item isn’t available anymore.';
  }
  return errorCopy(error);
}
