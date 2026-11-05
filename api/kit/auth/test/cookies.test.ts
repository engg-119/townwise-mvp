import type { CookieOptions, Response } from 'express';
import { expect, test } from 'vitest';

import { clearSessionCookies, cookieNames, readCookie, setSessionCookies, type CookieNames } from '../src/cookies.ts';

const REFRESH = 'a'.repeat(43);
const ACCESS = 'header.payload.signature';

function recording(): { res: Response; calls: { op: string; name: string; value?: string; options: CookieOptions }[] } {
  const calls: { op: string; name: string; value?: string; options: CookieOptions }[] = [];
  const res = {
    cookie(name: string, value: string, options: CookieOptions) {
      calls.push({ op: 'cookie', name, value, options });
      return res;
    },
    clearCookie(name: string, options: CookieOptions) {
      calls.push({ op: 'clear', name, options });
      return res;
    },
  };
  return { res: res as unknown as Response, calls };
}

const HOST: CookieNames = { access: '__Host-access', refresh: '__Host-refresh' };

test('a single value is read', () => {
  expect(readCookie(`__Host-access=${ACCESS}`, 'access', HOST)).toEqual({ status: 'ok', value: ACCESS });
  expect(readCookie(`other=no; __Host-refresh=${REFRESH}`, 'refresh', HOST)).toEqual({ status: 'ok', value: REFRESH });
});

test('an absent cookie is absent', () => {
  expect(readCookie(undefined, 'access', HOST)).toEqual({ status: 'absent' });
  expect(readCookie('theme=dark', 'refresh', HOST)).toEqual({ status: 'absent' });
});

test('a duplicated name is invalid', () => {
  expect(readCookie(`__Host-refresh=${REFRESH}; __Host-refresh=${REFRESH}`, 'refresh', HOST)).toEqual({ status: 'invalid' });
});

test('a bad charset is invalid', () => {
  expect(readCookie('__Host-access=not a token', 'access', HOST)).toEqual({ status: 'invalid' });
  expect(readCookie('__Host-refresh=short', 'refresh', HOST)).toEqual({ status: 'invalid' });
});

test('__Host-refreshX does not match __Host-refresh', () => {
  expect(readCookie(`__Host-refreshX=${REFRESH}`, 'refresh', HOST)).toEqual({ status: 'absent' });
});

test('dev-mode names when the issuer is http', () => {
  expect(cookieNames('https://api.example.test')).toEqual(HOST);
  expect(cookieNames('http://localhost:8080')).toEqual({ access: 'access', refresh: 'refresh' });
});

test('set and clear emit identical attributes', () => {
  const { res, calls } = recording();
  const names = cookieNames('https://api.example.test');
  setSessionCookies(res, {
    names,
    secure: true,
    accessToken: ACCESS,
    refreshToken: REFRESH,
    refreshMaxAgeSeconds: 1234,
  });
  clearSessionCookies(res, { names, secure: true, refreshMaxAgeSeconds: 1234 });
  const setAccess = calls.find((call) => call.op === 'cookie' && call.name === names.access);
  const clearAccess = calls.find((call) => call.op === 'clear' && call.name === names.access);
  const setRefresh = calls.find((call) => call.op === 'cookie' && call.name === names.refresh);
  const clearRefresh = calls.find((call) => call.op === 'clear' && call.name === names.refresh);
  expect(clearAccess?.options).toEqual(setAccess?.options);
  expect(clearRefresh?.options).toEqual(setRefresh?.options);
  expect(setAccess?.options).toMatchObject({ httpOnly: true, secure: true, path: '/', sameSite: 'lax', maxAge: 600_000 });
  expect(setRefresh?.options).toMatchObject({ httpOnly: true, secure: true, path: '/', sameSite: 'strict', maxAge: 1_234_000 });
  expect(setAccess?.options).not.toHaveProperty('domain');
  expect(setRefresh?.options).not.toHaveProperty('domain');
});
