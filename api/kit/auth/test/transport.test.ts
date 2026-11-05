import { AppError } from '@ckeith26/server-core';
import { expect, test } from 'vitest';

import { assertCookieRequestOrigin, resolvePlatform } from '../src/transport.ts';

const ORIGIN = 'https://app.example.test';
const ORIGINS = new Set([ORIGIN]);

function expectOriginDenied(run: () => void): void {
  try {
    run();
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ status: 403, code: 'origin_not_allowed' });
  }
}

test('web with an allowlisted Origin is web', () => {
  expect(resolvePlatform({ origin: ORIGIN }, 'web', ORIGINS)).toBe('web');
});

test('web with an unlisted Origin, with Origin null and with no Origin is 403', () => {
  expectOriginDenied(() => { resolvePlatform({ origin: 'https://evil.example.test' }, 'web', ORIGINS); });
  expectOriginDenied(() => { resolvePlatform({ origin: 'null' }, 'web', ORIGINS); });
  expectOriginDenied(() => { resolvePlatform({}, 'web', ORIGINS); });
});

test('native with no browser headers is native', () => {
  expect(resolvePlatform({}, 'native', ORIGINS)).toBe('native');
});

test('native with only sec-fetch-mode (what Node fetch sends) is native', () => {
  expect(resolvePlatform({ 'sec-fetch-mode': 'cors' }, 'native', ORIGINS)).toBe('native');
});

test('native with any Origin (including null) or with Sec-Fetch-Site is 403', () => {
  expectOriginDenied(() => { resolvePlatform({ origin: ORIGIN }, 'native', ORIGINS); });
  expectOriginDenied(() => { resolvePlatform({ origin: 'null' }, 'native', ORIGINS); });
  expectOriginDenied(() => { resolvePlatform({ 'sec-fetch-site': 'cross-site' }, 'native', ORIGINS); });
});

test('an unsafe cookie request needs an allowlisted Origin and GET does not', () => {
  expect(() => { assertCookieRequestOrigin('POST', { origin: ORIGIN }, ORIGINS); }).not.toThrow();
  expect(() => { assertCookieRequestOrigin('GET', {}, ORIGINS); }).not.toThrow();
  expect(() => { assertCookieRequestOrigin('GET', { origin: 'https://evil.example.test' }, ORIGINS); }).not.toThrow();
  expectOriginDenied(() => { assertCookieRequestOrigin('POST', {}, ORIGINS); });
  expectOriginDenied(() => { assertCookieRequestOrigin('POST', { origin: 'https://evil.example.test' }, ORIGINS); });
  expectOriginDenied(() => { assertCookieRequestOrigin('DELETE', { origin: 'null' }, ORIGINS); });
});
