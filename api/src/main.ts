// Composition root, from api/kit/server-core/MODULE.md "Wire it in". The only file that reads process.env.
import { z } from 'zod';
import { configSchema as serverSchema, createLogger, createServer, loadEnv } from '@ckeith26/server-core';
import { configSchema as mongoSchema, connectMongo, ensureIndexes } from '@ckeith26/mongo';
import { configSchema as redisSchema, createRedis } from '@ckeith26/redis';
import { createRateLimiter, ipKey, rateLimit } from '@ckeith26/rate-limit';
import { configSchema as authSchema, createAuth, createMongoAuthStores } from '@ckeith26/auth';
import { createTownwiseApi } from './app.ts';
import { createManagedIdentityTokenSource, resolveManagedIdentity } from './azure-identity.ts';
import { createAnthropicChatModel } from './chat/model.ts';
import { configSchema as townwiseSchema, resolveTownwiseConfig } from './config.ts';
import { createSendMagicLink } from './email.ts';
import { createAcsTransport } from './mail/acs.ts';
import { createMailer, OFF_MAILER } from './mail/mailer.ts';
import { createGooglePlacesClient } from './places/google.ts';

// ANTHROPIC_API_KEY and GOOGLE_PLACES_API_KEY are optional: absent, the tuning chat or the Places proxy is off. Each
// goes no further than the client built here. IDENTITY_ENDPOINT and IDENTITY_HEADER are set by Container Apps for the
// managed identity, and AZURE_CLIENT_ID by containerapp.tf; they are read only when email is on.
const { ANTHROPIC_API_KEY, GOOGLE_PLACES_API_KEY, IDENTITY_ENDPOINT, IDENTITY_HEADER, AZURE_CLIENT_ID, ...config } = loadEnv(z.object({
  ...serverSchema.shape, ...mongoSchema.shape, ...redisSchema.shape, ...authSchema.shape, ...townwiseSchema.shape,
  ANTHROPIC_API_KEY: z.string().optional(),
  GOOGLE_PLACES_API_KEY: z.string().optional(),
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
// Email (spec D14) is on when EMAIL_ENDPOINT is set; it then needs the managed identity, or boot fails.
const { email, emailReplyTo, webUrl } = resolveTownwiseConfig(config);
const mailer = email === null ? OFF_MAILER : createMailer({
  transport: createAcsTransport({
    endpoint: email.endpoint,
    sender: email.sender,
    tokens: createManagedIdentityTokenSource({
      identity: resolveManagedIdentity({ IDENTITY_ENDPOINT, IDENTITY_HEADER, AZURE_CLIENT_ID }, 'EMAIL_ENDPOINT'),
      now,
    }),
  }),
  logger, webUrl, replyTo: emailReplyTo,
});
const api = createTownwiseApi({ config, logger, connection: mongo.connection, authStores, auth, redis: redis.client, now, chat, places, mailer });
await ensureIndexes(mongo.connection, { logger });   // after every store has registered its models
await redis.ready(3000);                             // bounded; logs and continues on false
const ceiling = createRateLimiter({ redis: redis.client, name: 'app:api-ceiling', limit: 2000, windowSeconds: 60 });
const server = createServer({
  config, logger,
  routes: [{ path: '/auth', router: auth.router }, { path: '/api', router: api }],
  middleware: [rateLimit({ limiter: ceiling, key: ipKey, whenStoreDown: 'allow', logger })],
  // The mail drain first, after the HTTP drain: a send still in flight when its 2 seconds end is lost.
  onShutdown: [{ name: 'mail', close: () => mailer.idle() }, redis, mongo],
});
await server.listen();
