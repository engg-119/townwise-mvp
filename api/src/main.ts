// Composition root, from backend/server-core/MODULE.md "Wire it in". The only file that reads process.env.
import { z } from 'zod';
import { configSchema as serverSchema, createLogger, createServer, loadEnv } from '@ckeith26/server-core';
import { configSchema as mongoSchema, connectMongo, ensureIndexes } from '@ckeith26/mongo';
import { configSchema as redisSchema, createRedis } from '@ckeith26/redis';
import { createRateLimiter, ipKey, rateLimit } from '@ckeith26/rate-limit';
import { configSchema as authSchema, createAuth, createMongoAuthStores } from '@ckeith26/auth';
import { createTownwiseApi } from './app.ts';
import { configSchema as townwiseSchema } from './config.ts';
import { createSendMagicLink } from './email.ts';

const config = loadEnv(z.object({
  ...serverSchema.shape, ...mongoSchema.shape, ...redisSchema.shape, ...authSchema.shape, ...townwiseSchema.shape,
}), process.env);
const logger = createLogger(config);
const mongo = await connectMongo({ config, logger });
const redis = createRedis({ config, logger });
// One clock for the kit and Townwise: staff windows, view-as grants and audit times read it.
const now = (): Date => new Date();
const authStores = createMongoAuthStores(mongo.connection);
// Google sign-in is on when AUTH_GOOGLE_CLIENT_IDS is set. Townwise does not send magic links (see email.ts).
const auth = createAuth({
  config, logger, redis: redis.client, now,
  stores: authStores,
  sendMagicLink: createSendMagicLink(config),
});
const api = createTownwiseApi({ config, logger, connection: mongo.connection, authStores, auth, redis: redis.client, now });
await ensureIndexes(mongo.connection, { logger });   // after every store has registered its models
await redis.ready(3000);                             // bounded; logs and continues on false
const ceiling = createRateLimiter({ redis: redis.client, name: 'app:api-ceiling', limit: 2000, windowSeconds: 60 });
const server = createServer({
  config, logger,
  routes: [{ path: '/auth', router: auth.router }, { path: '/api', router: api }],
  middleware: [rateLimit({ limiter: ceiling, key: ipKey, whenStoreDown: 'allow', logger })],
  onShutdown: [redis, mongo],
});
await server.listen();
