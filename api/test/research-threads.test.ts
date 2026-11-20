// The research threads (D66 design decision 3, task 1.1): six town threads, the location's two plus town_overview for a
// town outside the twelve, both location threads whatever Google's names may do, the search limits and the window.
import { describe, expect, it } from 'vitest';

import {
  LOCATION_MAX_SEARCHES, MAX_FETCHES, RESEARCH_WINDOW_DAYS, TOWN_MAX_SEARCHES, researchWindow, threadDef, threadsFor,
} from '../src/research/threads.ts';

describe('threadsFor', () => {
  it('gives a town its six shared threads, 8 searches each, naming no restaurant', () => {
    const threads = threadsFor({ kind: 'town', townId: 'hanover-nh' }, { placesToAi: false });
    expect(threads.map((thread) => thread.id)).toEqual(['schools', 'sports', 'arts_festivals', 'civic', 'tourism_seasonal', 'markets_community']);
    for (const thread of threads) {
      expect(thread).toMatchObject({ subject: 'town', maxSearches: 8, namesRestaurant: false, origin: null });
      expect(thread.focus.length).toBeGreaterThan(20);
    }
    expect(TOWN_MAX_SEARCHES).toBe(8);
  });

  it.each([true, false])('gives a location of the twelve neighborhood and competitors with placesToAi %s', (placesToAi) => {
    const threads = threadsFor({ kind: 'location', townId: 'hanover-nh' }, { placesToAi });
    expect(threads.map((thread) => [thread.id, thread.origin, thread.namesRestaurant, thread.maxSearches])).toEqual([
      ['neighborhood', 'neighborhood', true, 5],
      ['competitors', 'competitor', true, 5],
    ]);
    expect(LOCATION_MAX_SEARCHES).toBe(5);
  });

  it('adds town_overview, a location thread naming no restaurant, for a town outside the twelve', () => {
    const threads = threadsFor({ kind: 'location', townId: null }, { placesToAi: false });
    expect(threads.map((thread) => thread.id)).toEqual(['neighborhood', 'competitors', 'town_overview']);
    expect(threads[2]).toMatchObject({ subject: 'location', origin: 'town_overview', namesRestaurant: false, maxSearches: 5 });
  });

  it('searches the web for competitors when Google names may not go to Anthropic, and the listed ones when they may', () => {
    const off = threadDef('competitors', { placesToAi: false }).focus;
    const on = threadDef('competitors', { placesToAi: true }).focus;
    expect(off).toMatch(/in town/);
    expect(off).toMatch(/Name each business/);
    expect(on).toMatch(/listed in the request/);
    // The restaurant's own events are never a competitor's (UI review).
    for (const focus of [off, on]) expect(focus).toMatch(/Leave out the restaurant named in the request/);
  });

  it('looks a thread up by id as threadsFor defines it', () => {
    for (const subject of [{ kind: 'town', townId: 'stowe-vt' }, { kind: 'location', townId: null }] as const) {
      for (const thread of threadsFor(subject, { placesToAi: true })) expect(threadDef(thread.id, { placesToAi: true })).toEqual(thread);
    }
  });

  it('allows 2 page fetches a thread', () => {
    expect(MAX_FETCHES).toBe(2);
  });
});

describe('researchWindow', () => {
  it('runs 180 days from today in the town\'s time zone', () => {
    expect(RESEARCH_WINDOW_DAYS).toBe(180);
    // 02:30 UTC on Nov 20 is still Nov 19 in Hanover.
    expect(researchWindow(new Date('2026-11-20T02:30:00Z'), 'America/New_York')).toEqual({ from: '2026-11-19', to: '2027-05-18' });
    expect(researchWindow(new Date('2026-11-20T12:00:00Z'), 'America/New_York')).toEqual({ from: '2026-11-20', to: '2027-05-19' });
  });
});
