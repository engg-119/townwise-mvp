import { AppError } from '@ckeith26/server-core';
import { errors, type JWTPayload } from 'jose';
import { expect, test } from 'vitest';

import { classifyGoogleError, parseGoogleClaims } from '../src/google.ts';

function claims(overrides: Record<string, unknown> = {}): JWTPayload {
  return {
    aud: '1111-web.apps.googleusercontent.com',
    sub: 'google-sub',
    email: 'Ada@gmail.com',
    email_verified: true,
    iat: 1_700_000_000,
    exp: 1_700_003_600,
    ...overrides,
  };
}

function codeOf(err: unknown): string {
  expect(err).toBeInstanceOf(AppError);
  return (err as AppError).code;
}

test('an array aud is refused', () => {
  try {
    parseGoogleClaims(claims({ aud: ['1111-web.apps.googleusercontent.com'] }));
    throw new Error('expected a refusal');
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    expect(err.code).toBe('invalid_google_token');
    expect(err.status).toBe(401);
  }
});

test('a sub of 0 or 256 characters is refused', () => {
  for (const sub of ['', 'a'.repeat(256)]) {
    expect(() => parseGoogleClaims(claims({ sub }))).toThrow(AppError);
  }
});

test('email_verified true and the string true are accepted', () => {
  expect(parseGoogleClaims(claims({ email_verified: true })).email).toBe('ada@gmail.com');
  expect(parseGoogleClaims(claims({ email_verified: 'true' })).email).toBe('ada@gmail.com');
});

test('email_verified false, the string false, missing and 1 are refused', () => {
  const samples: Record<string, unknown>[] = [
    { email_verified: false },
    { email_verified: 'false' },
    { email_verified: undefined },
    { email_verified: 1 },
  ];
  for (const overrides of samples) {
    try {
      parseGoogleClaims(claims(overrides));
      throw new Error('expected a refusal');
    } catch (err) {
      expect(codeOf(err)).toBe('google_email_unverified');
      expect((err as AppError).status).toBe(403);
    }
  }
});

test('exp <= iat is refused', () => {
  expect(() => parseGoogleClaims(claims({ iat: 10, exp: 10 }))).toThrow(AppError);
  expect(() => parseGoogleClaims(claims({ iat: 10, exp: 9 }))).toThrow(AppError);
});

test('the email is normalized', () => {
  expect(parseGoogleClaims(claims({ email: '  Ada@Gmail.com ' })).email).toBe('ada@gmail.com');
});

test('the 401 allowlist maps to invalid_google_token', () => {
  const samples = [
    new errors.JWSInvalid('bad'),
    new errors.JWSSignatureVerificationFailed(),
    new errors.JWTInvalid('bad'),
    new errors.JWTExpired('expired', {}),
    new errors.JWTClaimValidationFailed('claim', {}),
    new errors.JOSEAlgNotAllowed('alg'),
    new errors.JOSENotSupported('unsupported'),
    new errors.JWKSNoMatchingKey(),
    new errors.JWKSMultipleMatchingKeys(),
  ];
  for (const err of samples) {
    const app = classifyGoogleError(err);
    expect(app.status).toBe(401);
    expect(app.code).toBe('invalid_google_token');
  }
});

test('ERR_JOSE_GENERIC, ERR_JWKS_TIMEOUT, ERR_JWKS_INVALID and TypeError are 503 google_unavailable', () => {
  const generic = new Error('generic');
  Object.assign(generic, { code: 'ERR_JOSE_GENERIC' });
  const samples = [generic, new errors.JWKSTimeout(), new errors.JWKSInvalid('bad'), new TypeError('refused')];
  for (const err of samples) {
    const app = classifyGoogleError(err);
    expect(app.status).toBe(503);
    expect(app.code).toBe('google_unavailable');
  }
});
