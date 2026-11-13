import type { TownEvent } from '../../../src/portal/analytics/api';
import {
  ALL_FILTERS, calendarMonth, dayView, forecastWords, monthBounds, pastRange, reasonOutcomeWords, selectedDay, tooltipLines,
  type CalendarCell, type CalendarInput, type ImportedEvent,
} from '../../../src/portal/calendar/model';
import type { ForecastDay, ForecastWindow } from '../../../src/portal/estimates/api';
import { daysBetween } from '../../../src/portal/locations/dates';
import { holiday, note, townEvent } from '../analytics/fakes';

// The Calendar's pure model (P27, spec 16.3): each day's figure, marks, chips and words, the day
// panel's parts, the filters and the month bounds. The client never adds a note's guests itself: every figure after
// today is the published forecast's own (spec 14.5). Synthetic figures only.

const TODAY = '2026-11-11';

function forecastDay(fields: Partial<ForecastDay> & Pick<ForecastDay, 'date'>): ForecastDay {
  return {
    status: 'open', low: 180, mid: 212.4, high: 240, model: { status: 'open', low: 180, mid: 212.4, high: 240 }, noteGuests: 0, moreNotes: 0,
    reasons: [{ kind: 'weekday', label: 'Saturday', effectPct: null, sources: [], note: null }], runId: 'r1', actual: null, inRange: null,
    ...fields,
  };
}

function windowOf(days: ForecastDay[]): ForecastWindow {
  return { available: true, reason: null, runs: [{ id: 'r1', model: { label: 'Townwise demand model v9' }, madeAt: '2026-11-01', live: null }], days, weeks: [] };
}

const NONE: ForecastWindow = { available: false, reason: 'no_published_forecast', runs: [], days: [], weeks: [] };

const NOTED = forecastDay({
  date: '2026-11-21', low: 250, mid: 282.4, high: 310, noteGuests: 70,
  reasons: [
    { kind: 'note', label: 'Your private event, 70 guests, 6 pm to 9 pm', effectPct: null, sources: [], note: { id: 'n1', guests: 70, outcome: 'added' } },
    { kind: 'event', label: 'Dartmouth home football', effectPct: 12, sources: [{ label: 'dartmouthsports.com', url: 'https://dartmouthsports.com/' }], note: null },
    { kind: 'weekday', label: 'Saturday', effectPct: null, sources: [], note: null },
    { kind: 'term', label: 'Fall term classes', effectPct: null, sources: [], note: null },
  ],
});
const BOOKED = forecastDay({
  date: '2026-11-14', status: 'booked', low: null, mid: null, high: null, noteGuests: 70,
  reasons: [{ kind: 'note', label: 'Your private buyout, 70 guests', effectPct: null, sources: [], note: { id: 'n2', guests: 70, outcome: 'booked' } }],
});
const CLOSED = forecastDay({
  date: '2026-11-26', status: 'closed', low: null, mid: null, high: null,
  reasons: [{ kind: 'note', label: 'Your closure', effectPct: null, sources: [], note: { id: 'n3', guests: null, outcome: 'closed' } }],
});
const PAST = forecastDay({ date: '2026-11-07', low: 120, mid: 135, high: 150, model: { status: 'open', low: 120, mid: 135, high: 150 }, actual: 138, inRange: true });

const GAME: TownEvent = townEvent({ start: '2026-11-21', title: 'Dartmouth home football' });
const VETERANS: TownEvent = holiday('2026-11-11', 'Veterans Day', 'us:veterans', 'Veterans Day');
const TERM: TownEvent = townEvent({ id: 'hanover-nh:term', start: '2026-09-14', end: '2026-11-17', title: 'Fall term classes', kind: 'term' });
const PARTY = note({ startDate: '2026-11-21', expectedGuests: 70, startTime: '18:00', endTime: '21:00', detail: 'A rehearsal dinner.' });
const IMPORTED: ImportedEvent = { uid: 'u1', title: 'Wine delivery', startDate: '2026-11-21', endDate: '2026-11-21', startTime: '09:00', endTime: '10:00' };

function input(fields: Partial<CalendarInput> = {}): CalendarInput {
  return {
    today: TODAY, month: '2026-11', forecast: windowOf([PAST, NOTED, BOOKED, CLOSED, forecastDay({ date: TODAY })]),
    salesDays: [{ date: '2026-11-07', guests: 138, netSalesCents: 276000 }, { date: '2026-11-08', guests: null, netSalesCents: 1000 }],
    events: [GAME, VETERANS, TERM], notes: [PARTY], imported: [IMPORTED], filters: ALL_FILTERS, ...fields,
  };
}

function cellOf(rows: readonly (readonly (CalendarCell | null)[])[], date: string): CalendarCell {
  const cell = rows.flat().find((each) => each?.date === date);
  if (cell === undefined || cell === null) throw new Error(`no cell for ${date}`);
  return cell;
}

test('a future day shows the forecast’s rounded mid and +N when notes added guests; a booked day its party; a closed day no figure', () => {
  const rows = calendarMonth(input());
  // Monday first, with null outside the month: Nov 1, 2026 is a Sunday.
  expect(rows[0]?.slice(0, 6)).toEqual([null, null, null, null, null, null]);
  expect(rows[0]?.[6]?.date).toBe('2026-11-01');
  expect(cellOf(rows, '2026-11-21')).toMatchObject({ figure: { value: 282, kind: 'forecast' }, noteGuests: 70, status: null });
  expect(cellOf(rows, TODAY)).toMatchObject({ figure: { value: 212, kind: 'forecast' }, noteGuests: 0, isToday: true, inWeek: true });
  expect(cellOf(rows, '2026-11-14')).toMatchObject({ figure: { value: 70, kind: 'booked' }, status: 'booked' });
  expect(cellOf(rows, '2026-11-26')).toMatchObject({ figure: null, status: 'closed' });
  // A future day the forecast doesn't cover shows nothing.
  expect(cellOf(rows, '2026-11-30').figure).toBeNull();
  // Today's week (Mon Nov 9 to Sun Nov 15) is outlined; the week after is not.
  expect(cellOf(rows, '2026-11-09').inWeek).toBe(true);
  expect(cellOf(rows, '2026-11-16').inWeek).toBe(false);
});

test('a past day shows its stored guests and never a forecast figure', () => {
  const rows = calendarMonth(input());
  expect(cellOf(rows, '2026-11-07')).toMatchObject({ figure: { value: 138, kind: 'actual' }, status: null });
  // No stored guests: nothing, though net sales were stored.
  expect(cellOf(rows, '2026-11-08').figure).toBeNull();
  // A past day the run covered, with no stored day, still shows no forecast figure.
  const noSales = calendarMonth(input({ salesDays: [] }));
  expect(cellOf(noSales, '2026-11-07').figure).toBeNull();
});

test('no published forecast: no figure after today on any day', () => {
  for (const forecast of [NONE, null]) {
    const rows = calendarMonth(input({ forecast }));
    const future = rows.flat().filter((cell): cell is CalendarCell => cell !== null && cell.date >= TODAY);
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((cell) => cell.figure === null && cell.status === null)).toBe(true);
  }
  expect(dayView('2026-11-21', input({ forecast: NONE })).forecast).toEqual({ kind: 'none', why: 'no_published_forecast' });
  expect(dayView('2026-11-30', input()).forecast).toEqual({ kind: 'none', why: 'not_covered' });
  expect(dayView('2026-11-21', input({ forecast: null })).forecast).toEqual({ kind: 'none', why: 'unavailable' });
});

test('filters hide holidays, town events, term dates, notes and imported events by kind', () => {
  const all = dayView('2026-11-21', input());
  expect(all.events.map((event) => event.title)).toEqual(['Dartmouth home football']);
  expect(all.notes.map((each) => each.id)).toEqual([PARTY.id]);
  expect(all.imported.map((event) => event.title)).toEqual(['Wine delivery']);
  expect(cellOf(calendarMonth(input()), '2026-11-21')).toMatchObject({
    chips: ['Dartmouth home football', 'Private event, 70'], more: 1, marks: { event: true, note: true, imported: true },
  });
  // Term periods show in the day panel only: they span weeks, so no cell repeats them.
  expect(dayView('2026-11-12', input()).events.map((event) => event.title)).toEqual(['Fall term classes']);
  expect(cellOf(calendarMonth(input()), '2026-11-12').chips).toEqual([]);

  const off = (key: keyof CalendarInput['filters']): CalendarInput => input({ filters: { ...ALL_FILTERS, [key]: false } });
  expect(dayView('2026-11-11', off('holidays')).events.map((event) => event.title)).toEqual(['Fall term classes']);
  expect(cellOf(calendarMonth(off('holidays')), '2026-11-11').marks.event).toBe(false);
  expect(dayView('2026-11-21', off('events')).events).toEqual([]);
  expect(dayView('2026-11-12', off('terms')).events).toEqual([]);
  expect(dayView('2026-11-21', off('notes')).notes).toEqual([]);
  expect(dayView('2026-11-21', off('imported')).imported).toEqual([]);
  const quiet = cellOf(calendarMonth(input({ filters: { ...ALL_FILTERS, events: false, notes: false, imported: false } })), '2026-11-21');
  expect(quiet).toMatchObject({ chips: [], more: 0, marks: { event: false, note: false, imported: false } });
  // Filters never hide a figure or the forecast's reasons.
  expect(quiet.figure).toEqual({ value: 282, kind: 'forecast' });
  expect(dayView('2026-11-21', off('notes')).reasons).toHaveLength(4);
});

test('the cell label says the figure, range, note guests, events and notes', () => {
  const rows = calendarMonth(input());
  expect(cellOf(rows, '2026-11-21').label).toBe(
    'Sat, Nov 21, 2026. Forecast about 282 guests, 250 to 310. Includes 70 guests from your notes. Dartmouth home football. 1 note. From your calendar: Wine delivery.',
  );
  expect(cellOf(rows, TODAY).label).toBe('Wed, Nov 11, 2026. Today. Forecast about 212 guests, 180 to 240. Veterans Day.');
  expect(cellOf(rows, '2026-11-14').label).toBe('Sat, Nov 14, 2026. Booked: a private buyout, 70 guests.');
  expect(cellOf(rows, '2026-11-26').label).toBe('Thu, Nov 26, 2026. Closed.');
  expect(cellOf(rows, '2026-11-07').label).toBe('Sat, Nov 7, 2026. 138 guests.');
  expect(cellOf(rows, '2026-11-30').label).toBe('Mon, Nov 30, 2026.');
});

test('the day panel words a forecast; the 8 in 10 sentence goes with the model’s own range only', () => {
  const plain = dayView(TODAY, input());
  expect(plain.heading).toBe('Today, Wed, Nov 11');
  expect(forecastWords(plain.forecast, 'Sawtooth')).toEqual({
    figure: { before: 'About', value: '212', after: 'guests' },
    lines: ['Likely 180 to 240. About 8 in 10 days land in the range.'],
  });
  const noted = dayView('2026-11-21', input());
  expect(noted.heading).toBe('Sat, Nov 21, 2026');
  expect(forecastWords(noted.forecast, 'Sawtooth').lines).toEqual([
    'Likely 250 to 310.',
    'Townwise’s model: 180 to 240. About 8 in 10 days land in that range. Your notes add 70 guests.',
  ]);
  expect(forecastWords(dayView('2026-11-14', input()).forecast, 'Sawtooth')).toEqual({
    figure: null, lines: ['Booked: a private buyout, 70 guests. No walk-in forecast.'],
  });
  expect(forecastWords(dayView('2026-11-26', input()).forecast, 'Sawtooth').lines).toEqual(['Closed.', 'From your closure note.']);
  expect(forecastWords(dayView('2026-11-07', input()).forecast, 'Sawtooth')).toEqual({
    figure: { before: '', value: '138', after: 'guests' },
    lines: ['Townwise’s model forecast 120 to 150, and the day landed in that range.'],
  });
  expect(forecastWords(dayView('2026-11-21', input({ forecast: NONE })).forecast, 'Sawtooth').lines).toEqual([
    'No forecast for this day.', 'Townwise hasn’t published a forecast for Sawtooth yet.',
  ]);
  // Reasons in the API's order, a note's with what it did, a run reason with its effect and sources.
  expect(noted.reasons.map((reason) => [reason.label, reason.detail])).toEqual([
    ['Your private event, 70 guests, 6 pm to 9 pm', 'Adds 70 guests'],
    ['Dartmouth home football', '+12%'],
    ['Saturday', null],
    ['Fall term classes', null],
  ]);
  expect(noted.reasons[1]?.sources).toEqual([{ label: 'dartmouthsports.com', url: 'https://dartmouthsports.com/' }]);
});

test('the tooltip holds the range, the notes’ guests and at most three reasons', () => {
  expect(tooltipLines('2026-11-21', input())).toEqual({
    date: 'Sat, Nov 21, 2026',
    lines: ['About 282 guests (250 to 310)', 'Includes 70 guests from your notes', 'Your private event, 70 guests, 6 pm to 9 pm', 'Dartmouth home football', 'Saturday'],
  });
  expect(tooltipLines('2026-11-07', input())?.lines).toEqual(['138 guests', 'Saturday']);
  expect(tooltipLines('2026-11-30', input())).toBeNull();
});

test('monthBounds allows 12 months back and 12 ahead, inside the API’s 400 days', () => {
  for (const today of ['2026-11-11', '2026-01-01', '2026-12-31', '2024-02-29']) {
    const bounds = monthBounds(today);
    const first = `${bounds.first}-01`;
    const last = bounds.lastDay;
    expect(daysBetween(first, today)).toBeLessThanOrEqual(400);
    expect(daysBetween(today, last)).toBeLessThanOrEqual(400);
  }
  expect(monthBounds(TODAY)).toEqual({ first: '2025-11', last: '2027-11', lastDay: '2027-11-30' });
  // A day outside the bounds, or not a date, falls back to today.
  expect(selectedDay('2027-11-30', TODAY)).toBe('2027-11-30');
  expect(selectedDay('2025-11-01', TODAY)).toBe('2025-11-01');
  expect(selectedDay('2027-12-01', TODAY)).toBe(TODAY);
  expect(selectedDay('2025-10-31', TODAY)).toBe(TODAY);
  expect(selectedDay('2026-02-30', TODAY)).toBe(TODAY);
  expect(selectedDay(undefined, TODAY)).toBe(TODAY);
  // The past part of a month, for GET .../sales/days: none for this month's first day or a later month.
  expect(pastRange('2026-11', TODAY)).toEqual({ from: '2026-11-01', to: '2026-11-10' });
  expect(pastRange('2026-10', TODAY)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
  expect(pastRange('2026-12', TODAY)).toBeNull();
  expect(pastRange('2026-11', '2026-11-01')).toBeNull();
});

test('reasonOutcomeWords words every NoteOutcome', () => {
  expect(reasonOutcomeWords('added', 70)).toBe('Adds 70 guests');
  expect(reasonOutcomeWords('added', 1)).toBe('Adds 1 guest');
  expect(reasonOutcomeWords('booked', 70)).toBe('Books the day');
  expect(reasonOutcomeWords('closed', null)).toBe('Closes the day');
  expect(reasonOutcomeWords('already_in_forecast', 70)).toBe('Already in this forecast');
  expect(reasonOutcomeWords('no_guest_count', null)).toBe('No guest count, so the forecast is unchanged');
  expect(reasonOutcomeWords('not_counted', 40)).toBe('Townwise only counts guests for private events so far');
  expect(reasonOutcomeWords('day_closed', 40)).toBe('The day is closed');
  expect(reasonOutcomeWords('past_day', 40)).toBe('This day has passed');
  // An outcome this client doesn't know says nothing rather than something wrong.
  expect(reasonOutcomeWords('something_new', 40)).toBeNull();
});
