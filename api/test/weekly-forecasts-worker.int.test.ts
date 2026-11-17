// The weekly refresh's worker (D42, workers/weekly-forecasts.ts) as its own composition root: it reads the environment
// through config.ts's schema, connects to Mongo only, runs one pass and exits 0; with the switch false or the lab runner
// off it starts nothing and exits 0; a bad environment exits 1; --loop runs a pass at start and another after its hour;
// --now moves the pass's clock and is refused in production. A fake runner stands in for the lab job, and the test
// server seeds the same database. With a model (a scripted fake, never Anthropic) the same pass makes TownwiseAI's weekly
// suggestions for an organization that never set the switch, lab or no lab (openspec change weekly-forecast-suggestions,
// task 4.3). Every number is synthetic.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';

import type { ChatModel } from '../src/chat/model.ts';
import { runWeeklyForecastsWorker, WORKER_TICK_MS } from '../src/workers/weekly-forecasts.ts';
import { message, scriptedModel, text } from './helpers/chat-model.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { fakeLabRunner, seedHistory, type FakeLabRunner } from './helpers/lab.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;
let runner: FakeLabRunner;

beforeAll(async () => {
  runner = fakeLabRunner();
  server = await startTownwiseServer({ labRunner: runner });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  for (const name of [
    'tw_orgs', 'tw_locations', 'tw_sales_days', 'tw_calibrations', 'tw_forecast_weeks', 'tw_forecast_schedule', 'tw_agent_suggestions',
    'tw_suggestion_passes', 'tw_chat_usage',
  ]) {
    await server.connection.collection(name).deleteMany({});
  }
});

/** The test server's database, which the worker connects to on its own. */
function mongoUri(): string {
  const url = new URL(inject('mongoUri'));
  url.pathname = '/townwise-test';
  url.searchParams.set('directConnection', 'true');
  return url.toString();
}

/** Mon, Nov 16, 2026 at 03:05 in Hanover (EST). */
const MONDAY_0305 = '2026-11-16T08:05:00.000Z';

function env(over: Record<string, string> = {}): Record<string, string> {
  return { NODE_ENV: 'test', LOG_LEVEL: 'info', MONGODB_URI: mongoUri(), TOWNWISE_LAB_RUNNER: 'off', ...over };
}

async function place(): Promise<void> {
  const orgId = await createOrg(server, { name: `Worker Kitchen ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  await seedHistory(server, { orgId, locationId, from: '2025-12-01', to: '2026-11-15' });
}

/** Runs the worker with the fake runner, or with the runner its environment builds ('env'). */
function run(opts: {
  argv?: string[]; env?: Record<string, string>; labRunner?: 'env'; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; signal?: AbortSignal;
  chat?: ChatModel;
} = {}) {
  const lines: Record<string, unknown>[] = [];
  const destination = { write(message: string) { for (const line of message.split('\n')) if (line.trim() !== '') lines.push(JSON.parse(line) as Record<string, unknown>); } };
  const code = runWeeklyForecastsWorker({
    argv: opts.argv ?? ['--now', MONDAY_0305], env: opts.env ?? env(), ...(opts.labRunner === 'env' ? {} : { labRunner: runner }),
    logDestination: destination, ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }), ...(opts.signal === undefined ? {} : { signal: opts.signal }),
    ...(opts.chat === undefined ? {} : { chat: opts.chat }),
  });
  return {
    code, lines, passes: () => lines.filter((line) => line.msg === 'townwise.weekly_refresh_pass'),
    suggestions: () => lines.filter((line) => line.msg === 'townwise.weekly_suggestions_pass'),
  };
}

describe('the worker', () => {
  it('runs one pass, starting a due location as the system, then exits 0', async () => {
    await place();
    const before = runner.jobs.length;
    const worker = run();
    expect(await worker.code).toBe(0);
    expect(runner.jobs.length).toBe(before + 1);
    expect(worker.passes()).toEqual([expect.objectContaining({ state: 'ran', started: 1, failed: 0 })]);
    expect(await server.connection.collection('tw_forecast_weeks').findOne({})).toMatchObject({ week: '2026-11-16', status: 'started' });
    // --now decides only who is due: the calibration's request time and callback window are the real clock's.
    const calibration = await server.connection.collection('tw_calibrations').findOne({ 'requestedBy.role': 'system' });
    expect(Math.abs((calibration?.requestedAt as Date).getTime() - Date.now())).toBeLessThan(60_000);
  });

  it('starts nothing and exits 0 with TOWNWISE_WEEKLY_FORECASTS false or the lab runner off', async () => {
    await place();
    const before = runner.jobs.length;
    const switchedOff = run({ env: env({ TOWNWISE_WEEKLY_FORECASTS: 'false' }) });
    expect(await switchedOff.code).toBe(0);
    expect(switchedOff.passes()).toEqual([expect.objectContaining({ state: 'off', started: 0 })]);
    // The environment's own runner: TOWNWISE_LAB_RUNNER=off builds none.
    const labOff = run({ labRunner: 'env' });
    expect(await labOff.code).toBe(0);
    expect(labOff.passes()).toEqual([expect.objectContaining({ state: 'off', started: 0 })]);
    expect(runner.jobs.length).toBe(before);
    expect(await server.connection.collection('tw_forecast_weeks').countDocuments({})).toBe(0);
  });

  it('exits 1 on a bad environment, an unknown argument, or --now in production, starting nothing', async () => {
    const before = runner.jobs.length;
    expect(await run({ env: env({ TOWNWISE_WEEKLY_FORECAST_CAP: 'many' }) }).code).toBe(1);
    expect(await run({ env: { NODE_ENV: 'test' } }).code).toBe(1);
    expect(await run({ argv: ['--sometimes'] }).code).toBe(1);
    expect(await run({ argv: ['--now', 'not a time'] }).code).toBe(1);
    const production = run({ env: env({ NODE_ENV: 'production', TOWNWISE_SUPERADMIN_EMAILS: 'staff@townwise.test' }) });
    expect(await production.code).toBe(1);
    expect(production.lines).toEqual([expect.objectContaining({ msg: 'townwise.weekly_worker_refused', reason: 'now_in_production' })]);
    // The local runner needs the secret it shares with the API.
    expect(await run({ labRunner: 'env', env: env({ TOWNWISE_LAB_RUNNER: 'local', TOWNWISE_LAB_API_URL: 'http://localhost:8080' }) }).code).toBe(1);
    expect(runner.jobs.length).toBe(before);
  });

  it('--loop runs a pass at start and another after each hour until stopped', async () => {
    await place();
    const stop = new AbortController();
    const waits: number[] = [];
    const worker = run({
      argv: ['--loop', '--now', '2026-11-16T07:00:00.000Z'],
      signal: stop.signal,
      sleep: (ms) => {
        waits.push(ms);
        if (waits.length === 2) stop.abort();
        return Promise.resolve();
      },
    });
    expect(await worker.code).toBe(0);
    expect(waits).toEqual([WORKER_TICK_MS, WORKER_TICK_MS]);
    // Monday at 02:00 in Hanover, before its week starts: two passes, neither due.
    expect(worker.passes()).toEqual([
      expect.objectContaining({ state: 'ran', started: 0 }), expect.objectContaining({ state: 'ran', started: 0 }),
    ]);
  });

  it('with a model, one pass also makes weekly suggestions for an organization that never set the switch, even with the lab off', async () => {
    await place();
    const model = scriptedModel();
    const closure = {
      type: 'note', ruleText: null, kind: 'closure', startDate: '2026-11-26', endDate: '2026-11-26', weekdays: null, effect: 'closed',
      expectedGuests: null, detail: null, startTime: null, endTime: null, why: 'Thanksgiving is Thu, Nov 26.', calendarIds: ['us:thanksgiving:2026'],
    };
    model.script({ kind: 'message', message: message([text(JSON.stringify({ suggestions: [closure] }))]) });
    // The real clock decides the town's today (only who is due moves with --now), so the closure must still be ahead.
    const today = new Date().toISOString().slice(0, 10);
    const worker = run({ labRunner: 'env', chat: model });
    expect(await worker.code).toBe(0);
    expect(worker.passes()).toEqual([expect.objectContaining({ state: 'off', started: 0 })]);
    expect(model.calls).toHaveLength(1);
    expect(await server.connection.collection('tw_suggestion_passes').findOne({})).toMatchObject({ week: '2026-11-16' });
    const stored = await server.connection.collection('tw_agent_suggestions').countDocuments({ status: 'open' });
    expect(worker.suggestions()).toEqual([expect.objectContaining({ state: 'ran', failed: 0 })]);
    expect(stored).toBe(today < '2026-11-26' ? 1 : 0);
    // Without ANTHROPIC_API_KEY (and no model given) the suggestions are off.
    const keyless = run({ labRunner: 'env' });
    expect(await keyless.code).toBe(0);
    expect(keyless.suggestions()).toEqual([expect.objectContaining({ state: 'off' })]);
  });
});
