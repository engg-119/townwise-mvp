// The weekly refresh's background worker (D42, design decision 2): a second composition root beside main.ts. It reads
// the environment through the same schemas (config.ts, the kit's Mongo and logger), builds only what a pass needs (the
// stores on one Mongo connection and the lab runner; no Valkey, which is the API's sidecar, and no HTTP server), runs
// one pass of lab/schedule.ts, closes its connection and exits 0, or 1 on an error. The API starts no loop of its own.
//
//   npm run worker:forecasts -w @townwise/api                 one pass (production's scheduled job, hourly)
//   npm run worker:forecasts -w @townwise/api -- --loop       a pass at start and then every hour, until stopped
//   npm run worker:forecasts -w @townwise/api -- --now <iso>  development only: which locations are due is decided as
//                                                             if it were <iso> (what the pass records keeps the real time)
//
// With TOWNWISE_LAB_RUNNER=local the job a pass starts calls back to the API at TOWNWISE_LAB_API_URL, so the API and the
// worker must share TOWNWISE_LAB_LOCAL_SECRET (development only, like the local runner). PATH and HOME go only to a
// local job; IDENTITY_ENDPOINT, IDENTITY_HEADER and AZURE_CLIENT_ID only to the Azure runner's managed identity.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { configSchema as mongoSchema, connectMongo, ensureIndexes } from '@ckeith26/mongo';
import { ConfigError, configSchema as serverSchema, createLogger, loadEnv } from '@ckeith26/server-core';
import { z } from 'zod';

import { createAzureCliTokenSource, createManagedIdentityTokenSource, resolveManagedIdentity, usesAzureCli } from '../azure-identity.ts';
import { configSchema as townwiseSchema, labRunnerOf, resolveTownwiseConfig } from '../config.ts';
import { createForecastSchedule } from '../lab/schedule.ts';
import { createAzureLabRunner, createLocalLabRunner, type LabRunner } from '../lab/runner.ts';
import { createTownwiseStores } from '../stores/index.ts';

/** How often --loop runs a pass, as production's scheduled job does (cron "5 * * * *"). */
export const WORKER_TICK_MS = 3_600_000;

const envSchema = z.object({
  ...serverSchema.pick({ NODE_ENV: true, LOG_LEVEL: true }).shape, ...mongoSchema.shape, ...townwiseSchema.shape,
  IDENTITY_ENDPOINT: z.string().optional(),
  IDENTITY_HEADER: z.string().optional(),
  AZURE_CLIENT_ID: z.string().optional(),
  PATH: z.string().optional(),
  HOME: z.string().optional(),
});
type WorkerEnv = z.infer<typeof envSchema>;

export interface WorkerDeps {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Tests: the lab runner to use instead of the one the environment builds (null is off). */
  readonly labRunner?: LabRunner | null;
  /** Tests: where log lines go (stdout otherwise). */
  readonly logDestination?: { write(message: string): void };
  /** Tests: --loop's wait between passes; it resolves early when `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Stops --loop (main wires SIGINT and SIGTERM to it). */
  readonly signal?: AbortSignal;
  /** Tests: the clock, shared with a test API's (the real time otherwise); --now still moves only which are due. */
  readonly now?: () => Date;
}

function labRunnerFor(env: WorkerEnv, now: () => Date): LabRunner | null {
  const lab = labRunnerOf(env);
  if (lab === null) return null;
  if (lab.kind === 'local') {
    if (lab.secret === null) {
      throw new ConfigError('TOWNWISE_LAB_LOCAL_SECRET', 'the weekly worker needs the secret the API shares with it, with TOWNWISE_LAB_RUNNER=local');
    }
    return createLocalLabRunner({ projectDir: resolve(lab.projectDir), apiUrl: lab.apiUrl, token: lab.secret, path: env.PATH ?? '', home: env.HOME ?? '' });
  }
  const identity = { IDENTITY_ENDPOINT: env.IDENTITY_ENDPOINT, IDENTITY_HEADER: env.IDENTITY_HEADER, AZURE_CLIENT_ID: env.AZURE_CLIENT_ID };
  const tokens = usesAzureCli(identity, env.NODE_ENV)
    ? createAzureCliTokenSource({ now })
    : createManagedIdentityTokenSource({ identity: resolveManagedIdentity(identity, 'TOWNWISE_LAB_RUNNER'), now });
  return createAzureLabRunner({ tokens, jobId: lab.jobId });
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); done(); }, { once: true });
  });
}

/** Runs the worker; resolves its exit code. Logs ids, codes and counts only. */
export async function runWeeklyForecastsWorker(deps: WorkerDeps): Promise<number> {
  let args;
  let env: WorkerEnv;
  try {
    args = parseArgs({ args: [...deps.argv], options: { loop: { type: 'boolean' }, now: { type: 'string' } }, strict: true }).values;
    env = loadEnv(envSchema, deps.env);
  } catch (err) {
    // A ConfigError names the variables and never their values; anything else here is an unknown argument.
    process.stderr.write(`${err instanceof ConfigError ? err.message : 'Usage: weekly-forecasts [--loop] [--now <ISO time>]'}\n`);
    return 1;
  }
  const logger = createLogger(env, deps.logDestination === undefined ? undefined : { destination: deps.logDestination });
  const realNow = deps.now ?? ((): Date => new Date());
  let offsetMs = 0;
  if (args.now !== undefined) {
    const start = Date.parse(args.now);
    if (env.NODE_ENV === 'production' || Number.isNaN(start)) {
      logger.error({ reason: env.NODE_ENV === 'production' ? 'now_in_production' : 'now_invalid' }, 'townwise.weekly_worker_refused');
      return 1;
    }
    offsetMs = start - realNow().getTime();
  }
  // Which locations are due (--now moves it for development); calibrations, week rows and the lease keep the real time,
  // so a job started now is still inside its 20-minute callback window when it calls the API back.
  const dueClock = (): Date => new Date(realNow().getTime() + offsetMs);
  let mongo;
  try {
    const config = resolveTownwiseConfig(env);
    const labRunner = deps.labRunner === undefined ? labRunnerFor(env, realNow) : deps.labRunner;
    mongo = await connectMongo({ config: env, logger });
    const stores = createTownwiseStores(mongo.connection);
    // The week rows' unique index is what keeps a week to one start per location, so it is built before any pass.
    await ensureIndexes(mongo.connection, { logger });
    const schedule = createForecastSchedule({
      ctx: { config, logger, now: realNow, stores, labRunner, redis: null, connection: mongo.connection }, dueClock,
    });
    const signal = deps.signal ?? new AbortController().signal;
    const sleep = deps.sleep ?? waitFor;
    // One pass; with --loop, another after each hour until stopped.
    for (;;) {
      await schedule.pass();
      if (args.loop !== true) return 0;
      await sleep(WORKER_TICK_MS, signal);
      if (signal.aborted) return 0;
    }
  } catch (err) {
    logger.error({ code: err instanceof ConfigError ? 'config' : 'internal' }, 'townwise.weekly_worker_failed');
    if (err instanceof ConfigError) process.stderr.write(`${err.message}\n`);
    return 1;
  } finally {
    await mongo?.close();
  }
}

if (import.meta.main) {
  const stop = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) process.once(name, () => { stop.abort(); });
  process.exit(await runWeeklyForecastsWorker({ argv: process.argv.slice(2), env: process.env, signal: stop.signal }));
}
