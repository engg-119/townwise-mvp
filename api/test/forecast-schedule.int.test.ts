// The weekly refresh's staff pause and what the console reads of it (D42): POST /api/admin/forecast-schedule is staff
// only and audited before the effect with no organization; the next pass starts nothing while it is paused; the
// calibrations list carries the schedule's state and each location's latest week row. Every number is synthetic.
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createForecastSchedule } from '../src/lab/schedule.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { fakeLabRunner, seedHistory, type FakeLabRunner } from './helpers/lab.ts';
import { call, signIn, signInStaff, STAFF_EMAIL, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

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
  for (const name of ['tw_orgs', 'tw_locations', 'tw_sales_days', 'tw_calibrations', 'tw_forecast_weeks', 'tw_forecast_schedule', 'tw_audit_events']) {
    await server.connection.collection(name).deleteMany({});
  }
});

function setSchedule(body: unknown, session = staff): Promise<Response> {
  return call(server, '/api/admin/forecast-schedule', { session, json: body });
}

async function place(): Promise<{ orgId: string; locationId: string; admin: TestSession }> {
  const orgId = await createOrg(server, { name: `Pause Kitchen ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  await seedHistory(server, { orgId, locationId, from: '2025-08-01', to: '2026-05-31' });
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, email);
  await addSeat(server, { orgId, userId: admin.userId, email, role: 'org_admin' });
  return { orgId, locationId, admin };
}

function schedulePass() {
  return createForecastSchedule({ ctx: server.ctx }).pass();
}

describe('the staff pause', () => {
  it('is staff only and refuses anything but { paused: boolean }, writing nothing', async () => {
    const p = await place();
    expect((await setSchedule({ paused: true }, p.admin)).status).toBe(403);
    for (const body of [{}, { paused: 'yes' }, { paused: true, extra: 1 }]) expect((await setSchedule(body)).status).toBe(400);
    expect(await server.ctx.stores.forecastSchedule.paused()).toBeNull();
    expect((await auditEvents(server)).filter((event) => String(event.action).startsWith('forecast_schedule.'))).toEqual([]);
  });

  it('pauses every scheduled start from the next pass, audited before the effect, and resumes', async () => {
    const p = await place();
    const jobs = runner.jobs.length;
    const res = await setSchedule({ paused: true });
    const at = server.clock.now().toISOString();
    expect({ status: res.status, body: await res.json() as unknown }).toEqual({
      status: 200, body: { schedule: { running: true, paused: { at, email: STAFF_EMAIL } } },
    });
    expect((await auditEvents(server)).filter((event) => event.action === 'forecast_schedule.paused')).toEqual([expect.objectContaining({
      actorRole: 'superadmin', actorEmail: STAFF_EMAIL, orgId: null, target: { type: 'forecast_schedule', id: 'weekly' }, details: {},
    })]);
    expect(await schedulePass()).toMatchObject({ state: 'paused', started: 0 });
    expect(runner.jobs.length).toBe(jobs);
    // Already paused: nothing recorded again.
    expect((await setSchedule({ paused: true })).status).toBe(200);
    expect((await auditEvents(server)).filter((event) => event.action === 'forecast_schedule.paused')).toHaveLength(1);

    const resumed = await setSchedule({ paused: false });
    expect(await resumed.json()).toEqual({ schedule: { running: true, paused: null } });
    expect((await auditEvents(server)).filter((event) => event.action === 'forecast_schedule.resumed')).toHaveLength(1);
    expect(await schedulePass()).toMatchObject({ state: 'ran', started: 1 });
    expect(runner.jobs.length).toBe(jobs + 1);

    // The console reads the schedule and the location's week row with its calibrations.
    const list = await call(server, `/api/admin/orgs/${p.orgId}/calibrations`, { session: staff });
    const body = await list.json() as { forecasts: unknown; schedule: unknown; weeks: unknown; calibrations: { id: string; via: string }[] };
    expect(body.forecasts).toEqual({ on: true, at: null });
    expect(body.schedule).toEqual({ running: true, paused: null });
    expect(body.weeks).toEqual([{ locationId: p.locationId, week: '2026-06-01', outcome: 'started', calibrationId: runner.jobs.at(-1)?.calibrationId }]);
    expect(body.calibrations[0]).toMatchObject({ id: runner.jobs.at(-1)?.calibrationId, via: 'scheduled' });
  });
});
