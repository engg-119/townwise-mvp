// Ported from client/src/portal/upload/values.ts at commit d755b5a with unchanged logic. The browser upload (P13)
// keeps its own copy; test/files/csv-stream.test.ts and the client's parity test hold both to the same fixtures.
// Reading one cell as a date or a number (spec 11.2 steps 2 and 3). Pure, and allocation-light, because a 50 MB
// file has millions of cells.

export type DateOrder = 'month_first' | 'day_first';

/** A readable date cell: a full date, or a slash date whose month and day order the person confirms. */
export type DateCell =
  | { kind: 'full'; date: string }
  | { kind: 'slash'; first: number; second: number; year: number };

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const COMPACT = /^(\d{4})(\d{2})(\d{2})$/;
const SLASH = /^(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})$/;
const TIME = /^\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AaPp]\.?[Mm]\.?)?$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** YYYY-MM-DD for a real calendar date, or null. */
export function calendarDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null;
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** The date for `cell` in `order`, or null when that order makes no real date. */
export function resolveDate(cell: DateCell, order: DateOrder): string | null {
  if (cell.kind === 'full') return cell.date;
  return order === 'month_first'
    ? calendarDate(cell.year, cell.first, cell.second)
    : calendarDate(cell.year, cell.second, cell.first);
}

/**
 * `YYYY-MM-DD`, `YYYYMMDD`, `M/D/YYYY` or `M/D/YY` (20YY), each optionally followed by a space and a time, which is
 * ignored. Null when the cell is none of these, or no order makes it a real date.
 */
export function readDateCell(raw: string): DateCell | null {
  let text = raw.trim();
  const space = text.indexOf(' ');
  if (space !== -1) {
    if (!TIME.test(text.slice(space + 1).trim())) return null;
    text = text.slice(0, space);
  }
  const full = ISO.exec(text) ?? COMPACT.exec(text);
  if (full !== null) {
    const date = calendarDate(Number(full[1]), Number(full[2]), Number(full[3]));
    return date === null ? null : { kind: 'full', date };
  }
  const slash = SLASH.exec(text);
  if (slash === null) return null;
  const yearText = slash[3] ?? '';
  const cell: DateCell = {
    kind: 'slash',
    first: Number(slash[1]),
    second: Number(slash[2]),
    year: yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText),
  };
  return resolveDate(cell, 'month_first') === null && resolveDate(cell, 'day_first') === null ? null : cell;
}

/**
 * The order a slash date proves: only one order makes it a real date, because one of its parts is above 12
 * (13/02/2025 is day first; 02/13/2025 is month first). Null for full dates and dates that read either way.
 */
export function provenOrder(cell: DateCell): DateOrder | null {
  if (cell.kind !== 'slash') return null;
  const monthFirst = resolveDate(cell, 'month_first') !== null;
  const dayFirst = resolveDate(cell, 'day_first') !== null;
  if (monthFirst === dayFirst) return null;
  return monthFirst ? 'month_first' : 'day_first';
}

/** Millionths of a unit: exact integer sums for money with up to six decimal places. */
export const MICROS = 1_000_000;

/** The decimal mark a number is read with: a dot (12.50, with thousands commas) or a comma (12,50, with thousands dots). */
export type DecimalMark = '.' | ',';

const AMOUNT: Readonly<Record<DecimalMark, RegExp>> = {
  '.': /^(\d{1,3}(?:,\d{3})+|\d+)?(?:\.(\d*))?$/,
  ',': /^(\d{1,3}(?:\.\d{3})+|\d+)?(?:,(\d*))?$/,
};
const GROUPING: Readonly<Record<DecimalMark, RegExp>> = { '.': /,/g, ',': /\./g };
const MINUS = /^[-\u2212]/;

/**
 * A number cell in millionths (`MICROS`): null for an empty cell, NaN when it can't be read. `$`, thousands
 * separators and spaces are stripped. Parentheses or a leading minus (hyphen or U+2212) mean negative, so refunds
 * net out. Separators must group thousands, so with a dot for decimals a decimal comma (12,50) is unreadable rather
 * than misread. `decimal` is a dot unless a caller asks how the cell reads with a comma (days.ts, semicolon files).
 */
export function readAmount(raw: string, decimal: DecimalMark = '.'): number | null {
  let text = raw.replace(/\s/g, '');
  if (text === '') return null;
  let negative = false;
  if (text.startsWith('(') && text.endsWith(')')) {
    negative = true;
    text = text.slice(1, -1);
  }
  let dollar = false;
  if (text.startsWith('$')) {
    dollar = true;
    text = text.slice(1);
  }
  if (MINUS.test(text)) {
    if (negative) return NaN;
    negative = true;
    text = text.slice(1);
  }
  if (!dollar && text.startsWith('$')) text = text.slice(1);
  const match = AMOUNT[decimal].exec(text);
  if (match === null) return NaN;
  const whole = match[1];
  const fraction = match[2] ?? '';
  if (whole === undefined && fraction === '') return NaN;
  let micros = (whole === undefined ? 0 : Number(whole.replace(GROUPING[decimal], ''))) * MICROS;
  if (fraction !== '') {
    micros += Number(fraction.slice(0, 6).padEnd(6, '0'));
    // Beyond six decimal places, round half up once here; no export carries that many.
    if (fraction.length > 6 && fraction.charCodeAt(6) >= 53) micros += 1;
  }
  return negative ? -micros : micros;
}

/** A guest count: null for an empty cell, NaN when it can't be read or isn't a whole number. */
export function readGuests(raw: string): number | null {
  const micros = readAmount(raw);
  if (micros === null || Number.isNaN(micros)) return micros;
  return micros % MICROS === 0 ? micros / MICROS : NaN;
}

/** Whole cents from millionths of a dollar, rounded half up. */
export function centsOf(micros: number): number {
  return Math.floor((micros + 5000) / 10000);
}
