import { AppError, type Logger } from '@ckeith26/server-core';
import type { Redis } from 'ioredis';
import { createRateLimiter, RateLimiterUnavailableError, type RateLimiter } from '@ckeith26/rate-limit';

export interface AuthRule {
  readonly name: string;
  readonly limit: number;
  readonly windowSeconds: number;
  readonly sensitive: boolean;
}

export const AUTH_RULES = {
  ip: { name: 'auth:ip', limit: 120, windowSeconds: 60, sensitive: false },
  mlSendIp: { name: 'auth:ml-send-ip', limit: 20, windowSeconds: 3600, sensitive: true },
  mlSendEmail: { name: 'auth:ml-send-email', limit: 3, windowSeconds: 900, sensitive: true },
  mlSendEmailDay: { name: 'auth:ml-send-email-day', limit: 10, windowSeconds: 86400, sensitive: true },
  totpUser: { name: 'auth:totp-user', limit: 5, windowSeconds: 900, sensitive: true },
  totpUserDay: { name: 'auth:totp-user-day', limit: 20, windowSeconds: 86400, sensitive: true },
} as const satisfies Record<string, AuthRule>;

export type RuleId = keyof typeof AUTH_RULES;

/** While Redis is down, deny keeps TOTP guessing and mail-bombing bounded (those routes answer 503)
 *  and allow keeps sign-in up without those bounds. A-L4: deny every sensitive rule; auth:ip is the
 *  only non-sensitive rule and stays available. */
export function onLimiterUnavailable(rule: { name: string; sensitive: boolean }): 'allow' | 'deny' {
  return rule.sensitive ? 'deny' : 'allow';
}

export interface AuthLimits {
  consume(rule: RuleId, key: string): Promise<void>;
  reset(rule: RuleId, key: string): Promise<void>;
}

export function createAuthLimits(deps: {
  redis: Redis;
  logger: Logger;
  makeLimiter?: (opts: { redis: Redis; name: string; limit: number; windowSeconds: number }) => RateLimiter;
}): AuthLimits {
  const make = deps.makeLimiter ?? createRateLimiter;
  const limiters = {} as Record<RuleId, RateLimiter>;
  for (const id of Object.keys(AUTH_RULES) as RuleId[]) {
    const rule = AUTH_RULES[id];
    limiters[id] = make({ redis: deps.redis, name: rule.name, limit: rule.limit, windowSeconds: rule.windowSeconds });
  }

  return {
    async consume(id: RuleId, key: string): Promise<void> {
      const rule = AUTH_RULES[id];
      let decision;
      try {
        decision = await limiters[id].consume(key);
      } catch (err) {
        if (!(err instanceof RateLimiterUnavailableError)) throw err;
        if (onLimiterUnavailable(rule) === 'allow') {
          deps.logger.warn({ rule: rule.name }, 'auth.limiter_unavailable');
          return;
        }
        throw new AppError(503, 'unavailable', 'Service temporarily unavailable');
      }
      if (!decision.allowed) {
        deps.logger.info({ rule: rule.name }, 'auth.rate_limited');
        throw new AppError(429, 'rate_limited', 'Too many requests. Try again later.', {
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
    },
    async reset(id: RuleId, key: string): Promise<void> {
      try {
        await limiters[id].reset(key);
      } catch (err) {
        if (!(err instanceof RateLimiterUnavailableError)) throw err;
        deps.logger.warn({ rule: AUTH_RULES[id].name }, 'auth.limiter_unavailable');
      }
    },
  };
}
