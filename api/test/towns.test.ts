import { describe, expect, it } from 'vitest';

import { TOWN_IDS, TOWNS, US_STATE_CODES } from '../src/towns.ts';

// Copied from the spec's Data facts; the client's test asserts the same literal list.
const SPEC_TOWN_IDS = [
  'hanover-nh', 'amherst-ma', 'ithaca-ny', 'burlington-vt', 'middlebury-vt', 'state-college-pa',
  'bar-harbor-me', 'stowe-vt', 'conway-nh', 'north-elba-ny', 'provincetown-ma', 'nantucket-ma',
];

describe('towns', () => {
  it('holds exactly the twelve researched town ids, in order', () => {
    expect([...TOWN_IDS]).toEqual(SPEC_TOWN_IDS);
    expect(TOWNS.map((town) => town.townId)).toEqual(SPEC_TOWN_IDS);
  });

  it('gives every town a listed two-letter state', () => {
    const states: readonly string[] = US_STATE_CODES;
    expect(new Set(states).size).toBe(states.length);
    for (const town of TOWNS) expect(states).toContain(town.state);
    for (const code of states) expect(code).toMatch(/^[A-Z]{2}$/);
  });
});
