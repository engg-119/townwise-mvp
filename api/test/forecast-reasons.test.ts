// A note's reason on a forecast day (spec 14.5), without Docker: its words are made in code from the note's kind, guest
// count and hours, never from its detail, and carry the note's id, guests and outcome; a run's reasons carry no note.
// A reason's effect (spec 14.4): the model's where the run recorded one, otherwise how the location's own last 52 weeks
// usually ran, closed and likely-closed days left out, rounded to the nearest 5 and null below each kind's minimum.
// Synthetic notes and days.
import { describe, expect, it } from 'vitest';

import { utcDay } from '../src/dates.ts';
import { effectFrom, effectHistory, reasonEffects, type EffectHistory } from '../src/forecasts/effects.ts';
import type { ReasonKind } from '../src/forecasts/file.ts';
import { clockWords, noteReasonView, reasonViews, ruleReasonView, townCalendarOf } from '../src/forecasts/reasons.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';
import type { NoteContent, NoteRecord } from '../src/stores/notes.ts';
import type { SalesDay } from '../src/stores/sales-days.ts';
import { weekdayOf } from '../src/time-zones.ts';

const SENTINEL = 'Smith rehearsal dinner for sentinel-guest';
const ID = '0000000000000000000000aa';

function note(fields: Partial<NoteContent> = {}): NoteRecord {
  return {
    id: ID, kind: 'private_event', startDate: '2026-06-06', endDate: '2026-06-06', weekdays: null, effect: 'more_guests',
    expectedGuests: 70, detail: SENTINEL, startTime: null, endTime: null, createdBy: 'author', byStaff: false,
    createdAt: new Date('2026-05-01T00:00:00Z'), updatedAt: new Date('2026-05-01T00:00:00Z'), ...fields,
  };
}

describe('note reasons', () => {
  it('words a note reason from its kind, guests and hours, never its detail', () => {
    const added = noteReasonView(note({ startTime: '18:00', endTime: '21:00' }), 'added');
    expect(added).toEqual({
      kind: 'note', label: 'Your private event, 70 guests, 6 pm to 9 pm', effectPct: null, effect: null, sources: [],
      note: { id: ID, guests: 70, outcome: 'added' }, rule: null,
    });
    const labels = [
      noteReasonView(note({ effect: 'closed', expectedGuests: 70 }), 'booked'),
      noteReasonView(note({ effect: 'closed', expectedGuests: null }), 'booked'),
      noteReasonView(note({ kind: 'closure', effect: 'closed', expectedGuests: null }), 'closed'),
      noteReasonView(note({ kind: 'other', effect: 'closed', expectedGuests: null }), 'closed'),
      noteReasonView(note({ kind: 'opening', expectedGuests: 50, startTime: '11:30', endTime: '14:00' }), 'not_counted'),
      noteReasonView(note({ kind: 'other', expectedGuests: null }), 'not_counted'),
      noteReasonView(note({ expectedGuests: 1 }), 'past_day'),
      noteReasonView(note({ expectedGuests: null, startTime: '12:00', endTime: '13:15' }), 'no_guest_count'),
    ].map((view) => view.label);
    expect(labels).toEqual([
      'Your private buyout, 70 guests',
      'Your private buyout',
      'Your closure',
      'Your note: closed',
      'Your opening, 50 guests, 11:30 am to 2 pm',
      'Your note',
      'Your private event, 1 guest',
      'Your private event, noon to 1:15 pm',
    ]);
    expect(noteReasonView(note({ effect: 'closed', expectedGuests: null }), 'day_closed').note).toEqual({ id: ID, guests: null, outcome: 'day_closed' });
    expect(JSON.stringify([added, labels])).not.toContain('sentinel');
  });

  it('clockWords: 18:30 is 6:30 pm, 12:00 is noon, 00:15 is 12:15 am', () => {
    expect(['18:30', '12:00', '00:15', '00:00', '09:00', '12:45', '23:59'].map(clockWords)).toEqual([
      '6:30 pm', 'noon', '12:15 am', 'midnight', '9 am', '12:45 pm', '11:59 pm',
    ]);
  });

  it('a run’s reasons carry no note', () => {
    const [weekday] = reasonViews('2026-06-06', [{ kind: 'weekday', ref: null, effectPct: null }], townCalendarOf('hanover-nh')('2026-06-06'));
    expect(weekday).toEqual({ kind: 'weekday', label: 'Saturday', effectPct: null, effect: null, sources: [], note: null, rule: null });
  });
});

describe('rule reasons', () => {
  const RULE_ID = '0000000000000000000000bb';
  const schedule = (fields: Partial<RuleSchedule> = {}): RuleSchedule => ({
    kind: 'closure', startDate: '2026-01-05', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
    ...fields,
  });

  it('words a rule’s reason from its schedule (no dates), never the rule’s text, and carries the rule’s id, guests and outcome', () => {
    expect(ruleReasonView({ id: RULE_ID, schedule: schedule() }, 'closed')).toEqual({
      kind: 'rule', label: 'Your rule: closed on Mondays', effectPct: null, effect: null, sources: [], note: null,
      rule: { id: RULE_ID, guests: null, outcome: 'closed' },
    });
    const labels = [
      schedule({ kind: 'private_event', effect: 'more_guests', expectedGuests: 40, weekdays: [5], startTime: '18:00', endTime: '21:00' }),
      schedule({ weekdays: null }),
      schedule({ kind: 'private_event', effect: 'closed', expectedGuests: 70, weekdays: [6, 0] }),
      schedule({ kind: 'other', effect: 'fewer_guests', weekdays: [2] }),
    ].map((each) => ruleReasonView({ id: RULE_ID, schedule: each }, 'not_counted').label);
    expect(labels).toEqual([
      'Your rule: adds 40 guests on Fridays, 6 pm to 9 pm',
      'Your rule: closed',
      'Your rule: private buyout, 70 guests on Saturdays and Sundays',
      'Your rule: other, fewer guests than usual on Tuesdays',
    ]);
    expect(ruleReasonView({ id: RULE_ID, schedule: schedule({ kind: 'private_event', effect: 'more_guests', expectedGuests: 40 }) }, 'added').rule)
      .toEqual({ id: RULE_ID, guests: 40, outcome: 'added' });
  });
});

describe('reason effects', () => {
  // Today is Thu, Nov 12, 2026: the history is Nov 13, 2025 to Nov 11, 2026, 52 of each weekday.
  const TODAY = '2026-11-12';
  const hanover = townCalendarOf('hanover-nh');
  const shift = (date: string, days: number): string => utcDay(new Date(`${date}T00:00:00.000Z`), days);
  /** 170 guests on a Saturday, 100 on any other day. */
  const base = (date: string): number => (weekdayOf(date) === 'Sat' ? 170 : 100);
  const reason = (kind: ReasonKind, ref: string | null = null, effectPct: number | null = null) => ({ kind, ref, effectPct });

  /** Every day the effects read, from the 8 weeks before the history to yesterday; null guests is a day with no row. */
  function history(guestsOf: (date: string) => number | null, fields: Partial<EffectHistory> = {}): EffectHistory {
    const { readFrom, to } = effectHistory(TODAY);
    const days: SalesDay[] = [];
    for (let date = readFrom; date <= to; date = shift(date, 1)) {
      const guests = guestsOf(date);
      if (guests !== null) days.push({ date, guests, netSalesCents: guests * 2000 });
    }
    return { today: TODAY, townId: 'hanover-nh', days, covering: () => [], ...fields };
  }

  it('rounds the size to the nearest 5, and 5 or less reads as about the same', () => {
    expect(effectFrom(54.5, 'history', 52)).toEqual({ direction: 'more', pct: 55, basis: 'history', days: 52 });
    expect(effectFrom(-9.1, 'history', 20)).toEqual({ direction: 'fewer', pct: 10, basis: 'history', days: 20 });
    expect(effectFrom(7.4, 'model', null)).toEqual({ direction: 'same', pct: 5, basis: 'model', days: null });
    expect(effectFrom(-2, 'history', 8)).toEqual({ direction: 'same', pct: 0, basis: 'history', days: 8 });
    expect(effectFrom(7.5, 'history', 8)).toMatchObject({ direction: 'more', pct: 10 });
    expect(effectFrom(-7.5, 'history', 8)).toMatchObject({ direction: 'fewer', pct: 10 });
  });

  it('reads the 52 weeks before today, and the 8 weeks before them that likely closed needs', () => {
    expect(effectHistory(TODAY)).toEqual({ from: '2025-11-13', to: '2026-11-11', readFrom: '2025-09-18' });
  });

  it('a run’s recorded effect is the model’s, whatever the history says', () => {
    const effectOf = reasonEffects(history(base));
    expect(effectOf('2026-11-21', reason('weekday', null, 23), hanover('2026-11-21'))).toEqual({ direction: 'more', pct: 25, basis: 'model', days: null });
    expect(effectOf('2026-11-21', reason('level', null, -4), hanover('2026-11-21'))).toEqual({ direction: 'same', pct: 5, basis: 'model', days: null });
  });

  it('weekday: that weekday’s mean against the mean of every open day; under 8 of its days, none', () => {
    const effectOf = reasonEffects(history(base));
    // Saturdays 170 against 110 a day: 55% more; Fridays 100 against 110: 10% fewer.
    expect(effectOf('2026-11-21', reason('weekday'), hanover('2026-11-21'))).toEqual({ direction: 'more', pct: 55, basis: 'history', days: 52 });
    expect(effectOf('2026-11-20', reason('weekday'), hanover('2026-11-20'))).toEqual({ direction: 'fewer', pct: 10, basis: 'history', days: 52 });
    const since = (from: string) => reasonEffects(history((date) => (date < from ? null : base(date))));
    expect(since('2026-09-24')('2026-11-21', reason('weekday'), hanover('2026-11-21'))).toBeNull();
    expect(since('2026-09-17')('2026-11-21', reason('weekday'), hanover('2026-11-21'))).toEqual({ direction: 'more', pct: 55, basis: 'history', days: 8 });
  });

  it('leaves closed and likely-closed days out of every comparison', () => {
    // A Saturday of 1 guest (likely closed), one a closure note covers and an all-zero one. Counted, they would make 50%.
    const guestsOf = (date: string): number => (date === '2026-10-10' ? 1 : date === '2026-10-24' ? 0 : base(date));
    const effectOf = reasonEffects(history(guestsOf, { covering: (date) => (date === '2026-10-17' ? [{ effect: 'closed' }] : []) }));
    expect(effectOf('2026-11-21', reason('weekday'), hanover('2026-11-21'))).toEqual({ direction: 'more', pct: 55, basis: 'history', days: 49 });
  });

  it('term state: each day in it against the same weekday in the other known term states; 6 a side', () => {
    const guestsOf = (date: string): number => (hanover(date).term.state === 'finals' ? base(date) * 0.8 : base(date));
    const effectOf = reasonEffects(history(guestsOf));
    // Fall 2025 (6 days), winter (5), spring (5) and summer (4) finals, each 20% under its weekday.
    expect(effectOf('2026-11-21', reason('term', 'hanover-nh:finals:fall'), hanover('2026-11-21')))
      .toEqual({ direction: 'fewer', pct: 20, basis: 'history', days: 20 });
    // A day whose term state is unknown (between classes and finals), and a history with no finals in it, say nothing.
    expect(effectOf('2026-11-19', reason('term'), hanover('2026-11-19'))).toBeNull();
    const sinceSummer = reasonEffects(history((date) => (date < '2026-09-02' ? null : guestsOf(date))));
    expect(sinceSummer('2026-11-21', reason('term'), hanover('2026-11-21'))).toBeNull();
  });

  it('event group: each day with it against the same weekday without it; 3 event days', () => {
    const football = (date: string): boolean => hanover(date).events.some((event) => event.group === 'hanover-nh:home-football');
    const guestsOf = (date: string): number => (football(date) ? base(date) * 1.5 : base(date));
    const effectOf = reasonEffects(history(guestsOf));
    // Four Saturday games and a Friday one, each half again its weekday.
    expect(effectOf('2026-11-21', reason('event', 'hanover-nh:home-football'), hanover('2026-11-21')))
      .toEqual({ direction: 'more', pct: 50, basis: 'history', days: 5 });
    // An event the ref doesn't name, and a history with two games, say nothing.
    expect(effectOf('2026-11-21', reason('event'), hanover('2026-11-21'))).toBeNull();
    const late = reasonEffects(history((date) => (date < '2026-10-04' ? null : guestsOf(date))));
    expect(late('2026-11-21', reason('event', 'hanover-nh:home-football'), hanover('2026-11-21'))).toBeNull();
  });

  it('holiday: each past occurrence against the same weekday in the 4 weeks around it, other holidays left out', () => {
    // Thanksgiving 2025 had 30 guests against Thursdays of 100; Christmas, a Thursday 4 weeks on, is left out.
    const guestsOf = (date: string): number => (date === '2025-11-27' ? 30 : date === '2025-12-25' ? 40 : base(date));
    const effectOf = reasonEffects(history(guestsOf));
    expect(effectOf('2026-11-26', reason('holiday'), hanover('2026-11-26'))).toEqual({ direction: 'fewer', pct: 70, basis: 'history', days: 1 });
    const closed = reasonEffects(history(guestsOf, { covering: (date) => (date === '2025-11-27' ? [{ effect: 'closed' }] : []) }));
    expect(closed('2026-11-26', reason('holiday'), hanover('2026-11-26'))).toBeNull();
  });

  it('level, closure and booking reasons, and a holiday reason on a day with none, carry no history effect', () => {
    const effectOf = reasonEffects(history(base));
    for (const kind of ['level', 'closure', 'booking'] as const) expect(effectOf('2026-11-21', reason(kind), hanover('2026-11-21'))).toBeNull();
    expect(effectOf('2026-11-21', reason('holiday'), hanover('2026-11-21'))).toBeNull();
    expect(reasonEffects(history(() => null))('2026-11-21', reason('weekday'), hanover('2026-11-21'))).toBeNull();
  });

  it('reasonViews puts each reason’s effect on its view; without effects (a past day) every effect is null', () => {
    const effectOf = reasonEffects(history(base));
    const run = [reason('weekday'), reason('event', 'hanover-nh:home-football', 12)];
    expect(reasonViews('2026-11-21', run, hanover('2026-11-21'), effectOf).map((view) => [view.label, view.effectPct, view.effect])).toEqual([
      ['Saturday', null, { direction: 'more', pct: 55, basis: 'history', days: 52 }],
      ['Home football vs Brown', 12, { direction: 'more', pct: 10, basis: 'model', days: null }],
    ]);
    expect(reasonViews('2026-11-21', run, hanover('2026-11-21')).map((view) => view.effect)).toEqual([null, null]);
  });
});
