// Forecast runs from the staff console (spec 10.13, 14.4): import as a draft, the same file again, an unfinished
// import finished by a retry, publish and withdraw by compare-and-set, delete, staff-only routes, another
// organization's ids answering 404, audit events with no figure that the org's admins see in their staff activity,
// log lines with ids and counts only, and the runs deleted with the organization, the location and its sales data,
// with staff ids cleared on person deletion. The fixture's numbers are synthetic.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { StaffActivityView } from '../src/audit.ts';
import type { StaffForecastRunView } from '../src/handlers/forecast-runs.ts';
import { addLocation, addSalesDay, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { call, signIn, signInStaff, STAFF_EMAIL, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const FIXTURE = JSON.parse(readFileSync(new URL('fixtures/forecast-run.json', import.meta.url), 'utf8')) as Record<string, unknown>;
/** The run file's days and weeks: 14 and 3. */
const ROWS = 17;

let server: TownwiseTestServer;
let staff: TestSession;

beforeAll(async () => {
  server = await startTownwiseServer();
  staff = await signInStaff(server);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

interface Team { orgId: string; locationId: string; admin: TestSession }

async function team(name = `Forecast Kitchen ${randomUUID().slice(0, 6)}`): Promise<Team> {
  const orgId = await createOrg(server, { name });
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, email);
  await addSeat(server, { orgId, userId: admin.userId, email, role: 'org_admin' });
  const locationId = await addLocation(server, { orgId, name: 'Hanover Room' });
  return { orgId, locationId, admin };
}

function withMadeAt(madeAt: string): Record<string, unknown> {
  return { ...structuredClone(FIXTURE), madeAt };
}

async function importRun(t: Pick<Team, 'orgId' | 'locationId'>, body: unknown = FIXTURE, session = staff): Promise<Response> {
  return call(server, `/api/admin/orgs/${t.orgId}/locations/${t.locationId}/forecast-runs`, { session, json: body });
}

async function imported(t: Team, body: unknown = FIXTURE): Promise<StaffForecastRunView> {
  const res = await importRun(t, body);
  expect(res.status).toBe(201);
  return (await res.json() as { run: StaffForecastRunView }).run;
}

function change(t: Pick<Team, 'orgId'>, runId: string, verb: 'publish' | 'withdraw', session = staff): Promise<Response> {
  return call(server, `/api/admin/orgs/${t.orgId}/forecast-runs/${runId}/${verb}`, { session, json: {} });
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

describe('import', () => {
  it('imports a run file as a draft with its model, dates and counts, and records it with no figure', async () => {
    const t = await team();
    server.logs.length = 0;
    const run = await imported(t);
    expect(run).toMatchObject({
      metric: 'guests', model: { family: 'hybrid_linear_xgboost', version: 'v9', label: 'Townwise demand model v9' },
      trainingSource: 'files_from_owner', trainedFrom: '2025-01-01', dataThrough: '2026-04-30', madeAt: '2026-05-01', frozen: false,
      interval: { level: 0.8, widened: true }, locationId: t.locationId, status: 'draft', range: { from: '2026-05-01', to: '2026-05-14' },
      dayCount: 14, weekCount: 3, publishedAt: null, withdrawnAt: null, importedByEmail: STAFF_EMAIL,
    });
    expect(await count('tw_forecasts', { runId: new Types.ObjectId(run.id) })).toBe(ROWS);
    const events = (await auditEvents(server)).filter((event) => event.action === 'forecast.imported');
    expect(events.at(-1)).toMatchObject({
      actorRole: 'superadmin', target: { type: 'forecast_run', id: run.id },
      details: { locationId: t.locationId, modelVersion: 'v9', from: '2026-05-01', to: '2026-05-14', dayCount: 14 },
    });
    const own = server.logs.filter((line) => line.includes('townwise.forecast'));
    expect(own).toHaveLength(1);
    expect(JSON.parse(own[0] ?? '{}')).toMatchObject({ orgId: t.orgId, locationId: t.locationId, runId: run.id, days: 14, weeks: 3 });
    expect(server.logs.join('\n')).not.toMatch(/"(low|mid|high|guests|baseline)"/);
  });

  it('answers 200 with the same run, writing nothing, for the same file again (whatever its key order)', async () => {
    const t = await team();
    const run = await imported(t);
    const before = (await auditEvents(server)).length;
    const again = await importRun(t, Object.fromEntries(Object.entries(FIXTURE).reverse()));
    expect(again.status).toBe(200);
    expect((await again.json() as { run: StaffForecastRunView }).run).toMatchObject({ id: run.id, status: 'draft' });
    expect((await auditEvents(server)).length).toBe(before);
    expect(await count('tw_forecast_runs', { orgId: new Types.ObjectId(t.orgId) })).toBe(1);
  });

  it('finishes an import a crash left unfinished when the same file is imported again', async () => {
    const t = await team();
    const run = await imported(t);
    const runId = new Types.ObjectId(run.id);
    await server.connection.collection('tw_forecast_runs').updateOne({ _id: runId }, { $set: { status: 'importing' } });
    await server.connection.collection('tw_forecasts').deleteMany({ runId, span: 'week' });
    // An unfinished import is invisible to staff publishing it.
    expect((await change(t, run.id, 'publish')).status).toBe(409);
    const res = await importRun(t);
    expect(res.status).toBe(201);
    expect((await res.json() as { run: StaffForecastRunView }).run).toMatchObject({ id: run.id, status: 'draft' });
    expect(await count('tw_forecasts', { runId })).toBe(ROWS);
  });

  it('answers 400 invalid_forecast_file with paths and codes only, and writes nothing', async () => {
    const t = await team();
    const bad = structuredClone(FIXTURE) as Record<string, unknown> & { days: Record<string, unknown>[] };
    const tuesday = bad.days[1];
    if (tuesday !== undefined) tuesday.high = 50;
    bad.sentinelGuestName = 'Sentinel Guest';
    const before = (await auditEvents(server)).length;
    const res = await importRun(t, bad);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; issues: { path: string; code: string }[] };
    expect(body.error).toBe('invalid_forecast_file');
    expect(body.issues).toEqual([{ path: '', code: 'unrecognized_keys' }]);
    expect(JSON.stringify(body)).not.toMatch(/Sentinel|sentinelGuestName/);
    delete bad.sentinelGuestName;
    const second = await (await importRun(t, bad)).json() as { issues: unknown[] };
    expect(second.issues).toEqual([{ path: 'days[1].high', code: 'below_mid' }]);
    expect((await auditEvents(server)).length).toBe(before);
    expect(await count('tw_forecast_runs', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
  });

  it('keeps a reason’s calendar ref only when it names an entry on that day', async () => {
    const t = await team();
    const run = await imported(t);
    const rows = await server.connection.collection('tw_forecasts').find({ runId: new Types.ObjectId(run.id), span: 'day' }).toArray();
    const refs = rows.flatMap((row) => (row.reasons as { ref: string | null }[]).map((reason) => reason.ref));
    expect(refs).toContain('hanover-nh:classes:spring');
    expect(refs).not.toContain('hanover-nh:not-on-the-calendar');
  });

  it('answers 404 for another organization’s location, an unknown one and an unknown organization', async () => {
    const t = await team();
    const other = await team();
    for (const target of [
      { orgId: t.orgId, locationId: other.locationId }, { orgId: t.orgId, locationId: new Types.ObjectId().toHexString() },
      { orgId: new Types.ObjectId().toHexString(), locationId: t.locationId },
    ]) {
      expect((await importRun(target)).status).toBe(404);
    }
    expect(await count('tw_forecast_runs', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
  });
});

describe('publish, withdraw and delete', () => {
  it('publishes a draft once, records it, and answers 200 to a repeat with nothing written', async () => {
    const t = await team();
    const run = await imported(t);
    const res = await change(t, run.id, 'publish');
    expect(res.status).toBe(200);
    const published = (await res.json() as { run: StaffForecastRunView }).run;
    expect(published).toMatchObject({ id: run.id, status: 'published', publishedAt: server.clock.now().toISOString() });
    const before = (await auditEvents(server)).length;
    expect((await change(t, run.id, 'publish')).status).toBe(200);
    expect((await auditEvents(server)).length).toBe(before);
    const doc = await server.connection.collection('tw_forecast_runs').findOne({ _id: new Types.ObjectId(run.id) });
    expect(doc).toMatchObject({ publishedBy: staff.userId, importedBy: staff.userId });
  });

  it('withdraws a draft or a published run; a withdrawn run cannot be published again', async () => {
    const t = await team();
    const run = await imported(t);
    expect((await change(t, run.id, 'publish')).status).toBe(200);
    const res = await change(t, run.id, 'withdraw');
    expect(res.status).toBe(200);
    expect((await res.json() as { run: StaffForecastRunView }).run).toMatchObject({ status: 'withdrawn' });
    expect((await change(t, run.id, 'withdraw')).status).toBe(200);
    const again = await change(t, run.id, 'publish');
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'forecast_run_not_draft' });
    const draft = await imported(t, withMadeAt('2026-05-02'));
    expect((await (await change(t, draft.id, 'withdraw')).json() as { run: StaffForecastRunView }).run.status).toBe('withdrawn');
  });

  it('deletes the rows, then the run, and answers 404 after', async () => {
    const t = await team();
    const run = await imported(t);
    const path = `/api/admin/orgs/${t.orgId}/forecast-runs/${run.id}`;
    expect((await call(server, path, { method: 'DELETE', session: staff })).status).toBe(204);
    expect(await count('tw_forecasts', { runId: new Types.ObjectId(run.id) })).toBe(0);
    expect(await count('tw_forecast_runs', { _id: new Types.ObjectId(run.id) })).toBe(0);
    expect((await call(server, path, { method: 'DELETE', session: staff })).status).toBe(404);
    expect((await change(t, run.id, 'publish')).status).toBe(404);
  });

  it('answers 404 for another organization’s run through this organization’s path', async () => {
    const t = await team();
    const other = await team();
    const theirs = await imported(other);
    expect((await change(t, theirs.id, 'publish')).status).toBe(404);
    expect((await call(server, `/api/admin/orgs/${t.orgId}/forecast-runs/${theirs.id}`, { method: 'DELETE', session: staff })).status).toBe(404);
    const doc = await server.connection.collection('tw_forecast_runs').findOne({ _id: new Types.ObjectId(theirs.id) });
    expect(doc?.status).toBe('draft');
  });

  it('lists the organization’s runs newest first, never another’s', async () => {
    const t = await team();
    const first = await imported(t);
    server.clock.advance(1000);
    const second = await imported(t, withMadeAt('2026-05-02'));
    await imported(await team());
    const res = await call(server, `/api/admin/orgs/${t.orgId}/forecast-runs`, { session: staff });
    expect(res.status).toBe(200);
    const { runs } = await res.json() as { runs: StaffForecastRunView[] };
    expect(runs.map((run) => run.id)).toEqual([second.id, first.id]);
    expect(JSON.stringify(runs)).not.toMatch(/"(low|mid|high|days)":/);
  });
});

describe('who can', () => {
  it('refuses every staff route to an org admin (403)', async () => {
    const t = await team();
    const run = await imported(t);
    const routes: [string, string, unknown][] = [
      ['GET', `/api/admin/orgs/${t.orgId}/forecast-runs`, undefined],
      ['POST', `/api/admin/orgs/${t.orgId}/locations/${t.locationId}/forecast-runs`, FIXTURE],
      ['POST', `/api/admin/orgs/${t.orgId}/forecast-runs/${run.id}/publish`, {}],
      ['POST', `/api/admin/orgs/${t.orgId}/forecast-runs/${run.id}/withdraw`, {}],
      ['DELETE', `/api/admin/orgs/${t.orgId}/forecast-runs/${run.id}`, undefined],
    ];
    for (const [method, path, json] of routes) {
      const res = await call(server, path, { method, session: t.admin, ...(json === undefined ? {} : { json }) });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
    expect((await server.connection.collection('tw_forecast_runs').findOne({ _id: new Types.ObjectId(run.id) }))?.status).toBe('draft');
  });

  it('shows every import, publish, withdrawal and deletion in the org’s staff activity, with no figure', async () => {
    const t = await team();
    const run = await imported(t);
    await change(t, run.id, 'publish');
    await change(t, run.id, 'withdraw');
    await call(server, `/api/admin/orgs/${t.orgId}/forecast-runs/${run.id}`, { method: 'DELETE', session: staff });
    const { events } = await (await call(server, '/api/org/staff-activity', { session: t.admin })).json() as { events: StaffActivityView[] };
    expect(events.map((event) => event.summary)).toEqual([
      'Deleted a forecast (model v9) for 2026-05-01 to 2026-05-14',
      'Withdrew a forecast (model v9) for 2026-05-01 to 2026-05-14',
      'Published a forecast (model v9) for 2026-05-01 to 2026-05-14',
      'Imported a forecast (model v9) for 2026-05-01 to 2026-05-14',
    ]);
    expect(events.every((event) => event.staffEmail === STAFF_EMAIL && event.applied)).toBe(true);
  });
});

describe('deletion', () => {
  it('deleting the location’s sales data deletes its forecasts', async () => {
    const t = await team();
    const run = await imported(t);
    await addSalesDay(server, { orgId: t.orgId, locationId: t.locationId, date: '2026-05-01', guests: 90, netSalesCents: 100_000 });
    const res = await call(server, `/api/org/locations/${t.locationId}/sales`, { method: 'DELETE', session: t.admin });
    expect(res.status).toBe(200);
    expect(await count('tw_forecast_runs', { _id: new Types.ObjectId(run.id) })).toBe(0);
    expect(await count('tw_forecasts', { runId: new Types.ObjectId(run.id) })).toBe(0);
  });

  it('deleting a location with no sales data deletes the forecasts imported for it', async () => {
    const t = await team();
    const run = await imported(t);
    expect((await call(server, `/api/org/locations/${t.locationId}`, { method: 'DELETE', session: t.admin })).status).toBe(204);
    expect(await count('tw_forecast_runs', { _id: new Types.ObjectId(run.id) })).toBe(0);
    expect(await count('tw_forecasts', { runId: new Types.ObjectId(run.id) })).toBe(0);
  });

  it('deleting the organization deletes its runs and rows, and leaves another organization’s', async () => {
    const t = await team();
    const kept = await team();
    await imported(t);
    const keptRun = await imported(kept);
    expect((await call(server, `/api/admin/orgs/${t.orgId}`, { method: 'PATCH', session: staff, json: { status: 'suspended' } })).status).toBe(200);
    expect((await call(server, `/api/admin/orgs/${t.orgId}`, { method: 'DELETE', session: staff })).status).toBe(200);
    expect(await count('tw_forecast_runs', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
    expect(await count('tw_forecasts', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
    expect(await count('tw_forecasts', { runId: new Types.ObjectId(keptRun.id) })).toBe(ROWS);
  });

  it('deleting a person clears their staff id from the runs they imported or published', async () => {
    const t = await team();
    const run = await imported(t);
    await change(t, run.id, 'publish');
    // A former staff member (no longer in TOWNWISE_SUPERADMIN_EMAILS), so the console can delete them.
    const formerEmail = `former-staff-${randomUUID().slice(0, 8)}@example.test`;
    const former = await signIn(server, formerEmail);
    await server.connection.collection('tw_forecast_runs').updateOne(
      { _id: new Types.ObjectId(run.id) }, { $set: { importedBy: former.userId, publishedBy: former.userId } },
    );
    const res = await call(server, '/api/admin/people/delete', { session: staff, json: { email: formerEmail } });
    expect(res.status).toBe(200);
    const doc = await server.connection.collection('tw_forecast_runs').findOne({ _id: new Types.ObjectId(run.id) });
    expect(doc).toMatchObject({ importedBy: null, publishedBy: null, status: 'published' });
    const list = await (await call(server, `/api/admin/orgs/${t.orgId}/forecast-runs`, { session: staff })).json() as { runs: StaffForecastRunView[] };
    expect(list.runs[0]?.importedByEmail).toBeNull();
  });
});
