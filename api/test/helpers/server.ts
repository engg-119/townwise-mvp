// Townwise test harness (spec Section 20). The kit's helpers are not exported, so this composes the
// public kit API: server-core's createServer with /auth (createAuth) and /api (createTownwiseApi).
import { createHash, randomBytes } from 'node:crypto';

import {
  configSchema as authSchema, createAuth, createMongoAuthStores,
  type Auth, type AuthStores, type MagicLinkMessage,
} from '@ckeith26/auth';
import { configSchema as mongoSchema, connectMongo, ensureIndexes } from '@ckeith26/mongo';
import { configSchema as redisSchema, createRedis, type RedisHandle } from '@ckeith26/redis';
import { configSchema as serverSchema, createLogger, createServer, loadEnv, type RouteMount } from '@ckeith26/server-core';
import type { Router } from 'express';
import type mongoose from 'mongoose';
import type { Connection } from 'mongoose';
import { inject } from 'vitest';
import { z } from 'zod';

import type { TownwiseRoute } from '../../src/access/routes.ts';
import { createTownwiseApi } from '../../src/app.ts';
import { configSchema as townwiseSchema } from '../../src/config.ts';

export const WEB_ORIGIN = 'https://app.example.test';
export const STAFF_EMAIL = 'staff@townwise.test';
export const MINUTE = 60 * 1000;

export interface TestClock {
  readonly now: () => Date;
  readonly advance: (ms: number) => void;
}

export interface TownwiseTestServer {
  readonly url: string;
  readonly connection: Connection;
  readonly authStores: AuthStores;
  readonly auth: Auth;
  readonly redis: RedisHandle['client'];
  readonly clock: TestClock;
  /** Every log line, raw JSON. */
  readonly logs: string[];
  /** Mongo command names, from command monitoring on the app's own connection. */
  readonly commands: string[];
  /** The /api router createTownwiseApi returned. */
  readonly apiRouter: Router;
  readonly mail: MagicLinkMessage[];
  close(): Promise<void>;
}

const envSchema = z.object({
  ...serverSchema.shape, ...mongoSchema.shape, ...redisSchema.shape, ...authSchema.shape, ...townwiseSchema.shape,
});

function testMongoUri(): string {
  const url = new URL(inject('mongoUri'));
  url.pathname = '/townwise-test';
  url.searchParams.set('directConnection', 'true');
  url.searchParams.set('monitorCommands', 'true');
  return url.toString();
}

function createClock(): TestClock {
  let current = Date.parse('2026-06-01T12:00:00.000Z');
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

/** Drops the database and flushes Valkey (which also resets the kit's magic-link send limits). */
export async function startTownwiseServer(opts?: {
  env?: Record<string, string>;
  /** Mounted at /probe with the same chain, to exercise policies no product route uses yet. */
  probe?: readonly TownwiseRoute[];
}): Promise<TownwiseTestServer> {
  const env: Record<string, string> = {
    NODE_ENV: 'test',
    PORT: '0',
    LOG_LEVEL: 'trace',
    TRUST_PROXY: 'loopback',
    CORS_ORIGINS: WEB_ORIGIN,
    SHUTDOWN_TIMEOUT_MS: '6000',
    AUTH_ISSUER: 'https://api.example.test',
    AUTH_MAGIC_LINK_URL: `${WEB_ORIGIN}/auth/magic`,
    AUTH_TOTP_ISSUER: 'Townwise Test',
    AUTH_JWT_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    AUTH_ENCRYPTION_KEYS: `e1:${randomBytes(32).toString('base64')}`,
    MONGODB_URI: testMongoUri(),
    REDIS_URL: inject('redisUrl'),
    REDIS_KEY_PREFIX: 'townwise-test:',
    TOWNWISE_SUPERADMIN_EMAILS: STAFF_EMAIL,
    ...opts?.env,
  };
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
  const commands: string[] = [];
  mongo.connection.getClient().on('commandStarted', (event: mongoose.mongo.CommandStartedEvent) => {
    commands.push(event.commandName);
  });
  const clock = createClock();
  const mail: MagicLinkMessage[] = [];
  try {
    if (!(await redis.ready(3000))) throw new Error('redis not ready');
    await mongo.connection.dropDatabase();
    await redis.client.flushdb();
    const authStores = createMongoAuthStores(mongo.connection);
    const auth = createAuth({
      config, logger, redis: redis.client, stores: authStores, now: clock.now,
      sendMagicLink: (message) => {
        mail.push(message);
        return Promise.resolve();
      },
    });
    const deps = { config, logger, connection: mongo.connection, authStores, auth, redis: redis.client, now: clock.now };
    const apiRouter = createTownwiseApi(deps);
    const routes: RouteMount[] = [{ path: '/auth', router: auth.router }, { path: '/api', router: apiRouter }];
    if (opts?.probe !== undefined) routes.push({ path: '/probe', router: createTownwiseApi(deps, opts.probe) });
    await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => true });
    const server = createServer({ config, logger, routes, onShutdown: [redis, mongo], exit: () => undefined });
    const listened = await server.listen();
    return {
      url: `http://127.0.0.1:${String(listened.port)}`,
      connection: mongo.connection,
      authStores,
      auth,
      redis: redis.client,
      clock,
      logs,
      commands,
      apiRouter,
      mail,
      close: () => server.shutdown('test'),
    };
  } catch (err) {
    redis.client.disconnect();
    await mongo.close();
    throw err;
  }
}

export interface TestSession {
  readonly userId: string;
  readonly sessionId: string;
  accessToken: string;
  refreshToken: string;
}

/** fetch against the test server. A session sends its access token as a native Bearer credential. */
export function call(server: Pick<TownwiseTestServer, 'url'>, path: string, init?: {
  method?: string;
  json?: unknown;
  rawBody?: string;
  session?: TestSession;
}): Promise<Response> {
  const headers = new Headers();
  if (init?.json !== undefined || init?.rawBody !== undefined) headers.set('content-type', 'application/json');
  if (init?.session !== undefined) headers.set('authorization', `Bearer ${init.session.accessToken}`);
  const body = init?.rawBody ?? (init?.json !== undefined ? JSON.stringify(init.json) : undefined);
  return fetch(new URL(path, server.url), {
    method: init?.method ?? (body !== undefined ? 'POST' : 'GET'),
    headers,
    redirect: 'manual',
    ...(body !== undefined ? { body } : {}),
  });
}

interface NativeSignIn {
  status: string;
  user: { id: string };
  session: { id: string };
  accessToken: string;
  refreshToken: string;
}

/** Signs in through the kit's magic-link routes (native), so no fake Google signer is needed. */
export async function signIn(server: TownwiseTestServer, email: string): Promise<TestSession> {
  const requested = await call(server, '/auth/magic-link', { json: { email, platform: 'native' } });
  if (requested.status !== 202) throw new Error(`magic link request failed (${String(requested.status)})`);
  const url = server.mail.at(-1)?.url ?? '';
  const params = new URLSearchParams(new URL(url).hash.slice(1));
  const redeemed = await call(server, '/auth/magic-link/redeem', {
    json: { token: params.get('token') ?? '', email: params.get('email') ?? '', platform: 'native' },
  });
  if (redeemed.status !== 200) throw new Error(`magic link redeem failed (${String(redeemed.status)})`);
  const body = await redeemed.json() as NativeSignIn;
  if (body.status !== 'signed_in') throw new Error(`sign-in answered ${body.status}`);
  return { userId: body.user.id, sessionId: body.session.id, accessToken: body.accessToken, refreshToken: body.refreshToken };
}

/** Access tokens last 600 seconds; call this after advancing the clock past them. */
export async function refresh(server: TownwiseTestServer, session: TestSession): Promise<void> {
  const res = await call(server, '/auth/refresh', { json: { platform: 'native', refreshToken: session.refreshToken } });
  if (res.status !== 200) throw new Error(`refresh failed (${String(res.status)})`);
  const body = await res.json() as { accessToken: string; refreshToken: string };
  session.accessToken = body.accessToken;
  session.refreshToken = body.refreshToken;
}

/** Seeds an enabled TOTP factor through the public TotpStore. The resolver reads only status and enabledAt. */
export async function makeStaff(server: TownwiseTestServer, userId: string, opts: { enabledAt: Date }): Promise<void> {
  const started = await server.authStores.totp.startEnrollment({
    userId,
    secretEnc: 'unused-by-townwise-tests',
    pendingExpiresAt: new Date(opts.enabledAt.getTime() + 10 * MINUTE),
  });
  if (!started) throw new Error('totp seed refused');
  const confirmed = await server.authStores.totp.confirmEnrollment({
    userId, step: 0, recoveryCodeHashes: [], now: opts.enabledAt,
  });
  if (!confirmed) throw new Error('totp seed confirm failed');
}

/** A staff session that passes the gate: signed in, with codes enabled a minute before the session began. */
export async function signInStaff(server: TownwiseTestServer, email = STAFF_EMAIL): Promise<TestSession> {
  const session = await signIn(server, email);
  await makeStaff(server, session.userId, { enabledAt: new Date(server.clock.now().getTime() - MINUTE) });
  return session;
}

/** Removes the staff factor, so the next staff sign-in is not an MFA challenge. Used in afterEach. */
export async function removeStaffFactor(server: TownwiseTestServer, email = STAFF_EMAIL): Promise<void> {
  const user = await server.authStores.users.findByEmail(email);
  if (user !== null) await server.authStores.totp.remove(user.id);
}

/** The Redis key rate-limit stores for `acct:<userId>` under `name` (keys are SHA-256 hashed). */
export function limiterKey(name: string, userId: string): string {
  return `rl:${name}:${createHash('sha256').update(`acct:${userId}`, 'utf8').digest('base64url')}`;
}

/** Parsed JSON log lines. */
export function logLines(server: TownwiseTestServer): Record<string, unknown>[] {
  return server.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
}
