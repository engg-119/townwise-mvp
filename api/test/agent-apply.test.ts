// D59: the one writer's pure parts (agent/apply.ts): a change's dedupe key (the same note from two sources is one key,
// whatever the title's case and spacing or the weekdays' order) and the conflict check against a person's notes and
// rules (a note TownwiseAI saved and nobody edited never blocks; a person's note or rule that decides a day differently
// does). Synthetic notes only.
import { describe, expect, it } from 'vitest';

import { conflictsWith, dedupeKeyOf } from '../src/agent/apply.ts';
import type { RuleSchedule } from '../src/stores/business-rules.ts';
import type { NoteContent, NoteRecord } from '../src/stores/notes.ts';

function content(over: Partial<NoteContent> = {}): NoteContent {
  return {
    kind: 'private_event', startDate: '2026-06-13', endDate: '2026-06-13', weekdays: null, effect: 'closed', expectedGuests: 60,
    detail: null, title: 'Rehearsal dinner', startTime: null, endTime: null, ...over,
  };
}

const AT = new Date('2026-06-01T12:00:00.000Z');

function record(over: Partial<NoteRecord> = {}): NoteRecord {
  return {
    ...content(), id: 'n1', createdBy: 'person', byStaff: false, source: null, fromEvent: null, agent: null, createdAt: AT, updatedAt: AT, ...over,
  };
}

function rule(over: Partial<RuleSchedule> = {}): RuleSchedule {
  return {
    kind: 'closure', startDate: '2026-01-01', endDate: null, weekdays: [1], effect: 'closed', expectedGuests: null, startTime: null, endTime: null,
    ...over,
  };
}

describe('dedupeKeyOf', () => {
  it('is one key for the same note whatever the title’s case and spacing, and the weekdays’ order', () => {
    const a = dedupeKeyOf({ action: 'note.add', note: content({ title: 'Rehearsal  Dinner', weekdays: [6, 5] }) });
    const b = dedupeKeyOf({ action: 'note.add', note: content({ title: ' rehearsal dinner ', weekdays: [5, 6] }) });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs by kind, dates, weekdays, effect and title, never by detail, guests or hours', () => {
    const base = dedupeKeyOf({ action: 'note.add', note: content() });
    const changes: Partial<NoteContent>[] = [
      { kind: 'closure' }, { startDate: '2026-06-12' }, { endDate: '2026-06-14' }, { weekdays: [6] }, { effect: 'more_guests' },
      { title: 'Another dinner' }, { title: null },
    ];
    for (const over of changes) expect(dedupeKeyOf({ action: 'note.add', note: content(over) })).not.toBe(base);
    for (const over of [{ detail: 'Back room' }, { expectedGuests: 80 }, { startTime: '18:00', endTime: '22:00' }]) {
      expect(dedupeKeyOf({ action: 'note.add', note: content(over) })).toBe(base);
    }
  });

  it('keys an item or days by the action and the caller’s key, so one file adds one summary', () => {
    expect(dedupeKeyOf({ action: 'item.add', key: 'file:abc' })).toBe(dedupeKeyOf({ action: 'item.add', key: 'file:abc' }));
    expect(dedupeKeyOf({ action: 'item.add', key: 'file:abc' })).not.toBe(dedupeKeyOf({ action: 'sales_days.add', key: 'file:abc' }));
    expect(dedupeKeyOf({ action: 'item.add', key: 'file:abc' })).not.toBe(dedupeKeyOf({ action: 'item.add', key: 'file:abd' }));
  });
});

describe('conflictsWith', () => {
  const closure = content({ kind: 'closure', effect: 'closed', expectedGuests: null, title: 'Closed for a private wedding' });

  it('a person’s note that decides the day differently conflicts: a party under a closure, a closure under a buyout', () => {
    const party = record({ kind: 'private_event', effect: 'more_guests', expectedGuests: 40 });
    expect(conflictsWith(closure, { notes: [party], rules: [] })).toBe(true);
    expect(conflictsWith(content(), { notes: [record({ kind: 'closure', effect: 'closed' })], rules: [] })).toBe(true);
  });

  it('a person’s note that decides the day the same way, or decides nothing, does not', () => {
    expect(conflictsWith(closure, { notes: [record({ kind: 'closure', effect: 'closed' })], rules: [] })).toBe(false);
    expect(conflictsWith(closure, { notes: [record({ kind: 'other', effect: 'unknown' })], rules: [] })).toBe(false);
    // A candidate that decides nothing never conflicts.
    expect(conflictsWith(content({ kind: 'other', effect: 'unknown' }), { notes: [record({ kind: 'closure', effect: 'closed' })], rules: [] })).toBe(false);
  });

  it('a note on other days, or on a weekday the candidate skips, does not', () => {
    expect(conflictsWith(closure, { notes: [record({ startDate: '2026-06-14', endDate: '2026-06-14', effect: 'more_guests' })], rules: [] })).toBe(false);
    // 2026-06-13 is a Saturday: a person's note on Sundays only never meets it.
    expect(conflictsWith(closure, {
      notes: [record({ startDate: '2026-06-01', endDate: '2026-06-30', weekdays: [0], kind: 'opening', effect: 'more_guests' })], rules: [],
    })).toBe(false);
  });

  it('a TownwiseAI note nobody edited never blocks; once a person edits it, it is theirs and does', () => {
    const agentNote = record({ kind: 'private_event', effect: 'more_guests', createdBy: 'townwise_ai', agent: { changeId: 'c1', at: AT } });
    expect(conflictsWith(closure, { notes: [agentNote], rules: [] })).toBe(false);
    const edited = { ...agentNote, updatedAt: new Date(AT.getTime() + 60_000) };
    expect(conflictsWith(closure, { notes: [edited], rules: [] })).toBe(true);
    // A note D34 made from a file before D59 counts as TownwiseAI's until edited.
    const fromFile = record({ kind: 'private_event', effect: 'more_guests', source: { via: 'ai_file', fileId: 'f1' } });
    expect(conflictsWith(closure, { notes: [fromFile], rules: [] })).toBe(false);
  });

  it('a note TownwiseAI saved from the person’s own words in chat (slice 4) is theirs from the start, and blocks', () => {
    // The person its author, `agent` set, no file `source`: what propose_note writes for a note stated plainly.
    const stated = record({ kind: 'private_event', effect: 'more_guests', createdBy: 'person', agent: { changeId: 'c1', at: AT } });
    expect(conflictsWith(closure, { notes: [stated], rules: [] })).toBe(true);
    // A read the person pressed writes in their name too, but from a file: TownwiseAI's until edited.
    const pressed = { ...stated, source: { via: 'ai_file' as const, fileId: 'f1' } };
    expect(conflictsWith(closure, { notes: [pressed], rules: [] })).toBe(false);
  });

  it('a person’s rule that closes the day conflicts with an opening, and one saying more guests with a closure', () => {
    // 2026-06-15 is a Monday.
    const opening = content({ kind: 'opening', effect: 'more_guests', startDate: '2026-06-15', endDate: '2026-06-15', expectedGuests: null });
    expect(conflictsWith(opening, { notes: [], rules: [rule()] })).toBe(true);
    const mondayClosure = { ...closure, startDate: '2026-06-15', endDate: '2026-06-15' };
    expect(conflictsWith(mondayClosure, { notes: [], rules: [rule()] })).toBe(false);
    expect(conflictsWith(mondayClosure, { notes: [], rules: [rule({ kind: 'other', effect: 'more_guests' })] })).toBe(true);
  });
});
