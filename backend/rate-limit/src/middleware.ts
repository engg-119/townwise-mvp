import { AppError, type Logger } from '@ckeith26/server-core';
import type { Request, RequestHandler } from 'express';

import { RateLimiterUnavailableError, type RateLimiter } from './limiter.ts';

/** key returns undefined to skip limiting (exact exempt paths only, see 2.12).
 *  whenStoreDown is required: 'allow' passes the request and logs warn at most once a minute per limiter;
 *  'deny' answers 503 unavailable.
 *  The store-down warning is throttled per rateLimit middleware (once a minute each); build one middleware per limiter if you need exactly one warning per limiter. */
export function rateLimit(opts: {
  limiter: RateLimiter;
  key: (req: Request) => string | undefined;
  whenStoreDown: 'allow' | 'deny';
  logger: Logger;
}): RequestHandler {
  let lastWarnedAt: number | undefined;
  return async (req, _res, next) => {
    const key = opts.key(req);
    if (key === undefined) {
      next();
      return;
    }
    try {
      const decision = await opts.limiter.consume(key);
      if (decision.allowed) {
        next();
        return;
      }
      throw new AppError(429, 'rate_limited', 'Too many requests. Try again later.', {
        retryAfterSeconds: decision.retryAfterSeconds,
      });
    } catch (err) {
      if (!(err instanceof RateLimiterUnavailableError)) throw err;
      if (opts.whenStoreDown === 'deny') {
        throw new AppError(503, 'unavailable', 'Service temporarily unavailable', { cause: err });
      }
      const now = Date.now();
      if (lastWarnedAt === undefined || now - lastWarnedAt >= 60_000) {
        lastWarnedAt = now;
        opts.logger.warn({ limiter: opts.limiter.name, err }, 'rate limit store unavailable; request allowed');
      }
      next();
    }
  };
}
