import { ApiError } from '../../api/client';
import { errorCopy, COPY as SHARED } from '../errors';
import { formatCount, formatDate, plural } from '../format';
import type { EntryView, FileKind, FileView, ImportView, QuestionKind } from './api';
import type { QueuedUpload } from './uploadQueue';

// Every word of stored files (the storage2 design, sections 2, 8.9, 9 and 15): file kinds, statuses, the reason
// for each outcome code, upload and reading errors, ETA phrases and the drop step's lines. No line carries a cell
// value; a file name prints only where the organization sees its own list, never under view-as (the API sends null).

export const COPY = {
  estimating: 'Estimating',
  waitingForTurn: 'Waiting for a turn',
  reconnecting: 'Reconnecting…',
  waitingToUpload: 'Waiting to upload',
  starting: 'Starting…',
  finishing: 'Finishing…',
  uploaded: 'Uploaded',
  cancelled: 'Canceled',
  interrupted: 'Upload interrupted. Drop it again.',
  failed: 'Something went wrong reading this file. It’s stored, and we’ll look into it.',
  /** Section 13: the browser path, for owners who send only daily totals. */
  dailyTotalsOnly: 'Prefer to send only daily totals? Read the file in your browser instead.',
  noFiles: 'No files yet. Files you drop on the history step are listed here, with what Townwise did with each.',
  nativeDownload: 'Download from a computer at townwise.tech.',
  downloadRaw: 'Download original',
  downloadClean: 'Download cleaned CSV',
  deleteRaw: 'Delete original',
  deleteAllRaw: 'Delete all originals for this location',
  deleting: 'Deleting…',
  downloading: 'Downloading…',
  showEntries: 'See what’s inside',
  hideEntries: 'Hide what’s inside',
  moreEntries: 'Show more',
  notSure: 'Not sure',
  notSureHelp: 'Not sure keeps this file stored but not used, and Townwise moves on to the next one.',
  answer: 'Continue',
  answering: 'Saving…',
  /** Deleted by a person, by staff or by retention: the file view doesn't say which, so neither do the words. */
  rawGone: 'The original was deleted. The cleaned copy and days stay.',
  rawDeleted: 'Deleted the original. The cleaned copy and its days stay.',
} as const;

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

function oneDecimal(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/** “820 KB”, “12.4 MB”, “200 MB”, “2 GB” (binary units, as P13 prints them). */
export function formatSize(bytes: number): string {
  if (bytes < MIB) return `${formatCount(Math.ceil(bytes / KIB))} KB`;
  if (bytes < GIB) return `${oneDecimal(bytes / MIB)} MB`;
  return `${oneDecimal(bytes / GIB)} GB`;
}

export const KIND_LABEL: Readonly<Record<FileKind, string>> = {
  text: 'CSV or text file',
  xlsx: 'Excel file',
  xls: 'Old Excel file',
  pdf: 'PDF',
  docx: 'Word file',
  doc: 'Old Word file',
  zip: 'ZIP archive',
  other: 'File',
};

/** The accept hint under the drop zone (storage2 15.4): pass the queue's `limits?.maxFileBytes ?? null`, never a constant. */
export function acceptHint(maxFileBytes: number | null): string {
  const kinds = 'Any file: CSV, Excel, PDF, Word, ZIP or text';
  return maxFileBytes === null ? `${kinds}.` : `${kinds}, up to ${formatSize(maxFileBytes)} each.`;
}

/** The reason after “Kept, not used: ”, for every kept code of a file or a ZIP entry. */
export const KEPT_REASON = {
  old_excel: 'Townwise can’t read old Excel files yet. Save it as .xlsx or CSV and drop it again.',
  old_word: 'Townwise can’t read old Word files. Save it as .docx and drop it again.',
  numbers: 'Townwise can’t read Numbers files. Export it as CSV or Excel and drop it again.',
  encrypted: 'it has a password. Save a copy without one and drop it again.',
  image: 'it’s an image. Townwise reads tables, not pictures.',
  type_not_read: 'Townwise doesn’t read this kind of file.',
  not_a_table: 'there’s no table in it that Townwise can read.',
  pdf_no_table: 'this PDF has no table with dates and sales.',
  pdf_scanned: 'this PDF is a scan, with no text Townwise can read.',
  word_no_table: 'this Word file has no table with dates and sales.',
  notes_not_read_yet: 'it looks like notes. Townwise doesn’t read notes from files yet. Add them on the Notes page.',
  item_level: 'each row is one item. Export daily totals or checks instead.',
  no_sales_columns: 'it has no guests or net sales column.',
  decimal_comma: 'its amounts may use a comma for decimals, as in 1.234,50. Export it with a dot for decimals and drop it again.',
  needs_help: 'you chose Not sure. Drop it again any time.',
  too_large_to_read: 'it’s too large to read. Split it into smaller files and drop them again.',
  no_header: 'it has no header row.',
  no_dates: 'no row had a date Townwise could read.',
  repeated_dates: 'the same dates appear on more than one row, so Townwise can’t tell what one row is.',
  too_many_days: 'it covers more than 10 years. Drop up to 10 years at a time.',
  too_many_locations: 'it has too many locations in it. Export one location at a time.',
  not_a_workbook: 'it isn’t a working Excel file.',
  too_complex: 'it took too long or too much memory to read. Split it into smaller files.',
  bad_encoding: 'its text encoding can’t be read. Export it again as UTF-8 CSV.',
  zip_too_big: 'this ZIP holds too many files or too much data to unpack.',
  zip_bomb: 'this ZIP unpacks to far more than its size, so Townwise didn’t open it.',
  zip_damaged: 'this ZIP is damaged.',
  zip_empty: 'this ZIP is empty.',
  nothing_usable: 'none of the files inside had daily sales Townwise could use.',
  raw_deleted: 'its original was deleted before Townwise read it.',
  reference: 'Kept for reference.',
  calendar_export: 'it’s a calendar export. Import it in Your calendars to see its events and let TownwiseAI read them all.',
  system_file: 'it’s a system file your computer added.',
  nested_zip: 'it’s a ZIP inside a ZIP inside a ZIP, too deep to open.',
  zip_method: 'it’s compressed in a way Townwise can’t unpack. Zip it again with your computer’s built-in tool.',
  other_table_used: 'another table in this ZIP already covers the same days.',
} as const;
export type KeptReason = keyof typeof KEPT_REASON;

function keptReason(code: string | null): string | null {
  if (code === null || !Object.hasOwn(KEPT_REASON, code)) return null;
  return KEPT_REASON[code as KeptReason];
}

/** The line for a file's status in the list and the Reading screen. */
export function fileLine(file: FileView): string {
  switch (file.status) {
    case 'uploading':
      return COPY.interrupted;
    case 'stored':
      return 'Stored, not read yet';
    case 'queued':
      return file.queuePosition === null ? 'Waiting to be read' : `Waiting to be read, ${formatCount(file.queuePosition)} in line`;
    case 'reading':
      return 'Reading';
    case 'waiting':
      return 'Waiting for your answer';
    case 'read':
      return file.result === null || file.result.dayCount === 0
        ? 'Used'
        : `Used: ${plural(file.result.dayCount, 'day', 'days')}, ${formatDate(file.result.firstDate)} to ${formatDate(file.result.lastDate)}`;
    case 'kept': {
      const reason = keptReason(file.outcome);
      return reason === null ? 'Kept, not used.' : `Kept, not used: ${reason}`;
    }
    case 'failed':
      return COPY.failed;
  }
}

/** A ZIP's count line: “1,240 files inside: 730 used, 510 kept, not used”. */
export function entriesLine(entries: NonNullable<FileView['entries']>): string {
  return `${plural(entries.total, 'file', 'files')} inside: ${formatCount(entries.used)} used, ${formatCount(entries.kept)} kept, not used`;
}

export function entryLine(entry: EntryView): string {
  if (entry.status === 'used') return entry.dayCount === null ? 'Used' : `Used: ${plural(entry.dayCount, 'day', 'days')}`;
  if (entry.status === 'failed') return 'Something went wrong reading this file.';
  const reason = keptReason(entry.outcome);
  return reason === null ? 'Kept, not used.' : `Kept, not used: ${reason}`;
}

/** “CSV file, uploaded Nov 5, 2026”: the name under view-as, where the API leaves it out. */
export function fileName(file: Pick<FileView, 'name' | 'kind' | 'uploadedAt'>): string {
  return file.name ?? `${KIND_LABEL[file.kind]}, uploaded ${formatDate(file.uploadedAt)}`;
}

/** The cleaned copy's name: the original's stem with “-townwise.csv”. */
export function cleanName(file: Pick<FileView, 'name'>): string {
  if (file.name === null) return 'file-townwise.csv';
  const dot = file.name.lastIndexOf('.');
  const stem = dot > 0 ? file.name.slice(0, dot) : file.name;
  return `${stem}-townwise.csv`;
}

/** “About 40 seconds left”, rounded up to 5 seconds; “Estimating” when there is no basis yet. */
export function timeLeft(seconds: number | null, phase?: 'upload' | 'read'): string {
  if (seconds === null) return COPY.estimating;
  const tail = phase === undefined ? 'left' : `left to ${phase}`;
  if (seconds < 60) {
    const rounded = Math.max(5, Math.ceil(seconds / 5) * 5);
    return rounded >= 60 ? `About 1 minute ${tail}` : `About ${String(rounded)} seconds ${tail}`;
  }
  if (seconds < 3600) {
    const minutes = Math.round(seconds / 60);
    return minutes >= 60 ? `About 1 hour ${tail}` : `About ${plural(minutes, 'minute', 'minutes')} ${tail}`;
  }
  return `About ${plural(Math.round(seconds / 3600), 'hour', 'hours')} ${tail}`;
}

/** “2.1 MB/s”, “640 KB/s”. */
export function speedLine(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`;
}

/** The line above the queue: “3 files, 48.2 MB · About 2 minutes left to upload”, or “· Uploaded” once all are sent. */
export function overallLine(overall: { files: number; bytes: number; secondsLeft: number | null }): string {
  const left = overall.secondsLeft === 0 ? COPY.uploaded : timeLeft(overall.secondsLeft, 'upload');
  return `${plural(overall.files, 'file', 'files')}, ${formatSize(overall.bytes)} · ${left}`;
}

/** The Reading screen's header line for the whole import. */
export function readingLine(view: Pick<ImportView, 'status' | 'etaSeconds' | 'waitingForTurn'>): string {
  if (view.waitingForTurn) return COPY.waitingForTurn;
  if (view.status === 'done') return 'Done';
  if (view.status === 'waiting') return 'Waiting for your answer';
  if (view.status === 'open') return 'Not started';
  return timeLeft(view.etaSeconds, 'read');
}

/** Every error code the file routes answer (storage2 6.3), plus the client's own `file_empty` and `unsupported`. */
export const UPLOAD_ERROR = {
  invalid_request: 'Something went wrong with that upload. Drop the file again.',
  purpose_unavailable: 'Townwise can’t take this kind of upload yet.',
  not_found: 'This location isn’t available.',
  file_too_large: 'This file is over the size limit. Split it or zip it.',
  import_full: 'This batch is full. Read these files first, then drop the rest.',
  too_many_uploading: 'Too many files are uploading for this location. Wait for some to finish.',
  storage_full: 'Your organization’s file storage is full. Delete some originals to make room.',
  daily_upload_limit: 'Your organization reached today’s upload limit. Upload the rest tomorrow.',
  file_duplicate: 'You already added this file.',
  file_not_uploading: 'This upload ended. Drop the file again.',
  upload_expired: 'This upload ran out of time. Drop the file again.',
  uploads_busy: 'Townwise is busy. Trying again…',
  storage_unavailable: 'File storage isn’t responding. Trying again…',
  chunks_missing: 'Part of this file didn’t arrive. Drop it again.',
  files_unavailable: 'Stored files are off right now. Read the file in your browser instead.',
  forbidden: 'Only the person who uploaded this file or an admin can do that.',
  view_as_read_only: 'Read-only while viewing as someone else.',
  view_as_no_download: 'Files can’t be downloaded while viewing as someone else.',
  no_access: 'You no longer have access to this organization.',
  rate_limited: 'Too many uploads at once. Townwise will try again in a moment.',
  raw_expired: 'The original was deleted. The cleaned copy and days stay.',
  file_busy: 'This file is still uploading or being read. Try again when it’s done.',
  no_clean_file: 'This file added no days, so there is no cleaned copy.',
  no_entries: 'This file isn’t a ZIP archive.',
  import_empty: 'Drop at least one file first.',
  import_not_open: 'Reading already started.',
  import_running: 'Townwise is reading files for this location. Try again when it’s done.',
  question_stale: 'This question changed. Here’s the new one.',
  file_empty: 'This file is empty.',
  unsupported: 'Upload from a computer at townwise.tech.',
} as const;
export type UploadErrorCode = keyof typeof UPLOAD_ERROR;

/** The words for a queue item's error or a file action's refusal: the code's own line, else the shared copy. */
export function uploadError(code: string, detail?: Readonly<Record<string, unknown>> | null): string {
  if (code === 'file_too_large' && typeof detail?.maxBytes === 'number') {
    return `This file is over ${formatSize(detail.maxBytes)}. Split it or zip it.`;
  }
  if (Object.hasOwn(UPLOAD_ERROR, code)) return UPLOAD_ERROR[code as UploadErrorCode];
  if (code === 'network') return SHARED.network;
  if (code === 'signed_out') return SHARED.signedOut;
  return SHARED.server;
}

/** Lines that promise the queue's own retry, which no file action has: those fall back to the shared copy. */
const QUEUE_RETRIES: ReadonlySet<string> = new Set(['rate_limited', 'uploads_busy', 'storage_unavailable']);

/** A file action's error (delete, download, answer): the code's line when it has one, else the shared copy. */
export function actionError(error: unknown): string {
  if (
    error instanceof ApiError && error.kind === 'http' && error.code !== null && !QUEUE_RETRIES.has(error.code)
    && Object.hasOwn(UPLOAD_ERROR, error.code)
  ) {
    return uploadError(error.code, error.detail);
  }
  return errorCopy(error);
}

/** A queue row's status line (storage2 2.1). */
export function queueLine(item: QueuedUpload): string {
  switch (item.state) {
    case 'waiting':
      return COPY.waitingToUpload;
    case 'creating':
      return COPY.starting;
    case 'sending': {
      const speed = item.bytesPerSecond === null ? null : speedLine(item.bytesPerSecond);
      const left = timeLeft(item.secondsLeft);
      return speed === null ? left : `${speed} · ${left}`;
    }
    case 'retrying':
      return COPY.reconnecting;
    case 'completing':
      return COPY.finishing;
    case 'done':
      return COPY.uploaded;
    case 'cancelled':
      return COPY.cancelled;
    case 'refused':
    case 'failed':
      return item.error === null ? SHARED.server : uploadError(item.error.code, item.error.detail);
  }
}

/** A question's prompt, what an answer does, and the words for enum options (storage 5.2). */
export function questionText(kind: QuestionKind, locationName: string): { prompt: string; help: string } {
  switch (kind) {
    case 'date_column':
      return {
        prompt: 'Which column has the date of each sale?',
        help: 'Townwise adds up each day from this column. Pick the business date if there is one, so a 1 a.m. order counts toward the night before.',
      };
    case 'date_order':
      return {
        prompt: 'Do the dates in this file put the month or the day first?',
        help: 'Townwise reads every date in this file the way you choose.',
      };
    case 'location_value':
      return {
        prompt: `Which of these is ${locationName}?`,
        help: 'This file covers more than one location. Townwise keeps only the rows for the one you choose.',
      };
    case 'row_mode':
      return {
        prompt: 'What is one row in this file?',
        help: 'Townwise adds up rows that share a date. Item-level files can’t be read: export daily totals or checks.',
      };
    case 'columns':
      return {
        prompt: 'Which columns hold guests and net sales?',
        help: 'Pick at least one. Townwise reads only these columns and the date, one total per day.',
      };
    case 'sheet':
      return {
        prompt: 'Which sheet has your daily sales?',
        help: 'Townwise reads only the sheet you choose.',
      };
  }
}

const ENUM_OPTION: Readonly<Record<string, string>> = {
  day: 'One day',
  check: 'One check or order',
  item: 'One item',
  month_first: 'Month first (3/4 is March 4)',
  day_first: 'Day first (3/4 is April 3)',
  not_sure: COPY.notSure,
};

/** An option's words: the server's label (a header or sheet name), or the client's for an enum id. */
export function optionLabel(kind: QuestionKind, option: { id: string; label: string }): string {
  if (option.id === 'not_sure') return COPY.notSure;
  if (kind === 'row_mode' || kind === 'date_order') return ENUM_OPTION[option.id] ?? option.label;
  if (option.id.endsWith(':none')) return 'Not in this file';
  return option.label;
}

/** “In the table with Date, Covers, Net Amount”: which table of a ZIP a question is about. */
export function familyLine(family: string): string {
  return `In the table with ${family}`;
}

/** What deleting the original keeps, said before the press (storage2 2.3). */
export function deleteRawBody(file: Pick<FileView, 'name' | 'kind' | 'uploadedAt'>): string {
  return `This deletes the original of ${fileName(file)}. The cleaned copy and the days it added stay. This can’t be undone.`;
}

/** Org admins, on Your data: every sales file's original at once. Items kept for reference are not originals of anything else, so they stay (D28). */
export function deleteAllRawBody(locationName: string): string {
  return `This deletes the original of every sales file for ${locationName}. Cleaned copies and days stay, and so do items kept for reference. Files still uploading or being read are skipped. This can’t be undone.`;
}

export function deletedOriginalsLine(result: { deletedOriginals: number; skippedBusy: number }): string {
  const deleted = `Deleted ${plural(result.deletedOriginals, 'original', 'originals')}.`;
  return result.skippedBusy === 0 ? deleted : `${deleted} ${plural(result.skippedBusy, 'file was', 'files were')} busy and kept.`;
}
