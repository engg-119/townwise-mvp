import { Redis } from 'ioredis';
import { afterAll, expect, it } from 'vitest';

import { createRateLimiter, RateLimiterUnavailableError } from '../src/index.ts';

const redis = new Redis({ lazyConnect: true });
afterAll(() => { redis.disconnect(); });

const ok = { redis, name: 'auth:ip', limit: 1, windowSeconds: 1 };

it('rule validation rejects windowSeconds < 1, non-integer limits and names without module:purpose', () => {
  expect(() => { createRateLimiter(ok); }).not.toThrow();
  for (const bad of [
    { windowSeconds: 0 },
    { windowSeconds: 0.5 },
    { limit: 0 },
    { limit: 1.5 },
    { name: 'auth' },
    { name: 'auth:ip:x' },
    { name: 'Auth:ip' },
    { name: 'auth:' },
  ]) {
    expect(() => { createRateLimiter({ ...ok, ...bad }); }).toThrow(TypeError);
  }
});

it('consume rejects an empty key and a 513-character key; accepts 512', async () => {
  const limiter = createRateLimiter({ ...ok, name: 'test:keys' });
  await expect(limiter.consume('')).rejects.toThrow(TypeError);
  await expect(limiter.consume('k'.repeat(513))).rejects.toThrow(TypeError);
  await expect(limiter.consume('k'.repeat(512))).rejects.toBeInstanceOf(RateLimiterUnavailableError);
});
