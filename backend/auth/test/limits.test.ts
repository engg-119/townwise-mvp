import { AppError, type Logger } from '@ckeith26/server-core';
import type { Redis } from 'ioredis';
import { RateLimiterUnavailableError, type RateLimiter, type RateLimitDecision } from '@ckeith26/rate-limit';
import { expect, test } from 'vitest';

import { AUTH_RULES, createAuthLimits, onLimiterUnavailable, type RuleId } from '../src/limits.ts';

interface LogLine { readonly level: 'info' | 'warn'; readonly bindings: unknown; readonly msg: string }

function logger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const record = (level: LogLine['level']) => (bindings: unknown, msg: string): void => {
    lines.push({ level, bindings, msg });
  };
  return {
    lines,
    logger: { info: record('info'), warn: record('warn') } as unknown as Logger,
  };
}

function limiter(behavior: {
  consume?: () => Promise<RateLimitDecision>;
  reset?: () => Promise<void>;
}): RateLimiter {
  return {
    name: 'auth:test',
    consume: behavior.consume ?? (() => Promise.resolve({ allowed: true, remaining: 1, retryAfterSeconds: 0 })),
    reset: behavior.reset ?? (() => Promise.resolve()),
  };
}

test('the auth rule table has the documented names, limits, windows and sensitivity', () => {
  expect(AUTH_RULES).toEqual({
    ip: { name: 'auth:ip', limit: 120, windowSeconds: 60, sensitive: false },
    mlSendIp: { name: 'auth:ml-send-ip', limit: 20, windowSeconds: 3600, sensitive: true },
    mlSendEmail: { name: 'auth:ml-send-email', limit: 3, windowSeconds: 900, sensitive: true },
    mlSendEmailDay: { name: 'auth:ml-send-email-day', limit: 10, windowSeconds: 86400, sensitive: true },
    totpUser: { name: 'auth:totp-user', limit: 5, windowSeconds: 900, sensitive: true },
    totpUserDay: { name: 'auth:totp-user-day', limit: 20, windowSeconds: 86400, sensitive: true },
  });
  const built: { name: string; limit: number; windowSeconds: number }[] = [];
  createAuthLimits({
    redis: {} as Redis,
    logger: logger().logger,
    makeLimiter: (opts) => {
      built.push({ name: opts.name, limit: opts.limit, windowSeconds: opts.windowSeconds });
      return limiter({});
    },
  });
  expect(built).toEqual(Object.values(AUTH_RULES).map((rule) => ({
    name: rule.name,
    limit: rule.limit,
    windowSeconds: rule.windowSeconds,
  })));
});

test('an allowed decision resolves', async () => {
  const limits = createAuthLimits({
    redis: {} as Redis,
    logger: logger().logger,
    makeLimiter: () => limiter({}),
  });
  await expect(limits.consume('ip', 'k')).resolves.toBeUndefined();
});

test('a denied decision is 429 rate_limited with retryAfterSeconds and logs auth.rate_limited', async () => {
  const captured = logger();
  const limits = createAuthLimits({
    redis: {} as Redis,
    logger: captured.logger,
    makeLimiter: () => limiter({
      consume: () => Promise.resolve({ allowed: false, remaining: 0, retryAfterSeconds: 9 }),
    }),
  });
  await expect(limits.consume('mlSendEmail', 'email-id')).rejects.toMatchObject({
    status: 429,
    code: 'rate_limited',
    retryAfterSeconds: 9,
  });
  await expect(limits.consume('mlSendEmail', 'email-id')).rejects.toBeInstanceOf(AppError);
  expect(captured.lines).toContainEqual({
    level: 'info',
    bindings: { rule: 'auth:ml-send-email' },
    msg: 'auth.rate_limited',
  });
});

test('errors other than RateLimiterUnavailableError propagate', async () => {
  const boom = new Error('boom');
  const limits = createAuthLimits({
    redis: {} as Redis,
    logger: logger().logger,
    makeLimiter: () => limiter({
      consume: () => Promise.reject(boom),
      reset: () => Promise.reject(boom),
    }),
  });
  await expect(limits.consume('ip', 'k')).rejects.toBe(boom);
  await expect(limits.reset('ip', 'k')).rejects.toBe(boom);
});

test('reset swallows a store outage and logs a warning', async () => {
  const captured = logger();
  const limits = createAuthLimits({
    redis: {} as Redis,
    logger: captured.logger,
    makeLimiter: () => limiter({
      reset: () => Promise.reject(new RateLimiterUnavailableError('down')),
    }),
  });
  await expect(limits.reset('totpUser', 'user')).resolves.toBeUndefined();
  expect(captured.lines).toContainEqual({
    level: 'warn',
    bindings: { rule: 'auth:totp-user' },
    msg: 'auth.limiter_unavailable',
  });
});

test('onLimiterUnavailable denies every sensitive rule and allows auth:ip', () => {
  const rules = Object.values(AUTH_RULES);
  expect(rules).toHaveLength(6);
  for (const rule of rules) {
    if (rule.name === 'auth:ip') {
      expect(rule.sensitive).toBe(false);
      expect(onLimiterUnavailable(rule)).toBe('allow');
    } else {
      expect(rule.sensitive).toBe(true);
      expect(onLimiterUnavailable(rule)).toBe('deny');
    }
  }
});

test('a store outage on a sensitive rule is 503 unavailable', async () => {
  const limits = createAuthLimits({
    redis: {} as Redis,
    logger: logger().logger,
    makeLimiter: () => limiter({
      consume: () => Promise.reject(new RateLimiterUnavailableError('down')),
    }),
  });
  const sensitive: RuleId[] = ['mlSendIp', 'mlSendEmail', 'mlSendEmailDay', 'totpUser', 'totpUserDay'];
  for (const id of sensitive) {
    await expect(limits.consume(id, 'k')).rejects.toMatchObject({ status: 503, code: 'unavailable' });
  }
});

test('a store outage on auth:ip continues and logs a warning', async () => {
  const captured = logger();
  const limits = createAuthLimits({
    redis: {} as Redis,
    logger: captured.logger,
    makeLimiter: () => limiter({
      consume: () => Promise.reject(new RateLimiterUnavailableError('down')),
    }),
  });
  await expect(limits.consume('ip', 'k')).resolves.toBeUndefined();
  expect(captured.lines).toContainEqual({
    level: 'warn',
    bindings: { rule: 'auth:ip' },
    msg: 'auth.limiter_unavailable',
  });
});
