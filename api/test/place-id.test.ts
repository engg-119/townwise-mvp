// The Google place id pattern shared by the Places proxy and access requests (spec 6.3, 10.2a).
import { describe, expect, it } from 'vitest';

import { PLACE_ID_PATTERN, placeIdSchema } from '../src/place-id.ts';

describe('placeIdSchema', () => {
  it('accepts a typical id, the 10 and 512 character bounds, and _ and -', () => {
    for (const id of ['ChIJTestPlace0001', 'a'.repeat(10), 'a'.repeat(512), 'Test_Place-0001']) {
      expect(placeIdSchema.safeParse(id).success, id.slice(0, 20)).toBe(true);
    }
  });

  it('refuses empty, 9, 513 characters, a space, a slash, a query, non-ASCII and surrounding whitespace', () => {
    for (const id of ['', 'a'.repeat(9), 'a'.repeat(513), 'ChIJ abcdefgh', '../../places/ChIJabc', 'ChIJabcdefgh?x=1', 'ChIJabcdéfgh', ' ChIJTestPlace0001', 'ChIJTestPlace0001\n']) {
      expect(placeIdSchema.safeParse(id).success, JSON.stringify(id.slice(0, 20))).toBe(false);
    }
    expect(placeIdSchema.safeParse(7).success).toBe(false);
  });

  it('exports the pattern the proxy uses', () => {
    expect(PLACE_ID_PATTERN.test('ChIJTestPlace0001')).toBe(true);
  });
});
