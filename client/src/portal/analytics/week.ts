import { formatCount, formatDate, plural } from '../format';
import type { Note } from '../locations/api';
import { addDays, EARLIEST_DATE, monthRange } from '../locations/dates';
import { valueOf } from '../locations/sales';
import type { Calendar, TownEvent } from './api';
import { usual, type Usual } from './baseline';
import { rowOf } from './cells';
import { dayFlags, eventsOf, notesOf, type DayContext } from './days';
import type { DayRecord } from './history';
import { METRIC_NOUN, MONTH_NAMES, metricNumber, metricText, shortDate, signedPercent, WEEKDAY_NAMES, weekdayOf, type Metric } from './words';

// Home's numbers (home.md 2 and 5.6): this week against the same weeks in past years, last week against the same
// week last year, the late-week share for the bar order, and this month in past years. Every figure is a sum, an
// average or a share of the location's own stored days, and every one is of a past day: no function here returns a
// figure for a day after the last day of data or after today, and nothing here estimates. "Last year" is the same
// weekday 52 weeks (364 days) earlier; "usual" is baseline.ts's, with every day allowed by the filters.

/** 52 weeks: the same weekday a year earlier. */
export const YEAR_DAYS = 364;
/** The fewest days of last year's week that Home sums or compares (home.md 2.2). */
export const SUMMARY_MIN_DAYS = 5;
/** Past years of this month that Home lists, newest first (home.md 2.5). */
export const MONTH_YEARS = 3;

const EVERY_DAY = (): boolean => true;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const LAST_YEAR_FOOTNOTE = 'Last year means the same weekday 52 weeks earlier. Usual is your average for that weekday in the 4 weeks either side, leaving out closed days, days with a note, and holiday and event days.';

export function mondayOf(date: string): string {
  return addDays(date, -rowOf(date));
}

/** Monday to Sunday. */
export function weekDates(monday: string): string[] {
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

export function sameWeekdayYearsAgo(date: string, years: number): string {
  return addDays(date, -YEAR_DAYS * years);
}

/** "Nov 2", with no year. */
export function dayMonth(date: string): string {
  return `${SHORT_MONTHS[Number(date.slice(5, 7)) - 1] ?? ''} ${String(Number(date.slice(8, 10)))}`;
}

/** "Nov 11", "Nov 20 to 22", or "Oct 26 to Nov 17" across months. */
export function dayMonthRange(start: string, end: string): string {
  if (start === end) return dayMonth(start);
  if (start.slice(0, 7) === end.slice(0, 7)) return `${dayMonth(start)} to ${String(Number(end.slice(8, 10)))}`;
  return `${dayMonth(start)} to ${dayMonth(end)}`;
}

/**
 * The calendar range Home asks for: from two years before this week's Monday, less the 4 weeks either side that
 * "usual" reads, to the later of this month's last day and this week's Sunday.
 */
export function homeCalendarRange(today: string): { from: string; to: string } {
  const monday = mondayOf(today);
  const back = addDays(monday, -(2 * YEAR_DAYS + 28));
  const from = back < EARLIEST_DATE ? EARLIEST_DATE : back;
  const monthEnd = monthRange(today.slice(0, 7)).to;
  const sunday = addDays(monday, 6);
  return { from, to: monthEnd > sunday ? monthEnd : sunday };
}

export interface HomeInput {
  today: string;
  byDate: ReadonlyMap<string, DayRecord>;
  context: DayContext;
  metric: Metric;
  /** The last stored day; null with no history. */
  lastDate: string | null;
}

/** A stored figure, only for a day that is past: on or before the last day of data and today. */
/**
 * A holiday or a town event marks its day. Term and season periods span weeks or months, so they are context
 * (days.ts, home.md 4.3): This week names them once, and no day cell, headline or month grid square repeats them.
 */
export function marksDay(event: Pick<TownEvent, 'kind'>): boolean {
  return event.kind === 'holiday' || event.kind === 'event';
}

function dayEventsOf(context: DayContext, date: string): TownEvent[] {
  return eventsOf(context, date).filter(marksDay);
}

function figureOf(date: string, input: HomeInput): number | null {
  if (input.lastDate === null || date > input.lastDate || date > input.today) return null;
  const day = input.byDate.get(date);
  return day === undefined ? null : valueOf(day, input.metric);
}

// This week

export interface PastDay {
  date: string;
  value: number | null;
  closed: boolean;
  usual: Usual | null;
  /** The value against usual, as a fraction; null without both. */
  change: number | null;
  /** Titles of the holidays and town events on the calendar that day; term and season periods are left out. */
  events: string[];
}

export function pastDay(date: string, input: HomeInput): PastDay {
  const value = figureOf(date, input);
  const day = input.byDate.get(date);
  const found = value === null ? null : usual(date, input.metric, input.byDate, input.context, EVERY_DAY);
  return {
    date,
    value,
    closed: value !== null && dayFlags(date, day, input.context).closed,
    usual: found,
    change: value === null || found === null || found.mean === 0 ? null : value / found.mean - 1,
    events: dayEventsOf(input.context, date).map((event) => event.title),
  };
}

export interface WeekRow {
  date: string;
  isToday: boolean;
  /** The day's holidays and town events; term and season periods are in ThisWeek.periods. */
  events: readonly TownEvent[];
  notes: readonly Note[];
  /** This week's own stored figure; null for any day after the last day of data. */
  value: number | null;
  lastYear: PastDay;
  twoYearsAgo: PastDay;
}

export interface WeekSummary {
  /** Last year's same week, Monday and Sunday. */
  from: string;
  to: string;
  /** Days of that week with the metric, and their total. */
  days: number;
  total: number;
  /** The days' total against the sum of their usuals, over the days that have both. */
  vsUsual: { change: number; days: number } | null;
  busiest: string | null;
  quietest: string | null;
}

export interface ThisWeek {
  monday: string;
  sunday: string;
  rows: WeekRow[];
  /** Whether any of the seven days two years ago has data, so the column shows. */
  twoYears: boolean;
  /** Null when last year's week has fewer than 5 days of data. */
  summary: WeekSummary | null;
  /** The first town event or holiday of the week, and how many others there are. */
  firstEvent: { title: string; date: string; more: number } | null;
  /** Term and season periods covering any day of the week, each once, in calendar order. */
  periods: TownEvent[];
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function summaryOf(days: readonly PastDay[]): WeekSummary | null {
  const kept = days.filter((each): each is PastDay & { value: number } => each.value !== null);
  const first = days[0];
  const last = days.at(-1);
  if (kept.length < SUMMARY_MIN_DAYS || first === undefined || last === undefined) return null;
  const withUsual = kept.filter((each): each is PastDay & { value: number; usual: Usual } => each.usual !== null);
  const usualTotal = sum(withUsual.map((each) => each.usual.mean));
  const vsUsual = withUsual.length >= SUMMARY_MIN_DAYS && usualTotal > 0
    ? { change: sum(withUsual.map((each) => each.value)) / usualTotal - 1, days: withUsual.length }
    : null;
  const open = kept.filter((each) => !each.closed);
  const busiest = kept.reduce<(PastDay & { value: number }) | null>((best, each) => (best === null || each.value > best.value ? each : best), null);
  const quietest = open.reduce<(PastDay & { value: number }) | null>((best, each) => (best === null || each.value < best.value ? each : best), null);
  return {
    from: first.date, to: last.date, days: kept.length, total: sum(kept.map((each) => each.value)), vsUsual,
    busiest: busiest?.date ?? null, quietest: quietest?.date ?? null,
  };
}

export function thisWeek(input: HomeInput): ThisWeek {
  const monday = mondayOf(input.today);
  const dates = weekDates(monday);
  const rows = dates.map((date) => ({
    date,
    isToday: date === input.today,
    events: dayEventsOf(input.context, date),
    notes: notesOf(input.context, date),
    value: figureOf(date, input),
    lastYear: pastDay(sameWeekdayYearsAgo(date, 1), input),
    twoYearsAgo: pastDay(sameWeekdayYearsAgo(date, 2), input),
  }));
  const seen = new Set<string>();
  const periods: TownEvent[] = [];
  for (const date of dates) {
    for (const event of eventsOf(input.context, date)) {
      if (marksDay(event) || seen.has(event.id)) continue;
      seen.add(event.id);
      periods.push(event);
    }
  }
  let firstEvent: ThisWeek['firstEvent'] = null;
  for (const row of rows) {
    for (const event of row.events) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      if (firstEvent === null) firstEvent = { title: event.title, date: row.date, more: 0 };
      else firstEvent.more += 1;
    }
  }
  return {
    monday,
    sunday: addDays(monday, 6),
    rows,
    twoYears: rows.some((row) => row.twoYearsAgo.value !== null),
    summary: summaryOf(rows.map((row) => row.lastYear)),
    firstEvent,
    periods,
  };
}

/** "Same week last year, Mon, Nov 3 to Sun, Nov 9, 2025. From all 7 days." */
export function summaryLabel(summary: WeekSummary): string {
  const range = `${shortDate(summary.from).replace(/, \d{4}$/, '')} to ${shortDate(summary.to)}`;
  const days = summary.days === 7 ? 'From all 7 days.' : `From ${formatCount(summary.days)} of its 7 days.`;
  return `Same week last year, ${range}. ${days}`;
}

/** "+9% against that year’s usual for those days, compared over 7 days." */
export function vsUsualLine(summary: WeekSummary): string | null {
  if (summary.vsUsual === null) return null;
  return `${signedPercent(summary.vsUsual.change)} against that year’s usual for those days, compared over ${plural(summary.vsUsual.days, 'day', 'days')}.`;
}

function weekdayName(date: string): string {
  return WEEKDAY_NAMES[weekdayOf(date)] ?? '';
}

/** "On the calendar this week: Veterans Day (Wednesday), and 1 more." Term and season periods are periodLine's. */
export function calendarWeekLine(week: Pick<ThisWeek, 'firstEvent' | 'periods'>, calendar: Pick<Calendar, 'town' | 'researched' | 'covers'>): string {
  const first = week.firstEvent;
  if (first === null) {
    const researched = calendar.town.townId !== null && calendar.researched && calendar.covers !== null;
    if (week.periods.length > 0) {
      return researched ? `No holiday or town event on ${calendar.town.name}’s researched calendar this week.` : 'No holiday or town event this week.';
    }
    return researched ? `Nothing on ${calendar.town.name}’s researched calendar this week.` : 'Nothing on the calendar this week.';
  }
  const more = first.more === 0 ? '' : `, and ${formatCount(first.more)} more`;
  return `On the calendar this week: ${first.title} (${weekdayName(first.date)})${more}.`;
}

/** "Fall term classes. Term, Sep 14 to Nov 17, 2026." A period, with its whole span, said once for the week. */
export function periodLine(event: Pick<TownEvent, 'title' | 'kind' | 'start' | 'end'>): string {
  const span = event.start.slice(0, 4) === event.end.slice(0, 4)
    ? `${dayMonthRange(event.start, event.end)}, ${event.end.slice(0, 4)}`
    : `${formatDate(event.start)} to ${formatDate(event.end)}`;
  return `${event.title}. ${EVENT_WORDS[event.kind]}, ${span}.`;
}

/** What the town calendar covers (home.md 2.2), always under This week. */
export function calendarCoverageLine(calendar: Pick<Calendar, 'town' | 'researched' | 'covers'>): string {
  const { town, covers } = calendar;
  if (town.townId === null) return `Townwise hasn’t researched ${town.name}, ${town.state} yet. Only US federal holidays and your notes show here.`;
  if (!calendar.researched || covers === null) return `Townwise’s ${town.name} calendar has no researched town events yet. Only US federal holidays and your notes show here.`;
  return `${town.name}’s researched calendar covers ${formatDate(covers.from)} to ${formatDate(covers.to)} so far, plus US federal holidays.`;
}

/** "Sat, Nov 8, 2025: 241 guests". */
export function pastDayLine(day: PastDay, metric: Metric): string | null {
  return day.value === null ? null : `${shortDate(day.date)}: ${metricText(day.value, metric)}`;
}

/** "+31% vs usual". */
export function vsUsualDay(day: PastDay): string | null {
  return day.change === null ? null : `${signedPercent(day.change)} vs usual`;
}

// Last week

export interface ComparedDay { date: string; value: number | null; lastYear: number | null }

export type LastWeek =
  | { state: 'no_history' }
  /** The history ends before last week. */
  | { state: 'no_recent'; monday: string; sunday: string; lastDate: string }
  /** Last week has no day with the metric, though the history reaches it: a gap, or days without this metric. */
  | { state: 'no_days'; monday: string; sunday: string }
  | { state: 'no_last_year'; monday: string; sunday: string; days: ComparedDay[] }
  | { state: 'no_overlap'; monday: string; sunday: string; days: ComparedDay[] }
  | {
    state: 'compared'; monday: string; sunday: string; days: ComparedDay[];
    /** Days with the metric in both weeks; the totals and the change are over these days only. */
    comparedDays: number; total: number; lastYearTotal: number; change: number | null;
  };

/** Last week (Monday to Sunday before this one) against the days 364 days earlier. */
export function lastWeekComparison(input: HomeInput): LastWeek {
  if (input.lastDate === null) return { state: 'no_history' };
  const monday = addDays(mondayOf(input.today), -7);
  const sunday = addDays(monday, 6);
  const days = weekDates(monday).map((date) => ({
    date, value: figureOf(date, input), lastYear: figureOf(sameWeekdayYearsAgo(date, 1), input),
  }));
  if (days.every((each) => each.value === null)) {
    return input.lastDate < monday ? { state: 'no_recent', monday, sunday, lastDate: input.lastDate } : { state: 'no_days', monday, sunday };
  }
  if (days.every((each) => each.lastYear === null)) return { state: 'no_last_year', monday, sunday, days };
  const both = days.filter((each): each is ComparedDay & { value: number; lastYear: number } => each.value !== null && each.lastYear !== null);
  if (both.length === 0) return { state: 'no_overlap', monday, sunday, days };
  const total = sum(both.map((each) => each.value));
  const lastYearTotal = sum(both.map((each) => each.lastYear));
  return {
    state: 'compared', monday, sunday, days, comparedDays: both.length, total, lastYearTotal,
    change: lastYearTotal === 0 ? null : total / lastYearTotal - 1,
  };
}

function moreOrLess(change: number, metric: Metric): string {
  const whole = Math.round(change * 100);
  if (whole === 0) return 'about the same as';
  const word = whole > 0 ? 'more' : metric === 'guests' ? 'fewer' : 'less';
  return `${formatCount(Math.abs(whole))}% ${word} than`;
}

/** The card's text summary, in every state. */
export function lastWeekLine(comparison: LastWeek, metric: Metric): string {
  switch (comparison.state) {
    case 'no_history': return 'No sales history yet, so there is nothing to compare.';
    case 'no_recent': return `Your history ends ${formatDate(comparison.lastDate)}. Upload the days since to compare last week.`;
    case 'no_days': return `No ${METRIC_NOUN[metric]} stored for last week, so there is nothing to compare yet.`;
    case 'no_last_year': return 'No data for the same week last year, so there is nothing to compare yet.';
    case 'no_overlap': return 'Last week and the same week last year have no day with data in common, so there is nothing to compare yet.';
    case 'compared': {
      const total = metricText(comparison.total, metric);
      const before = metricNumber(comparison.lastYearTotal, metric);
      if (comparison.change === null) {
        return `Last week: ${total}, against ${before} on the same days last year, compared over ${plural(comparison.comparedDays, 'day', 'days')}.`;
      }
      const against = moreOrLess(comparison.change, metric);
      if (comparison.comparedDays === 7) {
        return `Last week: ${total}, ${against} the same week last year (${before}), compared over 7 days.`;
      }
      return `Last week: ${total} on the ${formatCount(comparison.comparedDays)} days both weeks have, ${against} the same days last year (${before}).`;
    }
  }
}

// Bar order helper

/**
 * "Last year this week, Thursday to Sunday brought 58% of the week’s guests." Over last year's same week, the
 * share of the days with data that fell Thursday to Sunday. Null when any of Thursday to Sunday has no data.
 */
export function lateWeekShare(input: HomeInput): { share: number; days: number } | null {
  const dates = weekDates(sameWeekdayYearsAgo(mondayOf(input.today), 1));
  const values = dates.map((date) => figureOf(date, input));
  const late = values.slice(3);
  if (late.some((value) => value === null)) return null;
  const known = values.filter((value): value is number => value !== null);
  const total = sum(known);
  if (total <= 0) return null;
  return { share: sum(late.filter((value): value is number => value !== null)) / total, days: known.length };
}

export function lateWeekLine(found: { share: number; days: number }, metric: Metric): string {
  const share = `${formatCount(Math.round(found.share * 100))}%`;
  const days = found.days === 7 ? '' : ` (${formatCount(found.days)} days of that week have data)`;
  return `Last year this week, Thursday to Sunday brought ${share} of the week’s ${METRIC_NOUN[metric]}${days}.`;
}

// This month

export interface MonthFact {
  year: number;
  /** Days of this month in that year with the metric, closed days left out, and their average. */
  days: number;
  /** Open days of that year with the metric, which its daily average is over: fewer than a year when history starts or ends in it. */
  yearDays: number;
  mean: number;
  /** That month's average against the year's daily average; null when the year's average is 0. */
  change: number | null;
}

/** This month in past years, newest first, at most 3: each from the location's own open days. */
export function monthFacts(input: HomeInput): MonthFact[] {
  const year = Number(input.today.slice(0, 4));
  const month = input.today.slice(5, 7);
  const byYear = new Map<number, { month: number[]; all: number[] }>();
  for (const [date, day] of input.byDate) {
    const y = Number(date.slice(0, 4));
    if (y >= year) continue;
    const value = figureOf(date, input);
    if (value === null || dayFlags(date, day, input.context).closed) continue;
    const entry = byYear.get(y) ?? { month: [], all: [] };
    entry.all.push(value);
    if (date.slice(5, 7) === month) entry.month.push(value);
    byYear.set(y, entry);
  }
  return [...byYear.entries()]
    .filter(([, entry]) => entry.month.length > 0)
    .sort(([a], [b]) => b - a)
    .slice(0, MONTH_YEARS)
    .map(([y, entry]) => {
      const mean = sum(entry.month) / entry.month.length;
      const yearMean = sum(entry.all) / entry.all.length;
      return { year: y, days: entry.month.length, yearDays: entry.all.length, mean, change: yearMean === 0 ? null : mean / yearMean - 1 };
    });
}

/** "118 guests a day over 30 days in 2025, 9% below your 2025 daily average over 364 days." */
export function monthFactLine(fact: MonthFact, metric: Metric): string {
  const value = metric === 'guests' ? `${metricNumber(fact.mean, metric)} guests a day` : `${metricNumber(fact.mean, metric)} a day`;
  const head = `${value} over ${plural(fact.days, 'day', 'days')} in ${String(fact.year)}`;
  if (fact.change === null) return `${head}.`;
  const whole = Math.round(fact.change * 100);
  const average = `your ${String(fact.year)} daily average over ${plural(fact.yearDays, 'day', 'days')}`;
  if (whole === 0) return `${head}, level with ${average}.`;
  return `${head}, ${formatCount(Math.abs(whole))}% ${whole > 0 ? 'above' : 'below'} ${average}.`;
}

/** "Your November in past years". */
export function monthFactsHead(today: string): string {
  return `Your ${MONTH_NAMES[Number(today.slice(5, 7)) - 1] ?? ''} in past years`;
}

export interface MonthCell {
  date: string;
  /** A holiday or town event (term and season periods span months, so they mark no day). */
  event: boolean;
  note: boolean;
  inWeek: boolean;
  isToday: boolean;
}

/** This month as week rows, Monday first; null where a row's day is in another month. */
export function monthGrid(today: string, context: DayContext): (MonthCell | null)[][] {
  const { from, to } = monthRange(today.slice(0, 7));
  const monday = mondayOf(today);
  const sunday = addDays(monday, 6);
  const rows: (MonthCell | null)[][] = [];
  for (let start = mondayOf(from); start <= to; start = addDays(start, 7)) {
    rows.push(weekDates(start).map((date) => (date < from || date > to ? null : {
      date,
      event: eventsOf(context, date).some(marksDay),
      note: notesOf(context, date).length > 0,
      inWeek: date >= monday && date <= sunday,
      isToday: date === today,
    })));
  }
  return rows;
}

export type MonthItem =
  | { kind: 'event'; key: string; first: string; dates: string; event: TownEvent }
  | { kind: 'note'; key: string; first: string; dates: string; note: Note };

/** Every event and note on the calendar this month, by the first day of the month each covers. */
export function monthItems(today: string, context: DayContext): MonthItem[] {
  const { from, to } = monthRange(today.slice(0, 7));
  const items = new Map<string, MonthItem>();
  for (let date = from; date <= to; date = addDays(date, 1)) {
    for (const event of eventsOf(context, date)) {
      const key = `event:${event.id}`;
      if (!items.has(key)) items.set(key, { kind: 'event', key, first: date, dates: dayMonthRange(event.start, event.end), event });
    }
    for (const note of notesOf(context, date)) {
      const key = `note:${note.id}`;
      if (!items.has(key)) items.set(key, { kind: 'note', key, first: date, dates: dayMonthRange(note.startDate, note.endDate), note });
    }
  }
  return [...items.values()].sort((a, b) => a.first.localeCompare(b.first));
}

export const EVENT_WORDS: Readonly<Record<TownEvent['kind'], string>> = { holiday: 'Holiday', event: 'Town event', term: 'Term', season: 'Season' };

/** "Veterans Day. Federal holiday." */
export function eventLine(event: Pick<TownEvent, 'title' | 'kind' | 'scope'>): string {
  const kind = event.kind === 'holiday' && event.scope === 'national' ? 'Federal holiday' : EVENT_WORDS[event.kind];
  return `${event.title}. ${kind}.`;
}

/** The lead under the title (home.md 2.1). */
export function leadLine(lastDate: string | null, calendar: Pick<Calendar, 'town' | 'researched' | 'covers'>): string {
  const researched = calendar.town.townId !== null && calendar.researched && calendar.covers !== null;
  const source = researched ? `${calendar.town.name}’s researched calendar` : 'US federal holidays';
  if (lastDate === null) return `No sales history yet. Home shows ${source} and your notes.`;
  return `From your sales through ${shortDate(lastDate)} and ${source}.`;
}
