// The forecast lab from the staff console to the job's callback, with a fake runner that records each job instead of
// starting one; the test then plays the job, signed in as the lab identity (helpers/lab.ts). Starting a calibration
// (its checks, event, charge and limits), the input the job fetches, the draft run its result makes (forecasts are off
// here, so nothing is published; lab-publish.int.test.ts publishes), 404 for every callback the job should not make,
// 503 while Entra's keys are unreachable, timeouts, deletion while a job runs, duplicated results, and logs and audit
// events with ids and counts only. Every number is synthetic.
import { createHash, randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { TownwiseContext } from '../src/app.ts';
import { canonicalSha256, type FileIssue } from '../src/forecasts/file.ts';
import { labInputFingerprint, labInputSchema, type LabInput } from '../src/lab/input.ts';
import { LabStartError } from '../src/lab/runner.ts';
import { CALIBRATION_CHARGE_MICRO_USD, CALIBRATION_TIMEOUT_MS, checkStart, launch, type StartRequest } from '../src/lab/service.ts';
import type { CalibrationView } from '../src/lab/views.ts';
import { addChatUsage, addLocation, addNote, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { holdCalls } from './helpers/hold.ts';
import {
  CODE_VERSION, failJob, fakeLabRunner, IMAGE_DIGEST, jobCall, LAB_IDENTITY, labFailure, labIdentityToken, labKeys, labResultFor,
  resultTokenOf, runDays, seedHistory, testLabCaller, type FakeLabRunner,
} from './helpers/lab.ts';
import { comparisonWith, metricsWith, scorecardWith } from './helpers/lab-scorecard.ts';
import {
  call, logLines, refresh, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let staff: TestSession;
let runner: FakeLabRunner;
/** While true, the lab caller cannot fetch Entra's keys (an outage). */
let keysDown = false;

beforeAll(async () => {
  runner = fakeLabRunner();
  server = await startTownwiseServer({
    labRunner: runner,
    labCaller: testLabCaller(
      () => server.clock.now(),
      (header, token) => (keysDown ? Promise.reject(new TypeError('fetch failed')) : labKeys(header, token)),
    ),
  });
  staff = await signInStaff(server);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  runner.onStart = null;
  keysDown = false;
});

interface Job { calibrationId: string }

interface Team { orgId: string; locationId: string; admin: TestSession }

/** An organization with an org admin and one Hanover location holding guests from `from` (2024-10-01) to 2026-05-31. */
async function team(opts?: { from?: string; guests?: (date: string, index: number) => number }): Promise<Team> {
  const orgId = await createOrg(server, { name: `Lab Kitchen ${randomUUID().slice(0, 6)}` });
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, email);
  await addSeat(server, { orgId, userId: admin.userId, email, role: 'org_admin' });
  const locationId = await addLocation(server, { orgId, name: 'Hanover Room' });
  await seedHistory(server, { orgId, locationId, from: opts?.from ?? '2024-10-01', to: '2026-05-31', ...(opts?.guests === undefined ? {} : { guests: opts.guests }) });
  return { orgId, locationId, admin };
}

function start(t: Pick<Team, 'orgId' | 'locationId'>, body: unknown = {}): Promise<Response> {
  return call(server, `/api/admin/orgs/${t.orgId}/locations/${t.locationId}/calibrations`, { session: staff, json: body });
}

async function started(t: Team, body: unknown = {}): Promise<{ calibration: CalibrationView; job: Job }> {
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

async function inputFor(job: Job): Promise<LabInput> {
  const res = await jobCall(server, job, 'input');
  expect(res.status).toBe(200);
  return labInputSchema.parse(await res.json());
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: (await res.json() as { error: string }).error };
}

/** Every townwise.lab_callback_refused line since the logs were last cleared, as { route, reason }; each holds nothing else. */
function refusedLines(): { route: unknown; reason: unknown }[] {
  const lines = logLines(server).filter((line) => line.msg === 'townwise.lab_callback_refused');
  for (const line of lines) {
    expect(Object.keys(line).filter((key) => !['hostname', 'level', 'msg', 'pid', 'time'].includes(key)).sort()).toEqual(['reason', 'route']);
  }
  return lines.map(({ route, reason }) => ({ route, reason }));
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

async function eventsFor(calibrationId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => (event.target as { id?: string } | undefined)?.id === calibrationId
    || (event.details as { calibrationId?: string } | undefined)?.calibrationId === calibrationId);
}

/**
 * A published run of the location (files_from_owner) whose forecast reaches 2026-07-09, so it is the current one. Staff
 * switch forecasts on to publish it and off again (G1), so a calibration's draft then stays a draft.
 */
async function publishedChampion(t: Team): Promise<string> {
  const forecasts = (on: boolean): Promise<Response> => call(server, `/api/admin/orgs/${t.orgId}/forecasts-switch`, {
    session: staff, json: on ? { on, ownerAgreed: true } : { on },
  });
  const file = {
    schema: 'townwise.forecast-run/1', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v5', notebookCommit: 'abcdef0' },
    trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-04-30', madeAt: '2026-05-01', frozen: null,
    interval: { level: 0.8, widened: true }, backtest: null, ...runDays('2026-04-30', 70),
  };
  const imported = await call(server, `/api/admin/orgs/${t.orgId}/locations/${t.locationId}/forecast-runs`, { session: staff, json: file });
  expect(imported.status).toBe(201);
  const { run } = await imported.json() as { run: { id: string } };
  expect((await forecasts(true)).status).toBe(200);
  expect((await call(server, `/api/admin/orgs/${t.orgId}/forecast-runs/${run.id}/publish`, { session: staff, json: {} })).status).toBe(200);
  expect((await forecasts(false)).status).toBe(200);
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
    const { calibration } = await started(t);
    expect(calibration).toMatchObject({
      locationId: t.locationId, status: 'running', failure: null, failureWords: null, via: 'console', requestedByRole: 'superadmin',
      regimeStart: null, requestedAt: '2026-06-01T12:00:00.000Z', startedAt: '2026-06-01T12:00:00.000Z', finishedAt: null, runId: null,
      chargedUsd: 0.1, gate: null, summary: null,
    });
    // While the job started, the calibration was queued and its event already written. The job was handed its
    // calibration id and nothing else, and no token hash is stored until its input fetch.
    expect(seen).toEqual([{ status: 'queued', requested: 1, tokenSha256: undefined }]);
    expect(runner.jobs.at(-1)).toEqual({ calibrationId: calibration.id });
    const doc = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(calibration.id) });
    expect(doc).toMatchObject({ status: 'running', imageDigest: IMAGE_DIGEST, chargedMicroUsd: CALIBRATION_CHARGE_MICRO_USD, championRunId: null });
    expect(doc).not.toHaveProperty('tokenSha256');
    expect(doc?.tokenExpiresAt).toEqual(new Date(Date.parse('2026-06-01T12:00:00.000Z') + CALIBRATION_TIMEOUT_MS));
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
    // The list shows it, with the organization's forecasts switch (on by default, D42), the weekly refresh and no week yet.
    expect(await list(t)).toEqual({
      forecasts: { on: true, at: null }, schedule: { running: true, paused: null }, weeks: [], calibrations: [calibration],
    });
  });

  it('a second start for the same location is 409 calibration_in_progress; a fifth start in a day is 429', async () => {
    const t = await team();
    const first = await started(t);
    const before = (await auditEvents(server)).length;
    expect(await errorOf(await start(t))).toEqual({ status: 409, error: 'calibration_in_progress' });
    // Refused by the read-only checks: nothing recorded, nothing charged.
    expect((await auditEvents(server)).length).toBe(before);
    expect((await failJob(server, first.job)).status).toBe(200);
    for (let n = 2; n <= 4; n += 1) {
      const { job } = await started(t);
      expect((await failJob(server, job)).status).toBe(200);
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

  it('under 595 days of history is 409 not_enough_history and starts no job', async () => {
    // 2024-10-14 to 2026-05-31 spans 594 days; one day more is enough.
    const short = await team({ from: '2024-10-14' });
    const jobs = runner.jobs.length;
    const before = (await auditEvents(server)).length;
    const res = await start(short);
    expect(await res.clone().json()).toMatchObject({
      error: 'not_enough_history', message: 'Calibration needs at least 595 days from the first to the last day of sales history.',
    });
    expect(res.status).toBe(409);
    expect(runner.jobs).toHaveLength(jobs);
    expect((await auditEvents(server)).length).toBe(before);
    expect(await count('tw_calibrations', { orgId: new Types.ObjectId(short.orgId) })).toBe(0);
    await started(await team({ from: '2024-10-13' }));
  });

  it('a guest day after the town’s today is not history yet: the span and the input stop at today', async () => {
    // 2024-10-14 to 2026-06-01 (today) spans 595 days, and a row dated tomorrow adds nothing.
    const t = await team({ from: '2024-10-14' });
    await seedHistory(server, { orgId: t.orgId, locationId: t.locationId, from: '2026-06-01', to: '2026-06-02' });
    const { job } = await started(t);
    const input = await inputFor(job);
    expect(input).toMatchObject({ today: '2026-06-01', dataThrough: '2026-06-01' });
    expect(input.days.find((day) => day.date === '2026-06-02')?.guests).toBeNull();
  });

  it('a pattern change date outside the history or in its last 8 weeks is 400 invalid_regime_start', async () => {
    const t = await team();
    for (const regimeStart of ['2024-09-30', '2026-04-06', 'not-a-date']) {
      const res = await start(t, { regimeStart });
      expect(res.status).toBe(400);
      expect((await res.json() as { error: string }).error).toBe(regimeStart === 'not-a-date' ? 'invalid_request' : 'invalid_regime_start');
    }
    // 2026-04-05 is 56 days before the last day.
    const { calibration } = await started(t, { regimeStart: '2026-04-05' });
    expect(calibration.regimeStart).toBe('2026-04-05');
    expect((await eventsFor(calibration.id))[0]).toMatchObject({ details: { hasRegime: true } });
    expect((await inputFor(runner.jobs.at(-1) ?? { calibrationId: '' })).regimeStart).toBe('2026-04-05');
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

  it('a store outage of townwise:calibrations denies the start: nothing is queued, started or charged', async () => {
    // A Redis client whose connection has ended stands for the outage (the limiter refuses without waiting).
    let touched = 0;
    const touch = (): Promise<null> => { touched += 1; return Promise.resolve(null); };
    const ctx = {
      labRunner: { start: () => { touched += 1; return Promise.resolve({ imageDigest: null, codeVersion: null }); } },
      redis: { status: 'end' },
      now: () => new Date('2026-06-01T12:00:00.000Z'),
      stores: { forecasts: { published: touch }, calibrations: { insertQueued: touch }, chatUsage: { add: touch } },
    } as unknown as TownwiseContext;
    const req = {
      id: new Types.ObjectId().toHexString(), scope: { orgId: new Types.ObjectId().toHexString() }, location: { id: new Types.ObjectId().toHexString() },
      requester: { userId: 'staff-0000', role: 'superadmin', via: 'console' }, regimeStart: null, today: '2026-06-01',
    } as unknown as StartRequest;
    expect(await launch(ctx, req)).toEqual({ ok: false, code: 'rate_limited' });
    expect(touched).toBe(0);
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
  it('the job fetches its input as the lab identity and a result makes a draft run with the lab block; nothing is published', async () => {
    const t = await team();
    await addNote(server, { orgId: t.orgId, locationId: t.locationId, detail: 'Closed for a private reason', startDate: '2026-02-03' });
    const championId = await publishedChampion(t);
    const { calibration, job } = await started(t);
    const input = await inputFor(job);
    expect(input).toMatchObject({ calibrationId: calibration.id, today: '2026-06-01', dataThrough: '2026-05-31', horizonDays: 182, regimeStart: null });
    expect(input.days[0]?.date).toBe('2024-10-01');
    expect(input.days.find((day) => day.date === '2026-02-03')).toMatchObject({ closed: true });
    expect(input.champion?.runId).toBe(championId);
    expect(input.champion?.recordedWeekdayBiasMeanAbs).toBeNull(); // an imported run has no recorded backtest
    expect(input.champion?.days).toHaveLength(70);
    expect(JSON.stringify(input)).not.toContain('private reason');
    const stored = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(calibration.id) });
    expect(stored).toMatchObject({
      championRunId: championId, dataThrough: '2026-05-31', inputSha256: canonicalSha256(input), dataSha256: labInputFingerprint(input),
    });

    const result = labResultFor(input);
    const res = await jobCall(server, job, 'result', result);
    expect(await res.json()).toEqual({ status: 'succeeded' });
    expect(res.status).toBe(200);

    const view = await viewOf(t, calibration.id);
    // Better than the current forecast, but forecasts are off: the gate keeps it a draft.
    expect(view).toMatchObject({
      status: 'succeeded', failure: null, finishedAt: '2026-06-01T12:00:00.000Z', gate: { published: false, reason: 'forecasts_off' },
    });
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
      details: {
        locationId: t.locationId, calibrationId: calibration.id, status: 'succeeded', gate: 'forecasts_off', failure: null, runId: view.runId,
        heldOutWeeks: 12,
      },
    });
    // Nothing published: the current forecast is still the only published run, and no publish event was written.
    expect(await count('tw_forecast_runs', { locationId: new Types.ObjectId(t.locationId), status: 'published' })).toBe(1);
    expect((await auditEvents(server)).filter((event) => event.action === 'forecast.published' && (event.target as { id: string }).id !== championId))
      .toEqual([]);
    // A finished calibration takes no more calls.
    expect((await jobCall(server, job, 'input')).status).toBe(404);
  });

  it('the lab identity fetches the input once; a result needs the identity token and the result token that fetch handed out', async () => {
    const t = await team();
    const { calibration, job } = await started(t);
    // Another running calibration, whose input was fetched, for its result token.
    const other = (await started(await team())).job;
    await inputFor(other);
    server.logs.length = 0;
    const res = await jobCall(server, job, 'input');
    expect(res.status).toBe(200);
    const resultToken = res.headers.get('x-townwise-result-token') ?? '';
    expect(resultToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const input = labInputSchema.parse(await res.json());
    const sha = (token: string): string => createHash('sha256').update(token).digest('hex');
    const stored = () => server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(calibration.id) });
    expect(await stored()).toMatchObject({ tokenSha256: sha(resultToken), inputSha256: canonicalSha256(input), dataThrough: '2026-05-31' });
    const before = JSON.stringify(await stored());
    // A second fetch, by the lab identity or anyone holding its token, is 404 and changes nothing recorded.
    expect((await jobCall(server, job, 'input')).status).toBe(404);
    const result = labResultFor(input);
    const refusedPosts = [
      // The identity token alone.
      { reason: 'result_token', opts: { resultToken: null } },
      // The result token alone, or with a token that is not the lab identity's.
      { reason: 'missing', opts: { authorization: null, resultToken } },
      { reason: 'malformed', opts: { authorization: 'Bearer not.a.token', resultToken } },
      { reason: 'caller', opts: { authorization: `Bearer ${await labIdentityToken(server, { oid: '44444444-4444-4444-8444-444444444444' })}`, resultToken } },
      // Another calibration's result token, a garbled one, or the right one cut short.
      { reason: 'result_token', opts: { resultToken: resultTokenOf(other.calibrationId) ?? '' } },
      { reason: 'result_token', opts: { resultToken: `${resultToken.slice(0, 42)}!` } },
      { reason: 'result_token', opts: { resultToken: resultToken.slice(0, 42) } },
    ];
    for (const { opts } of refusedPosts) {
      expect((await jobCall(server, job, 'result', result, opts)).status).toBe(404);
      expect((await jobCall(server, job, 'result', labFailure(job, 'internal'), opts)).status).toBe(404);
    }
    expect(JSON.stringify(await stored())).toBe(before);
    // Each refusal is logged with its route and reason only: the second fetch found nothing to fetch.
    expect(refusedLines()).toEqual([
      { route: 'input', reason: 'not_live' },
      ...refusedPosts.flatMap(({ reason }) => [{ route: 'result', reason }, { route: 'result', reason }]),
    ]);
    expect(resultTokenOf(calibration.id)).toBe(resultToken);
    expect((await jobCall(server, job, 'result', result)).status).toBe(200);
    expect((await viewOf(t, calibration.id)).status).toBe('succeeded');
    expect(JSON.stringify(await stored())).not.toContain(resultToken);
    const logs = server.logs.join('\n');
    expect(logs).not.toContain(resultToken);
    expect(JSON.stringify(await eventsFor(calibration.id))).not.toContain(resultToken);
  });

  it('a job that fetches its input before its start returns still has its image recorded', async () => {
    const t = await team();
    const fetched: number[] = [];
    runner.onStart = async (job) => { fetched.push((await jobCall(server, job, 'input')).status); };
    const { calibration } = await started(t);
    expect(fetched).toEqual([200]);
    const doc = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(calibration.id) });
    expect(doc).toMatchObject({ status: 'running', imageDigest: IMAGE_DIGEST, chargedMicroUsd: CALIBRATION_CHARGE_MICRO_USD });
  });

  it('before the input was fetched, no result is taken, and the calibration stays live', async () => {
    const t = await team();
    const { calibration, job } = await started(t);
    const other = (await started(await team())).job;
    await inputFor(other);
    const result = labResultFor(labInputSchema.parse({
      schema: 'townwise.lab-input/2', calibrationId: calibration.id, metric: 'guests', today: '2026-06-01', dataThrough: '2026-05-31',
      horizonDays: 182, regimeStart: null, days: [{ date: '2026-05-31', guests: 1, term: 'interim', weekOfTerm: -1, events: [], closed: false, privateEvent: false, booked: false }],
      calendar: [], champion: null,
    }));
    server.logs.length = 0;
    for (const resultToken of [null, 'A'.repeat(43), resultTokenOf(other.calibrationId) ?? '']) {
      expect((await jobCall(server, job, 'result', result, { resultToken })).status).toBe(404);
      expect((await jobCall(server, job, 'result', labFailure(job, 'internal'), { resultToken })).status).toBe(404);
    }
    // The calibration is live, so each is a result token refusal.
    expect(refusedLines()).toEqual(Array.from({ length: 6 }, () => ({ route: 'result', reason: 'result_token' })));
    expect(await viewOf(t, calibration.id)).toMatchObject({ status: 'running', failure: null, runId: null });
    expect(await count('tw_forecast_runs', { locationId: new Types.ObjectId(t.locationId) })).toBe(0);
    // The job's own fetch still works.
    await inputFor(job);
  });

  it('input and result answer 404 for an unknown, malformed or finished id and any token but the lab identity’s, never 401', async () => {
    const a = await team();
    const jobA = (await started(a)).job;
    const finished = (await started(await team())).job;
    expect((await failJob(server, finished)).status).toBe(200);
    server.logs.length = 0;
    const statuses: number[] = [];
    const both = async (job: Job, opts?: { authorization?: string | null }): Promise<void> => {
      statuses.push((await jobCall(server, job, 'input', undefined, opts)).status);
      statuses.push((await jobCall(server, job, 'result', labFailure(job, 'internal'), { ...opts, resultToken: 'A'.repeat(43) })).status);
    };
    // Not a live calibration, with a good identity token: each logged as not_live, so probing ids shows.
    await both({ calibrationId: new Types.ObjectId().toHexString() });
    await both({ calibrationId: 'not-an-id' });
    await both(finished);
    expect(refusedLines()).toEqual(Array.from({ length: 3 }, () => [
      { route: 'input', reason: 'not_live' }, { route: 'result', reason: 'not_live' },
    ]).flat());
    server.logs.length = 0;
    // A live calibration, with anything but the lab identity's token for the callback app.
    const now = Math.floor(server.clock.now().getTime() / 1000);
    const refusals: { reason: string; authorization: string | null }[] = [
      { reason: 'missing', authorization: null },
      { reason: 'malformed', authorization: `Basic ${await labIdentityToken(server)}` },
      { reason: 'audience', authorization: `Bearer ${await labIdentityToken(server, { aud: 'https://management.azure.com/' })}` },
      { reason: 'audience', authorization: `Bearer ${await labIdentityToken(server, { aud: `api://${LAB_IDENTITY.audience}` })}` },
      { reason: 'issuer', authorization: `Bearer ${await labIdentityToken(server, { iss: `https://sts.windows.net/${LAB_IDENTITY.tenantId}/` })}` },
      { reason: 'tenant', authorization: `Bearer ${await labIdentityToken(server, { tid: '55555555-5555-4555-8555-555555555555' })}` },
      { reason: 'caller', authorization: `Bearer ${await labIdentityToken(server, { oid: '44444444-4444-4444-8444-444444444444' })}` },
      { reason: 'expired', authorization: `Bearer ${await labIdentityToken(server, { nbf: now - 7200, exp: now - 60 })}` },
    ];
    for (const { authorization } of refusals) await both(jobA, { authorization });
    expect(statuses.every((status) => status === 404)).toBe(true);
    expect(statuses).toHaveLength(6 + refusals.length * 2);
    // Each token refusal logs its route and reason, and nothing else.
    expect(refusedLines()).toEqual(refusals.flatMap(({ reason }) => [{ route: 'input', reason }, { route: 'result', reason }]));
    const logs = server.logs.join('\n');
    for (const { authorization } of refusals) {
      for (const part of (authorization ?? '').replace(/^\w+ /, '').split('.').filter((each) => each !== '')) expect(logs).not.toContain(part);
    }
    // None of those touched the live calibration: its job fetches its input and fails it as usual.
    expect(await viewOf(a, jobA.calibrationId)).toMatchObject({ status: 'running', failure: null });
    expect(await count('tw_calibrations', { _id: new Types.ObjectId(jobA.calibrationId), inputSha256: null })).toBe(1);
    expect((await failJob(server, jobA)).status).toBe(200);
    expect((await viewOf(a, jobA.calibrationId)).failure).toBe('job_failed');
  });

  it('while Entra’s keys cannot be fetched, input and result answer 503 and change nothing', async () => {
    const t = await team();
    const { calibration, job } = await started(t);
    const fetched = (await started(await team())).job;
    const input = await inputFor(fetched);
    const ids = [calibration.id, fetched.calibrationId].map((id) => new Types.ObjectId(id));
    const stored = () => server.connection.collection('tw_calibrations').find({ _id: { $in: ids } }).toArray();
    const before = JSON.stringify(await stored());
    keysDown = true;
    server.logs.length = 0;
    expect(await errorOf(await jobCall(server, job, 'input'))).toEqual({ status: 503, error: 'lab_auth_unavailable' });
    expect(await errorOf(await jobCall(server, fetched, 'result', labResultFor(input)))).toEqual({ status: 503, error: 'lab_auth_unavailable' });
    expect(JSON.stringify(await stored())).toBe(before);
    const unavailable = logLines(server).filter((line) => line.msg === 'townwise.lab_callback_unavailable');
    expect(unavailable.map(({ level, route, reason }) => ({ level, route, reason }))).toEqual([
      { level: 40, route: 'input', reason: 'keys_unavailable' }, { level: 40, route: 'result', reason: 'keys_unavailable' },
    ]);
    // Once the keys are back, the job's retry goes through.
    keysDown = false;
    expect((await jobCall(server, fetched, 'result', labResultFor(input))).status).toBe(200);
    await inputFor(job);
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

  it('logs, audit events and the database carry ids and counts only, and neither token', async () => {
    const t = await team({ guests: () => 98765 });
    server.logs.length = 0;
    const { calibration, job } = await started(t);
    const identity = await labIdentityToken(server);
    const signedIn = { authorization: `Bearer ${identity}` };
    const fetched = await jobCall(server, job, 'input', undefined, signedIn);
    expect(fetched.status).toBe(200);
    const input = labInputSchema.parse(await fetched.json());
    expect(input.days[0]?.guests).toBe(98765);
    const scorecard = scorecardWith({ backtest: { metrics: metricsWith({ weeklyWape: 0.123456 }) }, comparison: null });
    expect((await jobCall(server, job, 'result', labResultFor(input, { scorecard }), signedIn)).status).toBe(200);
    expect((await viewOf(t, calibration.id)).summary?.weeklyWapePct).toBe(12.3);
    const logs = server.logs.join('\n');
    const events = JSON.stringify(await eventsFor(calibration.id));
    const stored = JSON.stringify(await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(calibration.id) }));
    const resultToken = resultTokenOf(calibration.id);
    expect(resultToken).toBeDefined();
    for (const text of [logs, events]) {
      expect(text).not.toContain('98765');
      expect(text).not.toContain('0.123456');
    }
    // The calibration keeps its scorecard, but neither token: only the result token's hash, gone once it finished.
    for (const text of [logs, events, stored]) {
      for (const part of identity.split('.')) expect(text).not.toContain(part);
      expect(text).not.toContain(resultToken);
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
    // Its callback window closed with the 20 minutes, before anything read the calibration.
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
