import { dayContext, EMPTY_CONTEXT, type DayContext } from '../../../src/portal/analytics/days';
import { byDate, decodeHistory, type DayRecord } from '../../../src/portal/analytics/history';
import { plainOf } from '../../../src/portal/analytics/phrase';
import {
  calendarCoverageLine, calendarWeekLine, dayMonthRange, eventLine, forecastPhrase, forecastRange, homeCalendarRange, lastWeekComparison, lastWeekLine,
  lastWeekForecastCell, lastWeekForecastOnly, lastWeekLines, lastWeekPhrase, lastWeekPhrases, lastWeekRange, lastYearDayPhrase,
  lateWeekLine, lateWeekShare, leadLine, mondayOf, monthDay, monthFactLine, monthFacts, monthGrid, monthItems, monthMove, nextEvent,
  nextEventWhen, pastDay, periodLine, sameWeekdayYearsAgo, summaryLabel, thisDayLine, thisWeek, vsUsualLine, weekDates, weekEntries, type HomeInput,
  monthEntryLines, narrowCaption, WIDE_CELL_HEIGHT, WIDE_LINES, WIDE_ROWS, wideCell, type MonthCell,
} from '../../../src/portal/analytics/week';
import type { ForecastDay, ForecastWindow, LiveAccuracy } from '../../../src/portal/estimates/api';
import { addDays } from '../../../src/portal/locations/dates';
import { calendarBody, day, historyBody, holiday, note, run, townEvent } from '../analytics/fakes';
import { ALL_FILTERS, statusWord, type CalendarInput } from '../../../src/portal/calendar/model';
import type { Note } from '../../../src/portal/locations/api';
import type { TownEvent } from '../../../src/portal/analytics/api';
import { forecastDay } from '../calendar/fakes';
import { PARITY_DAY, PARITY_ORDER, parityInput } from '../calendar/parity-fixture';
import { ruleOf } from '../rules/fakes';

// Home's computations (home.md 2, 5.6), on synthetic days only. Explainability: every comparison says how many days
// it is over, and "last year" is the same weekday 52 weeks earlier. Honesty: no figure for a day after the last day
// of data or after today.

const TODAY = '2026-11-05'; // a Thursday

function input(days: readonly DayRecord[], context: DayContext = EMPTY_CONTEXT, today = TODAY): HomeInput {
  return { today, byDate: byDate(days), context, metric: 'guests', lastDate: days.at(-1)?.date ?? null };
}

/** Home's one CalendarInput (D49) over `notes` and `events`, with `fields` on top; no forecast read yet. */
function calendarOf(notes: readonly Note[], events: readonly TownEvent[], fields: Partial<CalendarInput> = {}): CalendarInput {
  return {
    today: TODAY, covered: forecastRange(TODAY), forecast: null, salesDays: [], events, notes, rules: [], imported: [], filters: ALL_FILTERS, ...fields,
  };
}

describe('weeks', () => {
  test('mondayOf runs Monday to Sunday, across a year end', () => {
    expect(mondayOf('2026-11-05')).toBe('2026-11-02');
    expect(mondayOf('2026-11-02')).toBe('2026-11-02');
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    expect(mondayOf('2027-01-01')).toBe('2026-12-28');
    expect(weekDates('2026-12-28')).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03']);
  });

  test('last year is the same weekday 364 days earlier', () => {
    expect(sameWeekdayYearsAgo('2026-11-05', 1)).toBe('2025-11-06');
    expect(sameWeekdayYearsAgo('2026-11-05', 2)).toBe('2024-11-07');
    expect(new Date('2025-11-06T00:00:00Z').getUTCDay()).toBe(new Date('2026-11-05T00:00:00Z').getUTCDay());
  });

  test('the calendar range reaches two years and four weeks back, and to the later of month end and six days from today', () => {
    expect(homeCalendarRange('2026-11-05')).toEqual({ from: '2024-10-07', to: '2026-11-30' });
    // This week's seven days from Nov 30, 2026 end in December, and from Sunday, Nov 29 too.
    expect(homeCalendarRange('2026-11-30').to).toBe('2026-12-06');
    expect(homeCalendarRange('2026-11-29').to).toBe('2026-12-05');
  });

  test('the forecast is read for this month and This week’s seven days, which can run into next month', () => {
    expect(forecastRange('2026-11-05')).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(forecastRange('2026-11-29')).toEqual({ from: '2026-11-01', to: '2026-12-05' });
  });

  test('a day’s published forecast in This week, its figure strong, as This month gives it (owner request)', () => {
    expect(forecastPhrase(undefined)).toBeNull();
    const open = forecastPhrase(forecastDay({ date: '2026-11-05', low: 67.6, mid: 90.4, high: 112.2 }));
    if (open === null) throw new Error('no phrase');
    // A forecast's mark (D49, decision 10): the leading "~" and the word "forecast".
    expect(plainOf(open)).toBe('~90 guests, forecast, likely 67 to 113');
    expect(open[0]).toEqual({ strong: '~90 guests' });
    expect(forecastPhrase(forecastDay({ date: '2026-11-15', status: 'closed', low: null, mid: null, high: null }))).toEqual(['Closed']);
    const yours = forecastDay({
      date: '2026-11-16', status: 'booked', low: null, mid: null, high: null, noteGuests: 40,
      reasons: [{ kind: 'note', label: 'Your buyout', effectPct: null, sources: [], note: { id: 'n1', guests: 40, outcome: 'booked' } }],
    });
    // A buyout's party is an expected count, a forecast too.
    expect(forecastPhrase(yours)).toEqual(['Booked: a private buyout, ', { strong: '~40 guests' }, ', forecast']);
    expect(forecastPhrase({ ...yours, reasons: [] })).toEqual(['Booked for a private event']);
    expect(forecastPhrase(forecastDay({ date: '2026-11-17', low: null, mid: null, high: null }))).toBeNull();
  });

  test('an outlook day (D52) in This week and This month: “Outlook: ~90 guests, forecast, likely 67 to 113”, its cell marked Outlook with its figure', () => {
    const outlook = forecastDay({ date: '2026-11-12', low: 67.6, mid: 90.4, high: 112.2, outlook: true });
    const phrase = forecastPhrase(outlook);
    if (phrase === null) throw new Error('no phrase');
    expect(plainOf(phrase)).toBe('Outlook: ~90 guests, forecast, likely 67 to 113');
    // A forecast day reads as before (D49's mark).
    const plain = forecastPhrase({ ...outlook, outlook: false });
    expect(plain === null ? null : plainOf(plain)).toBe('~90 guests, forecast, likely 67 to 113');
    const window: ForecastWindow = { available: true, reason: null, runs: [], days: [outlook], weeks: [] };
    const cells = monthGrid(TODAY, calendarOf([], [], { forecast: window })).flat();
    const cell = cells.find((each) => each?.date === outlook.date);
    expect(cell).toMatchObject({ status: 'outlook', figure: { value: 90, kind: 'forecast' }, figureText: '~90' });
    expect(cell?.label).toContain('Outlook: 90 guests, forecast, likely 67 to 113.');
    expect(cell === undefined || cell === null ? null : statusWord(cell.status)).toBe('Outlook');
  });

  test('ranges without a year', () => {
    expect(dayMonthRange('2026-11-11', '2026-11-11')).toBe('Nov 11');
    expect(dayMonthRange('2026-11-20', '2026-11-22')).toBe('Nov 20 to 22');
    expect(dayMonthRange('2026-10-26', '2026-11-17')).toBe('Oct 26 to Nov 17');
  });
});

describe('this week', () => {
  // Two years of history ending Wednesday, Nov 4, 2026. Saturdays 40 busier.
  const DAYS = run('2024-09-01', '2026-11-04', (date) => 100 + (new Date(`${date}T00:00:00Z`).getUTCDay() === 6 ? 40 : 0));

  test('the seven days from today, today first, with last year and two years ago, and no figure after today', () => {
    const week = thisWeek(input(DAYS));
    expect(week).toMatchObject({ from: TODAY, to: '2026-11-11' });
    expect(week.rows.map((row) => row.date)).toEqual(weekDates(TODAY));
    expect(week.rows[0]?.isToday).toBe(true);
    expect(week.rows.filter((row) => row.isToday)).toHaveLength(1);
    // History ends yesterday, so no day has a figure of its own; once today's data is in, today prints it.
    expect(week.rows.map((row) => row.value)).toEqual([null, null, null, null, null, null, null]);
    expect(thisWeek(input([...DAYS, day(TODAY, 120)])).rows.map((row) => row.value)).toEqual([120, null, null, null, null, null, null]);
    // Saturday, Nov 7 is the third day.
    expect(week.rows[2]?.lastYear).toMatchObject({ date: '2025-11-08', value: 140 });
    expect(week.rows[2]?.twoYearsAgo).toMatchObject({ date: '2024-11-09', value: 140 });
    expect(week.twoYears).toBe(true);
  });

  test('the summary needs 5 days of last year’s week and names its day count', () => {
    const week = thisWeek(input(DAYS));
    expect(week.summary).toMatchObject({ from: '2025-11-06', to: '2025-11-12', days: 7, total: 740, busiest: '2025-11-08', busiestValue: 140, quietestValue: 100 });
    // Busiest and quietest say their figure in brackets, the figure strong (owner request, 2026-11-15).
    const busiest = lastYearDayPhrase('Busiest', '2025-11-08', 140, 'guests');
    expect(plainOf(busiest)).toBe('Busiest last year: Sat, Nov 8, 2025 (140 guests).');
    expect(busiest.filter((part) => typeof part !== 'string')).toEqual([{ strong: '140 guests' }]);
    if (week.summary === null) throw new Error('no summary');
    expect(summaryLabel(week.summary)).toBe('Same 7 days last year, Thu, Nov 6 to Wed, Nov 12, 2025. From all 7 days.');
    // Every day matches its usual exactly.
    expect(vsUsualLine(week.summary)).toBe('0% against that year’s usual for those days, compared over 7 days.');
    // Four of the same 7 days last year: no summary.
    const gappy = DAYS.filter((each) => !['2025-11-06', '2025-11-07', '2025-11-10'].includes(each.date));
    expect(thisWeek(input(gappy)).summary).toBeNull();
    const six = DAYS.filter((each) => each.date !== '2025-11-06');
    const partial = thisWeek(input(six)).summary;
    if (partial === null) throw new Error('no summary');
    expect(summaryLabel(partial)).toBe('Same 7 days last year, Thu, Nov 6 to Wed, Nov 12, 2025. From 6 of its 7 days.');
  });

  test('the quietest day leaves out closed days', () => {
    const closed = DAYS.map((each) => (each.date === '2025-11-07' ? day(each.date, 0, 0) : each));
    const week = thisWeek(input(closed));
    expect(week.summary?.quietest).not.toBe('2025-11-07');
    expect(week.rows[1]?.lastYear.closed).toBe(true);
  });

  test('usual for a past day, and the change against it', () => {
    const busy = DAYS.map((each) => (each.date === '2025-11-08' ? day(each.date, 182) : each));
    const saturday = pastDay('2025-11-08', input(busy));
    expect(saturday.usual).toEqual({ mean: 140, days: 8 });
    expect(saturday.change).toBeCloseTo(0.3);
  });

  test('events and notes on each day; the first event line and the coverage line', () => {
    const context = dayContext(
      [note({ startDate: '2026-11-06', detail: 'A rehearsal dinner.' })],
      [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'), townEvent({ start: '2026-11-07', title: 'Sample game' })],
    );
    const week = thisWeek(input(DAYS, context));
    expect(week.rows[1]?.notes.map((each) => each.detail)).toEqual(['A rehearsal dinner.']);
    expect(week.rows[2]?.events.map((each) => each.title)).toEqual(['Sample game']);
    // Veterans Day, Wednesday, Nov 11, is the seventh day.
    expect(week.rows[6]?.events.map((each) => each.title)).toEqual(['Veterans Day']);
    expect(calendarWeekLine(week, calendarBody())).toBe('On the calendar this week: Sample game (Saturday), and 1 more.');
    expect(calendarWeekLine({ firstEvent: null, periods: [] }, calendarBody())).toBe('Nothing on Hanover’s researched calendar this week.');
    expect(calendarWeekLine({ firstEvent: null, periods: [] }, calendarBody({ town: { townId: null, name: 'Norwich', state: 'VT' }, researched: false, covers: null })))
      .toBe('Nothing on the calendar this week.');
    expect(calendarCoverageLine(calendarBody())).toBe('Hanover’s researched calendar covers Sep 14, 2026 to Jan 5, 2027 so far, plus US federal holidays.');
    expect(calendarCoverageLine(calendarBody({ town: { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' }, researched: false, covers: null })))
      .toBe('Townwise’s Nantucket calendar has no researched town events yet. Only US federal holidays and your notes show here.');
    expect(calendarCoverageLine(calendarBody({ town: { townId: null, name: 'Norwich', state: 'VT' }, researched: false, covers: null })))
      .toBe('Townwise hasn’t researched Norwich, VT yet. Only US federal holidays and your notes show here.');
  });

  test('term periods are context shown once, never a day’s event or the headline', () => {
    // Hanover's seeded shape: fall classes run for weeks, finals for days, a home game on one day.
    const term = (start: string, end: string, title: string): ReturnType<typeof townEvent> =>
      townEvent({ id: `hanover-nh:${start}:term`, start, end, title, kind: 'term', group: `hanover-nh:${title}`, groupLabel: title });
    const context = dayContext([], [
      term('2025-09-15', '2025-11-18', 'Fall term classes'), term('2026-09-14', '2026-11-17', 'Fall term classes'),
      term('2026-11-20', '2026-11-25', 'Fall term finals'), townEvent({ start: '2026-11-21', title: 'Home football vs Brown' }),
    ]);
    // From Monday, Nov 16: classes end on the second day, finals start on the fifth.
    const week = thisWeek(input(DAYS, context, '2026-11-16'));
    expect(week.firstEvent).toEqual({ title: 'Home football vs Brown', date: '2026-11-21', more: 0 });
    expect(calendarWeekLine(week, calendarBody())).toBe('On the calendar this week: Home football vs Brown (Saturday).');
    expect(week.rows.map((row) => row.events.map((each) => each.title))).toEqual([[], [], [], [], [], ['Home football vs Brown'], []]);
    expect(week.rows.every((row) => row.lastYear.events.length === 0 && row.twoYearsAgo.events.length === 0)).toBe(true);
    expect(week.periods.map((each) => each.title)).toEqual(['Fall term classes', 'Fall term finals']);
    expect(week.periods.map(periodLine)).toEqual(['Fall term classes. Term, Sep 14 to Nov 17, 2026.', 'Fall term finals. Term, Nov 20 to 25, 2026.']);
    // A week inside the term with no day event says so without claiming an empty calendar.
    const quiet = thisWeek(input(DAYS, context, '2026-11-04'));
    expect(quiet.firstEvent).toBeNull();
    expect(quiet.periods.map((each) => each.title)).toEqual(['Fall term classes']);
    expect(calendarWeekLine(quiet, calendarBody())).toBe('No holiday or town event on Hanover’s researched calendar this week.');
  });

  test('the lead names the last day of data and the calendar', () => {
    expect(leadLine('2026-11-04', calendarBody())).toBe('From your sales through Wed, Nov 4, 2026 and Hanover’s researched calendar.');
    expect(leadLine(null, calendarBody({ town: { townId: null, name: 'Norwich', state: 'VT' }, researched: false, covers: null })))
      .toBe('No sales history yet. Home shows US federal holidays and your notes.');
    expect(leadLine(null, calendarBody(), true)).toBe('Every sales upload is turned off. Home shows Hanover’s researched calendar and your notes.');
    expect(leadLine('2026-11-04', calendarBody(), true)).toBe('From your sales through Wed, Nov 4, 2026 and Hanover’s researched calendar.');
  });
});

describe('last week', () => {
  const DAYS = run('2025-10-01', '2026-11-04', (date) => (date >= '2026-10-26' ? 110 : 100));

  test('compared over the days both weeks have', () => {
    const comparison = lastWeekComparison(input(DAYS));
    // The seven days before today (Thu, Nov 5): Oct 29 to Nov 4, This week's weekdays a week earlier.
    expect(comparison).toMatchObject({ state: 'compared', from: '2026-10-29', to: '2026-11-04', comparedDays: 7, total: 770, lastYearTotal: 700 });
    expect(lastWeekLine(comparison, 'guests')).toBe('Last week: 770 guests, 10% more than the same week last year (700), compared over 7 days.');
    const partial = lastWeekComparison(input(DAYS.filter((each) => each.date !== '2025-11-01' && each.date !== '2026-10-30')));
    expect(partial).toMatchObject({ state: 'compared', comparedDays: 5, total: 550, lastYearTotal: 500 });
    expect(lastWeekLine(partial, 'guests')).toBe('Last week: 550 guests on the 5 days both weeks have, 10% more than the same days last year (500).');
  });

  test('fewer guests, less net sales', () => {
    const down = run('2025-10-01', '2026-11-04', (date) => (date >= '2026-10-26' ? 90 : 100));
    expect(lastWeekLine(lastWeekComparison(input(down)), 'guests')).toMatch(/10% fewer than the same week last year/);
    expect(lastWeekLine(lastWeekComparison({ ...input(down), metric: 'netSales' }), 'netSales')).toMatch(/^Last week: \$12,600, 10% less than/);
  });

  test('states: no history, no recent days, no last year, nothing in common', () => {
    expect(lastWeekComparison(input([]))).toEqual({ state: 'no_history' });
    const off = lastWeekComparison({ ...input([]), uploadsOff: true });
    expect(off).toEqual({ state: 'uploads_off' });
    expect(lastWeekLine(off, 'guests')).toBe('Every sales upload is turned off, so there is nothing to compare.');
    const old = DAYS.filter((each) => each.date <= '2026-10-20');
    const recent = lastWeekComparison(input(old));
    expect(recent.state).toBe('no_recent');
    expect(lastWeekLine(recent, 'guests')).toBe('Your history ends Oct 20, 2026. Upload the days since to compare last week.');
    // A gap: last week is missing, but today is stored, so the history does not end before it.
    const gap = lastWeekComparison(input([...DAYS, day('2026-11-05', 110)].filter((each) => each.date < '2026-10-29' || each.date > '2026-11-04')));
    expect(gap).toEqual({ state: 'no_days', from: '2026-10-29', to: '2026-11-04' });
    expect(lastWeekLine(gap, 'guests')).toBe('No guests stored for last week, so there is nothing to compare yet.');
    expect(lastWeekLine(gap, 'netSales')).toBe('No net sales stored for last week, so there is nothing to compare yet.');
    const young = DAYS.filter((each) => each.date >= '2026-01-01');
    const noLastYear = lastWeekComparison(input(young));
    expect(noLastYear.state).toBe('no_last_year');
    expect(lastWeekLine(noLastYear, 'guests')).toBe('No data for the same week last year, so there is nothing to compare yet.');
    const apart = DAYS.filter((each) => !(each.date >= '2026-10-29' && each.date <= '2026-11-01') && !(each.date >= '2025-11-03' && each.date <= '2025-11-05'));
    expect(lastWeekComparison(input(apart)).state).toBe('no_overlap');
  });
});

// Last week with the published forecast (D42, home-last-week): today is Mon, Nov 23, 2026, so last week is Mon, Nov 16
// to Sun, Nov 22. The read's figures, `scored`, `inRange` and `accuracy` are the API's own; Home never recomputes them.
describe('last week with the published forecast', () => {
  const MONDAY = '2026-11-23';
  const WEEK = weekDates('2026-11-16');
  // A year and more of 100 a day, and last week 110 a day, so last week is 10% up on last year.
  const HISTORY = run('2025-10-01', '2026-11-22', (date) => (date >= '2026-11-16' ? 110 : 100));

  function at(days: readonly DayRecord[]): HomeInput {
    return { today: MONDAY, byDate: byDate(days), context: EMPTY_CONTEXT, metric: 'guests', lastDate: days.at(-1)?.date ?? null };
  }

  /** The read for last week: each day the API's, with its `scored`, and the window's `accuracy`. */
  function window(days: ForecastDay[], accuracy: LiveAccuracy | null): ForecastWindow {
    return {
      available: true, reason: null, runs: [{ id: 'r1', model: { label: 'Townwise demand model v9' }, engine: 'model', madeAt: '2026-11-09', live: null }],
      days, accuracy, weeks: [],
    };
  }

  const scoredDay = (date: string, inRange: boolean): ForecastDay => forecastDay({ date, low: 90, mid: 105, high: 120, actual: 110, inRange, scored: true });

  test('the read is the seven days before today', () => {
    expect(lastWeekRange(MONDAY)).toEqual({ from: '2026-11-16', to: '2026-11-22' });
    expect(lastWeekRange('2026-11-05')).toEqual({ from: '2026-10-29', to: '2026-11-04' });
  });

  test('the read failing, nothing published, or none of the days covered: exactly today’s comparison', () => {
    const today = lastWeekComparison(at(HISTORY));
    expect(today.forecast).toBeUndefined();
    expect(lastWeekComparison(at(HISTORY), null)).toEqual(today);
    const nothing: ForecastWindow = { available: false, reason: 'no_published_forecast', runs: [], days: [], accuracy: null, weeks: [] };
    expect(lastWeekComparison(at(HISTORY), nothing)).toEqual(today);
    expect(lastWeekComparison(at(HISTORY), { ...nothing, reason: 'not_covered' })).toEqual(today);
    expect(lastWeekPhrases(lastWeekComparison(at(HISTORY), nothing), 'guests')).toEqual([lastWeekPhrase(today, 'guests')]);
    // Also before history: the upload step's card never shows a forecast for days whose uploads are turned off.
    const off = lastWeekComparison({ ...at([]), uploadsOff: true }, window(WEEK.map((date) => forecastDay({ date })), null));
    expect(off).toEqual({ state: 'uploads_off' });
  });

  test('a scored week: the error from the read’s accuracy, bold, then the last-year sentence', () => {
    // Six days scored (WAPE 11.6%, 5 in range); Sunday was a closure, left out of scoring.
    const days = [...WEEK.slice(0, 6).map((date, index) => scoredDay(date, index !== 2)), forecastDay({ date: '2026-11-22', scored: false, actual: 110, inRange: true })];
    const comparison = lastWeekComparison(at(HISTORY), window(days, { days: 6, inRange: 5, typicalErrorPct: 11.6, from: '2026-11-16', to: '2026-11-21' }));
    expect(comparison).toMatchObject({ state: 'compared', comparedDays: 7, total: 770, lastYearTotal: 700 });
    const [error] = lastWeekPhrases(comparison, 'guests');
    expect(error).toEqual(['Townwise’s forecast was off by ', { strong: '12%' }, ' over ', { strong: '6 days' }, '. ', { strong: '5 of 6 days' }, ' inside the forecast range.']);
    expect(lastWeekLines(comparison, 'guests')).toEqual([
      'Townwise’s forecast was off by 12% over 6 days. 5 of 6 days inside the forecast range.',
      'Last week: 770 guests, 10% more than the same week last year (700), compared over 7 days.',
    ]);
    // The read's own day, scored or not; no day is a forecast in place of sales.
    expect(comparison.forecast?.days.map((day) => [day.date, day.forecastOnly, day.forecast?.scored])).toEqual(
      WEEK.map((date) => [date, false, date !== '2026-11-22']),
    );
  });

  test('few scored days: only the in-range count, from the days’ own `scored` and `inRange`', () => {
    const days = [scoredDay('2026-11-16', true), scoredDay('2026-11-17', false), scoredDay('2026-11-18', true)];
    const comparison = lastWeekComparison(at(HISTORY), window(days, null));
    const [first] = lastWeekPhrases(comparison, 'guests');
    expect(first).toEqual([{ strong: '2 of 3 days' }, ' inside the forecast range.']);
    expect(lastWeekLines(comparison, 'guests')[0]).toBe('2 of 3 days inside the forecast range.');
    expect(lastWeekLines(comparison, 'guests').join(' ')).not.toMatch(/off by/);
    const one = lastWeekComparison(at(HISTORY), window([scoredDay('2026-11-16', false)], null));
    expect(lastWeekLines(one, 'guests')[0]).toBe('0 of 1 day inside the forecast range.');
  });

  test('no uploads since last Sunday: the forecast for these days, no total, and the sentence replaces “Your history ends”', () => {
    const before = HISTORY.filter((day) => day.date <= '2026-11-15');
    const days = WEEK.map((date) => forecastDay({ date, low: 180, mid: 210, high: 245, scored: false }));
    const comparison = lastWeekComparison(at(before), window(days, null));
    expect(comparison.state).toBe('no_recent');
    expect(comparison.forecast?.days.every((day) => day.forecastOnly)).toBe(true);
    expect(lastWeekLines(comparison, 'guests')).toEqual(['No guest count uploaded for these days yet; this is Townwise’s forecast.']);
    expect(lastWeekLines(comparison, 'guests').join(' ')).not.toMatch(/history ends/);
    // No total over forecast days: the state carries none, and no sentence sums them.
    expect(comparison).not.toHaveProperty('total');
    expect(lastWeekLines(comparison, 'guests').join(' ')).not.toMatch(/1,470|\b1470\b/);
  });

  test('a mix of scored and forecast-only days', () => {
    const upToFriday = HISTORY.filter((day) => day.date <= '2026-11-20');
    const days = [
      ...WEEK.slice(0, 5).map((date, index) => scoredDay(date, index !== 4)),
      forecastDay({ date: '2026-11-21', low: 180.4, mid: 210.2, high: 244.1, scored: false }),
      forecastDay({ date: '2026-11-22', low: 150, mid: 170, high: 190, scored: false }),
    ];
    const comparison = lastWeekComparison(at(upToFriday), window(days, { days: 5, inRange: 4, typicalErrorPct: 9.8, from: '2026-11-16', to: '2026-11-20' }));
    // The comparison is over the five stored days only: nothing is added for Saturday and Sunday.
    expect(comparison).toMatchObject({ state: 'compared', comparedDays: 5, total: 550, lastYearTotal: 500 });
    expect(lastWeekLines(comparison, 'guests')).toEqual([
      'Townwise’s forecast was off by 10% over 5 days. 4 of 5 days inside the forecast range.',
      'No guest count uploaded for Sat and Sun yet; this is Townwise’s forecast.',
      'Last week: 550 guests on the 5 days both weeks have, 10% more than the same days last year (500).',
    ]);
    const rows = comparison.forecast?.days ?? [];
    expect(rows.map((day) => day.forecastOnly)).toEqual([false, false, false, false, false, true, true]);
    const saturday = rows[5];
    if (saturday?.forecast == null) throw new Error('no Saturday');
    expect(lastWeekForecastOnly(saturday.forecast)).toBe('Forecast, no guest count uploaded yet: ~210 guests, 180 to 245');
    // Scored rows keep their guests, with the forecast beside them.
    expect(rows[0]).toMatchObject({ value: 110, lastYear: 100 });
    expect(lastWeekForecastCell(rows[0]?.forecast ?? forecastDay({ date: 'x' }))).toBe('About 105, 90 to 120');
  });

  test('which days the sentence names: one day by its date, a few by their weekdays', () => {
    const upToFriday = HISTORY.filter((day) => day.date <= '2026-11-20');
    const one = lastWeekComparison(at(upToFriday), window([forecastDay({ date: '2026-11-21', scored: false })], null));
    expect(lastWeekLines(one, 'guests')[0]).toBe('No guest count uploaded for Sat, Nov 21 yet; this is Townwise’s forecast.');
    const upToWednesday = HISTORY.filter((day) => day.date <= '2026-11-18');
    const three = lastWeekComparison(at(upToWednesday), window(WEEK.slice(3).map((date) => forecastDay({ date, scored: false })), null));
    expect(lastWeekLines(three, 'guests')[0]).toBe('No guest count uploaded for Thu, Fri, Sat and Sun yet; this is Townwise’s forecast.');
  });

  test('a forecast-only day that the run has closed or booked says so, from the run’s own figures', () => {
    const closed = forecastDay({ date: '2026-11-22', status: 'closed', low: null, mid: null, high: null, model: { status: 'closed', low: null, mid: null, high: null } });
    expect(lastWeekForecastOnly(closed)).toBe('Forecast, no guest count uploaded yet: closed');
    expect(lastWeekForecastCell(closed)).toBe('Closed');
    const booked = forecastDay({ date: '2026-11-22', status: 'booked', low: null, mid: null, high: null, model: { status: 'booked', low: null, mid: null, high: null } });
    expect(lastWeekForecastOnly(booked)).toBe('Forecast, no guest count uploaded yet: booked');
    expect(lastWeekForecastCell(booked)).toBe('Booked');
  });

  test('a note on a past day: the run’s own figure, left out of scoring as a closure', () => {
    // A closure note covers Wed, Nov 18; the run forecast it open, and the read keeps the run's figures for a past day.
    const days = WEEK.map((date) => (date === '2026-11-18'
      ? forecastDay({ date, low: 90, mid: 105, high: 120, actual: 110, inRange: true, scored: false })
      : scoredDay(date, true)));
    const comparison = lastWeekComparison(at(HISTORY), window(days, { days: 6, inRange: 6, typicalErrorPct: 4.6, from: '2026-11-16', to: '2026-11-22' }));
    const wednesday = comparison.forecast?.days[2];
    expect(wednesday).toMatchObject({ date: '2026-11-18', value: 110, forecastOnly: false });
    expect(wednesday?.forecast?.scored).toBe(false);
    expect(lastWeekForecastCell(wednesday?.forecast ?? forecastDay({ date: 'x' }))).toBe('About 105, 90 to 120');
    expect(lastWeekLines(comparison, 'guests')[0]).toBe('Townwise’s forecast was off by 5% over 6 days. 6 of 6 days inside the forecast range.');
  });
});

describe('the bar order helper', () => {
  test('Thursday to Sunday’s share of last year’s week, dropped when any of those days is missing', () => {
    // Last year's week of Nov 5, 2026 is Nov 3 to 9, 2025: Mon to Wed 100 each, Thu to Sun 150 each.
    const days = run('2025-11-03', '2025-11-09', (_date, index) => (index < 3 ? 100 : 150));
    const found = lateWeekShare(input(days));
    expect(found?.days).toBe(7);
    expect(found?.share).toBeCloseTo(600 / 900);
    if (found === null) throw new Error('no share');
    expect(lateWeekLine(found, 'guests')).toBe('Last year this week, Thursday to Sunday brought 67% of the week’s guests.');
    expect(lateWeekShare(input(days.filter((each) => each.date !== '2025-11-08')))).toBeNull();
    const short = lateWeekShare(input(days.filter((each) => each.date !== '2025-11-03')));
    if (short === null) throw new Error('no share');
    expect(lateWeekLine(short, 'guests')).toBe('Last year this week, Thursday to Sunday brought 75% of the week’s guests (6 days of that week have data).');
  });
});

describe('this month', () => {
  test('past years of this month, newest first, at most three, closed days left out, with their day counts', () => {
    const days = [
      ...run('2022-01-01', '2022-12-31', () => 100),
      ...run('2023-01-01', '2023-12-31', () => 100),
      ...run('2024-01-01', '2024-12-31', (date) => (date.slice(5, 7) === '11' ? 120 : 100)),
      ...run('2025-01-01', '2025-12-31', (date) => (date === '2025-11-27' ? 0 : date.slice(5, 7) === '11' ? 90 : 100)),
      ...run('2026-01-01', '2026-11-04', () => 100),
    ];
    const facts = monthFacts(input(days));
    expect(facts.map((fact) => fact.year)).toEqual([2025, 2024, 2023]);
    expect(facts[0]?.days).toBe(29);
    const none = { year: 0, days: 0, yearDays: 0, mean: 0, change: null };
    expect(monthFactLine(facts[0] ?? none, 'guests')).toMatch(/^90 guests a day over 29 days in 2025, \d+% below your 2025 daily average over 364 days\.$/);
    expect(monthFactLine(facts[2] ?? none, 'guests')).toBe('100 guests a day over 30 days in 2023, level with your 2023 daily average over 365 days.');
    expect(monthFactLine({ year: 2024, days: 30, yearDays: 366, mean: 12_000, change: 0.2 }, 'netSales')).toBe('$120 a day over 30 days in 2024, 20% above your 2024 daily average over 366 days.');
  });

  test('a partial year says how many days its average is over', () => {
    // History from Sep 1, 2024: the 2024 average is over Sep to Dec only, 122 open days.
    const days = run('2024-09-01', '2026-11-04', (date) => (date.slice(5, 7) === '11' ? 110 : 100));
    const fact = monthFacts(input(days)).find((each) => each.year === 2024);
    expect(fact).toMatchObject({ year: 2024, days: 30, yearDays: 122 });
    if (fact === undefined) throw new Error('no 2024');
    expect(monthFactLine(fact, 'guests')).toMatch(/^110 guests a day over 30 days in 2024, \d+% above your 2024 daily average over 122 days\.$/);
  });

  test('the month grid marks events, notes, this week and today; the list is in date order', () => {
    const calendar = calendarOf(
      [note({ startDate: '2026-11-20', endDate: '2026-11-22', kind: 'private_event' })],
      [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'), holiday('2026-11-26', 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving')],
    );
    const grid = monthGrid(TODAY, calendar);
    expect(grid[0]?.[0]).toBeNull(); // Oct 26 is not in November
    const cells = grid.flat().filter((cell) => cell !== null);
    expect(cells).toHaveLength(30);
    expect(cells.find((cell) => cell.date === '2026-11-11')?.marks.event).toBe(true);
    expect(cells.find((cell) => cell.date === '2026-11-21')?.marks.note).toBe(true);
    // This week is the seven days from today, as the This week card shows them.
    expect(cells.filter((cell) => cell.inWeek).map((cell) => cell.date)).toEqual(weekDates(TODAY));
    expect(cells.find((cell) => cell.isToday)?.date).toBe(TODAY);
    const items = monthItems(TODAY, calendar);
    expect(items.map((item) => [item.kind, item.dates])).toEqual([['event', 'Nov 11'], ['note', 'Nov 20 to 22'], ['event', 'Nov 26']]);
    expect(eventLine({ title: 'Veterans Day', kind: 'holiday', scope: 'national' })).toBe('Veterans Day. Federal holiday.');
    expect(eventLine({ title: 'Sample game', kind: 'event', scope: 'town' })).toBe('Sample game. Town event.');
  });
});

describe('the month card', () => {
  const NOTES = [note({ startDate: '2026-11-06', detail: 'A rehearsal dinner.' })];
  const EVENTS = [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'), townEvent({ start: '2026-11-07', title: 'Sample game' })];
  const context = dayContext(NOTES, EVENTS);

  test('each day of the grid says its marks in words, every entry named (D49)', () => {
    const cells = monthGrid(TODAY, calendarOf(NOTES, EVENTS)).flat().filter((cell) => cell !== null);
    expect(cells.find((cell) => cell.date === TODAY)?.label).toBe('Thu, Nov 5, 2026. Today. This week.');
    expect(cells.find((cell) => cell.date === '2026-11-06')?.label).toBe('Fri, Nov 6, 2026. This week. Private event.');
    expect(cells.find((cell) => cell.date === '2026-11-11')?.label).toBe('Wed, Nov 11, 2026. This week. Veterans Day.');
  });

  test('the month list adds rules, imported events and note names, a title once a day across sources (D49)', () => {
    const rule = ruleOf('r1', 'Closed Mondays in winter', {
      schedule: { kind: 'closure', startDate: '2026-11-01', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
      scheduleSummary: 'Closed on Mondays from Nov 1, 2026',
    });
    const imported = (uid: string, title: string, date: string) => ({
      calendarId: 'c1', calendar: 'US holidays', uid, title, startDate: date, endDate: date, startTime: null, endTime: null,
    });
    const items = monthItems(TODAY, calendarOf([note({ startDate: '2026-11-06', title: 'Holiday party' })], EVENTS, {
      rules: [rule], imported: [imported('v1', 'Veterans day', '2026-11-11'), imported('w1', 'Wine dinner', '2026-11-13')],
    }));
    expect(items.map((item) => [item.kind, item.dates])).toEqual([
      ['rule', 'Nov 2'], ['note', 'Nov 6'], ['event', 'Nov 7'], ['event', 'Nov 11'], ['imported', 'Nov 13'],
    ]);
  });

  test('This week’s days list the same entries in the same order as the Calendar’s week cards (D49 parity)', () => {
    const fixture = parityInput();
    const home = weekEntries(PARITY_DAY, fixture);
    expect(home.lines.map((entry) => entry.words)).toEqual(PARITY_ORDER.slice(0, 2));
    expect(home.more).toBe(`+${String(PARITY_ORDER.length - 2)} more`);
    // Three or fewer show whole.
    const few = weekEntries(PARITY_DAY, { ...fixture, imported: [], rules: [] });
    expect(few).toEqual({ lines: expect.any(Array) as unknown, more: null });
    expect(few.lines.map((entry) => entry.words)).toEqual(['Holiday party', 'Made-up Day', 'Craft fair']);
  });

  test('the keys move a day or a week and never leave the month', () => {
    expect(monthMove('2026-11-05', 'ArrowRight', false)).toBe('2026-11-06');
    expect(monthMove('2026-11-05', 'ArrowLeft', false)).toBe('2026-11-04');
    expect(monthMove('2026-11-12', 'ArrowUp', false)).toBe('2026-11-05');
    // Oct 29 is in October, so the day stays where it is.
    expect(monthMove('2026-11-05', 'ArrowUp', false)).toBe('2026-11-05');
    expect(monthMove('2026-11-26', 'ArrowDown', false)).toBe('2026-11-26');
    expect(monthMove('2026-11-01', 'ArrowLeft', false)).toBe('2026-11-01');
    expect(monthMove('2026-11-30', 'ArrowRight', false)).toBe('2026-11-30');
    // Home and End are the row's Monday and Sunday, kept in the month; with Ctrl, the month's ends.
    expect(monthMove('2026-11-05', 'Home', false)).toBe('2026-11-02');
    expect(monthMove('2026-11-05', 'End', false)).toBe('2026-11-08');
    expect(monthMove('2026-11-01', 'Home', false)).toBe('2026-11-01');
    expect(monthMove('2026-11-30', 'End', false)).toBe('2026-11-30');
    expect(monthMove('2026-11-05', 'Home', true)).toBe('2026-11-01');
    expect(monthMove('2026-11-05', 'End', true)).toBe('2026-11-30');
    expect(monthMove('2026-11-05', 'a', false)).toBeNull();
  });

  test('a day gives its events, notes and past years, and its own figure only once it is past and stored', () => {
    const days = run('2024-09-01', '2026-11-04', () => 100);
    const home = input(days, context);
    const past = monthDay('2026-11-03', home);
    expect(past).toMatchObject({ isToday: false, future: false, value: 100 });
    expect(past.lastYear).toMatchObject({ date: '2025-11-04', value: 100 });
    // Today and the day after the last stored day: no figure yet.
    expect(monthDay(TODAY, home)).toMatchObject({ isToday: true, future: false, value: null });
    const later = monthDay('2026-11-11', home);
    expect(later).toMatchObject({ future: true, value: null });
    expect(later.events.map((event) => event.title)).toEqual(['Veterans Day']);
    // A day after today still shows last year's same weekday: that is history.
    expect(later.lastYear).toMatchObject({ date: '2025-11-12', value: 100 });
    expect(monthDay('2026-11-06', home).notes.map((each) => each.detail)).toEqual(['A rehearsal dinner.']);
  });

  test('a likely-closed past day (spec D32) reads “Likely closed” in its cell, the day and past years, its count kept', () => {
    // 100 guests a day, but 1 on Tue, Nov 3, 2026 and on Tue, Nov 4, 2025; decoded, so each day has its typical guests.
    const days = decodeHistory(historyBody(run('2024-09-01', '2026-11-04', (date) => (date === '2026-11-03' || date === '2025-11-04' ? 1 : 100))));
    const home = input(days, context);
    // Home's cells are the Calendar's (D49): the same likely-closed rule, over the stored days.
    const cellOn = (on: HomeInput, date: string, notes: readonly Note[] = NOTES) => monthGrid(TODAY, calendarOf(notes, EVENTS, {
      salesDays: [...on.byDate.values()], forecast: { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [] },
    })).flat().find((each) => each?.date === date);
    const cell = cellOn(home, '2026-11-03');
    expect(cell).toMatchObject({ status: 'likely_closed', figure: null, label: 'Tue, Nov 3, 2026. Likely closed (1 guest recorded).' });
    expect(cellOn(home, '2026-11-02')).toMatchObject({ status: null, figure: { value: 100, kind: 'actual' }, figureText: '100', caption: null });
    const past = monthDay('2026-11-03', home);
    expect(past).toMatchObject({ value: 1, likelyClosed: true });
    expect(thisDayLine(past, 'guests')).toBe('Likely closed (1 guest recorded)');
    expect(thisDayLine(monthDay('2026-11-02', home), 'guests')).toBe('100 guests');
    expect(thisDayLine({ value: null, likelyClosed: false }, 'guests')).toBe('No sales stored for this day.');
    expect(past.lastYear).toMatchObject({ date: '2025-11-04', value: 1, closed: true, likelyClosed: true });
    // A note with fewer guests says the day was open: a real slow day.
    const slowNote = note({ startDate: '2026-11-03', kind: 'other', effect: 'fewer_guests' });
    const slow = input(days, dayContext([slowNote], []));
    expect(cellOn(slow, '2026-11-03', [slowNote])).toMatchObject({ status: null, figure: { value: 1, kind: 'actual' } });
    expect(monthDay('2026-11-03', slow)).toMatchObject({ likelyClosed: false });
  });

  test('a day whose guest count is marked wrong (D67) says its stored count and its net sales, as Analytics’ day panel does', () => {
    // 100 guests a day at $20 a guest; Mon, Nov 2, 2026 marked wrong.
    const mark = note({ kind: 'other', startDate: '2026-11-02', endDate: '2026-11-02', effect: 'wrong_guest_count', detail: null, expectedGuests: null });
    const days = decodeHistory(historyBody(run('2024-09-01', '2026-11-04', () => 100)), [mark]);
    const home = input(days, dayContext([mark], []));
    const marked = monthDay('2026-11-02', home);
    expect(marked).toMatchObject({ value: null, likelyClosed: false });
    expect(thisDayLine(marked, 'guests')).toBe('100 guests recorded, guest count marked wrong. Net sales $2,000.');
    // Net sales are the day's own, as stored.
    expect(thisDayLine(monthDay('2026-11-02', { ...home, metric: 'netSales' }), 'netSales')).toBe('$2,000');
    // An unmarked day reads as before.
    expect(thisDayLine(monthDay('2026-11-03', home), 'guests')).toBe('100 guests');
  });

  test('this week’s own near-empty day (spec D32) is likely closed, in This month’s words, but never today in the app', () => {
    // History through Tuesday, Nov 3, 2026, which had 1 guest; This week starts that day.
    const tuesdayToday = '2026-11-03';
    const days = decodeHistory(historyBody(run('2024-09-01', tuesdayToday, (date) => (date === tuesdayToday ? 1 : 100))));
    const week = thisWeek(input(days, context, tuesdayToday));
    const tuesday = week.rows[0];
    if (tuesday === undefined) throw new Error('no Tuesday');
    expect(tuesday).toMatchObject({ date: tuesdayToday, value: 1, likelyClosed: true });
    expect(thisDayLine(tuesday, 'guests')).toBe(thisDayLine(monthDay(tuesdayToday, input(days, context, tuesdayToday)), 'guests'));
    expect(thisDayLine(tuesday, 'guests')).toBe('Likely closed (1 guest recorded)');
    // Home's context knows today, whose upload may be partial: today is never likely closed (D32).
    expect(thisWeek(input(days, dayContext([], [], [], tuesdayToday), tuesdayToday)).rows[0]).toMatchObject({ value: 1, likelyClosed: false });
    // A business rule's schedule with fewer guests says the day was open (D31), as a note does.
    const ruled = thisWeek(input(days, dayContext([], [], [{ startDate: '2026-11-01', endDate: null, weekdays: [2], effect: 'fewer_guests' }]), tuesdayToday));
    expect(ruled.rows[0]).toMatchObject({ value: 1, likelyClosed: false });
  });

  test('two years ago reads the 8 same weekdays before it for its typical guests (spec D32), as the Calendar does', () => {
    // Tue, Nov 5, 2024 had 1 guest. The 4 Tuesdays before it have no row; the 4 before those had 100 each. Home reads
    // every stored day (GET .../sales/history), so the typical guests come from those 4 and the day is likely closed.
    const twoYearsAgo = '2024-11-05';
    const gap = new Set([1, 2, 3, 4].map((weeks) => addDays(twoYearsAgo, -7 * weeks)));
    const days = decodeHistory(historyBody(run('2024-09-01', '2026-11-04', (date) => (date === twoYearsAgo ? 1 : gap.has(date) ? null : 100))));
    // From Tuesday, Nov 3, 2026, whose same weekday two years earlier is Nov 5, 2024.
    const week = thisWeek(input(days, context, '2026-11-03'));
    expect(week.rows[0]?.twoYearsAgo).toMatchObject({ date: twoYearsAgo, value: 1, closed: true, likelyClosed: true });
  });

  test('the next event is the first holiday or town event from today, and says when', () => {
    const next = nextEvent(TODAY, context);
    expect(next).toMatchObject({ date: '2026-11-07', days: 2 });
    expect(next?.event.title).toBe('Sample game');
    if (next === null) throw new Error('no next event');
    expect(nextEventWhen(next)).toBe('Sat, Nov 7, 2026, in 2 days');
    expect(nextEventWhen({ ...next, days: 1, date: '2026-11-06' })).toBe('Tomorrow, Fri, Nov 6, 2026');
    expect(nextEventWhen({ ...next, days: 0, date: '2026-11-07' })).toBe('Today');
    // An event that began before today and is still on.
    const carnival = townEvent({ start: '2026-11-03', end: '2026-11-08', title: 'Sample festival' });
    const ongoing = nextEvent(TODAY, dayContext([], [carnival]));
    expect(ongoing).toMatchObject({ date: TODAY, days: 0 });
    if (ongoing === null) throw new Error('no ongoing event');
    expect(nextEventWhen(ongoing)).toBe('On now, until Sun, Nov 8, 2026');
    // Term periods mark no day, so they are never the next event; nothing through the end of the read is null.
    const term = townEvent({ start: '2026-09-14', end: '2026-11-17', title: 'Fall term classes', kind: 'term' });
    expect(nextEvent(TODAY, dayContext([], [term]))).toBeNull();
  });
});

// UI review B1 (D49): a wide Home cell has a line budget that fits its 96px. As in the Calendar's cell, the status or
// the caption sits in the top row beside the day and "+40" beside the figure, so the entry lines get what is left.
describe('a wide Home cell’s rows', () => {
  function cellOf(fields: Partial<MonthCell>): MonthCell {
    return {
      date: '2026-11-25', isToday: false, inWeek: false, status: null, figure: null, figureText: null, caption: null, noteGuests: 0, chips: [], more: 0,
      marks: { event: false, note: false, imported: false }, label: 'Day', ...fields,
    };
  }

  test('the top row, the figure row and the entry lines fit inside the cell, its padding and border', () => {
    expect(WIDE_ROWS.inner).toBe(WIDE_CELL_HEIGHT - 10);
    const used = WIDE_ROWS.top + WIDE_ROWS.gap + WIDE_ROWS.figure + WIDE_ROWS.gap + WIDE_LINES * WIDE_ROWS.entry + (WIDE_LINES - 1) * WIDE_ROWS.entryGap;
    expect(used).toBeLessThanOrEqual(WIDE_ROWS.inner);
    // One more line would not fit.
    expect(used + WIDE_ROWS.entryGap + WIDE_ROWS.entry).toBeGreaterThan(WIDE_ROWS.inner);
    expect(WIDE_LINES).toBe(2);
  });

  test('a booked buyout on a closed day: Booked beside the day, its party in the figure row, both entries', () => {
    const parts = wideCell(cellOf({
      status: 'booked', figure: { value: 70, kind: 'booked' }, figureText: '~70', caption: 'forecast', chips: ['Holiday party', 'Closed Wednesdays in December'],
    }));
    expect(parts).toEqual({ topRight: 'Booked', middle: 'figure', lines: ['Holiday party', 'Closed Wednesdays in December'], more: null });
  });

  test('a busy forecast day: its caption beside the day, one entry and “+N more” when they outrun the budget', () => {
    const parts = wideCell(cellOf({
      figure: { value: 334, kind: 'forecast' }, figureText: '~334', caption: 'forecast', noteGuests: 40,
      chips: ['Alumni reception', 'Home football game', 'Veterans Day'], more: 1,
    }));
    expect(parts).toEqual({ topRight: 'forecast', middle: 'figure', lines: ['Alumni reception'], more: '+3 more' });
  });

  test('a closed or likely-closed day says so in the figure row; a day with neither leaves it empty', () => {
    expect(wideCell(cellOf({ status: 'closed' }))).toMatchObject({ topRight: null, middle: 'status' });
    expect(wideCell(cellOf({ status: 'likely_closed' }))).toMatchObject({ topRight: null, middle: 'status' });
    expect(wideCell(cellOf({ status: 'outlook', figure: { value: 212, kind: 'forecast' }, caption: 'forecast' }))).toMatchObject({ topRight: 'Outlook', middle: 'figure' });
    expect(wideCell(cellOf({ status: 'booked' }))).toMatchObject({ topRight: 'Booked', middle: null });
    expect(wideCell(cellOf({ figure: { value: 94, kind: 'actual' }, caption: 'sales' }))).toMatchObject({ topRight: 'sales', middle: 'figure' });
  });

  test('monthEntryLines keeps to its budget, “+N more” counting as a line', () => {
    const chips = { chips: ['A', 'B', 'C'], more: 2 };
    expect(monthEntryLines({ chips: ['A', 'B'], more: 0 }, 2)).toEqual({ lines: ['A', 'B'], more: null });
    expect(monthEntryLines(chips, 2)).toEqual({ lines: ['A'], more: '+4 more' });
    expect(monthEntryLines(chips, 1)).toEqual({ lines: [], more: '+5 more' });
    expect(monthEntryLines({ chips: ['A'], more: 0 }, 1)).toEqual({ lines: ['A'], more: null });
  });
});

// UI review S4: on a phone a narrow cell drops "forecast", which is wider than the cell; the "~" marks the forecast.
test('a narrow cell’s caption: none for a forecast on a phone; “sales” stays', () => {
  expect(narrowCaption({ caption: 'forecast' }, true)).toBeNull();
  expect(narrowCaption({ caption: 'forecast' }, false)).toBe('forecast');
  expect(narrowCaption({ caption: 'sales' }, true)).toBe('sales');
  expect(narrowCaption({ caption: null }, false)).toBeNull();
});
