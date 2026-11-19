import {
  CELL_LINES, cellLines, dayTooltip, defaultDay, emptyDayLine, eventMonthRows, eventsOnDay, type EventDay, type MonthEvent,
} from '../../../src/portal/data/item/eventMonth';

// A calendar's events as a month grid on its page in Your data (D62): weeks Monday first, each day's events in order
// with a start time on the first day, a booking label's tag on a file calendar, and labels that say everything in
// full. Made-up titles only.

function event(over: Partial<MonthEvent> & Pick<MonthEvent, 'uid' | 'title' | 'startDate'>): MonthEvent {
  return { calendarId: 'c1', endDate: over.startDate, startTime: null, endTime: null, booking: null, bookingBy: null, ...over };
}

const DINNER = event({ uid: 'd1', title: 'Rehearsal dinner', startDate: '2026-11-21', startTime: '18:00', endTime: '21:00', booking: 'party', bookingBy: 'ai' });
const BRUNCH = event({ uid: 'b1', title: 'Brunch club', startDate: '2026-11-21', startTime: '10:30', endTime: '12:00' });
const FAIR = event({ uid: 'f1', title: 'Craft fair', startDate: '2026-11-20', endDate: '2026-11-22' });
const HOUSE = event({ uid: 'h1', title: 'Full house dinner', startDate: '2026-11-28', booking: 'buyout', bookingBy: 'person' });

function day(rows: (EventDay | null)[][], date: string): EventDay {
  const found = rows.flat().find((each) => each?.date === date);
  if (found === undefined || found === null) throw new Error(`no ${date}`);
  return found;
}

test('November 2026 is six Monday-first weeks, with the days of other months left empty', () => {
  const rows = eventMonthRows('2026-11', '2026-11-17', [], false);
  expect(rows).toHaveLength(6);
  // Nov 1, 2026 is a Sunday: the first row's Monday to Saturday are October's.
  expect(rows[0]?.map((each) => each?.date ?? null)).toEqual([null, null, null, null, null, null, '2026-11-01']);
  expect(rows[5]?.map((each) => each?.date ?? null)).toEqual(['2026-11-30', null, null, null, null, null, null]);
  expect(day(rows, '2026-11-17')).toMatchObject({ isToday: true, entries: [], label: 'Tue, Nov 17, 2026. Today. No events.' });
  expect(day(rows, '2026-11-18').isToday).toBe(false);
});

test('a day lists all-day and continuing events first, then by time; a span is on each of its days, timed only on its first', () => {
  const rows = eventMonthRows('2026-11', '2026-11-17', [DINNER, FAIR, BRUNCH, HOUSE], false);
  expect(day(rows, '2026-11-20').entries.map((entry) => [entry.time, entry.title])).toEqual([[null, 'Craft fair']]);
  expect(day(rows, '2026-11-21').entries.map((entry) => [entry.time, entry.title, entry.tag])).toEqual([
    [null, 'Craft fair', null], ['10:30 am', 'Brunch club', null], ['6 pm', 'Rehearsal dinner', null],
  ]);
  expect(day(rows, '2026-11-22').entries.map((entry) => entry.title)).toEqual(['Craft fair']);
  expect(day(rows, '2026-11-23').entries).toEqual([]);
  // Off a file calendar's page, no label shows even when the event has one.
  expect(day(rows, '2026-11-21').label).toBe(
    'Sat, Nov 21, 2026. 3 events: Craft fair, Nov 20 to 22; Brunch club, 10:30 am to noon; Rehearsal dinner, 6 pm to 9 pm.',
  );
});

test('on a file calendar a labeled event shows its tag, and its label says the label and who suggested it (D58)', () => {
  const rows = eventMonthRows('2026-11', '2026-11-17', [DINNER, HOUSE, BRUNCH], true);
  expect(day(rows, '2026-11-21').entries.map((entry) => entry.tag)).toEqual([null, 'Party']);
  expect(day(rows, '2026-11-28').entries[0]).toMatchObject({ tag: 'Buyout', words: 'Full house dinner, Buyout' });
  expect(day(rows, '2026-11-21').label).toBe(
    'Sat, Nov 21, 2026. 2 events: Brunch club, 10:30 am to noon; Rehearsal dinner, 6 pm to 9 pm, Party, suggested by TownwiseAI.',
  );
});

test(`a cell holds ${String(CELL_LINES)} lines, or ${String(CELL_LINES - 1)} and how many more`, () => {
  const many = Array.from({ length: 6 }, (_, at) => event({ uid: `e${String(at)}`, title: `Event ${String(at)}`, startDate: '2026-11-05' }));
  const entries = day(eventMonthRows('2026-11', '2026-11-17', many, false), '2026-11-05').entries;
  expect(cellLines(entries.slice(0, CELL_LINES))).toEqual({ lines: entries.slice(0, CELL_LINES), more: null });
  expect(cellLines(entries)).toEqual({ lines: entries.slice(0, CELL_LINES - 1), more: '+3 more' });
  // The day's label still says all six.
  expect(day(eventMonthRows('2026-11', '2026-11-17', many, false), '2026-11-05').label).toMatch(/^Thu, Nov 5, 2026\. 6 events: Event 0; .*; Event 5\.$/);
});

test('the month opens on today in today’s month, else its first day with an event, else its 1st', () => {
  const rows = eventMonthRows('2026-12', '2026-11-17', [event({ uid: 'x', title: 'Toy drive', startDate: '2026-12-09' })], false);
  expect(defaultDay('2026-12', '2026-11-17', rows)).toBe('2026-12-09');
  expect(defaultDay('2026-11', '2026-11-17', eventMonthRows('2026-11', '2026-11-17', [HOUSE], false))).toBe('2026-11-17');
  expect(defaultDay('2027-01', '2026-11-17', eventMonthRows('2027-01', '2026-11-17', [], false))).toBe('2027-01-01');
});

test('a day’s tooltip says each event in full; a day with none has no tooltip; an empty day says so', () => {
  const rows = eventMonthRows('2026-11', '2026-11-17', [DINNER, BRUNCH], true);
  expect(dayTooltip(day(rows, '2026-11-21'))).toEqual({
    date: 'Sat, Nov 21, 2026', lines: ['Brunch club, 10:30 am to noon', 'Rehearsal dinner, 6 pm to 9 pm, Party, suggested by TownwiseAI'],
  });
  expect(dayTooltip(day(rows, '2026-11-22'))).toBeNull();
  expect(emptyDayLine('2026-11-22')).toBe('No events on Sun, Nov 22, 2026.');
});

test('the day’s list keeps the grid’s order', () => {
  expect(eventsOnDay('2026-11-21', [DINNER, BRUNCH, FAIR]).map((each) => each.uid)).toEqual(['f1', 'b1', 'd1']);
});
