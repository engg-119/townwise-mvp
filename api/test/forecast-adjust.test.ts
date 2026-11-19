// Notes in the forecast (spec 14.5), without Docker: from the town's today on, a private event with a guest count adds
// its guests to an open day, a buyout books the day, a closure note closes it whatever the model said; on a day the
// model closed, a buyout books it and a private event with a count opens it with only those guests; a party the
// run already counted, a note with no count, an opening, an other note and a past day change no number and say why;
// note reasons come at most six, the ones that changed the day first. Synthetic notes.
import { describe, expect, it } from 'vitest';

import { adjustDay, flagsAfterData, MAX_NOTE_REASONS, MAX_RULE_REASONS, orderedReasons, type AdjustedNote, type AdjustedRule, type ModelDay, type ScheduledRule } from '../src/forecasts/adjust.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';
import type { NoteContent, NoteRecord } from '../src/stores/notes.ts';

const TODAY = '2026-06-01';
const DAY = '2026-06-06';
const OPEN: ModelDay = { status: 'open', low: 80, mid: 100, high: 120 };
const CLOSED: ModelDay = { status: 'closed', low: null, mid: null, high: null };
const BOOKED: ModelDay = { status: 'booked', low: null, mid: null, high: null };
const WEEKDAY = [{ kind: 'weekday' as const }];

let ids = 0;
function note(fields: Partial<NoteContent> = {}): NoteRecord {
  ids += 1;
  return {
    id: String(ids).padStart(24, '0'), kind: 'private_event', startDate: DAY, endDate: DAY, weekdays: null, effect: 'more_guests',
    expectedGuests: 70, detail: null, title: null, startTime: null, endTime: null, createdBy: 'author', byStaff: false, source: null, fromEvent: null, agent: null,
    createdAt: new Date('2026-05-01T00:00:00Z'), updatedAt: new Date('2026-05-01T00:00:00Z'), ...fields,
  };
}
const party = (guests: number | null) => note({ expectedGuests: guests });
const buyout = (guests: number | null) => note({ effect: 'closed', expectedGuests: guests });
const closure = () => note({ kind: 'closure', effect: 'closed', expectedGuests: null });

describe('adjustDay', () => {
  it('adds a private event’s guests to low, mid and high on an open day from today on', () => {
    const added = party(70);
    for (const date of [TODAY, DAY]) {
      expect(adjustDay(date, TODAY, OPEN, WEEKDAY, [added])).toEqual({
        status: 'open', low: 150, mid: 170, high: 190, noteGuests: 70, rules: [], notes: [{ note: added, outcome: 'added' }],
      });
    }
  });

  it('sums two private events on one day', () => {
    const day = adjustDay(DAY, TODAY, OPEN, WEEKDAY, [party(70), party(30)]);
    expect(day).toMatchObject({ status: 'open', low: 180, mid: 200, high: 220, noteGuests: 100 });
    expect(day.notes.map((entry) => entry.outcome)).toEqual(['added', 'added']);
  });

  it('a buyout makes the day booked with null figures and its guests in noteGuests', () => {
    const booked = buyout(50);
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [booked])).toEqual({
      status: 'booked', low: null, mid: null, high: null, noteGuests: 50, rules: [], notes: [{ note: booked, outcome: 'booked' }],
    });
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [buyout(null)])).toMatchObject({ status: 'booked', noteGuests: 0 });
    expect(adjustDay(DAY, TODAY, BOOKED, [{ kind: 'booking' }], [buyout(40)])).toMatchObject({ status: 'booked', noteGuests: 40 });
  });

  it('a closure closes an open or booked day; closed beats booked beats open', () => {
    for (const model of [OPEN, BOOKED, CLOSED]) {
      const closing = closure();
      expect(adjustDay(DAY, TODAY, model, [], [closing])).toEqual({
        status: 'closed', low: null, mid: null, high: null, noteGuests: 0, rules: [], notes: [{ note: closing, outcome: 'closed' }],
      });
    }
    // Another kind of note whose effect is closed closes the day too.
    expect(adjustDay(DAY, TODAY, OPEN, [], [note({ kind: 'other', effect: 'closed', expectedGuests: null, detail: 'x' })]))
      .toMatchObject({ status: 'closed', notes: [{ outcome: 'closed' }] });
    const booked = buyout(50);
    const closing = closure();
    const both = adjustDay(DAY, TODAY, OPEN, [], [booked, closing]);
    expect(both).toMatchObject({ status: 'closed', low: null, noteGuests: 0 });
    expect(both.notes).toEqual([{ note: closing, outcome: 'closed' }, { note: booked, outcome: 'day_closed' }]);
    expect(adjustDay(DAY, TODAY, CLOSED, [], [booked, closing])).toMatchObject({ status: 'closed', noteGuests: 0 });
  });

  it('on a day the model closed (a learned closure, no note), a buyout books it with its guests', () => {
    const booked = buyout(50);
    expect(adjustDay(DAY, TODAY, CLOSED, [{ kind: 'closure' }], [booked])).toEqual({
      status: 'booked', low: null, mid: null, high: null, noteGuests: 50, rules: [], notes: [{ note: booked, outcome: 'booked' }],
    });
    // A party on the same day can't add walk-ins to a booked day.
    expect(adjustDay(DAY, TODAY, CLOSED, [], [booked, party(70)])).toMatchObject({
      status: 'booked', noteGuests: 50, notes: [{ outcome: 'booked' }, { outcome: 'day_booked' }],
    });
  });

  it('on a day the model closed, a private event with a guest count opens it with just those guests', () => {
    const added = party(70);
    expect(adjustDay(DAY, TODAY, CLOSED, [{ kind: 'closure' }], [added])).toEqual({
      status: 'open', low: 70, mid: 70, high: 70, noteGuests: 70, rules: [], notes: [{ note: added, outcome: 'added' }],
    });
    expect(adjustDay(DAY, TODAY, CLOSED, [], [party(70), party(30), party(null)])).toMatchObject({
      status: 'open', low: 100, mid: 100, high: 100, noteGuests: 100, notes: [{ outcome: 'added' }, { outcome: 'added' }, { outcome: 'no_guest_count' }],
    });
    // With no count it stays closed, and the note says what would change it; fewer or unknown can't open it.
    expect(adjustDay(DAY, TODAY, CLOSED, [], [party(null), note({ effect: 'fewer_guests', expectedGuests: 20 })])).toMatchObject({
      status: 'closed', low: null, noteGuests: 0, notes: [{ outcome: 'no_guest_count' }, { outcome: 'day_closed' }],
    });
    // A closure note still wins over everything.
    expect(adjustDay(DAY, TODAY, CLOSED, [], [party(70), party(null), closure()])).toMatchObject({
      status: 'closed', low: null, noteGuests: 0, notes: [{ outcome: 'closed' }, { outcome: 'day_closed' }, { outcome: 'day_closed' }],
    });
  });

  it('a private event on a run day with a booking reason adds nothing (already_in_forecast)', () => {
    expect(adjustDay(DAY, TODAY, OPEN, [{ kind: 'weekday' }, { kind: 'booking' }], [party(70)])).toMatchObject({
      status: 'open', low: 80, mid: 100, high: 120, noteGuests: 0, notes: [{ outcome: 'already_in_forecast' }],
    });
  });

  it('a private event with no guest count, an opening, an other note, fewer or unknown change no number and say why', () => {
    const notes = [
      party(null),
      note({ kind: 'opening', expectedGuests: 50 }),
      note({ kind: 'other', expectedGuests: 50, detail: 'x' }),
      note({ effect: 'fewer_guests', expectedGuests: 20 }),
      note({ effect: 'unknown', expectedGuests: 20 }),
    ];
    const day = adjustDay(DAY, TODAY, OPEN, WEEKDAY, notes);
    expect(day).toMatchObject({ status: 'open', low: 80, mid: 100, high: 120, noteGuests: 0 });
    expect(day.notes.map((entry) => entry.outcome)).toEqual(['no_guest_count', 'not_counted', 'not_counted', 'not_counted', 'not_counted']);
  });

  it('a private event on a day a closure note closed is day_closed, and on a booked day day_booked', () => {
    expect(adjustDay(DAY, TODAY, OPEN, [], [party(70), closure()])).toMatchObject({ status: 'closed', noteGuests: 0, notes: [{ outcome: 'closed' }, { outcome: 'day_closed' }] });
    expect(adjustDay(DAY, TODAY, BOOKED, [], [party(70)])).toMatchObject({ status: 'booked', noteGuests: 0, notes: [{ outcome: 'day_booked' }] });
    expect(adjustDay(DAY, TODAY, BOOKED, [], [party(null)])).toMatchObject({ status: 'booked', noteGuests: 0, notes: [{ outcome: 'day_booked' }] });
    const booked = buyout(50);
    const added = party(70);
    expect(adjustDay(DAY, TODAY, OPEN, [], [added, booked])).toMatchObject({
      status: 'booked', noteGuests: 50, rules: [], notes: [{ note: booked, outcome: 'booked' }, { note: added, outcome: 'day_booked' }],
    });
  });

  it('a day before today keeps the model’s figures and lists its notes as past_day', () => {
    const day = adjustDay('2026-05-31', TODAY, OPEN, WEEKDAY, [party(70), closure(), buyout(20)]);
    expect(day).toMatchObject({ status: 'open', low: 80, mid: 100, high: 120, noteGuests: 0 });
    expect(day.notes.map((entry) => entry.outcome)).toEqual(['past_day', 'past_day', 'past_day']);
  });

  it('model keeps the run’s own status and figures', () => {
    const model: ModelDay = { status: 'open', low: 80.4, mid: 100.5, high: 119.6 };
    const before = structuredClone(model);
    expect(adjustDay(DAY, TODAY, model, WEEKDAY, [party(70)])).toMatchObject({ low: 150.4, mid: 170.5, high: 189.6 });
    expect(adjustDay(DAY, TODAY, model, WEEKDAY, [closure()])).toMatchObject({ status: 'closed', low: null });
    expect(model).toEqual(before);
    expect(adjustDay(DAY, TODAY, model, WEEKDAY, [])).toEqual({ ...model, noteGuests: 0, notes: [], rules: [] });
  });
});

describe('orderedReasons', () => {
  const RUN = ['run:weekday', 'run:term'];
  const words = (entry: AdjustedNote | AdjustedRule) => ('note' in entry
    ? `${entry.outcome}:${String(entry.note.expectedGuests)}`
    : `rule ${entry.outcome}:${String(entry.rule.schedule.expectedGuests)}`);

  it('at most 6 note reasons in order added, booked, closed, run reasons, then the rest; moreNotes counts the others; sums count all', () => {
    expect(MAX_NOTE_REASONS).toBe(6);
    const many = adjustDay(DAY, TODAY, OPEN, WEEKDAY, [
      note({ kind: 'opening', expectedGuests: 5 }), ...[1, 2, 3, 4, 5, 6, 7].map((guests) => party(guests)), party(null),
    ]);
    expect(many.noteGuests).toBe(28);
    expect(many.mid).toBe(128);
    expect(orderedReasons(many, RUN, words)).toEqual({
      reasons: ['added:1', 'added:2', 'added:3', 'added:4', 'added:5', 'added:6', 'run:weekday', 'run:term'],
      moreNotes: 3, moreRules: 0,
    });
    const few = adjustDay(DAY, TODAY, OPEN, WEEKDAY, [
      note({ kind: 'opening', expectedGuests: 5 }), party(10), party(null), note({ kind: 'other', expectedGuests: null, detail: 'x' }),
      party(20), note({ effect: 'unknown', expectedGuests: 9 }), note({ effect: 'fewer_guests', expectedGuests: 8 }),
    ]);
    expect(orderedReasons(few, RUN, words)).toEqual({
      reasons: ['added:10', 'added:20', 'run:weekday', 'run:term', 'not_counted:5', 'no_guest_count:null', 'not_counted:null', 'not_counted:9'],
      moreNotes: 1, moreRules: 0,
    });
    const closed = adjustDay(DAY, TODAY, OPEN, [], [party(70), closure(), buyout(20)]);
    expect(orderedReasons(closed, RUN, words)).toEqual({ reasons: ['closed:null', 'run:weekday', 'run:term', 'day_closed:70', 'day_closed:20'], moreNotes: 0, moreRules: 0 });
    expect(orderedReasons(adjustDay(DAY, TODAY, OPEN, WEEKDAY, []), RUN, words)).toEqual({ reasons: RUN, moreNotes: 0, moreRules: 0 });
  });
});

let ruleIds = 0;
/** A business rule with a schedule (D31): every day from Jan 5, closed unless the fields say otherwise. */
function rule(fields: Partial<RuleSchedule> = {}): ScheduledRule {
  ruleIds += 1;
  return {
    id: `b${String(ruleIds).padStart(23, '0')}`,
    schedule: {
      kind: 'closure', startDate: '2026-01-05', endDate: null, weekdays: null, effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
      ...fields,
    },
  };
}
const ruleParty = (guests: number | null) => rule({ kind: 'private_event', effect: 'more_guests', expectedGuests: guests });

describe('adjustDay with business rules (D31)', () => {
  it('a rule’s schedule applies as a note would: a closure closes the day, a party adds its guests, a buyout books it', () => {
    const closing = rule();
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [], [closing])).toEqual({
      status: 'closed', low: null, mid: null, high: null, noteGuests: 0, notes: [], rules: [{ rule: closing, outcome: 'closed' }],
    });
    const party40 = ruleParty(40);
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [], [party40])).toEqual({
      status: 'open', low: 120, mid: 140, high: 160, noteGuests: 40, notes: [], rules: [{ rule: party40, outcome: 'added' }],
    });
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [], [rule({ kind: 'private_event', effect: 'closed', expectedGuests: 60 })]))
      .toMatchObject({ status: 'booked', low: null, noteGuests: 60, rules: [{ outcome: 'booked' }] });
    // On a day the model closed, a rule's party opens it with only its guests, as a note's does.
    expect(adjustDay(DAY, TODAY, CLOSED, [{ kind: 'closure' }], [], [ruleParty(40)]))
      .toMatchObject({ status: 'open', low: 40, mid: 40, high: 40, noteGuests: 40, rules: [{ outcome: 'added' }] });
  });

  it('rules and notes on the same day both apply, and their guests add up', () => {
    const day = adjustDay(DAY, TODAY, OPEN, WEEKDAY, [party(70)], [ruleParty(40), ruleParty(10)]);
    expect(day).toMatchObject({
      status: 'open', low: 200, mid: 220, high: 240, noteGuests: 120,
      notes: [{ outcome: 'added' }], rules: [{ outcome: 'added' }, { outcome: 'added' }],
    });
  });

  it('a rule’s closure wins over the model, the other rules and a note that does not decide the day', () => {
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [note({ kind: 'other', effect: 'unknown', expectedGuests: null })], [rule(), ruleParty(40)])).toMatchObject({
      status: 'closed', low: null, noteGuests: 0, notes: [{ outcome: 'not_counted' }], rules: [{ outcome: 'closed' }, { outcome: 'day_closed' }],
    });
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [closure()], [ruleParty(40)])).toMatchObject({
      status: 'closed', noteGuests: 0, notes: [{ outcome: 'closed' }], rules: [{ outcome: 'day_closed' }],
    });
    // A note's buyout books the day, so a rule's party there adds no walk-ins.
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [buyout(50)], [ruleParty(40)])).toMatchObject({
      status: 'booked', noteGuests: 50, notes: [{ outcome: 'booked' }], rules: [{ outcome: 'day_booked' }],
    });
  });

  it('a note covering the day beats a rule’s closure or buyout: a one-day opening or party note opens a day a standing rule would close', () => {
    const closedMondays = rule();
    const opening = note({ kind: 'opening', effect: 'unknown', expectedGuests: null });
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [opening], [closedMondays])).toEqual({
      status: 'open', low: 80, mid: 100, high: 120, noteGuests: 0,
      notes: [{ note: opening, outcome: 'not_counted' }], rules: [{ rule: closedMondays, outcome: 'overridden' }],
    });
    // A party note opens it with the model's figures and its guests; more or fewer guests say it is open too.
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [party(70)], [closedMondays])).toMatchObject({
      status: 'open', low: 150, mid: 170, high: 190, noteGuests: 70, notes: [{ outcome: 'added' }], rules: [{ outcome: 'overridden' }],
    });
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [note({ kind: 'other', effect: 'fewer_guests', expectedGuests: null })], [closedMondays]))
      .toMatchObject({ status: 'open', mid: 100, rules: [{ outcome: 'overridden' }] });
    // A rule's buyout gives way too, and a rule's party still counts on the day the note opened.
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [opening], [rule({ kind: 'private_event', effect: 'closed', expectedGuests: 60 }), ruleParty(40)]))
      .toMatchObject({ status: 'open', mid: 140, noteGuests: 40, rules: [{ outcome: 'added' }, { outcome: 'overridden' }] });
    // A note's buyout or closure decides the day over the rule's closure.
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [party(70), buyout(50)], [closedMondays])).toMatchObject({
      status: 'booked', low: null, noteGuests: 50, notes: [{ outcome: 'booked' }, { outcome: 'day_booked' }], rules: [{ outcome: 'overridden' }],
    });
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [closure()], [rule({ kind: 'private_event', effect: 'closed' })])).toMatchObject({
      status: 'closed', notes: [{ outcome: 'closed' }], rules: [{ outcome: 'overridden' }],
    });
    // A day the model itself closed stays closed under an opening with no guest count, as without the rule.
    expect(adjustDay(DAY, TODAY, CLOSED, [{ kind: 'closure' }], [opening], [closedMondays])).toMatchObject({
      status: 'closed', notes: [{ outcome: 'not_counted' }], rules: [{ outcome: 'overridden' }],
    });
  });

  it('a rule with no guest count, fewer guests, an opening or other changes no number and says why; a run booking and a past day too', () => {
    const quiet = adjustDay(DAY, TODAY, OPEN, WEEKDAY, [], [
      ruleParty(null), rule({ kind: 'other', effect: 'fewer_guests' }), rule({ kind: 'opening', effect: 'more_guests', expectedGuests: 30 }),
    ]);
    expect(quiet).toMatchObject({ status: 'open', low: 80, mid: 100, high: 120, noteGuests: 0 });
    expect(quiet.rules.map((entry) => entry.outcome)).toEqual(['no_guest_count', 'not_counted', 'not_counted']);
    expect(adjustDay(DAY, TODAY, OPEN, [{ kind: 'booking' }], [], [ruleParty(40)])).toMatchObject({ noteGuests: 0, rules: [{ outcome: 'already_in_forecast' }] });
    const past = adjustDay('2026-05-31', TODAY, OPEN, WEEKDAY, [party(70)], [rule(), ruleParty(40)]);
    expect(past).toMatchObject({ status: 'open', low: 80, mid: 100, high: 120, noteGuests: 0 });
    expect(past.rules.map((entry) => entry.outcome)).toEqual(['past_day', 'past_day']);
  });

  it('orderedReasons: rules first in each group, then notes; rules never count toward the six note reasons', () => {
    const RUN = ['run:weekday', 'run:term'];
    const words = (entry: AdjustedNote | AdjustedRule) => ('note' in entry
      ? `${entry.outcome}:${String(entry.note.expectedGuests)}`
      : `rule ${entry.outcome}:${String(entry.rule.schedule.expectedGuests)}`);
    const day = adjustDay(DAY, TODAY, OPEN, WEEKDAY, [
      ...[1, 2, 3, 4, 5, 6, 7].map((guests) => party(guests)), note({ kind: 'opening', expectedGuests: 5 }),
    ], [rule({ kind: 'other', effect: 'fewer_guests' }), ruleParty(40)]);
    expect(day.noteGuests).toBe(68);
    expect(orderedReasons(day, RUN, words)).toEqual({
      reasons: [
        'rule added:40', 'added:1', 'added:2', 'added:3', 'added:4', 'added:5', 'added:6', 'run:weekday', 'run:term', 'rule not_counted:null',
      ],
      moreNotes: 2, moreRules: 0,
    });
  });

  it('orderedReasons: at most 6 rule reasons, the ones that changed the day first; moreRules counts the others, whose guests still count', () => {
    expect(MAX_RULE_REASONS).toBe(6);
    const words = (entry: AdjustedNote | AdjustedRule) => ('note' in entry ? `note ${entry.outcome}` : `rule ${entry.outcome}:${String(entry.rule.schedule.expectedGuests)}`);
    const quiet = () => rule({ kind: 'other', effect: 'fewer_guests' });
    const day = adjustDay(DAY, TODAY, OPEN, WEEKDAY, [party(70)], [quiet(), quiet(), ...[1, 2, 3, 4, 5, 6, 7].map((guests) => ruleParty(guests)), quiet()]);
    expect(day.noteGuests).toBe(98);
    expect(orderedReasons(day, ['run:weekday'], words)).toEqual({
      reasons: ['rule added:1', 'rule added:2', 'rule added:3', 'rule added:4', 'rule added:5', 'rule added:6', 'note added', 'run:weekday'],
      moreNotes: 0, moreRules: 4,
    });
    const few = adjustDay(DAY, TODAY, OPEN, WEEKDAY, [], [quiet(), ruleParty(40), quiet()]);
    expect(orderedReasons(few, ['run:weekday'], words)).toEqual({
      reasons: ['rule added:40', 'run:weekday', 'rule not_counted:null', 'rule not_counted:null'], moreNotes: 0, moreRules: 0,
    });
  });
});

describe('flagsAfterData (D49 as amended)', () => {
  it('is the one way a note reaches a run after its data ends: a private event the read does not apply itself', () => {
    // The lab input's privateEvent flag on a day after dataThrough (lab/input.ts): a private event with no count, or fewer guests.
    expect(flagsAfterData(party(null))).toBe(true);
    expect(flagsAfterData(note({ effect: 'fewer_guests', expectedGuests: null }))).toBe(true);
    // The read applies a counted party and a buyout itself, from today on; a closure and any other kind set no flag there.
    expect([flagsAfterData(party(70)), flagsAfterData(buyout(40)), flagsAfterData(closure())]).toEqual([false, false, false]);
    expect(flagsAfterData(note({ kind: 'opening', effect: 'more_guests', expectedGuests: null }))).toBe(false);
  });
});
