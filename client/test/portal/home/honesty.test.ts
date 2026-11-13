import { dayContext } from '../../../src/portal/analytics/days';
import { byDate, type DayRecord } from '../../../src/portal/analytics/history';
import {
  calendarCoverageLine, calendarWeekLine, lastWeekComparison, lastWeekLine, LAST_YEAR_FOOTNOTE, lateWeekLine, lateWeekShare, leadLine,
  mondayOf, monthDay, monthFactLine, monthFacts, monthGrid, nextEvent, nextEventWhen, pastDay, sameWeekdayYearsAgo, summaryLabel, thisWeek,
  vsUsualLine, weekDates, type HomeInput,
} from '../../../src/portal/analytics/week';
import type { ForecastDay } from '../../../src/portal/estimates/api';
import { addDays, monthRange } from '../../../src/portal/locations/dates';
import { BAR_ORDER_BODY } from '../../../src/portal/home/BarOrder';
import { lastWeekGlance } from '../../../src/portal/home/Glance';
import { forecastLine, questionsLabel } from '../../../src/portal/home/Home';
import { PEOPLE_HEAD } from '../../../src/portal/home/ThisMonth';
import { calendarBody, holiday, note, run, townEvent } from '../analytics/fakes';
import { forecastDay } from '../calendar/fakes';

// Home's honesty rule (home.md 0, build plan 6 U8): no number is ever given for a day after the last day of data
// or after today, and nothing Home says reads as a forecast. It checks the computations that every figure on Home
// comes from, over histories that end before this week, inside it and long ago, and every sentence Home builds.
// home.test.web.tsx checks the same rule in the rendered page.

const TODAY = '2026-11-05';
const FORECAST_WORDING = /\blikely\b|\branges?\b|forecast:\s*\d|\bpredict|\bexpect(ed|s)?\b/i;
const CONTEXT = dayContext(
  [note({ startDate: '2026-11-06', detail: 'A rehearsal dinner.' })],
  [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'), townEvent({ start: '2026-11-07', title: 'Sample game' })],
);
const ALL = run('2023-01-01', '2026-11-04', (date) => 100 + (new Date(`${date}T00:00:00Z`).getUTCDay() === 6 ? 40 : 0));

function input(lastDate: string): HomeInput {
  const days: DayRecord[] = ALL.filter((day) => day.date <= lastDate);
  return { today: TODAY, byDate: byDate(days), context: CONTEXT, metric: 'guests', lastDate: days.at(-1)?.date ?? null };
}

const ENDINGS = ['2026-11-04', '2026-11-02', '2026-10-28', '2026-10-20', '2025-12-31', '2025-06-30'];

describe.each(ENDINGS)('history ending %s', (end) => {
  const home = input(end);

  test('this week gives no figure after the last day of data', () => {
    for (const row of thisWeek(home).rows) {
      if (row.date > end) expect(row.value).toBeNull();
      for (const past of [row.lastYear, row.twoYearsAgo]) {
        if (past.date > end) expect([past.value, past.usual, past.change]).toEqual([null, null, null]);
      }
    }
  });

  test('last week, the bar order share and this month count only stored, past days', () => {
    const comparison = lastWeekComparison(home);
    if (comparison.state !== 'no_history' && comparison.state !== 'uploads_off' && comparison.state !== 'no_recent' && comparison.state !== 'no_days') {
      for (const day of comparison.days) {
        if (day.date > end) expect(day.value).toBeNull();
      }
    }
    // Last year's Thursday to Sunday of this week: no share unless all four are stored, past days. In ALL that
    // week is 100 a day with Saturday 140, so Thursday to Sunday is 440 of 740.
    const late = weekDates(sameWeekdayYearsAgo(mondayOf(TODAY), 1)).slice(3);
    const share = lateWeekShare(home);
    if (late.some((date) => date > end)) expect(share).toBeNull();
    else expect(share).toEqual({ share: 440 / 740, days: 7 });
    for (const fact of monthFacts(home)) expect(fact.year).toBeLessThan(2026);
  });

  test('the month card’s day detail gives no figure after the last day of data or after today', () => {
    const { from, to } = monthRange(TODAY.slice(0, 7));
    for (let date = from; date <= to; date = addDays(date, 1)) {
      const day = monthDay(date, home);
      if (date > end || date > TODAY) expect(day.value).toBeNull();
      if (date > TODAY) expect(day.future).toBe(true);
      for (const past of [day.lastYear, day.twoYearsAgo]) {
        if (past.date > end) expect([past.value, past.usual, past.change]).toEqual([null, null, null]);
      }
    }
  });

  test('monthGrid gives no figure after today without a forecast, and none after the last day of data', () => {
    for (const cell of monthGrid(TODAY, CONTEXT, { input: home, forecast: new Map() }).flat()) {
      if (cell === null) continue;
      if (cell.date >= TODAY || cell.date > end) expect(cell.figure).toBeNull();
      else expect(cell.figure?.kind).toBe('actual');
      expect([cell.status, cell.noteGuests]).toEqual([null, 0]);
    }
  });

  test('every sentence Home builds is free of forecast wording', () => {
    const week = thisWeek(home);
    const sentences = [
      leadLine(home.lastDate, calendarBody()), calendarWeekLine(week, calendarBody()), calendarCoverageLine(calendarBody()),
      lastWeekLine(lastWeekComparison(home), 'guests'), lastWeekGlance(lastWeekComparison(home), 'guests'),
      ...monthFacts(home).map((fact) => monthFactLine(fact, 'guests')),
    ];
    const next = nextEvent(TODAY, CONTEXT);
    if (next !== null) sentences.push(nextEventWhen(next));
    if (week.summary !== null) sentences.push(summaryLabel(week.summary), vsUsualLine(week.summary) ?? '');
    const share = lateWeekShare(home);
    if (share !== null) sentences.push(lateWeekLine(share, 'guests'));
    for (const sentence of sentences) expect(sentence).not.toMatch(FORECAST_WORDING);
  });
});

test('a day after today has no figure even when a row for it is stored', () => {
  const future = [...ALL, { date: '2026-11-06', guests: 999, netSalesCents: 1, upload: 0 }];
  const home: HomeInput = { today: TODAY, byDate: byDate(future), context: CONTEXT, metric: 'guests', lastDate: '2026-11-06' };
  expect(thisWeek(home).rows.find((row) => row.date === '2026-11-06')?.value).toBeNull();
  expect(pastDay('2026-11-06', home).value).toBeNull();
  expect(monthDay('2026-11-06', home).value).toBeNull();
});

test('a future day’s figure is only ever the published forecast’s mid', () => {
  // A stored row after today (999) never shows; from today on only the forecast's own figures do.
  const stored = [...ALL, ...['2026-11-05', '2026-11-06', '2026-11-09'].map((date) => ({ date, guests: 999, netSalesCents: 1, upload: 0 }))];
  const home: HomeInput = { today: TODAY, byDate: byDate(stored), context: CONTEXT, metric: 'guests', lastDate: '2026-11-09' };
  const booked = { kind: 'note', label: 'Your private buyout, 70 guests', effectPct: null, sources: [], note: { id: 'n2', guests: 70, outcome: 'booked' } };
  const forecast = new Map<string, ForecastDay>([
    ['2026-11-05', forecastDay({ date: '2026-11-05', low: 180.4, mid: 211.6, high: 240.2 })],
    ['2026-11-06', forecastDay({
      date: '2026-11-06', low: 180, mid: 220, high: 260, model: { status: 'open', low: 110, mid: 150, high: 190 }, noteGuests: 70,
    })],
    ['2026-11-07', forecastDay({ date: '2026-11-07', status: 'booked', low: null, mid: null, high: null, noteGuests: 70, reasons: [booked] })],
    ['2026-11-08', forecastDay({ date: '2026-11-08', status: 'closed', low: null, mid: null, high: null })],
  ]);
  const cells = new Map(monthGrid(TODAY, CONTEXT, { input: home, forecast }).flat().flatMap((cell) => (cell === null ? [] : [[cell.date, cell]])));
  const at = (date: string) => cells.get(date);
  expect(at('2026-11-04')?.figure).toEqual({ value: 100, kind: 'actual', text: '100' });
  expect(at('2026-11-05')?.figure).toEqual({ value: 212, kind: 'forecast', text: '212' });
  expect(at('2026-11-06')?.figure).toEqual({ value: 220, kind: 'forecast', text: '220' });
  expect(at('2026-11-06')?.noteGuests).toBe(70);
  expect(at('2026-11-06')?.label).toBe('Fri, Nov 6, 2026. This week. Forecast about 220 guests, 180 to 260. Includes 70 guests from your notes. 1 note.');
  expect(at('2026-11-07')?.figure).toEqual({ value: 70, kind: 'booked', text: '70' });
  expect(at('2026-11-07')?.status).toBe('booked');
  expect(at('2026-11-07')?.label).toBe('Sat, Nov 7, 2026. This week. Booked: a private buyout, 70 guests. Sample game.');
  expect([at('2026-11-08')?.figure, at('2026-11-08')?.status]).toEqual([null, 'closed']);
  expect(at('2026-11-08')?.label).toBe('Sun, Nov 8, 2026. This week. Closed.');
  // No forecast day: nothing, even with a stored row.
  expect(at('2026-11-09')?.figure).toBeNull();
  for (const cell of cells.values()) expect(cell.figure?.value).not.toBe(999);
});

test('no history at all: no figure anywhere', () => {
  const home: HomeInput = { today: TODAY, byDate: new Map(), context: CONTEXT, metric: 'guests', lastDate: null };
  const week = thisWeek(home);
  expect(week.rows.every((row) => row.value === null && row.lastYear.value === null && row.twoYearsAgo.value === null)).toBe(true);
  expect(week.summary).toBeNull();
  expect(lastWeekComparison(home)).toEqual({ state: 'no_history' });
  expect(lateWeekShare(home)).toBeNull();
  expect(monthFacts(home)).toEqual([]);
});

test('the fixed copy names what is not built yet and promises nothing', () => {
  for (const line of [forecastLine('Main Street Bar'), BAR_ORDER_BODY, PEOPLE_HEAD]) {
    expect(line).not.toMatch(FORECAST_WORDING);
    expect(line).not.toMatch(/\d/);
  }
  expect(LAST_YEAR_FOOTNOTE).not.toMatch(FORECAST_WORDING);
  expect(forecastLine('Main Street Bar')).toBe('Townwise hasn’t published a forecast for Main Street Bar yet. Until then, Home shows your history and the calendar, never a guess.');
  // The questions link is a count of what GET .../agent asks, and nothing more.
  expect(questionsLabel(1)).toBe('1 question from TownwiseAI');
  expect(questionsLabel(5)).toBe('5 questions from TownwiseAI');
  expect(questionsLabel(1200)).toBe('1,200 questions from TownwiseAI');
  expect(questionsLabel(2)).not.toMatch(FORECAST_WORDING);
});
