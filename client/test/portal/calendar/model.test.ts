import type { TownEvent } from '../../../src/portal/analytics/api';
import {
  ALL_FILTERS, calendarMonth, captionOf, dayView, forecastWords, monthBounds, pastRange, reasonOutcomeWords, reasonShortLines, savedNotice, selectedDay,
  statusWord, tooltipLines, type CalendarCell, type CalendarInput, type ImportedEvent,
} from '../../../src/portal/calendar/model';
import type { ForecastDay, ForecastWindow } from '../../../src/portal/estimates/api';
import { daysBetween } from '../../../src/portal/locations/dates';
import { holiday, note, townEvent } from '../analytics/fakes';
import { ruleOf } from '../rules/fakes';

// The Calendar's pure model (P28, spec 16.3): each day's figure, marks, chips and words, the day
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
    {
      kind: 'event', label: 'Dartmouth home football', effectPct: 12, effect: { direction: 'more', pct: 10, basis: 'model', days: null },
      sources: [{ label: 'dartmouthsports.com', url: 'https://dartmouthsports.com/' }], note: null,
    },
    { kind: 'weekday', label: 'Saturday', effectPct: null, effect: { direction: 'more', pct: 35, basis: 'history', days: 52 }, sources: [], note: null },
    { kind: 'term', label: 'Fall term classes', effectPct: null, effect: null, sources: [], note: null },
  ],
});
const OPM = { label: 'U.S. Office of Personnel Management', url: 'https://www.opm.gov/' };
const effect = (direction: 'more' | 'fewer' | 'same', pct: number, days: number | null, basis: 'history' | 'model' = 'history') => ({ direction, pct, basis, days });
/** Thanksgiving, with one reason of each kind of effect, in the API's (run's) order. */
const THANKSGIVING = forecastDay({
  date: '2026-11-26',
  reasons: [
    { kind: 'level', label: 'Your recent level', effectPct: null, effect: null, sources: [], note: null },
    { kind: 'holiday', label: 'Thanksgiving Day', effectPct: null, effect: effect('fewer', 70, 1), sources: [OPM], note: null },
    { kind: 'weekday', label: 'Thursday', effectPct: null, effect: effect('same', 5, 52), sources: [], note: null },
    { kind: 'booking', label: 'Private event booked', effectPct: 4, effect: effect('same', 5, null, 'model'), sources: [], note: null },
    { kind: 'term', label: 'Fall term finals', effectPct: null, effect: effect('fewer', 10, 20), sources: [], note: null },
    { kind: 'event', label: 'Turkey trot', effectPct: null, effect: effect('more', 20, 4), sources: [], note: null },
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

test('a past day under a tenth of its weekday’s typical guests reads “Likely closed”, its count kept in the words (spec D32)', () => {
  // Saturdays Sep 19 to Oct 31 at 140 guests, then Nov 7 with 1.
  const saturdays = ['2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31']
    .map((date) => ({ date, guests: 140, netSalesCents: 280_000 }));
  const salesDays = [...saturdays, { date: '2026-11-07', guests: 1, netSalesCents: 2_500 }];
  const near = input({ salesDays, forecast: windowOf([]) });
  const cell = cellOf(calendarMonth(near), '2026-11-07');
  expect(cell).toMatchObject({ status: 'likely_closed', figure: null });
  expect(cell.label).toBe('Sat, Nov 7, 2026. Likely closed (1 guest recorded).');
  expect(statusWord(cell.status)).toBe('Likely closed');
  expect(captionOf(cell)).toBeNull();
  expect(forecastWords(dayView('2026-11-07', near).forecast, 'Sawtooth')).toEqual({ figure: null, lines: ['Likely closed (1 guest recorded).'] });
  expect(tooltipLines('2026-11-07', near)?.lines).toEqual(['Likely closed (1 guest recorded)']);
  // A note with fewer guests says the day was open, even with Your notes filtered off.
  const slow = note({ startDate: '2026-11-07', kind: 'other', effect: 'fewer_guests' });
  const open = input({ salesDays, forecast: windowOf([]), notes: [slow], filters: { ...ALL_FILTERS, notes: false } });
  expect(cellOf(calendarMonth(open), '2026-11-07')).toMatchObject({ status: null, figure: { value: 1, kind: 'actual' } });
  expect(forecastWords(dayView('2026-11-07', open).forecast, 'Sawtooth').figure).toEqual({ before: '', value: '1', after: 'guest' });
  // Fewer than 3 Saturdays before it with guests: a real 1-guest day.
  const thin = input({ salesDays: [...saturdays.slice(-2), { date: '2026-11-07', guests: 1, netSalesCents: 2_500 }], forecast: windowOf([]) });
  expect(cellOf(calendarMonth(thin), '2026-11-07')).toMatchObject({ status: null, figure: { value: 1, kind: 'actual' } });
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
  const all = dayView('2026-11-21', input({ forecast: NONE }));
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
  // Notes and rules first, with what they did; then the run's reasons by the size of their effect, each in words with a
  // mark the words repeat, and its sources; then the ones with none.
  expect(noted.reasons.map((reason) => [reason.label, reason.mark, reason.detail])).toEqual([
    ['Your private event, 70 guests, 6 pm to 9 pm', null, 'Adds 70 guests'],
    ['Saturday', '▲', 'Usually about 35% more guests than your average day'],
    ['Dartmouth home football', '▲', 'Townwise’s model: about 10% more guests'],
    ['Fall term classes', null, 'Not enough of your history to say yet'],
  ]);
  expect(noted.reasons[2]?.sources).toEqual([{ label: 'dartmouthsports.com', url: 'https://dartmouthsports.com/' }]);
});

test('Why says whether each reason usually brings more or fewer guests, biggest first; a past day says nothing of it', () => {
  const view = dayView('2026-11-26', input({ forecast: windowOf([THANKSGIVING]) }));
  expect(view.reasons.map((reason) => [reason.label, reason.mark, reason.detail])).toEqual([
    ['Thanksgiving Day', '▼', 'Last time, about 70% fewer guests than the same weekday in the weeks around it'],
    ['Turkey trot', '▲', 'Usually about 20% more guests than the same weekday without it'],
    ['Fall term finals', '▼', 'Usually about 10% fewer guests than the same weekday at other times of the year'],
    ['Thursday', '=', 'Usually about as many guests as your average day'],
    ['Private event booked', '=', 'Townwise’s model: about the same number of guests'],
    ['Your recent level', null, null],
  ]);
  expect(view.reasons[0]?.sources).toEqual([OPM]);
  // Keys stay unique and stable whatever the order.
  expect(new Set(view.reasons.map((reason) => reason.key)).size).toBe(6);
  // A day before today: its reasons carry no effect, and the panel says nothing of one.
  expect(dayView('2026-11-07', input()).reasons.map((reason) => [reason.label, reason.mark, reason.detail])).toEqual([['Saturday', null, null]]);
});

test('the tooltip and Home’s day detail give the top reasons with short effect words', () => {
  expect(reasonShortLines(THANKSGIVING, false)).toEqual([
    'Thanksgiving Day: fewer guests last time', 'Turkey trot: usually more guests', 'Fall term finals: usually fewer guests',
    'Thursday: usually about the same', 'Private event booked: about the same in Townwise’s model', 'Your recent level',
  ]);
  expect(reasonShortLines(NOTED, false)).toEqual([
    'Your private event, 70 guests, 6 pm to 9 pm', 'Saturday: usually more guests', 'Dartmouth home football: more guests in Townwise’s model', 'Fall term classes',
  ]);
  expect(reasonShortLines(NOTED, true)).toEqual(['Your private event, 70 guests, 6 pm to 9 pm', 'Dartmouth home football', 'Saturday', 'Fall term classes']);
});

test('On the calendar leaves out what Why already shows, never a note', () => {
  const view = dayView('2026-11-21', input());
  expect(view.events).toEqual([]);
  expect(view.shownInWhy).toBe(1);
  expect(view.notes.map((each) => each.id)).toEqual([PARTY.id]);
  // With no forecast for the day, the calendar lists its events itself.
  const bare = dayView('2026-11-21', input({ forecast: NONE }));
  expect(bare.events.map((event) => event.title)).toEqual(['Dartmouth home football']);
  expect(bare.shownInWhy).toBe(0);
  expect(dayView(TODAY, input()).events.map((event) => event.title)).toEqual(['Veterans Day', 'Fall term classes']);
});

test('ranges round low down and high up, as spec 14.4 and TownwiseAI’s get_forecast do; the middle figure to the nearest guest', () => {
  const day = forecastDay({ date: '2026-11-21', low: 180.6, mid: 212.4, high: 239.2, model: { status: 'open', low: 110.6, mid: 142.4, high: 169.2 }, noteGuests: 70 });
  const rounded = input({ forecast: windowOf([day, forecastDay({ date: '2026-11-07', model: { status: 'open', low: 120.7, mid: 135, high: 149.1 }, actual: 138, inRange: true })]) });
  expect(cellOf(calendarMonth(rounded), '2026-11-21').label).toContain('Forecast about 212 guests, 180 to 240.');
  expect(forecastWords(dayView('2026-11-21', rounded).forecast, 'Sawtooth').lines).toEqual([
    'Likely 180 to 240.',
    'Townwise’s model: 110 to 170. About 8 in 10 days land in that range. Your notes add 70 guests.',
  ]);
  expect(tooltipLines('2026-11-21', rounded)?.lines[0]).toBe('About 212 guests (180 to 240)');
  expect(forecastWords(dayView('2026-11-07', rounded).forecast, 'Sawtooth').lines).toEqual(['Townwise’s model forecast 120 to 150, and the day landed in that range.']);
});

test('a day the model closed that a private event opened shows only the notes’ guests and no 8 in 10 sentence', () => {
  const opened = forecastDay({
    date: '2026-11-23', low: 70, mid: 70, high: 70, model: { status: 'closed', low: null, mid: null, high: null }, noteGuests: 70,
    reasons: [
      { kind: 'note', label: 'Your private event, 70 guests', effectPct: null, sources: [], note: { id: 'n4', guests: 70, outcome: 'added' } },
      { kind: 'closure', label: 'Closed', effectPct: null, sources: [], note: null },
    ],
  });
  const view = dayView('2026-11-23', input({ forecast: windowOf([opened]) }));
  expect(forecastWords(view.forecast, 'Sawtooth')).toEqual({
    figure: { before: 'About', value: '70', after: 'guests' },
    lines: ['Townwise’s model expects you closed. Your notes open the day with 70 guests.'],
  });
});

test('the tooltip holds the range, the notes’ guests and at most three reasons', () => {
  expect(tooltipLines('2026-11-21', input())).toEqual({
    date: 'Sat, Nov 21, 2026',
    lines: [
      'About 282 guests (250 to 310)', 'Includes 70 guests from your notes', 'Your private event, 70 guests, 6 pm to 9 pm',
      'Saturday: usually more guests', 'Dartmouth home football: more guests in Townwise’s model',
    ],
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
  // The past part of a month and the 8 weeks before it (likely closed reads them, spec D32), for GET .../sales/days:
  // none for this month's first day or a later month.
  expect(pastRange('2026-11', TODAY)).toEqual({ from: '2026-09-06', to: '2026-11-10' });
  expect(pastRange('2026-10', TODAY)).toEqual({ from: '2026-08-06', to: '2026-10-31' });
  expect(pastRange('2026-12', TODAY)).toBeNull();
  expect(pastRange('2026-11', '2026-11-01')).toBeNull();
});

test('savedNotice says what the saved note did to the day, from the forecast read again', () => {
  const withNote = (outcome: string, guests: number | null = 70): CalendarInput => input({
    forecast: windowOf([forecastDay({
      date: '2026-11-21', reasons: [{ kind: 'note', label: 'Your private event', effectPct: null, sources: [], note: { id: 'n9', guests, outcome } }],
    })]),
  });
  expect(savedNotice('2026-11-21', withNote('added'), 'n9')).toBe('Saved. The forecast for Sat, Nov 21 now includes its 70 guests.');
  expect(savedNotice('2026-11-21', withNote('added', 1), 'n9')).toBe('Saved. The forecast for Sat, Nov 21 now includes its 1 guest.');
  expect(savedNotice('2026-11-21', withNote('booked'), 'n9')).toBe('Saved. The forecast for Sat, Nov 21 now shows the day booked.');
  expect(savedNotice('2026-11-21', withNote('closed', null), 'n9')).toBe('Saved. The forecast for Sat, Nov 21 now shows the day closed.');
  expect(savedNotice('2026-11-21', withNote('already_in_forecast'), 'n9')).toBe('Saved. The forecast for Sat, Nov 21 already includes this event.');
  expect(savedNotice('2026-11-21', withNote('no_guest_count', null), 'n9')).toBe('Saved. Add a guest count to change the forecast.');
  expect(savedNotice('2026-11-21', withNote('not_counted'), 'n9')).toBe('Saved. Townwise only counts guests for private events so far, so the forecast is unchanged.');
  expect(savedNotice('2026-11-21', withNote('day_closed'), 'n9')).toBe('Saved. The day is closed, so the forecast is unchanged.');
  expect(savedNotice('2026-11-21', withNote('day_booked'), 'n9')).toBe('Saved. The day is booked, so the forecast is unchanged.');
  expect(savedNotice('2026-11-21', withNote('past_day'), 'n9')).toBe('Saved. This day has passed, so its forecast stays as it was made.');
  // Not known: an outcome this client doesn't know, the note not on the day (moved, or past the six), no forecast.
  expect(savedNotice('2026-11-21', withNote('something_new'), 'n9')).toBe('Saved.');
  expect(savedNotice('2026-11-21', withNote('added'), 'other')).toBe('Saved.');
  expect(savedNotice('2026-11-22', withNote('added'), 'n9')).toBe('Saved.');
  expect(savedNotice('2026-11-21', input({ forecast: NONE }), 'n9')).toBe('Saved.');
  expect(savedNotice('2026-11-21', input({ forecast: null }), 'n9')).toBe('Saved.');
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
  expect(reasonOutcomeWords('day_booked', 40)).toBe('The day is booked');
  expect(reasonOutcomeWords('past_day', 40)).toBe('This day has passed');
  // An outcome this client doesn't know says nothing rather than something wrong.
  expect(reasonOutcomeWords('something_new', 40)).toBeNull();
});

// Business rules with a schedule (D31): the API applies them with the notes, so the panel shows their reasons, and lists
// the rules covering the day with their summary.
const CLOSED_MONDAYS = ruleOf('r1', 'Closed Mondays', {
  schedule: { kind: 'closure', startDate: '2026-11-01', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
  scheduleSummary: 'Closed on Mondays from Nov 1, 2026',
});
const FRIDAY_PARTIES = ruleOf('r2', 'Rehearsal dinners on Fridays', {
  schedule: {
    kind: 'private_event', startDate: '2026-11-01', endDate: '2026-12-31', weekdays: [5], effect: 'more_guests', expectedGuests: 40, startTime: null, endTime: null,
  },
  scheduleSummary: 'Adds 40 guests on Fridays from Nov 1, 2026 to Dec 31, 2026',
});
const RULES = [CLOSED_MONDAYS, FRIDAY_PARTIES, ruleOf('r3', 'Patio opens in May')];
const ruleReason = (label: string, id: string, guests: number | null, outcome: string) => ({
  kind: 'rule', label, effectPct: null, sources: [], note: null, rule: { id, guests, outcome },
});

test('the day panel lists the scheduled rules covering the day, whatever the filters, and a rule’s reason with what it did', () => {
  const closedMonday = forecastDay({
    date: '2026-11-16', status: 'closed', low: null, mid: null, high: null,
    reasons: [ruleReason('Your rule: closed on Mondays', 'r1', null, 'closed'), { kind: 'weekday', label: 'Monday', effectPct: null, sources: [], note: null }],
  });
  const withRules = input({ forecast: windowOf([closedMonday]), rules: RULES });
  const monday = dayView('2026-11-16', withRules);
  expect(monday.rules.map((rule) => rule.id)).toEqual(['r1']);
  expect(dayView('2026-11-20', withRules).rules.map((rule) => rule.id)).toEqual(['r2']);
  expect(dayView('2026-11-17', withRules).rules).toEqual([]);
  expect(dayView('2027-01-01', { ...withRules, month: '2027-01' }).rules).toEqual([]);
  expect(dayView('2026-11-16', { ...withRules, filters: { ...ALL_FILTERS, notes: false } }).rules.map((rule) => rule.id)).toEqual(['r1']);
  // Home passes no rules.
  expect(dayView('2026-11-16', input()).rules).toEqual([]);
  expect(monday.reasons.map((reason) => [reason.label, reason.detail])).toEqual([
    ['Your rule: closed on Mondays', 'Closes the day'], ['Monday', 'Not enough of your history to say yet'],
  ]);
  expect(forecastWords(monday.forecast, 'Sawtooth').lines).toEqual(['Closed.', 'From your business rule.']);
  expect(tooltipLines('2026-11-16', withRules)?.lines).toEqual(['Closed', 'Your rule: closed on Mondays', 'Monday']);
});

test('guests a rule adds are named as the rule’s, and with a note’s as both', () => {
  const ruled = forecastDay({
    date: '2026-11-20', low: 220, mid: 252, high: 280, model: { status: 'open', low: 180, mid: 212, high: 240 }, noteGuests: 40,
    reasons: [ruleReason('Your rule: adds 40 guests on Fridays', 'r2', 40, 'added'), { kind: 'weekday', label: 'Friday', effectPct: null, sources: [], note: null }],
  });
  const both = forecastDay({
    date: '2026-11-27', low: 290, mid: 322, high: 350, model: { status: 'open', low: 180, mid: 212, high: 240 }, noteGuests: 110,
    reasons: [
      ruleReason('Your rule: adds 40 guests on Fridays', 'r2', 40, 'added'),
      { kind: 'note', label: 'Your private event, 70 guests', effectPct: null, sources: [], note: { id: 'n5', guests: 70, outcome: 'added' } },
    ],
  });
  const opened = forecastDay({
    date: '2026-11-23', low: 40, mid: 40, high: 40, model: { status: 'closed', low: null, mid: null, high: null }, noteGuests: 40,
    reasons: [ruleReason('Your rule: adds 40 guests on Mondays', 'r4', 40, 'added')],
  });
  const ruledInput = input({ forecast: windowOf([ruled, both, opened]), rules: RULES, notes: [] });
  expect(cellOf(calendarMonth(ruledInput), '2026-11-20').label).toContain('Includes 40 guests from your rules.');
  expect(cellOf(calendarMonth(ruledInput), '2026-11-27').label).toContain('Includes 110 guests from your notes and rules.');
  expect(tooltipLines('2026-11-20', ruledInput)?.lines[1]).toBe('Includes 40 guests from your rules');
  expect(forecastWords(dayView('2026-11-20', ruledInput).forecast, 'Sawtooth').lines).toEqual([
    'Likely 220 to 280.', 'Townwise’s model: 180 to 240. About 8 in 10 days land in that range. Your rules add 40 guests.',
  ]);
  expect(forecastWords(dayView('2026-11-27', ruledInput).forecast, 'Sawtooth').lines[1]).toContain('Your notes and rules add 110 guests.');
  expect(forecastWords(dayView('2026-11-23', ruledInput).forecast, 'Sawtooth').lines).toEqual([
    'Townwise’s model expects you closed. Your rules open the day with 40 guests.',
  ]);
  expect(dayView('2026-11-20', ruledInput).reasons[0]).toMatchObject({ label: 'Your rule: adds 40 guests on Fridays', detail: 'Adds 40 guests' });
});

test('a rule with fewer guests says a near-empty past day was open, as a note does (spec D32)', () => {
  const saturdays = ['2026-09-19', '2026-09-26', '2026-10-03', '2026-10-10', '2026-10-17', '2026-10-24', '2026-10-31']
    .map((date) => ({ date, guests: 140, netSalesCents: 280_000 }));
  const salesDays = [...saturdays, { date: '2026-11-07', guests: 1, netSalesCents: 2_500 }];
  const slowSaturdays = ruleOf('r5', 'Slow Saturdays this fall', {
    schedule: { kind: 'other', startDate: '2026-11-01', endDate: null, weekdays: [6], effect: 'fewer_guests', expectedGuests: null, startTime: null, endTime: null },
    scheduleSummary: 'Other, fewer guests than usual on Saturdays from Nov 1, 2026',
  });
  expect(cellOf(calendarMonth(input({ salesDays, forecast: windowOf([]), rules: [slowSaturdays] })), '2026-11-07'))
    .toMatchObject({ status: null, figure: { value: 1, kind: 'actual' } });
  expect(cellOf(calendarMonth(input({ salesDays, forecast: windowOf([]), rules: [] })), '2026-11-07')).toMatchObject({ status: 'likely_closed' });
});

test('today’s stored day is never likely closed: its upload may be partial, so only a day before the town’s today can be (D32)', () => {
  // Wednesdays Sep 16 to Nov 4 at 140 guests, then today (Wed, Nov 11) with 1 so far.
  const wednesdays = ['2026-09-16', '2026-09-23', '2026-09-30', '2026-10-07', '2026-10-14', '2026-10-21', '2026-10-28', '2026-11-04']
    .map((date) => ({ date, guests: 140, netSalesCents: 280_000 }));
  const partial = input({ salesDays: [...wednesdays, { date: TODAY, guests: 1, netSalesCents: 2_500 }], forecast: windowOf([]) });
  expect(cellOf(calendarMonth(partial), TODAY).status).not.toBe('likely_closed');
  expect(tooltipLines(TODAY, partial)?.lines ?? []).not.toContain('Likely closed (1 guest recorded)');
});

test('a rule a note sets aside says so, and rule reasons past the first six are counted for the panel (D31)', () => {
  expect(reasonOutcomeWords('overridden', null)).toBe('A note on this day sets this rule aside');
  const ruled = forecastDay({ date: '2026-11-21', moreRules: 2 });
  expect(dayView('2026-11-21', input({ forecast: windowOf([ruled]) })).moreRules).toBe(2);
  // An older answer without the count reads as none.
  expect(dayView('2026-11-21', input({ forecast: windowOf([forecastDay({ date: '2026-11-21' })]) })).moreRules).toBe(0);
});
