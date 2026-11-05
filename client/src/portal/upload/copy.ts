import { ApiError } from '../../api/client';
import { errorCopy, COPY as SHARED } from '../errors';
import { formatCount, formatDate, plural } from '../format';
import type { Calibration, Role } from '../schemas';
import type { ColumnProfile } from './columns';
import { LIST_LIMIT, type ExclusionReason, type Mapping, type RowTally } from './days';

// The upload page's words (spec 11.2, P13 and the Portal-Upload board), and the small formatters they need.
// Counts read as singular when they are one. No line ever carries a cell value or a file name.

export const COPY = {
  heading: 'Upload sales history',
  intro: 'Export a daily sales summary from your point-of-sale system as a CSV file. Your browser reads the file on this computer. Townwise receives only the date, guest count and net sales for each day; nothing else in the file leaves this computer.',
  choose: 'Choose a CSV file',
  fileHelp: 'A .csv or .txt file up to 50 MB, separated by commas, semicolons or tabs.',
  tooLarge: 'That file is larger than 50 MB.',
  notCsv: 'That doesn’t look like a CSV file. Excel file? Save it as CSV first.',
  noHeader: 'That file has no header row.',
  /** Not in the spec: the browser could not read the file (it moved or changed after it was chosen). */
  unreadable: 'That file can’t be read. Choose it again.',
  native: 'Upload from a computer at townwise.tech.',
  matchCells: 'Each picker lists your file’s column names and the kind of values found in its first 200 filled cells. Cell values stay hidden, except a location column’s once you name it.',
  rowQuestion: 'What is one row in this file?',
  itemLevel: 'Item-level exports aren’t supported. Export daily totals or checks, not items.',
  addedUp: 'We add up rows that share a date.',
  dateHelp: 'If your export has a business date column, pick it, so a 1 a.m. order counts toward the night before.',
  /** Not in the spec: Check the totals waits for a date column. */
  chooseDate: 'Choose the date column.',
  orderSet: 'Set from the dates in this file.',
  /** Not in the spec: the column's dates prove both orders. */
  orderMixed: 'Some dates in this column work only day first, and others only month first. Choose the order. Rows whose date doesn’t fit it are skipped.',
  valuesHelp: 'Guests and net sales are each optional. Pick at least one. Guesses from your column names are already picked.',
  chooseValues: 'Choose a guests column, a net sales column, or both.',
  locationHelp: 'For a file that covers several locations.',
  locationValueHelp: 'The only cell values Townwise shows, because you named this column as locations. Rows for other locations are left out.',
  /** Not in the spec: the column has more than 50 distinct values. */
  moreValues: 'This column has more than 50 values. Only the first 50 are listed.',
  checkTotals: 'Check the totals',
  noDates: 'No rows had a readable date. Check the Date column.',
  tooManyDays: 'This file covers more than 10 years. Upload up to 10 years at a time.',
  /** Not in the spec: a semicolon file whose net sales may use a decimal comma. */
  decimalComma: 'The net sales in this file may use a comma for decimals, as in 1.234,50. Townwise reads only a dot for decimals, so it can’t be sure of these amounts. Export the file with a dot for decimals, then choose it again.',
  checkAgainst: 'Check these against your point-of-sale system.',
  onlyThese: 'Only these three columns leave this computer, one row per day.',
  /** Not in the spec: every day was left out, so there is nothing to send. */
  nothingToSend: 'No days are left to send.',
  serverFailed: 'The upload didn’t finish, and some days may have saved. Send again. Days are never duplicated.',
  seeSales: 'See your sales data',
  addNotes: 'Add notes for unusual days',
  notInFile: 'Not in this file',
} as const;

const STEPS = 'Choose a file, Match columns, Check the totals, Send.';

export function stepLine(step: 1 | 2 | 3 | 4): string {
  return `Step ${String(step)} of 4: ${STEPS}`;
}

/** “820 KB”, “12.4 MB”. */
export function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${formatCount(Math.ceil(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function readingLine(bytes: number): string {
  return `Reading ${formatSize(bytes)} file…`;
}

export function sendingLine(days: number): string {
  return `Sending ${plural(days, 'day', 'days')}…`;
}

export function sendLabel(days: number): string {
  return `Send ${plural(days, 'day', 'days')}`;
}

/** Whole dollars, rounded half up, with thousands commas (spec 15.7). */
export function formatDollars(cents: number): string {
  return `$${formatCount(Math.floor((cents + 50) / 100))}`;
}

/** “rows 4, 9, 12”, then “and {n} more” past the first 10. */
export function rowList(rows: RowTally): string {
  const more = rows.count - rows.rows.length;
  return `${rows.count === 1 ? 'row' : 'rows'} ${rows.rows.join(', ')}${more > 0 ? ` and ${formatCount(more)} more` : ''}`;
}

export function rowsBecameDays(rows: number, days: number, first: string, last: string): string {
  return `${plural(rows, 'row', 'rows')} became ${plural(days, 'day', 'days')}, ${formatDate(first)} to ${formatDate(last)}.`;
}

export function noDateLine(rows: RowTally): string {
  return `${plural(rows.count, 'row', 'rows')} had no readable date (${rowList(rows)}).`;
}

export function badNumberLine(rows: RowTally): string {
  return `${plural(rows.count, 'row', 'rows')} had a number Townwise couldn’t read (${rowList(rows)}).`;
}

export function otherLocationLine(count: number): string {
  return count === 1 ? '1 row was for another location.' : `${formatCount(count)} rows were for other locations.`;
}

export function repeatedDatesLine(dates: number, repeats: RowTally): string {
  const verb = dates === 1 ? 'appears' : 'appear';
  return `${plural(dates, 'date', 'dates')} ${verb} more than once (${rowList(repeats)}). Choose “One check or order”, or fix the file.`;
}

export const EXCLUSION: Readonly<Record<ExclusionReason, string>> = {
  after_tomorrow: 'After tomorrow',
  before_earliest: 'Before January 1, 2010',
  negative: 'A negative daily total',
  guests_cap: 'More than 20,000 guests in one day',
  sales_cap: 'More than $1,000,000 in net sales in one day',
  no_value: 'Neither guests nor net sales',
};

/** The line under the first 10 left-out days. */
export function moreDaysLine(total: number): string | null {
  return total > LIST_LIMIT ? `And ${formatCount(total - LIST_LIMIT)} more.` : null;
}

/** Spec 11.2 step 3: what happens to days the location already has, by role (D16). */
export function alreadyHaveLine(role: Role, first: string, last: string): string {
  const range = `You already have ${formatDate(first)} to ${formatDate(last)}.`;
  return role === 'org_admin'
    ? `${range} Days in both will be replaced by this file.`
    : `${range} Days you already have stay as they are. Only an admin can replace them.`;
}

/** Spec 11.2 step 4: the result, by role. */
export function resultLines(role: Role, location: string, upload: { dayCount: number; inserted: number; replaced: number; kept: number }): string[] {
  if (role === 'org_admin') {
    return [`Saved ${plural(upload.dayCount, 'day', 'days')} for ${location}: ${formatCount(upload.inserted)} new, ${formatCount(upload.replaced)} replaced.`];
  }
  const lines = [`Saved ${formatCount(upload.inserted)} new ${upload.inserted === 1 ? 'day' : 'days'} for ${location}.`];
  if (upload.kept > 0) {
    lines.push(`${plural(upload.kept, 'day', 'days')} already had data. Ask an admin to replace ${upload.kept === 1 ? 'it' : 'them'}.`);
  }
  return lines;
}

/** Spec 14.1, the body of the calibration state. */
export function calibrationLine(calibration: Calibration): string {
  if (calibration.state === 'no_sales_data') {
    return 'Upload your sales history to start. The upload sends Townwise only the date, guest count and net sales for each day.';
  }
  return `Your sales history is in: ${plural(calibration.dayCount, 'day', 'days')}, ${formatDate(calibration.firstDate)} to ${formatDate(calibration.lastDate)}. Calibration isn’t built yet, so there is no forecast.`;
}

const KIND: Readonly<Record<ColumnProfile['kind'], string>> = { dates: 'dates', numbers: 'numbers', text: 'text', empty: 'empty' };

/** One option per column, by index: “{header}: {kind}”, with the column number when a header repeats or is blank. */
export function columnOptions(columns: readonly ColumnProfile[]): { value: string; label: string }[] {
  const seen = new Map<string, number>();
  for (const column of columns) seen.set(column.name, (seen.get(column.name) ?? 0) + 1);
  return columns.map((column, index) => {
    const number = `column ${String(index + 1)}`;
    const name = column.name === '' ? `Unnamed (${number})` : (seen.get(column.name) ?? 0) > 1 ? `${column.name} (${number})` : column.name;
    return { value: String(index), label: `${name}: ${KIND[column.kind]}` };
  });
}

export interface MatchMessages { row: string[]; date: string[]; values: string[]; locationValue: string[] }

/** Spec 11.2 step 2: what keeps Check the totals from running. */
export function matchMessages(mapping: Mapping, locationName: string): MatchMessages {
  return {
    row: mapping.rowMode === 'item' ? [COPY.itemLevel] : [],
    date: mapping.date === null ? [COPY.chooseDate] : [],
    values: mapping.guests === null && mapping.netSales === null ? [COPY.chooseValues] : [],
    locationValue: mapping.location !== null && mapping.locationValue === null ? [`Choose which value is ${locationName}.`] : [],
  };
}

export function canCheck(messages: MatchMessages): boolean {
  return messages.row.length + messages.date.length + messages.values.length + messages.locationValue.length === 0;
}

/**
 * The send error of P13 and what its button does: `send` (a 500, 503 or a timeout: the upload may have half
 * applied, so the primary sends again), `retry` (429 or the network: the shared copy, Try again sends again), or
 * `restart` (400, 413 or another refusal: a client bug, so Try again starts over).
 */
export function sendErrorOf(error: unknown): { text: string; action: 'send' | 'retry' | 'restart' } {
  if (error instanceof ApiError) {
    if (error.kind === 'timeout' || (error.kind === 'http' && error.status >= 500)) return { text: COPY.serverFailed, action: 'send' };
    if (error.kind === 'http' && error.status !== 429) return { text: SHARED.request, action: 'restart' };
  }
  return { text: errorCopy(error), action: 'retry' };
}
