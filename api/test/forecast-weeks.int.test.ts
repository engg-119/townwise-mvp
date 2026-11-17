// The weekly refresh's data layer (D42): week rows (one per location per week, starting then started or start_failed,
// tenant-scoped, deleted with the location and the organization), the schedule document (the lease and the staff pause),
// the cross-tenant lookups (candidates with forecasts on by default, live scheduled calibrations, stale starting rows,
// the weekly cap's count) and the calibration a week compares with. Every id is synthetic.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, scopeForWeeklyRefresh, type OrgScope } from '../src/access/policy.ts';
import { removeLocation } from '../src/handlers/locations.ts';
import { createCalibrationStore, type CalibrationRequester } from '../src/stores/calibrations.ts';
import { countedWeekRows, liveScheduledCalibrations, staleStartingWeeks, weeklyCandidates } from '../src/stores/cross-tenant.ts';
import { createForecastScheduleStore } from '../src/stores/forecast-schedule.ts';
import { createForecastWeekStore } from '../src/stores/forecast-weeks.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const SYSTEM = { userId: null, role: 'system', via: 'scheduled' } as const;
const WEEK = '2026-06-01';
const MINUTE = 60_000;

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  for (const name of ['tw_orgs', 'tw_locations', 'tw_calibrations', 'tw_forecast_weeks', 'tw_forecast_schedule']) {
    await server.connection.collection(name).deleteMany({});
  }
});

interface Tenant { orgId: string; locationId: string; scope: OrgScope }

async function tenant(opts: { forecastsOn?: boolean; status?: 'active' | 'suspended' } = {}): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Week Cafe ${randomUUID().slice(0, 6)}`, ...opts });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, locationId, scope: scopeForNewOrg(STAFF, orgId) };
}

describe('week rows', () => {
  it('records one row per location per week, starting then started with the calibration, by compare-and-set', async () => {
    const weeks = createForecastWeekStore(server.connection);
    const t = await tenant();
    const now = server.clock.now();
    expect(await weeks.insert(t.scope, { locationId: t.locationId, week: WEEK, status: 'starting', dataSha256: 'a'.repeat(64), now })).toBe(true);
    expect(await weeks.insert(t.scope, { locationId: t.locationId, week: WEEK, status: 'starting', dataSha256: null, now })).toBe(false);
    const row = await weeks.find(t.scope, t.locationId, WEEK);
    expect(row).toMatchObject({ status: 'starting', calibrationId: null, dataSha256: 'a'.repeat(64) });
    const id = row?.id ?? '';
    expect(await weeks.resolve(t.scope, id, { status: 'started', calibrationId: 'c1' }, now)).toBe(true);
    expect(await weeks.resolve(t.scope, id, { status: 'start_failed' }, now)).toBe(false);
    expect(await weeks.find(t.scope, t.locationId, WEEK)).toMatchObject({ status: 'started', calibrationId: 'c1' });
    expect(await weeks.removeStarting(t.scope, id)).toBe(false);
    expect(await weeks.insert(t.scope, { locationId: t.locationId, week: '2026-06-08', status: 'unchanged', dataSha256: null, now })).toBe(true);
  });

  it('is tenant-scoped: another organization neither finds nor changes the row', async () => {
    const weeks = createForecastWeekStore(server.connection);
    const t = await tenant();
    const other = await tenant();
    await weeks.insert(t.scope, { locationId: t.locationId, week: WEEK, status: 'starting', dataSha256: null, now: server.clock.now() });
    const id = (await weeks.find(t.scope, t.locationId, WEEK))?.id ?? '';
    expect(await weeks.find(other.scope, t.locationId, WEEK)).toBeNull();
    expect(await weeks.resolve(other.scope, id, { status: 'start_failed' }, server.clock.now())).toBe(false);
    expect(await weeks.removeStarting(other.scope, id)).toBe(false);
    expect(await weeks.latestByLocation(other.scope, '2026-01-01')).toEqual([]);
  });

  it('lists the newest row of each location, and deletes with the location and the organization', async () => {
    const weeks = createForecastWeekStore(server.connection);
    const t = await tenant();
    const patio = await addLocation(server, { orgId: t.orgId, name: 'Patio' });
    const now = server.clock.now();
    await weeks.insert(t.scope, { locationId: t.locationId, week: '2026-05-25', status: 'started', dataSha256: null, now });
    await weeks.insert(t.scope, { locationId: t.locationId, week: WEEK, status: 'unchanged', dataSha256: null, now });
    await weeks.insert(t.scope, { locationId: patio, week: WEEK, status: 'cap_reached', dataSha256: null, now });
    const latest = await weeks.latestByLocation(t.scope, '2026-05-01');
    expect(latest.map((row) => [row.locationId, row.week, row.status]).sort()).toEqual([
      [patio, WEEK, 'cap_reached'], [t.locationId, WEEK, 'unchanged'],
    ].sort());
    expect(await weeks.latestByLocation(t.scope, '2026-06-02')).toEqual([]);
    expect(await weeks.removeForLocation(t.scope, t.locationId)).toBe(2);
    expect(await weeks.removeForOrg(t.scope)).toBe(1);
  });
});

describe('deleting a location', () => {
  it('takes its week rows with it, and leaves its neighbour’s', async () => {
    const weeks = createForecastWeekStore(server.connection);
    const t = await tenant();
    const patio = await addLocation(server, { orgId: t.orgId, name: 'Patio' });
    const now = server.clock.now();
    await weeks.insert(t.scope, { locationId: t.locationId, week: WEEK, status: 'started', dataSha256: null, now });
    await weeks.insert(t.scope, { locationId: patio, week: WEEK, status: 'unchanged', dataSha256: null, now });
    expect(await removeLocation(server.ctx, t.scope, t.locationId)).toBe(true);
    expect(await weeks.find(t.scope, t.locationId, WEEK)).toBeNull();
    expect(await weeks.find(t.scope, patio, WEEK)).toMatchObject({ status: 'unchanged' });
  });
});

describe('the schedule document', () => {
  it('lets one pass hold the lease at a time, renews it only for its holder, and releases it', async () => {
    const schedule = createForecastScheduleStore(server.connection);
    const now = server.clock.now();
    expect(await schedule.claim({ owner: 'a', now, leaseMs: 10 * MINUTE })).toEqual({ claimed: true, paused: null });
    expect((await schedule.claim({ owner: 'b', now, leaseMs: 10 * MINUTE })).claimed).toBe(false);
    expect(await schedule.renew({ owner: 'a', now, leaseMs: 10 * MINUTE })).toBe(true);
    expect(await schedule.renew({ owner: 'b', now, leaseMs: 10 * MINUTE })).toBe(false);
    // Past the lease, another pass takes it, and the first one's renewal then fails.
    const later = new Date(now.getTime() + 11 * MINUTE);
    expect((await schedule.claim({ owner: 'b', now: later, leaseMs: 10 * MINUTE })).claimed).toBe(true);
    expect(await schedule.renew({ owner: 'a', now: later, leaseMs: 10 * MINUTE })).toBe(false);
    await schedule.release({ owner: 'b', now: later });
    expect((await schedule.claim({ owner: 'c', now: new Date(later.getTime() + 1), leaseMs: 10 * MINUTE })).claimed).toBe(true);
  });

  it('keeps the staff pause, which a claim reports, until it is cleared', async () => {
    const schedule = createForecastScheduleStore(server.connection);
    const now = server.clock.now();
    expect(await schedule.paused()).toBeNull();
    await schedule.setPaused({ at: now, by: 'staff-1', email: 'staff@example.test' }, now);
    expect(await schedule.paused()).toEqual({ at: now, by: 'staff-1', email: 'staff@example.test' });
    const claimed = await schedule.claim({ owner: 'a', now: new Date(now.getTime() + 1), leaseMs: MINUTE });
    expect(claimed).toEqual({ claimed: true, paused: { at: now, by: 'staff-1', email: 'staff@example.test' } });
    await schedule.setPaused(null, now);
    expect(await schedule.paused()).toBeNull();
  });
});

describe('cross-tenant lookups', () => {
  it('candidates are the locations of active organizations with forecasts on, an absent switch counting as on', async () => {
    const unswitched = await tenant();
    const on = await tenant({ forecastsOn: true });
    const off = await tenant();
    await server.connection.collection('tw_orgs').updateOne(
      { _id: new Types.ObjectId(off.orgId) }, { $set: { forecasts: { on: false, at: server.clock.now(), by: 'staff-1' } } },
    );
    await tenant({ status: 'suspended' });
    const found = await weeklyCandidates(server.connection);
    expect(found.map((each) => each.locationId).sort()).toEqual([unswitched.locationId, on.locationId].sort());
    expect(found.find((each) => each.locationId === on.locationId)).toEqual({ orgId: on.orgId, locationId: on.locationId });
    expect(scopeForWeeklyRefresh(found[0] ?? { orgId: '', locationId: '' }).orgId).toBe(found[0]?.orgId);
  });

  it('finds live scheduled calibrations, stale starting rows and the weekly cap’s count across organizations', async () => {
    const calibrations = createCalibrationStore(server.connection);
    const weeks = createForecastWeekStore(server.connection);
    const a = await tenant();
    const b = await tenant();
    const now = server.clock.now();
    const queue = (t: Tenant, requestedBy: CalibrationRequester) => calibrations.insertQueued(t.scope, {
      id: new Types.ObjectId().toHexString(), locationId: t.locationId, requestedBy, regimeStart: null, championRunId: null,
      tokenExpiresAt: new Date(now.getTime() + 20 * MINUTE), now,
    });
    const scheduled = await queue(a, SYSTEM);
    await queue(b, { userId: 'admin-1', role: 'org_admin', via: 'chat' });
    expect(await liveScheduledCalibrations(server.connection)).toEqual([
      { id: scheduled?.id, orgId: a.orgId, locationId: a.locationId, requestedAt: now },
    ]);
    await calibrations.finish(a.scope, scheduled?.id ?? '', { status: 'failed', failure: 'timeout' }, now);
    expect(await liveScheduledCalibrations(server.connection)).toEqual([]);

    await weeks.insert(a.scope, { locationId: a.locationId, week: WEEK, status: 'starting', dataSha256: null, now });
    await weeks.insert(b.scope, { locationId: b.locationId, week: WEEK, status: 'started', dataSha256: null, now });
    await weeks.insert(b.scope, { locationId: b.locationId, week: '2026-06-08', status: 'starting', dataSha256: null, now });
    const patio = await addLocation(server, { orgId: b.orgId, name: 'Patio' });
    await weeks.insert(b.scope, { locationId: patio, week: WEEK, status: 'unchanged', dataSha256: null, now });
    expect(await countedWeekRows(server.connection, WEEK)).toBe(2);
    expect(await staleStartingWeeks(server.connection, now)).toEqual([]);
    const stale = await staleStartingWeeks(server.connection, new Date(now.getTime() + 1));
    expect(stale.map((row) => [row.orgId, row.locationId]).sort()).toEqual([[a.orgId, a.locationId], [b.orgId, b.locationId]].sort());
  });

  it('a week compares with the newest calibration whose gate judged its own data, and finds a system start after a time', async () => {
    const calibrations = createCalibrationStore(server.connection);
    const t = await tenant();
    let at = server.clock.now().getTime();
    const make = async (gate: { published: boolean; reason: string } | null, outcome: 'succeeded' | 'failed', requestedBy: CalibrationRequester = SYSTEM) => {
      at += MINUTE;
      const record = await calibrations.insertQueued(t.scope, {
        id: new Types.ObjectId().toHexString(), locationId: t.locationId, requestedBy, regimeStart: null, championRunId: null,
        tokenExpiresAt: new Date(at + 20 * MINUTE), now: new Date(at),
      });
      const id = record?.id ?? '';
      await calibrations.markRunning(t.scope, id, { now: new Date(at), imageDigest: null });
      if (gate !== null) await calibrations.recordGate(t.scope, id, gate);
      await calibrations.finish(t.scope, id, outcome === 'succeeded' ? { status: 'succeeded' } : { status: 'failed', failure: 'timeout' }, new Date(at));
      return id;
    };
    expect(await calibrations.reference(t.scope, t.locationId)).toBeNull();
    const held = await make({ published: false, reason: 'refresh_worse' }, 'succeeded');
    expect((await calibrations.reference(t.scope, t.locationId))?.id).toBe(held);
    await make({ published: false, reason: 'forecasts_off' }, 'succeeded');
    await make({ published: false, reason: 'champion_changed' }, 'succeeded');
    await make(null, 'failed');
    expect((await calibrations.reference(t.scope, t.locationId))?.id).toBe(held);
    const published = await make({ published: true, reason: 'refreshed' }, 'succeeded', { userId: 'admin-1', role: 'org_admin', via: 'chat' });
    expect((await calibrations.reference(t.scope, t.locationId))?.id).toBe(published);
    const other = await tenant();
    expect(await calibrations.reference(other.scope, t.locationId)).toBeNull();

    expect((await calibrations.scheduledSince(t.scope, t.locationId, new Date(at)))).toBeNull();
    const latestSystem = await make(null, 'failed');
    expect((await calibrations.scheduledSince(t.scope, t.locationId, new Date(at)))?.id).toBe(latestSystem);
  });
});
