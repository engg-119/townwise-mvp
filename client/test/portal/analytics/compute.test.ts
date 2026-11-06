import {
  analyticsInput, byMonth, DRIVERS_EMPTY, driverLine, drivers, monthSummary, nightLine, nightTypes, seenText, weeklyShape,
  weeklySummary, yearOverYear, yearOverYearSummary,
} from '../../../src/portal/analytics/aggregates';
import { calendarRange, fetchCalendar, fetchSalesHistory, salesHistorySchema } from '../../../src/portal/analytics/api';
import { usual } from '../../../src/portal/analytics/baseline';
import {
  calendarCoverageLine, cellLabel, colOf, focusBounds, heatmapBlocks, heatmapSummary, initialFocus, moveFocus, rowOf,
  type Cell, type HeatmapInput,
} from '../../../src/portal/analytics/cells';
import { classOf, dayContext, EMPTY_CONTEXT, eventsOn, isClosed, notesOn } from '../../../src/portal/analytics/days';
import {
  basisLine, basisOf, defaultFilters, includedFn, KEEP_ONE_YEAR, metricsWithData, toggleYear, type Filters,
} from '../../../src/portal/analytics/filters';
import { byDate, decodeHistory } from '../../../src/portal/analytics/history';
import { levelsFor } from '../../../src/portal/analytics/levels';
import { dayPanel, noteWords, type PanelInput } from '../../../src/portal/analytics/panel';
import { longDate, shortDate, signedPercent } from '../../../src/portal/analytics/words';
import { addDays } from '../../../src/portal/locations/dates';
import {
  analyticsFake, calendarBody, day, historyBody, holiday, LOCATION_ID, note, OWNER_EMAIL, run, townEvent, upload,
} from './fakes';

// The Analytics compute modules (home.md 4 and 5, spec P24): the two reads, day classification, filters and the
// basis line, levels, "usual", the charts' numbers and sentences, the heatmap cells and keys, and the Day panel.
// Every figure is synthetic. Pillars: every section has a basis line (T); usual and the drivers' 2 and 4 thresholds
// say what they rest on (E); nothing is shown for a day after the last day of data (honesty).

const ALL_ON = { townEvents: true, holidays: true, notes: true, closures: true };

function filtersFor(days: Parameters<typeof defaultFilters>[0], change: Partial<Filters> = {}): Filters {
  return { ...defaultFilters(days), ...change };
}

describe('the two reads', () => {
  test('fetchSalesHistory reads the location history route and keeps the columns', async () => {
    const days = [day('2026-11-03', 120, 240_000), day('2026-11-04', null, 99_00)];
    const path = `/api/org/locations/${LOCATION_ID}/sales/history`;
    const api = analyticsFake({ [path]: historyBody(days) });
    const body = await fetchSalesHistory(api, LOCATION_ID);
    expect(api.paths).toEqual([path]);
    expect(decodeHistory(body)).toEqual(days);
    expect(body.coverage.dayCount).toBe(2);
  });

  test('columns of different lengths fail the request rather than pair a day with the wrong figure', () => {
    const body = historyBody([day('2026-11-03', 120), day('2026-11-04', 90)]);
    body.days.guests.pop();
    expect(salesHistorySchema.safeParse(body).success).toBe(false);
  });

  test('dates out of order, duplicate dates and upload indexes that point nowhere fail too', () => {
    const outOfOrder = historyBody([day('2026-11-04', 1), day('2026-11-03', 1)]);
    const duplicate = historyBody([day('2026-11-03', 1), day('2026-11-03', 1)]);
    const notADate = historyBody([day('2026-02-30', 1)]);
    const pointsNowhere = historyBody([day('2026-11-03', 1, 2000, 1)]);
    for (const body of [outOfOrder, duplicate, notADate, pointsNowhere]) expect(salesHistorySchema.safeParse(body).success).toBe(false);
    expect(salesHistorySchema.safeParse(historyBody([day('2026-11-03', 1, 2000, -1)])).success).toBe(true);
  });

  test('a linked file keeps its kind and a null name (view-as); an unknown kind reads as other', () => {
    const body = historyBody([day('2026-11-03', 1)], [upload({ file: { id: '00000000-0000-0000-0000-00000000f001', name: null, kind: 'pdf' } })]);
    expect(salesHistorySchema.parse(body).uploads[0]?.file).toEqual({ id: '00000000-0000-0000-0000-00000000f001', name: null, kind: 'pdf' });
    const later = { ...body, uploads: [{ ...body.uploads[0], file: { id: 'f', name: 'export.numbers', kind: 'numbers' } }] };
    expect(salesHistorySchema.parse(later).uploads[0]?.file?.kind).toBe('other');
  });

  test('fetchCalendar asks for the range and keeps each event with its sources', async () => {
    const thanksgiving = holiday('2026-11-26', 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving');
    const path = `/api/org/locations/${LOCATION_ID}/calendar?from=2026-01-01&to=2026-12-31`;
    const api = analyticsFake({ [path]: calendarBody({ events: [thanksgiving] }) });
    const calendar = await fetchCalendar(api, LOCATION_ID, { from: '2026-01-01', to: '2026-12-31' });
    expect(api.paths).toEqual([path]);
    expect(calendar.events).toEqual([thanksgiving]);
    expect(calendar.covers).toEqual({ from: '2026-09-14', to: '2027-01-05' });
  });

  test('calendarRange runs from January 1 of the first year with data to the end of this year, inside the API rules', () => {
    expect(calendarRange('2024-03-05', '2026-11-05')).toEqual({ from: '2024-01-01', to: '2026-12-31' });
    expect(calendarRange(null, '2026-11-05')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(calendarRange('2027-02-01', '2026-11-05')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    const long = calendarRange('2010-05-01', '2031-06-01');
    expect(long.to).toBe('2031-12-31');
    expect(addDays(long.from, 7319)).toBe(long.to);
  });
});

describe('history', () => {
  test('byDate finds each day by its date', () => {
    const days = [day('2026-11-03', 120), day('2026-11-04', 90)];
    expect(byDate(days).get('2026-11-04')).toEqual(days[1]);
    expect(byDate(days).get('2026-11-05')).toBeUndefined();
  });
});

describe('day classification', () => {
  test('a note covers only its weekdays inside its range', () => {
    const saturdays = note({ startDate: '2026-11-01', endDate: '2026-11-30', weekdays: [6] });
    expect(notesOn('2026-11-07', [saturdays])).toEqual([saturdays]);
    expect(notesOn('2026-11-06', [saturdays])).toEqual([]);
    expect(notesOn('2026-12-05', [saturdays])).toEqual([]);
    const context = dayContext([saturdays], []);
    expect(context.notesByDate.get('2026-11-28')).toEqual([saturdays]);
    expect(context.notesByDate.has('2026-11-27')).toBe(false);
  });

  test('a multi-day event covers each of its days', () => {
    const term = townEvent({ title: 'Fall term classes', start: '2026-09-14', end: '2026-11-17', kind: 'term' });
    expect(eventsOn('2026-10-01', [term])).toEqual([term]);
    expect(eventsOn('2026-11-18', [term])).toEqual([]);
    expect(dayContext([], [term]).eventsByDate.size).toBe(65);
  });

  test('closed is a closing note or an all-zero row; a date with no row is no data, never closed', () => {
    const closure = note({ startDate: '2026-11-26', kind: 'closure', effect: 'closed' });
    const context = dayContext([closure], []);
    expect(isClosed('2026-11-26', undefined, context)).toBe(true);
    expect(isClosed('2026-11-25', day('2026-11-25', 0, 0), EMPTY_CONTEXT)).toBe(true);
    expect(isClosed('2026-11-25', day('2026-11-25', 0, null), EMPTY_CONTEXT)).toBe(true);
    expect(isClosed('2026-11-25', day('2026-11-25', null, 0), EMPTY_CONTEXT)).toBe(true);
    expect(isClosed('2026-11-25', day('2026-11-25', 0, 500), EMPTY_CONTEXT)).toBe(false);
    expect(isClosed('2026-11-25', day('2026-11-25', null, null), EMPTY_CONTEXT)).toBe(false);
    expect(isClosed('2026-11-24', undefined, context)).toBe(false);
  });

  test('the class is the first that applies: closed, noted, holiday, event, regular; terms never count', () => {
    const date = '2026-11-26';
    const thanksgiving = holiday(date, 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving');
    const game = townEvent({ title: 'Home football vs Brown', start: date });
    const term = townEvent({ title: 'Fall term', start: '2026-09-14', end: '2026-12-01', kind: 'term' });
    const party = note({ startDate: date });
    const closure = note({ startDate: date, kind: 'closure', effect: 'closed' });
    const record = day(date, 120);
    expect(classOf(date, record, dayContext([closure, party], [thanksgiving, game]))).toBe('closed');
    expect(classOf(date, record, dayContext([party], [thanksgiving, game]))).toBe('noted');
    expect(classOf(date, record, dayContext([], [thanksgiving, game]))).toBe('holiday');
    expect(classOf(date, record, dayContext([], [game, term]))).toBe('event');
    expect(classOf(date, record, dayContext([], [term]))).toBe('regular');
    // A closure note that didn't close the day still marks it as noted.
    expect(classOf(date, record, dayContext([note({ startDate: date, kind: 'closure', effect: 'fewer_guests' })], []))).toBe('noted');
  });
});

describe('filters and the basis line', () => {
  const days = [
    day('2025-11-27', 60), day('2025-11-28', 0, 0), day('2025-11-29', 150),
    day('2026-11-26', 70), day('2026-11-27', 120), day('2026-11-28', 140),
  ];
  const context = dayContext(
    [note({ startDate: '2026-11-28' })],
    [holiday('2025-11-27', 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving'), holiday('2026-11-26', 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving')],
  );

  test('defaults: guests when any day has them, every mark on, closed days left out, every year', () => {
    expect(defaultFilters(days)).toEqual({
      metric: 'guests',
      marks: ALL_ON,
      include: { closed: false, noted: true, eventDays: true },
      years: [2025, 2026],
    });
    expect(defaultFilters([day('2026-01-01', null, 5000)]).metric).toBe('netSales');
    expect(metricsWithData([day('2026-01-01', null, 5000)])).toEqual({ guests: false, netSales: true });
  });

  test('each "Include in the numbers" box and each year changes what is included', () => {
    const lookup = byDate(days);
    const included = (filters: Filters): string[] => days.map((each) => each.date).filter(includedFn(filters, lookup, context));
    const base = filtersFor(days);
    expect(included(base)).toEqual(['2025-11-27', '2025-11-29', '2026-11-26', '2026-11-27', '2026-11-28']);
    expect(included({ ...base, include: { ...base.include, closed: true } })).toHaveLength(6);
    expect(included({ ...base, include: { ...base.include, noted: false } })).not.toContain('2026-11-28');
    expect(included({ ...base, include: { ...base.include, eventDays: false } })).toEqual(['2025-11-29', '2026-11-27', '2026-11-28']);
    expect(included({ ...base, years: [2026] })).toEqual(['2026-11-26', '2026-11-27', '2026-11-28']);
  });

  test('the basis line says how many days the numbers rest on and what the filters leave out', () => {
    const base = filtersFor(days);
    expect(basisLine(days, base, context)).toBe('Based on 5 days with a guest count. Leaves out 1 closed day.');
    const strict = { ...base, include: { closed: false, noted: false, eventDays: false } };
    expect(basisOf(days, strict, context)).toEqual({ days: 2, leftOut: { closed: 1, noted: 1, eventDays: 2 } });
    expect(basisLine(days, strict, context)).toBe(
      'Based on 2 days with a guest count. Leaves out 1 closed day, 1 day with a note and 2 holiday and event days.',
    );
    expect(basisLine(days, { ...base, years: [2026] }, context)).toBe('Based on 3 days with a guest count. Only 2026.');
    expect(basisLine(days, { ...base, metric: 'netSales', include: { ...base.include, closed: true } }, context)).toBe('Based on 6 days with net sales.');
    expect(basisLine([], defaultFilters([]), context)).toBe('No days with net sales match your filters.');
  });

  test('the last checked year cannot be unchecked', () => {
    const base = filtersFor(days);
    const one = toggleYear(base, 2025, false);
    expect(one).toEqual({ filters: { ...base, years: [2026] }, refused: false });
    const last = toggleYear(one.filters, 2026, false);
    expect(last.refused).toBe(true);
    expect(last.filters.years).toEqual([2026]);
    expect(KEEP_ONE_YEAR).toBe('Keep at least one year.');
    expect(toggleYear(one.filters, 2025, true).filters.years).toEqual([2025, 2026]);
  });
});

describe('levels', () => {
  test('quartiles split the values into four equal levels', () => {
    const level = levelsFor([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(level)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });

  test('with fewer than 4 distinct values every day is level 3', () => {
    const level = levelsFor([5, 5, 9, 9, 12]);
    expect([5, 9, 12, 100].map(level)).toEqual([3, 3, 3, 3]);
    expect(levelsFor([])(1)).toBe(3);
  });
});

describe('usual', () => {
  // 2026-11-07 is a Saturday; its neighbours are the Saturdays 1 to 4 weeks either side.
  const date = '2026-11-07';
  const neighbours = [-28, -21, -14, -7, 7, 14, 21, 28].map((offset) => addDays(date, offset));

  test('is the mean of the same weekday in the 4 weeks either side, leaving out the day itself', () => {
    const days = [...neighbours.map((each, index) => day(each, 100 + index * 10)), day(date, 999)].sort((a, b) => a.date.localeCompare(b.date));
    const lookup = byDate(days);
    expect(usual(date, 'guests', lookup, EMPTY_CONTEXT, () => true)).toEqual({ mean: 135, days: 8 });
  });

  test('leaves out days that are not regular or that the filters leave out, and needs 3 days', () => {
    const days = neighbours.slice(0, 4).map((each) => day(each, 100));
    const lookup = byDate(days);
    const party = note({ startDate: neighbours[0] ?? '' });
    expect(usual(date, 'guests', lookup, dayContext([party], []), () => true)).toEqual({ mean: 100, days: 3 });
    expect(usual(date, 'guests', lookup, dayContext([party], []), (each) => each !== neighbours[1])).toBeNull();
    expect(usual(date, 'netSales', lookup, EMPTY_CONTEXT, () => true)).toEqual({ mean: 200_000, days: 4 });
  });
});

describe('weekly shape and by month', () => {
  // Two weeks in March 2026: Monday 2 to Sunday 15, guests rising by weekday; Saturdays busiest.
  const days = run('2026-03-02', '2026-03-15', (date) => (date.endsWith('07') || date.endsWith('14') ? 210 : 100 + Number(date.slice(8)) % 7));
  const input = analyticsInput(days, EMPTY_CONTEXT, defaultFilters(days));

  test('averages each weekday, Monday first', () => {
    const shape = weeklyShape(input);
    expect(shape.map((each) => each.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(shape.every((each) => each.n === 2)).toBe(true);
    expect(shape[5]).toEqual({ weekday: 6, n: 2, mean: 210 });
    expect(weeklySummary(shape, 'guests')).toBe('Your busiest day is Saturday, 210 guests on average; your quietest is Sunday, 101.');
  });

  test('averages each calendar month across the kept years', () => {
    const months = byMonth(input);
    expect(months).toHaveLength(12);
    expect(months[2]?.n).toBe(14);
    expect(months[0]).toEqual({ month: 1, n: 0, meanPerDay: null });
    expect(monthSummary(months, 'guests')).toMatch(/^Only March has data so far: 1\d\d guests a day on average\.$/);
    const two = analyticsInput([day('2026-01-10', 80), day('2026-02-10', 60), day('2026-10-10', 171)], EMPTY_CONTEXT, defaultFilters(days));
    expect(monthSummary(byMonth(two), 'guests')).toBe('October is your busiest month, 171 guests a day on average; February is the quietest, 60.');
    expect(weeklySummary(weeklyShape(analyticsInput([], EMPTY_CONTEXT, defaultFilters([]))), 'guests')).toBeNull();
  });
});

describe('year over year', () => {
  test('compares the newest year with the one before over months with at least 15 days in both', () => {
    const days = [...run('2025-01-01', '2025-12-31', () => 100), ...run('2026-01-01', '2026-11-04', () => 110)];
    const result = yearOverYear(analyticsInput(days, EMPTY_CONTEXT, defaultFilters(days)));
    expect(result.years).toEqual([2025, 2026]);
    expect(result.cells).toHaveLength(24);
    expect(result.cells.find((cell) => cell.year === 2026 && cell.month === 11)).toEqual({
      year: 2026, month: 11, n: 4, daysInMonth: 30, meanPerDay: 110, complete: false,
    });
    expect(result.summary?.months).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.summary?.change).toBeCloseTo(0.1);
    expect(yearOverYearSummary(result)).toBe(
      '2026 is running about 10% ahead of 2025, comparing 10 months (January to October) with at least 15 days in both years.',
    );
  });

  test('a month with fewer than 15 days in either year is not compared', () => {
    const days = [...run('2025-03-01', '2025-03-14', () => 100), ...run('2025-04-01', '2025-04-30', () => 100), ...run('2026-03-01', '2026-04-30', () => 90)];
    const result = yearOverYear(analyticsInput(days, EMPTY_CONTEXT, defaultFilters(days)));
    expect(result.summary?.months).toEqual([4]);
    expect(yearOverYearSummary(result)).toBe('2026 is running about 10% behind 2025, comparing 1 month (April) with at least 15 days in both years.');
  });

  test('without a year before this one it says what is missing', () => {
    const days = run('2026-03-01', '2026-10-31', () => 100);
    const result = yearOverYear(analyticsInput(days, EMPTY_CONTEXT, defaultFilters(days)));
    expect(result.summary).toBeNull();
    expect(yearOverYearSummary(result)).toBe(
      'Year over year needs at least one full year before this one. You have 8 months so far. Older exports from your point-of-sale system would fill it in.',
    );
  });
});

describe('by type of night', () => {
  const thanksgiving = (date: string) => holiday(date, 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving');

  test('averages each type against regular nights, and under 2 nights gives no average', () => {
    const days = run('2025-11-01', '2025-11-30', (date) => (date === '2025-11-27' ? 150 : date === '2025-11-15' ? 200 : 100));
    const context = dayContext(
      [note({ startDate: '2025-11-15' }), note({ startDate: '2025-11-20', kind: 'closure', effect: 'closed' })],
      [thanksgiving('2025-11-27'), townEvent({ title: 'Homecoming', start: '2025-11-08' }), townEvent({ title: 'Game', start: '2025-11-22' })],
    );
    const nights = nightTypes(analyticsInput(days, context, defaultFilters(days)));
    expect(nights.map((night) => [night.type, night.n, night.mean])).toEqual([
      ['regular', 25, 100], ['holiday', 1, null], ['event', 2, 100], ['noted', 1, null], ['closed', 1, null],
    ]);
    expect(nights.map((night) => nightLine(night, 'guests'))).toEqual([
      'Regular nights: 25 nights, 100 guests on average, the baseline.',
      'Holidays: 1 night. Not enough nights yet.',
      'Town event days: 2 nights, 100 guests on average, 0% against regular nights.',
      'Your events (from notes): 1 night. Not enough nights yet.',
      'Closed: 1 night.',
    ]);
  });

  test('counts closures the export skipped, and says when the filters leave a type out', () => {
    const days = [...run('2024-11-20', '2024-11-30', (date) => (date === '2024-11-28' ? null : 100)), ...run('2025-11-20', '2025-11-30', () => 140)];
    const context = dayContext(
      [note({ startDate: '2024-11-28', kind: 'closure', effect: 'closed' })],
      [thanksgiving('2025-11-27'), thanksgiving('2024-11-28'), holiday('2025-11-21', 'A day', 'x', 'X')],
    );
    const base = defaultFilters(days);
    const nights = nightTypes(analyticsInput(days, context, { ...base, include: { ...base.include, eventDays: false } }));
    expect(nights.find((night) => night.type === 'closed')?.n).toBe(1);
    const holidays = nights.find((night) => night.type === 'holiday');
    expect(holidays).toMatchObject({ n: 2, mean: null, leftOut: true });
    if (holidays === undefined) throw new Error('expected a holidays row');
    expect(nightLine(holidays, 'guests')).toBe('Holidays: 2 nights, left out by your filters.');
  });
});

describe('biggest drivers', () => {
  // Thursdays and Saturdays are 100 a night; Thanksgiving is half that, private events 30% more.
  const days = run('2023-10-01', '2026-11-04', () => 100).map((each) => {
    if (['2023-11-23', '2024-11-28', '2025-11-27'].includes(each.date)) return day(each.date, 50);
    if (['2026-03-07', '2026-04-04', '2026-05-02', '2026-06-06'].includes(each.date)) return day(each.date, 130);
    return each;
  });
  const events = ['2023-11-23', '2024-11-28', '2025-11-27'].map((date) => holiday(date, 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving'));
  const notes = ['2026-03-07', '2026-04-04', '2026-05-02', '2026-06-06'].map((date) => note({ startDate: date }));

  test('ranks recurring days by how far they move the metric from usual, marking under 4 days rough', () => {
    const found = drivers(analyticsInput(days, dayContext(notes, events), defaultFilters(days)));
    expect(found.map((each) => [each.key, each.label, Math.round(each.effect * 100), each.dates.length, each.rough])).toEqual([
      ['us:thanksgiving', 'Thanksgiving', -50, 3, true],
      ['notes:private_event', 'Your private events', 30, 4, false],
    ]);
    expect(found.map(seenText)).toEqual(['3 days, 2023 to 2025', '4 days, 2026']);
    expect(found.map(driverLine)).toEqual([
      'Thanksgiving: −50% against usual, 3 days, 2023 to 2025. Rough.',
      'Your private events: +30% against usual, 4 days, 2026.',
    ]);
  });

  test('a kind of day seen once is not a driver, and the empty line says why', () => {
    const once = drivers(analyticsInput(days, dayContext([], events.slice(0, 1)), defaultFilters(days)));
    expect(once).toEqual([]);
    expect(DRIVERS_EMPTY).toBe('Townwise needs each kind of day to happen at least twice before it can say how much it moves your numbers.');
  });

  test('holiday days are measured even when the filters leave them out; closed occurrences and unchecked years are not', () => {
    const base = defaultFilters(days);
    const left = drivers(analyticsInput(days, dayContext([], events), { ...base, include: { ...base.include, eventDays: false } }));
    expect(left[0]?.dates).toHaveLength(3);
    const closedOne = drivers(analyticsInput(days, dayContext([note({ startDate: '2023-11-23', kind: 'closure', effect: 'closed' })], events), base));
    expect(closedOne[0]?.dates).toEqual(['2024-11-28', '2025-11-27']);
    const fewerYears = drivers(analyticsInput(days, dayContext([], events), { ...base, years: [2025, 2026] }));
    expect(fewerYears).toEqual([]);
  });

  test('keeps the top 8', () => {
    // Ten kinds of day, each seen twice, moving guests 5% to 50%.
    const many = Array.from({ length: 10 }, (_, index) => ['2024-01-04', '2025-01-04'].map((start) => holiday(
      addDays(start, index * 14), `Day ${String(index)}`, `g:${String(index)}`, `Day ${String(index)}`,
    ))).flat();
    const lift = new Map(many.map((event, index) => [event.start, 105 + Math.floor(index / 2) * 5]));
    const shaped = days.map((each) => {
      const value = lift.get(each.date);
      return value === undefined ? each : day(each.date, value);
    });
    const found = drivers(analyticsInput(shaped, dayContext([], many), defaultFilters(shaped)));
    expect(found).toHaveLength(8);
    expect(found[0]?.key).toBe('g:9');
  });
});

describe('heatmap cells', () => {
  const thanksgiving = holiday('2026-11-26', 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving');
  const game = townEvent({ title: 'Home football vs Brown', start: '2026-11-21' });
  const party = note({ startDate: '2026-11-21', detail: 'Rehearsal dinner' });
  const closure = note({ startDate: '2026-11-25', kind: 'closure', effect: 'closed' });
  const days = [
    ...run('2026-11-01', '2026-11-24', (date) => 100 + Number(date.slice(8))),
    day('2026-11-26', 40), day('2026-11-27', 0, 0),
  ];
  const context = dayContext([party, closure], [thanksgiving, game]);
  const filters = defaultFilters(days);
  const input: HeatmapInput = {
    days, metric: 'guests', marks: ALL_ON, context, included: includedFn(filters, byDate(days), context), years: [2026], today: '2026-11-28',
  };
  const cellAt = (blocks: ReturnType<typeof heatmapBlocks>, date: string): Cell | undefined => blocks[0]?.rows[rowOf(date)]?.[colOf(date)] ?? undefined;

  test('lays each year out as week columns by weekday rows, Monday first', () => {
    expect(rowOf('2026-01-01')).toBe(3);
    expect(colOf('2026-01-01')).toBe(0);
    expect(colOf('2026-01-05')).toBe(1);
    const [block] = heatmapBlocks(input);
    expect(block?.weeks).toBe(53);
    expect(block?.rows).toHaveLength(7);
    expect(block?.rows[0]?.[0]).toBeNull();
    expect(block?.months[0]).toEqual({ month: 1, col: 0 });
    expect(block?.months[10]).toEqual({ month: 11, col: colOf('2026-11-01') });
    expect(block?.label).toBe('2026, daily guests');
    // A leap year that starts on a Sunday needs a 54th column.
    expect(colOf('2012-12-31') + 1).toBe(54);
  });

  test('newest year first, and one fill scale for every block', () => {
    const two = [day('2025-06-01', 10), day('2025-06-02', 20), day('2026-06-01', 30), day('2026-06-02', 40)];
    const blocks = heatmapBlocks({ ...input, days: two, context: EMPTY_CONTEXT, included: () => true, years: [2025, 2026] });
    expect(blocks.map((block) => block.year)).toEqual([2026, 2025]);
    expect(blocks[1]?.rows[rowOf('2025-06-01')]?.[colOf('2025-06-01')]?.level).toBe(1);
    expect(blocks[0]?.rows[rowOf('2026-06-02')]?.[colOf('2026-06-02')]?.level).toBe(4);
  });

  test('each cell says what its fill and marks show', () => {
    const blocks = heatmapBlocks(input);
    expect(cellAt(blocks, '2026-11-21')).toMatchObject({
      state: 'value', eventMark: true, noteMark: true, focusable: true,
      label: 'Sat, Nov 21, 2026. 121 guests, $2,420. Town event: Home football vs Brown. 1 note.',
    });
    expect(cellAt(blocks, '2026-11-25')).toMatchObject({ state: 'closed', level: null, label: 'Wed, Nov 25, 2026. No data. 1 note. Closed.' });
    expect(cellAt(blocks, '2026-11-26')).toMatchObject({ state: 'value', eventMark: true, label: 'Thu, Nov 26, 2026. 40 guests, $800. Holiday: Thanksgiving Day.' });
    expect(cellAt(blocks, '2026-11-27')).toMatchObject({ state: 'closed', label: 'Fri, Nov 27, 2026. 0 guests, $0. Closed. Left out by your filters.' });
    expect(cellAt(blocks, '2026-11-28')).toMatchObject({ state: 'no_data', label: 'Sat, Nov 28, 2026. No data.' });
    expect(cellAt(blocks, '2026-11-29')).toMatchObject({ state: 'future', label: '', focusable: false });
  });

  test('turning a mark off takes it out of the cell and its label; closures off shows a left-out day', () => {
    const blocks = heatmapBlocks({ ...input, marks: { townEvents: false, holidays: true, notes: false, closures: false } });
    expect(cellAt(blocks, '2026-11-21')).toMatchObject({ eventMark: false, noteMark: false, label: 'Sat, Nov 21, 2026. 121 guests, $2,420.' });
    expect(cellAt(blocks, '2026-11-26')?.eventMark).toBe(true);
    expect(cellAt(blocks, '2026-11-27')).toMatchObject({ state: 'left_out', label: 'Fri, Nov 27, 2026. 0 guests, $0. Left out by your filters.' });
    expect(cellAt(blocks, '2026-11-25')).toMatchObject({ state: 'no_data' });
  });

  test('Reading: days in the pending range with no row are not read yet', () => {
    const blocks = heatmapBlocks({ ...input, pending: { from: '2026-11-25', to: '2026-11-28' } });
    expect(cellAt(blocks, '2026-11-28')).toMatchObject({ state: 'pending', label: 'Sat, Nov 28, 2026. Not read yet.' });
    expect(cellAt(blocks, '2026-11-26')?.state).toBe('value');
    expect(cellLabel('2026-11-28', undefined, input, true)).toBe('Sat, Nov 28, 2026. Not read yet.');
  });

  test('the summary names the range, the busiest and quietest open days, closed days and what the calendar covers', () => {
    expect(heatmapSummary(input, calendarBody())).toBe(
      'Daily guests, Nov 1, 2026 to Nov 27, 2026. Busiest: 124 on Tue, Nov 24, 2026. Quietest open day: 40 on Thu, Nov 26, 2026. '
      + '2 closed days. Town events are marked for Sep 2026 to Jan 2027, the dates Townwise’s Hanover calendar covers so far.',
    );
    expect(heatmapSummary({ ...input, years: [2025] }, null)).toBeNull();
  });

  test('the calendar line is honest about towns Townwise has not researched', () => {
    expect(calendarCoverageLine(calendarBody({ town: { townId: null, name: 'Woodstock', state: 'VT' }, researched: false, covers: null })))
      .toBe('Townwise hasn’t researched Woodstock, VT yet, so only US federal holidays are marked.');
    expect(calendarCoverageLine(calendarBody({ town: { townId: 'nantucket-ma', name: 'Nantucket', state: 'MA' }, researched: false, covers: null })))
      .toBe('Townwise’s Nantucket calendar has no researched town events yet, so only US federal holidays are marked.');
  });
});

describe('heatmap keys', () => {
  const days = [day('2025-03-03', 1), day('2026-11-04', 1)];
  const bounds = focusBounds(days, [2025, 2026], '2026-11-05');
  if (bounds === null) throw new Error('expected bounds');

  test('focus runs from January 1 of the first shown year to today', () => {
    expect(bounds).toEqual({ first: '2025-01-01', last: '2026-11-05', firstData: '2025-03-03', lastData: '2026-11-04', years: [2025, 2026] });
    expect(initialFocus(null, bounds)).toBe('2026-11-04');
    expect(initialFocus('2026-02-10', bounds)).toBe('2026-02-10');
    expect(initialFocus('2026-11-20', bounds)).toBe('2026-11-04');
    expect(focusBounds(days, [], '2026-11-05')).toBeNull();
  });

  test('arrows move a day or a week; Home and End go to the week’s Monday and Sunday', () => {
    // 2026-03-04 is a Wednesday.
    expect(moveFocus('2026-03-04', 'ArrowUp', false, bounds)).toBe('2026-03-03');
    expect(moveFocus('2026-03-04', 'ArrowDown', false, bounds)).toBe('2026-03-05');
    expect(moveFocus('2026-03-04', 'ArrowLeft', false, bounds)).toBe('2026-02-25');
    expect(moveFocus('2026-03-04', 'ArrowRight', false, bounds)).toBe('2026-03-11');
    expect(moveFocus('2026-03-04', 'Home', false, bounds)).toBe('2026-03-02');
    expect(moveFocus('2026-03-04', 'End', false, bounds)).toBe('2026-03-08');
    expect(moveFocus('2026-03-04', 'Tab', false, bounds)).toBeNull();
  });

  test('PageUp and PageDown move 52 weeks, across year blocks; Ctrl+Home and Ctrl+End go to the first and last day with data', () => {
    expect(moveFocus('2026-03-04', 'PageUp', false, bounds)).toBe('2025-03-05');
    expect(moveFocus('2025-03-05', 'PageDown', false, bounds)).toBe('2026-03-04');
    expect(moveFocus('2026-03-04', 'Home', true, bounds)).toBe('2025-03-03');
    expect(moveFocus('2025-03-04', 'End', true, bounds)).toBe('2026-11-04');
    expect(moveFocus('2026-01-01', 'ArrowUp', false, bounds)).toBe('2025-12-31');
  });

  test('a move past today, before the first year or into a hidden year keeps focus where it is', () => {
    expect(moveFocus('2026-11-05', 'ArrowDown', false, bounds)).toBe('2026-11-05');
    expect(moveFocus('2026-11-01', 'ArrowRight', false, bounds)).toBe('2026-11-01');
    expect(moveFocus('2025-01-01', 'ArrowUp', false, bounds)).toBe('2025-01-01');
    expect(moveFocus('2025-03-04', 'PageUp', false, bounds)).toBe('2025-03-04');
    // Home and End stay inside the day's year: 2025-01-01 is a Wednesday.
    expect(moveFocus('2025-01-01', 'Home', false, bounds)).toBe('2025-01-01');
    expect(moveFocus('2026-11-04', 'End', false, bounds)).toBe('2026-11-05');
    const gap = focusBounds([day('2024-03-03', 1), day('2026-03-03', 1)], [2024, 2026], '2026-11-05');
    if (gap === null) throw new Error('expected bounds');
    expect(moveFocus('2026-03-04', 'PageUp', false, gap)).toBe('2026-03-04');
  });
});

describe('the day panel', () => {
  const thanksgiving = holiday('2026-11-26', 'Thanksgiving Day', 'us:thanksgiving', 'Thanksgiving');
  const weekend = townEvent({ title: 'Homecoming weekend', start: '2026-11-20', end: '2026-11-22' });
  const party = note({ startDate: '2026-11-21', expectedGuests: 80, detail: 'Rehearsal dinner' });
  const days = [
    ...run('2025-10-01', '2025-12-31', () => 100),
    ...run('2026-10-01', '2026-11-23', (date) => (date === '2026-11-21' ? 241 : 184)),
    { ...day('2026-11-24', 150), upload: 1 },
  ];
  const uploads = [upload(), upload({ id: '00000000-0000-0000-0000-00000000a002', status: 'applying', uploadedAt: '2026-11-25T10:00:00.000Z' })];
  const context = dayContext([party], [thanksgiving, weekend]);
  const lookup = byDate(days);
  const filters = defaultFilters(days);
  const input: PanelInput = {
    byDate: lookup, context, uploads, metric: 'guests', included: includedFn(filters, lookup, context), today: '2026-11-26',
    lastDate: '2026-11-24', calendar: calendarBody(),
  };

  test('shows the day’s numbers, usual, last year, the town calendar with sources, notes and the upload', () => {
    expect(dayPanel('2026-11-21', input)).toEqual({
      date: '2026-11-21',
      heading: 'Saturday, Nov 21, 2026',
      status: [],
      numbers: [
        { label: 'Guests', value: '241' },
        { label: 'Net sales', value: '$4,820' },
        { label: 'Usual for a Saturday', value: '184 guests, from 4 Saturdays. This day: +31%.' },
        { label: 'Same day last year', value: 'Sat, Nov 22, 2025: 100 guests' },
      ],
      events: [{
        id: weekend.id, title: 'Homecoming weekend', dates: 'Nov 20, 2026 to Nov 22, 2026', kind: 'Town event',
        sources: [{ label: 'home.dartmouth.edu', url: 'https://home.dartmouth.edu/' }],
      }],
      calendarNote: null,
      notes: [{
        id: party.id, words: 'Private event, more guests than usual', dates: null, weekdays: null,
        expected: 'Expected guests: 80', detail: 'Rehearsal dinner', addedBy: `Added by ${OWNER_EMAIL}`,
      }],
      source: { line: `From the upload on Nov 4, 2026 by ${OWNER_EMAIL}.`, warning: null, file: null },
    });
  });

  test('after the last day of data it gives no usual, and says there is no data', () => {
    const panel = dayPanel('2026-11-26', input);
    expect(panel.status).toEqual(['No data for this day', 'Today']);
    expect(panel.numbers.map((each) => each.label)).toEqual(['Guests', 'Net sales', 'Same day last year']);
    expect(panel.numbers[0]?.value).toBe('No guest count');
    expect(panel.events[0]).toMatchObject({ title: 'Thanksgiving Day', kind: 'Holiday', dates: null });
    expect(panel.source).toBeNull();
  });

  test('an unfinished upload and a missing upload record say so', () => {
    expect(dayPanel('2026-11-24', input).source).toEqual({
      line: `From the upload on Nov 25, 2026 by ${OWNER_EMAIL}.`, warning: 'This upload didn’t finish.', file: null,
    });
    const missing = byDate([{ ...day('2026-11-24', 150), upload: -1 }]);
    expect(dayPanel('2026-11-24', { ...input, byDate: missing }).source).toEqual({ line: 'Upload record not found.', warning: null, file: null });
  });

  test('closed and left-out days say so, and a thin baseline says it is not enough', () => {
    const closedDays = byDate([day('2026-11-23', 0, 0)]);
    const panel = dayPanel('2026-11-23', { ...input, byDate: closedDays, included: () => false });
    expect(panel.status).toEqual(['Closed', 'Left out of the numbers by your filters']);
    expect(panel.numbers[2]).toEqual({ label: 'Usual for a Monday', value: 'Not enough similar days' });
  });

  test('the calendar note is honest about what the town research covers', () => {
    expect(dayPanel('2026-03-01', input).calendarNote).toBe('Hanover’s researched calendar doesn’t cover this date.');
    expect(dayPanel('2026-03-01', { ...input, calendar: calendarBody({ town: { townId: null, name: 'Woodstock', state: 'VT' }, researched: false, covers: null }) }).calendarNote)
      .toBe('Townwise hasn’t researched Woodstock, VT yet. Only US federal holidays and your notes show here.');
    expect(dayPanel('2026-03-01', { ...input, calendar: null }).calendarNote).toBeNull();
  });

  test('notes read in words, with their range and weekdays', () => {
    expect(noteWords({ kind: 'closure', effect: 'closed' })).toBe('Closure');
    expect(noteWords({ kind: 'opening', effect: 'unknown' })).toBe('Opening, effect not known');
    expect(noteWords({ kind: 'other', effect: 'fewer_guests' })).toBe('Other, fewer guests than usual');
    const weekly = note({ startDate: '2026-11-01', endDate: '2026-11-30', weekdays: [6], kind: 'other', effect: 'fewer_guests', detail: 'Road work' });
    const panel = dayPanel('2026-11-07', { ...input, context: dayContext([weekly], []) });
    expect(panel.notes[0]).toMatchObject({ dates: 'Nov 1, 2026 to Nov 30, 2026', weekdays: 'Saturdays only', detail: 'Road work' });
  });
});

describe('words', () => {
  test('dates carry their weekday and percentages a true minus', () => {
    expect(shortDate('2026-11-21')).toBe('Sat, Nov 21, 2026');
    expect(longDate('2026-11-21')).toBe('Saturday, Nov 21, 2026');
    expect([0.31, -0.124, 0.004, -0.004].map(signedPercent)).toEqual(['+31%', '−12%', '0%', '0%']);
  });
});
