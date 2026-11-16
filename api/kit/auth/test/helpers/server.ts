import { randomBytes } from 'node:crypto';

import { connectMongo, ensureIndexes, configSchema as mongoSchema } from '@ckeith26/mongo';
import { createRedis, configSchema as redisSchema } from '@ckeith26/redis';
import {
  createLogger,
  createServer,
  loadEnv,
  configSchema as serverSchema,
  type RouteMount,
} from '@ckeith26/server-core';
import type { Redis } from 'ioredis';
import type { Connection } from 'mongoose';
import { inject } from 'vitest';
import { z } from 'zod';

import { parseKeyring, configSchema as authSchema } from '../../src/config.ts';
import { createAuth, type Auth, type AuthDeps, type SignInResult } from '../../src/create-auth.ts';
import { createMongoAuthStores } from '../../src/stores/mongo/index.ts';
import type { AuthStores, Platform } from '../../src/stores/types.ts';
import { createTokenCrypto } from '../../src/token-crypto.ts';
import { generateRecoveryCodes } from '../../src/totp/factor.ts';
import { generateSecret } from '../../src/totp/totp.ts';
import { call, CookieJar, WEB_ORIGIN } from './http.ts';
import { createMailCapture, parseLink, type MailCapture } from './mail.ts';
import { waitForRedis } from './redis-ready.ts';

export interface TestDb {
  readonly connection: Connection;
  readonly stores: AuthStores;
  close(): Promise<void>;
}

function testMongoUri(): string {
  const url = new URL(inject('mongoUri'));
  url.pathname = '/auth-test';
  url.searchParams.set('directConnection', 'true');
  return url.toString();
}

/** connectMongo on inject('mongoUri') with directConnection and database auth-test, then drops, stores, indexes. */
export async function openTestDb(): Promise<TestDb> {
  const logger = createLogger({ LOG_LEVEL: 'silent' });
  const mongo = await connectMongo({
    config: { NODE_ENV: 'test', MONGODB_URI: testMongoUri() },
    logger,
  });
  await mongo.connection.dropDatabase();
  const stores = createMongoAuthStores(mongo.connection);
  await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => true });
  return {
    connection: mongo.connection,
    stores,
    close: () => mongo.close(),
  };
}

const envSchema = z.object({
  ...serverSchema.shape,
  ...mongoSchema.shape,
  ...redisSchema.shape,
  ...authSchema.shape,
});

export interface TestClock {
  now(): Date;
  advance(ms: number): void;
}

export interface AuthTestServer {
  readonly url: string;
  readonly auth: Auth;
  readonly stores: AuthStores;
  readonly connection: Connection;
  readonly redis: Redis;
  readonly mail: MailCapture;
  readonly logs: string[];
  readonly clock: TestClock;
  readonly env: Record<string, string>;
  close(): Promise<void>;
}

function createClock(): TestClock {
  let current = Date.parse('2026-06-01T12:00:00.000Z');
  return {
    now: () => new Date(current),
    advance(ms: number) {
      current += ms;
    },
  };
}

function envDefaults(): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PORT: '0',
    LOG_LEVEL: 'trace',
    TRUST_PROXY: 'loopback',
    CORS_ORIGINS: WEB_ORIGIN,
    HTTP_KEEP_ALIVE_TIMEOUT_MS: '65000',
    SHUTDOWN_TIMEOUT_MS: '6000',
    AUTH_ISSUER: 'https://api.example.test',
    AUTH_MAGIC_LINK_URL: `${WEB_ORIGIN}/auth/magic`,
    AUTH_TOTP_ISSUER: 'Kit Test',
    AUTH_JWT_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    AUTH_ENCRYPTION_KEYS: `e1:${randomBytes(32).toString('base64')}`,
    MONGODB_URI: testMongoUri(),
    REDIS_URL: inject('redisUrl'),
    REDIS_KEY_PREFIX: 'auth-test:',
  };
}

/** Composes the four schemas, drops data unless keepData, and listens with ensureIndexes already built. */
export async function startAuthServer(opts?: {
  env?: Record<string, string | undefined>;
  deps?: Partial<AuthDeps>;
  routes?: (auth: Auth) => RouteMount[];
  keepData?: boolean;
}): Promise<AuthTestServer> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...envDefaults(), ...opts?.env })) {
    if (typeof value === 'string') env[key] = value;
  }
  const config = loadEnv(envSchema, env);
  const logs: string[] = [];
  const logger = createLogger({ LOG_LEVEL: config.LOG_LEVEL }, {
    destination: {
      write(message: string) {
        for (const line of message.split('\n')) {
          if (line.trim() !== '') logs.push(line);
        }
      },
    },
  });
  const mongo = await connectMongo({ config, logger });
  const redis = createRedis({ config, logger });
  const clock = createClock();
  const mail = createMailCapture();
  try {
    await waitForRedis(redis);
    if (opts?.keepData !== true) {
      await mongo.connection.dropDatabase();
      await redis.client.flushdb();
    }
    const stores = createMongoAuthStores(mongo.connection);
    await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => true });
    const auth = createAuth({
      config: opts?.deps?.config ?? config,
      stores: opts?.deps?.stores ?? stores,
      redis: opts?.deps?.redis ?? redis.client,
      logger: opts?.deps?.logger ?? logger,
      sendMagicLink: (message) => {
        const custom = opts?.deps?.sendMagicLink;
        return custom !== undefined ? custom(message) : mail.sendMagicLink(message);
      },
      now: () => {
        const custom = opts?.deps?.now;
        return custom !== undefined ? custom() : clock.now();
      },
      ...(opts?.deps?.onUserCreated !== undefined ? { onUserCreated: opts.deps.onUserCreated } : {}),
      ...(opts?.deps?.googleKeys !== undefined ? { googleKeys: opts.deps.googleKeys } : {}),
    });
    const server = createServer({
      config,
      logger,
      routes: [{ path: '/auth', router: auth.router }, ...(opts?.routes?.(auth) ?? [])],
      onShutdown: [redis, mongo],
      exit: () => undefined,
    });
    const listened = await server.listen();
    return {
      url: `http://127.0.0.1:${String(listened.port)}`,
      auth,
      stores,
      connection: mongo.connection,
      redis: redis.client,
      mail,
      logs,
      clock,
      env,
      close: () => server.shutdown('test'),
    };
  } catch (err) {
    redis.client.disconnect();
    await mongo.close();
    throw err;
  }
}

export async function signIn(
  server: AuthTestServer,
  platform: Platform,
  email: string,
): Promise<{ jar: CookieJar; body: SignInResult }> {
  const jar = new CookieJar();
  const origin = platform === 'web' ? WEB_ORIGIN : undefined;
  const requested = await call(server.url, '/auth/magic-link', {
    json: { email, platform },
    ...(origin !== undefined ? { origin } : {}),
  });
  if (requested.status !== 202) throw new Error(`magic link request failed (${String(requested.status)})`);
  const link = parseLink(server.mail.messages.at(-1)?.url ?? '');
  const redeemed = await call(server.url, '/auth/magic-link/redeem', {
    json: { token: link.token, email: link.email, platform },
    ...(origin !== undefined ? { origin } : {}),
  });
  jar.store(redeemed);
  const body = await redeemed.json() as SignInResult;
  if (redeemed.status !== 200) throw new Error(`magic link redeem failed (${String(redeemed.status)})`);
  return { jar, body };
}

/** Writes an enabled factor for userId, encrypted with the server's own AUTH_ENCRYPTION_KEYS. */
export async function seedTotp(
  server: AuthTestServer,
  userId: string,
  opts?: { lastUsedStep?: number },
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const raw = server.env.AUTH_ENCRYPTION_KEYS;
  if (raw === undefined) throw new Error('AUTH_ENCRYPTION_KEYS is missing');
  const cipher = createTokenCrypto(parseKeyring(raw, { min: 32, max: 32 }));
  const secret = generateSecret();
  const codes = generateRecoveryCodes();
  const now = server.clock.now();
  const started = await server.stores.totp.startEnrollment({
    userId,
    secretEnc: cipher.encrypt(secret, `auth_totp:${userId}:secret`),
    pendingExpiresAt: new Date(now.getTime() + 10 * 60 * 1000),
  });
  if (!started) throw new Error('totp seed refused');
  const confirmed = await server.stores.totp.confirmEnrollment({
    userId,
    step: opts?.lastUsedStep ?? -1,
    recoveryCodeHashes: codes.hashes,
    now,
  });
  if (!confirmed) throw new Error('totp seed confirm failed');
  return { secret, recoveryCodes: codes.display };
}
