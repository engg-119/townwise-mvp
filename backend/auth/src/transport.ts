import type { IncomingHttpHeaders } from 'node:http';

import { AppError } from '@ckeith26/server-core';

import type { Platform } from './stores/types.ts';

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** native: 403 origin_not_allowed if Origin (any value, 'null' included) or Sec-Fetch-Site is present.
 *  web: 403 origin_not_allowed unless Origin exactly equals an entry of webOrigins. Sec-Fetch-Mode is ignored. */
export function resolvePlatform(
  headers: IncomingHttpHeaders,
  declared: Platform,
  webOrigins: ReadonlySet<string>,
): Platform {
  if (declared === 'native') {
    if (header(headers, 'origin') !== undefined || header(headers, 'sec-fetch-site') !== undefined) {
      throw new AppError(403, 'origin_not_allowed', 'Origin not allowed');
    }
    return 'native';
  }
  const origin = header(headers, 'origin');
  if (origin === undefined || !webOrigins.has(origin)) {
    throw new AppError(403, 'origin_not_allowed', 'Origin not allowed');
  }
  return 'web';
}

/** For cookie-authenticated requests: methods other than GET, HEAD, OPTIONS need a present, allowlisted Origin. */
export function assertCookieRequestOrigin(
  method: string,
  headers: IncomingHttpHeaders,
  webOrigins: ReadonlySet<string>,
): void {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return;
  const origin = header(headers, 'origin');
  if (origin === undefined || !webOrigins.has(origin)) {
    throw new AppError(403, 'origin_not_allowed', 'Origin not allowed');
  }
}
