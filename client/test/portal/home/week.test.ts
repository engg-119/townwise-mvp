import { dayContext, EMPTY_CONTEXT, type DayContext } from '../../../src/portal/analytics/days';
import { byDate, decodeHistory, type DayRecord } from '../../../src/portal/analytics/history';
import {
  calendarCoverageLine, calendarWeekLine, dayMonthRange, eventLine, homeCalendarRange, lastWeekComparison, lastWeekLine,
  lateWeekLine, lateWeekShare, leadLine, mondayOf, monthDay, monthFactLine, monthFacts, monthGrid, monthItems, monthMove, monthStatusWord, nextEvent,
  nextEventWhen, pastDay, periodLine, sameWeekdayYearsAgo, summaryLabel, thisDayLine, thisWeek, vsUsualLine, weekDates, type HomeInput,
} from '../../../src/portal/analytics/week';
import { addDays } from '../../../src/portal/locations/dates';
import { calendarBody, day, historyBody, holiday, note, run, townEvent } from '../analytics/fakes';

// Home's computations (home.md 2, 5.6), on synthetic days only. Explainability: every comparison says how many days
// it is over, and "last year" is the same weekday 52 weeks earlier. Honesty: no figure for a day after the last day
// of data or after today.

const TODAY = '2026-11-05'; // a Thursday

function input(days: readonly DayRecord[], context: DayContext = EMPTY_CONTEXT, today = TODAY): HomeInput {
  return { today, byDate: byDate(days), context, metric: 'guests', lastDate: days.at(-1)?.date ?? null };
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

  test('the calendar range starts two years and four weeks before this week’s Monday, and ends on the later of month end and today plus 6', () => {
    expect(homeCalendarRange('2026-11-05')).toEqual({ from: '2024-10-07', to: '2026-11-30' });
    // Sun, Nov 15, 2026: the start is this week's Monday (Nov 9) less 756 days, not today's; the month runs past the strip.
    expect(homeCalendarRange('2026-11-15')).toEqual({ from: '2024-10-14', to: '2026-11-30' });
    // Mon, Nov 30, 2026: the strip runs into December.
    expect(homeCalendarRange('2026-11-30')).toEqual({ from: '2024-11-04', to: '2026-12-06' });
    // Sun, Nov 29, 2026: this week's Sunday is in November, but the strip ends on Sat, Dec 5.
    expect(homeCalendarRange('2026-11-29')).toEqual({ from: '2024-10-28', to: '2026-12-05' });
  });

  test('ranges without a year', () => {
    expect(dayMonthRange('2026-11-11', '2026-11-11')).toBe('Nov 11');
    expect(dayMonthRange('2026-11-20', '2026-11-22')).toBe('Nov 20 to 22');
    expect(dayMonthRange('2026-10-26', '2026-11-17')).toBe('Oct 26 to Nov 17');
  });
});

describe('the next 7 days', () => {
  // Two years of history ending Wednesday, Nov 4, 2026. Saturdays 40 busier.
  const DAYS = run('2024-09-01', '2026-11-04', (date) => 100 + (new Date(`${date}T00:00:00Z`).getUTCDay() === 6 ? 40 : 0));

  test('rows from today through today plus 6, today first, with last year and two years ago, and no figure after the last day', () => {
    const week = thisWeek(input(DAYS));
    expect([week.first, week.last]).toEqual(['2026-11-05', '2026-11-11']);
    expect(week.rows.map((row) => row.date)).toEqual(weekDates(TODAY));
    expect(week.rows.map((row) => row.isToday)).toEqual([true, false, false, false, false, false, false]);
    // The history ends the day before today, so no day of the 7 has its own figure.
    expect(week.rows.map((row) => row.value)).toEqual([null, null, null, null, null, null, null]);
    // Today's own upload shows; a later day's never does.
    const uploaded = thisWeek(input([...DAYS, day(TODAY, 120), day('2026-11-06', 130)]));
    expect(uploaded.rows.map((row) => row.value)).toEqual([120, null, null, null, null, null, null]);
    expect(week.rows[2]?.lastYear).toMatchObject({ date: '2025-11-08', value: 140 });
    expect(week.rows[2]?.twoYearsAgo).toMatchObject({ date: '2024-11-09', value: 140 });
    expect(week.twoYears).toBe(true);
  });

  test('a Sunday starts on the Sunday, and the 7 days run across a month and a daylight saving change by calendar date', () => {
    const sunday = thisWeek(input(DAYS, EMPTY_CONTEXT, '2026-11-15'));
    expect(sunday.rows.map((row) => row.date)).toEqual(['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']);
    expect(sunday.rows[0]?.isToday).toBe(true);
    // Mon, Nov 30, 2026: each day has its own calendar entries and notes, December's included.
    const context = dayContext(
      [note({ startDate: '2026-12-05', detail: 'A holiday party.' })],
      [townEvent({ start: '2026-11-30', title: 'Sample lecture' }), townEvent({ start: '2026-12-03', title: 'Tree lighting' })],
    );
    const across = thisWeek(input(DAYS, context, '2026-11-30'));
    expect([across.first, across.last]).toEqual(['2026-11-30', '2026-12-06']);
    expect(across.rows.map((row) => row.date)).toEqual(['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-06']);
    expect(across.rows.map((row) => row.events.map((each) => each.title))).toEqual([['Sample lecture'], [], [], ['Tree lighting'], [], [], []]);
    expect(across.rows.map((row) => row.notes.map((each) => each.detail))).toEqual([[], [], [], [], [], ['A holiday party.'], []]);
    // US daylight saving time ends Sun, Nov 1, 2026: the days are still 7 calendar dates, one each.
    expect(thisWeek(input(DAYS, EMPTY_CONTEXT, '2026-10-29')).rows.map((row) => row.date))
      .toEqual(['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04']);
  });

  test('the summary sums the same 7 days last year, needs 5 of them and names its day count', () => {
    const week = thisWeek(input(DAYS));
    expect(week.summary).toMatchObject({ from: '2025-11-06', to: '2025-11-12', days: 7, total: 740, busiest: '2025-11-08' });
    if (week.summary === null) throw new Error('no summary');
    expect(summaryLabel(week.summary)).toBe('Same days last year, Thu, Nov 6 to Wed, Nov 12, 2025. From all 7 days.');
    // Every day matches its usual exactly.
    expect(vsUsualLine(week.summary)).toBe('0% against that year’s usual for those days, compared over 7 days.');
    // Sun, Nov 15, 2026: Nov 16 to 22, 2025.
    const sunday = thisWeek(input(DAYS, EMPTY_CONTEXT, '2026-11-15')).summary;
    if (sunday === null) throw new Error('no summary');
    expect(sunday).toMatchObject({ from: '2025-11-16', to: '2025-11-22', days: 7, total: 740 });
    expect(summaryLabel(sunday)).toBe('Same days last year, Sun, Nov 16 to Sat, Nov 22, 2025. From all 7 days.');
    // Four of those days: no summary.
    const gappy = DAYS.filter((each) => !['2025-11-16', '2025-11-17', '2025-11-18'].includes(each.date));
    expect(thisWeek(input(gappy, EMPTY_CONTEXT, '2026-11-15')).summary).toBeNull();
    const six = DAYS.filter((each) => each.date !== '2025-11-16');
    const partial = thisWeek(input(six, EMPTY_CONTEXT, '2026-11-15')).summary;
    if (partial === null) throw new Error('no summary');
    expect(summaryLabel(partial)).toBe('Same days last year, Sun, Nov 16 to Sat, Nov 22, 2025. From 6 of its 7 days.');
  });

  test('the quietest day leaves out closed days', () => {
    const closed = DAYS.map((each) => (each.date === '2025-11-07' ? day(each.date, 0, 0) : each));
    const week = thisWeek(input(closed));
    expect(week.summary?.quietest).not.toBe('2025-11-07');
    expect(week.rows[1]?.lastYear).toMatchObject({ date: '2025-11-07', closed: true });
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
    expect(week.rows[6]?.events.map((each) => each.title)).toEqual(['Veterans Day']);
    expect(calendarWeekLine(week, calendarBody())).toBe('On the calendar in the next 7 days: Sample game (Saturday), and 1 more.');
    expect(calendarWeekLine({ firstEvent: null, periods: [] }, calendarBody())).toBe('Nothing on Hanover’s researched calendar in the next 7 days.');
    expect(calendarWeekLine({ firstEvent: null, periods: [] }, calendarBody({ town: { townId: null, name: 'Norwich', state: 'VT' }, researched: false, covers: null })))
      .toBe('Nothing on the calendar in the next 7 days.');
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
      term('2026-11-20', '2026-11-25', 'Fall term finals'), townEvent({ start: '2026-11-21', title: 'Dartmouth home football' }),
    ]);
    // Sun, Nov 15, 2026: the 7 days run to Sat, Nov 21, through the end of classes and into finals.
    const week = thisWeek(input(DAYS, context, '2026-11-15'));
    expect(week.firstEvent).toEqual({ title: 'Dartmouth home football', date: '2026-11-21', more: 0 });
    expect(calendarWeekLine(week, calendarBody())).toBe('On the calendar in the next 7 days: Dartmouth home football (Saturday).');
    expect(week.rows.map((row) => row.events.map((each) => each.title))).toEqual([[], [], [], [], [], [], ['Dartmouth home football']]);
    expect(week.rows.every((row) => row.lastYear.events.length === 0 && row.twoYearsAgo.events.length === 0)).toBe(true);
    expect(week.periods.map((each) => each.title)).toEqual(['Fall term classes', 'Fall term finals']);
    expect(week.periods.map(periodLine)).toEqual(['Fall term classes. Term, Sep 14 to Nov 17, 2026.', 'Fall term finals. Term, Nov 20 to 25, 2026.']);
    // From Wed, Nov 18 classes are over, so only finals cover the 7 days.
    expect(thisWeek(input(DAYS, context, '2026-11-18')).periods.map((each) => each.title)).toEqual(['Fall term finals']);
    // 7 days inside the term with no day event say so without claiming an empty calendar.
    const quiet = thisWeek(input(DAYS, context, '2026-11-04'));
    expect(quiet.firstEvent).toBeNull();
    expect(quiet.periods.map((each) => each.title)).toEqual(['Fall term classes']);
    expect(calendarWeekLine(quiet, calendarBody())).toBe('No holiday or town event on Hanover’s researched calendar in the next 7 days.');
    expect(calendarWeekLine(quiet, calendarBody({ town: { townId: null, name: 'Norwich', state: 'VT' }, researched: false, covers: null })))
      .toBe('No holiday or town event in the next 7 days.');
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
    expect(comparison).toMatchObject({ state: 'compared', monday: '2026-10-26', sunday: '2026-11-01', comparedDays: 7, total: 770, lastYearTotal: 700 });
    expect(lastWeekLine(comparison, 'guests')).toBe('Last week: 770 guests, 10% more than the same week last year (700), compared over 7 days.');
    const partial = lastWeekComparison(input(DAYS.filter((each) => each.date !== '2025-10-28' && each.date !== '2026-10-30')));
    expect(partial).toMatchObject({ state: 'compared', comparedDays: 5, total: 550, lastYearTotal: 500 });
    expect(lastWeekLine(partial, 'guests')).toBe('Last week: 550 guests on the 5 days both weeks have, 10% more than the same days last year (500).');
  });

  test('on a Sunday last week stays Monday to Sunday, and this week’s days before today are in neither it nor the 7 days', () => {
    const sunday = '2026-11-15';
    const days = run('2025-10-01', '2026-11-14', () => 100);
    const comparison = lastWeekComparison(input(days, EMPTY_CONTEXT, sunday));
    expect(comparison).toMatchObject({ state: 'compared', monday: '2026-11-02', sunday: '2026-11-08' });
    if (comparison.state !== 'compared') throw new Error('not compared');
    const strip = thisWeek(input(days, EMPTY_CONTEXT, sunday)).rows.map((row) => row.date);
    expect(strip).toEqual(weekDates(sunday));
    // The month grid still outlines this week, Mon, Nov 9 to Sun, Nov 15.
    const outlined = monthGrid(sunday, EMPTY_CONTEXT).flat().filter((cell) => cell?.inWeek === true).map((cell) => cell?.date);
    expect(outlined).toEqual(weekDates('2026-11-09'));
    const shown = new Set([...comparison.days.map((each) => each.date), ...strip]);
    expect(weekDates('2026-11-09').slice(0, 6).filter((date) => shown.has(date))).toEqual([]);
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
    // A gap: last week is missing, but days after it are stored, so the history does not end before it.
    const gap = lastWeekComparison(input(DAYS.filter((each) => each.date < '2026-10-26' || each.date > '2026-11-01')));
    expect(gap).toEqual({ state: 'no_days', monday: '2026-10-26', sunday: '2026-11-01' });
    expect(lastWeekLine(gap, 'guests')).toBe('No guests stored for last week, so there is nothing to compare yet.');
    expect(lastWeekLine(gap, 'netSales')).toBe('No net sales stored for last week, so there is nothing to compare yet.');
    const young = DAYS.filter((each) => each.date >= '2026-01-01');
    const noLastYear = lastWeekComparison(input(young));
    expect(noLastYear.state).toBe('no_last_year');
    expect(lastWeekLine(noLastYear, 'guests')).toBe('No data for the same week last year, so there is nothing to compare yet.');
    const apart = DAYS.filter((each) => !(each.date >= '2026-10-26' && each.date <= '2026-10-29') && !(each.date >= '2025-10-31' && each.date <= '2025-11-02'));
    expect(lastWeekComparison(input(apart)).state).toBe('no_overlap');
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

  test('on a Sunday it still reads last year’s Monday-to-Sunday week, not the 7 days’ last year', () => {
    // Sun, Nov 15, 2026: last year's week is Mon, Nov 10 to Sun, Nov 16, 2025; the 7 days' last year is Nov 16 to 22.
    const days = run('2025-11-10', '2025-11-22', (_date, index) => (index < 3 ? 100 : 150));
    const found = lateWeekShare(input(days, EMPTY_CONTEXT, '2026-11-15'));
    expect(found).toEqual({ share: 600 / 900, days: 7 });
    if (found === null) throw new Error('no share');
    expect(lateWeekLine(found, 'guests')).toBe('Last year this week, Thursday to Sunday brought 67% of the week’s guests.');
    // Without Sun, Nov 16, 2025 there is no share, though the 7 days' last year has 6 of its days.
    expect(lateWeekShare(input(days.filter((each) => each.date !== '2025-11-16'), EMPTY_CONTEXT, '2026-11-15'))).toBeNull();
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
    const context = dayContext(
      [note({ startDate: '2026-11-20', endDate: '2026-11-22', kind: 'private_event' })],
      [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'), holiday('2026-11-26', 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving')],
    );
    const grid = monthGrid(TODAY, context);
    expect(grid[0]?.[0]).toBeNull(); // Oct 26 is not in November
    const cells = grid.flat().filter((cell) => cell !== null);
    expect(cells).toHaveLength(30);
    expect(cells.find((cell) => cell.date === '2026-11-11')?.event).toBe(true);
    expect(cells.find((cell) => cell.date === '2026-11-21')?.note).toBe(true);
    expect(cells.filter((cell) => cell.inWeek).map((cell) => cell.date)).toEqual(weekDates('2026-11-02'));
    expect(cells.find((cell) => cell.isToday)?.date).toBe(TODAY);
    const items = monthItems(TODAY, context);
    expect(items.map((item) => [item.kind, item.dates])).toEqual([['event', 'Nov 11'], ['note', 'Nov 20 to 22'], ['event', 'Nov 26']]);
    expect(eventLine({ title: 'Veterans Day', kind: 'holiday', scope: 'national' })).toBe('Veterans Day. Federal holiday.');
    expect(eventLine({ title: 'Sample game', kind: 'event', scope: 'town' })).toBe('Sample game. Town event.');
  });
});

describe('the month card', () => {
  const context = dayContext(
    [note({ startDate: '2026-11-06', detail: 'A rehearsal dinner.' })],
    [holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day'), townEvent({ start: '2026-11-07', title: 'Sample game' })],
  );

  test('each day of the grid says its marks in words', () => {
    const cells = monthGrid(TODAY, context).flat().filter((cell) => cell !== null);
    expect(cells.find((cell) => cell.date === TODAY)?.label).toBe('Thu, Nov 5, 2026. Today. This week.');
    expect(cells.find((cell) => cell.date === '2026-11-06')?.label).toBe('Fri, Nov 6, 2026. This week. 1 note.');
    expect(cells.find((cell) => cell.date === '2026-11-11')?.label).toBe('Wed, Nov 11, 2026. Veterans Day.');
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
    const cellOn = (on: HomeInput, date: string) => monthGrid(TODAY, on.context, { input: on, forecast: new Map() }).flat().find((each) => each?.date === date);
    const cell = cellOn(home, '2026-11-03');
    expect(cell).toMatchObject({ status: 'closed', likelyClosed: true, figure: null, label: 'Tue, Nov 3, 2026. This week. Likely closed (1 guest recorded).' });
    expect(cell === undefined || cell === null ? null : monthStatusWord(cell)).toBe('Likely closed');
    expect(monthStatusWord({ status: 'closed', likelyClosed: false })).toBe('Closed');
    expect(monthStatusWord({ status: 'booked', likelyClosed: false })).toBe('Booked');
    expect(cellOn(home, '2026-11-02')).toMatchObject({ status: null, likelyClosed: false, figure: { value: 100, kind: 'actual' } });
    const past = monthDay('2026-11-03', home);
    expect(past).toMatchObject({ value: 1, likelyClosed: true });
    expect(thisDayLine(past, 'guests')).toBe('Likely closed (1 guest recorded)');
    expect(thisDayLine(monthDay('2026-11-02', home), 'guests')).toBe('100 guests');
    expect(thisDayLine({ value: null, likelyClosed: false }, 'guests')).toBe('No sales stored for this day.');
    expect(past.lastYear).toMatchObject({ date: '2025-11-04', value: 1, closed: true, likelyClosed: true });
    // A note with fewer guests says the day was open: a real slow day.
    const slow = input(days, dayContext([note({ startDate: '2026-11-03', kind: 'other', effect: 'fewer_guests' })], []));
    expect(cellOn(slow, '2026-11-03')).toMatchObject({ status: null, likelyClosed: false, figure: { value: 1, kind: 'actual' } });
    expect(monthDay('2026-11-03', slow)).toMatchObject({ likelyClosed: false });
  });

  test('the 7 days’ own day is today’s, in This month’s words, and never likely closed with the town’s today (spec D32)', () => {
    // Tue, Nov 3, 2026 had 1 guest, and is today: the only day of the 7 that can have its own figure.
    const days = decodeHistory(historyBody(run('2024-09-01', '2026-11-04', (date) => (date === '2026-11-03' ? 1 : 100))));
    const tuesday = '2026-11-03';
    // A context without the town's today treats every day as past, so the day reads as likely closed, as This month's.
    const week = thisWeek(input(days, context, tuesday));
    const today = week.rows[0];
    if (today === undefined) throw new Error('no today');
    expect(today).toMatchObject({ date: tuesday, isToday: true, value: 1, likelyClosed: true });
    expect(week.rows.slice(1).every((row) => row.value === null)).toBe(true);
    expect(thisDayLine(today, 'guests')).toBe(thisDayLine(monthDay(tuesday, input(days, context, tuesday)), 'guests'));
    expect(thisDayLine(today, 'guests')).toBe('Likely closed (1 guest recorded)');
    // With the town's today, as Home builds it, today's upload may be partial, so it is never likely closed.
    const homeToday = thisWeek(input(days, dayContext([], [], [], tuesday), tuesday)).rows[0];
    if (homeToday === undefined) throw new Error('no today');
    expect(homeToday).toMatchObject({ value: 1, likelyClosed: false });
    expect(thisDayLine(homeToday, 'guests')).toBe('1 guest');
    // A business rule's schedule with fewer guests says the day was open (D31), as a note does.
    const ruled = thisWeek(input(days, dayContext([], [], [{ startDate: '2026-11-01', endDate: null, weekdays: [2], effect: 'fewer_guests' }]), tuesday));
    expect(ruled.rows[0]).toMatchObject({ value: 1, likelyClosed: false });
  });

  test('two years ago reads the 8 same weekdays before it for its typical guests (spec D32), as the Calendar does', () => {
    // Tue, Nov 5, 2024 had 1 guest. The 4 Tuesdays before it have no row; the 4 before those had 100 each. Home reads
    // every stored day (GET .../sales/history), so the typical guests come from those 4 and the day is likely closed.
    const twoYearsAgo = '2024-11-05';
    const gap = new Set([1, 2, 3, 4].map((weeks) => addDays(twoYearsAgo, -7 * weeks)));
    const days = decodeHistory(historyBody(run('2024-09-01', '2026-11-04', (date) => (date === twoYearsAgo ? 1 : gap.has(date) ? null : 100))));
    // With today Tue, Nov 3, 2026, the first of the 7 days is that day two years on.
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
