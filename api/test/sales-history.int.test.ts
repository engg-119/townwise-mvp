// GET /api/org/locations/:locationId/sales/history (spec 10.10): every stored day, oldest first, in columns, each
// naming the upload that last wrote it; members read it, view-as reads are logged with ids only, and no figure
// reaches a log line.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SalesHistory } from '../src/handlers/sales.ts';
import { NO_COVERAGE } from '../src/stores/sales-days.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import {
  call, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;

interface Team { orgId: string; admin: TestSession; adminEmail: string; member: TestSession; memberEmail: string }

let team: Team;

async function newTeam(name: string): Promise<Team> {
  const orgId = await createOrg(server, { name });
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, adminEmail);
  const member = await signIn(server, memberEmail);
  await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(server, { orgId, userId: member.userId, email: memberEmail });
  return { orgId, admin, adminEmail, member, memberEmail };
}

beforeAll(async () => {
  server = await startTownwiseServer();
  team = await newTeam('History Kitchen');
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

function newLocation(orgId = team.orgId): Promise<string> {
  return addLocation(server, { orgId, name: `Room ${randomUUID().slice(0, 6)}` });
}

function history(locationId: string, session: TestSession = team.member): Promise<Response> {
  return call(server, `/api/org/locations/${locationId}/sales/history`, { session });
}

async function upload(locationId: string, session: TestSession, days: { date: string; guests: number | null; netSalesCents: number | null }[]): Promise<string> {
  const res = await call(server, `/api/org/locations/${locationId}/sales/uploads`, { session, json: { days } });
  expect(res.status).toBe(201);
  return (await res.json() as { upload: { id: string } }).upload.id;
}

/** A day written straight to tw_sales_days, naming an upload that has no record. */
async function addOrphanDay(locationId: string, date: string): Promise<void> {
  await server.connection.collection('tw_sales_days').insertOne({
    orgId: new Types.ObjectId(team.orgId), locationId: new Types.ObjectId(locationId), date, guests: 7, netSalesCents: null,
    uploadId: new Types.ObjectId(), updatedAt: server.clock.now(),
  });
}

describe('GET /api/org/locations/:locationId/sales/history', () => {
  it('answers every day oldest first in columns of equal length, each naming the upload that last wrote it, newest upload first', async () => {
    const locationId = await newLocation();
    const firstAt = server.clock.now();
    const first = await upload(locationId, team.admin, [
      { date: '2026-05-03', guests: 120, netSalesCents: 410_000 },
      { date: '2026-05-01', guests: 101, netSalesCents: 350_050 },
      { date: '2026-05-02', guests: null, netSalesCents: 360_000 },
    ]);
    server.clock.advance(MINUTE);
    const secondAt = server.clock.now();
    // The admin's second upload replaces 05-03 and adds 05-04.
    const second = await upload(locationId, team.admin, [
      { date: '2026-05-03', guests: 125, netSalesCents: null },
      { date: '2026-05-04', guests: 90, netSalesCents: 300_000 },
    ]);
    server.clock.advance(MINUTE);
    const thirdAt = server.clock.now();
    // The member's upload adds 05-05 only; 05-04 is kept as it was.
    const third = await upload(locationId, team.member, [
      { date: '2026-05-04', guests: 1, netSalesCents: 1 },
      { date: '2026-05-05', guests: 80, netSalesCents: 280_000 },
    ]);

    const res = await history(locationId);
    expect(res.status).toBe(200);
    const body = await res.json() as SalesHistory;
    expect(body.days).toEqual({
      date: ['2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05'],
      guests: [101, null, 125, 90, 80],
      netSalesCents: [350_050, 360_000, null, 300_000, 280_000],
      upload: [2, 2, 1, 1, 0],
    });
    expect(body.uploads).toEqual([
      { id: third, uploadedAt: thirdAt.toISOString(), uploadedByEmail: team.memberEmail, status: 'applied', firstDate: '2026-05-04', lastDate: '2026-05-05', file: null },
      { id: second, uploadedAt: secondAt.toISOString(), uploadedByEmail: team.adminEmail, status: 'applied', firstDate: '2026-05-03', lastDate: '2026-05-04', file: null },
      { id: first, uploadedAt: firstAt.toISOString(), uploadedByEmail: team.adminEmail, status: 'applied', firstDate: '2026-05-01', lastDate: '2026-05-03', file: null },
    ]);
    expect(body.coverage).toEqual({
      dayCount: 5, guestsDayCount: 4, netSalesDayCount: 4, firstDate: '2026-05-01', lastDate: '2026-05-05', missingDays: 0,
    });
  });

  it('answers exactly the contract’s keys, at every level', async () => {
    const locationId = await newLocation();
    await upload(locationId, team.admin, [{ date: '2026-05-01', guests: 50, netSalesCents: 100_000 }]);
    const body = await (await history(locationId, team.admin)).json() as SalesHistory;
    expect(Object.keys(body).sort()).toEqual(['coverage', 'days', 'uploads']);
    expect(Object.keys(body.days).sort()).toEqual(['date', 'guests', 'netSalesCents', 'upload']);
    expect(Object.keys(body.uploads[0] ?? {}).sort()).toEqual(['file', 'firstDate', 'id', 'lastDate', 'status', 'uploadedAt', 'uploadedByEmail']);
  });

  it('answers empty columns, no uploads and no coverage for a location with no days', async () => {
    const body = await (await history(await newLocation())).json() as SalesHistory;
    expect(body).toEqual({ coverage: NO_COVERAGE, days: { date: [], guests: [], netSalesCents: [], upload: [] }, uploads: [] });
  });

  it('gives a day whose upload has no record the index -1, and lists only uploads that exist', async () => {
    const locationId = await newLocation();
    const uploadId = await upload(locationId, team.admin, [{ date: '2026-05-02', guests: 60, netSalesCents: null }]);
    await addOrphanDay(locationId, '2026-05-01');
    const body = await (await history(locationId)).json() as SalesHistory;
    expect(body.days.upload).toEqual([-1, 0]);
    expect(body.uploads.map((u) => u.id)).toEqual([uploadId]);
  });

  it('names an uploader whose user no longer exists “Deleted person”', async () => {
    const locationId = await newLocation();
    const gone = await signIn(server, `gone-${randomUUID().slice(0, 8)}@example.test`);
    await addSeat(server, { orgId: team.orgId, userId: gone.userId, email: 'gone@example.test' });
    await upload(locationId, gone, [{ date: '2026-05-01', guests: 30, netSalesCents: null }]);
    await server.connection.collection('users').deleteOne({ _id: new Types.ObjectId(gone.userId) });
    const body = await (await history(locationId)).json() as SalesHistory;
    expect(body.uploads.map((u) => u.uploadedByEmail)).toEqual(['Deleted person']);
  });

  it('answers 404 for another organization’s location and an unknown id, and 400 for a malformed id', async () => {
    const other = await newTeam('Other Kitchen');
    const theirs = await newLocation(other.orgId);
    await upload(theirs, other.admin, [{ date: '2026-05-01', guests: 13_579, netSalesCents: 87_654_321 }]);
    for (const id of [theirs, new Types.ObjectId().toHexString()]) {
      const res = await history(id);
      expect(res.status).toBe(404);
      const text = await res.text();
      expect(JSON.parse(text)).toMatchObject({ error: 'not_found' });
      expect(text).not.toContain('13579');
    }
    const malformed = await history('not-an-id');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('puts no figure, date list or email in any log line', async () => {
    const locationId = await newLocation();
    await upload(locationId, team.admin, [{ date: '2026-05-01', guests: 13_579, netSalesCents: 87_654_321 }]);
    server.logs.length = 0;
    expect((await history(locationId)).status).toBe(200);
    const logs = server.logs.join('\n');
    for (const secret of ['13579', '87654321', team.adminEmail, team.memberEmail]) expect(logs).not.toContain(secret);
  });
});

describe('during view-as', () => {
  let staff: TestSession;
  beforeEach(async () => { staff = await signInStaff(server); });
  afterEach(async () => { await removeStaffFactor(server); });

  it('answers 200 with the target’s history and logs townwise.view_as_read with ids only', async () => {
    const locationId = await newLocation();
    await upload(locationId, team.admin, [{ date: '2026-05-01', guests: 13_579, netSalesCents: 87_654_321 }]);
    const started = await call(server, '/api/admin/view-as', { session: staff, json: { userId: team.member.userId, reason: 'Helping with the heatmap' } });
    expect(started.status).toBe(201);
    const grantId = (await started.json() as { viewAs: { id: string } }).viewAs.id;
    server.logs.length = 0;
    const res = await history(locationId, staff);
    expect(res.status).toBe(200);
    expect((await res.json() as SalesHistory).days.guests).toEqual([13_579]);
    const reads = server.logs.filter((line) => line.includes('townwise.view_as_read'));
    expect(reads).toHaveLength(1);
    expect(JSON.parse(reads[0] ?? '{}')).toMatchObject({ grantId, routeId: 'org.sales.history' });
    const logs = server.logs.join('\n');
    for (const secret of ['13579', '87654321', team.memberEmail, team.adminEmail, 'Helping with the heatmap']) expect(logs).not.toContain(secret);
    expect((await call(server, '/api/admin/view-as/end', { session: staff, json: {} })).status).toBe(200);
  });
});
