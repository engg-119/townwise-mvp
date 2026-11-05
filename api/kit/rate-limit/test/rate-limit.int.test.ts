import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { createLogger } from '@ckeith26/server-core';
import { createRedis, type RedisHandle } from '@ckeith26/redis';
import { GenericContainer } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, expect, inject, it } from 'vitest';

import { createRateLimiter, RateLimiterUnavailableError } from '../src/index.ts';
import { VALKEY_IMAGE } from './images.ts';

const hash = (key: string): string => createHash('sha256').update(key, 'utf8').digest('base64url');

async function closeOwn(own: RedisHandle): Promise<void> {
  // Container stop leaves ioredis in reconnect backoff. If the socket is
  // already gone, disconnect() emits no 'end' and close() would wait forever.
  own.client.disconnect();
  await Promise.race([
    own.close(),
    new Promise<void>((resolve) => { setTimeout(resolve, 1200); }),
  ]);
}

let handle: RedisHandle;

beforeAll(async () => {
  handle = createRedis({
    config: { REDIS_URL: inject('redisUrl'), REDIS_KEY_PREFIX: 'kit-test:', NODE_ENV: 'test' },
    logger: createLogger({ LOG_LEVEL: 'silent' }),
  });
  expect(await handle.ready(3000)).toBe(true);
});

beforeEach(async () => {
  await handle.client.flushdb();
});

afterAll(async () => {
  await handle.close();
});

it('first hit sets a TTL atomically: PTTL > 0 immediately after the first consume (never -1)', async () => {
  const limiter = createRateLimiter({ redis: handle.client, name: 'test:ttl', limit: 5, windowSeconds: 60 });
  expect(await limiter.consume('k')).toEqual({ allowed: true, remaining: 4, retryAfterSeconds: 0 });
  const pttl = await handle.client.pttl(`rl:test:ttl:${hash('k')}`);
  expect(pttl).toBeGreaterThan(0);
  expect(pttl).toBeLessThanOrEqual(60_000);
});

it('50 concurrent consumes on a fresh key admit exactly limit', async () => {
  const limiter = createRateLimiter({ redis: handle.client, name: 'test:burst', limit: 10, windowSeconds: 60 });
  const results = await Promise.all(Array.from({ length: 50 }, () => limiter.consume('k')));
  expect(results.filter((decision) => decision.allowed)).toHaveLength(10);
  for (const decision of results) {
    if (decision.allowed) continue;
    expect(decision.remaining).toBe(0);
    expect(decision.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(decision.retryAfterSeconds).toBeLessThanOrEqual(60);
  }
});

it('distinct limiter names never share counters', async () => {
  const a = createRateLimiter({ redis: handle.client, name: 'test:a', limit: 1, windowSeconds: 60 });
  const b = createRateLimiter({ redis: handle.client, name: 'test:b', limit: 1, windowSeconds: 60 });
  expect((await a.consume('k')).allowed).toBe(true);
  expect((await b.consume('k')).allowed).toBe(true);
  expect((await a.consume('k')).allowed).toBe(false);
});

it('the Redis key is <REDIS_KEY_PREFIX>rl:<name>:<43-char hash> and contains no part of the caller\'s key', async () => {
  const limiter = createRateLimiter({ redis: handle.client, name: 'test:layout', limit: 5, windowSeconds: 60 });
  await limiter.consume('acct:zq-sentinel-zq');
  const keys = await handle.client.keys('*');
  expect(keys).toEqual([`kit-test:rl:test:layout:${hash('acct:zq-sentinel-zq')}`]);
  const stored = keys[0];
  expect(stored).toMatch(/^kit-test:rl:test:layout:[A-Za-z0-9_-]{43}$/);
  expect(stored).not.toContain('sentinel');
  expect(stored).not.toContain('acct');
});

it('with Redis stopped, consume rejects RateLimiterUnavailableError within 1.5s', async () => {
  const container = await new GenericContainer(VALKEY_IMAGE).withExposedPorts(6379).start();
  const own = createRedis({
    config: {
      REDIS_URL: `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`,
      REDIS_KEY_PREFIX: 'kit-test:',
      NODE_ENV: 'test',
    },
    logger: createLogger({ LOG_LEVEL: 'silent' }),
  });
  try {
    expect(await own.ready(3000)).toBe(true);
    const limiter = createRateLimiter({ redis: own.client, name: 'test:down', limit: 5, windowSeconds: 60 });
    expect((await limiter.consume('k')).allowed).toBe(true);
    await container.stop();
    const started = performance.now();
    let rejected: unknown;
    try {
      await limiter.consume('k');
    } catch (err) {
      rejected = err;
    }
    expect(performance.now() - started).toBeLessThan(1500);
    expect(rejected).toBeInstanceOf(RateLimiterUnavailableError);
    if (!(rejected instanceof RateLimiterUnavailableError)) throw new Error('expected RateLimiterUnavailableError');
    expect(rejected.cause).toBeDefined();
  } finally {
    await closeOwn(own);
  }
});

it('reset() clears the key; with Redis stopped it rejects RateLimiterUnavailableError', async () => {
  const container = await new GenericContainer(VALKEY_IMAGE).withExposedPorts(6379).start();
  const own = createRedis({
    config: {
      REDIS_URL: `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`,
      REDIS_KEY_PREFIX: 'kit-test:',
      NODE_ENV: 'test',
    },
    logger: createLogger({ LOG_LEVEL: 'silent' }),
  });
  try {
    expect(await own.ready(3000)).toBe(true);
    const limiter = createRateLimiter({ redis: own.client, name: 'test:reset', limit: 1, windowSeconds: 60 });
    expect((await limiter.consume('k')).allowed).toBe(true);
    expect((await limiter.consume('k')).allowed).toBe(false);
    await limiter.reset('k');
    expect(await own.client.exists(`rl:test:reset:${hash('k')}`)).toBe(0);
    expect((await limiter.consume('k')).allowed).toBe(true);
    await container.stop();
    const started = performance.now();
    let rejected: unknown;
    try {
      await limiter.reset('k');
    } catch (err) {
      rejected = err;
    }
    expect(performance.now() - started).toBeLessThan(1500);
    expect(rejected).toBeInstanceOf(RateLimiterUnavailableError);
  } finally {
    await closeOwn(own);
  }
});
