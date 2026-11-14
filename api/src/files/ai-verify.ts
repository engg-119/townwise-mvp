// Reading with TownwiseAI (spec 11A.9): which daily totals TownwiseAI read from a file the file's own text bears out,
// before any is written as sales days. A day counts only when one line of the text carries its date and no other date
// (a CSV, workbook or Word table row, a paragraph, a PDF line), that line carries each figure the day gives as
// separate numbers, and the day passes the upload route's caps. A figure elsewhere in the file, on another day's line,
// or on a line of two dates never counts, so rows shifted by one, figures read from a header, and numbers scattered
// apart from the dates are not borne out. Pure: the text is the organization's data, and nothing here logs or keeps it.
import { isCalendarDate } from '../dates.ts';
import type { AiReadDay } from '../stores/files.ts';
import type { SalesDay } from '../stores/sales-days.ts';

/** The upload route's caps (handlers/sales.ts, spec 11.3). */
const MAX_GUESTS = 20_000;
const MAX_NET_SALES_CENTS = 100_000_000;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/** Full names first, so "march" is read whole before "mar". */
const MONTH_WORDS = `(${[...MONTHS, 'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sept', 'sep', 'oct', 'nov', 'dec'].join('|')})\\.?(?![a-z])`;

function monthOf(word: string): number {
  const lower = word.toLowerCase();
  return MONTHS.findIndex((month) => month.startsWith(lower.slice(0, 3))) + 1;
}

function isoOf(year: number, month: number, day: number): string | null {
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isCalendarDate(iso) ? iso : null;
}

/**
 * The forms read, case-insensitively: 2026-11-16; 11/16/2026 and 11/16/26 (month first); 16/11/2026 only when the
 * first number cannot be a month; Nov 16 2026, November 16, 2026 and 16 Nov 2026 (with an optional "th" and full stop).
 */
const DATE_FORMS: readonly { readonly pattern: RegExp; readonly read: (parts: string[]) => string | null }[] = [
  { pattern: /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/g, read: ([y, m, d]) => isoOf(Number(y), Number(m), Number(d)) },
  {
    pattern: new RegExp(`\\b${MONTH_WORDS}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})(?!\\d)`, 'gi'),
    read: ([m, d, y]) => isoOf(Number(y), monthOf(m ?? ''), Number(d)),
  },
  {
    pattern: new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_WORDS},?\\s+(\\d{4})(?!\\d)`, 'gi'),
    read: ([d, m, y]) => isoOf(Number(y), monthOf(m ?? ''), Number(d)),
  },
  {
    pattern: /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g,
    read: ([a, b, y]) => {
      const first = Number(a);
      const second = Number(b);
      const year = (y ?? '').length === 2 ? 2000 + Number(y) : Number(y);
      if (first <= 12) return isoOf(year, first, second);
      return second <= 12 ? isoOf(year, second, first) : null;
    },
  },
];

/** Every date the text writes in one of DATE_FORMS, and the text with each blanked, so its parts are not read as figures. */
export function datesIn(text: string): { dates: Set<string>; rest: string } {
  const dates = new Set<string>();
  let rest = text;
  for (const { pattern, read } of DATE_FORMS) {
    rest = rest.replace(pattern, (match: string, ...groups: unknown[]) => {
      const date = read(groups.slice(0, 3).map(String));
      if (date === null) return match;
      dates.add(date);
      return ' '.repeat(match.length);
    });
  }
  return { dates, rest };
}

/** One number written on a line: as a whole number when it is written as one (no decimal part, no $), and in cents. */
export interface Figure { readonly whole: number | null; readonly cents: number }

/** A run of digits and commas, with a leading $ and a decimal part allowed. */
const NUMBER = /\$?\d[\d,]*(?:\.\d+)?/g;
/** Thousands commas: 3,456.50 is one number. */
const THOUSANDS = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/** The numbers of `text`, commas read only as thousands separators: a run like 120,3456.50 is no number here. */
function numbersOf(text: string): Figure[] {
  const figures: Figure[] = [];
  for (const [token] of text.matchAll(NUMBER)) {
    const bare = token.replace(/^\$/, '').replace(/,+$/, '');
    if (bare.includes(',') && !THOUSANDS.test(bare)) continue;
    const value = Number(bare.replaceAll(',', ''));
    if (!Number.isFinite(value)) continue;
    figures.push({ whole: token.startsWith('$') || bare.includes('.') ? null : value, cents: Math.round(value * 100) });
  }
  return figures;
}

/** The commas of `line` that sit inside a number with thousands separators (3,456.50), by position. */
function thousandsCommas(line: string): Set<number> {
  const at = new Set<number>();
  for (const match of line.matchAll(NUMBER)) {
    const bare = match[0].replace(/^\$/, '').replace(/,+$/, '');
    if (!THOUSANDS.test(bare)) continue;
    const start = match.index + (match[0].startsWith('$') ? 1 : 0);
    for (let index = 0; index < bare.length; index += 1) if (bare[index] === ',') at.add(start + index);
  }
  return at;
}

/** A CSV row: no tab, and a comma outside double quotes that is no thousands separator. */
export function isCsvLine(line: string): boolean {
  if (line.includes('\t')) return false;
  const thousands = thousandsCommas(line);
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted && !thousands.has(index)) return true;
  }
  return false;
}

/** A CSV row's fields, quotes removed ("" inside quotes is one quote). */
function csvFields(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? '';
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else field += char;
  }
  fields.push(field);
  return fields;
}

/** `line` with each double-quoted part blanked. */
function unquoted(line: string): string {
  return line.replace(/"(?:[^"]|"")*"?/g, (part) => ' '.repeat(part.length));
}

/** The numbers with thousands separators outside double quotes. */
function thousandsOf(line: string): Figure[] {
  return [...unquoted(line).matchAll(NUMBER)].flatMap(([token]) => (THOUSANDS.test(token.replace(/^\$/, '').replace(/,+$/, '')) ? numbersOf(token) : []));
}

/**
 * The figures one line (its dates blanked) writes. Any line reads a comma inside a number as a thousands separator.
 * Only a CSV row is also read field by field, its commas parting the figures (an unquoted 1,204 there is 1, 204 and
 * 1,204): a quoted field is one field, so "$12,345.67" is never 12 or 345.67.
 */
export function figuresIn(line: string): Figure[] {
  return isCsvLine(line) ? [...csvFields(line).flatMap(numbersOf), ...thousandsOf(line)] : numbersOf(line);
}

/** For each date written alone on a line of `text`, the figures of each such line. */
export function rowsByDate(text: string): Map<string, Figure[][]> {
  const rows = new Map<string, Figure[][]>();
  for (const line of text.split(/\r\n|\n|\r/)) {
    const { dates, rest } = datesIn(line);
    if (dates.size !== 1) continue;
    const [date] = dates;
    if (date === undefined) continue;
    const figures = figuresIn(rest);
    if (figures.length > 0) rows.set(date, [...(rows.get(date) ?? []), figures]);
  }
  return rows;
}

/** The day as a sales day: net sales in cents. */
export function salesDayOf(day: AiReadDay): SalesDay {
  return { date: day.date, guests: day.guests, netSalesCents: day.netSales === null ? null : Math.round(day.netSales * 100) };
}

/** A line bears the day out: its guests as a whole number and its net sales in cents, each a number of its own. */
function bearsOut(row: readonly Figure[], day: SalesDay): boolean {
  const places = (match: (figure: Figure) => boolean): number[] => row.flatMap((figure, index) => (match(figure) ? [index] : []));
  const guests = day.guests === null ? null : places((figure) => figure.whole === day.guests);
  const sales = day.netSalesCents === null ? null : places((figure) => figure.cents === day.netSalesCents);
  if (guests === null) return sales !== null && sales.length > 0;
  if (sales === null) return guests.length > 0;
  return guests.some((at) => sales.some((other) => other !== at));
}

/**
 * The places in `days` of the days the text bears out, in order: a line carrying the date alone carries each figure
 * the day gives, from `earliest` to `latest`, guests a whole number up to 20,000 and net sales up to one million dollars.
 */
export function verifiedIndexes(days: readonly AiReadDay[], text: string, bounds: { earliest: string; latest: string }): number[] {
  const rows = rowsByDate(text);
  return days.flatMap((day, index) => {
    const sales = salesDayOf(day);
    const inBounds = day.date >= bounds.earliest && day.date <= bounds.latest
      && (sales.guests === null || (Number.isInteger(sales.guests) && sales.guests >= 0 && sales.guests <= MAX_GUESTS))
      && (sales.netSalesCents === null || (sales.netSalesCents >= 0 && sales.netSalesCents <= MAX_NET_SALES_CENTS))
      && (sales.guests !== null || sales.netSalesCents !== null);
    return inBounds && (rows.get(day.date) ?? []).some((row) => bearsOut(row, sales)) ? [index] : [];
  });
}
