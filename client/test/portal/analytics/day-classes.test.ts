import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TownEvent } from '../../../src/portal/analytics/api';
import { classOf, dayContext, type DayClass } from '../../../src/portal/analytics/days';
import type { Note } from '../../../src/portal/locations/api';
import { day, note, townEvent } from './fakes';

// The day classes shared with the API (spec 13.2): api/src/people-in-town/history.ts ports classOf for "your history
// by term state", and both sides run the same cases from day-classes.json. The API's test checks that this copy and
// api/test/fixtures/day-classes.json are identical, so a change to either side's rules needs both and the fixture.

interface ClassCase {
  name: string;
  date: string;
  day: { guests: number | null; netSalesCents: number | null } | null;
  notes: Pick<Note, 'startDate' | 'endDate' | 'weekdays' | 'effect'>[];
  events: Pick<TownEvent, 'start' | 'end' | 'kind'>[];
  class: DayClass;
}

const { cases } = JSON.parse(readFileSync(join(__dirname, 'day-classes.json'), 'utf8')) as { cases: ClassCase[] };

test('the fixture covers every class', () => {
  expect(new Set(cases.map((each) => each.class))).toEqual(new Set(['closed', 'noted', 'holiday', 'event', 'regular']));
});

test.each(cases)('$name: $class', (each) => {
  const notes = each.notes.map((fields) => note(fields));
  const events = each.events.map((fields, index) => townEvent({ ...fields, title: `Case event ${String(index)}` }));
  const record = each.day === null ? undefined : day(each.date, each.day.guests, each.day.netSalesCents);
  expect(classOf(each.date, record, dayContext(notes, events))).toBe(each.class);
});
