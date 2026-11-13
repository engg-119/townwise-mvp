import { plural } from '../format';
import { valueOf } from '../locations/sales';
import { dayFlags, type DayContext, type DayFlags } from './days';
import type { DayRecord } from './history';
import { listText, type Metric } from './words';

// The Analytics filters (home.md 4.2). They live in the page's component state only: never in the URL, never in
// storage. "Include in the numbers" decides which days every average, chart, night type and driver uses, and the
// heatmap's color levels; "Show on the calendar" decides only the heatmap's marks.

export interface Marks { townEvents: boolean; holidays: boolean; notes: boolean; closures: boolean }

export interface Inclusion {
  closed: boolean;
  /** Days with a note that doesn't close them. Closures follow `closed` only. */
  noted: boolean;
  /** Days with a holiday or a town event. */
  eventDays: boolean;
}

export interface Filters {
  metric: Metric;
  marks: Marks;
  include: Inclusion;
  /** The checked years, ascending. Never empty while the location has data. */
  years: readonly number[];
}

export type Included = (date: string) => boolean;

export const KEEP_ONE_YEAR = 'Keep at least one year.';

function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/** Every year with a stored day, ascending. */
export function yearsWithData(days: readonly DayRecord[]): number[] {
  return [...new Set(days.map((day) => yearOf(day.date)))].sort((a, b) => a - b);
}

export function metricsWithData(days: readonly DayRecord[]): Readonly<Record<Metric, boolean>> {
  return {
    guests: days.some((day) => day.guests !== null),
    netSales: days.some((day) => day.netSalesCents !== null),
  };
}

/** Guests when any day has a guest count, else net sales; every mark on; closed days left out; every year. */
export function defaultFilters(days: readonly DayRecord[]): Filters {
  return {
    metric: metricsWithData(days).guests ? 'guests' : 'netSales',
    marks: { townEvents: true, holidays: true, notes: true, closures: true },
    include: { closed: false, noted: true, eventDays: true },
    years: yearsWithData(days),
  };
}

/** Checks or unchecks a year. Unchecking the last checked year is refused, and the box stays checked. */
export function toggleYear(filters: Filters, year: number, checked: boolean): { filters: Filters; refused: boolean } {
  const has = filters.years.includes(year);
  if (checked === has) return { filters, refused: false };
  if (!checked && filters.years.length === 1) return { filters, refused: true };
  const years = checked ? [...filters.years, year].sort((a, b) => a - b) : filters.years.filter((each) => each !== year);
  return { filters: { ...filters, years }, refused: false };
}

type LeftOut = 'closed' | 'noted' | 'eventDays';

/** Why the filters leave a day out, by the first rule that applies; null when the day is in the numbers. */
function leftOutBy(flags: DayFlags, include: Inclusion): LeftOut | null {
  if (flags.closed && !include.closed) return 'closed';
  if (flags.noted && !include.noted) return 'noted';
  if ((flags.holiday || flags.event) && !include.eventDays) return 'eventDays';
  return null;
}

/** True for a day in a checked year that no "Include in the numbers" box leaves out. */
export function includedFn(filters: Filters, byDate: ReadonlyMap<string, DayRecord>, context: DayContext): Included {
  const years = new Set(filters.years);
  return (date) => years.has(yearOf(date)) && leftOutBy(dayFlags(date, byDate.get(date), context), filters.include) === null;
}

export interface Basis {
  /** Days in the checked years with a value for the metric that the filters keep. */
  days: number;
  leftOut: Readonly<Record<LeftOut, number>>;
}

export function basisOf(days: readonly DayRecord[], filters: Filters, context: DayContext): Basis {
  const years = new Set(filters.years);
  const leftOut = { closed: 0, noted: 0, eventDays: 0 };
  let kept = 0;
  for (const day of days) {
    if (!years.has(yearOf(day.date)) || valueOf(day, filters.metric) === null) continue;
    const reason = leftOutBy(dayFlags(day.date, day, context), filters.include);
    if (reason === null) kept += 1;
    else leftOut[reason] += 1;
  }
  return { days: kept, leftOut };
}

const WITH_METRIC: Readonly<Record<Metric, [string, string]>> = {
  guests: ['day with a guest count', 'days with a guest count'],
  netSales: ['day with net sales', 'days with net sales'],
};

/**
 * The basis line printed under every section: "Based on 812 days with a guest count. Leaves out 4 closed days and
 * 12 days with a note." Names the years when some are unchecked.
 */
export function basisLine(days: readonly DayRecord[], filters: Filters, context: DayContext): string {
  const basis = basisOf(days, filters, context);
  const [one, many] = WITH_METRIC[filters.metric];
  const parts = [basis.days === 0 ? `No ${many} match your filters.` : `Based on ${plural(basis.days, one, many)}.`];
  const left = [
    basis.leftOut.closed > 0 ? plural(basis.leftOut.closed, 'closed day', 'closed days') : null,
    basis.leftOut.noted > 0 ? plural(basis.leftOut.noted, 'day with a note', 'days with a note') : null,
    basis.leftOut.eventDays > 0 ? plural(basis.leftOut.eventDays, 'holiday or event day', 'holiday and event days') : null,
  ].filter((part): part is string => part !== null);
  if (left.length > 0) parts.push(`Leaves out ${listText(left)}.`);
  const all = yearsWithData(days);
  if (filters.years.length < all.length) parts.push(`Only ${listText(filters.years.map(String))}.`);
  return parts.join(' ');
}
