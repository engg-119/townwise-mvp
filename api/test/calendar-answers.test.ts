// D59 slice 5 (openspec change auto-apply-agent-reads design decision 16): which open closure suggestions a location's
// closed calendar events answer (src/calendar/answers.ts planAnswers): a dated closure rule or closure note every day of
// which is covered, a standing closed weekday whose next 8 days of each weekday from tomorrow are covered, never a season,
// a booking, more or fewer guests or a D53 kind, and none a person's note or rule decides differently. Every event and
// title is made up; today is Mon, Jun 1, 2026.
import { describe, expect, it } from 'vitest';

import {
  answerablesOf, answerNoteId, closedAlready, daysToCover, isAnswerChange, planAnswers, UPCOMING_WEEKDAYS, type Answerable,
} from '../src/calendar/answers.ts';
import type { CalendarEvent } from '../src/calendar/closed-events.ts';
import type { PersonsEntries } from '../src/agent/apply.ts';
import type { SuggestionRecord } from '../src/stores/agent-suggestions.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';
import type { NoteContent, NoteRecord } from '../src/stores/notes.ts';

const TODAY = '2026-06-01';
const CAL = 'a'.repeat(24);
const NONE: PersonsEntries = { notes: [], rules: [] };

function closed(uid: string, startDate: string, endDate = startDate): CalendarEvent {
  return { calendarId: CAL, uid, title: 'Closed', startDate, endDate, startTime: null, endTime: null, keyed: true };
}

function schedule(over: Partial<RuleSchedule>): RuleSchedule {
  return {
    kind: 'closure', startDate: '2026-12-24', endDate: '2026-12-26', weekdays: null, effect: 'closed', expectedGuests: null,
    startTime: null, endTime: null, ...over,
  };
}

function note(over: Partial<NoteContent>): NoteContent {
  return {
    kind: 'closure', startDate: '2026-12-24', endDate: '2026-12-26', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
    title: null, startTime: null, endTime: null, ...over,
  };
}

const rule = (id: string, over: Partial<RuleSchedule> = {}): Answerable => ({ ref: { kind: 'stored', id }, content: { type: 'rule', text: 'Closed', schedule: schedule(over) } });
const noteItem = (id: string, over: Partial<NoteContent> = {}): Answerable => ({ ref: { kind: 'stored', id }, content: { type: 'note', note: note(over) } });

/** The ids planAnswers answered. */
function answered(items: readonly Answerable[], events: readonly CalendarEvent[], persons: PersonsEntries = NONE): string[] {
  return planAnswers({ items, closed: events, persons, today: TODAY }).answers.map((each) => (each.ref.kind === 'stored' ? each.ref.id : `sales_${String(each.ref.weekday)}`));
}

describe('daysToCover', () => {
  it('is every day a dated closure closes, its weekdays only', () => {
    expect(daysToCover({ type: 'rule', text: 'x', schedule: schedule({}) }, TODAY)).toEqual(['2026-12-24', '2026-12-25', '2026-12-26']);
    // Dec 21 to Jan 3, Mondays only.
    expect(daysToCover({ type: 'rule', text: 'x', schedule: schedule({ startDate: '2026-12-21', endDate: '2027-01-03', weekdays: [1] }) }, TODAY))
      .toEqual(['2026-12-21', '2026-12-28']);
    expect(daysToCover({ type: 'note', note: note({}) }, TODAY)).toEqual(['2026-12-24', '2026-12-25', '2026-12-26']);
  });

  it('is the next 8 days of each weekday of a standing closure, from tomorrow or its start, the later', () => {
    const mondays = daysToCover({ type: 'rule', text: 'x', schedule: schedule({ startDate: '2026-01-05', endDate: null, weekdays: [1] }) }, TODAY);
    expect(UPCOMING_WEEKDAYS).toBe(8);
    expect(mondays).toEqual(['2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']);
    const later = daysToCover({ type: 'rule', text: 'x', schedule: schedule({ startDate: '2026-07-01', endDate: null, weekdays: [1, 2] }) }, TODAY);
    expect(later?.length).toBe(16);
    expect(later?.[0]).toBe('2026-07-06');
  });

  it('is null for what a calendar never answers', () => {
    const never = [
      { type: 'rule', text: 'x', schedule: schedule({ endDate: null, startDate: '2026-01-01', season: { repeat: 'yearly', from: '12-24', to: '12-26' } }) },
      { type: 'rule', text: 'x', schedule: schedule({ endDate: null, weekdays: null }) },
      { type: 'rule', text: 'x', schedule: schedule({ kind: 'private_event', effect: 'closed' }) },
      { type: 'rule', text: 'x', schedule: schedule({ kind: 'other', effect: 'fewer_guests' }) },
      { type: 'note', note: note({ kind: 'private_event', effect: 'closed' }) },
      { type: 'note', note: note({ kind: 'private_event', effect: 'more_guests' }) },
      { type: 'note', note: note({ kind: 'other', effect: 'unknown', detail: 'Inventory' }) },
    ] as const;
    for (const content of never) expect({ content, days: daysToCover(content, TODAY) }).toEqual({ content, days: null });
  });
});

describe('planAnswers', () => {
  it('answers a dated closure every day of which is covered, by the events covering it', () => {
    const events = [closed('holidays', '2026-12-23', '2026-12-25'), closed('boxing', '2026-12-26')];
    const plan = planAnswers({ items: [rule('r1')], closed: events, persons: NONE, today: TODAY });
    expect(plan.answers).toHaveLength(1);
    expect(plan.answers[0]?.events.map((each) => each.uid)).toEqual(['holidays', 'boxing']);
    expect(plan.answers[0]?.rule).toBeNull();
    expect(answered([rule('r1')], [closed('holidays', '2026-12-23', '2026-12-25')])).toEqual([]);
  });

  it('answers a closure note suggestion as a rule is', () => {
    expect(answered([noteItem('n1')], [closed('e', '2026-12-24', '2026-12-26')])).toEqual(['n1']);
    expect(answered([noteItem('n2', { kind: 'private_event', effect: 'closed' })], [closed('e', '2026-12-24', '2026-12-26')])).toEqual([]);
  });

  it('answers a standing weekday with its own rule when its next 8 days are covered', () => {
    const mondays = ['2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27'];
    const events = mondays.map((day, i) => closed(`mon-${String(i)}`, day));
    const standing: Answerable = {
      ref: { kind: 'sales', weekday: 1, evidence: { noSalesCount: 9, weekdayCount: 10, lastSalesDate: null } },
      content: { type: 'rule', text: 'Closed on Mondays', schedule: schedule({ startDate: '2026-01-05', endDate: null, weekdays: [1] }) },
    };
    const plan = planAnswers({ items: [standing], closed: events, persons: NONE, today: TODAY });
    expect(plan.answers.map((each) => each.rule?.text)).toEqual(['Closed on Mondays']);
    // The covering events too: the first names the calendar the rule is from.
    expect(plan.answers[0]?.events.map((each) => each.uid)).toEqual(events.map((each) => each.uid));
    expect(answered([standing], events.slice(0, 7))).toEqual([]);
  });

  it('holds one a person’s note or rule decides differently, and counts it', () => {
    const party = {
      ...note({ kind: 'private_event', effect: 'more_guests', startDate: '2026-12-24', endDate: '2026-12-24' }),
      id: 'p', locationId: 'l', createdBy: 'person', byStaff: false, createdAt: new Date(), updatedAt: new Date(), source: null, agent: null,
      fromEvent: null,
    } as unknown as NoteRecord;
    const events = [closed('e', '2026-12-24', '2026-12-26')];
    const plan = planAnswers({ items: [rule('r1')], closed: events, persons: { notes: [party], rules: [] }, today: TODAY });
    expect(plan.answers).toEqual([]);
    expect(plan.held).toBe(1);
    const open = schedule({ kind: 'opening', effect: 'unknown', startDate: '2026-12-26', endDate: '2026-12-26' });
    expect(answered([rule('r1')], events, { notes: [], rules: [open] })).toEqual([]);
  });

  it('turns stored suggestions and the sales history’s into answerables, leaving out the kinds a calendar never answers', () => {
    const base = { id: 's', locationId: 'l', week: '2026-06-01', firstDate: '2026-12-24', why: null, calendarIds: [], status: 'open', createdAt: new Date(), updatedAt: new Date(), source: 'file', fileId: null, evidence: null, closureKey: null };
    const records = [
      { ...base, id: 'rule', type: 'rule', text: 'Closed', schedule: schedule({}) },
      { ...base, id: 'note', type: 'note', note: note({}) },
      { ...base, id: 'event', type: 'event', note: note({}), event: { calendarId: CAL, uid: 'u', startDate: '2026-12-24', endDate: '2026-12-24', startTime: null, endTime: null } },
    ] as unknown as SuggestionRecord[];
    const sales = [{ weekday: 1, schedule: schedule({ startDate: '2026-01-05', endDate: null, weekdays: [1] }), evidence: { noSalesCount: 9, weekdayCount: 10, lastSalesDate: null } }];
    expect(answerablesOf(records, sales).map((each) => (each.ref.kind === 'stored' ? each.ref.id : `sales_${String(each.ref.weekday)}`)))
      .toEqual(['rule', 'note', 'sales_1']);
  });

  it('plans one note id per event, the same on every run', () => {
    expect(answerNoteId(CAL, 'holidays')).toMatch(/^[0-9a-f]{24}$/);
    expect(answerNoteId(CAL, 'holidays')).toBe(answerNoteId(CAL, 'holidays'));
    expect(answerNoteId(CAL, 'holidays')).not.toBe(answerNoteId(CAL, 'boxing'));
  });
});

describe('closedAlready', () => {
  const event = closed('e', '2026-12-24', '2026-12-26');

  it('is true only when closure notes close every day of the event', () => {
    expect(closedAlready([note({})], event)).toBe(true);
    expect(closedAlready([note({ endDate: '2026-12-24' }), note({ startDate: '2026-12-25' })], event)).toBe(true);
    // A note over one of its days leaves the rest open in the forecast.
    expect(closedAlready([note({ startDate: '2026-12-24', endDate: '2026-12-24' })], event)).toBe(false);
  });

  it('reads a note on its weekdays, and never a booking’s note', () => {
    // Closed on Mondays all year does not close Thursday, Dec 24.
    expect(closedAlready([note({ startDate: '2026-01-01', endDate: '2026-12-31', weekdays: [1] })], event)).toBe(false);
    expect(closedAlready([note({ kind: 'private_event', effect: 'closed' })], event)).toBe(false);
    expect(closedAlready([note({ kind: 'private_event', effect: 'more_guests' })], event)).toBe(false);
  });
});

describe('isAnswerChange', () => {
  it('is a closure note from a calendar, never the sort’s booking notes or labels', () => {
    expect(isAnswerChange({ sourceKind: 'calendar', action: 'note.add', noteKind: 'closure' })).toBe(true);
    expect(isAnswerChange({ sourceKind: 'calendar', action: 'note.add', noteKind: 'private_event' })).toBe(false);
    expect(isAnswerChange({ sourceKind: 'calendar', action: 'booking.label', noteKind: null })).toBe(false);
    expect(isAnswerChange({ sourceKind: 'file', action: 'note.add', noteKind: 'closure' })).toBe(false);
  });
});
