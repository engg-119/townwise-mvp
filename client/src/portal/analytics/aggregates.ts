import { formatCount, plural } from '../format';
import { valueOf } from '../locations/sales';
import type { EventKind } from './api';
import { usual } from './baseline';
import { classOf, closedDaysBetween, dayFlags, type DayClass, type DayContext } from './days';
import { includedFn, type Filters, type Included } from './filters';
import { byDate as indexByDate, type DayRecord } from './history';
import {
  metricNumber, metricText, MONTH_NAMES, signedPercent, WEEK_ORDER, WEEKDAY_NAMES, weekdayOf, type Metric,
} from './words';

// Analytics' charts as numbers (home.md 4.6, 5.5): weekly shape, by month, year over year, by type of night and
// the biggest drivers, each with the sentence that sums it up. Every figure is an average of the location's own
// stored days that the filters keep; nothing is estimated, and a figure with too few days behind it is null.

export interface AnalyticsInput {
  days: readonly DayRecord[];
  byDate: ReadonlyMap<string, DayRecord>;
  context: DayContext;
  filters: Filters;
  included: Included;
}

export function analyticsInput(days: readonly DayRecord[], context: DayContext, filters: Filters): AnalyticsInput {
  const byDate = indexByDate(days);
  return { days, byDate, context, filters, included: includedFn(filters, byDate, context) };
}

interface Point { date: string; value: number }

/** The kept days with a value for the metric. */
function points(input: AnalyticsInput): Point[] {
  const out: Point[] = [];
  for (const day of input.days) {
    const value = valueOf(day, input.filters.metric);
    if (value !== null && input.included(day.date)) out.push({ date: day.date, value });
  }
  return out;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function perDay(metric: Metric): string {
  return metric === 'guests' ? 'guests a day' : 'a day';
}

// Weekly shape

export interface WeekdayStat { weekday: number; n: number; mean: number | null }

/** Monday first. */
export function weeklyShape(input: AnalyticsInput): WeekdayStat[] {
  const values = new Map<number, number[]>(WEEK_ORDER.map((weekday) => [weekday, []]));
  for (const point of points(input)) values.get(weekdayOf(point.date))?.push(point.value);
  return WEEK_ORDER.map((weekday) => {
    const list = values.get(weekday) ?? [];
    return { weekday, n: list.length, mean: mean(list) };
  });
}

function extremesOf<T extends { mean: number | null }>(stats: readonly T[]): { high: T & { mean: number }; low: T & { mean: number } } | null {
  let high: (T & { mean: number }) | null = null;
  let low: (T & { mean: number }) | null = null;
  for (const stat of stats) {
    if (stat.mean === null) continue;
    const known = stat as T & { mean: number };
    if (high === null || known.mean > high.mean) high = known;
    if (low === null || known.mean < low.mean) low = known;
  }
  return high === null || low === null ? null : { high, low };
}

/** "Your busiest day is Saturday, 210 guests on average; your quietest is Monday, 108." */
export function weeklySummary(stats: readonly WeekdayStat[], metric: Metric): string | null {
  const found = extremesOf(stats);
  if (found === null) return null;
  const high = `${WEEKDAY_NAMES[found.high.weekday] ?? ''}, ${metricText(found.high.mean, metric)} on average`;
  if (found.high.weekday === found.low.weekday) return `Only ${WEEKDAY_NAMES[found.high.weekday] ?? ''}s have data so far: ${metricText(found.high.mean, metric)} on average.`;
  return `Your busiest day is ${high}; your quietest is ${WEEKDAY_NAMES[found.low.weekday] ?? ''}, ${metricNumber(found.low.mean, metric)}.`;
}

// By month

export interface MonthStat { month: number; n: number; meanPerDay: number | null }

/** Months 1 to 12, every year the filters keep pooled together. */
export function byMonth(input: AnalyticsInput): MonthStat[] {
  const values: number[][] = MONTH_NAMES.map(() => []);
  for (const point of points(input)) values[Number(point.date.slice(5, 7)) - 1]?.push(point.value);
  return values.map((list, index) => ({ month: index + 1, n: list.length, meanPerDay: mean(list) }));
}

/** "October is your busiest month, 171 guests a day on average; February is the quietest, 118." */
export function monthSummary(stats: readonly MonthStat[], metric: Metric): string | null {
  const found = extremesOf(stats.map((stat) => ({ ...stat, mean: stat.meanPerDay })));
  if (found === null) return null;
  const name = (month: number): string => MONTH_NAMES[month - 1] ?? '';
  const high = `${metricNumber(found.high.mean, metric)} ${perDay(metric)} on average`;
  if (found.high.month === found.low.month) return `Only ${name(found.high.month)} has data so far: ${high}.`;
  return `${name(found.high.month)} is your busiest month, ${high}; ${name(found.low.month)} is the quietest, ${metricNumber(found.low.mean, metric)}.`;
}

// Year over year

/** A month counts toward the year-over-year comparison when both years have at least this many days in it. */
export const YOY_MIN_DAYS = 15;

export interface YearMonthStat {
  year: number;
  month: number;
  n: number;
  daysInMonth: number;
  meanPerDay: number | null;
  /** Every day of the month has a value the filters keep. Charts draw the rest as hollow points. */
  complete: boolean;
}

export interface YearOverYearSummary {
  year: number;
  against: number;
  /** As a fraction: 0.04 is 4% ahead. */
  change: number;
  /** The months compared, 1 to 12. */
  months: number[];
}

export interface YearOverYear {
  years: number[];
  /** Per year (ascending), months 1 to 12. */
  cells: YearMonthStat[];
  summary: YearOverYearSummary | null;
  /** The newest checked pair, left out because no month has 15 days in both (early January); null otherwise. */
  skipped: { year: number; against: number } | null;
  /**
   * Why there is no summary: `history` when every year on file is checked and still nothing compares (older exports
   * would help), `checked` when unchecked years have data. Null with a summary.
   */
  gap: 'history' | 'checked' | null;
  /** Distinct months in the checked years with any value for the metric, for the "not enough yet" line. */
  monthsWithData: number;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The months with at least 15 kept days in both years, and the change over them; null when none or a zero base. */
function compare(cells: readonly YearMonthStat[], year: number, against: number): YearOverYearSummary | null {
  const cell = (y: number, month: number): YearMonthStat | undefined => cells.find((each) => each.year === y && each.month === month);
  const months: number[] = [];
  let now = 0;
  let before = 0;
  for (let month = 1; month <= 12; month += 1) {
    const a = cell(year, month);
    const b = cell(against, month);
    const nowMean = a !== undefined && a.n >= YOY_MIN_DAYS ? a.meanPerDay : null;
    const beforeMean = b !== undefined && b.n >= YOY_MIN_DAYS ? b.meanPerDay : null;
    if (nowMean === null || beforeMean === null) continue;
    months.push(month);
    now += nowMean;
    before += beforeMean;
  }
  return months.length > 0 && before > 0 ? { year, against, change: now / before - 1, months } : null;
}

/**
 * Average per day per month for each checked year, and the newest checked year against the one before it. When
 * that pair shares no month with 15 days in both (January 1 to 14 of every year), the newest pair that does.
 */
export function yearOverYear(input: AnalyticsInput): YearOverYear {
  const values = new Map<string, number[]>();
  for (const point of points(input)) {
    const key = point.date.slice(0, 7);
    const list = values.get(key);
    if (list === undefined) values.set(key, [point.value]);
    else list.push(point.value);
  }
  const years = [...input.filters.years].sort((a, b) => a - b);
  const cells = years.flatMap((year) => MONTH_NAMES.map((_, index) => {
    const month = index + 1;
    const list = values.get(`${String(year)}-${String(month).padStart(2, '0')}`) ?? [];
    const total = daysInMonth(year, month);
    return { year, month, n: list.length, daysInMonth: total, meanPerDay: mean(list), complete: list.length === total };
  }));
  const withData = years.filter((year) => cells.some((cell) => cell.year === year && cell.n > 0));
  let summary: YearOverYearSummary | null = null;
  for (let index = withData.length - 1; index >= 1 && summary === null; index -= 1) {
    summary = compare(cells, withData[index] ?? 0, withData[index - 1] ?? 0);
  }
  const newest = withData.at(-1);
  const before = withData.at(-2);
  const skipped = summary !== null && newest !== undefined && before !== undefined && summary.year !== newest
    ? { year: newest, against: before }
    : null;
  const checked = new Set(years);
  const withMetric = input.days.filter((day) => valueOf(day, input.filters.metric) !== null);
  const unchecked = withMetric.some((day) => !checked.has(Number(day.date.slice(0, 4))));
  const gap = summary !== null ? null : unchecked ? 'checked' : 'history';
  const monthsWithData = new Set(
    withMetric.filter((day) => checked.has(Number(day.date.slice(0, 4)))).map((day) => day.date.slice(0, 7)),
  ).size;
  return { years, cells, summary, skipped, gap, monthsWithData };
}

/**
 * "2026 is running about 4% ahead of 2025, comparing 10 months (January to October) with at least 15 days in both
 * years." Without a month to compare, the line that says what is missing: a second checked year when unchecked
 * years have data, else older history (the page shows "Upload older history" only for `gap: 'history'`).
 */
export function yearOverYearSummary(result: YearOverYear): string {
  const { summary } = result;
  if (summary === null) {
    if (result.gap === 'checked') {
      const checkedWithData = new Set(result.cells.filter((cell) => cell.n > 0).map((cell) => cell.year)).size;
      return checkedWithData < 2
        ? 'Check at least two years to compare.'
        : `No month has at least ${String(YOY_MIN_DAYS)} days in two of the years you checked.`;
    }
    return 'Year over year needs at least one full year before this one. '
      + `You have ${plural(result.monthsWithData, 'month', 'months')} so far. `
      + 'Older exports from your point-of-sale system would fill it in.';
  }
  const whole = Math.round(summary.change * 100);
  const direction = whole === 0
    ? `level with ${String(summary.against)}`
    : `about ${formatCount(Math.abs(whole))}% ${whole > 0 ? 'ahead of' : 'behind'} ${String(summary.against)}`;
  const first = MONTH_NAMES[(summary.months[0] ?? 1) - 1] ?? '';
  const last = MONTH_NAMES[(summary.months.at(-1) ?? 1) - 1] ?? '';
  const span = summary.months.length === 1 ? `1 month (${first})` : `${String(summary.months.length)} months (${first} to ${last})`;
  const line = `${String(summary.year)} is running ${direction}, comparing ${span} with at least ${String(YOY_MIN_DAYS)} days in both years.`;
  if (result.skipped === null) return line;
  const { year, against } = result.skipped;
  return `${line} ${String(year)} is not compared yet: no month has at least ${String(YOY_MIN_DAYS)} days in both ${String(year)} and ${String(against)}.`;
}

// By type of night

export const NIGHT_TYPES: readonly DayClass[] = ['regular', 'holiday', 'event', 'noted', 'closed'];

export const NIGHT_LABEL: Readonly<Record<DayClass, string>> = {
  regular: 'Regular nights',
  holiday: 'Holidays',
  event: 'Town event days',
  noted: 'Your events (from notes)',
  closed: 'Closed',
};

/** A type of night needs this many kept nights before it gets an average. */
export const NIGHT_MIN = 2;

export interface NightType {
  type: DayClass;
  /** Nights of this type in the checked years: days with a value, or for Closed every closed day from your first day of data to your last. */
  n: number;
  /** Null for Closed, under 2 kept nights, or when the filters leave the type out. */
  mean: number | null;
  /** Against Regular nights, as a fraction; null for Regular itself or without both means. */
  change: number | null;
  /** The filters leave every night of this type out of the numbers. */
  leftOut: boolean;
}

export function nightTypes(input: AnalyticsInput): NightType[] {
  const { filters, context, byDate } = input;
  const years = new Set(filters.years);
  const counts = new Map<DayClass, number>(NIGHT_TYPES.map((type) => [type, 0]));
  const kept = new Map<DayClass, number[]>(NIGHT_TYPES.map((type) => [type, []]));
  for (const day of input.days) {
    const value = valueOf(day, filters.metric);
    const type = classOf(day.date, day, context);
    if (type === 'closed' || value === null || !years.has(Number(day.date.slice(0, 4)))) continue;
    counts.set(type, (counts.get(type) ?? 0) + 1);
    if (input.included(day.date)) kept.get(type)?.push(value);
  }
  const first = input.days[0]?.date;
  const last = input.days.at(-1)?.date;
  counts.set('closed', first === undefined || last === undefined ? 0 : closedDaysBetween(first, last, years, byDate, context));
  const regular = mean(kept.get('regular') ?? []);
  return NIGHT_TYPES.map((type) => {
    const n = counts.get(type) ?? 0;
    const values = kept.get(type) ?? [];
    const average = type === 'closed' || values.length < NIGHT_MIN ? null : mean(values);
    const change = type === 'regular' || average === null || regular === null || regular === 0 ? null : average / regular - 1;
    return { type, n, mean: average, change, leftOut: type !== 'closed' && n > 0 && values.length === 0 };
  });
}

/**
 * "Regular nights: 954 nights, 145 guests on average, the baseline." "Holidays: 31 nights, +27% against regular
 * nights." Closed shows its count only.
 */
export function nightLine(night: NightType, metric: Metric): string {
  const head = `${NIGHT_LABEL[night.type]}: ${plural(night.n, 'night', 'nights')}`;
  if (night.type === 'closed') return `${head}.`;
  if (night.leftOut) return `${head}, left out by your filters.`;
  if (night.mean === null) return `${head}. Not enough nights yet.`;
  if (night.type === 'regular') return `${head}, ${metricText(night.mean, metric)} on average, the baseline.`;
  if (night.change === null) return `${head}, ${metricText(night.mean, metric)} on average.`;
  return `${head}, ${metricText(night.mean, metric)} on average, ${signedPercent(night.change)} against regular nights.`;
}

// Biggest drivers

/** A driver needs this many days with an effect; under DRIVER_SOLID days it is marked rough ([CONFIRM: driver thresholds]). */
export const DRIVER_MIN = 2;
export const DRIVER_SOLID = 4;
export const DRIVER_TOP = 8;

export const DRIVERS_FOOTNOTE = 'Each effect compares those days with your usual for that weekday in the 4 weeks around them. '
  + 'Fewer than 4 days is thin evidence, so Townwise marks those rough. Holiday and event days are always measured, '
  + 'even when your filters leave them out of the other numbers.';

export const DRIVERS_EMPTY = 'Townwise needs each kind of day to happen at least twice before it can say how much it moves your numbers.';

export interface Driver {
  /** An event group ('us:thanksgiving'), or 'notes:private_event' and 'notes:opening'. */
  key: string;
  label: string;
  /** Mean of the day effects, as a fraction: 0.27 is 27% more than usual. */
  effect: number;
  /** Days with an effect, oldest first. */
  dates: string[];
  rough: boolean;
  firstYear: number;
  lastYear: number;
}

const NOTE_GROUPS: Readonly<Partial<Record<string, { key: string; label: string }>>> = {
  private_event: { key: 'notes:private_event', label: 'Your private events' },
  opening: { key: 'notes:opening', label: 'Openings' },
};

/**
 * Only holiday and event groups are drivers. Term and season periods span months and count as regular days
 * (days.ts), so their usual comes from the same days and their effect would be about 0%: context, not evidence.
 */
const DRIVER_KINDS: ReadonlySet<EventKind> = new Set(['holiday', 'event']);

/**
 * Recurring kinds of day (holiday and event groups, your private events, openings) ranked by how far they move the
 * metric from usual. Each occurrence day in a checked year with a value, not closed and with a usual counts, even
 * when the "Include in the numbers" boxes leave it out (they only take it out of the usual); a group needs 2 such
 * days, and under 4 it is rough.
 */
export function drivers(input: AnalyticsInput): Driver[] {
  const { filters, context, byDate } = input;
  const groups = new Map<string, { label: string; dates: Set<string> }>();
  const add = (key: string, label: string, date: string): void => {
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { label, dates: new Set([date]) });
    else group.dates.add(date);
  };
  for (const [date, events] of context.eventsByDate) {
    for (const event of events) {
      if (event.group !== null && DRIVER_KINDS.has(event.kind)) add(event.group, event.groupLabel ?? event.title, date);
    }
  }
  for (const [date, notes] of context.notesByDate) {
    for (const note of notes) {
      const group = NOTE_GROUPS[note.kind];
      if (group !== undefined) add(group.key, group.label, date);
    }
  }
  const years = new Set(filters.years);
  const out: Driver[] = [];
  for (const [key, group] of groups) {
    const effects: number[] = [];
    const dates: string[] = [];
    for (const date of [...group.dates].sort()) {
      const day = byDate.get(date);
      const value = day === undefined ? null : valueOf(day, filters.metric);
      if (value === null || !years.has(Number(date.slice(0, 4))) || dayFlags(date, day, context).closed) continue;
      const base = usual(date, filters.metric, byDate, context, input.included);
      if (base === null || base.mean === 0) continue;
      effects.push(value / base.mean - 1);
      dates.push(date);
    }
    const effect = mean(effects);
    const first = dates[0];
    const last = dates.at(-1);
    if (effect === null || effects.length < DRIVER_MIN || first === undefined || last === undefined) continue;
    out.push({
      key, label: group.label, effect, dates, rough: effects.length < DRIVER_SOLID,
      firstYear: Number(first.slice(0, 4)), lastYear: Number(last.slice(0, 4)),
    });
  }
  return out
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect) || a.label.localeCompare(b.label))
    .slice(0, DRIVER_TOP);
}

/** "3 days, 2024 to 2026" or "2 days, 2025". */
export function seenText(driver: Driver): string {
  const years = driver.firstYear === driver.lastYear
    ? String(driver.firstYear)
    : `${String(driver.firstYear)} to ${String(driver.lastYear)}`;
  return `${plural(driver.dates.length, 'day', 'days')}, ${years}`;
}

/** "Thanksgiving: +27% against usual, 3 days, 2024 to 2026. Rough." */
export function driverLine(driver: Driver): string {
  return `${driver.label}: ${signedPercent(driver.effect)} against usual, ${seenText(driver)}.${driver.rough ? ' Rough.' : ''}`;
}
