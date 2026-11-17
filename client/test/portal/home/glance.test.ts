import { EMPTY_CONTEXT } from '../../../src/portal/analytics/days';
import { byDate, type DayRecord } from '../../../src/portal/analytics/history';
import { plainOf } from '../../../src/portal/analytics/phrase';
import { lastWeekComparison, weekDates, type HomeInput } from '../../../src/portal/analytics/week';
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
  expect(plainOf(lastWeekGlancePhrase(comparison, 'guests'))).toBe('No guest count uploaded yet; Last week shows Townwise’s forecast.');
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
