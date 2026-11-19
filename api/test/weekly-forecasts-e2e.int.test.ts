// The weekly refresh end to end (D42, design decision 19, task 7.1): the worker (workers/weekly-forecasts.ts) runs one
// pass as a Monday 03:05 pass in Hanover with the REAL local lab runner, which starts `uv run ... townwise_lab job` in
// modeling/lab; the job fetches its input from, and posts its result to, an in-process API sharing the worker's
// TOWNWISE_LAB_LOCAL_SECRET, as a developer runs it (api/README.md, Run the weekly refresh locally). The worker and the
// API share one clock, set to that Monday 03:05, as production's share the real time: the worker's --now (development
// only) moves just which locations are due while the records keep the real time, and the API's callback window is
// counted on the API's clock, so a test API on a fixed clock takes the worker's clock rather than --now. A fixed day
// also keeps the run deterministic: which town calendar days fall in the history, and so the lab's verdict, would
// otherwise move with the real date. Then a second pass the same week starts nothing, and the forecast read for Last
// week's seven days (Home, client/src/portal/analytics/week.ts lastWeekComparison) gives scored days with the window's
// accuracy and forecast-only days with their figures. Skipped, saying why, where uv is not installed; the lab's own
// tests need it too. Every number is synthetic: a generated two-year history, never data/.
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { daysBetween, utcDay } from '../src/dates.ts';
import type { ForecastWindow } from '../src/forecasts/reader.ts';
import { createLocalLabCaller } from '../src/lab/caller.ts';
import { LAB_MODEL_VERSION } from '../src/lab/input.ts';
import { SYSTEM_REQUESTER } from '../src/lab/service.ts';
import type { Town } from '../src/towns.ts';
import { localDay, localMinutes, timeZoneOf, weekdayOf } from '../src/time-zones.ts';
import { runWeeklyForecastsWorker } from '../src/workers/weekly-forecasts.ts';
import { addLocation, addSalesDay, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { seedHistory } from './helpers/lab.ts';
import { call, refresh, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const LAB_DIR = fileURLToPath(new URL('../../modeling/lab', import.meta.url));
const HAS_UV = spawnSync('uv', ['--version'], { stdio: 'ignore' }).status === 0;
// Opt-in: building the lab's Python environment from scratch takes minutes, which `npm run verify` in CI cannot
// afford (its job stops at 30 minutes). Run it before a release with TOWNWISE_LAB_E2E=1 (api/README.md).
const RUN_E2E = process.env.TOWNWISE_LAB_E2E === '1';
const TITLE = 'the weekly forecast worker, end to end with the real local lab';

/** Days of guests seeded before Last week, ending the day before it starts. */
const HISTORY_DAYS = 700;
/** Last week's days that get a guest count after the run publishes (of 7); the read scores 5 or more. */
const LAST_WEEK_WITH_GUESTS = 5;
/** The job's callback, including uv's first sync of the lab's environment if beforeAll's did not do it. */
const CALLBACK_WAIT_MS = 240_000;

function addDays(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`), days);
}

// A synthetic restaurant, counted back from its last day: each weekday's level times a yearly season (25% either way
// over 364 days) times an independent swing per seven days (lognormal, sigma 0.08) times daily noise (lognormal, sigma
// 0.12). Seed 1 was chosen because, with the lab input the API builds for this Hanover history (its town calendar
// included) on this Monday and on the Mondays a week either side, modeling/lab returns the baseline with room on every
// check: on this Monday 34 of 40 weeks inside their range, weekly bias -0.8%, weekly WAPE 10.4% against the model's
// 11.1% and the weekday median's 15.9% (checked with the lab directly, model v8). Other seeds publish the model; where
// the model wins with ranges that hold under 65% of weeks, the lab returns the baseline when the baseline passes its
// checks (design.md, decision 8 and Open Questions).
const WEEKDAY_LEVEL = [50, 30, 38, 45, 55, 85, 95]; // Sunday to Saturday
const SEED = 1;
/** Days after the last seeded day the generator also covers: Last week's. */
const AFTER = 7;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function normals(seed: number, count: number): number[] {
  const random = mulberry32(seed);
  return Array.from({ length: count }, () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random()));
}

const DAILY = normals(119 + SEED, HISTORY_DAYS + AFTER);
const WEEKLY = normals(2026 + SEED, Math.ceil((HISTORY_DAYS + AFTER) / 7) + 1);

/** The synthetic guests on `date`, for a history whose last seeded day is `through` (up to AFTER days after it). */
function guestsOn(date: string, through: string): number {
  const index = daysBetween(date, through) + AFTER;
  const season = 1 + 0.25 * Math.sin((2 * Math.PI * (index + 91)) / 364);
  const swing = Math.exp(0.08 * (WEEKLY[Math.floor(index / 7)] ?? 0));
  const noise = Math.exp(0.12 * (DAILY[index] ?? 0));
  return Math.round((WEEKDAY_LEVEL[new Date(`${date}T00:00:00.000Z`).getUTCDay()] ?? 0) * season * swing * noise);
}

/** The test server's database, which the worker connects to on its own. */
function mongoUri(): string {
  const url = new URL(inject('mongoUri'));
  url.pathname = '/townwise-test';
  url.searchParams.set('directConnection', 'true');
  return url.toString();
}

/** The pass's clock: Monday 16 November 2026, 03:05 in Hanover (EST), when the location is due. */
const MONDAY_0305 = '2026-11-16T08:05:00.000Z';

describe.skipIf(!RUN_E2E || !HAS_UV)(
  !RUN_E2E ? `${TITLE} (skipped: set TOWNWISE_LAB_E2E=1 to run it)`
    : HAS_UV ? TITLE : `${TITLE} (skipped: uv is not on PATH, and this test runs the lab job with it)`,
  () => {
  let server: TownwiseTestServer;
  let member: TestSession;
  let orgId: string;
  let locationId: string;
  const secret = randomBytes(32).toString('base64url');
  /** Today in Hanover (the Monday), Last week's first day, and the last seeded day before it. */
  let today: string;
  let lastWeek: string;
  let through: string;

  beforeAll(async () => {
    // The lab's environment first, so the job's own `uv run --frozen` starts at once.
    const sync = spawnSync('uv', ['sync', '--frozen', '--project', LAB_DIR], { cwd: LAB_DIR, stdio: 'ignore', timeout: 300_000 });
    expect(sync.status).toBe(0);
    // The API takes the job's callback with the secret the worker's runner hands the job; its own runner never runs here.
    server = await startTownwiseServer({ labCaller: createLocalLabCaller(secret) });
    server.clock.advance(Date.parse(MONDAY_0305) - server.clock.now().getTime());
    orgId = await createOrg(server, { name: `E2E Kitchen ${randomUUID().slice(0, 6)}` });
    locationId = await addLocation(server, { orgId, name: 'Main Street' });
    const email = `member-${randomUUID().slice(0, 8)}@example.test`;
    member = await signIn(server, email);
    await addSeat(server, { orgId, userId: member.userId, email });
    const location = await server.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(locationId) });
    expect(location?.town).toMatchObject({ townId: 'hanover-nh' }); // the fixtures' town, with its calendar
    const { timeZone } = timeZoneOf(location?.town as Town);
    today = localDay(server.clock.now(), timeZone);
    expect([today, weekdayOf(today), localMinutes(server.clock.now(), timeZone)]).toEqual(['2026-11-16', 'Mon', 3 * 60 + 5]);
    lastWeek = addDays(today, -7);
    through = addDays(lastWeek, -1);
    await seedHistory(server, {
      orgId, locationId, from: addDays(through, -(HISTORY_DAYS - 1)), to: through, guests: (date) => guestsOn(date, through),
    });
  }, 600_000);
  afterAll(async () => { await server.close(); });

  function worker(): { code: Promise<number>; passes: () => Record<string, unknown>[] } {
    const lines: Record<string, unknown>[] = [];
    const env: Record<string, string> = {
      NODE_ENV: 'test', LOG_LEVEL: 'info', MONGODB_URI: mongoUri(), TOWNWISE_LAB_RUNNER: 'local', TOWNWISE_LAB_API_URL: server.url,
      TOWNWISE_LAB_LOCAL_SECRET: secret, TOWNWISE_LAB_PROJECT_DIR: LAB_DIR,
    };
    for (const name of ['PATH', 'HOME'] as const) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
    const code = runWeeklyForecastsWorker({
      argv: [], env, now: server.clock.now,
      logDestination: { write(message: string) { for (const line of message.split('\n')) if (line.trim() !== '') lines.push(JSON.parse(line) as Record<string, unknown>); } },
    });
    return { code, passes: () => lines.filter((line) => line.msg === 'townwise.weekly_refresh_pass') };
  }

  async function calibrations(): Promise<Record<string, unknown>[]> {
    return server.connection.collection('tw_calibrations').find({ locationId: new Types.ObjectId(locationId) }).toArray();
  }

  /** The calibration once the job has called back (succeeded or failed), or a failure naming where it stopped. */
  async function settled(): Promise<Record<string, unknown>> {
    const deadline = Date.now() + CALLBACK_WAIT_MS;
    for (;;) {
      const [found] = await calibrations();
      if (found !== undefined && (found.status === 'succeeded' || found.status === 'failed')) return found;
      if (Date.now() > deadline) {
        throw new Error(`the lab job did not call back within ${String(CALLBACK_WAIT_MS / 1000)} seconds (calibration ${String(found?.status)})`);
      }
      await new Promise((done) => setTimeout(done, 500));
    }
  }

  async function forecast(from: string, to: string): Promise<ForecastWindow> {
    const res = await call(server, `/api/org/locations/${locationId}/forecast?from=${from}&to=${to}`, { session: member });
    expect(res.status).toBe(200);
    return await res.json() as ForecastWindow;
  }

  it('a Monday 03:05 pass starts the location as the system, and the real job publishes a run reaching a year past today', async () => {
    // An organization nobody switched: no `forecasts` field, which reads as on (D42).
    expect(await server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(orgId) })).not.toHaveProperty('forecasts');

    const first = worker();
    expect(await first.code).toBe(0);
    expect(first.passes()).toEqual([expect.objectContaining({ state: 'ran', started: 1, failed: 0 })]);

    const calibration = await settled();
    expect(calibration).toMatchObject({
      status: 'succeeded', requestedBy: SYSTEM_REQUESTER, chargedMicroUsd: 0, dataThrough: through,
      gate: { published: true, reason: 'published' },
    });
    const calibrationId = (calibration._id as Types.ObjectId).toHexString();
    // The lab recorded which engine made the draft, beside both engines' backtests (the model runs at 595 days).
    const scorecard = JSON.parse(calibration.scorecardJson as string) as {
      engine: 'model' | 'baseline'; history: { spanDays: number }; engines: { model: unknown; baseline: unknown };
    };
    expect(['model', 'baseline']).toContain(scorecard.engine);
    expect(scorecard.history.spanDays).toBe(HISTORY_DAYS - 1);
    expect(scorecard.engines.model).not.toBeNull();
    expect(scorecard.engines.baseline).not.toBeNull();

    // The published run: the lab's, from the day after its data through today plus 365 days (D52 release B): its
    // forecast tier through today plus 91, then its outlook.
    const run = await server.connection.collection('tw_forecast_runs').findOne({ _id: new Types.ObjectId(calibration.runId as string) });
    expect(run).toMatchObject({
      status: 'published', trainingSource: 'townwise_lab', dataThrough: through, madeAt: today,
      model: { family: scorecard.engine === 'baseline' ? 'seasonal_baseline' : 'hybrid_linear_xgboost', version: LAB_MODEL_VERSION },
      range: { from: lastWeek, to: addDays(today, 365) }, lab: expect.objectContaining({ calibrationId }) as unknown,
    });
    const ahead = await forecast(today, addDays(today, 91));
    expect(ahead.available).toBe(true);
    expect(ahead.runs.map((each) => [each.id, each.engine])).toEqual([[calibration.runId, scorecard.engine]]);
    expect(ahead.days).toHaveLength(92);
    // The last 92 days of the year: the run's outlook, with the same open days and ordered figures
    const outlook = await forecast(addDays(today, 274), addDays(today, 365));
    expect(outlook.days).toHaveLength(92);
    expect(ahead.days.map((day) => day.outlook).concat(outlook.days.map((day) => day.outlook)))
      .toEqual([...Array<boolean>(92).fill(false), ...Array<boolean>(92).fill(true)]);
    for (const day of [...ahead.days, ...outlook.days]) {
      // Every day is open (the history has guests on holidays too), with the run's own middle and 80% range.
      expect(day.model.status).toBe('open');
      expect(day.model.low).not.toBeNull();
      expect(day.model.low ?? 0).toBeLessThanOrEqual(day.model.mid ?? -1);
      expect(day.model.mid ?? 0).toBeLessThanOrEqual(day.model.high ?? -1);
    }

    // The week's row, and the audit event recorded as the system.
    expect(await server.connection.collection('tw_forecast_weeks').find({ locationId: new Types.ObjectId(locationId) }).toArray())
      .toEqual([expect.objectContaining({ week: today, status: 'started', calibrationId })]);
    const scheduled = (await auditEvents(server)).filter((event) => event.action === 'calibration.scheduled');
    expect(scheduled).toEqual([expect.objectContaining({
      actorRole: 'system', orgId: new Types.ObjectId(orgId), target: { type: 'calibration', id: calibrationId },
      details: { locationId, calibrationId },
    })]);
  }, CALLBACK_WAIT_MS + 60_000);

  it('the next hour’s pass, the same week, starts nothing', async () => {
    server.clock.advance(3_600_000);
    const second = worker();
    expect(await second.code).toBe(0);
    expect(second.passes()).toEqual([expect.objectContaining({ state: 'ran', started: 0, failed: 0 })]);
    expect(await calibrations()).toHaveLength(1);
    expect(await server.connection.collection('tw_forecast_weeks').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(1);
  });

  it('Last week reads scored days with the window’s accuracy and forecast-only days with their figures', async () => {
    await refresh(server, member); // the hour the second pass moved the clock outlasted the access token
    const days = Array.from({ length: 7 }, (_, index) => addDays(lastWeek, index));
    const withGuests = days.slice(0, LAST_WEEK_WITH_GUESTS);
    for (const date of withGuests) {
      await addSalesDay(server, { orgId, locationId, date, guests: guestsOn(date, through), netSalesCents: null });
    }
    // Home's Last week read (lastWeekRange: the seven days before today).
    const read = await forecast(lastWeek, addDays(today, -1));
    expect(read.available).toBe(true);
    expect(read.days.map((day) => day.date)).toEqual(days);
    for (const day of read.days) {
      // What lastWeekComparison reads of a day: the run's own open figures (runDay), then `scored` and `inRange`.
      expect(day.model).toMatchObject({ status: 'open', low: expect.any(Number) as unknown, mid: expect.any(Number) as unknown, high: expect.any(Number) as unknown });
      if (withGuests.includes(day.date)) {
        expect(day).toMatchObject({ actual: guestsOn(day.date, through), scored: true, inRange: expect.any(Boolean) as unknown });
      } else {
        // Forecast only: no guest count yet, the published figures shown as the forecast.
        expect(day).toMatchObject({ actual: null, scored: false, inRange: null });
      }
    }
    const scored = read.days.filter((day) => day.scored);
    expect(read.accuracy).toEqual({
      days: LAST_WEEK_WITH_GUESTS, inRange: scored.filter((day) => day.inRange === true).length,
      typicalErrorPct: expect.any(Number) as unknown, from: lastWeek, to: addDays(lastWeek, LAST_WEEK_WITH_GUESTS - 1),
    });
  });
});
