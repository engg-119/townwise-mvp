import { describe, expect, it } from 'vitest';

import { fingerprintOf } from '../../src/files/upload.ts';

describe('fingerprint (spec 6.11)', () => {
  const hashes = ['0'.repeat(64), '1'.repeat(64)];

  it('is the same for the same chunks and chunk size', () => {
    expect(fingerprintOf(8, hashes)).toBe(fingerprintOf(8, [...hashes]));
  });

  it('changes with any chunk, the order, or the chunk size', () => {
    const base = fingerprintOf(8, hashes);
    expect(fingerprintOf(8, ['0'.repeat(64), '2'.repeat(64)])).not.toBe(base);
    expect(fingerprintOf(8, [...hashes].reverse())).not.toBe(base);
    expect(fingerprintOf(16, hashes)).not.toBe(base);
  });
});
