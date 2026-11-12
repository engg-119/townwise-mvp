// Reading with TownwiseAI (spec 11A.9): which daily totals TownwiseAI read from a file the file's own text bears out,
// before any is written as sales days. A day counts when its date appears in the text in a form people write dates in,
// each figure it gives appears among the text's numbers, and it passes the upload route's caps. Pure: the text is the
// organization's data, and nothing here logs or keeps it.
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

/** A run of digits and commas, with a leading $ and a decimal part allowed. */
const NUMBER = /\$?\d[\d,]*(?:\.\d+)?/g;
/** Thousands commas: 3,456.50 is one number. */
const THOUSANDS = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/**
 * The text's whole numbers (guests), and every number in cents (net sales, compared to two decimals). A run with commas
 * is read both ways, as one number with thousands commas (3,456.50) and as the numbers the commas part (a CSV row's
 * 120,3456.50), since the check is only whether a figure appears.
 */
export function numbersIn(text: string): { whole: Set<number>; cents: Set<number> } {
  const whole = new Set<number>();
  const cents = new Set<number>();
  for (const [token] of text.matchAll(NUMBER)) {
    const bare = token.replace(/^\$/, '');
    const readings = bare.split(',').filter((piece) => piece !== '');
    if (THOUSANDS.test(bare)) readings.push(bare.replaceAll(',', ''));
    for (const reading of readings) {
      const value = Number(reading);
      if (!Number.isFinite(value)) continue;
      if (Number.isInteger(value)) whole.add(value);
      cents.add(Math.round(value * 100));
    }
  }
  return { whole, cents };
}

/**
 * The days of `days` the text bears out, as sales days (net sales in cents), in their order: the date written in the
 * text, each figure given among its numbers, from `earliest` to `latest`, guests a whole number up to 20,000 and net
 * sales up to one million dollars.
 */
export function verifiedDays(days: readonly AiReadDay[], text: string, bounds: { earliest: string; latest: string }): SalesDay[] {
  const { dates, rest } = datesIn(text);
  const { whole, cents } = numbersIn(rest);
  const verified: SalesDay[] = [];
  for (const day of days) {
    const netSalesCents = day.netSales === null ? null : Math.round(day.netSales * 100);
    const inBounds = day.date >= bounds.earliest && day.date <= bounds.latest
      && (day.guests === null || (Number.isInteger(day.guests) && day.guests >= 0 && day.guests <= MAX_GUESTS))
      && (netSalesCents === null || (netSalesCents >= 0 && netSalesCents <= MAX_NET_SALES_CENTS))
      && (day.guests !== null || netSalesCents !== null);
    const borneOut = dates.has(day.date) && (day.guests === null || whole.has(day.guests))
      && (netSalesCents === null || cents.has(netSalesCents));
    if (inBounds && borneOut) verified.push({ date: day.date, guests: day.guests, netSalesCents });
  }
  return verified;
}
