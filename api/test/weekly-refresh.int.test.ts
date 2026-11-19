// The weekly refresh's pass (D42, lab/schedule.ts), with the test server's fake clock and a fake runner; the test plays
// the job where a calibration must finish (helpers/lab.ts). One test per scenario of the weekly-forecast-refresh delta:
// which locations a Monday starts, the reference rule, the regime carried over, the live and weekly caps, the lease, week
// rows a dead pass left starting, time zones, the three stops and the pass's log line. Then TownwiseAI's weekly
// suggestions in the same pass (openspec change weekly-forecast-suggestions), over a scripted model: one call per
// location a week by default, none when an org admin turned them off or the switch is false, with or without the lab,
// the $0.30 reservation and its correction, the budget skip, what the request holds and what it never holds, and the
// checks on the answer. Then the owner-calendar events the call sends while the calendar titles switch is on
// (calendar-event-suggestions): only keyed ones not linked or spotted before, a Google calendar's only under the new
// agreement and a file's or link's only when added on or after the notice, nothing that identifies them, the reservation unchanged, and sentinel titles in no stored suggestion and no
// staff view of the panel. Every number and title is synthetic.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { utcDay } from '../src/dates.ts';
import { labInputSchema, type LabInput } from '../src/lab/input.ts';
import {
  createForecastSchedule, SCHEDULE_LIVE_CAP, SCHEDULE_PASS_BUDGET_MS, SCHEDULE_START_TRIES, type PassResult, type ScheduleContext,
} from '../src/lab/schedule.ts';
import { finishCalibration, launch, SYSTEM_REQUESTER, type StartRequest } from '../src/lab/service.ts';
import { removeLocation } from '../src/handlers/locations.ts';
import { countRefitStartsSince } from '../src/stores/cross-tenant.ts';
import { parseIcs } from '../src/calendar/ics.ts';
import type { AgentPanel } from '../src/handlers/agent.ts';
import {
  SUGGESTIONS_MAX_OWNER_EVENTS, SUGGESTIONS_RESERVE_MICRO_USD, SUGGESTIONS_SYSTEM_PROMPT, SUGGESTIONS_TIME_MS, suggestionsReserveMicroUsd,
} from '../src/lab/suggestions.ts';
import { message, messagesOf, scriptedModel, text, type ScriptedModel } from './helpers/chat-model.ts';
import { addLocation, addNote, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { fakeLabRunner, jobCall, labFailure, labResultFor, runDays, seedHistory, type FakeLabRunner } from './helpers/lab.ts';
import { addGrant } from './helpers/fixtures.ts';
import {
  call, logLines, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;
let runner: FakeLabRunner;

beforeAll(async () => {
  runner = fakeLabRunner();
  server = await startTownwiseServer({ labRunner: runner });
});
afterAll(async () => { await server.close(); });

const COLLECTIONS = [
  'tw_orgs', 'tw_locations', 'tw_sales_days', 'tw_calibrations', 'tw_forecast_weeks', 'tw_forecast_schedule', 'tw_forecast_runs',
  'tw_forecasts', 'tw_audit_events', 'tw_notes', 'tw_agent_suggestions', 'tw_suggestion_passes', 'tw_chat_usage', 'tw_business_rules',
  'tw_members', 'tw_calendar_sources', 'tw_calendar_events', 'tw_google_connections', 'tw_view_as_grants',
];

/** The test clock starts at Mon, Jun 1, 2026, 12:00 UTC (08:00 in Hanover); each test starts there again. */
let start = 0;
beforeEach(async () => {
  await server.redis.flushdb();
  for (const name of COLLECTIONS) await server.connection.collection(name).deleteMany({});
  runner.onStart = null;
  server.clock.advance(Date.parse('2026-06-01T12:00:00.000Z') - server.clock.now().getTime());
  start = runner.jobs.length;
});

const LAST = '2026-05-31';
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PERSON = { userId: 'staff-0000', role: 'superadmin', via: 'console' } as const;

interface Place { scope: OrgScope; orgId: string; locationId: string }

/**
 * An organization (no `forecasts` field unless `forecasts` says otherwise) with a location in `town` holding guests on
 * every day of a `span`-day span ending on LAST.
 */
async function place(opts: { span?: number; forecasts?: 'off' | 'on'; town?: { townId: string | null; name: string; state: string } } = {}): Promise<Place> {
  const name = `Weekly Kitchen ${randomUUID().slice(0, 6)}`;
  const orgId = await createOrg(server, opts.forecasts === undefined ? { name } : { name, forecastsOn: opts.forecasts === 'on' });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  if (opts.town !== undefined) {
    await server.connection.collection('tw_locations').updateOne({ _id: new Types.ObjectId(locationId) }, { $set: { town: opts.town } });
  }
  await seedHistory(server, { orgId, locationId, from: utcDay(new Date(`${LAST}T00:00:00.000Z`), -(opts.span ?? 300)), to: LAST });
  return { scope: { orgId } as OrgScope, orgId, locationId };
}

function schedule(over: { config?: Partial<ScheduleContext['config']>; labRunner?: null; owner?: string; chat?: ScriptedModel } = {}) {
  const ctx: ScheduleContext = {
    ...server.ctx,
    config: { ...server.ctx.config, ...over.config },
    ...(over.labRunner === null ? { labRunner: null } : {}),
    ...(over.chat === undefined ? {} : { chat: over.chat }),
  };
  return createForecastSchedule({ ctx, ...(over.owner === undefined ? {} : { owner: over.owner }) });
}

function pass(over: Parameters<typeof schedule>[0] = {}): Promise<PassResult> {
  return schedule(over).pass();
}

function jobs() {
  return runner.jobs.slice(start);
}

async function weekRow(p: Place, week = '2026-06-01'): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_forecast_weeks').findOne({ orgId: new Types.ObjectId(p.orgId), locationId: new Types.ObjectId(p.locationId), week });
}

async function calibration(id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(id) });
}

/** The job of `calibrationId` fetches its input and posts the lab's answer to it (a draft judged by the gate). */
async function finishJob(calibrationId: string): Promise<LabInput> {
  const res = await jobCall(server, { calibrationId }, 'input');
  expect(res.status).toBe(200);
  const input = labInputSchema.parse(await res.json());
  expect((await jobCall(server, { calibrationId }, 'result', labResultFor(input))).status).toBe(200);
  return input;
}

async function personStart(p: Place, regimeStart: string | null = null) {
  const location = await server.ctx.stores.locations.find(p.scope, p.locationId);
  if (location === null) throw new Error('no location');
  const req: StartRequest = { id: new Types.ObjectId().toHexString(), scope: p.scope, location, requester: PERSON, regimeStart, today: '2026-06-01' };
  const launched = await launch(server.ctx, req);
  if (!launched.ok) throw new Error(`the start was refused: ${launched.code}`);
  return launched.calibration;
}

describe('which locations a Monday starts', () => {
  it('a changed location of an organization with no forecasts field starts as the system on Monday after 03:00', async () => {
    const p = await place();
    const result = await pass();
    expect(result).toMatchObject({ state: 'ran', started: 1, failed: 0, skipped: 0, capped: 0 });
    const [job] = jobs();
    expect(jobs()).toHaveLength(1);
    const row = await weekRow(p);
    expect(row).toMatchObject({ status: 'started', calibrationId: job?.calibrationId });
    expect(row?.dataSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await calibration(job?.calibrationId ?? '')).toMatchObject({
      requestedBy: SYSTEM_REQUESTER, chargedMicroUsd: 0, regimeStart: null, status: 'running',
    });
    const scheduled = (await auditEvents(server)).filter((event) => event.action === 'calibration.scheduled');
    expect(scheduled).toEqual([expect.objectContaining({
      actorRole: 'system', target: { type: 'calibration', id: job?.calibrationId },
      details: { locationId: p.locationId, calibrationId: job?.calibrationId },
    })]);
    // The week's row means a later pass that day starts nothing more.
    expect(await pass()).toMatchObject({ state: 'ran', started: 0 });
    expect(jobs()).toHaveLength(1);
  });

  it('starts nothing before 03:00 on Monday in the town', async () => {
    const p = await place();
    server.clock.advance(-(5 * HOUR + 30 * MINUTE)); // Mon 06:30 UTC, 02:30 in Hanover
    expect(await pass()).toMatchObject({ state: 'ran', started: 0, skipped: 0, capped: 0 });
    expect(await weekRow(p)).toBeNull();
    expect(jobs()).toHaveLength(0);
  });

  it('a location with no row yet that week is caught up on a later day of it, under that Monday', async () => {
    const p = await place();
    server.clock.advance(DAY + 2 * HOUR); // Tue 14:00 UTC: Monday's passes never reached it
    expect(await pass()).toMatchObject({ state: 'ran', started: 1 });
    expect(await weekRow(p)).toMatchObject({ status: 'started' });
    // Its week has a row now: the rest of the week starts nothing more.
    server.clock.advance(3 * DAY);
    expect(await pass()).toMatchObject({ started: 0 });
    expect(jobs()).toHaveLength(1);
  });

  it('a location in another time zone starts from 03:00 in its own town', async () => {
    const hanover = await place();
    const pacific = await place({ town: { townId: null, name: 'Mendocino', state: 'CA' } });
    server.clock.advance(-(3 * HOUR + 30 * MINUTE)); // 08:30 UTC: 04:30 in Hanover, 01:30 in California
    expect(await pass()).toMatchObject({ started: 1 });
    expect(await weekRow(hanover)).toMatchObject({ status: 'started' });
    expect(await weekRow(pacific)).toBeNull();
    server.clock.advance(2 * HOUR); // 03:30 in California
    expect(await pass()).toMatchObject({ started: 1 });
    expect(await weekRow(pacific)).toMatchObject({ status: 'started' });
  });

  it('considers organizations with forecasts on or unset, never one switched off or suspended', async () => {
    const unset = await place();
    const on = await place({ forecasts: 'on' });
    const off = await place({ forecasts: 'off' });
    const suspended = await place();
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(suspended.orgId) }, { $set: { status: 'suspended' } });
    expect(await pass()).toMatchObject({ started: 2 });
    expect(await weekRow(unset)).toMatchObject({ status: 'started' });
    expect(await weekRow(on)).toMatchObject({ status: 'started' });
    expect(await weekRow(off)).toBeNull();
    expect(await weekRow(suspended)).toBeNull();
  });

  it('records not_enough_history under a 230-day span and starts from 230', async () => {
    const short = await place({ span: 229 });
    const enough = await place({ span: 230 });
    expect(await pass()).toMatchObject({ started: 1, skipped: 1 });
    expect(await weekRow(short)).toMatchObject({ status: 'not_enough_history', calibrationId: null });
    expect(await weekRow(enough)).toMatchObject({ status: 'started' });
  });

  it('records unchanged when the fingerprint equals the reference calibration’s, and starts again once the data changes', async () => {
    const p = await place();
    await pass();
    const [job] = jobs();
    await finishJob(job?.calibrationId ?? '');
    // 300 days is too short for a first model forecast: the gate refused it on its own data, so it is a reference.
    expect(await calibration(job?.calibrationId ?? '')).toMatchObject({ status: 'succeeded', gate: { published: false, reason: 'not_enough_history' } });
    server.clock.advance(7 * DAY);
    expect(await pass()).toMatchObject({ started: 0, skipped: 1 });
    expect(await weekRow(p, '2026-06-08')).toMatchObject({ status: 'unchanged' });
    // A week's new days change the fingerprint (and the lab model version would too).
    await seedHistory(server, { orgId: p.orgId, locationId: p.locationId, from: '2026-06-01', to: '2026-06-07' });
    server.clock.advance(7 * DAY);
    expect(await pass()).toMatchObject({ started: 1 });
    expect(await weekRow(p, '2026-06-15')).toMatchObject({ status: 'started' });
  });

  it('with no new data for 9 weeks, refits on the Monday before the published run would stop being current', async () => {
    // 620 days, so the draft passes every check, published with a run through today plus 91 (Aug 31), as the lab makes it.
    const p = await place({ span: 620 });
    await pass();
    const [job] = jobs();
    const firstId = job?.calibrationId ?? '';
    const res = await jobCall(server, { calibrationId: firstId }, 'input');
    const input = labInputSchema.parse(await res.json());
    expect(input.today).toBe('2026-06-01');
    const result = labResultFor(input, { run: runDays(input.dataThrough, 92) });
    expect((await jobCall(server, { calibrationId: firstId }, 'result', result)).status).toBe(200);
    expect(await calibration(firstId)).toMatchObject({ gate: { published: true } });
    // Through Jul 27 the run is still current at the next Monday's pass (Aug 31 is 28 days after Aug 3): unchanged.
    for (const week of ['2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']) {
      server.clock.advance(7 * DAY);
      expect(await pass()).toMatchObject({ started: 0, skipped: 1 });
      expect(await weekRow(p, week)).toMatchObject({ status: 'unchanged' });
    }
    // Aug 3: by Aug 10 it would have lapsed, and a refit on the same days reaches today plus 91 again.
    server.clock.advance(7 * DAY);
    expect(await pass()).toMatchObject({ started: 1, skipped: 0 });
    expect(await weekRow(p, '2026-08-03')).toMatchObject({ status: 'started', dataSha256: (await calibration(firstId))?.dataSha256 });
  });

  it('unchanged data refits a year-long run on the Monday a 91-day run would (D52: current by the forecast tier)', async () => {
    // As the case above, but the run reaches today plus 365 (2027-06-01): its forecast tier still ends Aug 31.
    const p = await place({ span: 620 });
    await pass();
    const [job] = jobs();
    const firstId = job?.calibrationId ?? '';
    const input = labInputSchema.parse(await (await jobCall(server, { calibrationId: firstId }, 'input')).json());
    const result = labResultFor(input, { run: runDays(input.dataThrough, 366) });
    expect(result.run.days.at(-1)?.date).toBe('2027-06-01');
    expect((await jobCall(server, { calibrationId: firstId }, 'result', result)).status).toBe(200);
    expect(await calibration(firstId)).toMatchObject({ gate: { published: true } });
    for (const week of ['2026-06-08', '2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']) {
      server.clock.advance(7 * DAY);
      expect(await pass()).toMatchObject({ started: 0, skipped: 1 });
      expect(await weekRow(p, week)).toMatchObject({ status: 'unchanged' });
    }
    server.clock.advance(7 * DAY);
    expect(await pass()).toMatchObject({ started: 1, skipped: 0 });
    expect(await weekRow(p, '2026-08-03')).toMatchObject({ status: 'started', dataSha256: (await calibration(firstId))?.dataSha256 });
  });

  it('a published run that ends where its data does, not at its today plus 91, is not refit on unchanged data', async () => {
    // labResultFor's run covers 14 days after the data: a refit on the same days would end there again.
    const p = await place({ span: 620 });
    await pass();
    const [job] = jobs();
    await finishJob(job?.calibrationId ?? '');
    expect(await calibration(job?.calibrationId ?? '')).toMatchObject({ gate: { published: true } });
    server.clock.advance(7 * DAY);
    expect(await pass()).toMatchObject({ started: 0, skipped: 1 });
    expect(await weekRow(p, '2026-06-08')).toMatchObject({ status: 'unchanged' });
  });

  it('the reference rule: forecasts switched on after a forecasts_off draft start a fresh calibration on unchanged data', async () => {
    // 620 days, so the draft passes every check but G1.
    const p = await place({ span: 620, forecasts: 'off' });
    const person = await personStart(p);
    await finishJob(person.id);
    expect(await calibration(person.id)).toMatchObject({ gate: { published: false, reason: 'forecasts_off' } });
    expect(await pass()).toMatchObject({ started: 0 });
    await server.connection.collection('tw_orgs').updateOne(
      { _id: new Types.ObjectId(p.orgId) }, { $set: { forecasts: { on: true, at: server.clock.now(), by: 'staff-0000' } } },
    );
    expect(await pass()).toMatchObject({ started: 1, skipped: 0 });
    expect(await weekRow(p)).toMatchObject({ status: 'started' });
    expect((await weekRow(p))?.dataSha256).toBe((await calibration(person.id))?.dataSha256);
  });

  it('carries over the regimeStart of the calibration that made the newest published run', async () => {
    const p = await place({ span: 620 });
    const person = await personStart(p, '2026-01-05');
    const input = await finishJob(person.id);
    expect(input.regimeStart).toBe('2026-01-05');
    expect(await calibration(person.id)).toMatchObject({ gate: { published: true } });
    await seedHistory(server, { orgId: p.orgId, locationId: p.locationId, from: '2026-06-01', to: '2026-06-07' });
    server.clock.advance(7 * DAY);
    expect(await pass()).toMatchObject({ started: 1 });
    const job = jobs().at(-1);
    expect(await calibration(job?.calibrationId ?? '')).toMatchObject({ requestedBy: SYSTEM_REQUESTER, regimeStart: '2026-01-05' });
  });

  it('drops a carried regimeStart the history no longer holds, and starts without one instead of failing every week', async () => {
    const p = await place({ span: 620 });
    const person = await personStart(p, '2024-12-02');
    await finishJob(person.id);
    expect(await calibration(person.id)).toMatchObject({ regimeStart: '2024-12-02', gate: { published: true } });
    // The days before 2025-01-01 leave the history, as turning their upload off does (D28): the pattern change date is
    // now before the first day, which a start refuses (invalid_regime_start).
    await server.connection.collection('tw_sales_days').deleteMany({ locationId: new Types.ObjectId(p.locationId), date: { $lt: '2025-01-01' } });
    await seedHistory(server, { orgId: p.orgId, locationId: p.locationId, from: '2026-06-01', to: '2026-06-07' });
    server.clock.advance(7 * DAY);
    server.logs.length = 0;
    expect(await pass()).toMatchObject({ started: 1, failed: 0 });
    expect(await weekRow(p, '2026-06-08')).toMatchObject({ status: 'started' });
    expect(await calibration(jobs().at(-1)?.calibrationId ?? '')).toMatchObject({ requestedBy: SYSTEM_REQUESTER, regimeStart: null });
    expect(logLines(server).filter((line) => line.msg === 'townwise.weekly_refresh_regime_dropped')).toEqual([
      expect.objectContaining({ orgId: p.orgId, locationId: p.locationId }),
    ]);
  });

  it('someone already calibrating: no row, and a later pass that Monday starts it', async () => {
    const p = await place({ span: 600 });
    const person = await personStart(p);
    expect(await pass()).toMatchObject({ started: 0, skipped: 1 });
    expect(await weekRow(p)).toBeNull();
    await finishCalibration(server.ctx, p.scope, person, { status: 'failed', failure: 'job_failed' });
    server.clock.advance(HOUR);
    expect(await pass()).toMatchObject({ started: 1 });
  });

  it('a failed scheduled calibration is not retried that week; the pass that timed it out counts it failed', async () => {
    const p = await place();
    await pass();
    const [job] = jobs();
    server.clock.advance(21 * MINUTE); // its job never called back: timed out
    expect(await pass()).toMatchObject({ started: 0, failed: 1 });
    expect(await calibration(job?.calibrationId ?? '')).toMatchObject({ status: 'failed', failure: 'timeout' });
    // The ops alert (forecasts_failed) reads the line: a scheduled calibration that failed after it started
    const finished = logLines(server).filter((line) => line.msg === 'townwise.calibration_finished' && line.calibrationId === job?.calibrationId);
    expect(finished).toEqual([expect.objectContaining({ status: 'failed', failure: 'timeout', via: 'scheduled' })]);
    expect(await weekRow(p)).toMatchObject({ status: 'started' });
    server.clock.advance(HOUR);
    expect(await pass()).toMatchObject({ started: 0, failed: 0 }); // counted once
    expect(jobs()).toHaveLength(1);
  });

  it('a scheduled job whose lab answers ok false logs calibration_finished failed, via scheduled, for the ops alert', async () => {
    await place();
    await pass();
    const [job] = jobs();
    const calibrationId = job?.calibrationId ?? '';
    expect((await jobCall(server, { calibrationId }, 'input')).status).toBe(200);
    expect((await jobCall(server, { calibrationId }, 'result', labFailure({ calibrationId }, 'internal'))).status).toBe(200);
    const finished = logLines(server).filter((line) => line.msg === 'townwise.calibration_finished' && line.calibrationId === calibrationId);
    expect(finished).toEqual([expect.objectContaining({ status: 'failed', failure: 'job_failed', via: 'scheduled' })]);
    // Ids and codes only
    const keys = Object.keys(finished[0] ?? {}).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key)).sort();
    expect(keys).toEqual(['calibrationId', 'failure', 'gate', 'heldOutWeeks', 'locationId', 'orgId', 'status', 'via']);
  });

  it('a job that cannot start leaves no row, so a later pass that Monday tries again', async () => {
    const p = await place();
    runner.failNext(new Error('no job'));
    expect(await pass()).toMatchObject({ started: 0, failed: 1 });
    expect(await weekRow(p)).toBeNull();
    server.clock.advance(HOUR);
    expect(await pass()).toMatchObject({ started: 1, failed: 0 });
    expect(await weekRow(p)).toMatchObject({ status: 'started', calibrationId: jobs().at(-1)?.calibrationId });
  });

  it('records start_failed once the job could not start 3 times that Monday', async () => {
    const p = await place();
    for (let i = 0; i < SCHEDULE_START_TRIES; i += 1) {
      runner.failNext(new Error('no job'));
      expect(await pass()).toMatchObject({ started: 0, failed: 1 });
      server.clock.advance(HOUR);
    }
    expect(await weekRow(p)).toMatchObject({ status: 'start_failed' });
    expect(await pass()).toMatchObject({ started: 0, failed: 0 });
    expect(jobs()).toHaveLength(0);
  });
});

describe('the caps', () => {
  it('starts at most 3 live at once, writing no row for the rest, and later passes start them as live ones finish', async () => {
    const places = [];
    for (let i = 0; i < 5; i += 1) places.push(await place());
    expect(await pass()).toMatchObject({ started: SCHEDULE_LIVE_CAP, capped: 2 });
    const rows = await Promise.all(places.map((p) => weekRow(p)));
    expect(rows.filter((row) => row === null)).toHaveLength(2);
    expect(await pass()).toMatchObject({ started: 0, capped: 2 });
    // One finishes: the next pass starts one more.
    const [first] = jobs();
    const done = places.find((p, i) => rows[i]?.calibrationId === first?.calibrationId);
    if (done === undefined) throw new Error('no place for the first job');
    const record = await server.ctx.stores.calibrations.find(done.scope, first?.calibrationId ?? '');
    if (record === null) throw new Error('no calibration');
    await finishCalibration(server.ctx, done.scope, record, { status: 'failed', failure: 'job_failed' });
    expect(await pass()).toMatchObject({ started: 1, capped: 1 });
    server.clock.advance(21 * MINUTE); // the 3 live time out, counted failed
    expect(await pass()).toMatchObject({ started: 1, failed: 3, capped: 0 });
    expect(jobs()).toHaveLength(5);
  });

  it('locations the live cap held all Monday start later that week, so a full week reaches the weekly cap', async () => {
    // At 3 live at once and one pass an hour, Monday alone (03:00 to midnight, 21 passes) starts at most 63; the rest of
    // the week holds the remaining room up to TOWNWISE_WEEKLY_FORECAST_CAP (default 200).
    const places = [];
    for (let i = 0; i < SCHEDULE_LIVE_CAP + 2; i += 1) places.push(await place());
    expect(await pass()).toMatchObject({ started: SCHEDULE_LIVE_CAP, capped: 2 });
    server.clock.advance(DAY); // Tuesday: Monday's 3 have timed out, and the 2 held back have no row yet
    expect(await pass()).toMatchObject({ started: 2, capped: 0 });
    const rows = await Promise.all(places.map((p) => weekRow(p)));
    expect(rows.map((row) => row?.status)).toEqual(Array.from({ length: places.length }, () => 'started'));
    expect(jobs()).toHaveLength(places.length);
  });

  it('records cap_reached past the weekly cap', async () => {
    const a = await place();
    const b = await place();
    expect(await pass({ config: { weeklyForecastCap: 1 } })).toMatchObject({ started: 1, capped: 1 });
    const statuses = [(await weekRow(a))?.status, (await weekRow(b))?.status].sort();
    expect(statuses).toEqual(['cap_reached', 'started']);
  });
});

describe('the lease', () => {
  it('a pass that finds the lease held starts nothing', async () => {
    await place();
    await server.ctx.stores.forecastSchedule.claim({ owner: 'slow-pass', now: server.clock.now(), leaseMs: 10 * MINUTE });
    expect(await pass()).toMatchObject({ state: 'lease_held', started: 0 });
    expect(jobs()).toHaveLength(0);
  });

  it('a renewal that fails mid-pass stops it at once, and a later pass continues with the rest', async () => {
    for (let i = 0; i < 4; i += 1) await place();
    runner.onStart = async () => {
      // Another pass takes the lease while this one starts its first location.
      await server.connection.collection<{ _id: string }>('tw_forecast_schedule').updateOne(
        { _id: 'weekly' }, { $set: { owner: 'other-pass', leaseUntil: new Date(server.clock.now().getTime() + 10 * MINUTE) } },
      );
      runner.onStart = null;
    };
    expect(await pass()).toMatchObject({ state: 'lease_lost', started: 1 });
    expect(jobs()).toHaveLength(1);
    server.clock.advance(21 * MINUTE); // the other pass's lease and the first calibration both run out
    expect(await pass()).toMatchObject({ state: 'ran', started: 3 });
    expect(jobs()).toHaveLength(4);
  });

  it('a starting row a dead pass left is resolved: start_failed with no calibration, started with one', async () => {
    const lost = await place();
    const made = await place();
    const old = new Date(server.clock.now().getTime() - 11 * MINUTE);
    const insert = (p: Place) => server.connection.collection('tw_forecast_weeks').insertOne({
      orgId: new Types.ObjectId(p.orgId), locationId: new Types.ObjectId(p.locationId), week: '2026-06-01', status: 'starting',
      calibrationId: null, dataSha256: null, createdAt: old, updatedAt: old,
    });
    await insert(lost);
    await insert(made);
    const location = await server.ctx.stores.locations.find(made.scope, made.locationId);
    if (location === null) throw new Error('no location');
    const launched = await launch(server.ctx, {
      id: new Types.ObjectId().toHexString(), scope: made.scope, location, requester: SYSTEM_REQUESTER, regimeStart: null, today: '2026-06-01',
    });
    if (!launched.ok) throw new Error('not launched');
    expect(await pass()).toMatchObject({ started: 0, failed: 1 });
    expect(await weekRow(lost)).toMatchObject({ status: 'start_failed' });
    expect(await weekRow(made)).toMatchObject({ status: 'started', calibrationId: launched.calibration.id });
    expect(jobs()).toHaveLength(1);
  });
});

describe('the pass’s deadline', () => {
  it('is inside the job’s 600-second replica timeout, so an execution is never killed mid-location', () => {
    expect(SCHEDULE_PASS_BUDGET_MS).toBeLessThanOrEqual(480_000);
  });

  it('starts no calibration once the pass is near its deadline, ending deadline, and the next pass goes on', async () => {
    for (let i = 0; i < 3; i += 1) await place();
    // Each start takes 4 minutes (a slow runner): the third would begin with no time left.
    runner.onStart = () => { server.clock.advance(4 * MINUTE); return Promise.resolve(); };
    expect(await pass()).toMatchObject({ state: 'deadline', started: 2 });
    runner.onStart = null;
    server.clock.advance(HOUR);
    expect(await pass()).toMatchObject({ state: 'ran', started: 1 });
    expect(jobs()).toHaveLength(3);
  });
});

describe('the stops', () => {
  it('starts nothing with TOWNWISE_WEEKLY_FORECASTS false, the lab runner off, or the schedule paused', async () => {
    const p = await place();
    expect(await pass({ config: { weeklyForecasts: false } })).toMatchObject({ state: 'off', started: 0 });
    expect(await pass({ labRunner: null })).toMatchObject({ state: 'off', started: 0 });
    await server.ctx.stores.forecastSchedule.setPaused({ at: server.clock.now(), by: 'staff-0000', email: 'staff@townwise.test' }, server.clock.now());
    expect(await pass()).toMatchObject({ state: 'paused', started: 0 });
    expect(await weekRow(p)).toBeNull();
    expect(jobs()).toHaveLength(0);
    await server.ctx.stores.forecastSchedule.setPaused(null, server.clock.now());
    expect(await pass()).toMatchObject({ state: 'ran', started: 1 });
  });
});

describe('the pass’s log line', () => {
  it('logs townwise.weekly_refresh_pass with counts, its state and time only: no id and no figure', async () => {
    const a = await place();
    await place({ span: 100 });
    const b = await place({ forecasts: 'off' });
    runner.failNext(new Error('no job'));
    await pass();
    const line = logLines(server).filter((each) => each.msg === 'townwise.weekly_refresh_pass').at(-1);
    expect(line).toMatchObject({ state: 'ran', started: 0, failed: 1, skipped: 1, capped: 0 });
    const keys = Object.keys(line ?? {}).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key)).sort();
    expect(keys).toEqual(['capped', 'failed', 'ms', 'skipped', 'started', 'state']);
    const text = JSON.stringify(line);
    for (const id of [a.orgId, a.locationId, b.orgId]) expect(text).not.toContain(id);
  });
});

describe('weekly suggestions', () => {
  /** A model answering each call with `items` as its structured answer. */
  function answering(...answers: unknown[][]): ScriptedModel {
    const model = scriptedModel();
    for (const items of answers) {
      model.script({ kind: 'message', message: message([text(JSON.stringify({ suggestions: items }))], { usage: { input: 10_000, output: 500 } }) });
    }
    return model;
  }

  const JULY_4 = {
    type: 'note', ruleText: null, kind: 'closure', startDate: '2026-07-04', endDate: '2026-07-04', weekdays: null, effect: 'closed',
    expectedGuests: null, detail: null, startTime: null, endTime: null, why: 'Independence Day is Sat, Jul 4.', calendarIds: ['us:independence-day:2026'],
  };

  async function suggestions(p: Place): Promise<Record<string, unknown>[]> {
    return server.connection.collection('tw_agent_suggestions').find({ locationId: new Types.ObjectId(p.locationId) }).toArray();
  }

  async function passRow(p: Place, week = '2026-06-01'): Promise<Record<string, unknown> | null> {
    return server.connection.collection('tw_suggestion_passes').findOne({ locationId: new Types.ObjectId(p.locationId), week });
  }

  async function spent(p: Place): Promise<number> {
    const doc = await server.connection.collection('tw_chat_usage').findOne({ orgId: new Types.ObjectId(p.orgId), month: '2026-06' });
    return (doc?.costMicroUsd as number | undefined) ?? 0;
  }

  it('one call per location a week by default, stored as open suggestions and recorded on the week’s pass row', async () => {
    const p = await place();
    const model = answering([JULY_4], [JULY_4]);
    const first = await pass({ chat: model });
    expect(first.suggestions).toMatchObject({ state: 'ran', passes: 1, suggested: 1, none: 0, budget: 0, failed: 0 });
    expect(model.calls).toHaveLength(1);
    expect(await suggestions(p)).toEqual([expect.objectContaining({
      week: '2026-06-01', type: 'note', status: 'open', why: JULY_4.why, calendarIds: ['us:independence-day:2026'],
      content: expect.objectContaining({ kind: 'closure', startDate: '2026-07-04' }) as unknown,
    })]);
    expect(await passRow(p)).toMatchObject({ status: 'suggested', suggested: 1 });
    // The rest of the week makes no call: later that day, and on Thursday.
    expect((await pass({ chat: model })).suggestions).toMatchObject({ passes: 0, none: 0 });
    server.clock.advance(3 * DAY);
    expect((await pass({ chat: model })).suggestions).toMatchObject({ passes: 0, none: 0 });
    expect(model.calls).toHaveLength(1);
    // The next Monday makes the next one, and the same suggestion again is dropped as a repeat.
    server.clock.advance(4 * DAY);
    expect((await pass({ chat: model })).suggestions).toMatchObject({ passes: 0, none: 1 });
    expect(model.calls).toHaveLength(2);
    expect(await suggestions(p)).toHaveLength(1);
    expect(await passRow(p, '2026-06-08')).toMatchObject({ status: 'none', suggested: 0 });
  });

  it('a location missed on Monday is caught up later that week; none before 03:00 on Monday in the town', async () => {
    const p = await place();
    const model = answering([]);
    server.clock.advance(-(5 * HOUR + 30 * MINUTE)); // Mon 02:30 in Hanover
    expect((await pass({ chat: model })).suggestions).toMatchObject({ state: 'ran', none: 0 });
    expect(model.calls).toHaveLength(0);
    server.clock.advance(2 * DAY);
    expect((await pass({ chat: model })).suggestions).toMatchObject({ none: 1 });
    expect(await passRow(p)).toMatchObject({ status: 'none' });
  });

  it('none when an org admin turned them off, with the switch false, or without a model; with the lab off they still run', async () => {
    const off = await place();
    await server.connection.collection('tw_orgs').updateOne(
      { _id: new Types.ObjectId(off.orgId) }, { $set: { weeklySuggestions: { on: false, at: server.clock.now(), by: 'admin-0000' } } },
    );
    const model = answering([JULY_4]);
    expect((await pass({ chat: model, config: { weeklySuggestions: false } })).suggestions).toMatchObject({ state: 'off' });
    expect((await pass()).suggestions).toMatchObject({ state: 'off' });
    expect(model.calls).toHaveLength(0);
    const on = await place();
    const labOff = await pass({ chat: model, labRunner: null });
    expect(labOff).toMatchObject({ state: 'off', started: 0, suggestions: { state: 'ran', passes: 1 } });
    expect(model.calls).toHaveLength(1);
    expect(await passRow(off)).toBeNull();
    expect(await passRow(on)).toMatchObject({ status: 'suggested' });
  });

  it('reserves $0.30 of the organization’s TownwiseAI month and corrects it to what the call cost', async () => {
    const p = await place();
    const model = scriptedModel();
    let during = -1;
    // The answer waits until the call is made, then reads the month while the call is in flight.
    const gate = (async () => {
      while (model.calls.length === 0) await new Promise((resolve) => { setTimeout(resolve, 5); });
      during = await spent(p);
    })();
    model.script({ kind: 'message', message: message([text(JSON.stringify({ suggestions: [] }))], { usage: { input: 10_000, output: 500 } }), gate });
    await pass({ chat: model });
    expect(during).toBe(SUGGESTIONS_RESERVE_MICRO_USD);
    // 10,000 input tokens at $4 a million and 500 output at $20: $0.05.
    expect(await spent(p)).toBe(50_000);
  });

  it('is skipped (budget) when the month has less than $0.30 left, making no call', async () => {
    const p = await place();
    await server.connection.collection('tw_chat_usage').insertOne({
      orgId: new Types.ObjectId(p.orgId), month: '2026-06', costMicroUsd: 19_800_000, updatedAt: server.clock.now(),
    });
    const model = answering([JULY_4]);
    expect((await pass({ chat: model })).suggestions).toMatchObject({ budget: 1, passes: 0 });
    expect(model.calls).toHaveLength(0);
    expect(await passRow(p)).toMatchObject({ status: 'budget' });
    expect(await spent(p)).toBe(19_800_000);
  });

  it('a call that fails before reporting anything costs nothing, hands its reservation back and leaves the week to a later pass', async () => {
    const p = await place();
    const model = scriptedModel();
    model.script({ kind: 'error', error: new Error('overloaded') });
    expect((await pass({ chat: model })).suggestions).toMatchObject({ failed: 1, passes: 0 });
    expect(await passRow(p)).toBeNull();
    expect(await spent(p)).toBe(0);
    // An hour later the model answers: the week's one call is made after all.
    model.script({ kind: 'message', message: message([text(JSON.stringify({ suggestions: [JULY_4] }))], { usage: { input: 10_000, output: 500 } }) });
    server.clock.advance(HOUR);
    expect((await pass({ chat: model })).suggestions).toMatchObject({ failed: 0, passes: 1, suggested: 1 });
    expect(await passRow(p)).toMatchObject({ status: 'suggested' });
    expect(model.calls).toHaveLength(2);
  });

  it('sends the calendar, the notes as written and the rules; never an email, the organization’s or location’s name, or a figure', async () => {
    const name = `Sentinel-Org ${randomUUID().slice(0, 6)}`;
    const orgId = await createOrg(server, { name });
    const locationId = await addLocation(server, { orgId, name: 'Sentinel-Room' });
    await seedHistory(server, { orgId, locationId, from: utcDay(new Date(`${LAST}T00:00:00.000Z`), -400), to: LAST, guests: () => 4321 });
    await addSeat(server, { orgId, userId: 'user-sentinel', email: 'sentinel-owner@example.test', role: 'org_admin' });
    await addNote(server, { orgId, locationId, detail: 'Sentinel-Detail: the Smith party', startDate: '2026-06-20' });
    await server.ctx.stores.businessRules.create({ orgId } as OrgScope, locationId, {
      text: 'Sentinel-Rule closed Mondays', schedule: null, addedVia: 'page', createdBy: 'user-sentinel', now: server.clock.now(),
    });
    const model = answering([]);
    await pass({ chat: model });
    expect(model.calls).toHaveLength(1);
    const call = model.calls[0];
    expect(call?.params.tools).toBeUndefined();
    const sent = JSON.stringify(messagesOf(call)) + JSON.stringify(call?.params.system);
    expect(sent).toContain('Sentinel-Detail: the Smith party');
    expect(sent).toContain('us:independence-day:2026');
    expect(sent).toContain('hanover-nh:2026-06-14:commencement');
    for (const absent of ['sentinel-owner@example.test', name, 'Sentinel-Room', '4321', orgId, locationId, 'user-sentinel', 'netSales', 'averageGuests']) {
      expect(sent).not.toContain(absent);
    }
    // A rule with no schedule covers no day, so it is not sent (only scheduled rules covering the 91 days are).
    expect(sent).not.toContain('Sentinel-Rule');
  });

  it('drops what the checks refuse and stores what passes', async () => {
    const p = await place();
    const model = answering([
      { ...JULY_4, endDate: '2026-07-03' },
      { ...JULY_4, startDate: '2026-06-01', endDate: '2026-06-01' },
      { ...JULY_4, startDate: '2026-12-25', endDate: '2026-12-25' },
      JULY_4,
    ]);
    expect((await pass({ chat: model })).suggestions).toMatchObject({ passes: 1, suggested: 1 });
    expect((await suggestions(p)).map((row) => (row.content as { startDate: string }).startDate)).toEqual(['2026-07-04']);
  });

  it('logs townwise.weekly_suggestions_pass with counts, its state and time only: no id and no words', async () => {
    const p = await place();
    await pass({ chat: answering([JULY_4]) });
    const line = logLines(server).filter((each) => each.msg === 'townwise.weekly_suggestions_pass').at(-1);
    const keys = Object.keys(line ?? {}).filter((key) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key)).sort();
    expect(keys).toEqual(['applied', 'budget', 'failed', 'ms', 'none', 'ownerEvents', 'passes', 'state', 'suggested']);
    const textOf = JSON.stringify(logLines(server));
    for (const absent of [p.orgId, p.locationId, JULY_4.why]) expect(JSON.stringify(line)).not.toContain(absent);
    expect(textOf).not.toContain(JULY_4.why);
  });

  /** A model whose first call waits for `during` (run while that call is in flight), answering `items` each time. */
  function duringFirstCall(during: () => Promise<void>, ...answers: unknown[][]): ScriptedModel {
    const model = scriptedModel();
    const gate = (async () => {
      while (model.calls.length === 0) await new Promise((resolve) => { setTimeout(resolve, 5); });
      await during();
    })();
    answers.forEach((items, index) => {
      const step = message([text(JSON.stringify({ suggestions: items }))], { usage: { input: 10_000, output: 500 } });
      model.script(index === 0 ? { kind: 'message', message: step, gate } : { kind: 'message', message: step });
    });
    return model;
  }

  it('an org admin turning them off mid-pass stops the organization’s locations not yet reached', async () => {
    const p = await place();
    const second = await addLocation(server, { orgId: p.orgId, name: 'Second Room' });
    const model = duringFirstCall(async () => {
      await server.connection.collection('tw_orgs').updateOne(
        { _id: new Types.ObjectId(p.orgId) }, { $set: { weeklySuggestions: { on: false, at: server.clock.now(), by: 'admin-0000' } } },
      );
    }, [JULY_4], [JULY_4]);
    await pass({ chat: model });
    expect(model.calls).toHaveLength(1);
    expect(await passRow({ ...p, locationId: second })).toBeNull();
  });

  it('the staff pause stops them too, with the lab on or off, and no call is made until it is lifted', async () => {
    const p = await place();
    const model = answering([JULY_4]);
    await server.ctx.stores.forecastSchedule.setPaused({ at: server.clock.now(), by: 'staff-0000', email: 'staff@townwise.test' }, server.clock.now());
    expect(await pass({ chat: model })).toMatchObject({ state: 'paused', suggestions: { state: 'paused', passes: 0 } });
    expect(await pass({ chat: model, labRunner: null })).toMatchObject({ state: 'off', suggestions: { state: 'paused', passes: 0 } });
    expect(model.calls).toHaveLength(0);
    expect(await passRow(p)).toBeNull();
    await server.ctx.stores.forecastSchedule.setPaused(null, server.clock.now());
    expect((await pass({ chat: model })).suggestions).toMatchObject({ state: 'ran', passes: 1 });
  });

  it('records on the schedule when a pass last ran them, not when they are paused or off', async () => {
    await place();
    const ranAt = async () => (await server.connection.collection('tw_forecast_schedule').findOne({ _id: 'weekly' as never }))?.suggestionsAt as Date | undefined;
    await pass();
    expect(await ranAt() ?? null).toBeNull();
    await server.ctx.stores.forecastSchedule.setPaused({ at: server.clock.now(), by: 'staff-0000', email: 'staff@townwise.test' }, server.clock.now());
    await pass({ chat: answering([]) });
    expect(await ranAt() ?? null).toBeNull();
    await server.ctx.stores.forecastSchedule.setPaused(null, server.clock.now());
    await pass({ chat: answering([]) });
    expect(await ranAt()).toEqual(server.clock.now());
  });

  it('keeps nothing for a location deleted while its call was in flight', async () => {
    const p = await place();
    const model = duringFirstCall(async () => {
      await removeLocation(server.ctx, p.scope, p.locationId);
    }, [JULY_4]);
    await pass({ chat: model });
    expect(model.calls).toHaveLength(1);
    expect(await suggestions(p)).toEqual([]);
    expect(await passRow(p)).toBeNull();
  });

  it('a pass row a dead pass left running is resolved: one holding a reservation fails and refunds it once; one without is removed, so the week still runs', async () => {
    const held = await place();
    const bare = await place();
    const old = new Date(server.clock.now().getTime() - 11 * MINUTE);
    const row = (p: Place, reservedMicroUsd: number) => ({
      orgId: new Types.ObjectId(p.orgId), locationId: new Types.ObjectId(p.locationId), week: '2026-06-01', status: 'running', suggested: 0,
      reservedMicroUsd, month: '2026-06', createdAt: old, updatedAt: old,
    });
    await server.connection.collection('tw_suggestion_passes').insertMany([row(held, SUGGESTIONS_RESERVE_MICRO_USD), row(bare, 0)]);
    await server.connection.collection('tw_chat_usage').insertOne({
      orgId: new Types.ObjectId(held.orgId), month: '2026-06', costMicroUsd: SUGGESTIONS_RESERVE_MICRO_USD + 70_000, updatedAt: old,
    });
    const model = answering([JULY_4]);
    expect((await pass({ chat: model })).suggestions).toMatchObject({ passes: 1, failed: 1 });
    expect(await passRow(held)).toMatchObject({ status: 'failed', reservedMicroUsd: 0 });
    expect(await spent(held)).toBe(70_000);
    // The week of the one that never reserved runs: its call is the pass's only one.
    expect(model.calls).toHaveLength(1);
    expect(await passRow(bare)).toMatchObject({ status: 'suggested' });
    // Refunded once: a later pass finds nothing left to resolve.
    server.clock.advance(HOUR);
    expect((await pass({ chat: answering() })).suggestions).toMatchObject({ failed: 0 });
    expect(await spent(held)).toBe(70_000);
  });

  it('takes no new location once a call could outlast the pass’s deadline, ending deadline, and the next pass makes it', async () => {
    const places = [];
    for (let i = 0; i < 4; i += 1) places.push(await place());
    const model = answering([], [], [], []);
    // Each call runs its whole time (as one Anthropic hangs on until the call's own timeout).
    const slow: ScriptedModel = { ...model, stream(params, options) { server.clock.advance(SUGGESTIONS_TIME_MS); return model.stream(params, options); } };
    const first = await pass({ chat: slow });
    expect(first.suggestions).toMatchObject({ state: 'deadline', none: 3, failed: 0 });
    expect(model.calls).toHaveLength(3);
    const rows = await Promise.all(places.map((p) => passRow(p)));
    expect(rows.filter((row) => row === null)).toHaveLength(1);
    expect(rows.filter((row) => row?.status === 'none')).toHaveLength(3);
    server.clock.advance(HOUR);
    expect((await pass({ chat: model })).suggestions).toMatchObject({ state: 'ran', none: 1, failed: 0 });
    expect(model.calls).toHaveLength(4);
  });

  it('a running row younger than a lease is left alone', async () => {
    const p = await place();
    const recent = new Date(server.clock.now().getTime() - 2 * MINUTE);
    await server.connection.collection('tw_suggestion_passes').insertOne({
      orgId: new Types.ObjectId(p.orgId), locationId: new Types.ObjectId(p.locationId), week: '2026-06-01', status: 'running', suggested: 0,
      reservedMicroUsd: SUGGESTIONS_RESERVE_MICRO_USD, month: '2026-06', createdAt: recent, updatedAt: recent,
    });
    expect((await pass({ chat: answering() })).suggestions).toMatchObject({ failed: 0 });
    expect(await passRow(p)).toMatchObject({ status: 'running', reservedMicroUsd: SUGGESTIONS_RESERVE_MICRO_USD });
  });

  describe('a large request', () => {
    /** 200 notes over the 91 days, each with 280 characters of detail: a request whose ceiling is over $0.30. */
    async function manyNotes(p: Place): Promise<void> {
      await server.connection.collection('tw_notes').insertMany(Array.from({ length: 200 }, (_unused, index) => {
        const date = utcDay(new Date('2026-06-02T00:00:00.000Z'), index % 90);
        return {
          orgId: new Types.ObjectId(p.orgId), locationId: new Types.ObjectId(p.locationId), kind: 'other', startDate: date, endDate: date,
          weekdays: null, effect: 'unknown', expectedGuests: null, detail: `Synthetic note ${String(index)} `.padEnd(280, 'x'),
          startTime: null, endTime: null, createdBy: 'fixture', createdAt: server.clock.now(), updatedAt: server.clock.now(),
        };
      }));
    }

    it('reserves its ceiling at the most expensive model’s prices, more than $0.30, and corrects it to the cost', async () => {
      const p = await place();
      await manyNotes(p);
      let during = -1;
      const model = duringFirstCall(async () => { during = await spent(p); }, []);
      await pass({ chat: model });
      const call = model.calls[0];
      if (call === undefined) throw new Error('no call');
      expect(during).toBe(suggestionsReserveMicroUsd(call.params));
      expect(during).toBeGreaterThan(SUGGESTIONS_RESERVE_MICRO_USD);
      expect(await spent(p)).toBe(50_000);
    });

    it('is skipped (budget) when the month has $0.30 left but less than its ceiling', async () => {
      const p = await place();
      await manyNotes(p);
      await server.connection.collection('tw_chat_usage').insertOne({
        orgId: new Types.ObjectId(p.orgId), month: '2026-06', costMicroUsd: 20_000_000 - SUGGESTIONS_RESERVE_MICRO_USD, updatedAt: server.clock.now(),
      });
      const model = answering([JULY_4]);
      expect((await pass({ chat: model })).suggestions).toMatchObject({ budget: 1 });
      expect(model.calls).toHaveLength(0);
      expect(await spent(p)).toBe(20_000_000 - SUGGESTIONS_RESERVE_MICRO_USD);
    });
  });

  it('sends only the earlier suggestions whose dates fall in the 91 days', async () => {
    const p = await place();
    const store = server.ctx.stores.agentSuggestions;
    const closure = (date: string) => ({
      content: { type: 'note' as const, note: {
        kind: 'closure' as const, startDate: date, endDate: date, weekdays: null, effect: 'closed' as const, expectedGuests: null,
        detail: null, title: null, startTime: null, endTime: null,
      } },
      why: `Synthetic why for ${date}.`, calendarIds: [],
    });
    await store.insert(p.scope, { locationId: p.locationId, week: '2026-01-05', suggestions: [closure('2026-01-10'), closure('2026-07-03')], now: server.clock.now() });
    const model = answering([]);
    await pass({ chat: model });
    const sent = JSON.stringify(messagesOf(model.calls[0]));
    expect(sent).toContain('2026-07-03');
    expect(sent).not.toContain('2026-01-10');
  });

  describe('owner-calendar events (calendar-event-suggestions, design decisions 6 to 8 and 11)', () => {
    const TOWN = { today: '2026-06-01', timeZone: 'America/New_York' };

    /** A calendar file of single events, each on `day` (YYYYMMDD) from 6 pm to 10 pm; one with no uid is not keyed. */
    function parsedOf(events: readonly { uid: string | null; title: string; day: string }[]) {
      const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Townwise test//EN', ...events.flatMap((event) => [
        'BEGIN:VEVENT', ...(event.uid === null ? [] : [`UID:${event.uid}`]), `SUMMARY:${event.title}`, `DTSTART:${event.day}T180000`,
        `DTEND:${event.day}T220000`, 'END:VEVENT',
      ]), 'END:VCALENDAR', ''].join('\r\n');
      const parsed = parseIcs(text, TOWN);
      if ('error' in parsed) throw new Error(parsed.error);
      return parsed;
    }

    /**
     * A link calendar (a file with `file`, Google with `connectionId`), added from the popover that shows the weekly
     * notice (`titlesNotice: 1`) unless `unnoticed` says it was added from a screen that did not (an older one).
     */
    async function calendarOf(
      p: Place, events: readonly { uid: string | null; title: string; day: string }[],
      source: { label: string; connectionId?: string; file?: true; unnoticed?: true; addedAt?: Date },
    ): Promise<string> {
      const notice = source.unnoticed === true ? {} : { titlesNotice: 1 as const };
      const added = await server.ctx.stores.ownerCalendars.add(p.scope, p.locationId, source.connectionId !== undefined
        ? { kind: 'google', label: source.label, sealedAddress: 'sealed-for-test', googleConnectionId: source.connectionId }
        : source.file === true ? { kind: 'file', label: source.label, ...notice }
          : { kind: 'link', label: source.label, sealedAddress: 'sealed-for-test', host: 'bookings.sentinel-host.test', ...notice }, parsedOf(events), {
        createdBy: 'user-sentinel', now: source.addedAt ?? server.clock.now(),
      });
      if (added === 'calendar_limit') throw new Error('calendar_limit');
      return added.id;
    }

    /** A Google connection, made from the explainer that shows the weekly notice when `noticed`, revoked when `revokedAt`. */
    async function connectionOf(p: Place, noticed: boolean, revokedAt: Date | null = null): Promise<string> {
      const _id = new Types.ObjectId();
      const at = server.clock.now();
      await server.connection.collection('tw_google_connections').insertOne({
        _id, orgId: new Types.ObjectId(p.orgId), userId: `user-${randomUUID().slice(0, 8)}`, sealedRefreshToken: 'sealed-for-test', scopes: [],
        agreedAt: at, connectedAt: at, updatedAt: at, revokedAt, checkAt: new Date('2099-01-01T00:00:00.000Z'), leaseUntil: null,
        ...(noticed ? { titlesNotice: 1 } : {}),
      });
      return _id.toHexString();
    }

    function sentOf(model: ScriptedModel): Record<string, unknown> {
      const [first] = messagesOf(model.calls[0]);
      return JSON.parse(typeof first?.content === 'string' ? first.content : '') as Record<string, unknown>;
    }

    function passLine(): Record<string, unknown> | undefined {
      return logLines(server).filter((each) => each.msg === 'townwise.weekly_suggestions_pass').at(-1);
    }

    it('sends the keyed events, soonest first, as titles with no email or phone number, and nothing that names a calendar or an event', async () => {
      const p = await place();
      const link = await calendarOf(p, [
        { uid: 'sentinel-uid-0001@bookings.sentinel-host.test', title: 'Private party, 40 guests, call 603-555-0100 or host@sentinel-mail.test', day: '20260613' },
        { uid: null, title: 'Unkeyed lunch', day: '20260610' },
        { uid: 'sentinel-uid-0002@bookings.sentinel-host.test', title: 'Linked brunch', day: '20260611' },
        { uid: 'sentinel-uid-0003@bookings.sentinel-host.test', title: 'Spotted before', day: '20260612' },
        { uid: 'sentinel-uid-0004@bookings.sentinel-host.test', title: 'Past the 91 days', day: '20260905' },
      ], { label: 'Sentinel Front Desk' });
      await server.ctx.stores.notes.create(p.scope, p.locationId, {
        kind: 'private_event', startDate: '2026-06-11', endDate: '2026-06-11', weekdays: null, effect: 'more_guests', expectedGuests: 20, detail: null, title: null,
        startTime: '18:00', endTime: '22:00',
      }, {
        createdBy: 'user-sentinel', now: server.clock.now(),
        fromEvent: { calendarId: link, uid: 'sentinel-uid-0002@bookings.sentinel-host.test', startDate: '2026-06-11', endDate: '2026-06-11', startTime: '18:00', endTime: '22:00', linkedAt: server.clock.now() },
      });
      await server.ctx.stores.agentSuggestions.insert(p.scope, { locationId: p.locationId, week: '2026-05-25', now: server.clock.now(), suggestions: [{
        content: {
          type: 'event',
          note: { kind: 'private_event', startDate: '2026-06-12', endDate: '2026-06-12', weekdays: null, effect: 'unknown', expectedGuests: null, detail: null, title: null, startTime: '18:00', endTime: '22:00' },
          event: { calendarId: link, uid: 'sentinel-uid-0003@bookings.sentinel-host.test', startDate: '2026-06-12', endDate: '2026-06-12', startTime: '18:00', endTime: '22:00' },
        },
        why: null, calendarIds: [],
      }] });
      await server.ctx.stores.agentSuggestions.markDismissed(p.scope, p.locationId, (await server.ctx.stores.agentSuggestions.listOpen(p.scope, p.locationId, '2026-06-01'))[0]?.id ?? '', { by: 'user-sentinel', now: server.clock.now() });
      const older = await connectionOf(p, false);
      const newer = await connectionOf(p, true);
      const revoked = await connectionOf(p, true, server.clock.now());
      await calendarOf(p, [{ uid: 'sentinel-google-revoked', title: 'Revoked dinner', day: '20260616' }], { label: 'Sentinel Revoked Google', connectionId: revoked });
      const oldGoogle = await calendarOf(p, [{ uid: 'sentinel-google-old', title: 'Old agreement dinner', day: '20260615' }], { label: 'Sentinel Old Google', connectionId: older });
      const newGoogle = await calendarOf(p, [{ uid: 'sentinel-google-new', title: 'New agreement dinner', day: '20260609' }], { label: 'Sentinel New Google', connectionId: newer });

      const model = answering([]);
      await pass({ chat: model });
      const sent = sentOf(model);
      expect(sent.ownerEvents).toEqual([
        { ref: 'e1', title: 'New agreement dinner', startDate: '2026-06-09', startWeekday: 'Tue', endDate: '2026-06-09', endWeekday: 'Tue', startTime: '18:00', endTime: '22:00' },
        { ref: 'e2', title: 'Private party, 40 guests, call [removed] or [removed]', startDate: '2026-06-13', startWeekday: 'Sat', endDate: '2026-06-13', endWeekday: 'Sat', startTime: '18:00', endTime: '22:00' },
      ]);
      const request = JSON.stringify(model.calls[0]?.params);
      for (const absent of [
        'sentinel-uid', 'sentinel-google', 'Sentinel Front Desk', 'Sentinel Old Google', 'Sentinel New Google', 'sentinel-host', 'sentinel-mail', '603-555-0100',
        'Unkeyed lunch', 'Linked brunch', 'Spotted before', 'Old agreement dinner', 'Revoked dinner', 'Past the 91 days', link, oldGoogle, newGoogle, older, newer, revoked,
        '"kind":"link"', '"kind":"google"',
      ]) expect({ absent, found: request.includes(absent) }).toEqual({ absent, found: false });
      expect(passLine()).toMatchObject({ ownerEvents: 2, passes: 0, none: 1 });
      expect(JSON.stringify(logLines(server))).not.toMatch(/Private party|New agreement dinner|sentinel-uid/);
    });

    it('sends a file’s or link’s events only when its add showed the weekly notice, whatever day it was added', async () => {
      const p = await place();
      const later = new Date('2027-01-01T12:00:00.000Z');
      await calendarOf(p, [{ uid: 'old-link-0001@bookings.example.test', title: 'Old link dinner', day: '20260609' }], { label: 'Old link', unnoticed: true });
      await calendarOf(p, [{ uid: 'old-file-0001@bookings.example.test', title: 'Old file dinner', day: '20260610' }], { label: 'Old file', file: true, unnoticed: true, addedAt: later });
      await calendarOf(p, [{ uid: 'new-link-0001@bookings.example.test', title: 'New link dinner', day: '20260611' }], { label: 'New link' });
      await calendarOf(p, [{ uid: 'new-file-0001@bookings.example.test', title: 'New file dinner', day: '20260612' }], { label: 'New file', file: true });
      // A calendar row written before the notice was stored has no such field, as one added from an older screen.
      const raw = await server.connection.collection('tw_calendar_sources').find({ orgId: new Types.ObjectId(p.orgId) }).sort({ _id: 1 }).toArray();
      expect(raw.map((row) => (row.titlesNotice as number | undefined) ?? null)).toEqual([null, null, 1, 1]);
      const model = answering([]);
      await pass({ chat: model });
      expect((sentOf(model).ownerEvents as { title: string }[]).map((each) => each.title)).toEqual(['New link dinner', 'New file dinner']);
      expect(JSON.stringify(model.calls[0]?.params)).not.toMatch(/Old link dinner|Old file dinner/);
      expect(passLine()).toMatchObject({ ownerEvents: 2 });
    });

    it('leaves out the labeled events of a confirmed file calendar, and sends its unlabeled ones and an unconfirmed calendar’s (D58)', async () => {
      const p = await place();
      const confirmed = await calendarOf(p, [
        { uid: 'labeled-other@bookings.example.test', title: 'Labeled meeting', day: '20260609' },
        { uid: 'labeled-party@bookings.example.test', title: 'Labeled party', day: '20260610' },
        { uid: 'unlabeled@bookings.example.test', title: 'Unlabeled dinner', day: '20260611' },
      ], { label: 'Confirmed', file: true });
      const sorted = await calendarOf(p, [{ uid: 'sorted-party@bookings.example.test', title: 'Sorted party', day: '20260612' }], { label: 'Sorted', file: true });
      const calendars = server.ctx.stores.ownerCalendars;
      await calendars.setLabels(p.scope, p.locationId, confirmed, [
        { uid: 'labeled-other@bookings.example.test', booking: 'other' }, { uid: 'labeled-party@bookings.example.test', booking: 'party' },
      ], server.clock.now());
      await calendars.confirmBookings(p.scope, p.locationId, confirmed, { by: 'admin-0000', now: server.clock.now() });
      await calendars.setLabels(p.scope, p.locationId, sorted, [{ uid: 'sorted-party@bookings.example.test', booking: 'party' }], server.clock.now());
      const model = answering([]);
      await pass({ chat: model });
      expect((sentOf(model).ownerEvents as { title: string }[]).map((each) => each.title)).toEqual(['Unlabeled dinner', 'Sorted party']);
      expect(JSON.stringify(model.calls[0]?.params)).not.toMatch(/Labeled meeting|Labeled party/);
    });

    it('sends none of a new file’s or link’s events with the organization’s calendar titles switch off', async () => {
      const p = await place();
      await calendarOf(p, [{ uid: 'new-link-0001@bookings.example.test', title: 'New link dinner', day: '20260611' }], { label: 'New link' });
      await calendarOf(p, [{ uid: 'new-file-0001@bookings.example.test', title: 'New file dinner', day: '20260612' }], { label: 'New file', file: true });
      await server.ctx.stores.orgs.setCalendarTitlesToAi(p.scope, { on: false, at: server.clock.now(), by: 'admin-0000' });
      const model = answering([]);
      await pass({ chat: model });
      expect(sentOf(model)).not.toHaveProperty('ownerEvents');
      expect(JSON.stringify(model.calls[0]?.params)).not.toMatch(/New link dinner|New file dinner/);
      expect(passLine()).toMatchObject({ ownerEvents: 0 });
    });

    it('sends none with the organization’s calendar titles switch off, and the request is as before', async () => {
      const p = await place();
      await calendarOf(p, [{ uid: 'party-0001@bookings.example.test', title: 'Private party', day: '20260613' }], { label: 'Front desk' });
      await server.ctx.stores.orgs.setCalendarTitlesToAi(p.scope, { on: false, at: server.clock.now(), by: 'admin-0000' });
      const model = answering([]);
      await pass({ chat: model });
      expect(model.calls[0]?.params.system).toBe(SUGGESTIONS_SYSTEM_PROMPT);
      expect(Object.keys(sentOf(model)).sort()).toEqual(['alreadySuggested', 'calendar', 'from', 'notes', 'rules', 'to', 'today', 'town']);
      expect(JSON.stringify(model.calls[0]?.params)).not.toContain('Private party');
      expect(passLine()).toMatchObject({ ownerEvents: 0 });
    });

    it('a typical calendar of 20 events keeps the reservation at $0.30', async () => {
      const p = await place();
      await calendarOf(p, Array.from({ length: 20 }, (_, index) => ({
        uid: `booking-${String(index)}@bookings.example.test`, title: `Private booking number ${String(index)} for the back room, 30 guests`,
        day: `202606${String(index + 2).padStart(2, '0')}`,
      })), { label: 'Front desk' });
      const model = answering([]);
      await pass({ chat: model });
      expect((sentOf(model).ownerEvents as unknown[])).toHaveLength(20);
      const params = model.calls[0]?.params;
      if (params === undefined) throw new Error('no call');
      expect(suggestionsReserveMicroUsd(params)).toBe(SUGGESTIONS_RESERVE_MICRO_USD);
    });

    it('sends at most 150, soonest first: a 151st is left out', async () => {
      const p = await place();
      // Two a day from Jun 2, the 151st (index 150) the latest of them.
      await calendarOf(p, Array.from({ length: 151 }, (_, index) => ({
        uid: `booking-${String(index).padStart(3, '0')}@bookings.example.test`, title: `Booking ${String(index).padStart(3, '0')}`,
        day: utcDay(new Date('2026-06-02T00:00:00.000Z'), Math.floor(index / 2)).replaceAll('-', ''),
      })), { label: 'Front desk' });
      const model = answering([]);
      await pass({ chat: model });
      const titles = (sentOf(model).ownerEvents as { title: string }[]).map((each) => each.title);
      expect(titles).toHaveLength(SUGGESTIONS_MAX_OWNER_EVENTS);
      expect(titles).not.toContain('Booking 150');
      expect(titles.at(-1)).toBe('Booking 149');
    });

    it('keeps a spotted Google event and a closure, drops one that repeats a sentinel title, and no stored suggestion or staff view holds the title', async () => {
      const p = await place();
      const connectionId = await connectionOf(p, true);
      await calendarOf(p, [{ uid: 'sentinel-0001@google.test', title: 'Zyxwvut rehearsal dinner, 40 guests', day: '20260613' }], { label: 'Bookings', connectionId });
      const spot = {
        ...JULY_4, type: 'event', kind: 'private_event', effect: 'unknown', startDate: '2026-06-13', endDate: '2026-06-13', expectedGuests: 40,
        eventRef: 'e1', why: 'Zyxwvut rehearsal dinner', detail: 'Zyxwvut', calendarIds: [],
      };
      const echoed = { ...JULY_4, startDate: '2026-07-03', endDate: '2026-07-03', why: 'The Zyxwvut family closes it.', eventRef: null };
      const model = answering([{ ...JULY_4, eventRef: null }, echoed, spot]);
      expect((await pass({ chat: model })).suggestions).toMatchObject({ passes: 1, suggested: 2, ownerEvents: 1 });
      const rows = await suggestions(p);
      expect(rows.map((row) => row.type).sort()).toEqual(['event', 'note']);
      expect(rows.find((row) => row.type === 'event')).toMatchObject({ why: null, content: { expectedGuests: 40, detail: null, effect: 'unknown' } });
      expect(JSON.stringify(rows).toLowerCase()).not.toContain('zyxwvut');

      const email = `owner-${randomUUID().slice(0, 8)}@example.test`;
      const owner: TestSession = await signIn(server, email);
      await addSeat(server, { orgId: p.orgId, userId: owner.userId, email, role: 'org_admin' });
      const read = async (session: TestSession): Promise<AgentPanel> => {
        const res = await call(server, `/api/org/locations/${p.locationId}/agent`, { session });
        expect(res.status).toBe(200);
        return await res.json() as AgentPanel;
      };
      expect(JSON.stringify(await read(owner))).toContain('Zyxwvut rehearsal dinner, 40 guests');
      const staff = await signInStaff(server);
      try {
        await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: owner.userId, orgId: p.orgId });
        const viewed = await read(staff);
        expect(viewed.suggestions.map((each) => each.type).sort()).toEqual(['event', 'note']);
        expect(JSON.stringify(viewed).toLowerCase()).not.toContain('zyxwvut');
      } finally {
        await removeStaffFactor(server);
      }
    });

    it('D59 slice 3: saves a spotted buyout it is sure of as TownwiseAI’s note linked to the event, with no title anywhere it keeps', async () => {
      const p = await place();
      const calendarId = await calendarOf(p, [
        { uid: 'buyout-0001@bookings.example.test', title: 'Qxzv buyout, 60 guests', day: '20260613' },
        { uid: 'party-0002@bookings.example.test', title: 'Qxzv party, 12 guests', day: '20260620' },
      ], { label: 'Front desk' });
      const spot = (ref: string, date: string, over: Record<string, unknown>) => ({
        ...JULY_4, type: 'event', kind: 'private_event', startDate: date, endDate: date, eventRef: ref, why: '', calendarIds: [], ...over,
      });
      const model = answering([
        spot('e1', '2026-06-13', { effect: 'closed', expectedGuests: 60, confidence: 'high' }),
        spot('e2', '2026-06-20', { effect: 'unknown', expectedGuests: 12, confidence: 'high' }),
      ]);
      expect((await pass({ chat: model })).suggestions).toMatchObject({ applied: 1, suggested: 1, ownerEvents: 2 });
      const notes = await server.connection.collection('tw_notes').find({ locationId: new Types.ObjectId(p.locationId) }).toArray();
      expect(notes).toEqual([expect.objectContaining({
        createdBy: 'townwise_ai', kind: 'private_event', effect: 'closed', expectedGuests: 60, startDate: '2026-06-13', title: null, detail: null,
        startTime: '18:00', endTime: '22:00', fromEvent: expect.objectContaining({ uid: 'buyout-0001@bookings.example.test', calendarId: new Types.ObjectId(calendarId) }) as unknown,
      })]);
      const rows = await suggestions(p);
      expect(rows.map((row) => [row.type, row.status]).sort()).toEqual([['event', 'accepted'], ['event', 'open']]);
      expect(String(rows.find((row) => row.status === 'accepted')?._id)).toBe(String(notes[0]?._id));
      const ledger = await server.connection.collection('tw_agent_changes').find({ locationId: new Types.ObjectId(p.locationId) }).toArray();
      expect(ledger).toEqual([expect.objectContaining({ action: 'note.add', sourceKind: 'weekly', why: null, noteKind: 'private_event' })]);
      expect(passLine()).toMatchObject({ applied: 1 });
      expect(JSON.stringify([rows, ledger, logLines(server), await auditEvents(server)])).not.toContain('Qxzv');
    });
  });
});

// ---- D59: refits after training changes -----------------------------------------------------------------------------

describe('refits after training changes (D59)', () => {
  /** Monday's refresh starts the location and its job finishes, so it has a reference calibration and a week row. */
  async function settled(): Promise<Place> {
    const p = await place();
    expect(await pass()).toMatchObject({ started: 1 });
    const [job] = jobs();
    await finishJob(job?.calibrationId ?? '');
    start = runner.jobs.length;
    return p;
  }

  /** A person's closure on a history day (what the lab reads changes), and the mark it wants, at the clock's now. */
  async function changed(p: Place, date: string): Promise<void> {
    await server.ctx.stores.notes.create(p.scope, p.locationId, {
      kind: 'closure', startDate: date, endDate: date, weekdays: null, effect: 'closed', expectedGuests: null, detail: null, title: null,
      startTime: null, endTime: null,
    }, { createdBy: 'person', now: server.clock.now() });
    await server.ctx.stores.locations.wantRefit(p.scope, p.locationId, server.clock.now());
  }

  async function refitOf(p: Place): Promise<{ wantedAt: Date | null; startedAt: Date | null }> {
    return server.ctx.stores.locations.refitState(p.scope, p.locationId);
  }

  it('a burst of changes starts one refit as the system, at the first pass 15 quiet minutes after the last of them', async () => {
    const p = await settled();
    for (const date of ['2026-05-10', '2026-05-11', '2026-05-12']) {
      await changed(p, date);
      server.clock.advance(5 * MINUTE);
    }
    // The last change was 5 minutes ago: not quiet yet.
    expect((await pass()).refits).toEqual({ started: 0, cleared: 0, held: 0, failed: 0 });
    server.clock.advance(11 * MINUTE);
    const result = await pass();
    expect(result.refits).toEqual({ started: 1, cleared: 0, held: 0, failed: 0 });
    expect(jobs()).toHaveLength(1);
    expect(await calibration(jobs()[0]?.calibrationId ?? '')).toMatchObject({ requestedBy: SYSTEM_REQUESTER, chargedMicroUsd: 0 });
    expect(await refitOf(p)).toEqual({ wantedAt: null, startedAt: server.clock.now() });
    expect(logLines(server).filter((line) => line.msg === 'townwise.refit_pass').at(-1)).toMatchObject({ started: 1 });
    // Nothing more is wanted: the next pass starts nothing.
    expect((await pass()).refits.started).toBe(0);
  });

  it('the weekly cap counts every refit start, not one per location and not a refusal, and Monday’s pass counts them too', async () => {
    const { locations } = server.ctx.stores;
    const now = server.clock.now();
    const p = await place();
    // Three refits on three days this past week at one location, and a refusal at another.
    for (const daysAgo of [3, 2, 1]) expect(await locations.markRefitStarted(p.scope, p.locationId, new Date(now.getTime() - daysAgo * DAY), true)).toBe(true);
    const q = await place();
    expect(await locations.markRefitStarted(q.scope, q.locationId, now, false)).toBe(true);
    expect(await countRefitStartsSince(server.connection, new Date(now.getTime() - 7 * DAY))).toBe(3);
    // A cap of 4: the three refits leave room for one of Monday's two starts.
    expect(await pass({ config: { weeklyForecastCap: 4 } })).toMatchObject({ started: 1, capped: 1 });
    expect(jobs()).toHaveLength(1);
  });

  it('a mark whose lab input did not change is cleared, with no start', async () => {
    const p = await settled();
    await server.ctx.stores.locations.wantRefit(p.scope, p.locationId, server.clock.now());
    server.clock.advance(16 * MINUTE);
    expect((await pass()).refits).toEqual({ started: 0, cleared: 1, held: 0, failed: 0 });
    expect(jobs()).toHaveLength(0);
    expect((await refitOf(p)).wantedAt).toBeNull();
  });

  it('a location refits at most once a day: a change after a refit keeps its mark until a day after that start', async () => {
    const p = await settled();
    await changed(p, '2026-05-10');
    server.clock.advance(16 * MINUTE);
    expect((await pass()).refits.started).toBe(1);
    await finishJob(jobs()[0]?.calibrationId ?? '');
    const startedAt = server.clock.now();
    server.clock.advance(2 * HOUR);
    await changed(p, '2026-05-11');
    server.clock.advance(HOUR);
    expect((await pass()).refits.started).toBe(0);
    expect((await refitOf(p)).wantedAt).not.toBeNull();
    server.clock.advance(startedAt.getTime() + DAY - server.clock.now().getTime() + MINUTE);
    expect((await pass()).refits.started).toBe(1);
    expect(jobs()).toHaveLength(2);
  });

  it('a location with a live calibration, or past the live cap, keeps its mark for a later pass', async () => {
    const p = await settled();
    await changed(p, '2026-05-10');
    server.clock.advance(16 * MINUTE);
    const person = await personStart(p);
    expect((await pass()).refits).toMatchObject({ started: 0, held: 1 });
    expect((await refitOf(p)).wantedAt).not.toBeNull();
    await finishJob(person.id);
    // Three other locations' Monday starts are live: the cap of 3 holds this one too.
    for (let i = 0; i < SCHEDULE_LIVE_CAP; i += 1) await place();
    start = runner.jobs.length;
    const result = await pass();
    expect(result).toMatchObject({ started: SCHEDULE_LIVE_CAP });
    expect(result.refits).toMatchObject({ started: 0, held: 1 });
    expect((await refitOf(p)).wantedAt).not.toBeNull();
  });

  it('a change landing while the refit starts keeps its newer mark', async () => {
    const p = await settled();
    await changed(p, '2026-05-10');
    server.clock.advance(16 * MINUTE);
    const newer = new Date(server.clock.now().getTime() + 1000);
    runner.onStart = async () => { await server.ctx.stores.locations.wantRefit(p.scope, p.locationId, newer); };
    expect((await pass()).refits.started).toBe(1);
    expect(await refitOf(p)).toEqual({ wantedAt: newer, startedAt: server.clock.now() });
  });

  it('starts no refit while TOWNWISE_WEEKLY_FORECASTS is false or the schedule is paused, and keeps the mark', async () => {
    const p = await settled();
    await changed(p, '2026-05-10');
    server.clock.advance(16 * MINUTE);
    expect((await pass({ config: { weeklyForecasts: false } })).refits.started).toBe(0);
    await server.ctx.stores.forecastSchedule.setPaused({ at: server.clock.now(), by: 'staff-0000', email: 'staff@townwise.test' }, server.clock.now());
    try {
      expect((await pass()).refits.started).toBe(0);
    } finally {
      await server.ctx.stores.forecastSchedule.setPaused(null, server.clock.now());
    }
    expect(jobs()).toHaveLength(0);
    expect((await refitOf(p)).wantedAt).not.toBeNull();
    expect((await pass()).refits.started).toBe(1);
  });
});
