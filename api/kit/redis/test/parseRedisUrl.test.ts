import { ConfigError } from '@ckeith26/server-core';
import { expect, it } from 'vitest';

import { parseRedisUrl } from '../src/parseRedisUrl.ts';

function catchError(run: () => void): unknown {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

it('parseRedisUrl: production rejects redis:// and accepts REDISS:// as rediss:// with tls set', () => {
  expect(() => parseRedisUrl('redis://cache.internal:6379', true)).toThrow(ConfigError);
  expect(parseRedisUrl('REDISS://cache.internal:6380', true))
    .toEqual({ host: 'cache.internal', port: 6380, db: 0, tls: true, username: undefined, password: undefined });
});

it('parseRedisUrl: rejects ?tls=, ?keyPrefix=other:, ?commandTimeout=9, a fragment, and /abc; the message excludes the URL', () => {
  const base = 'redis://user:sentinelpw@sentinel-host:6379';
  for (const bad of [`${base}/?tls=false`, `${base}/?keyPrefix=other:`, `${base}/?commandTimeout=9`, `${base}/#x`, `${base}/abc`]) {
    const err = catchError(() => { parseRedisUrl(bad, false); });
    expect(err).toBeInstanceOf(ConfigError);
    if (!(err instanceof ConfigError)) throw new Error('expected ConfigError');
    expect(err.problems.map((problem) => problem.variable)).toEqual(['REDIS_URL']);
    expect(JSON.stringify([err.message, err.problems])).not.toMatch(/sentinel|tls=|keyPrefix=|commandTimeout=|abc/);
  }
});

it('parseRedisUrl: decodes p%40ss%3Aw0rd, strips IPv6 brackets, maps /2 to db 2 and no path to db 0', () => {
  expect(parseRedisUrl('redis://default:p%40ss%3Aw0rd@[::1]:6379/2', false))
    .toEqual({ host: '::1', port: 6379, db: 2, tls: false, username: 'default', password: 'p@ss:w0rd' });
  expect(parseRedisUrl('redis://localhost', false))
    .toEqual({ host: 'localhost', port: 6379, db: 0, tls: false, username: undefined, password: undefined });
});
