import { createHash, createSecretKey, randomBytes } from 'node:crypto';

import { expect, test } from 'vitest';

import { deriveEmailKey, emailId, normalizeEmail } from '../src/email-id.ts';

const EMAIL = 'ada@example.test';

test('deterministic for one key', () => {
  const key = deriveEmailKey(createSecretKey(randomBytes(32)));
  expect(emailId(key, EMAIL)).toBe(emailId(key, EMAIL));
  expect(emailId(key, EMAIL)).toMatch(/^[A-Za-z0-9_-]+$/);
});

test('differs from the unsalted SHA-256 and changes with the key', () => {
  const key = deriveEmailKey(createSecretKey(randomBytes(32)));
  const id = emailId(key, EMAIL);
  expect(id).not.toBe(createHash('sha256').update(EMAIL).digest('base64url'));
  expect(id).not.toBe(createHash('sha256').update(EMAIL).digest('hex'));
  const other = deriveEmailKey(createSecretKey(randomBytes(32)));
  expect(id).not.toBe(emailId(other, EMAIL));
});

test('normalizeEmail trims, lowercases and refuses over 254 characters', () => {
  expect(normalizeEmail('  Ada@Example.Test ')).toBe('ada@example.test');
  expect(normalizeEmail(`${'a'.repeat(243)}@example.test`)).toBeNull();
  expect(normalizeEmail('not an email')).toBeNull();
});
