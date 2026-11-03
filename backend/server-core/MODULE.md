---
name: server-core
summary: "The HTTP process every product runs: an Express app with security middleware, a JSON error model, generated request ids, allowlisted structured logs, /healthz, graceful shutdown, and env loading."
requires: []
env:
  - name: NODE_ENV
    required: true
    secret: false
  - name: PORT
    required: false
    secret: false
  - name: LOG_LEVEL
    required: false
    secret: false
  - name: CORS_ORIGINS
    required: false
    secret: false
  - name: TRUST_PROXY
    required: true
    secret: false
  - name: HTTP_KEEP_ALIVE_TIMEOUT_MS
    required: false
    secret: false
  - name: SHUTDOWN_TIMEOUT_MS
    required: false
    secret: false
status: beta
source:
  repo: coffee-chats/coffee-chats-mvp
  commit: ea8d0d8b20ffb1ab880e949c53d7377a6a72fd0e
  paths:
    - api/src/infrastructure/server/createApp.js
    - api/src/infrastructure/middleware/csrfOrigin.js
    - api/src/infrastructure/server/__tests__/logRedaction.test.js
    - api/src/infrastructure/server/__tests__/createApp.clientIp.test.js
    - api/src/server.js
    - api/src/infrastructure/server/lifecycle.js
---

## Wire it in

| name | required | secret | default / rule |
|---|---|---|---|
| NODE_ENV | yes | no | development, test, or production. Every deployed environment, staging included, is production. |
| PORT | no | no | 8080 |
| LOG_LEVEL | no | no | info |
| CORS_ORIGINS | no | no | empty (no browser origins). Development lists `http://localhost:8081` explicitly. Nothing about localhost is implied. |
| TRUST_PROXY | yes | no | required. See the three values below. |
| HTTP_KEEP_ALIVE_TIMEOUT_MS | no | no | 65000. Must exceed the load balancer idle timeout. |
| SHUTDOWN_TIMEOUT_MS | no | no | 25000. Must stay below ECS stopTimeout. |

Composition root. The app is the only place that reads `process.env`. On ECS, `NODE_ENV` must be production:

```ts
import { z } from 'zod';
import { configSchema as serverSchema, createLogger, createServer, loadEnv } from '@ckeith26/server-core';
import { configSchema as mongoSchema, connectMongo, ensureIndexes } from '@ckeith26/mongo';
import { configSchema as redisSchema, createRedis } from '@ckeith26/redis';
import { createRateLimiter, ipKey, rateLimit } from '@ckeith26/rate-limit';
import { configSchema as authSchema, createAuth, createMongoAuthStores } from '@ckeith26/auth';
import { sendMagicLink } from './email.ts';   // app-owned email transport (Section 3)

const config = loadEnv(z.object({ ...serverSchema.shape, ...mongoSchema.shape, ...redisSchema.shape, ...authSchema.shape }), process.env);
if (process.env.ECS_CONTAINER_METADATA_URI_V4 !== undefined && config.NODE_ENV !== 'production') {
  throw new Error('NODE_ENV must be production on ECS; development and test are for local machines and CI only');
}
const logger = createLogger(config);
const mongo = await connectMongo({ config, logger });
const redis = createRedis({ config, logger });
const auth = createAuth({ config, stores: createMongoAuthStores(mongo.connection), redis: redis.client, logger, sendMagicLink });
await ensureIndexes(mongo.connection, { logger });   // after every store has registered its models
await redis.ready(3000);                             // bounded; logs and continues on false
const ceiling = createRateLimiter({ redis: redis.client, name: 'app:api-ceiling', limit: 2000, windowSeconds: 60 });
const server = createServer({
  config, logger,
  routes: [{ path: '/auth', router: auth.router }],
  middleware: [rateLimit({ limiter: ceiling, key: ipKey, whenStoreDown: 'allow', logger })],
  onShutdown: [redis, mongo],
});
await server.listen();
```

Body parsing is per router. server-core does not mount a global parser. A JSON router mounts its own parser, and a webhook router mounts a raw or text parser and is listed before any broader mount:

```ts
router.use(express.json({ limit: '100kb' }));
webhook.use(express.raw({ type: '*/*', limit: '100kb' }));
// or webhook.use(express.text({ type: '*/*', limit: '100kb' }));
```

A router that forgets `express.json` gets `req.body === undefined`, which `parseInput` rejects with 400.

`TRUST_PROXY` values:

- Local and CI: `loopback`.
- ECS behind an ALB: the ALB subnet CIDRs (for example `10.0.0.0/20,10.0.16.0/20`), not all of `uniquelocal`. The task security group accepts traffic only from the ALB security group. Otherwise any workload that can reach the task directly can set `X-Forwarded-For`.
- Behind a CDN: append the CDN's published ranges. The kit does not ship those ranges, because they go stale.

Every deployed environment, staging included, sets `NODE_ENV=production`. The ALB health check and the container health check both use `GET /healthz`. Keep the ALB idle timeout below `HTTP_KEEP_ALIVE_TIMEOUT_MS` (use 125000 behind an ALB whose idle timeout is 120 seconds). Keep ECS `stopTimeout` above `SHUTDOWN_TIMEOUT_MS`. `TRUST_PROXY` is the ALB subnet CIDRs, and the task security group accepts traffic only from the ALB security group.

## Security

Allowlisted `req`, `res`, and `err` serializers. `redact` is a second layer. Query redaction is anchored so ordinary keys stay visible. Capability tokens never go in URL paths. The API CSP is strict and includes `form-action`. There is no `Cross-Origin-Opener-Policy` header. HSTS is sent only when `NODE_ENV` is `production`. Responses default to `Cache-Control: no-store`. An exact-match Origin CSRF guard runs before CORS and uses the same origin list. CORS allows only `Content-Type` and `Authorization` request headers. Each router mounts its own body parser, and `createServer` refuses a mount order that would let a broader path see a more specific path first. Request ids are generated. Inbound `X-Request-Id` values are ignored. Error bodies never carry stacks, driver messages, or parser messages. `TRUST_PROXY` is required and validated. Production controls are keyed on `NODE_ENV === 'production'`, and `main.ts` refuses any other value on ECS.

`req` and `res` serializers log only `id`, `method`, `url`, `ip`, `userAgent`, and `statusCode`. The `err` serializer keeps `type`, a safe `message`, `code` when it is a string or number, and a rebuilt stack, and it follows `cause` and `AggregateError.errors` to depth 3 (at most 10 aggregate entries). pino `redact` paths, which a product edits in its copy, are `password`, `token`, `accessToken`, `refreshToken`, `idToken`, `mfaToken`, `recoveryCode`, `secret`, `authorization`, `cookie`, and the same names one level down (`*.password` and the rest). Query keys, also a constant a product edits in its copy, are `t`, `q`, `token`, `access_token`, `refresh_token`, `id_token`, `code`, `state`, `password`, `secret`, `key`, `signature`, and `sig`.

Helmet's default `Cross-Origin-Resource-Policy: same-origin` is kept. It is right for JSON fetched through CORS, but it blocks image loads of API-served assets from another origin. A later module that serves assets sets CORP on those routes only.

Size the global ceiling as peak per-user request rate times the users behind one NAT. Exempt only exact paths whose signature verifier fails closed, never a prefix such as `/webhooks/`.

Background rejections shut the process down because shutdown drains in-flight requests, and logging-only would leave a process in a state nobody checked.

## Changes from source

Ported:

- Helmet setup and reasoning (`api/src/infrastructure/server/createApp.js:141-177`). CSP changes from off to a strict API policy because the kit serves JSON only.
- `no-store` default (`api/src/infrastructure/server/createApp.js:179-195`).
- CSRF-before-CORS ordering (`api/src/infrastructure/server/createApp.js:204-222`). Guard semantics (`api/src/infrastructure/middleware/csrfOrigin.js:51`, `api/src/infrastructure/middleware/csrfOrigin.js:94-123`).
- Query redaction regex and anchoring tests (`api/src/infrastructure/server/createApp.js:38-65`, `api/src/infrastructure/server/__tests__/logRedaction.test.js`).
- Trust-proxy lesson and client-ip cases (`api/src/infrastructure/server/createApp.js:22-36`, `api/src/infrastructure/server/__tests__/createApp.clientIp.test.js:39-60`).
- Generic parse error response (`api/src/infrastructure/server/createApp.js:407-414`). JSON 404 (`api/src/server.js:549-559`).
- Graceful shutdown core: idempotent shutdown, an unref'd force timer, and the exit code (`api/src/infrastructure/server/lifecycle.js:30-115`).

- Fixed: substring localhost match outside production (`api/src/infrastructure/server/createApp.js:232`, `api/src/infrastructure/middleware/csrfOrigin.js:69`) -> exact parsed allowlist. Pinned by `test/origins.test.ts` > "origins: rejects https://localhost.evil.com, a trailing slash, a path, the null origin and http in production".
- Fixed: the error handler passes `err.message` through for any status below 500 (`api/src/infrastructure/server/createApp.js:415-417`) -> only `AppError` messages are exposed. Pinned by `test/server.int.test.ts` > "errors: a non-AppError with status 400 and a detailed message is answered with Bad Request".
- Fixed: Node's 5s `keepAliveTimeout` against an ALB idle timeout of 120 (`infrastructure/terraform/workers/api_alb.tf:85`) -> configurable, default 65s for the ALB's 60s default; a 120 second ALB sets 125000. Pinned by `test/shutdown.int.test.ts` > "listen: keepAliveTimeout equals HTTP_KEEP_ALIVE_TIMEOUT_MS and headersTimeout is larger".
- Fixed: `server.close` waits on idle keep-alive sockets (`api/src/infrastructure/server/lifecycle.js:61-68`) -> idle sweep plus a drain deadline. Pinned by `test/shutdown.int.test.ts` > "shutdown: an in-flight request on a keep-alive connection completes, and shutdown finishes in under 2s, not keepAliveTimeout".
- Fixed: shutdown closes only Mongo (`api/src/infrastructure/server/lifecycle.js:69`) -> ordered hooks. Pinned by `test/shutdown.int.test.ts` > "shutdown: hooks run in order after drain; a hanging hook is abandoned at 2s".
- Fixed: lifecycle reads `process.env.SHUTDOWN_TIMEOUT_MS` (`api/src/infrastructure/server/lifecycle.js:14`) -> config schema. Pinned by `test/config.test.ts` > "config: loadEnv error lists variables and never contains any input value".
- Fixed: a global raw body capture for `/webhook/` paths next to a global JSON parser (`api/src/infrastructure/server/createApp.js:329-353`) -> per-router parsers plus enforced mount order. Pinned by `test/server.int.test.ts` > "raw route: with /webhooks (express.text) listed before / (express.json), a JSON-typed POST to /webhooks reaches the raw router as the untouched string"; `test/routes.test.ts` > "routes: a path that is a segment prefix of a later path throws ConfigError; /webhooks before / is accepted; /a before /ab is accepted".

Dropped:

- `X-Requested-With` in the CORS allowed headers (`api/src/infrastructure/server/createApp.js:252`): no kit client sends it.
- `api/src/infrastructure/server/asyncErrors.js` (Express 5 handles rejected handler promises). `compression` and `api/src/infrastructure/server/compressionFilter.js` (a JSON API returning tokens next to attacker-influenced fields is BREACH-shaped; a CDN can compress). `morgan` (replaced by pino-http). `cookie-parser` and `passport` (auth owns cookies). Views and static files. `earlyRouter` (the MCP host partition). `urlencoded` with `extended: true`. Portal wildcard origins (`api/src/shared/config/portalOrigin.js`; tenancy is a later wave). Hardcoded Cloudflare ranges (`api/src/infrastructure/server/createApp.js:27-36`). `describeError` (replaced by the allowlist `err` serializer).
- Moved to auth: the token cipher (`api/src/shared/utils/tokenCrypto.js`). It has one wave 1 consumer, so it lives in `backend/auth`.
