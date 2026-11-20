import { researchedEventSchema as foundEventSchema } from '../../../src/portal/analytics/api';
import { compactEntries, dayEntries, fitLines, folded, foundCovers, foundInFront, notNamed, type DaySources } from '../../../src/portal/calendar/entries';
import { ALL_FILTERS, type ImportedEvent } from '../../../src/portal/calendar/model';
import { holiday, note, townEvent } from '../analytics/fakes';
import { ruleOf } from '../rules/fakes';
import { foundEvent } from './fakes';

// The one list of what is on a day (D49, calendar-shows-everything design decision 1): its order, its words, and the
// compact dedupe the cells, the tooltip, the week cards and Home's This week share. Every name and title is made up.

const DAY = '2026-11-11';

function imported(fields: Partial<ImportedEvent> & Pick<ImportedEvent, 'title'>): ImportedEvent {
  return {
    calendarId: 'c1', calendar: 'US holidays', uid: fields.title, startDate: DAY, endDate: DAY, startTime: null, endTime: null, ...fields,
  };
}

function sources(fields: Partial<DaySources>): DaySources {
  return { notes: [], rules: [], events: [], imported: [], filters: ALL_FILTERS, ...fields };
}

const VETERANS = holiday(DAY, 'Veterans Day', 'veterans-day', 'Veterans Day');
const CLOSED_RULE = ruleOf('r1', 'Closed on Wednesdays', {
  schedule: { kind: 'closure', startDate: '2026-01-07', endDate: null, weekdays: [3], effect: 'closed', expectedGuests: null, startTime: null, endTime: null },
});

test('the order is notes, rules, holidays, town events, imported events, then periods only when asked', () => {
  const entries = dayEntries(DAY, sources({
    notes: [note({ startDate: DAY, title: 'Holiday party', expectedGuests: 70 })],
    rules: [CLOSED_RULE],
    events: [
      townEvent({ start: DAY, title: 'Fall term classes', kind: 'term', end: '2026-11-20' }),
      townEvent({ start: DAY, title: 'Hockey night' }),
      VETERANS,
    ],
    imported: [imported({ title: 'Wine delivery', startTime: '09:00', endTime: '10:00' }), imported({ title: 'Staff day' })],
  }));
  expect(entries.map((entry) => entry.words)).toEqual(['Holiday party', 'Closed on Wednesdays', 'Veterans Day', 'Hockey night', 'Staff day', 'Wine delivery']);
  const withPeriods = dayEntries(DAY, sources({ events: [townEvent({ start: DAY, title: 'Fall term classes', kind: 'term' }), VETERANS] }), { periods: true });
  expect(withPeriods.map((entry) => entry.words)).toEqual(['Veterans Day', 'Fall term classes']);
});

test('a note reads its title, else its kind words; a rule its text; notes go in start order', () => {
  const entries = dayEntries(DAY, sources({
    notes: [
      note({ startDate: DAY, startTime: '18:00', endTime: '21:00', expectedGuests: 70 }),
      note({ startDate: '2026-11-10', endDate: DAY, kind: 'private_event', effect: 'closed', title: 'Rehearsal dinner' }),
    ],
    rules: [CLOSED_RULE],
  }));
  expect(entries.map((entry) => [entry.kind, entry.words, entry.title])).toEqual([
    ['note', 'Rehearsal dinner', 'Rehearsal dinner'],
    ['note', 'Private event, 70', null],
    ['rule', 'Closed on Wednesdays', 'Closed on Wednesdays'],
  ]);
});

test('the filters hide what they name, and never a rule', () => {
  const entries = dayEntries(DAY, sources({
    notes: [note({ startDate: DAY })], rules: [CLOSED_RULE], events: [VETERANS], imported: [imported({ title: 'Staff day' })],
    filters: { ...ALL_FILTERS, notes: false, holidays: false, imported: false },
  }));
  expect(entries.map((entry) => entry.kind)).toEqual(['rule']);
});

test('each entry names its source: a town event its sites, an imported event its calendar, a TownwiseAI note its file', () => {
  const entries = dayEntries(DAY, sources({
    notes: [note({ startDate: DAY, source: { via: 'ai_file', fileId: 'f1', ref: 'f_0123456789abcdef01234567' } }), note({ startDate: DAY, source: { via: 'ai_file', fileId: 'f2', ref: null } })],
    events: [VETERANS],
    imported: [imported({ title: 'Staff day', calendarId: 'c7', calendar: 'Bookings' })],
  }));
  expect(entries.map((entry) => entry.source)).toEqual([
    { kind: 'file', ref: 'f_0123456789abcdef01234567' },
    null,
    { kind: 'town', sources: VETERANS.sources },
    { kind: 'calendar', calendarId: 'c7', calendar: 'Bookings' },
  ]);
  expect(entries.map((entry) => entry.group)).toEqual(['notes', 'notes', 'town', 'calendar:c7']);
});

test('compactEntries merges a title only across sources, never two of one source and never kind words', () => {
  const day = dayEntries(DAY, sources({
    notes: [
      note({ startDate: DAY, title: 'Holiday party' }), note({ startDate: DAY, title: 'Holiday party' }),
      note({ startDate: DAY, expectedGuests: 70 }), note({ startDate: DAY, expectedGuests: 70 }),
    ],
    events: [VETERANS],
    imported: [
      imported({ title: 'Veterans day ', calendarId: 'c1' }),
      imported({ title: 'veterans  DAY', calendarId: 'c2', calendar: 'Work' }),
      imported({ title: 'Private party', calendarId: 'c3', uid: 'p1', startTime: '12:00', endTime: '14:00' }),
      imported({ title: 'Private party', calendarId: 'c3', uid: 'p2', startTime: '18:00', endTime: '21:00' }),
      imported({ title: 'Holiday party', calendarId: 'c3', uid: 'p3' }),
    ],
  }));
  expect(compactEntries(day).map((entry) => entry.words)).toEqual([
    'Holiday party', 'Holiday party', 'Private event, 70', 'Private event, 70', 'Veterans Day', 'Private party', 'Private party',
  ]);
  // The full list keeps every entry, for the day panel.
  expect(day).toHaveLength(10);
});

test('folded is lower case with each run of white space one space, trimmed', () => {
  expect(folded('  Veterans\t\n DAY ')).toBe('veterans day');
});

test('notNamed leaves out the entries a shown reason already names', () => {
  const shown = note({ startDate: DAY, title: 'Holiday party' });
  const day = dayEntries(DAY, sources({
    notes: [shown, note({ startDate: DAY, title: 'Holiday party' })], events: [VETERANS], imported: [imported({ title: 'Staff day' })],
  }));
  // A note goes only by its own shown reason (its id); the second note with the same title stays.
  expect(notNamed(day, ['VETERANS day', 'holiday party'], new Set([shown.id])).map((entry) => entry.words)).toEqual(['Holiday party', 'Staff day']);
});

test('fitLines shows every line up to the limit, else one fewer and “+N more”', () => {
  expect(fitLines(['a', 'b', 'c'], 3)).toEqual({ lines: ['a', 'b', 'c'], more: null });
  expect(fitLines(['a', 'b', 'c', 'd'], 3)).toEqual({ lines: ['a', 'b'], more: '+2 more' });
  expect(fitLines(['a', 'b', 'c'], 2)).toEqual({ lines: ['a'], more: '+2 more' });
  expect(fitLines([], 2)).toEqual({ lines: [], more: null });
});

describe('found by research (D66)', () => {
  const FOUND = foundEventSchema.parse(foundEvent({ start: DAY, end: DAY }));
  const WEEKLY = foundEventSchema.parse(foundEvent({
    id: `t-${'b'.repeat(24)}`, title: 'Thursday market', start: '2026-11-09', end: '2026-11-22', weekdays: [3, 4], origin: 'town', competitor: null,
  }));

  test('found events come after imported events and before the periods, keyed by id with their sources', () => {
    const entries = dayEntries(DAY, sources({
      notes: [note({ startDate: DAY, title: 'Holiday party' })],
      events: [townEvent({ start: DAY, title: 'Fall term classes', kind: 'term' }), VETERANS],
      imported: [imported({ title: 'Staff day' })],
      found: [FOUND],
    }), { periods: true });
    expect(entries.map((entry) => entry.words)).toEqual(['Holiday party', 'Veterans Day', 'Staff day', 'Trivia night', 'Fall term classes']);
    expect(entries[3]).toMatchObject({
      key: `found:l-${'a'.repeat(24)}`, kind: 'researched', group: 'research', title: 'Trivia night',
      source: { kind: 'research', sources: [{ label: 'example.com', url: 'https://example.com/trivia' }] },
    });
  });

  test('the filter hides them, and an event with weekdays shows only on those days', () => {
    expect(dayEntries(DAY, sources({ found: [FOUND], filters: { ...ALL_FILTERS, researched: false } }))).toEqual([]);
    // Nov 11, 2026 is a Wednesday (3), Nov 13 a Friday (5).
    expect(dayEntries(DAY, sources({ found: [WEEKLY] })).map((entry) => entry.words)).toEqual(['Thursday market']);
    expect(dayEntries('2026-11-13', sources({ found: [WEEKLY] }))).toEqual([]);
    expect(foundCovers(WEEKLY, '2026-11-12')).toBe(true);
    expect(foundCovers(WEEKLY, '2026-11-23')).toBe(false);
  });

  test('a multi-week or Unconfirmed one comes after the day’s own found events (UI review)', () => {
    const season = foundEventSchema.parse(foundEvent({
      id: `t-${'c'.repeat(24)}`, title: 'Winter parking ban', kind: 'season', start: '2026-11-01', end: '2027-04-30', confidence: 'medium', startTime: null,
    }));
    const unconfirmed = foundEventSchema.parse(foundEvent({ id: `t-${'d'.repeat(24)}`, title: 'Maybe a fair', start: DAY, end: DAY, confidence: 'low' }));
    const week = foundEventSchema.parse(foundEvent({ id: `t-${'e'.repeat(24)}`, title: 'Book week', start: '2026-11-09', end: '2026-11-15' }));
    const entries = dayEntries(DAY, sources({ found: [season, unconfirmed, WEEKLY, week, FOUND] }));
    // In the read's order within each half: the weekly market, the 7-day week and the day's own event lead.
    expect(entries.map((entry) => entry.words)).toEqual(['Thursday market', 'Book week', 'Trivia night', 'Winter parking ban', 'Maybe a fair']);
    expect([season, unconfirmed, WEEKLY, week, FOUND].map(foundInFront)).toEqual([false, false, true, true, true]);
  });

  test('none without found, or with found null (the read failed)', () => {
    expect(dayEntries(DAY, sources({}))).toEqual([]);
    expect(dayEntries(DAY, sources({ found: null }))).toEqual([]);
  });

  test('a cancelled one says so on compact surfaces, and a found title a town event already shows is shown once', () => {
    const cancelled = { ...FOUND, status: 'cancelled' as const };
    expect(dayEntries(DAY, sources({ found: [cancelled] })).map((entry) => entry.words)).toEqual(['Trivia night (cancelled)']);
    const twice = dayEntries(DAY, sources({ events: [townEvent({ start: DAY, title: 'Trivia Night' })], found: [FOUND] }));
    expect(twice).toHaveLength(2);
    expect(compactEntries(twice).map((entry) => entry.group)).toEqual(['town']);
  });
});
