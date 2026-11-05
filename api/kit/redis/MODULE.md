---
name: redis
summary: One ioredis client per app with a key prefix, strict URL parsing, TLS in production, endless reconnect and a shutdown hook.
requires:
  - server-core
env:
  - name: REDIS_URL
    required: true
    secret: true
  - name: REDIS_KEY_PREFIX
    required: true
    secret: false
status: beta
source:
  repo: coffee-chats/coffee-chats-mvp
  commit: ea8d0d8b20ffb1ab880e949c53d7377a6a72fd0e
  paths:
    - api/src/infrastructure/redis/index.js
    - api/src/shared/config/index.js
    - api/src/infrastructure/redis/__tests__/connectRedis.test.js
    - api/src/infrastructure/server/lifecycle.js
    - api/src/server.js
---

## Wire it in

`createRedis` builds one ioredis client and returns a shutdown hook named `redis`:

```ts
import type { Redis } from 'ioredis';
import type { Logger, ServerConfig, ShutdownHook } from '@ckeith26/server-core';

export interface RedisHandle extends ShutdownHook {
  readonly client: Redis;
  /** PING raced against timeoutMs. Resolves true when Redis answered, false otherwise. Never throws. */
  ready(timeoutMs: number): Promise<boolean>;
}
export function createRedis(deps: {
  config: RedisConfig & Pick<ServerConfig, 'NODE_ENV'>;
  logger: Logger;
}): RedisHandle;
```

In the composition root, create the client, wait for it before `listen()`, and close it on shutdown:

```ts
const redis = createRedis({ config, logger });
await redis.ready(3000); // bounded; logs and continues on false
const server = createServer({
  config, logger,
  routes: [{ path: '/auth', router: auth.router }],
  onShutdown: [redis, mongo],
});
await server.listen();
```

`ready(3000)` runs before `listen()` because ioredis connects at construction, but the client is still `connecting` on the first command after boot. The bounded ping keeps the first requests after a deploy off the store-down path. A false result is logged and startup continues.

`REDIS_URL` uses the `redis:` or `rediss:` protocol. Production requires `rediss:`. The URL has no query string and no fragment. The path is empty, `/`, or `/0` through `/15`. Username and password are percent-encoded.

`REDIS_KEY_PREFIX` matches `/^[a-z0-9][a-z0-9-]*:$/`, for example `myapp:`.

`keyPrefix` is not applied to `KEYS` or `SCAN MATCH` patterns. Blocking commands need their own connection: `client.duplicate({ commandTimeout: undefined })`.

The ElastiCache parameter group for the limiter's Redis sets `maxmemory-policy noeviction`. ElastiCache's default `volatile-lru` evicts keys with a TTL first, and every limiter key has one, so memory pressure would silently reset counters. With `noeviction` a full Redis fails writes, which surfaces as `RateLimiterUnavailableError` and the caller's explicit store-down decision.

## Security

`REDIS_URL` is secret because it holds the AUTH token. The URL never reaches ioredis raw, so query parameters cannot override client options, and `REDISS://` still gets TLS. Parse errors name the broken rule and include no part of the URL. The error listener logs the error code only, not the message or the address. `commandTimeout: 1000` and `maxRetriesPerRequest: 2` bound every command. `noeviction` turns memory pressure into `RateLimiterUnavailableError` instead of reset counters.

## Changes from source

Ported:

- TLS by scheme (`api/src/infrastructure/redis/index.js:13-17`, `api/src/infrastructure/redis/index.js:28`).
- The error listener (`api/src/infrastructure/redis/index.js:32-34`).
- The bounded startup ping (`api/src/infrastructure/redis/index.js:120-150`).
- Why blocking clients need their own connection (`api/src/infrastructure/redis/index.js:63-69`), documented for the jobs module.

- Fixed: retry gives up after 10 attempts (`api/src/infrastructure/redis/index.js:20-27`), now never gives up. Pinned by `test/createRedis.test.ts` > "retry strategy never gives up: client.options.retryStrategy(n) is a number in [0, 5199] for n = 1, 10, 1000, 1e6"; `test/redis.int.test.ts` > "reconnects after a 10s outage".
- Fixed: module-level singletons (`api/src/infrastructure/redis/index.js:4-5`, `api/src/infrastructure/redis/index.js:44-61`, `api/src/infrastructure/redis/index.js:70-76`), now a factory. Pinned by `test/createRedis.test.ts` > "createRedis: client.options.tls is an object and keyPrefix and commandTimeout are the factory values in production".
- Fixed: `disconnectRedis` is never called by lifecycle (`api/src/infrastructure/server/lifecycle.js:69`, `api/src/server.js:576-582`, `2-platform.md` 9 N4), now a shutdown hook. server-core runs `shutdown: hooks run in order after drain; a hanging hook is abandoned at 2s`. Pinned by `test/redis.int.test.ts` > "close() resolves while Redis is down".
- Fixed: `maxRetriesPerRequest` default 3 and no command timeout (`api/src/shared/config/index.js:510-511`), now 2 plus `commandTimeout`. Pinned by `test/redis.int.test.ts` > "commands fail within about 1s while Redis is unreachable (no hang)".
- Fixed: no production TLS check, and URL parameters could override client options, now a strict parse with `rediss:` required in production. Pinned by `test/parseRedisUrl.test.ts` > "parseRedisUrl: production rejects redis:// and accepts REDISS:// as rediss:// with tls set"; `test/parseRedisUrl.test.ts` > "parseRedisUrl: rejects ?tls=, ?keyPrefix=other:, ?commandTimeout=9, a fragment, and /abc; the message excludes the URL".

Dropped:

- Subscriber, blocking, and publisher clients (`api/src/infrastructure/redis/index.js:56-85`). `duplicate()` covers them when the jobs module arrives.
- `isRedisConnected()` (`api/src/infrastructure/redis/index.js:116-118`). The limiter's ready check replaces it.
- The `RedisClient` alias. Consumers import the `Redis` type from ioredis.
