// The deterministic follow-up's decision (src/calendar/follow-up.ts followUpsFor, openspec change
// calendar-event-suggestions, design decisions 3 and 12): a note linked to an owner-calendar event gets a `move` when
// the event moved and the note is still on its event, a `remove` when the event went and every guard holds, and
// otherwise its open follow-up, if any, expires. Pure: no store, no clock. Every date and title here is made up.
import { describe, expect, it } from 'vitest';

import { followUpsFor, type FollowGuards } from '../src/calendar/follow-up.ts';
import type { NoteDates, NoteRecord } from '../src/stores/notes.ts';
import type { StoredEvent } from '../src/stores/owner-calendars.ts';

const TODAY = '2026-11-17';
const CALENDAR = 'c'.repeat(24);
const UID = 'party-0001@bookings.example.test';
const EDITED = new Date('2026-11-10T15:00:00.000Z');
const GUARDS: FollowGuards = { today: TODAY, eventCount: 12, keptKeys: 8, hadKeys: 9 };

const DEC_5: NoteDates = { startDate: '2026-12-05', endDate: '2026-12-05', startTime: '18:00', endTime: '22:00' };
const DEC_12: NoteDates = { startDate: '2026-12-12', endDate: '2026-12-12', startTime: '18:00', endTime: '22:00' };

/** A private-event note on `dates`, linked to the event when it was on `link` (null for an unlinked note). */
function note(id: string, dates: NoteDates, link: NoteDates | null = dates): NoteRecord {
  return {
    id, kind: 'private_event', ...dates, weekdays: null, effect: 'closed', expectedGuests: 40, detail: 'Buyout upstairs',
    createdBy: 'user-0001', byStaff: false, source: null,
    fromEvent: link === null ? null : { calendarId: CALENDAR, uid: UID, ...link, linkedAt: new Date('2026-11-01T12:00:00.000Z') },
    createdAt: new Date('2026-11-01T12:00:00.000Z'), updatedAt: EDITED,
  };
}

function event(dates: NoteDates, uid = UID): StoredEvent {
  return { uid, title: 'Sentinel Pemberton party', ...dates, keyed: true };
}

describe('followUpsFor', () => {
  it('moved: proposes the note on the event’s new dates and hours, kind, guests and detail as they are', () => {
    expect(followUpsFor([note('n1', DEC_5)], [event(DEC_12)], GUARDS)).toEqual({
      follows: [{
        type: 'move',
        note: { kind: 'private_event', ...DEC_12, weekdays: null, effect: 'closed', expectedGuests: 40, detail: 'Buyout upstairs' },
        follow: { noteId: 'n1', calendarId: CALENDAR, change: 'moved', from: DEC_5, to: DEC_12, noteUpdatedAt: EDITED },
      }],
      expire: [],
    });
    // Hours alone count as a move.
    const later = { ...DEC_5, startTime: '19:00', endTime: '23:00' };
    expect(followUpsFor([note('n1', DEC_5)], [event(later)], GUARDS).follows.map((each) => each.note)).toEqual([
      expect.objectContaining(later),
    ]);
  });

  it('moved, with the note edited off its link’s dates or hours: nothing, and its open follow-up expires', () => {
    for (const edited of [{ ...DEC_5, startDate: '2026-12-06', endDate: '2026-12-06' }, { ...DEC_5, startTime: null, endTime: null }]) {
      expect(followUpsFor([note('n1', edited, DEC_5)], [event(DEC_12)], GUARDS)).toEqual({ follows: [], expire: ['n1'] });
    }
  });

  it('moved into the past, to today, or to dates Section 12 refuses: nothing', () => {
    for (const to of [
      { ...DEC_5, startDate: '2026-11-10', endDate: '2026-11-10' },
      { ...DEC_5, startDate: TODAY, endDate: TODAY },
      // 367 days, longer than a note may run.
      { ...DEC_5, startDate: '2026-12-12', endDate: '2027-12-14', startTime: null, endTime: null },
    ]) {
      expect(followUpsFor([note('n1', DEC_5)], [event(to)], GUARDS)).toEqual({ follows: [], expire: ['n1'] });
    }
  });

  it('back at the link’s dates and hours: nothing to suggest, so its open follow-up expires', () => {
    expect(followUpsFor([note('n1', DEC_5)], [event(DEC_5)], GUARDS)).toEqual({ follows: [], expire: ['n1'] });
  });

  it('gone: proposes deleting the note as it is', () => {
    const linked = note('n1', DEC_5);
    expect(followUpsFor([linked], [event(DEC_12, 'another@bookings.example.test')], GUARDS)).toEqual({
      follows: [{
        type: 'remove',
        note: { kind: 'private_event', ...DEC_5, weekdays: null, effect: 'closed', expectedGuests: 40, detail: 'Buyout upstairs' },
        follow: { noteId: 'n1', calendarId: CALENDAR, change: 'gone', from: DEC_5, to: null, noteUpdatedAt: EDITED },
      }],
      expire: [],
    });
    // A refresh with no key before it to keep (a calendar that had only UID-less events) still suggests it.
    expect(followUpsFor([linked], [], { ...GUARDS, keptKeys: 0, hadKeys: 0 }).follows).toHaveLength(1);
  });

  it('gone on a full calendar, after a key rewrite, for a past event or a note under way, or edited off: nothing', () => {
    const cases: [NoteRecord, FollowGuards][] = [
      // 2,000 events: the cut may have dropped it.
      [note('n1', DEC_5), { ...GUARDS, eventCount: 2_000 }],
      // The refresh kept none of the keys the calendar had: the feed rewrote them.
      [note('n1', DEC_5), { ...GUARDS, keptKeys: 0, hadKeys: 9 }],
      // The event ended before today.
      [note('n1', { ...DEC_5, startDate: '2026-11-14', endDate: '2026-11-15' }), GUARDS],
      // The note starts today (its event runs on to Dec 5).
      [note('n1', { ...DEC_5, startDate: TODAY, startTime: null, endTime: null }), GUARDS],
      // The note was edited off its event.
      [note('n1', DEC_12, DEC_5), GUARDS],
    ];
    for (const [linked, guards] of cases) expect(followUpsFor([linked], [], guards)).toEqual({ follows: [], expire: ['n1'] });
  });

  it('hours past midnight: a note made from a late night has no hours, and still follows its event', () => {
    const lateNight = { startDate: '2026-12-05', endDate: '2026-12-05', startTime: '22:00', endTime: '02:00' };
    const allDay = { ...lateNight, startTime: null, endTime: null };
    // Make a note leaves a late night's hours out (its end is before its start), so the note is all day on its date.
    const [moved] = followUpsFor([note('n1', allDay, lateNight)], [event({ ...lateNight, startDate: '2026-12-12', endDate: '2026-12-12' })], GUARDS).follows;
    expect(moved).toMatchObject({
      type: 'move', note: { startDate: '2026-12-12', endDate: '2026-12-12', startTime: null, endTime: null },
      follow: { from: lateNight, to: { ...lateNight, startDate: '2026-12-12', endDate: '2026-12-12' } },
    });
    // A late night that becomes an evening: the note takes its hours.
    const [evening] = followUpsFor([note('n1', allDay, lateNight)], [event({ ...lateNight, startTime: '19:00', endTime: '23:00' })], GUARDS).follows;
    expect(evening?.note).toMatchObject({ startDate: '2026-12-05', startTime: '19:00', endTime: '23:00' });
    // The same late night is not a move.
    expect(followUpsFor([note('n1', allDay, lateNight)], [event(lateNight)], GUARDS)).toEqual({ follows: [], expire: ['n1'] });
  });

  it('leaves unlinked notes out, and decides each linked note on its own', () => {
    const lunch = { ...DEC_5, startTime: '12:00', endTime: '14:00' };
    const other: NoteRecord = { ...note('n2', lunch), fromEvent: { calendarId: CALENDAR, uid: 'lunch@bookings.example.test', ...lunch, linkedAt: EDITED } };
    const decided = followUpsFor([note('n0', DEC_5, null), note('n1', DEC_5), other], [event(DEC_12), event(lunch, 'lunch@bookings.example.test')], GUARDS);
    expect(decided.follows.map((each) => [each.type, each.follow.noteId])).toEqual([['move', 'n1']]);
    expect(decided.expire).toEqual(['n2']);
  });
});
