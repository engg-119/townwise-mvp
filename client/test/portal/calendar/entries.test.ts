import { compactEntries, dayEntries, fitLines, folded, notNamed, noteChip, noteWords, type DaySources } from '../../../src/portal/calendar/entries';
import { ALL_FILTERS, type ImportedEvent } from '../../../src/portal/calendar/model';
import { holiday, note, townEvent } from '../analytics/fakes';
import { ruleOf } from '../rules/fakes';

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

test('a note marking a day’s guest count wrong (D67) reads “Guest count marked wrong”, or its event name', () => {
  const mark = note({ kind: 'other', startDate: DAY, effect: 'wrong_guest_count', detail: null });
  expect(noteChip(mark)).toBe('Guest count marked wrong');
  expect(noteWords({ ...mark, title: null })).toBe('Guest count marked wrong');
  expect(noteWords({ ...mark, title: 'Door counter broken' })).toBe('Door counter broken');
  expect(compactEntries(dayEntries(DAY, sources({ notes: [mark] }))).map((entry) => entry.words)).toEqual(['Guest count marked wrong']);
});
