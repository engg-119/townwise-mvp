// "Your history by term state" (spec 13.2): the day classes match the client's (the shared day-classes.json
// fixture, kept identical to the client's copy), only open regular days with a known term state count, and a cell
// needs 3 days for a mean. Synthetic days only.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { typicalGuests } from '../src/closed-days.ts';
import { classOfDay, closureOfDay, MIN_CELL_DAYS, yourHistory, type DayClass } from '../src/people-in-town/history.ts';
import type { TermState } from '../src/people-in-town/term.ts';
import type { NoteContent } from '../src/stores/notes.ts';
import type { SalesDay } from '../src/stores/sales-days.ts';
import type { TownEvent } from '../src/town-calendar.ts';

interface ClassCase {
  name: string;
  date: string;
  /** Other stored days' guests, which the day's typical guests come from (spec D32); none when absent. */
  history?: { date: string; guests: number | null }[];
  day: { guests: number | null; netSalesCents: number | null } | null;
  notes: Pick<NoteContent, 'startDate' | 'endDate' | 'weekdays' | 'effect'>[];
  events: Pick<TownEvent, 'start' | 'end' | 'kind'>[];
  class: DayClass;
  likelyClosed?: true;
}

const FIXTURE = new URL('fixtures/day-classes.json', import.meta.url);
const CLIENT_COPY = new URL('../../client/test/portal/analytics/day-classes.json', import.meta.url);

describe('the day classes', () => {
  const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: ClassCase[] };

  it('are the client’s: the fixture and its client copy are identical', () => {
    expect(readFileSync(CLIENT_COPY, 'utf8')).toBe(readFileSync(FIXTURE, 'utf8'));
    expect(cases.length).toBeGreaterThan(10);
    expect(new Set(cases.map((each) => each.class))).toEqual(new Set(['closed', 'noted', 'holiday', 'event', 'regular']));
  });

  it('include likely-closed cases (spec D32)', () => {
    expect(cases.filter((each) => each.likelyClosed === true).length).toBeGreaterThan(3);
  });

  for (const each of cases) {
    it(`${each.name}: ${each.class}${each.likelyClosed === true ? ', likely closed' : ''}`, () => {
      const guests = new Map((each.history ?? []).map((other) => [other.date, other.guests]));
      const typical = typicalGuests(each.date, (date) => guests.get(date));
      expect(classOfDay(each.date, each.day ?? undefined, each.notes, each.events, typical)).toBe(each.class);
      expect(closureOfDay(each.date, each.day ?? undefined, each.notes, typical) === 'likely_closed').toBe(each.likelyClosed === true);
    });
  }
});

function day(date: string, guests: number | null, netSalesCents: number | null = guests === null ? null : guests * 2000): SalesDay {
  return { date, guests, netSalesCents };
}

/** Saturdays from 2026-10-03 in session; Saturdays from 2026-12-05 between terms; anything else unknown. */
function stateOf(date: string): TermState {
  if (date >= '2026-09-14' && date <= '2026-11-17') return 'in_session';
  if (date >= '2026-11-26' && date <= '2027-01-03') return 'between_terms';
  return 'unknown';
}

describe('yourHistory', () => {
  it('averages open regular days by term state and weekday, with day counts, and needs 3 days for a mean', () => {
    const days = [
      day('2026-10-03', 200), day('2026-10-10', 220), day('2026-10-17', 240), // Saturdays in session
      day('2026-12-05', 100), day('2026-12-12', 120), // two Saturdays between terms
      day('2026-10-05', 80), // a Monday in session
    ];
    const history = yourHistory(days, [], [], stateOf);
    expect(history).toEqual({
      metric: 'guests',
      cells: [
        { state: 'in_session', weekday: 'Mon', days: 1, mean: null },
        { state: 'in_session', weekday: 'Sat', days: 3, mean: 220 },
        { state: 'between_terms', weekday: 'Sat', days: 2, mean: null },
      ],
      first: '2026-10-03',
      last: '2026-12-12',
    });
    expect(MIN_CELL_DAYS).toBe(3);
  });

  it('leaves out closed, noted, holiday and event days, unknown term days and days without the metric', () => {
    const days = [
      day('2026-10-03', 200), day('2026-10-10', 220), day('2026-10-17', 240), day('2026-10-24', 0, 0),
      day('2026-10-31', 400), day('2026-11-07', 300), day('2026-11-14', 900), day('2026-11-21', 999), day('2026-10-26', null, 50_000),
    ];
    const notes = [{ startDate: '2026-10-31', endDate: '2026-10-31', weekdays: null, effect: 'more_guests' as const }];
    const events = [{ start: '2026-11-07', end: '2026-11-07', kind: 'event' as const }, { start: '2026-11-14', end: '2026-11-14', kind: 'holiday' as const }];
    const history = yourHistory(days, notes, events, stateOf);
    expect(history.cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 3, mean: 220 }]);
    expect([history.first, history.last]).toEqual(['2026-10-03', '2026-10-17']);
  });

  it('leaves out a likely-closed day (spec D32): its guests are not a slow Saturday', () => {
    const days = [day('2026-09-19', 200), day('2026-09-26', 200), day('2026-10-03', 200), day('2026-10-10', 2), day('2026-10-17', 200)];
    expect(yourHistory(days, [], [], stateOf).cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 4, mean: 200 }]);
  });

  it('uses net sales in whole dollars only when no day has guests', () => {
    const days = [day('2026-10-03', null, 400_049), day('2026-10-10', null, 500_000), day('2026-10-17', null, 600_000)];
    expect(yourHistory(days, [], [], stateOf)).toMatchObject({
      metric: 'netSales', cells: [{ state: 'in_session', weekday: 'Sat', days: 3, mean: 5000 }],
    });
  });

  it('is empty, with no dates, when nothing counts', () => {
    expect(yourHistory([], [], [], stateOf)).toEqual({ metric: 'netSales', cells: [], first: null, last: null });
    expect(yourHistory([day('2027-03-06', 100)], [], [], stateOf)).toEqual({ metric: 'guests', cells: [], first: null, last: null });
  });
});
