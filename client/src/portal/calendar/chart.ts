import { scaleTop } from '../analytics/chartScale';
import { YEAR_DAYS } from '../analytics/week';
import type { PlotDay, PlotDrawn } from '../chart/ForecastPlot';
import { addDays } from '../locations/dates';
import type { SalesDay } from '../locations/api';
import type { DateRange } from './grid';
import { figureOf, statusWord, type CalendarInput } from './model';

// The Calendar's forecast chart as data (P28, D64), pure: for each date, what chart/ForecastPlot.tsx draws, in guests.
// The point is the forecast read's own day (its low, middle and high) on an open day, past days included, so a past
// day's stored guests (the actual) sit beside the forecast the run made for it; an outlook day (D52) is marked. The
// words in a point's place are the cell's status word (Closed, Booked, Likely closed, No data, No forecast), as figureOf
// decides it, so they wait for the forecast read as the cells' words do. The same weekday last year is the stored
// guests 364 days earlier (analytics/week.ts YEAR_DAYS), from the page's own read of them (lastYearRange). A day the
// reads don't cover yet draws nothing. Nothing here estimates, sums or adjusts a figure.

export interface CalendarChartDay extends PlotDay {
  isToday: boolean;
  outlook: boolean;
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
      return { date, isToday, pending: true, point: null, outlook: false, actual: null, lastYear: null, status: null };
    }
    const found = figureOf(date, input);
    const read = input.forecast?.days.find((day) => day.date === date) ?? null;
    const open = found.status === null || found.status === 'outlook';
    const point = open && read !== null && read.status === 'open' && read.low !== null && read.mid !== null && read.high !== null
      ? { low: read.low, mid: read.mid, high: read.high } : null;
    const actual = date < input.today ? input.salesDays.find((day) => day.date === date)?.guests ?? null : null;
    const before = lastYear?.find((day) => day.date === addDays(date, -YEAR_DAYS))?.guests ?? null;
    return {
      date, isToday, pending: false, point, outlook: point !== null && read?.outlook === true, actual, lastYear: before,
      status: open ? null : statusWord(found.status),
    };
  });
  const values = days.flatMap((day) => [day.point?.high ?? null, day.actual, day.lastYear]).filter((value): value is number => value !== null);
  return {
    days,
    top: scaleTop(Math.max(0, ...values)),
    drawn: {
      forecast: days.some((day) => day.point !== null),
      actual: days.some((day) => day.actual !== null),
      lastYear: days.some((day) => day.lastYear !== null),
      outlook: days.some((day) => day.outlook),
    },
  };
}

/** Whether the chart draws anything: with nothing to draw it is left out. */
export function chartDraws(chart: CalendarChart): boolean {
  return chart.drawn.forecast || chart.drawn.actual || chart.drawn.lastYear;
}
