import { EMPTY_CONTEXT } from '../../../src/portal/analytics/days';
import { byDate, type DayRecord } from '../../../src/portal/analytics/history';
import { forecastRange, thisWeek, weekDates, type HomeInput } from '../../../src/portal/analytics/week';
import { ALL_FILTERS, type CalendarInput } from '../../../src/portal/calendar/model';
import type { ForecastDay, ForecastWindow } from '../../../src/portal/estimates/api';
import type { Metric } from '../../../src/portal/analytics/words';
import { chartShows, weekChart } from '../../../src/portal/home/weekChartData';
import { day, run } from '../analytics/fakes';
import { forecastDay } from '../calendar/fakes';

// This week's chart as data (spec P11, owner request 2026-11-18), on synthetic days: what each day draws, the words
// that stand in for a point, and the scale. Honesty: every figure is the forecast's own or a stored day's; a forecast
// is drawn only in guests, and with nothing published no day says a forecast word.

const TODAY = '2026-11-05';
const DAYS: DayRecord[] = [...run('2025-10-01', '2026-11-04', () => 100), day(TODAY, 120)];

function windowOf(days: ForecastDay[]): ForecastWindow {
  return { available: true, reason: null, runs: [], days, weeks: [] };
}

function chartOf(forecast: ForecastWindow | null, metric: Metric = 'guests', history = true) {
  const home: HomeInput = { today: TODAY, byDate: byDate(DAYS), context: EMPTY_CONTEXT, metric, lastDate: TODAY };
  const input: CalendarInput = {
    today: TODAY, covered: forecastRange(TODAY), forecast, salesDays: [], events: [], notes: [], rules: [], imported: [], filters: ALL_FILTERS,
  };
  return weekChart(thisWeek(home, input), input, metric, forecast?.available === true, history);
}

const WEEK = weekDates(TODAY);

test('open days draw their middle and range, the actual is today’s stored figure, and last year is each same weekday', () => {
  const chart = chartOf(windowOf(WEEK.map((date) => forecastDay({ date, low: 180.4, mid: 212.2, high: 240.6 }))));
  expect(chart.days.map((each) => each.point)).toEqual(WEEK.map(() => ({ low: 180.4, mid: 212.2, high: 240.6 })));
  expect(chart.days.map((each) => each.actual)).toEqual([120, null, null, null, null, null, null]);
  expect(chart.days.map((each) => each.lastYear)).toEqual([100, 100, 100, 100, 100, 100, 100]);
  expect(chart.days.every((each) => each.status === null)).toBe(true);
  expect(chart.top).toBe(250);
  expect(chart.drawn).toEqual({ forecast: true, actual: true, lastYear: true });
});

test('closed, booked (with your buyout’s party) and uncovered days say so instead of a point', () => {
  const [thu, fri, sat] = WEEK;
  const buyout = forecastDay({
    date: sat ?? '', status: 'booked', low: null, mid: null, high: null, noteGuests: 40,
    reasons: [{ kind: 'note', label: 'Your private buyout', effectPct: null, sources: [], note: { id: 'n1', guests: 40, outcome: 'booked' } }],
  });
  const chart = chartOf(windowOf([forecastDay({ date: thu ?? '' }), forecastDay({ date: fri ?? '', status: 'closed', low: null, mid: null, high: null }), buyout]));
  expect(chart.days.map((each) => each.status)).toEqual([null, ['Closed'], ['Booked', '~40 guests'], ['No forecast'], ['No forecast'], ['No forecast'], ['No forecast']]);
  expect(chart.days.slice(1).every((each) => each.point === null)).toBe(true);
  // A booked day that isn't your buyout has no party to give.
  const other = chartOf(windowOf([forecastDay({ date: sat ?? '', status: 'booked', low: null, mid: null, high: null, reasons: [] })]));
  expect(other.days[2]?.status).toEqual(['Booked']);
});

test('an outlook day draws like an open one and its label says Outlook', () => {
  const chart = chartOf(windowOf([forecastDay({ date: TODAY, outlook: true })]));
  expect(chart.days[0]?.point).toEqual({ low: 180, mid: 212, high: 240 });
  expect(chart.days[0]?.label).toContain('Outlook: 212 guests, forecast, likely 180 to 240.');
});

test('in net sales the forecast (in guests) is not drawn on the scale, and its days keep no gap words', () => {
  const chart = chartOf(windowOf(WEEK.map((date) => forecastDay({ date }))), 'netSales');
  expect(chart.days.every((each) => each.point === null && each.status === null)).toBe(true);
  expect(chart.drawn.forecast).toBe(false);
});

test('with nothing published no day says a word, and with no history last year is neither drawn nor said', () => {
  const unpublished = chartOf({ available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [] });
  expect(unpublished.days.every((each) => each.status === null && each.point === null)).toBe(true);
  const bare = chartOf(null, 'guests', false);
  expect(bare.days.every((each) => each.lastYear === null)).toBe(true);
  expect(bare.days[1]?.label).toBe('Fri, Nov 6, 2026.');
  // The scale fits what is drawn: today's 120 alone.
  expect(bare.top).toBe(200);
});

test('the chart shows only when it draws something, and the forecast when one is published', () => {
  const open = windowOf(WEEK.map((date) => forecastDay({ date })));
  expect(chartShows(chartOf(open), true)).toBe(true);
  // In net sales the forecast is not drawn, so the days (with their Forecast row) stay in view, last year or not.
  expect(chartShows(chartOf(open, 'netSales'), true)).toBe(false);
  // Nothing published: last year or today's figure is enough.
  expect(chartShows(chartOf(null), false)).toBe(true);
  expect(chartShows(chartOf(null, 'guests', false), false)).toBe(true);
  // Nothing at all to draw: no forecast, no last year, no figure for today.
  const empty = { ...chartOf(null, 'guests', false), drawn: { forecast: false, actual: false, lastYear: false } };
  expect(chartShows(empty, false)).toBe(false);
});
