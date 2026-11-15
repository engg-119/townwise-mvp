import { dayContext, EMPTY_CONTEXT, type DayContext } from '../../../src/portal/analytics/days';
import { byDate, decodeHistory, type DayRecord } from '../../../src/portal/analytics/history';
import { plainOf } from '../../../src/portal/analytics/phrase';
import {
  calendarCoverageLine, calendarWeekLine, dayMonthRange, eventLine, homeCalendarRange, lastWeekComparison, lastWeekLine, lastYearDayPhrase,
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

  test('the calendar range reaches two years and four weeks back, and to the later of month end and six days from today', () => {
    expect(homeCalendarRange('2026-11-05')).toEqual({ from: '2024-10-07', to: '2026-11-30' });
    // This week's seven days from Nov 30, 2026 end in December, and from Sunday, Nov 29 too.
    expect(homeCalendarRange('2026-11-30').to).toBe('2026-12-06');
    expect(homeCalendarRange('2026-11-29').to).toBe('2026-12-05');
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
    expect(comparison).toMatchObject({ state: 'compared', monday: '2026-10-26', sunday: '2026-11-01', comparedDays: 7, total: 770, lastYearTotal: 700 });
    expect(lastWeekLine(comparison, 'guests')).toBe('Last week: 770 guests, 10% more than the same week last year (700), compared over 7 days.');
    const partial = lastWeekComparison(input(DAYS.filter((each) => each.date !== '2025-10-28' && each.date !== '2026-10-30')));
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
    // This week is the seven days from today, as the This week card shows them.
    expect(cells.filter((cell) => cell.inWeek).map((cell) => cell.date)).toEqual(weekDates(TODAY));
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
    expect(cells.find((cell) => cell.date === '2026-11-11')?.label).toBe('Wed, Nov 11, 2026. This week. Veterans Day.');
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
    expect(cell).toMatchObject({ status: 'closed', likelyClosed: true, figure: null, label: 'Tue, Nov 3, 2026. Likely closed (1 guest recorded).' });
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
