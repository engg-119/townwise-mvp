---
name: mongo
summary: "A MongoDB connection with safe defaults, the boot-time index step, a duplicate-key helper, an ObjectId schema and a shutdown hook."
requires:
  - server-core
env:
  - name: MONGODB_URI
    required: true
    secret: true
status: beta
source:
  repo: coffee-chats/coffee-chats-mvp
  commit: ea8d0d8b20ffb1ab880e949c53d7377a6a72fd0e
  paths:
    - api/src/infrastructure/database/connect.js
    - api/src/infrastructure/database/indexAudit.js
    - api/src/scripts/buildMissingIndexes.js
    - api/src/infrastructure/database/docdbIndexSupport.js
    - api/src/infrastructure/database/__tests__/docdbIndexSupport.test.js
    - api/src/infrastructure/middleware/objectIdParams.js
---

## Wire it in

Call `connectMongo({ config, logger })`, then register every store's models on `mongo.connection`, then `ensureIndexes(mongo.connection, { logger })` before `listen()`. Shut mongo down after redis: `onShutdown: [redis, mongo]`. `NODE_ENV` comes from server-core. The product composition root, including that shutdown list, is the one in server-core's MODULE.md.

```ts
const mongo = await connectMongo({ config, logger });
// Each store calls mongo.connection.model(...) here.
await ensureIndexes(mongo.connection, { logger });
```

| name | required | secret |
|---|---|---|
| MONGODB_URI | yes | yes |

`parseInput(objectId, req.params.id)` is chosen per parameter. Google, Stripe and Tavus ids are not ObjectIds.

Stores wrap intentional operators in `trusted(...)`. Every client-supplied filter value is a zod scalar. Since mongoose 9.11.4, `sanitizeFilter` also refuses an array value on a scalar path (a CastError) instead of casting it to `$in`, so an intentional `$in` must be written out inside `trusted(...)`.

New products start empty, so building at boot is the zero-ops path. A product with a large collection must change `buildAtBoot` before deploy because a TTL build deletes expired documents and a unique build fails on duplicates.

The one-off build, for a collection that must not build at boot, runs as an ECS one-off task in the VPC:

```ts
await ensureIndexes(conn, { logger, buildAtBoot: () => true });
```

Build one index at a time while watching cluster CPU. A TTL build deletes the expired backlog when it lands. A unique build fails while duplicates exist, so clean them first.

### DocumentDB

- URI: `mongodb://USER:PASS@<cluster-endpoint>:27017/app?tls=true&tlsCAFile=/app/certs/global-bundle.pem&replicaSet=rs0&retryWrites=false`. The CA bundle is baked into the image.
- No `readPreference` parameter. The primary default is what session checks, refresh rotation, reuse detection and magic-link single use need. Reads from the primary are read-after-write consistent. Replica reads are eventually consistent, and DocumentDB has no causal consistency.
- `retryWrites=false` is required below engine 8.0.2. No `authMechanism`: the driver negotiates. DocumentDB supports SCRAM-SHA-256 on 5.0.1+ and 8.0.1+.
- A product on DocumentDB adds one unit test: register its models on an unopened `mongoose.createConnection()` and assert `documentDbIndexProblems(conn)` is `[]`. CI runs MongoDB 8.0 only.

## Security

Every client filter value is zod-parsed to a scalar. `sanitizeFilter` is the second layer, and since mongoose 9.11.4 it also refuses an array on a scalar path. Production TLS is checked on the driver's resolved options. Connection errors and logs carry no credentials. Reads stay on the primary. Nothing is ever dropped. A missing or failed unique or TTL index fails boot.

## Changes from source

Ported:

- Connection event logging (`api/src/infrastructure/database/connect.js:202-218`). Lifecycle owns signals (`api/src/infrastructure/database/connect.js:220-222`).
- The boot-time index check idea (`api/src/infrastructure/database/indexAudit.js:1-17`) and the one-off build discipline (`api/src/scripts/buildMissingIndexes.js:11-24`).
- The DocumentDB 5.0 index matrix and its tests (`api/src/infrastructure/database/docdbIndexSupport.js:10-71`, `api/src/infrastructure/database/__tests__/docdbIndexSupport.test.js:12-58`).
- The no-echo ObjectId rule (`api/src/infrastructure/middleware/objectIdParams.js:83-96`), now a zod schema used through `parseInput`.

- Fixed: global `mongoose.connect` singleton and module-level `isConnected` (`api/src/infrastructure/database/connect.js:7,53-57,123`) -> `createConnection` per app. Pinned by `test/mongo.int.test.ts` > "sanitizeFilter: {email: {$ne: null}} throws CastError; trusted({$gt: 0}) works; another connection is unaffected".
- Fixed: `indexAudit` compares key specs by hand and ignores `unique` (`api/src/infrastructure/database/indexAudit.js:19-24,51-55`) -> `diffIndexes()`. Pinned by `test/mongo.int.test.ts` > "ensureIndexes builds a declared unique index before the first write, and a duplicate insert gives isDuplicateKeyError".
- Fixed: `autoIndex` left at its default, so production silently ran without indexes (`api/src/infrastructure/database/indexAudit.js:4-11`) -> explicit step before listen with a fail-boot rule for unique and TTL. Pinned by `test/mongo.int.test.ts` > "ensureIndexes fails boot when a unique index cannot build over duplicates".
- Fixed: no filter sanitization (`api/src/modules/ai/controllers/tavusWebhookController.js:101`) -> `sanitizeFilter` plus the scalar rule. Pinned by `test/mongo.int.test.ts` > "sanitizeFilter: {email: {$ne: null}} throws CastError; trusted({$gt: 0}) works; another connection is unaffected"; `test/mongo.int.test.ts` > "sanitizeFilter regression guard: passing sanitizeFilter only in createConnection options does NOT enable it"; `test/mongo.int.test.ts` > "sanitizeFilter limit: an array filter value is cast to $in and matches".

- Replaced: `secondaryPreferred` in the production URI forced per-transaction overrides (`api/src/modules/emailDelivery/services/emailDeliveryOutbox.js:97-99`) -> primary reads. The product URI carries `readPreference`, and the module cannot pin it. Section 3's session tests depend on primary reads.

Dropped:

- X.509 env-var branches and the `DOCDB_CA_PATH` branch (`api/src/infrastructure/database/connect.js:30-111`): URI parameters carry the same information.
- `maxPoolSize: 25` (`api/src/shared/config/index.js:318-320`) -> driver default.
- `loadModels.js` filesystem walk: stores register their models on the connection.
- The `objectIdParam` router helper: one validation path (`parseInput`) instead of two.

## Local changes

- mongoose 9.11.2 to 9.11.4 (`package.json`, 2026-11-11), with the API, for the advisories osv-scanner reports on 9.11.2 (GHSA-6972-9mcm-vhwj, GHSA-8332-j7wj-wjw4, GHSA-gg4r-jv3p-qx3c, GHSA-wr5m-5jph-8m96). A patch release, published 2026-10-23, past the 7-day release-age gate. Two behaviors changed under `sanitizeFilter`: the `createConnection` option is honored (it was ignored, which is why `src/connect.ts` sets it on the connection, and still does), and an array on a scalar path is refused instead of cast to `$in`. Pinned by `sanitizeFilter regression guard: since mongoose 9.11.4, sanitizeFilter in createConnection options enables it` and `sanitizeFilter: an array filter value on a scalar path is refused, not cast to $in` (`test/mongo.int.test.ts`), and by the rest of this module's suite and the API's, on the new version.
