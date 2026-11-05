import { createLogger } from '@ckeith26/server-core';
import { afterEach, expect, it } from 'vitest';

import { createRedis, type RedisHandle } from '../src/createRedis.ts';

const handles: RedisHandle[] = [];

afterEach(() => {
  for (const handle of handles) handle.client.disconnect();
  handles.length = 0;
});

function open(
  config: { NODE_ENV: 'test' | 'production'; REDIS_URL: string; REDIS_KEY_PREFIX: string },
  lines?: string[],
): RedisHandle {
  const captured = lines ?? [];
  const logger = createLogger({ LOG_LEVEL: 'info' }, {
    destination: { write(line: string) { captured.push(line); } },
  });
  const handle = createRedis({ config, logger });
  handles.push(handle);
  return handle;
}

it('retry strategy never gives up: client.options.retryStrategy(n) is a number in [0, 5199] for n = 1, 10, 1000, 1e6', () => {
  const handle = open({ NODE_ENV: 'test', REDIS_URL: 'redis://127.0.0.1:6380', REDIS_KEY_PREFIX: 'myapp:' });
  const strategy = handle.client.options.retryStrategy;
  expect(typeof strategy).toBe('function');
  if (typeof strategy !== 'function') return;
  for (const n of [1, 10, 1000, 1e6]) {
    const delay = strategy(n);
    expect(typeof delay).toBe('number');
    if (typeof delay !== 'number') continue;
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(5199);
  }
});

it('createRedis: client.options.tls is an object and keyPrefix and commandTimeout are the factory values in production', () => {
  const handle = open({ NODE_ENV: 'production', REDIS_URL: 'rediss://127.0.0.1:6380', REDIS_KEY_PREFIX: 'myapp:' });
  expect(handle.name).toBe('redis');
  expect(handle.client.options.tls).toEqual({});
  expect(handle.client.options).toMatchObject({ keyPrefix: 'myapp:', commandTimeout: 1000, maxRetriesPerRequest: 2 });
});

it('an error listener is attached', () => {
  const lines: string[] = [];
  const handle = open({ NODE_ENV: 'test', REDIS_URL: 'redis://127.0.0.1:6380', REDIS_KEY_PREFIX: 'myapp:' }, lines);
  expect(handle.client.listenerCount('error')).toBeGreaterThan(0);
  handle.client.emit('error', Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:6379'), { code: 'ECONNREFUSED' }));
  const parsed = lines.map((line) => JSON.parse(line) as { level?: number; code?: string });
  expect(parsed.some((entry) => entry.level === 40 && entry.code === 'ECONNREFUSED')).toBe(true);
  expect(lines.join('\n')).not.toContain('10.1.2.3');
});
