// A note's reason on a forecast day (spec 14.5), without Docker: its words are made in code from the note's kind, guest
// count and hours, never from its detail, and carry the note's id, guests and outcome; a run's reasons carry no note.
// Synthetic notes.
import { describe, expect, it } from 'vitest';

import { clockWords, noteReasonView, reasonViews, ruleReasonView, townCalendarOf } from '../src/forecasts/reasons.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';
import type { NoteContent, NoteRecord } from '../src/stores/notes.ts';

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
      kind: 'note', label: 'Your private event, 70 guests, 6 pm to 9 pm', effectPct: null, sources: [],
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
    expect(weekday).toEqual({ kind: 'weekday', label: 'Saturday', effectPct: null, sources: [], note: null, rule: null });
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
      kind: 'rule', label: 'Your rule: closed on Mondays', effectPct: null, sources: [], note: null,
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
