import { scaleTop } from '../analytics/chartScale';
import { YEAR_DAYS } from '../analytics/week';
import type { PlotDay, PlotDrawn } from '../chart/ForecastPlot';
import { addDays } from '../locations/dates';
import type { SalesDay } from '../locations/api';
import type { DateRange } from './grid';
import { backtestDayOf, figureOf, statusWord, type CalendarInput } from './model';

// The Calendar's forecast chart as data (P28, D64), pure: for each date, what chart/ForecastPlot.tsx draws, in guests.
// The point is the forecast read's own day (its low, middle and high) on an open day, past days included, so a past
// day's stored guests (the actual) sit beside the forecast the run made for it; an outlook day (D52) is marked. The
// words in a point's place are the cell's status word (Closed, Booked, Likely closed, No data, No forecast), as figureOf
// decides it, so they wait for the forecast read as the cells' words do. The same weekday last year is the stored
// guests 364 days earlier (analytics/week.ts YEAR_DAYS), from the page's own read of them (lastYearRange). A day the
// reads don't cover yet draws nothing. Nothing here estimates, sums or adjusts a figure. A past date no run covers draws
// the backtest's figure for it when the input shows them (D72, model.ts backtestDayOf), marked `backtest` so the plot
// draws it apart from a real forecast and the key names it.

export interface CalendarChartDay extends PlotDay {
  isToday: boolean;
  outlook: boolean;
  /** D72: the point is the backtest's, on a past date no run covers. */
  backtest: boolean;
  /** The status word drawn in the day's place: none on an open or outlook day, or while the forecast reads. */
  status: string | null;
  /** The reads don't cover the day yet. */
  pending: boolean;
}

export interface CalendarChart {
  days: CalendarChartDay[];
  /** The scale's round top over every drawn figure. */
  top: number;
  drawn: Required<PlotDrawn>;
}

/**
 * What the page reads for the chart's same weekday last year: the range's days 364 days earlier, up to yesterday;
 * null when every one of them is today or later (a range more than a year ahead).
 */
export function lastYearRange(range: DateRange, today: string): DateRange | null {
  const yesterday = addDays(today, -1);
  const from = addDays(range.from, -YEAR_DAYS);
  const back = addDays(range.to, -YEAR_DAYS);
  const to = back < yesterday ? back : yesterday;
  return from > to ? null : { from, to };
}

/**
 * The chart's days for `dates` from the page's reads. `lastYear`: the stored days of lastYearRange, or null while
 * they are unread or when their read failed, so no day draws last year.
 */
export function calendarChart(dates: readonly string[], input: CalendarInput, lastYear: readonly SalesDay[] | null): CalendarChart {
  const days = dates.map((date): CalendarChartDay => {
    const isToday = date === input.today;
    if (date < input.covered.from || date > input.covered.to) {
      return { date, isToday, pending: true, point: null, outlook: false, backtest: false, actual: null, lastYear: null, status: null };
    }
    const found = figureOf(date, input);
    const read = input.forecast?.days.find((day) => day.date === date) ?? null;
    const open = found.status === null || found.status === 'outlook';
    const backtest = open && read === null ? backtestDayOf(date, input) : null;
    const point = open && read !== null && read.status === 'open' && read.low !== null && read.mid !== null && read.high !== null
      ? { low: read.low, mid: read.mid, high: read.high }
      : backtest === null ? null : { low: backtest.low, mid: backtest.mid, high: backtest.high };
    const actual = date < input.today ? input.salesDays.find((day) => day.date === date)?.guests ?? null : null;
    const before = lastYear?.find((day) => day.date === addDays(date, -YEAR_DAYS))?.guests ?? null;
    return {
      date, isToday, pending: false, point, outlook: point !== null && read?.outlook === true, backtest: backtest !== null, actual, lastYear: before,
      status: open ? null : statusWord(found.status),
    };
  });
  const values = days.flatMap((day) => [day.point?.high ?? null, day.actual, day.lastYear]).filter((value): value is number => value !== null);
  return { days, top: scaleTop(Math.max(0, ...values)), drawn: chartDrawn(days) };
}

/** Which series `days` draw, for the key: the week view's key names those of the 7 days in view. */
export function chartDrawn(days: readonly CalendarChartDay[]): Required<PlotDrawn> {
  return {
    forecast: days.some((day) => day.point !== null && !day.backtest),
    actual: days.some((day) => day.actual !== null),
    lastYear: days.some((day) => day.lastYear !== null),
    outlook: days.some((day) => day.outlook),
    backtest: days.some((day) => day.point !== null && day.backtest),
  };
}

/** Whether the chart draws anything: with nothing to draw it is left out. */
export function chartDraws(chart: CalendarChart): boolean {
  return chart.drawn.forecast || chart.drawn.backtest || chart.drawn.actual || chart.drawn.lastYear;
}

/** Whether the chart draws a forecast or a backtest (D72) somewhere. */
export function drawsForecast(chart: Pick<CalendarChart, 'drawn'>): boolean {
  return chart.drawn.forecast || chart.drawn.backtest;
}

/**
 * The month chart's upright words: each day's status word while the chart draws a forecast or a backtest somewhere,
 * else none, since a month with neither would be a column of words per day that the grid already says; the chart says
 * it once under the plot instead (MonthChart.tsx), in one line, “No forecast for these days.” (owner decision,
 * 2026-11-19).
 */
export function chartWords(chart: CalendarChart): (string | null)[] {
  return chart.days.map((day) => (drawsForecast(chart) ? day.status : null));
}

/** A day's slice of the chart in the week view: the day with its neighbors either side, and where it is among them. */
export interface ChartWindow { days: CalendarChartDay[]; at: number; top: number }

/**
 * Each day's slice (D64), by date: the day and its neighbors, which its lines run on to, so each of the week strip's
 * columns draws a constant few days however long the strip grows, rather than all of them.
 */
export function chartWindows(chart: CalendarChart): Map<string, ChartWindow> {
  return new Map(chart.days.map((day, index) => {
    const from = Math.max(0, index - 1);
    return [day.date, { days: chart.days.slice(from, index + 2), at: index - from, top: chart.top }];
  }));
}
