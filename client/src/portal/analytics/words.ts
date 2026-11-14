import { formatCount, formatDate } from '../format';
import { formatDollars, type Series } from '../locations/sales';

// Analytics' small pieces of wording (spec 15.6 and 15.7): weekday and month names, dates with their weekday,
// signed percentages with a true minus, and a metric's value in words. Business days are read in UTC, as
// src/portal/locations/dates.ts reads them.

export type Metric = Series;

/** Indexed by the API's weekday number, 0 Sunday to 6 Saturday. */
export const WEEKDAY_NAMES: readonly string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Indexed by month number minus one. */
export const MONTH_NAMES: readonly string[] = [
  'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
];

/** Monday first, as the boards and the heatmap's rows run. */
export const WEEK_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

/** The API's weekday number of a YYYY-MM-DD day. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

/** "Sat, Nov 21, 2026". */
export function shortDate(date: string): string {
  return `${WEEKDAY_SHORT[weekdayOf(date)] ?? ''}, ${formatDate(date)}`;
}

/** "Saturday, Nov 21, 2026". */
export function longDate(date: string): string {
  return `${WEEKDAY_NAMES[weekdayOf(date)] ?? ''}, ${formatDate(date)}`;
}

/** "+31%", "−12%" (true minus), "0%" for a change written as a fraction (0.31). */
export function signedPercent(change: number): string {
  const whole = Math.round(change * 100);
  if (whole === 0) return '0%';
  return `${whole > 0 ? '+' : '−'}${formatCount(Math.abs(whole))}%`;
}

/** "241 guests", "1 guest" or "$5,210". Averages round to whole guests or dollars. */
export function metricText(value: number, metric: Metric): string {
  return metric === 'guests' ? `${formatCount(value)} ${value === 1 ? 'guest' : 'guests'}` : formatDollars(value);
}

/** "241" or "$5,210": the number without its noun, for tables and charts. */
export function metricNumber(value: number, metric: Metric): string {
  return metric === 'guests' ? formatCount(value) : formatDollars(value);
}

/** "guests" or "net sales". */
export const METRIC_NOUN: Readonly<Record<Metric, string>> = { guests: 'guests', netSales: 'net sales' };

/** "2026", "2025 and 2026", "2024, 2025 and 2026". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}
