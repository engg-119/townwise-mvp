// "Your history by term state" (spec 13.2): the day classes match the client's (the shared day-classes.json
// fixture, kept identical to the client's copy), only open regular days with a known term state count, and a cell
// needs 3 days for a mean. Synthetic days only.
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { trustedGuestDays, typicalGuests } from '../src/closed-days.ts';
import { classOfDay, closureOfDay, MIN_CELL_DAYS, yourHistory, type DayClass } from '../src/people-in-town/history.ts';
import type { TermState } from '../src/people-in-town/term.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';
import type { NoteContent } from '../src/stores/notes.ts';
import type { SalesDay } from '../src/stores/sales-days.ts';
import type { TownEvent } from '../src/town-calendar.ts';

interface ClassCase {
  name: string;
  date: string;
  /** Other stored days' guests, which the day's typical guests come from (spec D32); none when absent. */
  history?: { date: string; guests: number | null }[];
  day: { guests: number | null; netSalesCents: number | null } | null;
  notes: Pick<NoteContent, 'kind' | 'startDate' | 'endDate' | 'weekdays' | 'effect'>[];
  /** Business rule schedules covering the day (spec D31); none when absent. */
  rules?: Pick<RuleSchedule, 'kind' | 'startDate' | 'endDate' | 'weekdays' | 'effect'>[];
  events: Pick<TownEvent, 'start' | 'end' | 'kind'>[];
  /** The town's today; absent, the day is before today. */
  today?: string;
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
      // A guest count marked wrong (D67) is read first, on the day and its history, as every reader does.
      const guests = new Map(trustedGuestDays(each.history ?? [], each.notes).map((other) => [other.date, other.guests]));
      const typical = typicalGuests(each.date, (date) => guests.get(date));
      const stored = each.day === null ? undefined : trustedGuestDays([{ date: each.date, ...each.day }], each.notes)[0];
      const [rules, today] = [each.rules ?? [], each.today ?? null];
      expect(classOfDay(each.date, stored, each.notes, each.events, typical, rules, today)).toBe(each.class);
      expect(closureOfDay(each.date, stored, each.notes, typical, rules, today) === 'likely_closed').toBe(each.likelyClosed === true);
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
    const notes = [{ kind: 'private_event' as const, startDate: '2026-10-31', endDate: '2026-10-31', weekdays: null, effect: 'more_guests' as const }];
    const events = [{ start: '2026-11-07', end: '2026-11-07', kind: 'event' as const }, { start: '2026-11-14', end: '2026-11-14', kind: 'holiday' as const }];
    const history = yourHistory(days, notes, events, stateOf);
    expect(history.cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 3, mean: 220 }]);
    expect([history.first, history.last]).toEqual(['2026-10-03', '2026-10-17']);
  });

  it('treats a covering rule schedule like a note for the likely-closed check (spec D32, D31)', () => {
    const history = [{ date: '2026-09-19', guests: 200 }, { date: '2026-09-26', guests: 200 }, { date: '2026-10-03', guests: 200 }];
    const guests = new Map(history.map((other) => [other.date, other.guests]));
    const typical = typicalGuests('2026-10-10', (date) => guests.get(date));
    const near = day('2026-10-10', 2);
    const rule = (effect: NoteContent['effect'], endDate: string | null = null) => ({ kind: 'other' as const, startDate: '2026-10-01', endDate, weekdays: null, effect });
    for (const effect of ['more_guests', 'fewer_guests'] as const) {
      expect(closureOfDay('2026-10-10', near, [], typical, [rule(effect)])).toBeNull();
      expect(classOfDay('2026-10-10', near, [], [], typical, [rule(effect)])).toBe('regular');
    }
    expect(closureOfDay('2026-10-10', near, [], typical)).toBe('likely_closed');
    // Other effects change nothing about the override; a closed rule closes the day as a closed note does.
    expect(closureOfDay('2026-10-10', near, [], typical, [rule('unknown')])).toBe('likely_closed');
    expect(closureOfDay('2026-10-10', near, [], typical, [rule('closed')])).toBe('closed');
    // Outside its dates or weekdays, or ended before the day, a rule does not apply.
    expect(closureOfDay('2026-10-10', near, [], typical, [rule('more_guests', '2026-10-09')])).toBe('likely_closed');
    expect(closureOfDay('2026-10-10', near, [], typical, [{ ...rule('more_guests'), weekdays: [1] }])).toBe('likely_closed');
    expect(closureOfDay('2026-10-10', near, [], typical, [{ ...rule('more_guests'), startDate: '2026-10-11' }])).toBe('likely_closed');
  });

  it('keeps a rule-covered near-empty day in the history as an open day', () => {
    const days = [day('2026-09-19', 200), day('2026-09-26', 200), day('2026-10-03', 200), day('2026-10-10', 2), day('2026-10-17', 200)];
    const rules = [{ kind: 'other' as const, startDate: '2026-10-10', endDate: null, weekdays: null, effect: 'fewer_guests' as const }];
    expect(yourHistory(days, [], [], stateOf, rules).cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 5, mean: 160 }]);
  });

  it('leaves a guest count marked wrong (D67) out of every mean, and out of its neighbors’ likely-closed test', () => {
    const days = [day('2026-09-19', 200), day('2026-09-26', 200), day('2026-10-03', 200), day('2026-10-10', 20), day('2026-10-17', 900)];
    const mark = (date: string) => ({ kind: 'other' as const, startDate: date, endDate: date, weekdays: null, effect: 'wrong_guest_count' as const });
    expect(yourHistory(days, [], [], stateOf).cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 5, mean: 304 }]);
    // Oct 17 marked: its count is in no mean, and the Saturday is noted, not regular.
    expect(yourHistory(days, [mark('2026-10-17')], [], stateOf).cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 4, mean: 155 }]);
    // A marked day is never counted under the netSales metric either: it is noted.
    expect(yourHistory([day('2026-10-10', 0, 50_000)], [mark('2026-10-10')], [], stateOf)).toMatchObject({ cells: [], first: null });
    // Oct 3's 10 marked: too few Saturdays remain for Oct 10's typical guests, so its 18 is a slow Saturday, not likely closed.
    const slow = [day('2026-09-19', 200), day('2026-09-26', 200), day('2026-10-03', 10), day('2026-10-10', 18)];
    expect(yourHistory(slow, [], [], stateOf).cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 3, mean: 137 }]);
    expect(yourHistory(slow, [mark('2026-10-03')], [], stateOf).cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 3, mean: 139 }]);
  });

  it('leaves out a likely-closed day (spec D32): its guests are not a slow Saturday', () => {
    const days = [day('2026-09-19', 200), day('2026-09-26', 200), day('2026-10-03', 200), day('2026-10-10', 2), day('2026-10-17', 200)];
    expect(yourHistory(days, [], [], stateOf).cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 4, mean: 200 }]);
  });

  it('never calls a day on or after today likely closed (spec D32): today’s upload may be partial', () => {
    const days = [day('2026-09-19', 200), day('2026-09-26', 200), day('2026-10-03', 200), day('2026-10-10', 2)];
    expect(yourHistory(days, [], [], stateOf, [], '2026-10-11').cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 3, mean: 200 }]);
    expect(yourHistory(days, [], [], stateOf, [], '2026-10-10').cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 4, mean: 151 }]);
  });

  it('keeps a past day’s real guests under a standing closure rule, and leaves out the days the rule really closed', () => {
    const closedSaturdays = [{ kind: 'closure' as const, startDate: '2026-10-01', endDate: null, weekdays: [6], effect: 'closed' as const }];
    const days = [day('2026-09-19', 200), day('2026-09-26', 200), day('2026-10-03', 210), day('2026-10-10', 2), day('2026-10-17', 0, 500)];
    expect(yourHistory(days, [], [], stateOf, closedSaturdays, '2026-11-01').cells).toEqual([{ state: 'in_session', weekday: 'Sat', days: 3, mean: 203 }]);
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
