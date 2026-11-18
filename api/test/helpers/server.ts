// Townwise test harness (spec Section 20). The kit's helpers are not exported, so this composes the
// public kit API: server-core's createServer with /auth (createAuth) and /api (createTownwiseApi).
import { createHash, randomBytes, type KeyObject } from 'node:crypto';

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

import { createActivityRecorder, OFF_ACTIVITY } from '../../src/access/activity.ts';
import type { TownwiseRoute } from '../../src/access/routes.ts';
import { createTownwiseApi, createTownwiseContext, createTownwiseLab, type TownwiseContext } from '../../src/app.ts';
import type { CalendarFetcher } from '../../src/calendar/fetch.ts';
import type { GoogleCalendarClient, revokeGoogleGrant } from '../../src/calendar/google.ts';
import type { ChatModel } from '../../src/chat/model.ts';
import { createTurnRunner, type TurnRunner } from '../../src/chat/turn-runner.ts';
import { configSchema as townwiseSchema } from '../../src/config.ts';
import { createAiReadActions } from '../../src/files/ai-actions.ts';
import { createAiReader, type AiReader, type AiReaderDeps, type OnAiRead } from '../../src/files/ai-reader.ts';
import type { FileBlobs } from '../../src/files/blobs.ts';
import type { FileReaderModel } from '../../src/files/extract/reader.ts';
import type { AiTextInput, AiTextOutcome } from '../../src/files/parse/ai-text.ts';
import { createFileWorker, type FileWorker, type FileWorkerDeps } from '../../src/files/worker.ts';
import type { LabCaller } from '../../src/lab/caller.ts';
import type { LabRunner } from '../../src/lab/runner.ts';
import type { MailTransport } from '../../src/mail/acs.ts';
import { createMailer, OFF_MAILER, type Mailer } from '../../src/mail/mailer.ts';
import type { PeopleData } from '../../src/people-in-town/sources.ts';
import { createActivityDayStore } from '../../src/stores/activity-days.ts';
import { createTownwiseStores } from '../../src/stores/index.ts';
import type { PlacesClient } from '../../src/places/google.ts';
import type { StaticMapSigner } from '../../src/places/static-map.ts';
import { testLabCaller } from './lab.ts';
import { waitForRedis } from './redis-ready.ts';

export const WEB_ORIGIN = 'https://app.example.test';
export const STAFF_EMAIL = 'staff@townwise.test';
export const MINUTE = 60 * 1000;
/** The Reply-To and web origin a test server's mailer uses. */
export const MAIL_REPLY_TO = 'team@townwise.test';
export const MAIL_WEB_URL = 'http://localhost:8081';

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
  /** The context the server's routes run with, for calling services directly (the weekly refresh's starts, say). */
  readonly ctx: TownwiseContext;
  readonly mail: MagicLinkMessage[];
  /** Townwise's mailer: over `mailTransport` when one was given, else OFF_MAILER. Await idle() before asserting. */
  readonly mailer: Mailer;
  /** The file reader, when the server was started with `reader`. */
  readonly reader: FileWorker | null;
  /** Reading with TownwiseAI, when the server was started with `aiReader`; tests drive it with nudge() and settled(). */
  readonly aiReader: AiReader | null;
  /** The process's TownwiseAI turn runner, first in onShutdown as in main.ts. */
  readonly turnRunner: TurnRunner;
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
  /** The tuning chat's model, a scripted fake (helpers/chat-model.ts); absent, the chat is off. */
  chat?: ChatModel;
  /** A tuning chat turn's time limit; absent, the production 150 seconds. */
  chatTurnTimeLimitMs?: number;
  /** Google Places, over a fake fetch (helpers/places-fetch.ts); absent, the Places proxy is off. */
  places?: PlacesClient;
  /** Townwise's emails, through a capturing transport (helpers/mail.ts); absent, email is off. */
  mailTransport?: MailTransport;
  /** Signs the confirm card's map URL (src/places/static-map.ts); absent, details answers map: null. */
  placesMap?: StaticMapSigner;
  /** Client file storage (memory-blobs.ts, or Azurite); absent, stored files are off. */
  files?: FileBlobs;
  /** Runs the file reader on `files`; tests drive it with nudge() and settled(). */
  reader?: Partial<Pick<FileWorkerDeps, 'parse' | 'leaseMs' | 'extract' | 'filesMonthlyBudgetUsd'>>;
  /**
   * Reading with TownwiseAI on `files`, over a scripted model (no call leaves the test); absent, it is off and its route
   * answers 503 ai_unavailable. The budget defaults to 5 dollars, as in production. `onRead` defaults to production's
   * actions (files/ai-actions.ts) on this server's stores, blobs and lab; `aroundOnRead` wraps those (to fail or delete
   * something around them).
   */
  aiReader?: { model: FileReaderModel; aroundOnRead?: (actions: OnAiRead) => OnAiRead }
    & Partial<Pick<AiReaderDeps, 'leaseMs' | 'extractText' | 'onRead' | 'filesMonthlyBudgetUsd'>>;
  /**
   * Reading the ordering setup with TownwiseAI (D41), over a scripted model (no call leaves the test); absent, it is off
   * and its route answers 503 ai_unavailable. `setupReadTimeMs` shortens its time limit; `setupReadText` scripts the
   * AI text thread a file's text is made with.
   */
  setupReader?: FileReaderModel;
  setupReadTimeMs?: number;
  setupReadText?: (input: AiTextInput) => Promise<AiTextOutcome>;
  /** U13A: synthetic headcount inputs for people in town; absent, the committed (empty) sources. */
  peopleData?: PeopleData;
  /** The forecast lab's runner (helpers/lab.ts has a fake); absent, calibrations are off. /lab is mounted either way. */
  labRunner?: LabRunner;
  /**
   * Who may call /lab; absent, helpers/lab.ts's testLabCaller (the lab identity's token, signed by the test key) when
   * there is a runner, and nobody (/lab answers 404) when there is none, as main.ts builds both or neither.
   */
  labCaller?: LabCaller;
  /** Seals owner calendar links; absent, links are off (503 calendar_links_unavailable). */
  calendarKey?: KeyObject;
  /** Fetches owner calendar links (helpers over a local server); absent, the guarded fetcher over the network. */
  calendarFetcher?: CalendarFetcher;
  /** Google calendars, over a fake client (helpers/google.ts) with its client id; absent, they are off (503). */
  googleCalendar?: GoogleCalendarClient;
  googleCalendarClientId?: string;
  /** Revokes a Google grant (helpers/google.ts has a fake that records each call); absent, nothing is revoked. */
  revokeGoogle?: typeof revokeGoogleGrant;
  /**
   * Records active days (access/activity.ts) as production does, the recorder at `ctx.activity` (await its idle() before
   * asserting); absent, OFF_ACTIVITY, so other suites' write checks stay about their own routes.
   */
  activity?: boolean;
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
    await waitForRedis(redis);
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
    const mailer = opts?.mailTransport === undefined
      ? OFF_MAILER
      : createMailer({ transport: opts.mailTransport, logger, webUrl: MAIL_WEB_URL, replyTo: MAIL_REPLY_TO });
    const files = opts?.files;
    const reader = files === undefined || opts?.reader === undefined ? null : createFileWorker({
      connection: mongo.connection, stores: createTownwiseStores(mongo.connection), authStores, blobs: files, logger, now: clock.now,
      replicaId: 'test-reader', pollMs: 60_000, ...opts.reader,
    });
    const turnRunner = createTurnRunner({ stores: createTownwiseStores(mongo.connection), logger, now: clock.now });
    const baseDeps = {
      config, logger, connection: mongo.connection, authStores, auth, redis: redis.client, now: clock.now, chat: opts?.chat,
      chatTurnTimeLimitMs: opts?.chatTurnTimeLimitMs, turnRunner, places: opts?.places, mailer, placesMap: opts?.placesMap,
      files, fileWorker: reader ?? undefined, setupReader: opts?.setupReader, setupReadTimeMs: opts?.setupReadTimeMs,
      setupReadText: opts?.setupReadText,
      peopleData: opts?.peopleData, labRunner: opts?.labRunner,
      labCaller: opts?.labCaller ?? (opts?.labRunner === undefined ? undefined : testLabCaller(clock.now)),
      calendarKey: opts?.calendarKey, calendarFetcher: opts?.calendarFetcher, googleCalendar: opts?.googleCalendar,
      googleCalendarClientId: opts?.googleCalendarClientId, revokeGoogle: opts?.revokeGoogle,
      activity: opts?.activity === true
        ? createActivityRecorder({ connection: mongo.connection, activityDays: createActivityDayStore(mongo.connection), logger, now: clock.now })
        : OFF_ACTIVITY,
    };
    const { aroundOnRead = (actions: OnAiRead) => actions, ...readerOpts } = opts?.aiReader ?? { model: undefined };
    const aiReader = files === undefined || readerOpts.model === undefined ? null : createAiReader({
      connection: mongo.connection, stores: createTownwiseStores(mongo.connection), authStores, blobs: files, logger, now: clock.now,
      pollMs: 60_000, filesMonthlyBudgetUsd: 5, onRead: aroundOnRead(createAiReadActions(createTownwiseContext(baseDeps))), ...readerOpts,
      model: readerOpts.model,
    });
    const deps = { ...baseDeps, aiReader: aiReader ?? undefined };
    const apiRouter = createTownwiseApi(deps);
    // As main.ts mounts them.
    const routes: RouteMount[] = [
      { path: '/auth', router: auth.router }, { path: '/api', router: apiRouter }, { path: '/lab', router: createTownwiseLab(deps) },
    ];
    if (opts?.probe !== undefined) routes.push({ path: '/probe', router: createTownwiseApi(deps, opts.probe) });
    await ensureIndexes(mongo.connection, { logger, buildAtBoot: () => true });
    const readers = [reader, aiReader].filter((each): each is FileWorker | AiReader => each !== null);
    const server = createServer({ config, logger, routes, onShutdown: [turnRunner, ...readers, redis, mongo], exit: () => undefined });
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
      ctx: createTownwiseContext(deps),
      mail,
      mailer,
      reader,
      aiReader,
      turnRunner,
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

const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify']);

/**
 * Every write the app's connection sends while `run` runs, in order, as `<command> <collection>`. The kit's stores share
 * the connection, so its writes show too.
 */
export async function writesDuring(server: TownwiseTestServer, run: () => Promise<void>): Promise<string[]> {
  const writes: string[] = [];
  const listener = (event: mongoose.mongo.CommandStartedEvent): void => {
    if (WRITE_COMMANDS.has(event.commandName)) writes.push(`${event.commandName} ${String(event.command[event.commandName])}`);
  };
  const client = server.connection.getClient();
  client.on('commandStarted', listener);
  try {
    await run();
  } finally {
    client.off('commandStarted', listener);
  }
  return writes;
}

/** Parsed JSON log lines. */
export function logLines(server: TownwiseTestServer): Record<string, unknown>[] {
  return server.logs.map((line) => JSON.parse(line) as Record<string, unknown>);
}
