// The forecast lab from the staff console to the job's callback, with a fake runner that records each job instead of
// starting one; the test then plays the job (helpers/lab.ts). Starting a calibration (its checks, event, charge and
// limits), the input the job fetches, the draft run its result makes (nothing is published here), 404 for every
// callback the job should not make, timeouts, deletion while a job runs, duplicated results, and logs and audit events
// with ids and counts only. Every number is synthetic.
import { createHash, randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import { canonicalSha256, type FileIssue } from '../src/forecasts/file.ts';
import { labInputSchema, type LabInput } from '../src/lab/input.ts';
import { LabStartError } from '../src/lab/runner.ts';
import { CALIBRATION_CHARGE_MICRO_USD, CALIBRATION_TIMEOUT_MS, checkStart, type StartRequest } from '../src/lab/service.ts';
import type { CalibrationView } from '../src/lab/views.ts';
import { addChatUsage, addLocation, addNote, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { holdCalls } from './helpers/hold.ts';
import {
  CODE_VERSION, fakeLabRunner, IMAGE_DIGEST, jobCall, labFailure, labResultFor, runDays, seedHistory, type FakeLabRunner,
} from './helpers/lab.ts';
import { comparisonWith, metricsWith, scorecardWith } from './lab-fixtures.ts';
import {
  call, logLines, refresh, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let staff: TestSession;
let runner: FakeLabRunner;

beforeAll(async () => {
  runner = fakeLabRunner();
  server = await startTownwiseServer({ labRunner: runner });
  staff = await signInStaff(server);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  runner.onStart = null;
});

interface Team { orgId: string; locationId: string; admin: TestSession }

/** An organization with an org admin and one Hanover location holding guests from `from` (2025-01-01) to 2026-05-31. */
async function team(opts?: { from?: string; guests?: (date: string, index: number) => number }): Promise<Team> {
  const orgId = await createOrg(server, { name: `Lab Kitchen ${randomUUID().slice(0, 6)}` });
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, email);
  await addSeat(server, { orgId, userId: admin.userId, email, role: 'org_admin' });
  const locationId = await addLocation(server, { orgId, name: 'Hanover Room' });
  await seedHistory(server, { orgId, locationId, from: opts?.from ?? '2025-01-01', to: '2026-05-31', ...(opts?.guests === undefined ? {} : { guests: opts.guests }) });
  return { orgId, locationId, admin };
}

function start(t: Pick<Team, 'orgId' | 'locationId'>, body: unknown = {}): Promise<Response> {
  return call(server, `/api/admin/orgs/${t.orgId}/locations/${t.locationId}/calibrations`, { session: staff, json: body });
}

async function started(t: Team, body: unknown = {}): Promise<{ calibration: CalibrationView; job: { calibrationId: string; token: string } }> {
  const res = await start(t, body);
  expect(res.status).toBe(201);
  const { calibration } = await res.json() as { calibration: CalibrationView };
  const job = runner.jobs.at(-1);
  if (job?.calibrationId !== calibration.id) throw new Error('the runner did not get this calibration');
  return { calibration, job };
}

async function list(t: Pick<Team, 'orgId'>): Promise<{ forecasts: { on: boolean; at: string | null }; calibrations: CalibrationView[] }> {
  const res = await call(server, `/api/admin/orgs/${t.orgId}/calibrations`, { session: staff });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ forecasts: { on: boolean; at: string | null }; calibrations: CalibrationView[] }>;
}

async function viewOf(t: Pick<Team, 'orgId'>, id: string): Promise<CalibrationView> {
  const found = (await list(t)).calibrations.find((each) => each.id === id);
  if (found === undefined) throw new Error('no such calibration');
  return found;
}

async function inputFor(job: { calibrationId: string; token: string }): Promise<LabInput> {
  const res = await jobCall(server, job, 'input');
  expect(res.status).toBe(200);
  return labInputSchema.parse(await res.json());
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: (await res.json() as { error: string }).error };
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

async function eventsFor(calibrationId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => (event.target as { id?: string } | undefined)?.id === calibrationId
    || (event.details as { calibrationId?: string } | undefined)?.calibrationId === calibrationId);
}

/** A published run of the location (files_from_owner) whose forecast reaches 2026-07-09, so it is the current one. */
async function publishedChampion(t: Team): Promise<string> {
  const file = {
    schema: 'townwise.forecast-run/1', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v5', notebookCommit: 'abcdef0' },
    trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-04-30', madeAt: '2026-05-01', frozen: null,
    interval: { level: 0.8, widened: true }, backtest: null, ...runDays('2026-04-30', 70),
  };
  const imported = await call(server, `/api/admin/orgs/${t.orgId}/locations/${t.locationId}/forecast-runs`, { session: staff, json: file });
  expect(imported.status).toBe(201);
  const { run } = await imported.json() as { run: { id: string } };
  expect((await call(server, `/api/admin/orgs/${t.orgId}/forecast-runs/${run.id}/publish`, { session: staff, json: {} })).status).toBe(200);
  return run.id;
}

describe('starting a calibration', () => {
  it('staff start: 201 queued then running, records calibration.requested before the effect, charges $0.10 once', async () => {
    const t = await team();
    const seen: { status: unknown; requested: number; tokenSha256: unknown }[] = [];
    runner.onStart = async (job) => {
      const doc = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(job.calibrationId) });
      seen.push({ status: doc?.status, requested: (await eventsFor(job.calibrationId)).length, tokenSha256: doc?.tokenSha256 });
    };
    server.logs.length = 0;
    const { calibration, job } = await started(t);
    expect(calibration).toMatchObject({
      locationId: t.locationId, status: 'running', failure: null, failureWords: null, via: 'console', requestedByRole: 'superadmin',
      regimeStart: null, requestedAt: '2026-06-01T12:00:00.000Z', startedAt: '2026-06-01T12:00:00.000Z', finishedAt: null, runId: null,
      chargedUsd: 0.1, gate: null, summary: null,
    });
    // While the job started, the calibration was queued, its event already written, and only the token's hash stored.
    const tokenSha256 = createHash('sha256').update(job.token).digest('hex');
    expect(seen).toEqual([{ status: 'queued', requested: 1, tokenSha256 }]);
    expect(job.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const doc = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(calibration.id) });
    expect(doc).toMatchObject({ status: 'running', imageDigest: IMAGE_DIGEST, chargedMicroUsd: CALIBRATION_CHARGE_MICRO_USD, championRunId: null });
    expect(JSON.stringify(doc)).not.toContain(job.token);
    const usage = await server.connection.collection('tw_chat_usage').find({ orgId: new Types.ObjectId(t.orgId) }).toArray();
    expect(usage.map((row) => ({ month: row.month as unknown, costMicroUsd: row.costMicroUsd as unknown })))
      .toEqual([{ month: '2026-06', costMicroUsd: 100_000 }]);
    const events = await eventsFor(calibration.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'calibration.requested', actorRole: 'superadmin', orgId: new Types.ObjectId(t.orgId),
      target: { type: 'calibration', id: calibration.id },
      details: { locationId: t.locationId, calibrationId: calibration.id, via: 'console', hasRegime: false },
    });
    const started_ = logLines(server).filter((line) => line.msg === 'townwise.calibration_started');
    expect(started_).toHaveLength(1);
    expect(started_[0]).toMatchObject({ orgId: t.orgId, locationId: t.locationId, calibrationId: calibration.id, via: 'console' });
    // The list shows it, with the organization's forecasts switch.
    expect(await list(t)).toEqual({ forecasts: { on: false, at: null }, calibrations: [calibration] });
  });

  it('a second start for the same location is 409 calibration_in_progress; a fifth start in a day is 429', async () => {
    const t = await team();
    const first = await started(t);
    const before = (await auditEvents(server)).length;
    expect(await errorOf(await start(t))).toEqual({ status: 409, error: 'calibration_in_progress' });
    // Refused by the read-only checks: nothing recorded, nothing charged.
    expect((await auditEvents(server)).length).toBe(before);
    expect((await jobCall(server, first.job, 'result', labFailure(first.job, 'internal'))).status).toBe(200);
    for (let n = 2; n <= 4; n += 1) {
      const { job } = await started(t);
      expect((await jobCall(server, job, 'result', labFailure(job, 'internal'))).status).toBe(200);
    }
    const jobs = runner.jobs.length;
    const fifth = await start(t);
    expect(await errorOf(fifth)).toEqual({ status: 429, error: 'calibrations_rate_limited' });
    expect(runner.jobs).toHaveLength(jobs);
    // Refused after the event: the event and a not-applied note naming why, and no calibration.
    const [requested, notApplied] = (await auditEvents(server)).slice(-2);
    expect(requested).toMatchObject({ action: 'calibration.requested', details: { locationId: t.locationId } });
    expect(notApplied).toMatchObject({ action: 'staff_action.not_applied', details: { eventId: String(requested?._id), code: 'calibrations_rate_limited' } });
    const requestedId = (requested?.target as { id: string }).id;
    expect(await count('tw_calibrations', { _id: new Types.ObjectId(requestedId) })).toBe(0);
    expect((await list(t)).calibrations).toHaveLength(4);
    const usage = await server.connection.collection('tw_chat_usage').findOne({ orgId: new Types.ObjectId(t.orgId) });
    expect(usage?.costMicroUsd).toBe(4 * CALIBRATION_CHARGE_MICRO_USD);
  });

  it('under 420 days of history is 409 not_enough_history and starts no job', async () => {
    // 2025-04-07 to 2026-05-31 spans 419 days; one day more is enough.
    const short = await team({ from: '2025-04-07' });
    const jobs = runner.jobs.length;
    const before = (await auditEvents(server)).length;
    const res = await start(short);
    expect(await res.clone().json()).toMatchObject({
      error: 'not_enough_history', message: 'Calibration needs at least 420 days from the first to the last day of sales history.',
    });
    expect(res.status).toBe(409);
    expect(runner.jobs).toHaveLength(jobs);
    expect((await auditEvents(server)).length).toBe(before);
    expect(await count('tw_calibrations', { orgId: new Types.ObjectId(short.orgId) })).toBe(0);
    await started(await team({ from: '2025-04-06' }));
  });

  it('a pattern change date outside the history or in its last 8 weeks is 400 invalid_regime_start', async () => {
    const t = await team();
    for (const regimeStart of ['2024-12-31', '2026-04-06', 'not-a-date']) {
      const res = await start(t, { regimeStart });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe(regimeStart === 'not-a-date' ? 'invalid_request' : 'invalid_regime_start');
    }
    // 2026-04-05 is 56 days before the last day.
    const { calibration } = await started(t, { regimeStart: '2026-04-05' });
    expect(calibration.regimeStart).toBe('2026-04-05');
    expect((await eventsFor(calibration.id))[0]).toMatchObject({ details: { hasRegime: true } });
    expect((await inputFor(runner.jobs.at(-1) ?? { calibrationId: '', token: '' })).regimeStart).toBe('2026-04-05');
  });

  it('a spent month’s budget is 409 chat_budget_exhausted', async () => {
    const t = await team();
    await addChatUsage(server, { orgId: t.orgId, month: '2026-06', costMicroUsd: 20_000_000 });
    const jobs = runner.jobs.length;
    expect(await errorOf(await start(t))).toEqual({ status: 409, error: 'chat_budget_exhausted' });
    expect(runner.jobs).toHaveLength(jobs);
    // Last month's spending doesn't count.
    const other = await team();
    await addChatUsage(server, { orgId: other.orgId, month: '2026-05', costMicroUsd: 20_000_000 });
    await started(other);
  });

  it('a runner that throws fails the calibration start_failed and answers 503 lab_start_failed', async () => {
    const t = await team();
    runner.failNext(new LabStartError('upstream_status', { status: 403 }));
    server.logs.length = 0;
    const res = await start(t);
    expect(await res.clone().json()).toMatchObject({ error: 'lab_start_failed', message: 'The calibration couldn’t start. Try again in a few minutes.' });
    expect(res.status).toBe(503);
    const [failed] = (await list(t)).calibrations;
    expect(failed).toMatchObject({ status: 'failed', failure: 'start_failed', failureWords: 'It couldn’t start.', chargedUsd: 0 });
    expect(await count('tw_chat_usage', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
    const logged = logLines(server).filter((line) => line.msg === 'townwise.lab_start_failed');
    expect(logged.map(({ calibrationId, code }) => ({ calibrationId, code }))).toEqual([{ calibrationId: failed?.id, code: 'upstream_status' }]);
    const events = await eventsFor(failed?.id ?? '');
    expect(events.map((event) => event.action)).toEqual(['calibration.requested', 'calibration.finished']);
    expect(events[1]).toMatchObject({ actorRole: 'system', details: { status: 'failed', failure: 'start_failed', runId: null } });
    // The location is free again.
    await started(t);
  });

  it('with the lab off, checkStart refuses lab_unavailable before reading anything', async () => {
    // Every store access would throw on this context.
    const ctx = { labRunner: null } as unknown as TownwiseContext;
    expect(await checkStart(ctx, {} as StartRequest)).toBe('lab_unavailable');
  });

  it('is staff only', async () => {
    const t = await team();
    expect((await call(server, `/api/admin/orgs/${t.orgId}/locations/${t.locationId}/calibrations`, { session: t.admin, json: {} })).status).toBe(403);
    expect((await call(server, `/api/admin/orgs/${t.orgId}/calibrations`, { session: t.admin })).status).toBe(403);
    // Another organization's location is 404.
    const other = await team();
    expect(await errorOf(await start({ orgId: t.orgId, locationId: other.locationId }))).toEqual({ status: 404, error: 'not_found' });
  });
});

describe('the job’s callback', () => {
  it('the job fetches its input with the token and a result makes a draft run with the lab block; nothing is published', async () => {
    const t = await team();
    await addNote(server, { orgId: t.orgId, locationId: t.locationId, detail: 'Closed for a private reason', startDate: '2026-02-03' });
    const championId = await publishedChampion(t);
    const { calibration, job } = await started(t);
    const input = await inputFor(job);
    expect(input).toMatchObject({ calibrationId: calibration.id, today: '2026-06-01', dataThrough: '2026-05-31', horizonDays: 182, regimeStart: null });
    expect(input.days[0]?.date).toBe('2025-01-01');
    expect(input.days.find((day) => day.date === '2026-02-03')).toMatchObject({ closed: true });
    expect(input.champion?.runId).toBe(championId);
    expect(input.champion?.days).toHaveLength(70);
    expect(JSON.stringify(input)).not.toContain('private reason');
    const stored = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(calibration.id) });
    expect(stored).toMatchObject({ championRunId: championId, dataThrough: '2026-05-31', inputSha256: canonicalSha256(input) });

    const result = labResultFor(input);
    const res = await jobCall(server, job, 'result', result);
    expect(await res.json()).toEqual({ status: 'succeeded' });
    expect(res.status).toBe(200);

    const view = await viewOf(t, calibration.id);
    expect(view).toMatchObject({ status: 'succeeded', failure: null, finishedAt: '2026-06-01T12:00:00.000Z', gate: null });
    expect(view.summary).toEqual({
      weeks: 12, weeklyWapePct: 15, championWeeklyWapePct: 20, coverage: { inside: 10, weeks: 12 }, weekdayBiasPct: 5, championWeekdayBiasPct: 5,
    });
    const run = await server.connection.collection('tw_forecast_runs').findOne({ _id: new Types.ObjectId(view.runId ?? '') });
    expect(run).toMatchObject({
      status: 'draft', trainingSource: 'townwise_lab', importedBy: null, publishedAt: null, dataThrough: '2026-05-31', frozen: null,
      lab: { calibrationId: calibration.id, codeVersion: CODE_VERSION, imageDigest: IMAGE_DIGEST, inputSha256: canonicalSha256(input) },
    });
    expect(JSON.parse(String((run?.lab as { paramsJson?: string } | undefined)?.paramsJson))).toEqual(result.params);
    expect(await count('tw_forecasts', { runId: new Types.ObjectId(view.runId ?? '') })).toBe(result.run.days.length + result.run.weeks.length);
    const doc = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(calibration.id) });
    expect(doc).toMatchObject({ codeVersion: CODE_VERSION, scorecardJson: JSON.stringify(result.scorecard) });
    expect(doc?.tokenSha256).toBeUndefined();
    expect(doc?.liveLocation).toBeUndefined();

    const events = await eventsFor(calibration.id);
    expect(events.map((event) => event.action)).toEqual(['calibration.requested', 'calibration.finished']);
    expect(events[1]).toMatchObject({
      actorRole: 'system', actorUserId: 'system',
      details: { locationId: t.locationId, calibrationId: calibration.id, status: 'succeeded', gate: null, failure: null, runId: view.runId, heldOutWeeks: 12 },
    });
    // Nothing published: the current forecast is still the only published run, and no publish event was written.
    expect(await count('tw_forecast_runs', { locationId: new Types.ObjectId(t.locationId), status: 'published' })).toBe(1);
    expect((await auditEvents(server)).filter((event) => event.action === 'forecast.published' && (event.target as { id: string }).id !== championId))
      .toEqual([]);
    // The finished calibration's token is dead.
    expect((await jobCall(server, job, 'input')).status).toBe(404);
  });

  it('input and result answer 404 for an unknown id, a wrong token, another org’s id and a finished calibration, never 401', async () => {
    const a = await team();
    const b = await team();
    const jobA = (await started(a)).job;
    const jobB = (await started(b)).job;
    const statuses: number[] = [];
    const both = async (job: { calibrationId: string; token: string }, opts?: { authorization?: string | null }): Promise<void> => {
      statuses.push((await jobCall(server, job, 'input', undefined, opts)).status);
      statuses.push((await jobCall(server, job, 'result', labFailure(job, 'internal'), opts)).status);
    };
    await both({ calibrationId: new Types.ObjectId().toHexString(), token: jobA.token });
    await both({ calibrationId: jobA.calibrationId, token: jobB.token });
    await both({ calibrationId: jobB.calibrationId, token: jobA.token });
    await both({ calibrationId: 'not-an-id', token: jobA.token });
    await both(jobA, { authorization: null });
    await both(jobA, { authorization: `Basic ${jobA.token}` });
    await both(jobA, { authorization: `Bearer ${jobA.token}x` });
    expect(statuses.every((status) => status === 404)).toBe(true);
    expect(statuses).toHaveLength(14);
    // None of those touched either calibration.
    expect((await viewOf(a, jobA.calibrationId)).status).toBe('running');
    expect((await viewOf(b, jobB.calibrationId)).status).toBe('running');
    expect((await jobCall(server, jobA, 'result', labFailure(jobA, 'internal'))).status).toBe(200);
    expect((await viewOf(a, jobA.calibrationId)).failure).toBe('job_failed');
    statuses.length = 0;
    await both(jobA);
    expect(statuses).toEqual([404, 404]);
    expect((await jobCall(server, jobB, 'input')).status).toBe(200);
  });

  it('a result with a different dataThrough, an invalid run or scorecard, or another champion fails invalid_result', async () => {
    const t = await team();
    const cases: { name: string; result: (input: LabInput) => unknown; issue: FileIssue }[] = [
      {
        name: 'dataThrough',
        result: (input) => labResultFor(input, { run: { dataThrough: '2026-05-30' } }),
        issue: { path: 'run.dataThrough', code: 'data_through_mismatch' },
      },
      {
        name: 'run',
        result: (input) => {
          const result = labResultFor(input);
          const [first, ...rest] = result.run.days;
          return { ...result, run: { ...result.run, days: [{ ...first, high: 1 }, ...rest] } };
        },
        issue: { path: 'run.days[0].high', code: 'below_mid' },
      },
      {
        name: 'scorecard',
        result: (input) => ({ ...labResultFor(input), scorecard: { ...scorecardWith(), guests: 98765 } }),
        issue: { path: 'scorecard', code: 'unrecognized_keys' },
      },
      {
        name: 'champion',
        result: (input) => labResultFor(input, { scorecard: scorecardWith({ comparison: { ...comparisonWith({}, {}), championRunId: 'f'.repeat(24) } }) }),
        issue: { path: 'scorecard.comparison.championRunId', code: 'champion_mismatch' },
      },
    ];
    for (const each of cases) {
      const { calibration, job } = await started(t);
      const input = await inputFor(job);
      const res = await jobCall(server, job, 'result', each.result(input));
      const body = await res.json() as { error: string; issues: FileIssue[] };
      expect({ name: each.name, status: res.status, error: body.error }).toEqual({ name: each.name, status: 400, error: 'invalid_lab_result' });
      expect(body.issues).toContainEqual(each.issue);
      for (const issue of body.issues) expect(Object.keys(issue).sort()).toEqual(['code', 'path']);
      expect(JSON.stringify(body)).not.toContain('98765');
      expect(await viewOf(t, calibration.id)).toMatchObject({
        status: 'failed', failure: 'invalid_result', failureWords: 'Its result didn’t pass Townwise’s checks.', runId: null,
      });
    }
    expect(await count('tw_forecast_runs', { locationId: new Types.ObjectId(t.locationId) })).toBe(0);
  });

  it('ok false with not_enough_history fails the calibration with that failure', async () => {
    const t = await team();
    const { calibration, job } = await started(t);
    await inputFor(job);
    const res = await jobCall(server, job, 'result', labFailure(job, 'not_enough_history'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'failed' });
    expect(await viewOf(t, calibration.id)).toMatchObject({
      status: 'failed', failure: 'not_enough_history', failureWords: 'There wasn’t enough sales history.', runId: null, summary: null,
    });
    expect((await eventsFor(calibration.id)).at(-1)).toMatchObject({
      action: 'calibration.finished', details: { status: 'failed', failure: 'not_enough_history', runId: null, heldOutWeeks: null },
    });
  });

  it('a duplicated result post answers 200 and leaves one run and one finished event', async () => {
    const t = await team();
    const { calibration, job } = await started(t);
    const result = labResultFor(await inputFor(job));
    // The first post waits while writing its rows; the second runs to the end meanwhile.
    const rows = holdCalls(server, 'bulkWrite', 'TwForecast');
    try {
      const first = jobCall(server, job, 'result', result);
      await rows.arrived(1);
      rows.release(2);
      const second = await jobCall(server, job, 'result', result);
      expect({ status: second.status, body: await second.json() as unknown }).toEqual({ status: 200, body: { status: 'succeeded' } });
      rows.release(1);
      const late = await first;
      expect({ status: late.status, body: await late.json() as unknown }).toEqual({ status: 200, body: { status: 'succeeded' } });
    } finally {
      rows.restore();
    }
    // A retry after it finished finds no live calibration.
    expect((await jobCall(server, job, 'result', result)).status).toBe(404);
    expect(await count('tw_forecast_runs', { locationId: new Types.ObjectId(t.locationId) })).toBe(1);
    const view = await viewOf(t, calibration.id);
    expect(view.status).toBe('succeeded');
    expect(await count('tw_forecasts', { runId: new Types.ObjectId(view.runId ?? '') })).toBe(result.run.days.length + result.run.weeks.length);
    expect((await eventsFor(calibration.id)).filter((event) => event.action === 'calibration.finished')).toHaveLength(1);
  });

  it('a result for a location whose sales were deleted mid-run leaves no run', async () => {
    const deleteSales = async (t: Team): Promise<void> => {
      expect((await call(server, `/api/org/locations/${t.locationId}/sales`, { method: 'DELETE', session: t.admin })).status).toBe(200);
    };
    // Deleted before the job posts: the calibration went with the sales data, so the post is 404.
    const before = await team();
    const early = await started(before);
    const earlyResult = labResultFor(await inputFor(early.job));
    await deleteSales(before);
    expect((await jobCall(server, early.job, 'result', earlyResult)).status).toBe(404);
    expect(await count('tw_forecast_runs', { locationId: new Types.ObjectId(before.locationId) })).toBe(0);

    // Deleted while the post writes its run: the run it wrote after the deletion goes too.
    const during = await team();
    const late = await started(during);
    const lateResult = labResultFor(await inputFor(late.job));
    const rows = holdCalls(server, 'bulkWrite', 'TwForecast');
    try {
      const post = jobCall(server, late.job, 'result', lateResult);
      await rows.arrived(1);
      expect(await count('tw_forecast_runs', { locationId: new Types.ObjectId(during.locationId) })).toBe(1);
      await deleteSales(during);
      rows.release(1);
      expect((await post).status).toBe(404);
    } finally {
      rows.restore();
    }
    for (const t of [before, during]) {
      const location = new Types.ObjectId(t.locationId);
      expect(await count('tw_forecast_runs', { locationId: location })).toBe(0);
      expect(await count('tw_forecasts', { locationId: location })).toBe(0);
      expect(await count('tw_calibrations', { locationId: location })).toBe(0);
    }
  });

  it('logs and audit events carry ids and counts only', async () => {
    const t = await team({ guests: () => 98765 });
    server.logs.length = 0;
    const { calibration, job } = await started(t);
    const input = await inputFor(job);
    expect(input.days[0]?.guests).toBe(98765);
    const scorecard = scorecardWith({ backtest: { metrics: metricsWith({ weeklyWape: 0.123456 }) }, comparison: null });
    expect((await jobCall(server, job, 'result', labResultFor(input, { scorecard }))).status).toBe(200);
    expect((await viewOf(t, calibration.id)).summary?.weeklyWapePct).toBe(12.3);
    const logs = server.logs.join('\n');
    const events = JSON.stringify(await eventsFor(calibration.id));
    for (const text of [logs, events]) {
      expect(text).not.toContain('98765');
      expect(text).not.toContain('0.123456');
      expect(text).not.toContain(job.token);
    }
    const own = logLines(server).filter((line) => String(line.msg).startsWith('townwise.calibration') || String(line.msg).startsWith('townwise.lab'));
    expect(own.map((line) => line.msg)).toEqual(['townwise.calibration_started', 'townwise.calibration_finished']);
    expect(own[1]).toMatchObject({ orgId: t.orgId, locationId: t.locationId, calibrationId: calibration.id, status: 'succeeded', failure: null, heldOutWeeks: 12 });
  });
});

describe('timeouts', () => {
  it('a live calibration older than 20 minutes fails as timeout and frees the location', async () => {
    const t = await team();
    const { calibration, job } = await started(t);
    server.clock.advance(CALIBRATION_TIMEOUT_MS - 1000);
    await refresh(server, staff);
    expect((await viewOf(t, calibration.id)).status).toBe('running');
    expect(await errorOf(await start(t))).toEqual({ status: 409, error: 'calibration_in_progress' });
    server.clock.advance(1000);
    // Its token died with the 20 minutes, before anything read the calibration.
    expect((await jobCall(server, job, 'input')).status).toBe(404);
    expect(await viewOf(t, calibration.id)).toMatchObject({
      status: 'failed', failure: 'timeout', failureWords: 'It didn’t finish within 20 minutes.',
    });
    const finished = (await eventsFor(calibration.id)).filter((event) => event.action === 'calibration.finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]).toMatchObject({ actorRole: 'system', details: { status: 'failed', failure: 'timeout' } });
    // Reading again changes nothing; the location takes a new calibration.
    await list(t);
    expect((await eventsFor(calibration.id)).filter((event) => event.action === 'calibration.finished')).toHaveLength(1);
    await started(t);
  });

  it('a start times out the stale calibration itself', async () => {
    await refresh(server, staff);
    const t = await team();
    const { calibration } = await started(t);
    server.clock.advance(CALIBRATION_TIMEOUT_MS);
    await refresh(server, staff);
    const next = await started(t);
    expect(next.calibration.id).not.toBe(calibration.id);
    expect(await viewOf(t, calibration.id)).toMatchObject({ status: 'failed', failure: 'timeout' });
  });
});
