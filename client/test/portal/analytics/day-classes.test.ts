import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TownEvent } from '../../../src/portal/analytics/api';
import { classOf, dayContext, dayFlags, ruleSchedules, typicalGuests, type DayClass } from '../../../src/portal/analytics/days';
import type { Note } from '../../../src/portal/locations/api';
import { day, note, townEvent } from './fakes';

// The day classes shared with the API (spec 13.2): api/src/people-in-town/history.ts ports classOf for "your history
// by term state", and both sides run the same cases from day-classes.json. The API's test checks that this copy and
// api/test/fixtures/day-classes.json are identical, so a change to either side's rules needs both and the fixture.
// Likely closed (spec D32) reads the day's typical guests, which each side computes from the case's `history`.

interface ClassCase {
  name: string;
  date: string;
  history?: { date: string; guests: number | null }[];
  day: { guests: number | null; netSalesCents: number | null } | null;
  notes: Pick<Note, 'startDate' | 'endDate' | 'weekdays' | 'effect'>[];
  events: Pick<TownEvent, 'start' | 'end' | 'kind'>[];
  class: DayClass;
  likelyClosed?: true;
}

const { cases } = JSON.parse(readFileSync(join(__dirname, 'day-classes.json'), 'utf8')) as { cases: ClassCase[] };

test('the fixture covers every class, and likely closed', () => {
  expect(new Set(cases.map((each) => each.class))).toEqual(new Set(['closed', 'noted', 'holiday', 'event', 'regular']));
  expect(cases.filter((each) => each.likelyClosed === true).length).toBeGreaterThan(3);
});

test.each(cases)('$name: $class', (each) => {
  const notes = each.notes.map((fields) => note(fields));
  const events = each.events.map((fields, index) => townEvent({ ...fields, title: `Case event ${String(index)}` }));
  const guests = new Map((each.history ?? []).map((other) => [other.date, other.guests]));
  const record = each.day === null
    ? undefined
    : { ...day(each.date, each.day.guests, each.day.netSalesCents), typicalGuests: typicalGuests(each.date, (date) => guests.get(date)) };
  const context = dayContext(notes, events);
  expect(classOf(each.date, record, context)).toBe(each.class);
  expect(dayFlags(each.date, record, context).likelyClosed).toBe(each.likelyClosed === true);
});

// A business rule's schedule (spec D31) says a near-empty day was open exactly as a note does, for the likely-closed
// check only (spec D32); the API's tests pin the same in people-history.test.ts.
describe('rule schedules', () => {
  const history = [{ date: '2026-09-19', guests: 200 }, { date: '2026-09-26', guests: 200 }, { date: '2026-10-03', guests: 200 }];
  const guests = new Map(history.map((other) => [other.date, other.guests]));
  const near = { ...day('2026-10-10', 2), typicalGuests: typicalGuests('2026-10-10', (date) => guests.get(date)) };
  const rule = (effect: Note['effect'], endDate: string | null = null, weekdays: number[] | null = null) =>
    ({ startDate: '2026-10-01', endDate, weekdays, effect });
  const flags = (...rules: ReturnType<typeof rule>[]) => dayFlags('2026-10-10', near, dayContext([], [], rules));

  test('more or fewer guests keep a near-empty day open, and the day stays regular, not noted', () => {
    for (const effect of ['more_guests', 'fewer_guests'] as const) {
      expect(flags(rule(effect))).toMatchObject({ closed: false, likelyClosed: false, noted: false });
      expect(classOf('2026-10-10', near, dayContext([], [], [rule(effect)]))).toBe('regular');
    }
  });

  test('no rules, other effects, and rules not covering the day change nothing', () => {
    expect(flags()).toMatchObject({ closed: true, likelyClosed: true });
    expect(flags(rule('unknown'))).toMatchObject({ likelyClosed: true });
    expect(flags(rule('more_guests', '2026-10-09'))).toMatchObject({ likelyClosed: true });
    expect(flags(rule('more_guests', null, [1]))).toMatchObject({ likelyClosed: true });
    expect(classOf('2026-10-10', near, dayContext([], []))).toBe('closed');
  });

  test('a closed rule closes the day, as a closed note does', () => {
    expect(flags(rule('closed'))).toMatchObject({ closed: true, likelyClosed: false });
  });

  test('ruleSchedules keeps only the rules that have a schedule', () => {
    const schedule = rule('more_guests');
    expect(ruleSchedules([{ schedule }, { schedule: null }, {}])).toEqual([schedule]);
  });
});
