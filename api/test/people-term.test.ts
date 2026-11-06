// The term state (spec 13.2) from the town calendar's term entries: classes, finals, summer session, between terms
// only when both ends are known, and unknown everywhere else. Hanover's seeded calendar, plus synthetic entries.
import { describe, expect, it } from 'vitest';

import { BETWEEN_TERMS_LABEL, termEntries, termStateOn } from '../src/people-in-town/term.ts';
import { townCalendarCovers, townEvents, type TownEvent } from '../src/town-calendar.ts';

const covers = townCalendarCovers('hanover-nh');
if (covers === null) throw new Error('Hanover has a researched calendar');
const hanover = termEntries(townEvents('hanover-nh', covers));

function term(group: string, title: string, start: string, end: string): TownEvent {
  return {
    id: `test:${start}`, title, start, end, kind: 'term', scope: 'town', group, groupLabel: title, confidence: 'high',
    sources: [{ label: 'Example registrar', url: 'https://registrar.example.test/' }],
  };
}

describe('termEntries', () => {
  it('keeps only term entries whose group follows the convention, sorted by start', () => {
    const entries = termEntries([
      term('x-town:finals:fall', 'Fall finals', '2026-11-20', '2026-11-25'),
      term('x-town:classes:fall', 'Fall classes', '2026-09-14', '2026-11-17'),
      { ...term('x-town:recess:fall', 'Recess', '2026-10-01', '2026-10-02') },
      { ...term('x-town:classes:fall', 'Not a term', '2026-10-05', '2026-10-05'), kind: 'event' },
    ]);
    expect(entries.map((entry) => [entry.part, entry.season, entry.start])).toEqual([
      ['classes', 'fall', '2026-09-14'], ['finals', 'fall', '2026-11-20'],
    ]);
  });

  it('finds every Hanover term entry in the seeded calendar', () => {
    // 16 from the CSV seed, then winter and spring 2027 classes and finals from the registrar.
    expect(hanover).toHaveLength(20);
  });
});

describe('termStateOn, Hanover', () => {
  it('reads fall classes, fall finals and summer classes from the entries, with their labels and sources', () => {
    expect(termStateOn('2026-10-15', hanover)).toMatchObject({ state: 'in_session', label: 'Fall term classes' });
    expect(termStateOn('2026-11-17', hanover)).toMatchObject({ state: 'in_session', label: 'Fall term classes' });
    expect(termStateOn('2026-11-20', hanover)).toMatchObject({ state: 'finals', label: 'Fall term finals' });
    expect(termStateOn('2026-07-15', hanover)).toMatchObject({ state: 'summer_session', label: 'Summer term classes' });
    expect(termStateOn('2026-10-15', hanover).events.map((event) => event.id)).toEqual(['hanover-nh:2026-09-14:fall-term-classes']);
  });

  it('derives between terms only between a finals entry and the next classes entry, citing both', () => {
    const spring = termStateOn('2026-03-20', hanover);
    expect(spring).toMatchObject({ state: 'between_terms', label: BETWEEN_TERMS_LABEL });
    expect(spring.events.map((event) => event.group)).toEqual(['hanover-nh:finals:winter', 'hanover-nh:classes:spring']);
    expect(termStateOn('2026-09-05', hanover).state).toBe('between_terms');
    // The winter break: fall 2026 finals end 11-25, winter 2027 classes start 01-05 (registrar 2026-27).
    const winter = termStateOn('2026-12-10', hanover);
    expect(winter).toMatchObject({ state: 'between_terms', label: BETWEEN_TERMS_LABEL });
    expect(winter.events.map((event) => event.group)).toEqual(['hanover-nh:finals:fall', 'hanover-nh:classes:winter']);
  });

  it('is unknown between classes and finals, before the first entry, and after the last finals with no next classes', () => {
    expect(termStateOn('2026-11-18', hanover).state).toBe('unknown');
    expect(termStateOn('2024-12-15', hanover).state).toBe('unknown');
    // The calendar has no summer 2027 classes entry yet, so the days after spring 2027 finals are not derived.
    expect(termStateOn('2027-06-20', hanover)).toEqual({ state: 'unknown', label: null, events: [] });
  });
});

describe('termStateOn, a town without term entries', () => {
  it('is always unknown', () => {
    expect(termStateOn('2026-10-15', termEntries(townEvents('nantucket-ma', { from: '2026-01-01', to: '2026-12-31' }))).state).toBe('unknown');
    expect(termStateOn('2026-10-15', []).state).toBe('unknown');
  });
});
