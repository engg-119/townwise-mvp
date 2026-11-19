import { scaleTop } from '../analytics/chartScale';
import { pastDayLine, type ThisWeek, type WeekRow } from '../analytics/week';
import { shortDate, type Metric } from '../analytics/words';
import { dayEntries } from '../calendar/entries';
import { entryLabel, figureLabel, figureOf, markedFigure, type CalendarInput } from '../calendar/model';
import type { ForecastDay } from '../estimates/api';
import { plural } from '../format';

// This week's chart (spec P11, owner request 2026-11-18), as pure data: for each of This week's seven days, the
// published forecast's middle and range to draw (in guests), the words that stand in a day's place when there is no
// point (Closed, Booked with a buyout's party, No forecast), the stored figure as the actual, the same weekday last
// year, and the full label a screen reader hears. Every figure is one Home already shows: the forecast's own (as
// calendar/model.ts figureOf reads it from Home's one CalendarInput), This week's stored day and last year's
// (analytics/week.ts). Nothing here estimates, sums or adjusts a figure.

export interface ChartDay {
  date: string;
  isToday: boolean;
  row: WeekRow;
  /** The published day; null when the read has none for it, has not answered, or nothing is published. */
  forecast: ForecastDay | null;
  /**
   * The forecast to draw: the day's middle and its range as the location's notes leave it (the words' own figures). Null
   * for a closed or booked day, a day with no figure, and when Home's metric is not guests (forecasts are in guests).
   */
  point: { low: number; mid: number; high: number } | null;
  /** The words drawn in the day's place instead of a point: “Closed”, “Booked” (and a buyout's party), “No forecast”. */
  status: string[] | null;
  /** This week's own stored figure in Home's metric (only today can have one), drawn beside the forecast. */
  actual: number | null;
  /** The same weekday 52 weeks earlier, in Home's metric. */
  lastYear: number | null;
  /** Everything the day's column shows, and its calendar, in words. */
  label: string;
}

export interface WeekChart {
  days: ChartDay[];
  /** The scale's round top, over every drawn figure. */
  top: number;
  /** Which series have at least one figure drawn, for the key. */
  drawn: { forecast: boolean; actual: boolean; lastYear: boolean };
}

function withStop(words: string): string {
  return /[.!?]$/.test(words) ? words : `${words}.`;
}

/**
 * The chart's days. `published`: a published forecast is in `input.forecast` (with none, no day draws a status word,
 * as the strip shows no Forecast row). `history`: the location has stored days, so last year is said.
 */
export function weekChart(week: Pick<ThisWeek, 'rows'>, input: CalendarInput, metric: Metric, published: boolean, history: boolean): WeekChart {
  const guests = metric === 'guests';
  const days = week.rows.map((row): ChartDay => {
    const found = figureOf(row.date, input, metric);
    const forecast = input.forecast?.days.find((day) => day.date === row.date) ?? null;
    const point = guests && forecast !== null && found.figure?.kind === 'forecast' && forecast.low !== null && forecast.mid !== null && forecast.high !== null
      ? { low: forecast.low, mid: forecast.mid, high: forecast.high } : null;
    let status: string[] | null = null;
    if (published && found.status === 'closed') status = ['Closed'];
    if (published && found.status === 'booked') {
      status = found.figure === null ? ['Booked'] : ['Booked', markedFigure(plural(found.figure.value, 'guest', 'guests'), found.figure)];
    }
    if (published && found.status === 'no_forecast') status = ['No forecast'];
    const actual = row.value;
    const lastYear = history ? row.lastYear.value : null;
    const past = pastDayLine(row.lastYear, metric);
    const label = [
      `${shortDate(row.date)}.`,
      row.isToday ? 'Today.' : null,
      found.words,
      actual === null ? null : withStop(figureLabel(actual, { kind: 'actual' }, metric)),
      history ? (past === null ? 'No data for the same weekday last year.' : `Same weekday last year, ${past}.`) : null,
      ...dayEntries(row.date, input).map(entryLabel),
    ].filter((part) => part !== null).join(' ');
    return { date: row.date, isToday: row.isToday, row, forecast, point, status, actual, lastYear, label };
  });
  const values = days.flatMap((day) => [day.point?.high ?? null, day.actual, day.lastYear]).filter((value): value is number => value !== null);
  return {
    days,
    top: scaleTop(Math.max(0, ...values)),
    drawn: {
      forecast: days.some((day) => day.point !== null),
      actual: days.some((day) => day.actual !== null),
      lastYear: days.some((day) => day.lastYear !== null),
    },
  };
}

/**
 * Whether This week shows the chart in place of its days: only when it draws something, and, with a forecast published,
 * only when it draws that forecast (in guests). Otherwise the strip or table stays in view (with its Forecast row when
 * one is published), and an empty plot never stands in for it (no last year yet, today not in, or a forecast in net
 * sales).
 */
export function chartShows(chart: WeekChart, published: boolean): boolean {
  if (published) return chart.drawn.forecast;
  return chart.drawn.lastYear || chart.drawn.actual;
}
