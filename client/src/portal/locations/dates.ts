import { formatDate } from '../format';

// Business days are YYYY-MM-DD strings with no time zone (spec 6), moved in UTC as api/src/dates.ts moves them.

const DAY_MS = 24 * 60 * 60 * 1000;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The earliest business day the API accepts (spec 11.3, 12). */
export const EARLIEST_DATE = '2010-01-01';

function timeOf(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** True for a real calendar date written as YYYY-MM-DD. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = timeOf(value);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function addDays(day: string, days: number): string {
  return new Date(timeOf(day) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((timeOf(to) - timeOf(from)) / DAY_MS);
}

/** The same day `years` later (a 29 February lands on 1 March), as the API computes it. */
export function plusYears(day: string, years: number): string {
  const date = new Date(timeOf(day));
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

/** The server's business day (UTC), for the rules the API checks. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The viewer's own day, for what reads as past or coming up. */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${String(now.getFullYear())}-${month}-${day}`;
}

/** "Feb 2026" for "2026-02". */
export function formatMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const name = match === null ? undefined : SHORT_MONTHS[Number(match[2]) - 1];
  return match === null || name === undefined ? month : `${name} ${match[1] ?? ''}`;
}

/** The first and last day of a "YYYY-MM" month. */
export function monthRange(month: string): { from: string; to: string } {
  const from = `${month}-01`;
  const next = new Date(timeOf(from));
  next.setUTCMonth(next.getUTCMonth() + 1);
  return { from, to: addDays(next.toISOString().slice(0, 10), -1) };
}

/** "Mar 2, 2026 to Mar 9, 2026", or one date when the two match. */
export function formatRange(first: string, last: string): string {
  return first === last ? formatDate(first) : `${formatDate(first)} to ${formatDate(last)}`;
}
