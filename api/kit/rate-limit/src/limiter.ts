import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';
import { RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';

const LIMITER_NAME = /^[a-z0-9-]+:[a-z0-9-]+$/;

export type RateLimitDecision =
  | { readonly allowed: true; readonly remaining: number; readonly retryAfterSeconds: 0 }
  | { readonly allowed: false; readonly remaining: 0; readonly retryAfterSeconds: number };

/** Redis errored, timed out or was not ready. `cause` holds the original error. */
export class RateLimiterUnavailableError extends Error {
  override readonly name = 'RateLimiterUnavailableError';
}

export interface RateLimiter {
  readonly name: string;
  /** Counts one hit. Resolves the decision; rejects RateLimiterUnavailableError within about 1s
   *  when the store fails. Never falls back to process memory. */
  consume(key: string): Promise<RateLimitDecision>;
  /** Deletes the counter. Rejects RateLimiterUnavailableError on store failure. */
  reset(key: string): Promise<void>;
}

/** name: /^[a-z0-9-]+:[a-z0-9-]+$/ ("<module>:<purpose>"); limit and windowSeconds: integers >= 1.
 *  Throws at construction (boot) on a bad rule. Sub-second windows are refused because RLF takes a
 *  non-atomic MULTI path for them (lib/RateLimiterRedis.js:164-169). */
export function createRateLimiter(opts: {
  redis: Redis;
  name: string;
  limit: number;
  windowSeconds: number;
}): RateLimiter {
  if (!LIMITER_NAME.test(opts.name)) throw new TypeError('name must be <module>:<purpose>');
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new TypeError('limit must be an integer >= 1');
  if (!Number.isInteger(opts.windowSeconds) || opts.windowSeconds < 1) {
    throw new TypeError('windowSeconds must be an integer >= 1');
  }

  const limiter = new RateLimiterRedis({
    storeClient: opts.redis,
    keyPrefix: `rl:${opts.name}`,
    points: opts.limit,
    duration: opts.windowSeconds,
    rejectIfRedisNotReady: true,
  });

  return {
    name: opts.name,
    async consume(key: string): Promise<RateLimitDecision> {
      const hashed = hashKey(key);
      try {
        const res = await limiter.consume(hashed);
        return { allowed: true, remaining: res.remainingPoints, retryAfterSeconds: 0 };
      } catch (err) {
        if (err instanceof RateLimiterRes) {
          return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds: Math.max(1, Math.ceil(err.msBeforeNext / 1000)),
          };
        }
        throw unavailable(opts.name, err);
      }
    },
    async reset(key: string): Promise<void> {
      const hashed = hashKey(key);
      // RLF delete does not honor rejectIfRedisNotReady, and its promise stays
      // pending in the offline queue after the socket drops. DEL on the injected
      // client rejects on commandTimeout, and a client that is not ready has
      // already lost the store.
      if (opts.redis.status !== 'ready') {
        throw unavailable(opts.name, new Error('Redis connection is not ready'));
      }
      try {
        await opts.redis.del(`rl:${opts.name}:${hashed}`);
      } catch (err) {
        throw unavailable(opts.name, err);
      }
    },
  };
}

function hashKey(key: string): string {
  if (key.length < 1 || key.length > 512) throw new TypeError('rate limit key must be 1 to 512 characters');
  return createHash('sha256').update(key, 'utf8').digest('base64url');
}

function unavailable(name: string, cause: unknown): RateLimiterUnavailableError {
  return new RateLimiterUnavailableError(`rate limiter ${name} unavailable`, { cause });
}
