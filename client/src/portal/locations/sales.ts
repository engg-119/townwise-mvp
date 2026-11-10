import { formatCount, formatDate } from '../format';
import type { Coverage } from '../schemas';
import type { SalesDay } from './api';
import { addDays } from './dates';

// Sales data's numbers (spec P12, 15.7): the chart's range and series, its text summary, money in whole dollars,
// and the chart's geometry, which the web chart draws and the tests check. Pure functions, no figures invented:
// a day with no row, or no value for the series, is a gap in the line.

/** The chart covers the last 365 days of data, ending at the last day (spec P12). */
/**
 * Shown in place of "No sales history yet" when the location has stored days but every upload holding them is turned
 * off on Your data (D28; the API's `uploadsOff`).
 */
export const UPLOADS_OFF_LINE = 'Every sales upload for this location is turned off. Turn one back on in Your data to see its days.';

export function chartRange(coverage: Coverage): { from: string; to: string } | null {
  if (coverage.firstDate === null || coverage.lastDate === null) return null;
  const from = addDays(coverage.lastDate, -364);
  return { from: from < coverage.firstDate ? coverage.firstDate : from, to: coverage.lastDate };
}

export type Series = 'guests' | 'netSales';

/** Daily guests, or daily net sales when the days have no guest counts. */
export function seriesOf(days: readonly SalesDay[]): Series {
  return days.some((day) => day.guests !== null) ? 'guests' : 'netSales';
}

export const SERIES_TITLE: Readonly<Record<Series, string>> = { guests: 'Daily guests', netSales: 'Daily net sales' };

export function valueOf(day: SalesDay, series: Series): number | null {
  return series === 'guests' ? day.guests : day.netSalesCents;
}

/** "$1,234": whole dollars with thousands commas, rounded half up (spec 15.7). */
export function formatDollars(cents: number): string {
  return `$${formatCount(Math.floor((cents + 50) / 100))}`;
}

/** A table cell: the whole number, the dollars, or “No data” for a day with no value. */
export function cellOf(value: number | null, money: boolean): string {
  if (value === null) return 'No data';
  return money ? formatDollars(value) : formatCount(value);
}

/** "312 guests" or "$4,210". */
export function valueText(value: number, series: Series): string {
  return series === 'guests' ? `${formatCount(value)} guests` : formatDollars(value);
}

export interface Extreme { date: string; value: number }

/** The highest and lowest day with a value (the earliest on a tie); null when no day has one. */
export function extremes(days: readonly SalesDay[], series: Series): { highest: Extreme; lowest: Extreme } | null {
  let highest: Extreme | null = null;
  let lowest: Extreme | null = null;
  for (const day of days) {
    const value = valueOf(day, series);
    if (value === null) continue;
    if (highest === null || value > highest.value) highest = { date: day.date, value };
    if (lowest === null || value < lowest.value) lowest = { date: day.date, value };
  }
  return highest === null || lowest === null ? null : { highest, lowest };
}

/** “Daily guests, {first} to {last}. Highest: {value} on {date}. Lowest day with data: {value} on {date}.” */
export function chartSummary(days: readonly SalesDay[], series: Series): string | null {
  const found = extremes(days, series);
  const first = days[0];
  const last = days.at(-1);
  if (found === null || first === undefined || last === undefined) return null;
  return `${SERIES_TITLE[series]}, ${formatDate(first.date)} to ${formatDate(last.date)}. `
    + `Highest: ${valueText(found.highest.value, series)} on ${formatDate(found.highest.date)}. `
    + `Lowest day with data: ${valueText(found.lowest.value, series)} on ${formatDate(found.lowest.date)}.`;
}

export interface ChartGeometry {
  /** The SVG path of the line, in a 0 to 300 by 0 to `height` box; a gap starts a new segment. */
  path: string;
  /** Lone days (no neighbour with a value) are drawn as dots so they don't vanish. */
  dots: { x: number; y: number }[];
  min: number;
  max: number;
  /** Month ticks with their year, at the first, middle and last day. */
  ticks: string[];
}

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthTick(date: string): string {
  return `${SHORT_MONTHS[Number(date.slice(5, 7)) - 1] ?? ''} ${date.slice(0, 4)}`;
}

/** The chart's line over `days` (oldest first), with the y scale fitted to the values (spec P12). */
export function chartGeometry(days: readonly SalesDay[], series: Series, height: number): ChartGeometry | null {
  const first = days[0];
  const last = days.at(-1);
  const found = extremes(days, series);
  if (first === undefined || last === undefined || found === null) return null;
  const { value: max } = found.highest;
  const { value: min } = found.lowest;
  const span = Math.max(1, Math.round((Date.parse(last.date) - Date.parse(first.date)) / 86_400_000));
  const x = (date: string): number => r2((Math.round((Date.parse(date) - Date.parse(first.date)) / 86_400_000) / span) * 300);
  // A flat series sits in the middle.
  const y = (value: number): number => r2(max === min ? height / 2 : ((max - value) / (max - min)) * height);
  const parts: string[] = [];
  const dots: { x: number; y: number }[] = [];
  let run: { x: number; y: number }[] = [];
  let previous: string | null = null;
  const flush = (): void => {
    const only = run[0];
    if (run.length === 1 && only !== undefined) dots.push(only);
    if (run.length > 1) parts.push(run.map((point, index) => `${index === 0 ? 'M' : 'L'}${String(point.x)} ${String(point.y)}`).join(' '));
    run = [];
  };
  for (const day of days) {
    const value = valueOf(day, series);
    if (value === null || (previous !== null && addDays(previous, 1) !== day.date)) flush();
    if (value !== null) run.push({ x: x(day.date), y: y(value) });
    previous = day.date;
  }
  flush();
  const middle = days[Math.floor((days.length - 1) / 2)] ?? first;
  return { path: parts.join(' '), dots, min, max, ticks: [monthTick(first.date), monthTick(middle.date), monthTick(last.date)] };
}
