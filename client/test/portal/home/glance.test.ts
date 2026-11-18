import { EMPTY_CONTEXT } from '../../../src/portal/analytics/days';
import { byDate, type DayRecord } from '../../../src/portal/analytics/history';
import { plainOf } from '../../../src/portal/analytics/phrase';
import {
  forecastDayPhrase, lastYearBesidePhrase, lastWeekComparison, thisWeek, todayForecastPhrase, weekDates, weekForecast, weekForecastLabel, weekRangePhrase, type HomeInput,
} from '../../../src/portal/analytics/week';
import type { ForecastDay, ForecastWindow, LiveAccuracy } from '../../../src/portal/estimates/api';
import { lastWeekErrorGlancePhrase, lastWeekGlance, lastWeekGlancePhrase } from '../../../src/portal/home/Glance';
import { run } from '../analytics/fakes';
import { forecastDay } from '../calendar/fakes';

// At a glance's Last week tile follows the Last week card (D42, home-last-week): the forecast's error when the card
// shows one from the read's `accuracy`, the forecast-only words when every day is a forecast without sales, and
// today's words otherwise. Today is Mon, Nov 23, 2026; synthetic days only.

const MONDAY = '2026-11-23';
const WEEK = weekDates('2026-11-16');
const HISTORY = run('2025-10-01', '2026-11-22', (date) => (date >= '2026-11-16' ? 110 : 100));

function at(days: readonly DayRecord[]): HomeInput {
  return { today: MONDAY, byDate: byDate(days), context: EMPTY_CONTEXT, metric: 'guests', lastDate: days.at(-1)?.date ?? null };
}

function published(days: ForecastDay[], accuracy: LiveAccuracy | null): ForecastWindow {
  return { available: true, reason: null, runs: [{ id: 'r1', model: { label: 'Townwise demand model v9' }, madeAt: '2026-11-09', live: null }], days, accuracy, weeks: [] };
}

const scored = (date: string): ForecastDay => forecastDay({ date, low: 90, mid: 105, high: 120, actual: 110, inRange: true, scored: true });
const TODAY_WORDS = '+10% against the same week last year (700), over all 7 days.';

test('the tile with an error: “Off by 12%” strong, against the forecast over 6 days, then today’s words', () => {
  const days = [...WEEK.slice(0, 6).map(scored), forecastDay({ date: '2026-11-22', scored: false, actual: 110 })];
  const comparison = lastWeekComparison(at(HISTORY), published(days, { days: 6, inRange: 5, typicalErrorPct: 11.6, from: '2026-11-16', to: '2026-11-21' }));
  const error = lastWeekErrorGlancePhrase(comparison);
  expect(error).toEqual([{ strong: 'Off by 12%' }, ' against the forecast over 6 days.']);
  expect(lastWeekGlance(comparison, 'guests')).toBe(TODAY_WORDS);
});

test('under 5 scored days, or none, the tile keeps today’s words with no error', () => {
  const few = lastWeekComparison(at(HISTORY), published(WEEK.slice(0, 3).map(scored), null));
  expect(lastWeekErrorGlancePhrase(few)).toBeNull();
  expect(lastWeekGlance(few, 'guests')).toBe(TODAY_WORDS);
  expect(lastWeekErrorGlancePhrase(lastWeekComparison(at(HISTORY)))).toBeNull();
});

test('every day a forecast without sales: the forecast-only words in place of “Your sales stop at”', () => {
  const before = HISTORY.filter((day) => day.date <= '2026-11-15');
  const comparison = lastWeekComparison(at(before), published(WEEK.map((date) => forecastDay({ date, scored: false })), null));
  expect(plainOf(lastWeekGlancePhrase(comparison, 'guests'))).toBe('No guest counts for these days yet. Upload your sales to see how Townwise’s forecast did.');
  expect(lastWeekErrorGlancePhrase(comparison)).toBeNull();
  // Some days forecast only, some stored: today's words.
  const upToFriday = HISTORY.filter((day) => day.date <= '2026-11-20');
  const mixed = lastWeekComparison(at(upToFriday), published(WEEK.slice(5).map((date) => forecastDay({ date, scored: false })), null));
  expect(lastWeekGlance(mixed, 'guests')).toBe('+10% against the same week last year (500), over the 5 days both weeks have.');
});

test('nothing published: exactly today’s words', () => {
  const before = HISTORY.filter((day) => day.date <= '2026-11-15');
  const nothing: ForecastWindow = { available: false, reason: 'no_published_forecast', runs: [], days: [], accuracy: null, weeks: [] };
  expect(lastWeekGlance(lastWeekComparison(at(before), nothing), 'guests')).toBe('Your sales stop at Sun, Nov 15, 2026.');
});

// At a glance's This week (D43): with a published forecast for all seven days from today, the days' figures as the
// Forecast row rounds them, added up, with no range; otherwise null, and the tile stays on last year.
describe('weekForecast', () => {
  const NEXT = weekDates(MONDAY);
  const week = thisWeek(at(HISTORY));
  const open = (date: string, mid: number): ForecastDay => forecastDay({ date, low: mid - 20, mid, high: mid + 20 });
  const booked: ForecastDay['reasons'][number] = {
    kind: 'note', label: 'Your private buyout, 40 guests', effectPct: null, sources: [], note: { id: 'n1', guests: 40, outcome: 'booked' },
  };

  test('adds up the rounded middles, so the Forecast row adds up to the total; busiest, quietest and today', () => {
    const days = NEXT.map((date, index) => open(date, 100.4 + index * 10));
    const found = weekForecast(week, published(days, null), 'guests');
    expect(found).not.toBeNull();
    if (found === null) return;
    // 100 + 110 + ... + 160, each rounded first.
    expect(found.total).toBe(910);
    expect(found.busiest).toEqual({ date: '2026-11-29', value: 160, booked: false });
    expect(found.quietest).toEqual({ date: '2026-11-23', value: 100, booked: false });
    expect(plainOf(todayForecastPhrase(found.today))).toBe('Today: ~100 guests, forecast, 80 to 121.');
    expect(weekForecastLabel(found)).toBe('Mon, Nov 23 to Sun, Nov 29, 2026: the 7 days’ forecasts added up.');
    expect(forecastDayPhrase('Busiest', { date: '2026-11-29', value: 160, booked: false })).toEqual(['Busiest: Sun, Nov 29, 2026 (', { strong: '~160 guests' }, ', forecast).']);
  });

  test('a closed day counts 0 and is never the quietest; your buyout counts its party and is never the quietest', () => {
    const days = NEXT.map((date, index) => open(date, 100 + index));
    days[1] = forecastDay({ date: NEXT[1] ?? '', status: 'closed', low: null, mid: null, high: null });
    days[2] = forecastDay({ date: NEXT[2] ?? '', status: 'booked', low: null, mid: null, high: null, noteGuests: 40, reasons: [booked] });
    const found = weekForecast(week, published(days, null), 'guests');
    // 100 + 0 + 40 + 103 + 104 + 105 + 106: the buyout's 40 is the lowest figure but only open days are quietest.
    expect(found?.total).toBe(558);
    expect(found?.quietest).toEqual({ date: NEXT[0], value: 100, booked: false });
    expect(found?.busiest).toEqual({ date: NEXT[6], value: 106, booked: false });
  });

  test('a buyout as the busiest day reads as its party, marked as a forecast', () => {
    const days = NEXT.map((date) => open(date, 100));
    days[5] = forecastDay({ date: NEXT[5] ?? '', status: 'booked', low: null, mid: null, high: null, noteGuests: 140, reasons: [booked] });
    const found = weekForecast(week, published(days, null), 'guests');
    expect(found?.busiest).toEqual({ date: NEXT[5], value: 140, booked: true });
    expect(plainOf(forecastDayPhrase('Busiest', found?.busiest ?? { date: '', value: 0, booked: true }))).toBe('Busiest: Sat, Nov 28, 2026 (a private buyout, ~140 guests, forecast).');
  });

  test('a week running into next month reads its last days from the same read', () => {
    const today = '2026-11-28';
    const dates = weekDates(today);
    expect(dates.at(-1)).toBe('2026-12-04');
    const found = weekForecast(thisWeek({ ...at(HISTORY), today }), published(dates.map((date) => open(date, 100)), null), 'guests');
    expect(found?.total).toBe(700);
    expect(weekForecastLabel(found ?? { from: '', to: '', missing: [] })).toBe('Sat, Nov 28 to Fri, Dec 4, 2026: the 7 days’ forecasts added up.');
  });

  test('5 or 6 days with a figure: their total, the days left out named, and no range', () => {
    const all = NEXT.map((date) => open(date, 100));
    const six = weekForecast(week, published(all.slice(0, 6), null), 'guests');
    expect([six?.total, six?.missing, six?.range]).toEqual([600, ['2026-11-29'], null]);
    expect(weekForecastLabel(six ?? { from: '', to: '', missing: [] })).toBe(
      'Mon, Nov 23 to Sun, Nov 29, 2026: 6 of the 7 days’ forecasts added up. Sun, Nov 29 has no forecast figure.',
    );
    // Booked by the run, not your buyout ("Booked for a private event"), and your buyout with no party: no figure.
    const two = [...all];
    two[3] = forecastDay({ date: NEXT[3] ?? '', status: 'booked', low: null, mid: null, high: null, noteGuests: 0 });
    two[4] = forecastDay({ date: NEXT[4] ?? '', status: 'booked', low: null, mid: null, high: null, noteGuests: 0, reasons: [booked] });
    const five = weekForecast(week, published(two, null), 'guests');
    expect([five?.total, five?.missing]).toEqual([500, ['2026-11-26', '2026-11-27']]);
    expect(weekForecastLabel(five ?? { from: '', to: '', missing: [] })).toMatch(/: 5 of the 7 days’ forecasts added up\. Thu, Nov 26 and Fri, Nov 27 have no forecast figure\.$/);
    // Today without a figure: the line says so.
    const noToday = weekForecast(week, published(all.slice(1), null), 'guests');
    expect(noToday?.today).toBeNull();
    expect(todayForecastPhrase(noToday?.today ?? null)).toEqual(['Today: no forecast figure.']);
    // An open day without its range shows no figure in the row, so it is left out too.
    const rangeless = [...all];
    rangeless[2] = forecastDay({ date: NEXT[2] ?? '', low: null, mid: 100, high: null });
    expect(weekForecast(week, published(rangeless, null), 'guests')?.missing).toEqual(['2026-11-25']);
  });

  test('null, so the tile stays on last year: under 5 days with a figure, sales, nothing published', () => {
    const all = NEXT.map((date) => open(date, 100));
    expect(weekForecast(week, published(all.slice(0, 4), null), 'guests')).toBeNull();
    expect(weekForecast(week, published(all, null), 'netSales')).toBeNull();
    expect(weekForecast(week, null, 'guests')).toBeNull();
    expect(weekForecast(week, { available: false, reason: 'no_published_forecast', runs: [], days: [], accuracy: null, weeks: [] }, 'guests')).toBeNull();
  });

  test('all 7 days: the run’s weekly 80% band on the estimated part, exact guests added as they are', () => {
    const banded = (days: ForecastDay[]): ForecastWindow => ({
      ...published(days, null),
      runs: [{ id: 'r1', model: { label: 'Townwise demand model v9' }, madeAt: '2026-11-09', live: null, backtest: { weeklyRangePct: { below: 20, above: 25 } } }],
    });
    const all = NEXT.map((date) => open(date, 100));
    // 700 estimated: 560 to 875.
    expect(weekForecast(week, banded(all), 'guests')?.range).toEqual({ low: 560, high: 875 });
    expect(plainOf(weekRangePhrase({ low: 560, high: 875 }))).toBe('Likely 560 to 875 guests: 8 in 10 of this forecast’s backtest weeks landed in a range this wide.');
    // A day with 40 guests from your notes (mid 140) and a 60-guest buyout in place of two 100s: 700 in all, 600
    // estimated (480 to 750) and 100 exact.
    const withExact = [...all];
    withExact[1] = forecastDay({ date: NEXT[1] ?? '', low: 120, mid: 140, high: 160, noteGuests: 40 });
    withExact[2] = forecastDay({ date: NEXT[2] ?? '', status: 'booked', low: null, mid: null, high: null, noteGuests: 60, reasons: [booked] });
    const found = weekForecast(week, banded(withExact), 'guests');
    expect(found?.total).toBe(700);
    expect(found?.range).toEqual({ low: 100 + 480, high: 100 + 750 });
    // A run with no band, or a day left out: no range.
    expect(weekForecast(week, published(all, null), 'guests')?.range).toBeNull();
    expect(weekForecast(week, banded(all.slice(0, 6)), 'guests')?.range).toBeNull();
  });

  test('today closed or booked, and last year beside the total', () => {
    expect(plainOf(todayForecastPhrase(forecastDay({ date: MONDAY, status: 'booked', low: null, mid: null, high: null, noteGuests: 40 })))).toBe('Today: a private buyout, ~40 guests, forecast.');
    expect(todayForecastPhrase(forecastDay({ date: MONDAY, status: 'closed', low: null, mid: null, high: null }))).toEqual(['Today: closed.']);
    const summary = week.summary;
    expect(summary).not.toBeNull();
    if (summary === null) return;
    expect(plainOf(lastYearBesidePhrase(summary, 'guests'))).toMatch(/^Same 7 days last year: 700 guests[.,]/);
  });
});
