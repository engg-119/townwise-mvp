import { dayContext } from '../../../src/portal/analytics/days';
import { byDate, type DayRecord } from '../../../src/portal/analytics/history';
import {
  calendarCoverageLine, calendarWeekLine, lastWeekComparison, lastWeekLine, LAST_YEAR_FOOTNOTE, lateWeekLine, lateWeekShare, leadLine,
  mondayOf, monthFactLine, monthFacts, pastDay, sameWeekdayYearsAgo, summaryLabel, thisWeek, vsUsualLine, weekDates, type HomeInput,
} from '../../../src/portal/analytics/week';
import { BAR_ORDER_BODY } from '../../../src/portal/home/BarOrder';
import { FORECAST_LINE, QUESTIONS_PLANNED } from '../../../src/portal/home/Home';
import { PEOPLE_PLANNED } from '../../../src/portal/home/ThisMonth';
import { calendarBody, holiday, note, run, townEvent } from '../analytics/fakes';

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
    if (comparison.state !== 'no_history' && comparison.state !== 'no_recent' && comparison.state !== 'no_days') {
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

  test('every sentence Home builds is free of forecast wording', () => {
    const week = thisWeek(home);
    const sentences = [
      leadLine(home.lastDate, calendarBody()), calendarWeekLine(week, calendarBody()), calendarCoverageLine(calendarBody()),
      lastWeekLine(lastWeekComparison(home), 'guests'), ...monthFacts(home).map((fact) => monthFactLine(fact, 'guests')),
    ];
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
  for (const line of [FORECAST_LINE, QUESTIONS_PLANNED, BAR_ORDER_BODY, PEOPLE_PLANNED]) {
    expect(line).not.toMatch(FORECAST_WORDING);
    expect(line).not.toMatch(/\d/);
  }
  expect(LAST_YEAR_FOOTNOTE).not.toMatch(FORECAST_WORDING);
  expect(FORECAST_LINE).toMatch(/never a guess/);
});
