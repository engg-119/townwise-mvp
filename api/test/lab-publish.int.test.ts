// The forecast lab's publish step (G1, G2, G3), with a fake runner; the test plays the job (helpers/lab.ts). A draft
// that passes the gate is published by the system when the organization's forecasts are switched on, and stays a draft
// when they are off or the organization is suspended; a current forecast withdrawn while the job ran; two result posts
// at once; a result equal to a run that already exists; a published lab run read by owners and withdrawn by staff; the
// forecasts switch; and the system's events in the org admins' staff activity. Every number is synthetic.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StaffActivityView } from '../src/audit.ts';
import type { ForecastWindow } from '../src/forecasts/reader.ts';
import { gateWords, GATE_WORDS } from '../src/lab/gate.ts';
import { labInputSchema, type LabInput } from '../src/lab/input.ts';
import type { LabSuccess } from '../src/lab/result.ts';
import type { CalibrationView } from '../src/lab/views.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { holdCalls } from './helpers/hold.ts';
import { fakeLabRunner, jobCall, labResultFor, runDays, seedHistory, type FakeLabRunner } from './helpers/lab.ts';
import { metricsWith, scorecardWith } from './helpers/lab-scorecard.ts';
import {
  call, logLines, signIn, signInStaff, STAFF_EMAIL, startTownwiseServer, type TestSession, type TownwiseTestServer,
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
beforeEach(async () => { await server.redis.flushdb(); });

interface Team { orgId: string; locationId: string; admin: TestSession }
interface Job { calibrationId: string }

const ON = { on: true, ownerAgreed: true } as const;

function switchForecasts(t: Pick<Team, 'orgId'>, body: unknown, session = staff): Promise<Response> {
  return call(server, `/api/admin/orgs/${t.orgId}/forecasts-switch`, { session, json: body });
}

/**
 * An organization with an org admin and one Hanover location holding guests from 2024-10-01 to `to` (2026-05-31), with
 * its forecasts switched on through the console when `forecastsOn`.
 */
async function team(opts?: { forecastsOn?: boolean; to?: string; unswitched?: true }): Promise<Team> {
  // Switched off by staff unless `unswitched` (never switched, on by default since D42), so switching on goes through
  // the console.
  const name = `Publish Kitchen ${randomUUID().slice(0, 6)}`;
  const orgId = await createOrg(server, opts?.unswitched === true ? { name } : { name, forecastsOn: false });
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, email);
  await addSeat(server, { orgId, userId: admin.userId, email, role: 'org_admin' });
  const locationId = await addLocation(server, { orgId, name: 'Hanover Room' });
  await seedHistory(server, { orgId, locationId, from: '2024-10-01', to: opts?.to ?? '2026-05-31' });
  if (opts?.forecastsOn === true) expect((await switchForecasts({ orgId }, ON)).status).toBe(200);
  return { orgId, locationId, admin };
}

async function started(t: Team): Promise<{ calibration: CalibrationView; job: Job }> {
  const res = await call(server, `/api/admin/orgs/${t.orgId}/locations/${t.locationId}/calibrations`, { session: staff, json: {} });
  expect(res.status).toBe(201);
  const { calibration } = await res.json() as { calibration: CalibrationView };
  const job = runner.jobs.at(-1);
  if (job?.calibrationId !== calibration.id) throw new Error('the runner did not get this calibration');
  return { calibration, job };
}

async function inputFor(job: Job): Promise<LabInput> {
  const res = await jobCall(server, job, 'input');
  expect(res.status).toBe(200);
  return labInputSchema.parse(await res.json());
}

/** The job posts `result`; resolves the answer's status and body. */
async function post(job: Job, result: LabSuccess): Promise<{ status: number; body: unknown }> {
  const res = await jobCall(server, job, 'result', result);
  return { status: res.status, body: await res.json() as unknown };
}

async function viewOf(t: Pick<Team, 'orgId'>, id: string): Promise<CalibrationView> {
  const res = await call(server, `/api/admin/orgs/${t.orgId}/calibrations`, { session: staff });
  expect(res.status).toBe(200);
  const found = (await res.json() as { calibrations: CalibrationView[] }).calibrations.find((each) => each.id === id);
  if (found === undefined) throw new Error('no such calibration');
  return found;
}

function runDoc(runId: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_forecast_runs').findOne({ _id: new Types.ObjectId(runId) });
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

async function orgEvents(orgId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => String(event.orgId) === orgId);
}

async function actionsOf(orgId: string, action: string): Promise<Record<string, unknown>[]> {
  return (await orgEvents(orgId)).filter((event) => event.action === action);
}

async function eventsFor(calibrationId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => (event.target as { id?: string } | undefined)?.id === calibrationId
    || (event.details as { calibrationId?: string } | undefined)?.calibrationId === calibrationId);
}

function changeRun(t: Pick<Team, 'orgId'>, runId: string, verb: 'publish' | 'withdraw'): Promise<Response> {
  return call(server, `/api/admin/orgs/${t.orgId}/forecast-runs/${runId}/${verb}`, { session: staff, json: {} });
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
  expect((await changeRun(t, run.id, 'publish')).status).toBe(200);
  return run.id;
}

async function forecastOf(t: Team, from: string, to: string): Promise<ForecastWindow> {
  const res = await call(server, `/api/org/locations/${t.locationId}/forecast?from=${from}&to=${to}`, { session: t.admin });
  expect(res.status).toBe(200);
  return res.json() as Promise<ForecastWindow>;
}

const SUCCEEDED = { status: 200, body: { status: 'succeeded' } };

describe('the gate decides', () => {
  it('a passing draft with forecasts on is published, with forecast.published by the system actor before the effect', async () => {
    const t = await team({ forecastsOn: true });
    const { calibration, job } = await started(t);
    const result = labResultFor(await inputFor(job));
    server.logs.length = 0;
    // The run's two status writes: importing to draft, then draft to published, which waits here.
    const writes = holdCalls(server, 'updateOne', 'TwForecastRun');
    let answer: { status: number; body: unknown };
    try {
      writes.release(1);
      const posted = post(job, result);
      await writes.arrived(2);
      // Before the effect: the event is written and the run is still a draft.
      expect(await actionsOf(t.orgId, 'forecast.published')).toHaveLength(1);
      const [draft] = await server.connection.collection('tw_forecast_runs').find({ locationId: new Types.ObjectId(t.locationId) }).toArray();
      expect(draft?.status).toBe('draft');
      writes.release(2);
      answer = await posted;
    } finally {
      writes.restore();
    }
    expect(answer).toEqual(SUCCEEDED);

    const view = await viewOf(t, calibration.id);
    expect(view).toMatchObject({ status: 'succeeded', gate: { published: true, reason: 'published', words: gateWords('published', true) } });
    const runId = view.runId ?? '';
    expect(await runDoc(runId)).toMatchObject({
      status: 'published', publishedAt: server.clock.now(), publishedBy: null, importedBy: null, trainingSource: 'townwise_lab',
      lab: { calibrationId: calibration.id },
    });
    const events = await eventsFor(calibration.id);
    expect(events.map((event) => event.action)).toEqual(['calibration.requested', 'forecast.published', 'calibration.finished']);
    expect(events[1]).toEqual(expect.objectContaining({
      actorUserId: 'system', actorEmail: 'Townwise forecast lab', actorRole: 'system', viewAsGrantId: null,
      target: { type: 'forecast_run', id: runId },
      details: {
        locationId: t.locationId, modelVersion: 'v6', from: '2026-06-01', to: '2026-06-14', dayCount: 14, via: 'lab',
        calibrationId: calibration.id,
      },
    }));
    expect(events[2]).toMatchObject({
      actorRole: 'system', details: { status: 'succeeded', gate: 'published', failure: null, runId, heldOutWeeks: 12 },
    });
    expect(await actionsOf(t.orgId, 'staff_action.not_applied')).toEqual([]);
    const own = logLines(server).filter((line) => line.msg === 'townwise.calibration_finished' || line.msg === 'townwise.forecast_status');
    expect(own.map((line) => line.msg)).toEqual(['townwise.forecast_status', 'townwise.calibration_finished']);
    expect(own[0]).toEqual(expect.objectContaining({ orgId: t.orgId, runId, status: 'published' }));
    expect(own[1]).toMatchObject({ calibrationId: calibration.id, status: 'succeeded', gate: 'published', heldOutWeeks: 12 });
  });

  it('beating a published forecast publishes with the words for the current forecast, not the weekday average', async () => {
    const t = await team({ forecastsOn: true });
    await publishedChampion(t);
    const { calibration, job } = await started(t);
    expect(await post(job, labResultFor(await inputFor(job)))).toEqual(SUCCEEDED);
    const view = await viewOf(t, calibration.id);
    expect(view).toMatchObject({ gate: { published: true, reason: 'published', words: GATE_WORDS.published } });
    expect(GATE_WORDS.published).toContain('current forecast');
  });

  it('a passing draft of an organization nobody switched publishes: forecasts are on by default (D42)', async () => {
    const t = await team({ unswitched: true });
    expect(await server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(t.orgId) })).not.toHaveProperty('forecasts');
    const { calibration, job } = await started(t);
    expect(await post(job, labResultFor(await inputFor(job)))).toEqual(SUCCEEDED);
    const view = await viewOf(t, calibration.id);
    expect(view).toMatchObject({ status: 'succeeded', gate: { published: true, reason: 'published' } });
    expect(await runDoc(view.runId ?? '')).toMatchObject({ status: 'published' });
    expect(await actionsOf(t.orgId, 'forecast.published')).toHaveLength(1);
  });

  it('a passing draft with forecasts off stays a draft with gate forecasts_off, and nothing is published', async () => {
    const t = await team();
    const { calibration, job } = await started(t);
    expect(await post(job, labResultFor(await inputFor(job)))).toEqual(SUCCEEDED);
    const view = await viewOf(t, calibration.id);
    expect(view).toMatchObject({ status: 'succeeded', gate: { published: false, reason: 'forecasts_off', words: GATE_WORDS.forecasts_off } });
    expect(await runDoc(view.runId ?? '')).toMatchObject({ status: 'draft', publishedAt: null });
    expect(await actionsOf(t.orgId, 'forecast.published')).toEqual([]);
    expect((await eventsFor(calibration.id)).at(-1)).toMatchObject({
      action: 'calibration.finished', details: { status: 'succeeded', gate: 'forecasts_off', runId: view.runId },
    });
  });

  it('a suspended organization counts as forecasts off', async () => {
    const t = await team({ forecastsOn: true });
    const { calibration, job } = await started(t);
    const input = await inputFor(job);
    expect((await call(server, `/api/admin/orgs/${t.orgId}`, { method: 'PATCH', session: staff, json: { status: 'suspended' } })).status).toBe(200);
    expect(await post(job, labResultFor(input))).toEqual(SUCCEEDED);
    const view = await viewOf(t, calibration.id);
    expect(view.gate).toMatchObject({ published: false, reason: 'forecasts_off' });
    expect(await runDoc(view.runId ?? '')).toMatchObject({ status: 'draft' });
    expect(await actionsOf(t.orgId, 'forecast.published')).toEqual([]);
  });

  it('a champion withdrawn while the job ran gives champion_changed and no publish', async () => {
    const t = await team({ forecastsOn: true });
    const championId = await publishedChampion(t);
    const { calibration, job } = await started(t);
    const input = await inputFor(job);
    expect(input.champion?.runId).toBe(championId);
    expect((await changeRun(t, championId, 'withdraw')).status).toBe(200);
    // Better than the forecast it was compared with, which is no longer published.
    expect(await post(job, labResultFor(input))).toEqual(SUCCEEDED);
    const view = await viewOf(t, calibration.id);
    expect(view).toMatchObject({
      status: 'succeeded', gate: { published: false, reason: 'champion_changed', words: GATE_WORDS.champion_changed },
    });
    expect(await runDoc(view.runId ?? '')).toMatchObject({ status: 'draft' });
    expect(await count('tw_forecast_runs', { locationId: new Types.ObjectId(t.locationId), status: 'published' })).toBe(0);
    expect((await actionsOf(t.orgId, 'forecast.published')).map((event) => (event.target as { id: string }).id)).toEqual([championId]);
  });
});

describe('one set of rules for every calibration (D42)', () => {
  /** A run of `length` days (70 by default, so it is the current one once published) with every middle `mid`. */
  function run70(mid: number, length = 70): Partial<LabSuccess['run']> {
    const { days, weeks } = runDays('2026-05-31', length);
    return {
      days: days.map((day) => ({ ...day, low: mid * 0.8, mid, high: mid * 1.25, baseline: mid })),
      weeks: weeks.map((week) => ({ ...week, low: week.openDays * mid * 0.8, mid: week.openDays * mid, high: week.openDays * mid * 1.25 })),
    };
  }

  /** A calibration of `t` whose job posts a model draft with backtest weekly WAPE `wape`, no held-out week and middles `mid`. */
  async function calibrateWith(t: Team, wape: number, mid = 50, length = 70): Promise<CalibrationView> {
    const { calibration, job } = await started(t);
    const input = await inputFor(job);
    const scorecard = scorecardWith({
      comparison: null, backtest: { metrics: metricsWith({ weeklyWape: wape }) },
      history: { firstDate: input.days[0]?.date ?? '', lastDate: input.dataThrough, spanDays: 607 },
    });
    expect(await post(job, labResultFor(input, { scorecard, run: run70(mid, length) }))).toEqual(SUCCEEDED);
    return viewOf(t, calibration.id);
  }

  it('a refit against a one-week-old lab run is judged on the streak’s best recorded backtest, not held-out weeks', async () => {
    const t = await team({ forecastsOn: true });
    expect((await calibrateWith(t, 0.17)).gate).toMatchObject({ published: true, reason: 'published' });
    // 0.6 points above the run's recorded 17.0%: worse, and no held-out week would have answered too_few_weeks
    expect((await calibrateWith(t, 0.176, 51)).gate).toMatchObject({ published: false, reason: 'refresh_worse', words: GATE_WORDS.refresh_worse });
    // 0.5 points above: a tie publishes
    const refreshed = await calibrateWith(t, 0.175, 52);
    expect(refreshed.gate).toMatchObject({ published: true, reason: 'refreshed', words: GATE_WORDS.refreshed });
    expect(await runDoc(refreshed.runId ?? '')).toMatchObject({ status: 'published' });
    // The streak's best is still the first run's 17.0%, so 17.9% is held, though it is within 0.5 points of 17.5%
    expect((await calibrateWith(t, 0.179, 53)).gate).toMatchObject({ published: false, reason: 'refresh_worse' });
  });

  it('a passing refit whose next 28 days move more than 25% from the current run’s is held for staff', async () => {
    const t = await team({ forecastsOn: true });
    expect((await calibrateWith(t, 0.17)).gate?.reason).toBe('published');
    const jumped = await calibrateWith(t, 0.17, 65);
    expect(jumped.gate).toMatchObject({ published: false, reason: 'jump_held', words: GATE_WORDS.jump_held });
    expect(await runDoc(jumped.runId ?? '')).toMatchObject({ status: 'draft' });
    // The line the ops alert forecasts_held reads (infra monitoring.tf): ids and the gate's code, never a figure.
    const held = logLines(server).filter((line) => line.msg === 'townwise.calibration_finished' && line.calibrationId === jumped.id);
    expect(held).toEqual([expect.objectContaining({ orgId: t.orgId, calibrationId: jumped.id, status: 'succeeded', gate: 'jump_held' })]);
    expect((await calibrateWith(t, 0.17, 60)).gate).toMatchObject({ published: true, reason: 'refreshed' });
  });

  it('with the current run lapsed, a draft whose next 28 days move more than 25% from the newest published run is held too', async () => {
    const t = await team({ forecastsOn: true });
    // A published run reaching only 20 days ahead, so it is never the current one (that needs 28): the next draft is a
    // first forecast again, with nothing current to compare with.
    expect((await calibrateWith(t, 0.17, 50, 20)).gate?.reason).toBe('published');
    const jumped = await calibrateWith(t, 0.17, 65);
    expect(jumped.gate).toMatchObject({ published: false, reason: 'jump_held', words: GATE_WORDS.jump_held });
    expect(await runDoc(jumped.runId ?? '')).toMatchObject({ status: 'draft' });
    expect((await calibrateWith(t, 0.17, 55)).gate).toMatchObject({ published: true, reason: 'published' });
  });

  it('a lapsed year-long run’s outlook stays out of the jump guard (D52): only its forecast tier’s days are compared', async () => {
    const t = await team({ forecastsOn: true });
    // An imported year-long run made 2026-03-11 (82 days before today, 2026-06-01): its forecast tier ends 2026-06-10,
    // 10 days into the draft's 28, so it is lapsed. Its middles are 50 through then and 100 in its outlook.
    const { days, weeks } = runDays('2026-03-10', 366);
    const file = {
      schema: 'townwise.forecast-run/1', metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v5', notebookCommit: 'abcdef0' },
      trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-03-10', madeAt: '2026-03-11', frozen: null,
      interval: { level: 0.8, widened: true }, backtest: null, weeks,
      days: days.map((day) => (day.date > '2026-06-10' ? { ...day, low: 80, mid: 100, high: 125, baseline: 100 } : day)),
    };
    const imported = await call(server, `/api/admin/orgs/${t.orgId}/locations/${t.locationId}/forecast-runs`, { session: staff, json: file });
    expect(imported.status).toBe(201);
    const { run } = await imported.json() as { run: { id: string } };
    expect((await changeRun(t, run.id, 'publish')).status).toBe(200);
    // Middles of 50 against its 10 forecast-tier days of 50: no jump. Its 18 outlook days at 100 would have held it.
    const draft = await calibrateWith(t, 0.17, 50);
    expect(draft.gate).toMatchObject({ published: true, reason: 'published' });
  });
});

describe('retries, races and existing runs', () => {
  async function onePublish(t: Team, calibrationId: string, answers: unknown[]): Promise<void> {
    expect(answers).toEqual([SUCCEEDED, SUCCEEDED]);
    expect(await count('tw_forecast_runs', { locationId: new Types.ObjectId(t.locationId) })).toBe(1);
    const view = await viewOf(t, calibrationId);
    expect(view).toMatchObject({ status: 'succeeded', gate: { published: true, reason: 'published' } });
    expect(await runDoc(view.runId ?? '')).toMatchObject({ status: 'published' });
    const events = await eventsFor(calibrationId);
    expect(events.filter((event) => event.action === 'forecast.published')).toHaveLength(1);
    expect(events.filter((event) => event.action === 'calibration.finished')).toHaveLength(1);
    expect(await actionsOf(t.orgId, 'staff_action.not_applied')).toEqual([]);
  }

  it('two concurrent result posts make one run, one publish and one finished event', async () => {
    // Both reach the gate with the run a draft: the first waits on its gate write while the second runs to the end.
    const raced = await team({ forecastsOn: true });
    const first = await started(raced);
    const result = labResultFor(await inputFor(first.job));
    // The calibration's writes from here: 1 and 2 the first post's result and gate, 3 to 5 the second post's result,
    // gate and finish.
    const writes = holdCalls(server, 'updateOne', 'TwCalibration');
    const answers: unknown[] = [];
    try {
      writes.release(1);
      const early = post(first.job, result);
      await writes.arrived(2);
      for (const n of [3, 4, 5]) writes.release(n);
      answers.push(await post(first.job, result));
      writes.open();
      answers.push(await early);
    } finally {
      writes.restore();
    }
    await onePublish(raced, first.calibration.id, answers);

    // The first waits on its rows while the second publishes and finishes: the first then finds the run published.
    const late = await team({ forecastsOn: true });
    const second = await started(late);
    const lateResult = labResultFor(await inputFor(second.job));
    const rows = holdCalls(server, 'bulkWrite', 'TwForecast');
    const lateAnswers: unknown[] = [];
    try {
      const waiting = post(second.job, lateResult);
      await rows.arrived(1);
      rows.release(2);
      lateAnswers.push(await post(second.job, lateResult));
      rows.release(1);
      lateAnswers.push(await waiting);
    } finally {
      rows.restore();
    }
    await onePublish(late, second.calibration.id, lateAnswers);
  });

  it('an outage between the gate and the publish: the job’s retried post publishes the draft once', async () => {
    const t = await team({ forecastsOn: true });
    const { calibration, job } = await started(t);
    const result = labResultFor(await inputFor(job));
    // The audit store refuses the first forecast.published event, after the gate was recorded.
    const events = server.connection.models.TwAuditEvent as unknown as { create: (...args: unknown[]) => Promise<unknown> };
    const create = events.create.bind(events);
    let refused = 0;
    const spy = vi.spyOn(events, 'create').mockImplementation(async (...args: unknown[]) => {
      if ((args[0] as { action?: string }).action === 'forecast.published' && refused === 0) {
        refused += 1;
        throw new Error('audit store unavailable');
      }
      return create(...args);
    });
    try {
      expect((await post(job, result)).status).toBe(503);
      const doc = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(calibration.id) });
      expect(doc).toMatchObject({ status: 'running', gate: { published: true, reason: 'published' } });
      expect(await runDoc(String(doc?.runId))).toMatchObject({ status: 'draft' });
      expect(await post(job, result)).toEqual(SUCCEEDED);
    } finally {
      spy.mockRestore();
    }
    expect(refused).toBe(1);
    await onePublish(t, calibration.id, [SUCCEEDED, SUCCEEDED]);
  });

  it('the lab never changes an existing run: a result equal to a published run’s file answers that run unchanged', async () => {
    const t = await team({ forecastsOn: true });
    // The first calibration publishes a forecast reaching 70 days ahead, so it becomes the current one.
    const first = await started(t);
    const firstResult = labResultFor(await inputFor(first.job), { run: runDays('2026-05-31', 70) });
    expect(await post(first.job, firstResult)).toEqual(SUCCEEDED);
    const runId = (await viewOf(t, first.calibration.id)).runId ?? '';
    const before = await runDoc(runId);
    expect(before).toMatchObject({ status: 'published', lab: { calibrationId: first.calibration.id } });
    const rows = await count('tw_forecasts', { runId: new Types.ObjectId(runId) });

    // The second, compared with it and better on paper, posts the very same run file.
    const second = await started(t);
    const input = await inputFor(second.job);
    expect(input.champion?.runId).toBe(runId);
    // The lab holds an engine switch to the gate's weekday-bias check against the run's recorded backtest (D42).
    expect(input.champion?.recordedWeekdayBiasMeanAbs).toBe(firstResult.scorecard.backtest.metrics.weekdayBiasMeanAbs);
    expect(await post(second.job, labResultFor(input, { run: firstResult.run }))).toEqual(SUCCEEDED);
    expect(await runDoc(runId)).toEqual(before);
    expect(await count('tw_forecasts', { runId: new Types.ObjectId(runId) })).toBe(rows);
    expect(await count('tw_forecast_runs', { locationId: new Types.ObjectId(t.locationId) })).toBe(1);
    // It names that run, and gated nothing: no publish, no refused write.
    expect(await viewOf(t, second.calibration.id)).toMatchObject({ status: 'succeeded', runId, gate: null });
    expect((await eventsFor(second.calibration.id)).map((event) => event.action)).toEqual(['calibration.requested', 'calibration.finished']);
    expect((await eventsFor(second.calibration.id)).at(-1)).toMatchObject({ details: { gate: null, runId } });
    expect(await actionsOf(t.orgId, 'forecast.published')).toHaveLength(1);
    expect(await actionsOf(t.orgId, 'staff_action.not_applied')).toEqual([]);

    // A draft another calibration made stays that calibration's draft too, even once forecasts are on.
    const d = await team();
    const kept = await started(d);
    const keptResult = labResultFor(await inputFor(kept.job));
    expect(await post(kept.job, keptResult)).toEqual(SUCCEEDED);
    const draftId = (await viewOf(d, kept.calibration.id)).runId ?? '';
    const draft = await runDoc(draftId);
    expect(draft).toMatchObject({ status: 'draft', lab: { calibrationId: kept.calibration.id } });
    expect((await switchForecasts(d, ON)).status).toBe(200);
    const again = await started(d);
    expect(await post(again.job, labResultFor(await inputFor(again.job), { run: keptResult.run }))).toEqual(SUCCEEDED);
    expect(await runDoc(draftId)).toEqual(draft);
    expect(await viewOf(d, again.calibration.id)).toMatchObject({ status: 'succeeded', runId: draftId, gate: null });
    expect(await actionsOf(d.orgId, 'forecast.published')).toEqual([]);
  });
});

describe('a published lab run', () => {
  it('a published lab run reads in GET /org/locations/:id/forecast with trainingSource townwise_lab and its live accuracy', async () => {
    // Sales through May 24 when it ran; the week after arrives once it is published.
    const t = await team({ forecastsOn: true, to: '2026-05-24' });
    const { calibration, job } = await started(t);
    const input = await inputFor(job);
    expect(input.dataThrough).toBe('2026-05-24');
    expect(await post(job, labResultFor(input))).toEqual(SUCCEEDED);
    const runId = (await viewOf(t, calibration.id)).runId ?? '';
    await seedHistory(server, { orgId: t.orgId, locationId: t.locationId, from: '2026-05-25', to: '2026-05-31', guests: () => 55 });
    const body = await forecastOf(t, '2026-05-25', '2026-06-07');
    expect(body.runs).toEqual([{
      id: runId, metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v6', label: 'Townwise demand model v6' }, engine: 'model',
      trainingSource: 'townwise_lab', trainedFrom: '2024-10-01', dataThrough: '2026-05-24', madeAt: '2026-06-01', frozen: false,
      interval: { level: 0.8, widened: true },
      backtest: { from: '2026-01-05', to: '2026-03-29', weeks: 12, weeklyTypicalErrorPct: 9.5, weeksOver20Pct: 1, weeklyRangePct: { below: 10, above: 20 } },
      // Seven days scored, each 5 guests off a forecast of 50 and inside its range: 35 over 385 guests.
      live: { days: 7, inRange: 7, typicalErrorPct: 9.1, from: '2026-05-25', to: '2026-05-31' },
    }]);
    expect(body.days).toHaveLength(14);
    expect(body.days.every((day) => day.runId === runId)).toBe(true);
    expect(body.days[0]).toMatchObject({ date: '2026-05-25', mid: 50, actual: 55, inRange: true });
  });

  it('staff withdraw a lab run with the existing route; the previous published run serves its dates again', async () => {
    const t = await team({ forecastsOn: true });
    const championId = await publishedChampion(t);
    const { calibration, job } = await started(t);
    expect(await post(job, labResultFor(await inputFor(job)))).toEqual(SUCCEEDED);
    const runId = (await viewOf(t, calibration.id)).runId ?? '';
    const served = await forecastOf(t, '2026-06-01', '2026-06-14');
    expect(served.runs.map((run) => run.id)).toEqual([runId]);
    expect(new Set(served.days.map((day) => day.runId))).toEqual(new Set([runId]));

    const res = await changeRun(t, runId, 'withdraw');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ run: { id: runId, status: 'withdrawn', trainingSource: 'townwise_lab' } });
    const after = await forecastOf(t, '2026-06-01', '2026-06-14');
    expect(after.runs.map((run) => run.id)).toEqual([championId]);
    expect(after.days).toHaveLength(14);
    expect(new Set(after.days.map((day) => day.runId))).toEqual(new Set([championId]));
    expect((await actionsOf(t.orgId, 'forecast.withdrawn')).at(-1)).toMatchObject({ actorRole: 'superadmin', target: { id: runId } });
  });
});

describe('the forecasts switch', () => {
  it('the switch records org.forecasts_switched before the effect; on needs ownerAgreed true', async () => {
    const t = await team();
    for (const body of [{ on: true }, { on: true, ownerAgreed: false }, { on: 'yes', ownerAgreed: true }, {}, { on: false, ownerAgreed: true }, { ...ON, extra: 1 }]) {
      const res = await switchForecasts(t, body);
      expect({ body, status: res.status, error: (await res.json() as { error: string }).error }).toEqual({ body, status: 400, error: 'invalid_request' });
    }
    expect(await actionsOf(t.orgId, 'org.forecasts_switched')).toEqual([]);

    // The switch's write waits: its event is already there, and the organization unchanged.
    const writes = holdCalls(server, 'updateOne', 'TwOrg');
    let res: Response;
    try {
      const switched = switchForecasts(t, ON);
      await writes.arrived(1);
      expect(await actionsOf(t.orgId, 'org.forecasts_switched')).toHaveLength(1);
      expect((await server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(t.orgId) }))?.forecasts).toMatchObject({ on: false });
      writes.release(1);
      res = await switched;
    } finally {
      writes.restore();
    }
    const at = server.clock.now().toISOString();
    expect({ status: res.status, body: await res.json() as unknown }).toEqual({ status: 200, body: { forecasts: { on: true, at } } });
    expect((await server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(t.orgId) }))?.forecasts)
      .toEqual({ on: true, at: server.clock.now(), by: staff.userId });
    expect(await actionsOf(t.orgId, 'org.forecasts_switched')).toEqual([expect.objectContaining({
      actorRole: 'superadmin', actorEmail: STAFF_EMAIL, target: { type: 'org', id: t.orgId }, details: { on: true },
    })]);

    // Already on: nothing written.
    expect((await switchForecasts(t, ON)).status).toBe(200);
    expect(await actionsOf(t.orgId, 'org.forecasts_switched')).toHaveLength(1);
    const off = await switchForecasts(t, { on: false });
    expect({ status: off.status, body: await off.json() as unknown }).toEqual({ status: 200, body: { forecasts: { on: false, at } } });
    expect((await actionsOf(t.orgId, 'org.forecasts_switched')).map((event) => event.details)).toEqual([{ on: true }, { on: false }]);
    const list = await (await call(server, `/api/admin/orgs/${t.orgId}/calibrations`, { session: staff })).json() as { forecasts: unknown };
    expect(list.forecasts).toEqual({ on: false, at });

    // Staff only; an unknown organization is 404 with nothing written.
    expect((await switchForecasts(t, ON, t.admin)).status).toBe(403);
    expect((await switchForecasts({ orgId: new Types.ObjectId().toHexString() }, ON)).status).toBe(404);
    expect(await actionsOf(t.orgId, 'org.forecasts_switched')).toHaveLength(2);
  });

  it('org admins see the system’s publish and finished events in Townwise staff activity', async () => {
    const t = await team({ forecastsOn: true });
    const { job } = await started(t);
    expect(await post(job, labResultFor(await inputFor(job)))).toEqual(SUCCEEDED);
    const res = await call(server, '/api/org/staff-activity', { session: t.admin });
    expect(res.status).toBe(200);
    const { events } = await res.json() as { events: StaffActivityView[] };
    expect(events.map(({ staffEmail, summary, applied }) => ({ staffEmail, summary, applied }))).toEqual([
      { staffEmail: 'Townwise forecast lab', summary: 'A calibration published a new forecast', applied: true },
      { staffEmail: 'Townwise forecast lab', summary: 'Published a calibrated forecast (model v6) for 2026-06-01 to 2026-06-14', applied: true },
      { staffEmail: STAFF_EMAIL, summary: 'Started a calibration', applied: true },
      { staffEmail: STAFF_EMAIL, summary: 'Switched forecasts on, with the owner’s agreement', applied: true },
    ]);
  });
});
