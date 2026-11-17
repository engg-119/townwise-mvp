// Who pays for a calibration and how much history it needs (D27, D42): a person's start (an org admin's or staff's) is
// one of the organization's 4 a day, is charged $0.10 to its TownwiseAI month, is refused on a spent month and needs a
// 595-day span; the weekly refresh's start (the system requester) is none of those and may start from 230 days. The
// services are called directly, as the weekly refresh will (phase 3b), with a fake runner. Every number is synthetic.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { calibrationFor, calibrationWords } from '../src/calibration.ts';
import { utcDay } from '../src/dates.ts';
import { runFileSha256, type ForecastRunFile } from '../src/forecasts/file.ts';
import {
  CALIBRATION_CHARGE_MICRO_USD, CALIBRATIONS_PER_ORG_PER_DAY, checkStart, finishCalibration, launch, SYSTEM_REQUESTER, type StartRequest,
} from '../src/lab/service.ts';
import { addChatUsage, addLocation, createOrg } from './helpers/fixtures.ts';
import { fakeLabRunner, runDays, seedHistory, type FakeLabRunner } from './helpers/lab.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;
let runner: FakeLabRunner;

beforeAll(async () => {
  runner = fakeLabRunner();
  server = await startTownwiseServer({ labRunner: runner });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

/** The test clock's day (2026-06-01) is the town's today; history runs to the day before. */
const TODAY = '2026-06-01';
const LAST = '2026-05-31';
const PERSON = { userId: 'staff-0000', role: 'superadmin', via: 'console' } as const;

interface Place { scope: OrgScope; orgId: string; locationId: string }

/** An organization with one location holding guests on every day of a `span`-day span ending on LAST. */
async function place(span: number, forecastsOn = false): Promise<Place> {
  const orgId = await createOrg(server, { name: `Refresh Kitchen ${randomUUID().slice(0, 6)}`, forecastsOn });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  await seedHistory(server, { orgId, locationId, from: utcDay(new Date(`${LAST}T00:00:00.000Z`), -span), to: LAST });
  return { scope: { orgId } as OrgScope, orgId, locationId };
}

async function request(p: Place, requester: StartRequest['requester']): Promise<StartRequest> {
  const location = await server.ctx.stores.locations.find(p.scope, p.locationId);
  if (location === null) throw new Error('no location');
  return { id: new Types.ObjectId().toHexString(), scope: p.scope, location, requester, regimeStart: null, today: TODAY };
}

/** Starts one calibration (checkStart, then launch), then frees the location again (a timeout), resolving its record. */
async function startAndFree(p: Place, requester: StartRequest['requester']) {
  const req = await request(p, requester);
  expect(await checkStart(server.ctx, req)).toBeNull();
  const launched = await launch(server.ctx, req);
  if (!launched.ok) return launched;
  await finishCalibration(server.ctx, p.scope, launched.calibration, { status: 'failed', failure: 'timeout' });
  return launched;
}

function usage(orgId: string): Promise<number> {
  return server.connection.collection('tw_chat_usage').countDocuments({ orgId: new Types.ObjectId(orgId) });
}

describe('the weekly refresh’s start (system requester, D42)', () => {
  it('is recorded as the system, charged nothing, and leaves the month and the 4 a day untouched', async () => {
    const p = await place(600);
    const system = await startAndFree(p, SYSTEM_REQUESTER);
    if (!system.ok) return expect.unreachable('the system start starts');
    const doc = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(system.calibration.id) });
    expect(doc).toMatchObject({ requestedBy: { userId: null, role: 'system', via: 'scheduled' }, chargedMicroUsd: 0 });
    expect(await usage(p.orgId)).toBe(0);
    // The organization's 4 a day are all still there for people
    for (let i = 0; i < CALIBRATIONS_PER_ORG_PER_DAY; i += 1) expect((await startAndFree(p, PERSON)).ok).toBe(true);
    expect(await launch(server.ctx, await request(p, PERSON))).toEqual({ ok: false, code: 'rate_limited' });
    // and a fifth start of the day by the system still starts
    expect((await startAndFree(p, SYSTEM_REQUESTER)).ok).toBe(true);
    const month = await server.connection.collection('tw_chat_usage').findOne({ orgId: new Types.ObjectId(p.orgId) });
    expect(month?.costMicroUsd).toBe(CALIBRATIONS_PER_ORG_PER_DAY * CALIBRATION_CHARGE_MICRO_USD);
    expect(runner.jobs.length).toBeGreaterThanOrEqual(6);
  });

  it('is not refused for a spent month', async () => {
    const p = await place(600);
    await addChatUsage(server, { orgId: p.orgId, month: '2026-06', costMicroUsd: 20_000_000 });
    expect(await checkStart(server.ctx, await request(p, PERSON))).toBe('budget_exhausted');
    expect(await checkStart(server.ctx, await request(p, SYSTEM_REQUESTER))).toBeNull();
  });

  it('may start from a 230-day span; 229 is not_enough_history', async () => {
    expect(await checkStart(server.ctx, await request(await place(230), SYSTEM_REQUESTER))).toBeNull();
    expect(await checkStart(server.ctx, await request(await place(229), SYSTEM_REQUESTER))).toBe('not_enough_history');
  });

  it('still holds the location’s one live slot', async () => {
    const p = await place(600);
    const person = await launch(server.ctx, await request(p, PERSON));
    expect(person.ok).toBe(true);
    expect(await checkStart(server.ctx, await request(p, SYSTEM_REQUESTER))).toBe('in_progress');
  });
});

describe('a person’s start keeps D27', () => {
  it('is charged $0.10 to the month and needs a 595-day span', async () => {
    const p = await place(600);
    const started = await startAndFree(p, PERSON);
    if (!started.ok) return expect.unreachable('the start starts');
    const doc = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId(started.calibration.id) });
    expect(doc?.chargedMicroUsd).toBe(CALIBRATION_CHARGE_MICRO_USD);
    expect(await usage(p.orgId)).toBe(1);
    expect(await checkStart(server.ctx, await request(await place(594), PERSON))).toBe('not_enough_history');
    expect(await checkStart(server.ctx, await request(await place(300), PERSON))).toBe('not_enough_history');
    expect(await checkStart(server.ctx, await request(await place(595), PERSON))).toBeNull();
  });
});

describe('calibrated and stale (14.3, D42)', () => {
  /** Publishes a run of the location whose data ends on `dataThrough`, as a staff import would. */
  async function publishRun(p: Place, dataThrough: string): Promise<void> {
    const file: ForecastRunFile = {
      schema: 'townwise.forecast-run/1', metric: 'guests', model: { family: 'seasonal_baseline', version: 'v7', notebookCommit: 'abcdef0' },
      trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough, madeAt: dataThrough, frozen: null,
      interval: { level: 0.8, widened: true }, backtest: null, ...runDays(dataThrough, 70),
    };
    const id = new Types.ObjectId().toHexString();
    const { run } = await server.ctx.stores.forecasts.upsertRun(p.scope, p.locationId, {
      id, file, fileSha256: runFileSha256(file), importedBy: 'staff-0000', lab: null, now: server.clock.now(),
    });
    await server.ctx.stores.forecasts.setStatus(p.scope, run.id, { from: ['importing'], to: 'published', at: server.clock.now(), by: 'staff-0000' });
  }

  async function stateOf(p: Place) {
    const location = await server.ctx.stores.locations.find(p.scope, p.locationId);
    if (location === null) throw new Error('no location');
    return calibrationFor(server.ctx, p.scope, location, await server.ctx.stores.salesDays.coverage(p.scope, p.locationId));
  }

  it('reads the newest published run: stale with the days with guests after it, calibrated when it holds the last one', async () => {
    const p = await place(300, true);
    expect((await stateOf(p)).state).toBe('not_calibrated');
    await publishRun(p, '2026-05-24');
    // Today is Mon, Jun 1 in Hanover: the weekly refresh next considers the location on Mon, Jun 8
    const stale = await stateOf(p);
    expect(stale).toMatchObject({ state: 'stale', dataThrough: '2026-05-24', newerDays: 7, nextRefresh: '2026-06-08', lastDate: LAST });
    expect(calibrationWords(stale)).toBe('Forecast made from your sales through Sun, May 24. Townwise refits on Mon, Jun 8 with the 7 days since.');
    await publishRun(p, LAST);
    expect(await stateOf(p)).toMatchObject({ state: 'calibrated', dataThrough: LAST, newerDays: 0, nextRefresh: '2026-06-08' });
  });

  it('an organization nobody switched has its next refresh (forecasts on by default); none with the switch false or the schedule paused', async () => {
    const orgId = await createOrg(server, { name: `Default Kitchen ${randomUUID().slice(0, 6)}` });
    const locationId = await addLocation(server, { orgId, name: 'Main Room' });
    await seedHistory(server, { orgId, locationId, from: '2025-08-04', to: LAST });
    const p: Place = { scope: { orgId } as OrgScope, orgId, locationId };
    await publishRun(p, '2026-05-24');
    expect(await stateOf(p)).toMatchObject({ state: 'stale', nextRefresh: '2026-06-08' });
    const location = await server.ctx.stores.locations.find(p.scope, p.locationId);
    if (location === null) throw new Error('no location');
    const coverage = await server.ctx.stores.salesDays.coverage(p.scope, p.locationId);
    const switchedOff = { ...server.ctx, config: { ...server.ctx.config, weeklyForecasts: false } };
    expect(await calibrationFor(switchedOff, p.scope, location, coverage)).toMatchObject({ state: 'stale', nextRefresh: null });
    await server.ctx.stores.forecastSchedule.setPaused({ at: server.clock.now(), by: 'staff-0000', email: 'staff@townwise.test' }, server.clock.now());
    try {
      expect(await stateOf(p)).toMatchObject({ state: 'stale', nextRefresh: null });
    } finally {
      await server.ctx.stores.forecastSchedule.setPaused(null, server.clock.now());
    }
    expect(await stateOf(p)).toMatchObject({ nextRefresh: '2026-06-08' });
  });

  it('promises no refit when a refit already read the days since and was refused, since next Monday finds nothing changed', async () => {
    const p = await place(300, true);
    await publishRun(p, '2026-05-24');
    expect(await stateOf(p)).toMatchObject({ state: 'stale', newerDays: 7, nextRefresh: '2026-06-08' });
    // This Monday's refit read every day through LAST and was refused (refresh_worse): it is the reference now, so the
    // next Monday's fingerprint matches it and the week records unchanged.
    const { calibrations } = server.ctx.stores;
    const id = new Types.ObjectId().toHexString();
    const now = server.clock.now();
    await calibrations.insertQueued(p.scope, {
      id, locationId: p.locationId, requestedBy: { userId: null, role: 'system', via: 'scheduled' }, regimeStart: null, championRunId: null,
      tokenExpiresAt: new Date(now.getTime() + 20 * 60_000), now,
    });
    await calibrations.markRunning(p.scope, id, { now, imageDigest: null });
    await calibrations.recordInput(p.scope, id, { inputSha256: 'a'.repeat(64), dataSha256: 'b'.repeat(64), dataThrough: LAST, resultTokenSha256: 'c'.repeat(64) });
    await calibrations.recordGate(p.scope, id, { published: false, reason: 'refresh_worse' });
    await calibrations.finish(p.scope, id, { status: 'succeeded' }, now);
    const stale = await stateOf(p);
    expect(stale).toMatchObject({ state: 'stale', newerDays: 7, nextRefresh: null });
    expect(calibrationWords(stale)).toBe('Forecast made from your sales through Sun, May 24. The 7 days since aren’t in it yet.');
    // A new day with guests is one the reference hasn't read: the next Monday refits again.
    await seedHistory(server, { orgId: p.orgId, locationId: p.locationId, from: '2026-06-01', to: '2026-06-01' });
    expect(await stateOf(p)).toMatchObject({ state: 'stale', newerDays: 8, nextRefresh: '2026-06-08' });
  });

  it('has no next refresh while the organization’s forecasts are off', async () => {
    const p = await place(300);
    await publishRun(p, '2026-05-24');
    expect(await stateOf(p)).toMatchObject({ state: 'stale', newerDays: 7, nextRefresh: null });
  });
});
