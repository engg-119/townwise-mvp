import { expect, test } from 'vitest';

import {
  AUTH_ROUTES,
  googleBody,
  logoutBody,
  magicLinkBody,
  mfaVerifyBody,
  redeemBody,
  refreshBody,
  totpConfirmBody,
  totpDisableBody,
} from '../src/routes.ts';

const TOKEN = 'a'.repeat(43);

test('the route table matches the frozen HTTP contract', () => {
  expect(AUTH_ROUTES).toEqual([
    {
      method: 'POST',
      path: '/google',
      auth: 'platform',
      body: ['idToken', 'platform'],
      success: [200],
      errors: [
        'invalid_request',
        'invalid_google_token',
        'origin_not_allowed',
        'google_email_unverified',
        'google_email_not_authoritative',
        'email_linked_to_other_google_account',
        'google_email_conflict',
        'rate_limited',
        'google_unavailable',
      ],
    },
    {
      method: 'POST',
      path: '/magic-link',
      auth: 'platform',
      body: ['email', 'platform'],
      success: [202],
      errors: ['invalid_request', 'origin_not_allowed', 'rate_limited', 'email_unavailable'],
    },
    {
      method: 'POST',
      path: '/magic-link/redeem',
      auth: 'platform',
      body: ['token', 'email', 'platform'],
      success: [200],
      errors: ['invalid_request', 'invalid_or_expired_link', 'origin_not_allowed', 'rate_limited'],
    },
    {
      method: 'POST',
      path: '/mfa/verify',
      auth: 'platform',
      body: ['mfaToken', 'platform', 'code', 'recoveryCode'],
      success: [200],
      errors: ['invalid_request', 'invalid_code', 'invalid_mfa_token', 'origin_not_allowed', 'rate_limited'],
    },
    {
      method: 'POST',
      path: '/refresh',
      auth: 'refresh',
      body: ['platform', 'refreshToken'],
      success: [204, 200],
      errors: ['session_ended', 'origin_not_allowed', 'rate_limited'],
    },
    {
      method: 'POST',
      path: '/logout',
      auth: 'optional',
      body: ['platform', 'refreshToken'],
      success: [204],
      errors: ['origin_not_allowed'],
    },
    {
      method: 'POST',
      path: '/logout-all',
      auth: 'session',
      body: [],
      success: [204],
      errors: ['unauthenticated', 'origin_not_allowed'],
    },
    {
      method: 'GET',
      path: '/me',
      auth: 'session',
      body: [],
      success: [200],
      errors: ['unauthenticated'],
    },
    {
      method: 'POST',
      path: '/totp/enroll',
      auth: 'recent',
      body: [],
      success: [200],
      errors: ['unauthenticated', 'origin_not_allowed', 'reauth_required', 'totp_already_enabled'],
    },
    {
      method: 'POST',
      path: '/totp/enroll/confirm',
      auth: 'recent',
      body: ['code'],
      success: [200],
      errors: ['invalid_code', 'enrollment_expired', 'unauthenticated', 'origin_not_allowed', 'reauth_required', 'rate_limited'],
    },
    {
      method: 'POST',
      path: '/totp/disable',
      auth: 'recent',
      body: ['code', 'recoveryCode'],
      success: [204],
      errors: ['invalid_code', 'unauthenticated', 'origin_not_allowed', 'reauth_required', 'totp_not_enabled', 'rate_limited'],
    },
  ]);
});

test('body schemas accept the documented request shapes', () => {
  const rawEmail = '  Ada@Example.Test ';
  expect(googleBody.parse({ idToken: 'header.payload.sig', platform: 'web' })).toEqual({
    idToken: 'header.payload.sig',
    platform: 'web',
  });
  expect(magicLinkBody.parse({ email: rawEmail, platform: 'native' })).toEqual({
    email: rawEmail,
    platform: 'native',
  });
  expect(redeemBody.parse({ token: TOKEN, email: rawEmail, platform: 'web' })).toEqual({
    token: TOKEN,
    email: rawEmail,
    platform: 'web',
  });
  expect(mfaVerifyBody.parse({ mfaToken: 'mfa.token.value', platform: 'native', code: '123456' })).toEqual({
    mfaToken: 'mfa.token.value',
    platform: 'native',
    code: '123456',
  });
  expect(refreshBody.parse({ platform: 'web' })).toEqual({ platform: 'web' });
  expect(logoutBody.parse({ platform: 'native', refreshToken: TOKEN })).toEqual({
    platform: 'native',
    refreshToken: TOKEN,
  });
  expect(totpConfirmBody.parse({ code: '654321' })).toEqual({ code: '654321' });
  expect(totpDisableBody.parse({ recoveryCode: 'abcde12345abcde12345' })).toEqual({
    recoveryCode: 'abcde12345abcde12345',
  });
});

test('body schemas refuse arrays, operator objects and over-long strings', () => {
  expect(redeemBody.safeParse({ token: ['x'], email: 'ada@example.test', platform: 'web' }).success).toBe(false);
  expect(redeemBody.safeParse({ token: { $ne: null }, email: 'ada@example.test', platform: 'web' }).success).toBe(false);
  expect(redeemBody.safeParse({ token: 'a'.repeat(42), email: 'ada@example.test', platform: 'web' }).success).toBe(false);
  expect(googleBody.safeParse({ idToken: 'x'.repeat(8193), platform: 'web' }).success).toBe(false);
  expect(magicLinkBody.safeParse({ email: 'a'.repeat(321), platform: 'web' }).success).toBe(false);
  expect(magicLinkBody.safeParse({ email: ['a'], platform: 'web' }).success).toBe(false);
  const withExtension = { platform: 'extension' as const };
  expect(googleBody.safeParse({ idToken: 'x', ...withExtension }).success).toBe(false);
  expect(magicLinkBody.safeParse({ email: 'ada@example.test', ...withExtension }).success).toBe(false);
  expect(redeemBody.safeParse({ token: TOKEN, email: 'ada@example.test', ...withExtension }).success).toBe(false);
  expect(mfaVerifyBody.safeParse({ mfaToken: 'x', code: '123456', ...withExtension }).success).toBe(false);
  expect(refreshBody.safeParse(withExtension).success).toBe(false);
  expect(logoutBody.safeParse(withExtension).success).toBe(false);
  expect(totpConfirmBody.safeParse({ code: '123456', ...withExtension }).success).toBe(true);
  expect(totpDisableBody.safeParse({ code: '123456', ...withExtension }).success).toBe(true);
});

test('mfa verify takes exactly one of code or recoveryCode, normalized', () => {
  expect(mfaVerifyBody.parse({ mfaToken: 'm', platform: 'web', code: '123 456' }).code).toBe('123456');
  expect(mfaVerifyBody.parse({
    mfaToken: 'm',
    platform: 'web',
    recoveryCode: 'ABCDE-12345 ABCDE-12345',
  }).recoveryCode).toBe('abcde12345abcde12345');
  expect(mfaVerifyBody.safeParse({
    mfaToken: 'm',
    platform: 'web',
    code: '123456',
    recoveryCode: 'abcde12345abcde12345',
  }).success).toBe(false);
  expect(mfaVerifyBody.safeParse({ mfaToken: 'm', platform: 'web' }).success).toBe(false);
  expect(mfaVerifyBody.safeParse({ mfaToken: 'm', platform: 'web', code: '12345' }).success).toBe(false);
  expect(mfaVerifyBody.safeParse({ mfaToken: 'm', platform: 'web', recoveryCode: 'a'.repeat(19) }).success).toBe(false);
});

test('refresh and logout leave the refreshToken shape to the handler', () => {
  expect(refreshBody.parse({ platform: 'native', refreshToken: 42 })).toEqual({ platform: 'native', refreshToken: 42 });
  expect(refreshBody.parse({ platform: 'web' })).toEqual({ platform: 'web' });
  expect(logoutBody.parse({ platform: 'native', refreshToken: 42 })).toEqual({ platform: 'native', refreshToken: 42 });
  expect(logoutBody.parse({ platform: 'web' })).toEqual({ platform: 'web' });
});
