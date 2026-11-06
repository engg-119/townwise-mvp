// Composition root, from api/kit/server-core/MODULE.md "Wire it in". The only file that reads process.env.
import { z } from 'zod';
import { ConfigError, configSchema as serverSchema, createLogger, createServer, loadEnv } from '@ckeith26/server-core';
import { configSchema as mongoSchema, connectMongo, ensureIndexes } from '@ckeith26/mongo';
import { configSchema as redisSchema, createRedis } from '@ckeith26/redis';
import { createRateLimiter, ipKey, rateLimit } from '@ckeith26/rate-limit';
import { configSchema as authSchema, createAuth, createMongoAuthStores } from '@ckeith26/auth';
import { createTownwiseApi } from './app.ts';
import { createAnthropicChatModel } from './chat/model.ts';
import { configSchema as townwiseSchema, filesBackendOf, type FilesBackend } from './config.ts';
import { createSendMagicLink } from './email.ts';
import { createAzuriteFileBlobs, type FileBlobs } from './files/blobs.ts';
import { createGooglePlacesClient } from './places/google.ts';

// ANTHROPIC_API_KEY and GOOGLE_PLACES_API_KEY are optional: absent, the tuning chat or the Places proxy is off. Each
// goes no further than the client built here.
const { ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY, ...config } = loadEnv(z.object({
  ...serverSchema.shape, ...mongoSchema.shape, ...redisSchema.shape, ...authSchema.shape, ...townwiseSchema.shape,
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
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
const chat = ANTHROPIC_API_KEY === undefined ? undefined : createAnthropicChatModel(ANTHROPIC_API_KEY);
const places = GOOGLE_PLACES_API_KEY === undefined ? undefined : createGooglePlacesClient(GOOGLE_PLACES_API_KEY);

// Stored files are off unless FILES_BLOB_ACCOUNT_URL is set (api/production.env keeps it commented until the runbook's
// "Enable file storage" step). Locally, Azurite through its connection string; config.ts refuses that in production.
async function fileBlobsFor(backend: FilesBackend | null): Promise<FileBlobs | undefined> {
  if (backend === null) return undefined;
  if (backend.kind === 'azurite') return createAzuriteFileBlobs(backend.connectionString);
  // SEAM (U1, api/src/azure-identity.ts): the managed identity token source is not built yet. When it lands, this
  // becomes createAzureFileBlobs(backend.accountUrl, <its TokenCredential adapter for https://storage.azure.com>).
  throw new ConfigError('FILES_BLOB_ACCOUNT_URL', 'stored files in Azure need the managed identity token source, which is not built yet');
}
const files = await fileBlobsFor(filesBackendOf(config));
const api = createTownwiseApi({ config, logger, connection: mongo.connection, authStores, auth, redis: redis.client, now, chat, places, files });
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
