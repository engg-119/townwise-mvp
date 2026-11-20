import { calendarChart, chartDrawn, chartDraws, chartWindows, chartWords, drawsForecast, lastYearRange } from '../../../src/portal/calendar/chart';
import { ALL_FILTERS, type CalendarInput } from '../../../src/portal/calendar/model';
import type { BacktestDay, ForecastWindow } from '../../../src/portal/estimates/api';
import type { SalesDay } from '../../../src/portal/locations/api';
import { forecastDay, forecastOf } from './fakes';

// The Calendar's forecast chart as data (P28, D64), on synthetic days: what each day draws (the forecast's middle and
// range, past days too, an outlook day marked), the guests stored for a past day, the same weekday last year, the
// words in a point's place (none in a chart with no forecast point), nothing for a day whose reads are in flight, the
// scale, each day's slice for the week view (the day and its neighbors), and what a run of days draws for the key.
// Every figure is a read's own.
// Today is Wed, Nov 11, 2026.

const TODAY = '2026-11-11';

function windowOf(days: Parameters<typeof forecastOf>[0]): ForecastWindow {
  return forecastOf(days) as ForecastWindow;
}

function stored(date: string, guests: number | null): SalesDay {
  return { date, guests, netSalesCents: guests === null ? null : guests * 2000 };
}

function input(fields: Partial<CalendarInput> = {}): CalendarInput {
  return {
    today: TODAY, covered: { from: '2026-11-01', to: '2026-11-30' }, forecast: windowOf([]), salesDays: [], events: [], notes: [], rules: [],
    imported: [], filters: ALL_FILTERS, ...fields,
  };
}

test('an open day draws its middle and range; an outlook day draws its wider range marked as outlook', () => {
  const chart = calendarChart(['2026-11-12', '2026-11-13'], input({
    forecast: windowOf([forecastDay({ date: '2026-11-12' }), forecastDay({ date: '2026-11-13', low: 150, mid: 212, high: 290, outlook: true })]),
  }), null);
  expect(chart.days.map((day) => day.point)).toEqual([{ low: 180, mid: 212, high: 240 }, { low: 150, mid: 212, high: 290 }]);
  expect(chart.days.map((day) => day.outlook)).toEqual([false, true]);
  expect(chart.days.map((day) => day.status)).toEqual([null, null]);
  expect(chart.drawn).toEqual({ forecast: true, actual: false, lastYear: false, outlook: true, backtest: false });
  expect(chart.top).toBe(500);
});

test('closed, booked and uncovered days say so in words and draw no point', () => {
  const chart = calendarChart(['2026-11-12', '2026-11-13', '2026-11-14'], input({
    forecast: windowOf([
      forecastDay({ date: '2026-11-12', status: 'closed', low: null, mid: null, high: null }),
      forecastDay({ date: '2026-11-13', status: 'booked', low: null, mid: null, high: null, noteGuests: 40 }),
    ]),
  }), null);
  expect(chart.days.map((day) => day.status)).toEqual(['Closed', 'Booked', 'No forecast']);
  expect(chart.days.every((day) => day.point === null)).toBe(true);
  expect(chartDraws(chart)).toBe(false);
});

test('a past day draws its stored guests beside the forecast the run made for it; with neither it says No data', () => {
  const chart = calendarChart(['2026-11-09', '2026-11-10'], input({
    forecast: windowOf([forecastDay({ date: '2026-11-09', low: 100, mid: 120, high: 140 })]),
    salesDays: [stored('2026-11-09', 131)],
  }), null);
  expect(chart.days[0]).toMatchObject({ point: { low: 100, mid: 120, high: 140 }, actual: 131, status: null, isToday: false });
  expect(chart.days[1]).toMatchObject({ point: null, actual: null, status: 'No data' });
  expect(chart.drawn.actual).toBe(true);
  expect(chart.top).toBe(200);
});

test('a likely closed day keeps its stored guests and says Likely closed, with no forecast point', () => {
  const wednesdays = Array.from({ length: 8 }, (_, at) => {
    // The 8 Wednesdays before Nov 4: Sep 9 to Oct 28.
    const date = new Date(Date.UTC(2026, 8, 9 + at * 7)).toISOString().slice(0, 10);
    return stored(date, 100);
  });
  const chart = calendarChart(['2026-11-04'], input({
    forecast: windowOf([forecastDay({ date: '2026-11-04', low: 90, mid: 100, high: 110 })]),
    salesDays: [...wednesdays, stored('2026-11-04', 2)],
  }), null);
  expect(chart.days[0]).toMatchObject({ status: 'Likely closed', point: null, actual: 2 });
});

test('the same weekday last year is the stored guests 364 days before; with no read it is not drawn', () => {
  const dates = ['2026-11-12', '2026-11-13'];
  const reads = input({ forecast: windowOf([forecastDay({ date: '2026-11-12' })]) });
  const chart = calendarChart(dates, reads, [stored('2025-11-13', 96), stored('2025-11-14', null)]);
  expect(chart.days.map((day) => day.lastYear)).toEqual([96, null]);
  expect(chart.drawn.lastYear).toBe(true);
  expect(calendarChart(dates, reads, null).days.map((day) => day.lastYear)).toEqual([null, null]);
});

test('a day its reads don’t cover yet draws nothing and is pending; today is marked', () => {
  const chart = calendarChart(['2026-11-11', '2026-12-01'], input({ forecast: windowOf([forecastDay({ date: '2026-11-11' })]) }), [stored('2025-12-02', 80)]);
  expect(chart.days[0]?.isToday).toBe(true);
  expect(chart.days[1]).toMatchObject({ pending: true, point: null, actual: null, lastYear: null, status: null });
});

test('while the forecast read loads or after it failed, no day says a forecast word', () => {
  const chart = calendarChart(['2026-11-12', '2026-11-10'], input({ forecast: null }), null);
  expect(chart.days.map((day) => day.status)).toEqual([null, null]);
  expect(chartDraws(chart)).toBe(false);
});

test('last year’s read: the range 364 days back, up to yesterday; none when all of it is to come', () => {
  expect(lastYearRange({ from: '2026-10-26', to: '2026-12-06' }, TODAY)).toEqual({ from: '2025-10-27', to: '2025-12-07' });
  expect(lastYearRange({ from: '2027-11-01', to: '2027-12-05' }, TODAY)).toEqual({ from: '2026-11-02', to: '2026-11-10' });
  expect(lastYearRange({ from: '2027-11-15', to: '2027-12-05' }, TODAY)).toBeNull();
});

test('the month chart’s words: each day’s status word while a forecast is drawn somewhere; none in a chart with none', () => {
  const dates = ['2026-11-12', '2026-11-13', '2026-11-14'];
  const some = calendarChart(dates, input({
    forecast: windowOf([forecastDay({ date: '2026-11-12' }), forecastDay({ date: '2026-11-13', status: 'closed', low: null, mid: null, high: null })]),
  }), null);
  expect(chartWords(some)).toEqual([null, 'Closed', 'No forecast']);
  const none = calendarChart(dates, input({
    forecast: windowOf([forecastDay({ date: '2026-11-13', status: 'closed', low: null, mid: null, high: null })]),
  }), [stored('2025-11-13', 96)]);
  expect(none.days.map((day) => day.status)).toEqual(['No forecast', 'Closed', 'No forecast']);
  expect(chartWords(none)).toEqual([null, null, null]);
});

test('each day’s slice for the week view holds the day and its neighbors only, and where the day is among them', () => {
  const dates = ['2026-11-12', '2026-11-13', '2026-11-14', '2026-11-15'];
  const chart = calendarChart(dates, input({ forecast: windowOf(dates.map((date) => forecastDay({ date }))) }), null);
  const windows = chartWindows(chart);
  expect(windows.size).toBe(4);
  const first = windows.get('2026-11-12');
  expect(first?.days.map((day) => day.date)).toEqual(['2026-11-12', '2026-11-13']);
  expect(first?.at).toBe(0);
  const middle = windows.get('2026-11-14');
  expect(middle?.days.map((day) => day.date)).toEqual(['2026-11-13', '2026-11-14', '2026-11-15']);
  expect(middle?.at).toBe(1);
  expect(windows.get('2026-11-15')?.days.map((day) => day.date)).toEqual(['2026-11-14', '2026-11-15']);
  // Every slice keeps the whole chart's scale, so the slices line up.
  expect([...windows.values()].every((each) => each.top === chart.top)).toBe(true);
});

test('what a run of days draws, for the week view’s key over the days in view', () => {
  const chart = calendarChart(['2026-11-12', '2026-11-13'], input({
    forecast: windowOf([forecastDay({ date: '2026-11-12' }), forecastDay({ date: '2026-11-13', outlook: true })]),
  }), null);
  expect(chartDrawn(chart.days.slice(0, 1))).toEqual({ forecast: true, actual: false, lastYear: false, outlook: false, backtest: false });
  expect(chartDrawn(chart.days)).toEqual(chart.drawn);
  expect(chartDrawn([])).toEqual({ forecast: false, actual: false, lastYear: false, outlook: false, backtest: false });
});

describe('backtest days (D72)', () => {
  // Nov 2 and 3 have no run's day and a backtest's; Nov 9 has a run's day and a backtest entry, which it ignores.
  const backtest = (date: string, fields: Partial<BacktestDay> = {}): BacktestDay => ({
    date, engine: 'model', dataThrough: '2026-06-30', low: 100, mid: 125, high: 150, runId: 'r0', actual: 131, inRange: true, ...fields,
  });
  const reads = (fields: Partial<CalendarInput> = {}): CalendarInput => input({
    backtest: true,
    forecast: { ...windowOf([forecastDay({ date: '2026-11-09', low: 100, mid: 120, high: 140 })]), backtest: [backtest('2026-11-02'), backtest('2026-11-03'), backtest('2026-11-09', { mid: 999 })] },
    salesDays: [stored('2026-11-02', 131), stored('2026-11-09', 131)],
    ...fields,
  });
  const dates = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-09'];

  test('a past date no run covers draws the backtest’s point, flagged; a run’s day keeps its own', () => {
    const chart = calendarChart(dates, reads(), null);
    expect(chart.days.map((day) => [day.point, day.backtest])).toEqual([
      [{ low: 100, mid: 125, high: 150 }, true],
      [{ low: 100, mid: 125, high: 150 }, true],
      [null, false],
      [{ low: 100, mid: 120, high: 140 }, false],
    ]);
    // Nov 2's stored guests sit beside its backtest; Nov 3 has none and Nov 4 neither a backtest nor guests.
    expect(chart.days.map((day) => day.actual)).toEqual([131, null, null, 131]);
    expect(chart.days.map((day) => day.status)).toEqual([null, null, 'No data', null]);
    expect(chart.drawn).toMatchObject({ forecast: true, backtest: true });
  });

  test('a month with only backtest days draws them, says each day’s word, and never says No forecast for these days', () => {
    const only = calendarChart(dates.slice(0, 3), reads(), null);
    expect(only.drawn).toMatchObject({ forecast: false, backtest: true });
    expect(chartDraws(only)).toBe(true);
    expect(drawsForecast(only)).toBe(true);
    expect(chartWords(only)).toEqual([null, null, 'No data']);
    // With neither a forecast nor a backtest, the month says it once (MonthChart.tsx), with no words per day.
    const neither = calendarChart(['2026-11-04', '2026-11-05'], reads(), null);
    expect(drawsForecast(neither)).toBe(false);
    expect(chartWords(neither)).toEqual([null, null]);
  });

  test('without the input’s backtest flag (Home), backtest days draw nothing', () => {
    const chart = calendarChart(dates, reads({ backtest: false }), null);
    expect(chart.days.map((day) => day.backtest)).toEqual([false, false, false, false]);
    expect(chart.days[1]).toMatchObject({ point: null, status: 'No data' });
    expect(chart.drawn.backtest).toBe(false);
  });
});
