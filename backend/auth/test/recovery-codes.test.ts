import { expect, test } from 'vitest';

import { generateRecoveryCodes, normalizeRecoveryCode } from '../src/totp/factor.ts';

test('recovery codes have the xxxxx-xxxxx-xxxxx-xxxxx format', () => {
  const { display } = generateRecoveryCodes();
  expect(display).toHaveLength(10);
  expect(new Set(display).size).toBe(10);
  for (const code of display) {
    expect(code).toMatch(/^[0-9a-f]{5}(-[0-9a-f]{5}){3}$/);
  }
});

test('ABCDE-12345 style input normalizes', () => {
  expect(normalizeRecoveryCode('ABCDE-12345 abcde 12345')).toBe('abcde12345abcde12345');
});

test('a recovery code of the wrong length is refused', () => {
  expect(normalizeRecoveryCode('abcde-12345')).toBeNull();
  expect(normalizeRecoveryCode('a'.repeat(19))).toBeNull();
  expect(normalizeRecoveryCode('a'.repeat(21))).toBeNull();
  expect(normalizeRecoveryCode('g'.repeat(20))).toBeNull();
});
