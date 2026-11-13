// Notes in the forecast (spec 14.5), without Docker: from the town's today on, a private event with a guest count adds
// its guests to an open day, a buyout books the day, a closure note closes it whatever the model said; on a day the
// model closed, a buyout books it and a private event with a count opens it with only those guests; a party the
// run already counted, a note with no count, an opening, an other note and a past day change no number and say why;
// note reasons come at most six, the ones that changed the day first. Synthetic notes.
import { describe, expect, it } from 'vitest';

import { adjustDay, MAX_NOTE_REASONS, orderedReasons, type ModelDay } from '../src/forecasts/adjust.ts';
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
    expectedGuests: 70, detail: null, startTime: null, endTime: null, createdBy: 'author', byStaff: false,
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
        status: 'open', low: 150, mid: 170, high: 190, noteGuests: 70, notes: [{ note: added, outcome: 'added' }],
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
      status: 'booked', low: null, mid: null, high: null, noteGuests: 50, notes: [{ note: booked, outcome: 'booked' }],
    });
    expect(adjustDay(DAY, TODAY, OPEN, WEEKDAY, [buyout(null)])).toMatchObject({ status: 'booked', noteGuests: 0 });
    expect(adjustDay(DAY, TODAY, BOOKED, [{ kind: 'booking' }], [buyout(40)])).toMatchObject({ status: 'booked', noteGuests: 40 });
  });

  it('a closure closes an open or booked day; closed beats booked beats open', () => {
    for (const model of [OPEN, BOOKED, CLOSED]) {
      const closing = closure();
      expect(adjustDay(DAY, TODAY, model, [], [closing])).toEqual({
        status: 'closed', low: null, mid: null, high: null, noteGuests: 0, notes: [{ note: closing, outcome: 'closed' }],
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
      status: 'booked', low: null, mid: null, high: null, noteGuests: 50, notes: [{ note: booked, outcome: 'booked' }],
    });
    // A party on the same day can't add walk-ins to a booked day.
    expect(adjustDay(DAY, TODAY, CLOSED, [], [booked, party(70)])).toMatchObject({
      status: 'booked', noteGuests: 50, notes: [{ outcome: 'booked' }, { outcome: 'day_booked' }],
    });
  });

  it('on a day the model closed, a private event with a guest count opens it with just those guests', () => {
    const added = party(70);
    expect(adjustDay(DAY, TODAY, CLOSED, [{ kind: 'closure' }], [added])).toEqual({
      status: 'open', low: 70, mid: 70, high: 70, noteGuests: 70, notes: [{ note: added, outcome: 'added' }],
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
      status: 'booked', noteGuests: 50, notes: [{ note: booked, outcome: 'booked' }, { note: added, outcome: 'day_booked' }],
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
    expect(adjustDay(DAY, TODAY, model, WEEKDAY, [])).toEqual({ ...model, noteGuests: 0, notes: [] });
  });
});

describe('orderedReasons', () => {
  const RUN = ['run:weekday', 'run:term'];
  const words = (entry: { note: NoteRecord; outcome: string }) => `${entry.outcome}:${String(entry.note.expectedGuests)}`;

  it('at most 6 note reasons in order added, booked, closed, run reasons, then the rest; moreNotes counts the others; sums count all', () => {
    expect(MAX_NOTE_REASONS).toBe(6);
    const many = adjustDay(DAY, TODAY, OPEN, WEEKDAY, [
      note({ kind: 'opening', expectedGuests: 5 }), ...[1, 2, 3, 4, 5, 6, 7].map((guests) => party(guests)), party(null),
    ]);
    expect(many.noteGuests).toBe(28);
    expect(many.mid).toBe(128);
    expect(orderedReasons(many, RUN, words)).toEqual({
      reasons: ['added:1', 'added:2', 'added:3', 'added:4', 'added:5', 'added:6', 'run:weekday', 'run:term'],
      moreNotes: 3,
    });
    const few = adjustDay(DAY, TODAY, OPEN, WEEKDAY, [
      note({ kind: 'opening', expectedGuests: 5 }), party(10), party(null), note({ kind: 'other', expectedGuests: null, detail: 'x' }),
      party(20), note({ effect: 'unknown', expectedGuests: 9 }), note({ effect: 'fewer_guests', expectedGuests: 8 }),
    ]);
    expect(orderedReasons(few, RUN, words)).toEqual({
      reasons: ['added:10', 'added:20', 'run:weekday', 'run:term', 'not_counted:5', 'no_guest_count:null', 'not_counted:null', 'not_counted:9'],
      moreNotes: 1,
    });
    const closed = adjustDay(DAY, TODAY, OPEN, [], [party(70), closure(), buyout(20)]);
    expect(orderedReasons(closed, RUN, words)).toEqual({ reasons: ['closed:null', 'run:weekday', 'run:term', 'day_closed:70', 'day_closed:20'], moreNotes: 0 });
    expect(orderedReasons(adjustDay(DAY, TODAY, OPEN, WEEKDAY, []), RUN, words)).toEqual({ reasons: RUN, moreNotes: 0 });
  });
});
