import { expect, test } from 'vitest';

import { base32Decode, base32Encode, codeAt, otpauthUri, stepAt, verifyCode } from '../src/totp/totp.ts';

const SECRET = base32Encode(Buffer.from('12345678901234567890'));
const VECTORS: readonly [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

test('matches the RFC 6238 SHA-1 test vectors', () => {
  for (const [unix, code] of VECTORS) {
    expect(codeAt(SECRET, stepAt(new Date(unix * 1000)))).toBe(code);
  }
});

test('base32 round trip', () => {
  const bytes = Uint8Array.from([0, 1, 2, 250, 255, 16, 32, 64, 128, 200]);
  expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
  expect(base32Decode(SECRET)).toEqual(Uint8Array.from(Buffer.from('12345678901234567890')));
});

test('accepts plus or minus one step and rejects two', () => {
  const now = new Date(1_111_111_111_000);
  const step = stepAt(now);
  expect(verifyCode(SECRET, codeAt(SECRET, step), now)).toBe(step);
  expect(verifyCode(SECRET, codeAt(SECRET, step - 1), now)).toBe(step - 1);
  expect(verifyCode(SECRET, codeAt(SECRET, step + 1), now)).toBe(step + 1);
  expect(verifyCode(SECRET, codeAt(SECRET, step - 2), now)).toBeNull();
  expect(verifyCode(SECRET, codeAt(SECRET, step + 2), now)).toBeNull();
});

test('accepts a spaced code (123 456)', () => {
  const now = new Date(59_000);
  const code = codeAt(SECRET, stepAt(now));
  const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;
  expect(verifyCode(SECRET, spaced, now)).toBe(stepAt(now));
});

test('malformed input returns null without throwing', () => {
  const now = new Date(59_000);
  expect(verifyCode('!!!', '287082', now)).toBeNull();
  expect(verifyCode(SECRET, '12345', now)).toBeNull();
  expect(verifyCode(SECRET, '12345a', now)).toBeNull();
});

test('encodes the otpauth URI', () => {
  expect(otpauthUri({ issuer: 'Kit Test', account: 'ada@example.test', secret: SECRET })).toBe(
    `otpauth://totp/Kit%20Test:ada%40example.test?secret=${SECRET}&issuer=Kit%20Test&algorithm=SHA1&digits=6&period=30`,
  );
});
