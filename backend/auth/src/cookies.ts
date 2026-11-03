import type { Response } from 'express';

export type CookieKind = 'access' | 'refresh';

export interface CookieNames { readonly access: string; readonly refresh: string }

export function cookieNames(issuer: string): CookieNames {
  return new URL(issuer).protocol === 'https:'
    ? { access: '__Host-access', refresh: '__Host-refresh' }
    : { access: 'access', refresh: 'refresh' };
}

export type CookieRead =
  | { readonly status: 'absent' }
  | { readonly status: 'invalid' }
  | { readonly status: 'ok'; readonly value: string };

const CHARSET: Record<CookieKind, RegExp> = {
  access: /^[A-Za-z0-9._-]{1,2048}$/,
  refresh: /^[A-Za-z0-9_-]{43}$/,
};

export function readCookie(header: string | undefined, kind: CookieKind, names: CookieNames): CookieRead {
  if (header === undefined || header === '') return { status: 'absent' };
  const name = names[kind];
  let found: string | undefined;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    if (trimmed.slice(0, eq) !== name) continue;
    if (found !== undefined) return { status: 'invalid' };
    found = trimmed.slice(eq + 1);
  }
  if (found === undefined) return { status: 'absent' };
  if (!CHARSET[kind].test(found)) return { status: 'invalid' };
  return { status: 'ok', value: found };
}

function accessOptions(secure: boolean): {
  httpOnly: true;
  secure: boolean;
  path: '/';
  sameSite: 'lax';
  maxAge: number;
} {
  return { httpOnly: true, secure, path: '/', sameSite: 'lax', maxAge: 600_000 };
}

function refreshOptions(secure: boolean, refreshMaxAgeSeconds: number): {
  httpOnly: true;
  secure: boolean;
  path: '/';
  sameSite: 'strict';
  maxAge: number;
} {
  return { httpOnly: true, secure, path: '/', sameSite: 'strict', maxAge: refreshMaxAgeSeconds * 1000 };
}

export function setSessionCookies(res: Response, input: {
  names: CookieNames;
  secure: boolean;
  accessToken: string;
  refreshToken: string;
  refreshMaxAgeSeconds: number;
}): void {
  res.cookie(input.names.access, input.accessToken, accessOptions(input.secure));
  res.cookie(input.names.refresh, input.refreshToken, refreshOptions(input.secure, input.refreshMaxAgeSeconds));
}

export function clearSessionCookies(res: Response, input: {
  names: CookieNames;
  secure: boolean;
  refreshMaxAgeSeconds: number;
}): void {
  res.clearCookie(input.names.access, accessOptions(input.secure));
  res.clearCookie(input.names.refresh, refreshOptions(input.secure, input.refreshMaxAgeSeconds));
}
