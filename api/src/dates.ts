// Business days are 'YYYY-MM-DD' strings with no time zone (spec 6). These helpers read and move them in UTC,
// and the time always comes from ctx.now.
import { z } from 'zod';

const DAY_MS = 24 * 60 * 60 * 1000;

/** The earliest business day Townwise accepts, for sales days and notes (spec 11.3, 12). [CONFIRM: earliest date] */
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

/** A business day: YYYY-MM-DD and a real calendar date. */
export const isoDate = z.string().refine(isCalendarDate);

/** The UTC business day of `at`, moved by `days`. */
export function utcDay(at: Date, days = 0): string {
  return new Date(at.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** The same day `years` later (a 29 February lands on 1 March). */
export function plusYears(day: string, years: number): string {
  const date = new Date(timeOf(day));
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((timeOf(to) - timeOf(from)) / DAY_MS);
}
