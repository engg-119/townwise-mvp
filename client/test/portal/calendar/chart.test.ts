import { calendarChart, chartDraws, lastYearRange } from '../../../src/portal/calendar/chart';
import { ALL_FILTERS, type CalendarInput } from '../../../src/portal/calendar/model';
import type { ForecastWindow } from '../../../src/portal/estimates/api';
import type { SalesDay } from '../../../src/portal/locations/api';
import { forecastDay, forecastOf } from './fakes';

// The Calendar's forecast chart as data (P28, D64), on synthetic days: what each day draws (the forecast's middle and
// range, past days too, an outlook day marked), the guests stored for a past day, the same weekday last year, the
// words in a point's place, nothing for a day whose reads are in flight, and the scale. Every figure is a read's own.
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
  expect(chart.drawn).toEqual({ forecast: true, actual: false, lastYear: false, outlook: true });
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
