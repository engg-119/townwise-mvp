// GET /api/org/locations/:locationId/sales/history (spec 10.10): every stored day, oldest first, in columns, each
// naming the upload that last wrote it and (F1) the stored file that upload was read from; members read it, view-as
// reads are logged with ids only and see no file name, and no figure or file name reaches a log line.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { SalesHistory } from '../src/handlers/sales.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { NO_COVERAGE } from '../src/stores/sales-days.ts';
import { addGrant, addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { filesPath, seedReadFile, uploadFile } from './helpers/files.ts';
import {
  call, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

let server: TownwiseTestServer;

interface Team { orgId: string; admin: TestSession; adminEmail: string; member: TestSession; memberEmail: string }

let team: Team;

async function newTeam(name: string, on: TownwiseTestServer = server): Promise<Team> {
  const orgId = await createOrg(on, { name });
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(on, adminEmail);
  const member = await signIn(on, memberEmail);
  await addSeat(on, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(on, { orgId, userId: member.userId, email: memberEmail });
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

function history(locationId: string, session: TestSession = team.member, on: TownwiseTestServer = server): Promise<Response> {
  return call(on, `/api/org/locations/${locationId}/sales/history`, { session });
}

async function upload(
  locationId: string, session: TestSession, days: { date: string; guests: number | null; netSalesCents: number | null }[], on: TownwiseTestServer = server,
): Promise<string> {
  const res = await call(on, `/api/org/locations/${locationId}/sales/uploads`, { session, json: { days } });
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

describe('while stored files are off', () => {
  it('names no file, even for an upload a stored file says it wrote', async () => {
    const locationId = await newLocation();
    const uploadId = await upload(locationId, team.admin, [{ date: '2026-05-01', guests: 40, netSalesCents: null }]);
    const fileId = await seedReadFile(server, createMemoryFileBlobs(), {
      orgId: team.orgId, locationId, uploadedBy: team.admin.userId, name: 'stored.csv', raw: Buffer.from('z'), clean: 'date\r\n',
    });
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(fileId) }, { $set: { uploadId: new Types.ObjectId(uploadId) } });
    const body = await (await history(locationId)).json() as SalesHistory;
    expect(body.uploads.map((each) => each.file)).toEqual([null]);
  });
});

// F1 (storage2.md 16.2): an upload the file reader wrote names its stored file, for the day panel's "Where it came
// from". A browser upload names none, a deleted file is gone from it, and view-as sees the kind but never the name.
// Its server, with stored files on, drops the shared test database when it starts, so this block runs last.
describe('the stored file an upload was read from', () => {
  const FILE_NAME = 'day-level.csv';
  let files: TownwiseTestServer;
  let blobs: MemoryFileBlobs;
  let kitchen: Team;

  beforeAll(async () => {
    blobs = createMemoryFileBlobs();
    files = await startTownwiseServer({ files: blobs, reader: {} });
    kitchen = await newTeam('Files Kitchen', files);
  });
  afterAll(async () => { await files.close(); });
  beforeEach(async () => { await files.redis.flushdb(); });
  afterEach(async () => { await removeStaffFactor(files); });

  async function read(locationId: string): Promise<string> {
    const bytes = readFileSync(join(import.meta.dirname, 'fixtures', 'sales-files', FILE_NAME));
    const done = await uploadFile(files, locationId, kitchen.member, FILE_NAME, bytes);
    expect(done.status).toBe(200);
    const fileId = done.body.file?.id ?? '';
    const importId = (done.body.import as { id: string }).id;
    expect((await call(files, `/api/org/locations/${locationId}/imports/${importId}/start`, { session: kitchen.member, json: {} })).status).toBe(202);
    await files.reader?.settled();
    return fileId;
  }

  async function uploadsOf(locationId: string, session: TestSession = kitchen.member): Promise<SalesHistory['uploads']> {
    const res = await history(locationId, session, files);
    expect(res.status).toBe(200);
    return (await res.json() as SalesHistory).uploads;
  }

  it('names the file the reader wrote days from, gives a browser upload none, and drops a deleted file', async () => {
    const locationId = await addLocation(files, { orgId: kitchen.orgId, name: `Room ${randomUUID().slice(0, 6)}` });
    const fileId = await read(locationId);
    files.clock.advance(MINUTE);
    const browser = await upload(locationId, kitchen.admin, [{ date: '2026-05-01', guests: 40, netSalesCents: null }], files);
    files.logs.length = 0;
    const uploads = await uploadsOf(locationId);
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toMatchObject({ id: browser, file: null });
    expect(uploads[1]?.file).toEqual({ id: fileId, name: FILE_NAME, kind: 'text' });
    expect(files.logs.join('\n')).not.toContain(FILE_NAME);

    expect((await call(files, filesPath(locationId, `/${fileId}`), { session: kitchen.member, method: 'DELETE' })).status).toBe(200);
    const after = await uploadsOf(locationId);
    // The file's days stay, so its upload is still listed, now with no file.
    expect(after.map((each) => each.file)).toEqual([null, null]);
  });

  it('gives the kind but never the name during view-as', async () => {
    const locationId = await addLocation(files, { orgId: kitchen.orgId, name: `Room ${randomUUID().slice(0, 6)}` });
    const fileId = await read(locationId);
    const staff = await signInStaff(files);
    await addGrant(files, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: kitchen.member.userId, orgId: kitchen.orgId });
    files.logs.length = 0;
    const uploads = await uploadsOf(locationId, staff);
    expect(uploads.map((each) => each.file)).toEqual([{ id: fileId, name: null, kind: 'text' }]);
    expect(files.logs.join('\n')).not.toContain(FILE_NAME);
  });

  it('finds a file past the first page of the location’s files', async () => {
    const locationId = await addLocation(files, { orgId: kitchen.orgId, name: `Room ${randomUUID().slice(0, 6)}` });
    const uploadId = await upload(locationId, kitchen.admin, [{ date: '2026-05-01', guests: 40, netSalesCents: null }], files);
    const fileId = await seedReadFile(files, blobs, {
      orgId: kitchen.orgId, locationId, uploadedBy: kitchen.admin.userId, name: 'oldest.csv', raw: Buffer.from('z'), clean: 'date\r\n',
    });
    const rows = files.connection.collection('tw_files');
    await rows.updateOne({ _id: new Types.ObjectId(fileId) }, { $set: { uploadId: new Types.ObjectId(uploadId) } });
    // 100 newer files, read from no upload of this location, fill the first page.
    const seeded = await rows.findOne({ _id: new Types.ObjectId(fileId) });
    if (seeded === null) throw new Error('no seeded file');
    await rows.insertMany(Array.from({ length: 100 }, (_, index) => ({
      ...seeded, _id: new Types.ObjectId(), name: `newer-${String(index)}.csv`, uploadId: new Types.ObjectId(),
    })));
    const uploads = await uploadsOf(locationId);
    expect(uploads.map((each) => each.file)).toEqual([{ id: fileId, name: 'oldest.csv', kind: 'text' }]);
  });
});
