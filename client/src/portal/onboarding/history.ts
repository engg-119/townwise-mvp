import type { FileView, ImportView } from '../files/api';
import type { QueuedUpload } from '../files/uploadQueue';
import { formatDate, plural } from '../format';
import type { LocationSummary, OrgResponse } from '../schemas';

// Onboarding step 3 on Home (spec P11, 11A; storage2 2.1, 2.2 and 15.3): the pure part of HistoryStep. When the
// step shows, which phase it is in, which rows it lists (this screen's uploads merged with the import the server
// reports), when "Read my history" can start, and every line it prints. Nothing here reads a file's contents: rows
// carry a file's name and size, and the server's counts and dates.

/**
 * Home shows the step while the organization has locations and none of them has a stored day yet (agreement 1
 * with session 54). Home also checks its own fresh history, so the step leaves as soon as this location has days.
 */
export function needsHistory(_org: OrgResponse, locations: readonly LocationSummary[]): boolean {
  // Days a turned-off upload holds (D28) are history: Home then says the uploads are off, not that none were sent.
  return locations.length > 0 && locations.every((location) => location.coverage.dayCount === 0 && (location.offDayCount ?? 0) === 0);
}

export type Phase = 'drop' | 'reading' | 'done' | 'nothing_used';

/**
 * `watched` is true once this screen saw the import before it finished, so a finished import someone comes back
 * to later opens an empty drop zone (storage2 15.3) unless it found nothing, whose reasons stay listed.
 */
export function phaseOf(view: ImportView | null, watched: boolean): Phase {
  if (view === null || view.status === 'open') return 'drop';
  if (view.status !== 'done') return 'reading';
  if (view.found.dayCount === 0) return 'nothing_used';
  return watched ? 'done' : 'drop';
}

export type Row =
  | { kind: 'upload'; key: string; item: QueuedUpload }
  | { kind: 'file'; key: string; file: FileView };

const SENDING: ReadonlySet<QueuedUpload['state']> = new Set(['waiting', 'creating', 'sending', 'retrying', 'completing']);

/**
 * The screen's rows: each file the server lists, in upload order, shown as this screen's upload while it is still
 * sending, then every upload the server doesn't list yet. A finished upload whose import the server has not
 * re-read yet shows the file its complete answered. Cancelled uploads, and their files, leave the list.
 */
export function mergeRows(view: ImportView | null, items: readonly QueuedUpload[]): Row[] {
  const byFile = new Map(items.filter((item) => item.fileId !== null).map((item) => [item.fileId, item]));
  const listed = new Set<string>();
  const rows: Row[] = [];
  for (const file of view?.files ?? []) {
    const item = byFile.get(file.id);
    listed.add(file.id);
    if (item?.state === 'cancelled') continue;
    if (item !== undefined && (SENDING.has(item.state) || item.state === 'refused' || item.state === 'failed')) {
      rows.push({ kind: 'upload', key: item.key, item });
    } else if (item?.state === 'done' && file.status === 'uploading' && item.file !== null) {
      rows.push({ kind: 'file', key: file.id, file: item.file });
    } else {
      rows.push({ kind: 'file', key: file.id, file });
    }
  }
  for (const item of items) {
    if (item.state === 'cancelled' || (item.fileId !== null && listed.has(item.fileId))) continue;
    rows.push(item.state === 'done' && item.file !== null ? { kind: 'file', key: item.key, file: item.file } : { kind: 'upload', key: item.key, item });
  }
  return rows;
}

/** At least one stored file to read (storage2 15.3, step 3). */
export function storedCount(rows: readonly Row[]): number {
  return rows.filter((row) => row.kind === 'file' && row.file.status === 'stored').length;
}

/** Uploads this screen is still sending: leaving now would stop them. */
export function sendingCount(items: readonly QueuedUpload[]): number {
  return items.filter((item) => SENDING.has(item.state)).length;
}

/** The import "Read my history" starts: the open one the server reports, else the one the first upload joined. */
export function importToStart(view: ImportView | null, queueImportId: string | null): string | null {
  if (view?.status === 'open') return view.id;
  return queueImportId;
}

/** A row's share sent or read, 0 to 1; null when there is no total to measure against. */
export function rowProgress(row: Row): number | null {
  if (row.kind === 'upload') {
    if (!SENDING.has(row.item.state) || row.item.sizeBytes === 0) return null;
    return Math.min(1, row.item.sentBytes / row.item.sizeBytes);
  }
  const { progress } = row.file;
  if (row.file.status !== 'reading' || progress?.total == null || progress.total <= 0) return null;
  return Math.min(1, progress.done / progress.total);
}

/** The years the Reading calendar draws: those with a stored day, else this year. Newest first in the grid. */
export function calendarYears(dates: readonly string[], today: string): number[] {
  const years = [...new Set(dates.map((date) => Number(date.slice(0, 4))))];
  return years.length === 0 ? [Number(today.slice(0, 4))] : years;
}

function addDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/**
 * While files are still being read, the days of the drawn years up to yesterday that have no row yet are drawn
 * as "Not read yet"; once reading is done, nothing is pending.
 */
export function pendingRange(years: readonly number[], today: string, reading: boolean): { from: string; to: string } | undefined {
  if (!reading || years.length === 0) return undefined;
  const to = addDays(today, -1);
  const from = `${String(Math.min(...years))}-01-01`;
  return from <= to ? { from, to } : undefined;
}

/** The location card moves into the right rail once, on a wide screen, when motion is allowed. */
export function cardMoves(input: { reduced: boolean | null; desktop: boolean; played: boolean; phase: Phase; hasImport: boolean }): boolean {
  return input.reduced === false && input.desktop && !input.played && input.phase === 'drop' && !input.hasImport;
}

/** Whether the card moves (`play`), shows in place (`still`) or is not decided yet (`wait`). */
export type Entrance = 'wait' | 'play' | 'still';

/**
 * The card's entrance, decided once: at the first status read, and never while a statement moment plays. The welcome
 * plays on the first Home visit after approval, which is when this step shows, so deciding under it would spend the
 * card's one move behind the overlay (spec 15.8 lets a page hold its entrance while `useMoment().playing`).
 */
export function nextEntrance(current: Entrance, input: { loaded: boolean; momentPlaying: boolean; moves: boolean }): Entrance {
  if (current !== 'wait' || !input.loaded || input.momentPlaying) return current;
  return input.moves ? 'play' : 'still';
}

/** The "Found so far" lines (storage2 2.2), from the import's own counts. */
export function foundLines(found: ImportView['found']): string[] {
  if (found.dayCount === 0 || found.firstDate === null || found.lastDate === null) return ['No days yet.'];
  const lines = [`${plural(found.dayCount, 'day', 'days')}, ${formatDate(found.firstDate)} to ${formatDate(found.lastDate)}.`];
  const parts: string[] = [];
  if (found.guestsDayCount > 0) parts.push(`${plural(found.guestsDayCount, 'day', 'days')} with guests`);
  if (found.netSalesDayCount > 0) parts.push(`${plural(found.netSalesDayCount, 'day', 'days')} with net sales`);
  if (parts.length > 0) lines.push(`${parts.join(', ')}.`);
  if (found.closedDates.length > 0) lines.push(`${plural(found.closedDates.length, 'day', 'days')} closed.`);
  lines.push(found.missingDays === 0 ? 'No days missing in between.' : `${plural(found.missingDays, 'day', 'days')} missing in between.`);
  return lines;
}

/** "2 of 3 files read" for the Reading header. */
export function filesReadLine(progress: ImportView['progress']): string {
  return `${String(progress.filesDone)} of ${plural(progress.filesTotal, 'file', 'files')} read`;
}

/** The Done line: "Done. 1,035 days, Jan 1, 2024 to Oct 31, 2026." */
export function doneLine(found: ImportView['found']): string {
  if (found.dayCount === 0 || found.firstDate === null || found.lastDate === null) return STEP.nothingUsed;
  return `Done. ${plural(found.dayCount, 'day', 'days')}, ${formatDate(found.firstDate)} to ${formatDate(found.lastDate)}.`;
}

/**
 * The one line screen readers hear as the step changes, said once per change and never per progress tick
 * (it carries no time left or byte count).
 */
export function statusLine(phase: Phase, view: ImportView | null): string {
  switch (phase) {
    case 'drop':
      return '';
    case 'reading':
      return view?.question === null || view === null ? STEP.readingTitle : STEP.questionLine;
    case 'done':
      return view === null ? '' : doneLine(view.found);
    case 'nothing_used':
      return STEP.nothingUsed;
  }
}

/** "Drop to add 2 files", or without a count when the browser doesn't say how many are being dragged. */
export function overLine(count: number): string {
  return count > 0 ? `Drop to add ${plural(count, 'file', 'files')}` : 'Drop to add these files';
}

export const SUGGESTIONS: readonly { title: string; body: string }[] = [
  {
    title: 'Daily sales summaries',
    body: 'From your point-of-sale system’s reports, as far back as they go. One row per day with guests, net sales or both is best.',
  },
  {
    title: 'Sales reports, as Excel, CSV or PDF',
    body: 'A PDF works when it has a table with a date and guests or net sales on each line. Scanned pages can’t be read.',
  },
  {
    title: 'ZIPs of exports',
    body: 'A ZIP of many exports, such as a year of daily files, is opened on Townwise’s server and each file inside is read.',
  },
  {
    title: 'Check-level exports work too',
    body: 'One row per check or order: Townwise adds them up by day. Item-level exports don’t work, because each item line repeats its check’s guest count.',
  },
  {
    title: 'As many years as you have',
    body: 'Each year shows another round of terms, holidays and town events. Two files or twenty, drop them all.',
  },
  {
    title: 'Closures and events',
    body: 'Add them on the Notes page. Townwise doesn’t read notes inside files yet.',
  },
];

export const STEP = {
  step: 'Step 3 of 3: Your history',
  title: 'Drop in everything you have',
  lead: 'Drop your exports as they are, as many as you have. Townwise reads the date, guest count and net sales for each day from them on its server.',
  dropHeading: 'Drop files here',
  dropBody: 'Many files at once is fine, by dragging them here or choosing them.',
  choose: 'Choose files',
  chooseMore: 'Add more files',
  suggestionsTitle: 'What to drop in',
  read: 'Read my history',
  readHelpNone: 'Add at least one file.',
  readHelpSending: 'Files still uploading are read when they finish.',
  starting: 'Starting…',
  remove: 'Remove',
  cancel: 'Cancel',
  removing: 'Removing…',
  readingTitle: 'Reading your history',
  closeOk: 'You can close this page. Townwise keeps reading on its server, and Home shows your history when it’s done.',
  foundTitle: 'Found so far',
  questionLine: 'Townwise needs an answer before it goes on.',
  opening: 'Opening Home.',
  goHome: 'Go to Home now',
  stayUploading: 'Some files are still uploading. Going to Home now stops them.',
  nothingUsed: 'Done. Townwise found no days it could use in these files.',
  nothingUsedHelp: 'Each file below says why. Drop other exports, or read a CSV file in your browser.',
  calendarLabel: 'Your history so far',
  calendarEmpty: 'No days read yet.',
  calendarFailed: 'The calendar of days couldn’t load. It fills in at the next update.',
  nativeDrop: 'Drop your files from a computer at townwise.tech.',
  cardEyebrow: 'Your restaurant',
  keepsTitle: 'What Townwise keeps',
  keeps: [
    'Your files, stored privately for your organization in a storage account with no public internet address. Each original is deleted after 365 days, or sooner when you delete it.',
    'From each file, the date, guest count and net sales for each day, and a cleaned copy with only those three columns.',
  ],
  keepsFiles: 'Download or delete your files on Sales data at any time.',
  salesData: 'Sales data',
  dailyTotalsAsk: 'Prefer to send only daily totals?',
  dailyTotalsLink: 'Read the file in your browser instead',
  offTitle: 'Read a file in your browser',
  offBody: 'Dropping files isn’t available right now. Export a daily summary from your point-of-sale system as a CSV file. Your browser reads it and sends Townwise only the date, guest count and net sales for each day.',
  refusedOffer: 'Or read a CSV file in your browser and send only the date, guest count and net sales for each day.',
  loading: 'Checking for files you dropped before',
} as const;
