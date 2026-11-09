// Composition root, from api/kit/server-core/MODULE.md "Wire it in". The only file that reads process.env.
import { z } from 'zod';
import { configSchema as serverSchema, createLogger, createServer, loadEnv } from '@ckeith26/server-core';
import { configSchema as mongoSchema, connectMongo, ensureIndexes } from '@ckeith26/mongo';
import { configSchema as redisSchema, createRedis } from '@ckeith26/redis';
import { createRateLimiter, ipKey, rateLimit } from '@ckeith26/rate-limit';
import { configSchema as authSchema, createAuth, createMongoAuthStores } from '@ckeith26/auth';
import { createTownwiseApi } from './app.ts';
import {
  createAzureCliTokenSource, createManagedIdentityTokenSource, resolveManagedIdentity, usesAzureCli, type AzureTokenSource,
} from './azure-identity.ts';
import { createTownwiseStores } from './stores/index.ts';
import { createAnthropicChatModel } from './chat/model.ts';
import { configSchema as townwiseSchema, filesBackendOf, resolveTownwiseConfig, type FilesBackend } from './config.ts';
import { createSendMagicLink } from './email.ts';
import { createAzureFileBlobs, createAzuriteFileBlobs, storageCredential, type FileBlobs } from './files/blobs.ts';
import { createAnthropicExtractModel } from './files/extract/model.ts';
import { createFileSweeper } from './files/sweeper.ts';
import { createFileWorker } from './files/worker.ts';
import { createAcsTransport } from './mail/acs.ts';
import { createMailer, OFF_MAILER } from './mail/mailer.ts';
import { createGooglePlacesClient } from './places/google.ts';
import { createStaticMapSigner, signingSecretSchema } from './places/static-map.ts';

// ANTHROPIC_API_KEY and GOOGLE_PLACES_API_KEY are optional: absent, the tuning chat and the file reader's AI column
// step, or the Places proxy, are off. Each goes no further than the clients built here. IDENTITY_ENDPOINT and IDENTITY_HEADER are set by Container Apps for the
// managed identity, and AZURE_CLIENT_ID by containerapp.tf; they are read only when email or stored files are on. The confirm card's
// map needs both GOOGLE_MAPS_STATIC_KEY and GOOGLE_MAPS_SIGNING_SECRET: without either there is no map, never an
// unsigned one. A malformed secret refuses boot.
const {
  ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY, GOOGLE_MAPS_STATIC_KEY, GOOGLE_MAPS_SIGNING_SECRET,
  IDENTITY_ENDPOINT, IDENTITY_HEADER, AZURE_CLIENT_ID, ...config
} = loadEnv(z.object({
  ...serverSchema.shape, ...mongoSchema.shape, ...redisSchema.shape, ...authSchema.shape, ...townwiseSchema.shape,
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
  GOOGLE_MAPS_STATIC_KEY: z.string().optional(),
  GOOGLE_MAPS_SIGNING_SECRET: signingSecretSchema.optional(),
  IDENTITY_ENDPOINT: z.string().optional(),
  IDENTITY_HEADER: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
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
const placesMap = GOOGLE_MAPS_STATIC_KEY === undefined || GOOGLE_MAPS_SIGNING_SECRET === undefined
  ? undefined : createStaticMapSigner(GOOGLE_MAPS_STATIC_KEY, GOOGLE_MAPS_SIGNING_SECRET);
// One token source for every Azure feature that is on (a cache per resource), built on first use: the managed identity,
// or, outside production while IDENTITY_ENDPOINT and IDENTITY_HEADER are both unset, the developer's az login.
// `feature` names the variable that turned it on, for the boot error when the identity is missing.
let azureTokens: AzureTokenSource | undefined;
const azureTokensFor = (feature: string): AzureTokenSource => {
  azureTokens ??= usesAzureCli({ IDENTITY_ENDPOINT, IDENTITY_HEADER }, config.NODE_ENV)
    ? createAzureCliTokenSource({ now })
    : createManagedIdentityTokenSource({
      identity: resolveManagedIdentity({ IDENTITY_ENDPOINT, IDENTITY_HEADER, AZURE_CLIENT_ID }, feature),
      now,
    });
  return azureTokens;
};
// Email (spec D14) is on when EMAIL_ENDPOINT is set. In production it then needs the managed identity, or boot fails;
// locally it sends through the developer's az login.
const { email, emailReplyTo, webUrl, filesMonthlyBudgetUsd } = resolveTownwiseConfig(config);
const mailer = email === null ? OFF_MAILER : createMailer({
  transport: createAcsTransport({
    endpoint: email.endpoint,
    sender: email.sender,
    tokens: azureTokensFor('EMAIL_ENDPOINT'),
  }),
  logger, webUrl, replyTo: emailReplyTo,
});

// Stored files are off unless FILES_BLOB_ACCOUNT_URL is set (api/production.env keeps it commented until the runbook's
// "Enable file storage" step). In Azure the API signs in with its managed identity, so boot fails without it. Locally,
// Azurite through its connection string; config.ts refuses that in production.
async function fileBlobsFor(backend: FilesBackend | null): Promise<FileBlobs | undefined> {
  if (backend === null) return undefined;
  if (backend.kind === 'azurite') return createAzuriteFileBlobs(backend.connectionString);
  return createAzureFileBlobs(backend.accountUrl, storageCredential(azureTokensFor('FILES_BLOB_ACCOUNT_URL')));
}
const files = await fileBlobsFor(filesBackendOf(config));
// The file reader runs in this process while stored files are on (files/worker.ts). Its AI column step is on with the
// same ANTHROPIC_API_KEY as the tuning chat, within TOWNWISE_FILES_MONTHLY_BUDGET_USD.
const fileWorker = files === undefined ? undefined : createFileWorker({
  connection: mongo.connection, stores: createTownwiseStores(mongo.connection), authStores, blobs: files, logger, now,
  extract: ANTHROPIC_API_KEY === undefined ? undefined : createAnthropicExtractModel(ANTHROPIC_API_KEY), filesMonthlyBudgetUsd,
});
// The daily sweep (retention, unfinished uploads, orphans) runs while stored files are on; one replica takes it a day.
const fileSweeper = files === undefined ? undefined : createFileSweeper({
  connection: mongo.connection, stores: createTownwiseStores(mongo.connection), blobs: files, logger, now,
});
const api = createTownwiseApi({
  config, logger, connection: mongo.connection, authStores, auth, redis: redis.client, now, chat, places, placesMap, mailer,
  files, fileWorker,
});
await ensureIndexes(mongo.connection, { logger });   // after every store has registered its models
fileWorker?.start();
fileSweeper?.start();
await redis.ready(3000);                             // bounded; logs and continues on false
const ceiling = createRateLimiter({ redis: redis.client, name: 'app:api-ceiling', limit: 2000, windowSeconds: 60 });
const server = createServer({
  config, logger,
  routes: [{ path: '/auth', router: auth.router }, { path: '/api', router: api }],
  middleware: [rateLimit({ limiter: ceiling, key: ipKey, whenStoreDown: 'allow', logger })],
  // The mail drain first, after the HTTP drain: a send still in flight when its 2 seconds end is lost. The reader and
  // the sweeper stop next, while the database is still open.
  onShutdown: [
    { name: 'mail', close: () => mailer.idle() }, ...(fileWorker === undefined ? [] : [fileWorker]),
    ...(fileSweeper === undefined ? [] : [fileSweeper]), redis, mongo,
  ],
});
await server.listen();
