import { formatDate, plural } from '../format';
import { addDays, formatMonth } from '../locations/dates';
import { formatDollars, SERIES_TITLE, valueOf } from '../locations/sales';
import type { Calendar } from './api';
import { closedDaysBetween, dayFlags, eventsOf, notesOf, type DayContext } from './days';
import type { Included, Marks } from './filters';
import type { DayRecord } from './history';
import { levelsFor, type Level } from './levels';
import { listText, metricNumber, shortDate, weekdayOf, type Metric } from './words';

// The heatmap as data (home.md 4.4): one block per shown year, newest first, laid out as week columns by weekday
// rows (Monday first), each cell with its state, fill level, marks and full text label; the keyboard moves; and the
// summary under the grid. Heatmap.web.tsx and Heatmap.tsx draw this and add nothing to it. Color never stands
// alone: every focusable cell's label says everything its fill and marks show.

export type CellState =
  /** A value the filters keep, drawn at its level. */
  | 'value'
  /** No stored row, or no value for the metric. */
  | 'no_data'
  /** A value the "Include in the numbers" filters leave out. */
  | 'left_out'
  /** A closed day, while the Closures mark is on. */
  | 'closed'
  /** Reading only: a day in the range still being read. */
  | 'pending'
  /** After today: blank and never focusable. */
  | 'future';

export interface Cell {
  date: string;
  /** 0 Monday to 6 Sunday. */
  row: number;
  col: number;
  state: CellState;
  /** Only for `value`. */
  level: Level | null;
  /** A holiday or town event, as the marks allow. */
  eventMark: boolean;
  noteMark: boolean;
  /** Empty for a future day. */
  label: string;
  focusable: boolean;
}

export interface YearBlock {
  year: number;
  /** Week columns: 53, or 54 when a leap year starts on a Sunday. */
  weeks: number;
  /** Seven rows, Monday first, each `weeks` long; null where the column has no day of this year. */
  rows: (Cell | null)[][];
  /** The column each month starts in, for the labels above the grid. */
  months: { month: number; col: number }[];
  /** "2026, daily guests": the grid's accessible name. */
  label: string;
}

export interface HeatmapInput {
  days: readonly DayRecord[];
  metric: Metric;
  marks: Marks;
  context: DayContext;
  included: Included;
  /** The years to show. */
  years: readonly number[];
  /** The viewer's day; later days are blank. */
  today: string;
  pending?: { from: string; to: string } | undefined;
}

/** 0 Monday to 6 Sunday. */
export function rowOf(date: string): number {
  return (weekdayOf(date) + 6) % 7;
}

function dayIndex(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${date.slice(0, 4)}-01-01T00:00:00.000Z`)) / 86_400_000);
}

/** The week column of a day within its year's block. */
export function colOf(date: string): number {
  return Math.floor((dayIndex(date) + rowOf(`${date.slice(0, 4)}-01-01`)) / 7);
}

const BLOCK_NOUN: Readonly<Record<Metric, string>> = { guests: 'daily guests', netSales: 'daily net sales' };

function valuesText(day: DayRecord | undefined): string {
  if (day === undefined) return 'No data.';
  const parts = [
    day.guests === null ? null : plural(day.guests, 'guest', 'guests'),
    day.netSalesCents === null ? null : formatDollars(day.netSalesCents),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? 'No data.' : `${parts.join(', ')}.`;
}

function titled(one: string, many: string, titles: readonly string[]): string | null {
  return titles.length === 0 ? null : `${titles.length === 1 ? one : many}: ${listText(titles)}.`;
}

/**
 * The cell's label: "Sat, Nov 21, 2026. 241 guests, $5,210. Town event: Home football vs Brown. 1 note. Closed.
 * Left out by your filters." with only the parts that apply and that the marks show.
 */
export function cellLabel(
  date: string, day: DayRecord | undefined, input: Pick<HeatmapInput, 'metric' | 'marks' | 'context' | 'included'>, pending: boolean,
): string {
  if (pending && day === undefined) return `${shortDate(date)}. Not read yet.`;
  const flags = dayFlags(date, day, input.context);
  const events = eventsOf(input.context, date);
  const notes = notesOf(input.context, date);
  const hasValue = day !== undefined && valueOf(day, input.metric) !== null;
  const parts = [
    `${shortDate(date)}.`,
    valuesText(day),
    input.marks.holidays ? titled('Holiday', 'Holidays', events.filter((event) => event.kind === 'holiday').map((event) => event.title)) : null,
    input.marks.townEvents ? titled('Town event', 'Town events', events.filter((event) => event.kind === 'event').map((event) => event.title)) : null,
    input.marks.notes && notes.length > 0 ? `${plural(notes.length, 'note', 'notes')}.` : null,
    input.marks.closures && flags.closed ? (flags.likelyClosed ? 'Likely closed.' : 'Closed.') : null,
    hasValue && !input.included(date) ? 'Left out by your filters.' : null,
  ];
  return parts.filter((part): part is string => part !== null).join(' ');
}

/** The fill levels come from the kept values in the shown years, so every block shares one scale. */
function levelOf(input: HeatmapInput): (value: number) => Level {
  const years = new Set(input.years);
  const values: number[] = [];
  for (const day of input.days) {
    const value = valueOf(day, input.metric);
    if (value !== null && years.has(Number(day.date.slice(0, 4))) && input.included(day.date)) values.push(value);
  }
  return levelsFor(values);
}

export function heatmapBlocks(input: HeatmapInput): YearBlock[] {
  const byDate = new Map(input.days.map((day) => [day.date, day]));
  const level = levelOf(input);
  const years = [...new Set(input.years)].sort((a, b) => b - a);
  return years.map((year) => {
    const first = `${String(year)}-01-01`;
    const last = `${String(year)}-12-31`;
    const weeks = colOf(last) + 1;
    const rows: (Cell | null)[][] = Array.from({ length: 7 }, () => Array.from({ length: weeks }, () => null));
    const months: { month: number; col: number }[] = [];
    for (let date = first; date <= last; date = addDays(date, 1)) {
      const row = rowOf(date);
      const col = colOf(date);
      if (date.endsWith('-01')) months.push({ month: Number(date.slice(5, 7)), col });
      const cells = rows[row];
      if (cells !== undefined) cells[col] = cellOf(date, byDate.get(date), input, level, row, col);
    }
    return { year, weeks, rows, months, label: `${String(year)}, ${BLOCK_NOUN[input.metric]}` };
  });
}

function cellOf(
  date: string, day: DayRecord | undefined, input: HeatmapInput, level: (value: number) => Level, row: number, col: number,
): Cell {
  const base = { date, row, col, level: null, eventMark: false, noteMark: false };
  if (date > input.today) return { ...base, state: 'future', label: '', focusable: false };
  const pending = input.pending !== undefined && input.pending.from <= date && date <= input.pending.to;
  const events = eventsOf(input.context, date);
  const marks = {
    eventMark: (input.marks.holidays && events.some((event) => event.kind === 'holiday'))
      || (input.marks.townEvents && events.some((event) => event.kind === 'event')),
    noteMark: input.marks.notes && notesOf(input.context, date).length > 0,
  };
  const label = cellLabel(date, day, input, pending);
  const value = day === undefined ? null : valueOf(day, input.metric);
  let state: CellState;
  if (pending && day === undefined) state = 'pending';
  else if (input.marks.closures && dayFlags(date, day, input.context).closed) state = 'closed';
  else if (value === null) state = 'no_data';
  else if (!input.included(date)) state = 'left_out';
  else return { ...base, ...marks, state: 'value', level: level(value), label, focusable: true };
  return { ...base, ...marks, state, label, focusable: true };
}

// Keyboard

export interface FocusBounds {
  /** January 1 of the earliest shown year. */
  first: string;
  /** Today, or December 31 of the latest shown year when that is earlier. */
  last: string;
  /** The first and last stored day in the shown years, for Ctrl+Home and Ctrl+End; null with none. */
  firstData: string | null;
  lastData: string | null;
  years: readonly number[];
}

export function focusBounds(days: readonly DayRecord[], years: readonly number[], today: string): FocusBounds | null {
  if (years.length === 0) return null;
  const sorted = [...years].sort((a, b) => a - b);
  const first = `${String(sorted[0] ?? 0)}-01-01`;
  const end = `${String(sorted.at(-1) ?? 0)}-12-31`;
  const last = today < end ? today : end;
  if (last < first) return null;
  const shown = new Set(sorted);
  const inShown = days.filter((day) => shown.has(Number(day.date.slice(0, 4))) && day.date <= last);
  return { first, last, firstData: inShown[0]?.date ?? null, lastData: inShown.at(-1)?.date ?? null, years: sorted };
}

/** Where focus starts: the selected day when it can take focus, else the last day with data, else the last day. */
export function initialFocus(selected: string | null | undefined, bounds: FocusBounds): string {
  if (selected !== null && selected !== undefined && canFocus(selected, bounds)) return selected;
  return bounds.lastData ?? bounds.last;
}

export function canFocus(date: string, bounds: FocusBounds): boolean {
  return date >= bounds.first && date <= bounds.last && bounds.years.includes(Number(date.slice(0, 4)));
}

function clampToYear(date: string, year: string, bounds: FocusBounds): string {
  const low = `${year}-01-01` > bounds.first ? `${year}-01-01` : bounds.first;
  const high = `${year}-12-31` < bounds.last ? `${year}-12-31` : bounds.last;
  if (date < low) return low;
  return date > high ? high : date;
}

/**
 * The day a key moves focus to, or null when the key is not one of the heatmap's: arrows move a day (up and down)
 * or a week (left and right), Home and End go to that week's Monday and Sunday within the year, PageUp and PageDown
 * the same weekday 52 weeks away, Ctrl+Home and Ctrl+End the first and last day with data. A move that would leave
 * the shown days keeps focus where it is.
 */
export function moveFocus(date: string, key: string, ctrl: boolean, bounds: FocusBounds): string | null {
  const step = (days: number): string => {
    const next = addDays(date, days);
    return canFocus(next, bounds) ? next : date;
  };
  switch (key) {
    case 'ArrowUp': return step(-1);
    case 'ArrowDown': return step(1);
    case 'ArrowLeft': return step(-7);
    case 'ArrowRight': return step(7);
    case 'PageUp': return step(-364);
    case 'PageDown': return step(364);
    case 'Home': return ctrl ? (bounds.firstData ?? date) : clampToYear(addDays(date, -rowOf(date)), date.slice(0, 4), bounds);
    case 'End': return ctrl ? (bounds.lastData ?? date) : clampToYear(addDays(date, 6 - rowOf(date)), date.slice(0, 4), bounds);
    default: return null;
  }
}

// Summary

/**
 * The calendar part of the summary: what the town marks cover. "Town events are marked for Sep 2026 to Jan 2027,
 * the dates Townwise's Hanover calendar covers so far."
 */
export function calendarCoverageLine(calendar: Pick<Calendar, 'town' | 'researched' | 'covers'>): string {
  const { town, covers } = calendar;
  if (town.townId === null) return `Townwise hasn’t researched ${town.name}, ${town.state} yet, so only US federal holidays are marked.`;
  if (!calendar.researched || covers === null) return `Townwise’s ${town.name} calendar has no researched town events yet, so only US federal holidays are marked.`;
  const from = formatMonth(covers.from.slice(0, 7));
  const to = formatMonth(covers.to.slice(0, 7));
  const span = from === to ? from : `${from} to ${to}`;
  return `Town events are marked for ${span}, the dates Townwise’s ${town.name} calendar covers so far.`;
}

/**
 * The text under the grid: "Daily guests, Jan 1, 2024 to Nov 4, 2026. Busiest: 312 on Sat, Oct 24, 2026. Quietest
 * open day: 41 on Mon, Jan 8, 2024. 4 closed days." then the calendar line. Busiest and quietest are over the kept
 * days; null when the shown years have no stored day.
 */
export function heatmapSummary(
  input: Pick<HeatmapInput, 'days' | 'metric' | 'context' | 'included' | 'years'>, calendar: Pick<Calendar, 'town' | 'researched' | 'covers'> | null,
): string | null {
  const years = new Set(input.years);
  const shown = input.days.filter((day) => years.has(Number(day.date.slice(0, 4))));
  const first = shown[0];
  const last = shown.at(-1);
  if (first === undefined || last === undefined) return null;
  const byDate = new Map(input.days.map((day) => [day.date, day]));
  let busiest: { date: string; value: number } | null = null;
  let quietest: { date: string; value: number } | null = null;
  for (const day of shown) {
    const value = valueOf(day, input.metric);
    if (value === null || !input.included(day.date)) continue;
    if (busiest === null || value > busiest.value) busiest = { date: day.date, value };
    if (dayFlags(day.date, day, input.context).closed) continue;
    if (quietest === null || value < quietest.value) quietest = { date: day.date, value };
  }
  const closed = closedDaysBetween(first.date, last.date, years, byDate, input.context);
  const parts = [
    `${SERIES_TITLE[input.metric]}, ${formatDate(first.date)} to ${formatDate(last.date)}.`,
    busiest === null ? null : `Busiest: ${metricNumber(busiest.value, input.metric)} on ${shortDate(busiest.date)}.`,
    quietest === null ? null : `Quietest open day: ${metricNumber(quietest.value, input.metric)} on ${shortDate(quietest.date)}.`,
    closed === 0 ? null : `${plural(closed, 'closed day', 'closed days')}.`,
    calendar === null ? null : calendarCoverageLine(calendar),
  ];
  return parts.filter((part): part is string => part !== null).join(' ');
}

// The numbers behind the cells

export interface MonthRow {
  /** "2026-11". */
  month: string;
  /** Days with a value for the metric. */
  days: number;
  total: number;
  mean: number;
}

/** Printed by native's month list, whose averages are heatmapMonths', so they never seem to contradict the basis line. */
export const MONTH_ROWS_LINE = 'Month averages count every day with a value in the years you checked, including days your filters leave out.';

/**
 * Per month of the shown years with a value for the metric, newest first: the days, their total and their average.
 * Every value counts, kept or left out by the filters, because this is the table behind the cells ("Show the
 * numbers" on web, the month list on native).
 */
export function heatmapMonths(input: Pick<HeatmapInput, 'days' | 'metric' | 'years'>): MonthRow[] {
  const years = new Set(input.years);
  const sums = new Map<string, { days: number; total: number }>();
  for (const day of input.days) {
    const value = valueOf(day, input.metric);
    if (value === null || !years.has(Number(day.date.slice(0, 4)))) continue;
    const month = day.date.slice(0, 7);
    const sum = sums.get(month) ?? { days: 0, total: 0 };
    sums.set(month, { days: sum.days + 1, total: sum.total + value });
  }
  return [...sums.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([month, sum]) => ({ month, days: sum.days, total: sum.total, mean: sum.total / sum.days }));
}
