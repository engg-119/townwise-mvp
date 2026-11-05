import { createSecretKey, randomBytes } from 'node:crypto';

import { expect, test } from 'vitest';

import type { KeyringEntry } from '../src/config.ts';
import { createTokenCrypto, TokenCryptoError } from '../src/token-crypto.ts';

function entry(kid: string, bytes = 32): KeyringEntry {
  return { kid, key: createSecretKey(randomBytes(bytes)) };
}

test('round trip', () => {
  const crypto = createTokenCrypto([entry('e1')]);
  const stored = crypto.encrypt('totp-secret', 'auth_totp:user-a:secret');
  expect(crypto.decrypt(stored, 'auth_totp:user-a:secret')).toBe('totp-secret');
  expect(stored.startsWith('v1:e1:')).toBe(true);
});

test('a ciphertext under another context does not decrypt', () => {
  const crypto = createTokenCrypto([entry('e1')]);
  const stored = crypto.encrypt('totp-secret', 'auth_totp:user-a:secret');
  expect(() => crypto.decrypt(stored, 'auth_totp:user-b:secret')).toThrow(TokenCryptoError);
});

test('rejects an unknown kid, a missing version prefix, a wrong segment count and a truncated tag', () => {
  const crypto = createTokenCrypto([entry('e1')]);
  const stored = crypto.encrypt('totp-secret', 'auth_totp:user-a:secret');
  const parts = stored.split(':');
  expect(() => crypto.decrypt(`v1:other:${parts.slice(2).join(':')}`, 'auth_totp:user-a:secret')).toThrow(TokenCryptoError);
  expect(() => crypto.decrypt(stored.slice(3), 'auth_totp:user-a:secret')).toThrow(TokenCryptoError);
  expect(() => crypto.decrypt(parts.slice(0, 4).join(':'), 'auth_totp:user-a:secret')).toThrow(TokenCryptoError);
  const tag = parts[4] ?? '';
  const truncated = [...parts.slice(0, 4), tag.slice(0, 8)].join(':');
  expect(() => crypto.decrypt(truncated, 'auth_totp:user-a:secret')).toThrow(TokenCryptoError);
});

test('isStale is true only for a non-first kid', () => {
  const oldKey = entry('old');
  const newKey = entry('new');
  const legacy = createTokenCrypto([oldKey]);
  const stored = legacy.encrypt('totp-secret', 'auth_totp:user-a:secret');
  const rotated = createTokenCrypto([newKey, oldKey]);
  expect(rotated.decrypt(stored, 'auth_totp:user-a:secret')).toBe('totp-secret');
  expect(rotated.isStale(stored)).toBe(true);
  const fresh = rotated.encrypt('totp-secret', 'auth_totp:user-a:secret');
  expect(rotated.isStale(fresh)).toBe(false);
});

test('key-ring errors name the position or kid, never key bytes', () => {
  const short = randomBytes(16);
  const duplicate = randomBytes(32);
  const shortRing = [entry('k1'), { kid: 'k2', key: createSecretKey(short) }];
  const duplicateRing = [
    { kid: 'k1', key: createSecretKey(duplicate) },
    { kid: 'k2', key: createSecretKey(randomBytes(32)) },
    { kid: 'k2', key: createSecretKey(duplicate) },
  ];
  expect(() => createTokenCrypto(shortRing)).toThrow(TokenCryptoError);
  expect(() => createTokenCrypto(duplicateRing)).toThrow(TokenCryptoError);
  try {
    createTokenCrypto(shortRing);
  } catch (err) {
    expect(err).toBeInstanceOf(TokenCryptoError);
    const message = err instanceof Error ? err.message : '';
    expect(message).toMatch(/position 2|kid k2/);
    expect(message).not.toContain(short.toString('base64'));
  }
  try {
    createTokenCrypto(duplicateRing);
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    expect(message).toMatch(/position 2|kid k2/);
    expect(message).not.toContain(duplicate.toString('base64'));
  }
});
