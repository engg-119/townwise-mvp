---
name: rate-limit
summary: Atomic Redis rate limiting by IP or caller key, imperative or as Express middleware, with an explicit store-down choice.
requires:
  - redis
  - server-core
env: []
status: beta
source:
  repo: coffee-chats/coffee-chats-mvp
  commit: ea8d0d8b20ffb1ab880e949c53d7377a6a72fd0e
  paths:
    - api/src/infrastructure/middleware/rateLimiter.js
    - api/src/infrastructure/middleware/__tests__/rateLimiter.ipPrefixKey.test.js
---

## Wire it in

Build one limiter per rule. `name` is `<module>:<purpose>` (`/^[a-z0-9-]+:[a-z0-9-]+$/`). `limit` and `windowSeconds` are integers greater than or equal to 1. The composition root's global ceiling is:

```ts
const ceiling = createRateLimiter({ redis: redis.client, name: 'app:api-ceiling', limit: 2000, windowSeconds: 60 });
const server = createServer({
  config, logger,
  routes: [{ path: '/auth', router: auth.router }],
  middleware: [rateLimit({ limiter: ceiling, key: ipKey, whenStoreDown: 'allow', logger })],
});
```

Size that ceiling as peak per-user request rate times the users behind one NAT. One user in a live meeting makes 60-100 requests a minute, and a campus NAT puts hundreds of users behind one address, which is why the example is 2000 per minute per IP. Exempt only exact paths whose signature verifier fails closed. `key` returns `undefined` for those paths and the middleware does not consume. Never exempt a prefix such as `/webhooks/`.

Every caller key is SHA-256 hashed before it reaches Redis, so the stored key is `<REDIS_KEY_PREFIX>rl:<name>:<hash>`. `REDIS_KEY_PREFIX` comes from `@ckeith26/redis`. `keyPrefix` is not applied to `KEYS` or `SCAN MATCH`.

Imperative callers turn `allowed: false` into `AppError(429, 'rate_limited', 'Too many requests. Try again later.', { retryAfterSeconds })`. `consume` and `reset` reject `RateLimiterUnavailableError` when the store errors, times out, or is not ready. There is no memory fallback. The caller catches that error and chooses.

`whenStoreDown` is required. `'deny'` answers 503 `unavailable`. `'allow'` calls `next()`. The store-down warning is throttled per rateLimit middleware (once a minute each); build one middleware per limiter if you need exactly one warning per limiter.

## Security

- Never key on unverified input a request can rotate for free. Keying on an unverified cookie gave every request a fresh bucket (`api/src/server.js:115-121`).
- A key the attacker chooses (an email) lets them lock that victim out. Pair it with an IP rule that runs first (`api/src/infrastructure/middleware/rateLimiter.js:281-300`).
- `reset()` may only target a key the caller has just proven it owns: one derived from the authenticated account (`acct:<userId>` or `acct:<userId>:ip:<ip>`), or a per-email key right after a magic link for that email was redeemed (only the inbox owner can redeem). Never an IP-only key, and never an email key before that proof. Otherwise an attacker with one valid account of their own makes N-1 guesses against a victim, logs into their own account to reset the IP bucket, and repeats.
- Endpoints that send mail or SMS, or that check a guessable secret, should use `whenStoreDown: 'deny'` (or, for imperative callers, deny on `RateLimiterUnavailableError`).
- The limiter's Redis runs `maxmemory-policy noeviction`. ElastiCache's default `volatile-lru` would evict limiter keys first, because every one has a TTL, and silently reset counters.

## Changes from source

Ported:

- IPv6 /64 keying and its edge cases (`api/src/infrastructure/middleware/rateLimiter.js:85-124`).
- A required per-limiter namespace (`api/src/infrastructure/middleware/rateLimiter.js:175-183`).

- Fixed: non-atomic TTL (`api/src/infrastructure/middleware/rateLimiter.js:36-48`). Pinned by `test/rate-limit.int.test.ts` > "first hit sets a TTL atomically: PTTL > 0 immediately after the first consume (never -1)".
- Fixed: implicit store-failure policy (`api/src/infrastructure/middleware/rateLimiter.js:31-32`, `api/src/infrastructure/middleware/rateLimiter.js:55-57`, `api/src/infrastructure/middleware/rateLimiter.js:192-195`). Pinned by `test/rate-limit.int.test.ts` > "with Redis stopped, consume rejects RateLimiterUnavailableError within 1.5s"; `test/middleware.test.ts` > "middleware: deny gives 429 rate_limited with Retry-After and retryAfterSeconds; store-down with 'allow' calls next; with 'deny' gives 503 unavailable; key returning undefined skips limiting".
- Fixed: store reached into module singletons (`api/src/infrastructure/middleware/rateLimiter.js:5`, `api/src/infrastructure/middleware/rateLimiter.js:34`). Pinned by `test/rate-limit.int.test.ts` > "distinct limiter names never share counters".

Dropped:

- `SCAN_MODE` ceiling (`api/src/infrastructure/middleware/rateLimiter.js:141-173`).
- Auth, API, and strict presets (`api/src/infrastructure/middleware/rateLimiter.js:212-269`). Rules belong to their modules.
- `contactFormRateLimiter` (`api/src/infrastructure/middleware/rateLimiter.js:281-362`). Its lessons are in Security above.
- Standard `RateLimit-*` headers (`api/src/infrastructure/middleware/rateLimiter.js:189-190`). `Retry-After` stays.
