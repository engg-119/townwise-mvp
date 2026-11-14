// Your data (D28): one list of everything a location received (sales uploads and stored files, newest first), turning
// an upload or a reference item off and on, renaming one, saving an edit of one, and deleting one. Synthetic days and
// files only; no file name, title or figure reaches an audit event.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { summaryOf } from '../src/audit.ts';
import { cleanBlobName, rawBlobName } from '../src/files/blobs.ts';
import { REPLACE_CLAIM_MS, replaceClaimStaleBefore } from '../src/files/items.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import type { DataItemView } from '../src/handlers/data.ts';
import type { SalesHistory } from '../src/handlers/sales.ts';
import { createTownwiseStores } from '../src/stores/index.ts';
import { addGrant, addLocation, addSeat, addUpload, auditEvents, createOrg } from './helpers/fixtures.ts';
import { filesPath, seedReadFile, uploadFile } from './helpers/files.ts';
import {
  call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A JPEG's first bytes: kept as kind `other`. */
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const RAW = Buffer.from('Date,Guests\n', 'utf8');

let server: TownwiseTestServer;
/** The same database with stored files off (FILES_BLOB_ACCOUNT_URL unset). */
let off: TownwiseTestServer;
let blobs: MemoryFileBlobs;

interface Team {
  orgId: string;
  admin: TestSession; adminEmail: string;
  member: TestSession; memberEmail: string;
  /** A second member. */
  other: TestSession; otherEmail: string;
}
let team: Team;

async function newTeam(name: string): Promise<Team> {
  const orgId = await createOrg(server, { name: `${name} ${randomUUID().slice(0, 6)}` });
  const [adminEmail, memberEmail, otherEmail] = ['admin', 'member', 'other'].map((who) => `${who}-${randomUUID().slice(0, 8)}@example.test`) as [string, string, string];
  const admin = await signIn(server, adminEmail);
  const member = await signIn(server, memberEmail);
  const other = await signIn(server, otherEmail);
  await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(server, { orgId, userId: member.userId, email: memberEmail });
  await addSeat(server, { orgId, userId: other.userId, email: otherEmail });
  return { orgId, admin, adminEmail, member, memberEmail, other, otherEmail };
}

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  // Each start drops the database, so both start before any fixture; the second builds the same indexes again.
  off = await startTownwiseServer();
  server = await startTownwiseServer({ files: blobs });
  team = await newTeam('Data Kitchen');
});
afterAll(async () => {
  await server.close();
  await off.close();
});
beforeEach(async () => { await server.redis.flushdb(); });

const scopeOf = (orgId: string): OrgScope => ({ orgId }) as unknown as OrgScope;

function newLocation(orgId = team.orgId): Promise<string> {
  return addLocation(server, { orgId, name: `Room ${randomUUID().slice(0, 6)}` });
}

/** One second later, so the next item is newer. */
function tick(): void {
  server.clock.advance(1000);
}

function plus(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The days from `from` to `to`, inclusive. */
function range(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = plus(day, 1)) out.push(day);
  return out;
}

/** Posts `count` consecutive days from `from` through POST .../sales/uploads; answers the upload's id. */
async function send(session: TestSession, locationId: string, from: string, count: number, on = server): Promise<string> {
  const days = Array.from({ length: count }, (_, i) => ({ date: plus(from, i), guests: 40 + i, netSalesCents: null }));
  const res = await call(on, `/api/org/locations/${locationId}/sales/uploads`, { session, json: { days } });
  expect(res.status).toBe(201);
  return (await res.json() as { upload: { id: string } }).upload.id;
}

/** A stored file that wrote an upload's days, as the reader leaves one: the upload through the route, then its file. */
async function seedReadFileUpload(
  locationId: string, from: string, count: number, session: TestSession = team.admin,
): Promise<{ uploadId: string; fileId: string }> {
  const uploadId = await send(session, locationId, from, count);
  const fileId = await seedReadFile(server, blobs, {
    orgId: team.orgId, locationId, uploadedBy: session.userId, name: 'sales.csv', raw: RAW, clean: 'date,guests,net_sales\r\n',
    uploaderRole: session === team.admin ? 'org_admin' : 'member',
  });
  await server.connection.collection('tw_files').updateOne(
    { _id: new Types.ObjectId(fileId) }, { $set: { uploadId: new Types.ObjectId(uploadId), 'result.uploadId': uploadId } },
  );
  return { uploadId, fileId };
}

/** A tw_files row written straight in (no blobs): by default the member's kept reference text item. */
async function seedFile(locationId: string, over: Record<string, unknown> = {}): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: new Types.ObjectId(team.orgId), locationId: new Types.ObjectId(locationId), importId: null, purpose: 'reference',
    uploadedBy: team.member.userId, uploaderRole: 'member', uploadedAt: server.clock.now(), name: 'notes.txt', kind: 'text',
    sizeBytes: 5, fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference',
    progress: null, readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null,
    rawDeletedAt: null, attempts: 0, ...over,
  });
  return _id.toHexString();
}

interface Page { items: DataItemView[]; next: string | null }

async function list(session: TestSession, query = '', on = server): Promise<Page> {
  const res = await call(on, `/api/org/data${query}`, { session });
  expect(res.status).toBe(200);
  return await res.json() as Page;
}

function itemPath(locationId: string, ref: string): string {
  return `/api/org/locations/${locationId}/data/${ref}`;
}

function patch(session: TestSession, locationId: string, ref: string, json: unknown, on = server): Promise<Response> {
  return call(on, itemPath(locationId, ref), { session, method: 'PATCH', json });
}

async function patched(session: TestSession, locationId: string, ref: string, enabled: boolean, on = server): Promise<DataItemView> {
  const res = await patch(session, locationId, ref, { enabled }, on);
  expect(res.status).toBe(200);
  return (await res.json() as { item: DataItemView }).item;
}

async function del(session: TestSession, locationId: string, ref: string, on = server): Promise<{ status: number; body: unknown }> {
  const res = await call(on, itemPath(locationId, ref), { session, method: 'DELETE' });
  return { status: res.status, body: await res.json() };
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

async function getJson<T>(session: TestSession, path: string): Promise<T> {
  const res = await call(server, path, { session });
  expect(res.status).toBe(200);
  return await res.json() as T;
}

function dayCount(locationId: string): Promise<number> {
  return getJson<{ coverage: { dayCount: number } }>(team.admin, `/api/org/locations/${locationId}/sales`).then((body) => body.coverage.dayCount);
}

async function dates(locationId: string): Promise<string[]> {
  return (await getJson<SalesHistory>(team.admin, `/api/org/locations/${locationId}/sales/history`)).days.date;
}

interface StoredEvent { target: { type: string; id: string }; details: Record<string, string | number | boolean | null> }

async function lastEvent(action: string): Promise<StoredEvent> {
  const found = (await auditEvents(server)).filter((event) => event.action === action).at(-1);
  expect(found).toBeDefined();
  return found as unknown as StoredEvent;
}

function exists(collection: string, id: string): Promise<boolean> {
  return server.connection.collection(collection).countDocuments({ _id: new Types.ObjectId(id) }).then((count) => count === 1);
}

async function renamed(session: TestSession, locationId: string, ref: string, title: string): Promise<DataItemView> {
  const res = await patch(session, locationId, ref, { title });
  expect(res.status).toBe(200);
  return (await res.json() as { item: DataItemView }).item;
}

function replace(session: TestSession, locationId: string, ref: string, fileId: string, on = server): Promise<Response> {
  return call(on, `${itemPath(locationId, ref)}/replace`, { session, json: { fileId } });
}

async function replaced(session: TestSession, locationId: string, ref: string, fileId: string): Promise<DataItemView> {
  const res = await replace(session, locationId, ref, fileId);
  expect(res.status).toBe(200);
  return (await res.json() as { item: DataItemView }).item;
}

/** A reference file stored through the chunked upload routes, as the browser stores an item or an edit; its id. */
async function keep(session: TestSession, locationId: string, name: string, text: string): Promise<string> {
  const added = await uploadFile(server, locationId, session, name, Buffer.from(text, 'utf8'), { purpose: 'reference' });
  expect(added.status).toBe(200);
  return added.body.file?.id ?? '';
}

function fileDoc(id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(id) });
}

/** A claim on an item for `byId`, made at `at`, as a replace that stopped after step 1 leaves it. */
async function leaveClaim(itemId: string, byId: string, at: Date): Promise<void> {
  await server.connection.collection('tw_files').updateOne(
    { _id: new Types.ObjectId(itemId) }, { $set: { replacedBy: new Types.ObjectId(byId), replacedAt: at } },
  );
}

/** A claim time REPLACE_CLAIM_MS and a millisecond ago: stale. */
function staleTime(): Date {
  return new Date(server.clock.now().getTime() - REPLACE_CLAIM_MS - 1);
}

function hasRaw(locationId: string, fileId: string): boolean {
  return blobs.raw.has(rawBlobName(scopeOf(team.orgId), { locationId, fileId }));
}

async function listed(session: TestSession, locationId: string, ref: string): Promise<DataItemView | undefined> {
  return (await list(session, `?locationId=${locationId}`)).items.find((each) => each.ref === ref);
}

describe('GET /api/org/data', () => {
  it('lists a location’s uploads and stored files newest first, each once: a file that wrote days as its upload, a kept file on its own', async () => {
    const l1 = await newLocation();
    const sentAt = server.clock.now().toISOString();
    const browser = await send(team.member, l1, '2026-05-01', 3);
    tick();
    const read = await seedReadFileUpload(l1, '2026-05-10', 2);   // wrote days
    tick();
    const kept = await uploadFile(server, l1, team.member, 'photo.jpg', jpeg, { purpose: 'reference' });
    expect(kept.status).toBe(200);
    const keptId = kept.body.file?.id ?? '';
    const { items, next } = await list(team.admin, `?locationId=${l1}`);
    expect(items.map((i) => [i.ref.slice(0, 2), i.via, i.kind])).toEqual([['f_', 'file', 'other'], ['u_', 'file', 'text'], ['u_', 'browser', 'daily_totals']]);
    expect(items.map((i) => i.ref)).toEqual([`f_${keptId}`, `u_${read.uploadId}`, `u_${browser}`]);
    expect(items[1]?.file?.id).toBe(read.fileId);
    expect(next).toBeNull();

    expect(items[2]).toEqual({
      ref: `u_${browser}`, locationId: l1, via: 'browser', kind: 'daily_totals', name: null, addedAt: sentAt, addedByEmail: team.memberEmail,
      sizeBytes: null, enabled: true, state: 'used', outcome: null, days: { count: 3, inUse: 3, firstDate: '2026-05-01', lastDate: '2026-05-03' },
      file: null, canTurnOff: true, canDelete: true, canEdit: false, editedAt: null, editedByEmail: null,
      // Spec 11A.9: a browser upload has no stored file for TownwiseAI to read.
      canAiRead: false, ai: null, fromAiRead: null,
    });
    expect(items[1]).toMatchObject({
      name: 'sales.csv', sizeBytes: RAW.length, enabled: true, state: 'used', addedByEmail: team.adminEmail,
      days: { count: 2, inUse: 2, firstDate: '2026-05-10', lastDate: '2026-05-11' },
      file: { id: read.fileId, hasClean: true, rawAvailable: true, entries: null, canDownloadRaw: true, canDownloadClean: true, canDeleteRaw: true },
      canTurnOff: true, canDelete: true,
    });
    expect(items[0]).toMatchObject({
      name: 'photo.jpg', sizeBytes: jpeg.length, enabled: true, state: 'kept', outcome: 'reference', days: null, addedByEmail: team.memberEmail,
      file: { id: keptId, hasClean: false, rawAvailable: true, canDownloadClean: false }, canTurnOff: true, canDelete: true,
    });
    // A member sees the same rows, with only their own items' actions.
    const asOther = (await list(team.other, `?locationId=${l1}`)).items;
    expect(asOther.map((i) => [i.ref, i.canTurnOff, i.canDelete])).toEqual([[`f_${keptId}`, false, false], [`u_${read.uploadId}`, false, false], [`u_${browser}`, false, false]]);
    const asMember = (await list(team.member, `?locationId=${l1}`)).items;
    expect(asMember.map((i) => [i.ref, i.canTurnOff, i.canDelete])).toEqual([[`f_${keptId}`, true, true], [`u_${read.uploadId}`, false, false], [`u_${browser}`, true, false]]);
  });

  it('names who added each: a current email, Townwise staff for a setup upload, Deleted person once gone', async () => {
    const l1 = await newLocation();
    await send(team.member, l1, '2026-05-01', 1);
    tick();
    await addUpload(server, {
      orgId: team.orgId, locationId: l1, uploadedAt: server.clock.now(), status: 'applied', uploadedBy: new Types.ObjectId().toHexString(), byStaff: true,
    });
    tick();
    await addUpload(server, { orgId: team.orgId, locationId: l1, uploadedAt: server.clock.now(), status: 'applied', uploadedBy: new Types.ObjectId().toHexString() });
    const { items } = await list(team.member, `?locationId=${l1}`);
    expect(items.map((i) => [i.via, i.addedByEmail])).toEqual([['browser', 'Deleted person'], ['staff', 'Townwise staff'], ['browser', team.memberEmail]]);
  });

  it('without locationId lists every location of the organization; another organization’s location id answers 404', async () => {
    const t = await newTeam('Two Rooms');
    const front = await addLocation(server, { orgId: t.orgId, name: 'Front' });
    const back = await addLocation(server, { orgId: t.orgId, name: 'Back' });
    const first = await send(t.admin, front, '2026-05-01', 1);
    tick();
    const second = await send(t.admin, back, '2026-05-01', 1);
    expect((await list(t.admin)).items.map((i) => [i.ref, i.locationId])).toEqual([[`u_${second}`, back], [`u_${first}`, front]]);
    expect(await errorOf(await call(server, `/api/org/data?locationId=${await newLocation()}`, { session: t.admin }))).toEqual({ status: 404, error: 'not_found' });
    for (const query of ['?locationId=nope', '?after=2026-06-01_abc', `?after=2026-13-01T00:00:00.000Z_${'a'.repeat(24)}`, `?after=2026-06-01T00:00:00Z_${'a'.repeat(24)}`]) {
      expect({ query, ...(await errorOf(await call(server, `/api/org/data${query}`, { session: t.admin }))) }).toEqual({ query, status: 400, error: 'invalid_request' });
    }
  });

  it('pages 100 at a time, and the last page has next null', async () => {
    const l1 = await newLocation();
    const base = server.clock.now().getTime();
    const rows: { at: number; id: string; ref: string }[] = [];
    // 98 uploads a second apart and three stored files among them, 101 items. The oldest two share a time, so the
    // cursor's id decides between them.
    for (let i = 0; i < 98; i += 1) {
      const at = base - i * 1000;
      const id = await addUpload(server, { orgId: team.orgId, locationId: l1, uploadedAt: new Date(at), status: 'applied' });
      rows.push({ at, id, ref: `u_${id}` });
    }
    for (const at of [base - 500, base - 50_500, base - 97_000]) {
      const id = await seedFile(l1, { uploadedAt: new Date(at) });
      rows.push({ at, id, ref: `f_${id}` });
    }
    const expected = rows.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    const first = await list(team.admin, `?locationId=${l1}`);
    expect(first.items).toHaveLength(100);
    const cursor = expected[99];
    expect(first.next).toBe(`${new Date(cursor?.at ?? 0).toISOString()}_${cursor?.id ?? ''}`);
    expect(expected[100]?.at).toBe(cursor?.at);
    const second = await list(team.admin, `?locationId=${l1}&after=${encodeURIComponent(first.next ?? '')}`);
    expect(second.items).toHaveLength(1);
    expect(second.next).toBeNull();
    expect([...first.items, ...second.items].map((i) => i.ref)).toEqual(expected.map((row) => row.ref));
  });

  describe('view-as', () => {
    afterEach(async () => { await removeStaffFactor(server); });

    it('under view-as, names are null and canTurnOff, canDelete and every download flag are false', async () => {
      const l1 = await newLocation();
      await seedReadFileUpload(l1, '2026-05-01', 2);
      tick();
      expect((await uploadFile(server, l1, team.admin, 'menu.pdf', Buffer.from('%PDF-1.4\nsynthetic\n'), { purpose: 'reference' })).status).toBe(200);
      const staff = await signInStaff(server);
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: team.admin.userId, orgId: team.orgId });
      const { items } = await list(staff, `?locationId=${l1}`);
      expect(items).toHaveLength(2);
      for (const item of items) {
        expect(item).toMatchObject({
          name: null, canTurnOff: false, canDelete: false, file: { canDownloadRaw: false, canDownloadClean: false, canDeleteRaw: false },
        });
      }
      expect(await errorOf(await patch(staff, l1, items[0]?.ref ?? '', { enabled: false }))).toEqual({ status: 403, error: 'view_as_read_only' });
      expect(await errorOf(await call(server, itemPath(l1, items[1]?.ref ?? ''), { session: staff, method: 'DELETE' }))).toEqual({ status: 403, error: 'view_as_read_only' });
    });
  });

  it('with stored files off, lists uploads only, each with file null', async () => {
    const l1 = await newLocation();
    const browser = await send(team.admin, l1, '2026-05-01', 2);
    tick();
    const read = await seedReadFileUpload(l1, '2026-05-10', 2);
    tick();
    await seedFile(l1);
    const offAdmin = await signIn(off, team.adminEmail);
    const { items } = await list(offAdmin, `?locationId=${l1}`, off);
    expect(items.map((i) => [i.ref, i.file, i.name])).toEqual([[`u_${read.uploadId}`, null, null], [`u_${browser}`, null, null]]);
  });

  it('shows an unfinished upload of a file to the person sending it only', async () => {
    const l1 = await newLocation();
    const created = await call(server, filesPath(l1), { session: team.member, json: { name: 'menu.txt', sizeBytes: 10, purpose: 'reference' } });
    expect(created.status).toBe(201);
    const fileId = (await created.json() as { file: { id: string } }).file.id;
    expect((await list(team.member, `?locationId=${l1}`)).items.map((i) => [i.ref, i.state, i.canTurnOff, i.canDelete]))
      .toEqual([[`f_${fileId}`, 'uploading', false, true]]);
    expect((await list(team.admin, `?locationId=${l1}`)).items).toEqual([]);
    expect(await errorOf(await patch(team.admin, l1, `f_${fileId}`, { enabled: false }))).toEqual({ status: 404, error: 'not_found' });
  });

  it('says how many of an upload’s days are still in use after a later upload replaced some', async () => {
    const l1 = await newLocation();
    await send(team.admin, l1, '2026-05-01', 10);
    tick();
    await send(team.admin, l1, '2026-05-06', 10);
    expect((await list(team.admin, `?locationId=${l1}`)).items[1]?.days).toEqual({ count: 10, inUse: 5, firstDate: '2026-05-01', lastDate: '2026-05-10' });
  });
});

describe('GET /api/org/locations/:locationId/data/:ref', () => {
  function getItem(session: TestSession, locationId: string, ref: string, on = server): Promise<Response> {
    return call(on, itemPath(locationId, ref), { session });
  }

  it('answers an upload, a sales file’s upload and a stored file exactly as the caller’s list shows each', async () => {
    const l1 = await newLocation();
    await send(team.member, l1, '2026-05-01', 3);
    tick();
    await seedReadFileUpload(l1, '2026-05-10', 2);
    tick();
    await keep(team.member, l1, 'menu.txt', 'Closed Mondays in January.');
    for (const session of [team.admin, team.member, team.other]) {
      const { items } = await list(session, `?locationId=${l1}`);
      expect(items.map((item) => item.ref.slice(0, 2))).toEqual(['f_', 'u_', 'u_']);
      for (const item of items) {
        const res = await getItem(session, l1, item.ref);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ item });
      }
    }
  });

  it('another location’s or organization’s item, an unknown id and a stored file that wrote days answer 404; a malformed ref 400', async () => {
    const l1 = await newLocation();
    const l2 = await newLocation();
    const upload = await send(team.admin, l1, '2026-05-01', 1);
    const read = await seedReadFileUpload(l1, '2026-05-10', 1);
    const fileId = await seedFile(l1);
    const t = await newTeam('Other Kitchen');
    const theirs = await addLocation(server, { orgId: t.orgId, name: 'Theirs' });
    const theirUpload = await send(t.admin, theirs, '2026-05-01', 1);
    const cases: [string, string][] = [
      [l2, `u_${upload}`], [l2, `f_${fileId}`], [l1, `u_${theirUpload}`], [theirs, `u_${theirUpload}`], [l1, `f_${read.fileId}`],
      [l1, `u_${new Types.ObjectId().toHexString()}`], [l1, `f_${new Types.ObjectId().toHexString()}`],
    ];
    for (const [locationId, ref] of cases) {
      expect({ ref, ...(await errorOf(await getItem(team.admin, locationId, ref))) }).toEqual({ ref, status: 404, error: 'not_found' });
    }
    for (const ref of [`x_${'a'.repeat(24)}`, `u_${'A'.repeat(24)}`, 'f_abc', 'text']) {
      expect({ ref, ...(await errorOf(await getItem(team.admin, l1, ref))) }).toEqual({ ref, status: 400, error: 'invalid_request' });
    }
  });

  it('with stored files off, an upload answers with no file, and a stored file 404, as the list leaves it out', async () => {
    const l1 = await newLocation();
    const read = await seedReadFileUpload(l1, '2026-05-10', 2);
    const fileId = await seedFile(l1);
    const offAdmin = await signIn(off, team.adminEmail);
    const res = await getItem(offAdmin, l1, `u_${read.uploadId}`, off);
    expect(res.status).toBe(200);
    const { item } = await res.json() as { item: DataItemView };
    expect(item).toEqual((await list(offAdmin, `?locationId=${l1}`, off)).items[0]);
    expect(item).toMatchObject({ ref: `u_${read.uploadId}`, kind: 'daily_totals', name: null, file: null, days: { count: 2, inUse: 2 } });
    expect(await errorOf(await getItem(offAdmin, l1, `f_${fileId}`, off))).toEqual({ status: 404, error: 'not_found' });
  });

  describe('view-as', () => {
    afterEach(async () => { await removeStaffFactor(server); });

    it('under view-as, the item has no name and no rights', async () => {
      const l1 = await newLocation();
      const fileId = await keep(team.admin, l1, 'winter-menu.txt', 'Closed Mondays in January.');
      const staff = await signInStaff(server);
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: team.admin.userId, orgId: team.orgId });
      const res = await getItem(staff, l1, `f_${fileId}`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).not.toContain('winter-menu');
      expect(JSON.parse(text)).toMatchObject({
        item: {
          ref: `f_${fileId}`, name: null, canTurnOff: false, canDelete: false, canEdit: false,
          file: { canDownloadRaw: false, canDownloadClean: false, canDeleteRaw: false },
        },
      });
    });
  });
});

describe('PATCH /api/org/locations/:locationId/data/:ref', () => {
  it('the uploader turns their upload off and on; its days leave and return', async () => {
    const l1 = await newLocation();
    const ref = `u_${await send(team.member, l1, '2026-05-01', 3)}`;
    expect(await patched(team.member, l1, ref, false)).toMatchObject({ ref, enabled: false, canTurnOff: true });
    expect(await dayCount(l1)).toBe(0);
    expect((await list(team.member, `?locationId=${l1}`)).items[0]).toMatchObject({ ref, enabled: false, days: { count: 3, inUse: 3 } });
    expect(await patched(team.member, l1, ref, true)).toMatchObject({ ref, enabled: true });
    expect(await dayCount(l1)).toBe(3);
  });

  it('an org admin turns off a member’s upload and a Townwise staff upload; a member gets 403 forbidden for either', async () => {
    const l1 = await newLocation();
    const theirs = `u_${await send(team.other, l1, '2026-05-01', 2)}`;
    tick();
    const setup = `u_${await addUpload(server, {
      orgId: team.orgId, locationId: l1, uploadedAt: server.clock.now(), status: 'applied', uploadedBy: team.member.userId, byStaff: true,
    })}`;
    for (const ref of [theirs, setup]) {
      expect({ ref, ...(await errorOf(await patch(team.member, l1, ref, { enabled: false }))) }).toEqual({ ref, status: 403, error: 'forbidden' });
      expect(await patched(team.admin, l1, ref, false)).toMatchObject({ ref, enabled: false, canTurnOff: true });
    }
    // Even the staff member's own id as uploader does not let a member manage a staff upload.
    expect((await list(team.member, `?locationId=${l1}`)).items.map((i) => [i.ref, i.canTurnOff])).toEqual([[setup, false], [theirs, false]]);
  });

  it('a reference item turns off and on; a stored file that wrote no days and is not for reference answers 400', async () => {
    const l1 = await newLocation();
    const item = await seedFile(l1);
    expect(await patched(team.member, l1, `f_${item}`, false)).toMatchObject({ ref: `f_${item}`, enabled: false, state: 'kept', canTurnOff: true });
    expect(await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(item) }))
      .toMatchObject({ disabledAt: server.clock.now(), disabledBy: team.member.userId });
    expect(await patched(team.admin, l1, `f_${item}`, true)).toMatchObject({ enabled: true });
    const doc = await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(item) });
    expect(Object.keys(doc ?? {})).not.toContain('disabledAt');
    expect(Object.keys(doc ?? {})).not.toContain('disabledBy');

    const unread = await seedFile(l1, { purpose: 'history', importId: new Types.ObjectId(), outcome: 'needs_help', name: 'sales.csv' });
    expect(await errorOf(await patch(team.admin, l1, `f_${unread}`, { enabled: false }))).toEqual({ status: 400, error: 'invalid_request' });
    expect((await list(team.admin, `?locationId=${l1}`)).items.find((i) => i.ref === `f_${unread}`)).toMatchObject({ canTurnOff: false, canDelete: true });
  });

  it('a file being read answers 409 item_busy', async () => {
    const l1 = await newLocation();
    const reading = await seedFile(l1, { purpose: 'history', importId: new Types.ObjectId(), status: 'reading', outcome: null, name: 'sales.csv' });
    tick();
    const res = await patch(team.member, l1, `f_${reading}`, { enabled: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'item_busy', message: 'Townwise is still using this item; try again when it is done' });
    // An upload whose file Townwise is reading again (after a question) is busy too.
    const read = await seedReadFileUpload(l1, '2026-05-01', 2);
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(read.fileId) }, { $set: { status: 'reading' } });
    expect(await errorOf(await patch(team.admin, l1, `u_${read.uploadId}`, { enabled: false }))).toEqual({ status: 409, error: 'item_busy' });
    const items = (await list(team.admin, `?locationId=${l1}`)).items;
    expect(items.map((i) => [i.ref, i.state, i.canTurnOff])).toEqual([[`u_${read.uploadId}`, 'reading', false], [`f_${reading}`, 'reading', false]]);
    // A stored file's first write: its upload is still applying, and the row reads as reading, not as not finished.
    await server.connection.collection('tw_uploads').updateOne({ _id: new Types.ObjectId(read.uploadId) }, { $set: { status: 'applying' } });
    expect(await errorOf(await patch(team.admin, l1, `u_${read.uploadId}`, { enabled: false }))).toEqual({ status: 409, error: 'item_busy' });
    expect((await list(team.admin, `?locationId=${l1}`)).items.find((i) => i.ref === `u_${read.uploadId}`)).toMatchObject({ state: 'reading', canTurnOff: false });
    expect(await dayCount(l1)).toBe(2);
  });

  it('records data.turned_off and data.turned_on with only locationId, item and kind', async () => {
    const l1 = await newLocation();
    const id = await send(team.admin, l1, '2026-05-01', 2);
    await patched(team.admin, l1, `u_${id}`, false);
    const turnedOff = await lastEvent('data.turned_off');
    expect(turnedOff).toMatchObject({ target: { type: 'upload', id }, details: { locationId: l1, item: 'upload', kind: 'daily_totals' } });
    expect(Object.keys(turnedOff.details).sort()).toEqual(['item', 'kind', 'locationId']);
    await patched(team.admin, l1, `u_${id}`, true);
    const turnedOn = await lastEvent('data.turned_on');
    expect(turnedOn).toMatchObject({ target: { type: 'upload', id }, details: { locationId: l1, item: 'upload', kind: 'daily_totals' } });
    expect(Object.keys(turnedOn.details).sort()).toEqual(['item', 'kind', 'locationId']);

    const fileId = await seedFile(l1);
    await patched(team.member, l1, `f_${fileId}`, false);
    expect(await lastEvent('data.turned_off')).toMatchObject({ target: { type: 'file', id: fileId }, details: { locationId: l1, item: 'file', kind: 'text' } });
    // Asking for the state it is already in changes nothing and records nothing.
    const count = (await auditEvents(server)).length;
    expect(await patched(team.member, l1, `f_${fileId}`, false)).toMatchObject({ enabled: false });
    expect((await auditEvents(server)).length).toBe(count);

    expect(summaryOf('data.turned_off', turnedOff.details)).toBe('Turned off an upload');
    expect(summaryOf('data.turned_on', turnedOn.details)).toBe('Turned on an upload');
    expect(summaryOf('data.turned_off', { locationId: l1, item: 'file', kind: 'text' })).toBe('Turned off a file');
    expect(summaryOf('data.turned_on', { locationId: l1, item: 'file', kind: 'text' })).toBe('Turned on a file');
  });

  it('refuses a malformed ref or body with 400, and an unknown ref, another location’s, or a file listed as its upload with 404', async () => {
    const l1 = await newLocation();
    const l2 = await newLocation();
    const id = await send(team.admin, l1, '2026-05-01', 1);
    const read = await seedReadFileUpload(l1, '2026-05-10', 1);
    for (const [ref, body] of [[`u_${id}`, { enabled: 'no' }], [`u_${id}`, { enabled: false, more: 1 }], ['x_1', { enabled: false }], [`u_${'A'.repeat(24)}`, { enabled: false }]] as const) {
      expect({ ref, ...(await errorOf(await patch(team.admin, l1, ref, body))) }).toEqual({ ref, status: 400, error: 'invalid_request' });
    }
    for (const [locationId, ref] of [
      [l1, `u_${new Types.ObjectId().toHexString()}`], [l1, `f_${new Types.ObjectId().toHexString()}`], [l2, `u_${id}`], [l1, `f_${read.fileId}`],
    ] as const) {
      expect({ ref, ...(await errorOf(await patch(team.admin, locationId, ref, { enabled: false }))) }).toEqual({ ref, status: 404, error: 'not_found' });
    }
    expect(await dayCount(l1)).toBe(2);
  });
});

describe('PATCH /api/org/locations/:locationId/data/:ref { title }: renaming', () => {
  it('the person who added it renames a reference item; the extension stays and data.renamed carries no name', async () => {
    const l1 = await newLocation();
    const id = await keep(team.member, l1, 'menu.pdf', '%PDF-1.4\nsynthetic\n');
    expect(await renamed(team.member, l1, `f_${id}`, '  Dinner menu  ')).toMatchObject({ ref: `f_${id}`, name: 'Dinner menu.pdf', canEdit: true });
    expect(await fileDoc(id)).toMatchObject({ name: 'Dinner menu.pdf' });
    expect((await listed(team.admin, l1, `f_${id}`))?.name).toBe('Dinner menu.pdf');
    const event = await lastEvent('data.renamed');
    expect(event).toMatchObject({ target: { type: 'file', id }, details: { locationId: l1, item: 'file', kind: 'pdf' } });
    expect(Object.keys(event.details).sort()).toEqual(['item', 'kind', 'locationId']);
    expect(JSON.stringify(event)).not.toMatch(/menu/i);
    expect(summaryOf('data.renamed', event.details)).toBe('Renamed a file');
  });

  it('keeps the extension unless the title ends with it, in any case; slashes and control characters become word breaks', async () => {
    const l1 = await newLocation();
    const id = await keep(team.member, l1, 'notes.txt', 'hello');
    expect((await renamed(team.member, l1, `f_${id}`, 'Lunch.TXT')).name).toBe('Lunch.TXT');
    // The extension is the current name's, as it is written now.
    expect((await renamed(team.member, l1, `f_${id}`, 'Specials 12/24\tand\nmore')).name).toBe('Specials 12-24 and more.TXT');
  });

  it('the same name as now answers 200 and writes and records nothing', async () => {
    const l1 = await newLocation();
    const id = await keep(team.member, l1, 'notes.txt', 'same name');
    const before = await fileDoc(id);
    const count = (await auditEvents(server)).length;
    expect((await renamed(team.member, l1, `f_${id}`, 'notes')).name).toBe('notes.txt');
    expect((await renamed(team.member, l1, `f_${id}`, 'notes.txt')).name).toBe('notes.txt');
    expect(await fileDoc(id)).toEqual(before);
    expect((await auditEvents(server)).length).toBe(count);
  });

  it('an upload, a sales file, an item whose original is gone and a malformed title answer 400; an item not kept 409 item_busy', async () => {
    const l1 = await newLocation();
    const upload = await send(team.member, l1, '2026-05-01', 1);
    const sales = await seedFile(l1, { purpose: 'history', importId: new Types.ObjectId(), outcome: 'needs_help', name: 'sales.csv' });
    const gone = await seedFile(l1, { rawDeletedAt: server.clock.now(), name: 'Text file' });
    const ok = await seedFile(l1);
    for (const [ref, body] of [
      [`u_${upload}`, { title: 'x' }], [`f_${sales}`, { title: 'x' }], [`f_${gone}`, { title: 'x' }],
      [`f_${ok}`, { title: '   ' }], [`f_${ok}`, { title: 'x'.repeat(121) }], [`f_${ok}`, { title: '\u0001\u0002' }],
      [`f_${ok}`, { title: 'x', enabled: false }], [`f_${ok}`, { title: 7 }],
    ] as const) {
      expect({ ref, body, ...(await errorOf(await patch(team.member, l1, ref, body))) }).toEqual({ ref, body, status: 400, error: 'invalid_request' });
    }
    expect((await renamed(team.member, l1, `f_${ok}`, 'x'.repeat(120))).name).toBe(`${'x'.repeat(120)}.txt`);
    const created = await call(server, filesPath(l1), { session: team.member, json: { name: 'menu.txt', sizeBytes: 10, purpose: 'reference' } });
    const uploading = (await created.json() as { file: { id: string } }).file.id;
    expect(await errorOf(await patch(team.member, l1, `f_${uploading}`, { title: 'x' }))).toEqual({ status: 409, error: 'item_busy' });
    expect(await fileDoc(gone)).toMatchObject({ name: 'Text file' });
  });

  it('someone else’s item is 403 for a member and renamed by an org admin; a staff-added item by an org admin only', async () => {
    const l1 = await newLocation();
    const id = await keep(team.member, l1, 'notes.txt', 'theirs');
    expect(await errorOf(await patch(team.other, l1, `f_${id}`, { title: 'Mine now' }))).toEqual({ status: 403, error: 'forbidden' });
    expect((await renamed(team.admin, l1, `f_${id}`, 'Renamed by the admin')).name).toBe('Renamed by the admin.txt');
    const staffs = await seedFile(l1, { byStaff: true, uploadedBy: team.member.userId });
    expect(await errorOf(await patch(team.member, l1, `f_${staffs}`, { title: 'x' }))).toEqual({ status: 403, error: 'forbidden' });
    expect((await renamed(team.admin, l1, `f_${staffs}`, 'Set up')).name).toBe('Set up.txt');
  });

  it('while an edit of the item is being saved answers 409 item_busy, even under a race, and renames once the claim is stale', async () => {
    const stores = createTownwiseStores(server.connection);
    const l1 = await newLocation();
    const id = await keep(team.member, l1, 'notes.txt', 'being edited');
    const edit = await keep(team.member, l1, 'notes.txt', 'being edited, saved');
    expect(await stores.files.claimReplace(scopeOf(team.orgId), l1, id, edit, server.clock.now())).not.toBeNull();
    for (const title of ['Renamed', 'notes']) {
      expect({ title, ...(await errorOf(await patch(team.member, l1, `f_${id}`, { title }))) }).toEqual({ title, status: 409, error: 'item_busy' });
    }
    // The compare-and-set itself refuses it, for a rename that read the item before the claim landed.
    expect(await stores.files.rename(scopeOf(team.orgId), l1, id, 'Renamed.txt', replaceClaimStaleBefore(server.clock.now()))).toBeNull();
    expect(await fileDoc(id)).toMatchObject({ name: 'notes.txt' });
    server.clock.advance(REPLACE_CLAIM_MS + 1);
    expect(await renamed(team.member, l1, `f_${id}`, 'Renamed')).toMatchObject({ name: 'Renamed.txt', canEdit: true });
  });

  it('another location’s or organization’s item answers 404, and stored files off 503 files_unavailable', async () => {
    const l1 = await newLocation();
    const l2 = await newLocation();
    const id = await seedFile(l1);
    const t = await newTeam('Rename Elsewhere');
    const foreign = await addLocation(server, { orgId: t.orgId, name: 'Theirs' });
    const theirs = await seedFile(foreign, { orgId: new Types.ObjectId(t.orgId), uploadedBy: t.admin.userId });
    for (const [locationId, ref] of [[l2, `f_${id}`], [l1, `f_${theirs}`], [foreign, `f_${id}`]] as const) {
      expect({ ref, ...(await errorOf(await patch(team.admin, locationId, ref, { title: 'x' }))) }).toEqual({ ref, status: 404, error: 'not_found' });
    }
    const offAdmin = await signIn(off, team.adminEmail);
    expect(await errorOf(await patch(offAdmin, l1, `f_${id}`, { title: 'x' }, off))).toEqual({ status: 503, error: 'files_unavailable' });
    expect(await fileDoc(id)).toMatchObject({ name: 'notes.txt' });
    expect(await fileDoc(theirs)).toMatchObject({ name: 'notes.txt' });
  });

  describe('view-as', () => {
    afterEach(async () => { await removeStaffFactor(server); });

    it('renaming and saving an edit are 403 view_as_read_only, and canEdit is false', async () => {
      const l1 = await newLocation();
      const id = await keep(team.admin, l1, 'notes.txt', 'admin text');
      const edit = await keep(team.admin, l1, 'notes.txt', 'admin text, edited');
      const staff = await signInStaff(server);
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: team.admin.userId, orgId: team.orgId });
      expect(await errorOf(await patch(staff, l1, `f_${id}`, { title: 'x' }))).toEqual({ status: 403, error: 'view_as_read_only' });
      expect(await errorOf(await replace(staff, l1, `f_${id}`, edit))).toEqual({ status: 403, error: 'view_as_read_only' });
      expect((await list(staff, `?locationId=${l1}`)).items.map((each) => each.canEdit)).toEqual([false, false]);
      expect(await fileDoc(id)).toMatchObject({ name: 'notes.txt' });
      expect(await exists('tw_files', id)).toBe(true);
    });
  });
});

describe('POST /api/org/locations/:locationId/data/:ref/replace', () => {
  it('saves an edit: the new file takes the item’s place, who added it, when and its off state; the old one goes', async () => {
    const l1 = await newLocation();
    const addedAt = server.clock.now().toISOString();
    const a = await keep(team.member, l1, 'notes.txt', 'first words');
    await patched(team.member, l1, `f_${a}`, false);
    const disabledAt = server.clock.now();
    tick();
    const b = await keep(team.member, l1, 'notes.txt', 'first words, edited');
    tick();
    const editedAt = server.clock.now().toISOString();
    const shown = await replaced(team.member, l1, `f_${a}`, b);
    expect(shown).toMatchObject({
      ref: `f_${b}`, locationId: l1, via: 'file', kind: 'text', name: 'notes.txt', addedAt, addedByEmail: team.memberEmail,
      sizeBytes: Buffer.byteLength('first words, edited'), enabled: false, state: 'kept', canTurnOff: true, canDelete: true, canEdit: true,
      editedAt, editedByEmail: team.memberEmail, file: { id: b, rawAvailable: true },
    });
    expect(await fileDoc(b)).toMatchObject({
      uploadedBy: team.member.userId, uploaderRole: 'member', uploadedAt: new Date(addedAt), disabledAt, disabledBy: team.member.userId,
      replaces: new Types.ObjectId(a), editedAt: new Date(editedAt), editedBy: team.member.userId,
    });
    expect(Object.keys(await fileDoc(b) ?? {})).not.toContain('replacedBy');
    expect(Object.keys(await fileDoc(b) ?? {})).not.toContain('editedByStaff');
    expect(await exists('tw_files', a)).toBe(false);
    expect(hasRaw(l1, a)).toBe(false);
    expect(hasRaw(l1, b)).toBe(true);
    // One item, where the first one was.
    expect((await list(team.admin, `?locationId=${l1}`)).items.map((each) => each.ref)).toEqual([`f_${b}`]);
    const event = await lastEvent('data.edited');
    expect(event).toMatchObject({ target: { type: 'file', id: b }, details: { locationId: l1, item: 'file', kind: 'text', replaces: a } });
    expect(Object.keys(event.details).sort()).toEqual(['item', 'kind', 'locationId', 'replaces']);
    expect(JSON.stringify(event)).not.toMatch(/notes|first words/);
    expect(summaryOf('data.edited', event.details)).toBe('Edited a file');
    expect((await auditEvents(server)).filter((each) => each.action === 'file.deleted' && (each.target as { id: string }).id === a)).toEqual([]);
  });

  it('an org admin saves an edit of a member’s item: it stays the member’s, and the admin is its editor', async () => {
    const l1 = await newLocation();
    const a = await seedFile(l1, { addedVia: 'townwise_ai', name: 'kept.txt' });
    const b = await keep(team.admin, l1, 'kept.txt', 'the admin’s version');
    const shown = await replaced(team.admin, l1, `f_${a}`, b);
    expect(shown).toMatchObject({ ref: `f_${b}`, via: 'townwise_ai', addedByEmail: team.memberEmail, editedByEmail: team.adminEmail, enabled: true });
    expect(await listed(team.member, l1, `f_${b}`)).toMatchObject({ canTurnOff: true, canDelete: true, canEdit: true, editedByEmail: team.adminEmail });
    expect(await listed(team.other, l1, `f_${b}`)).toMatchObject({ canEdit: false });
    const doc = await fileDoc(b);
    expect(doc).toMatchObject({ uploadedBy: team.member.userId, uploaderRole: 'member', addedVia: 'townwise_ai', editedBy: team.admin.userId });
    expect(Object.keys(doc ?? {})).not.toContain('disabledAt');
  });

  it('a retry after each step finishes the work, and one after it is done answers the same item and records nothing', async () => {
    const stores = createTownwiseStores(server.connection);
    const scope = scopeOf(team.orgId);
    const l1 = await newLocation();
    /** Steps 1 and 2 as the route makes them. */
    const place = async (a: string, b: string): Promise<void> => {
      const claimed = await stores.files.claimReplace(scope, l1, a, b, server.clock.now());
      if (claimed === null) throw new Error('the item was not claimed');
      expect(await stores.files.takePlace(scope, l1, b, { from: claimed, at: server.clock.now(), by: team.member.userId, byStaff: false })).not.toBeNull();
    };
    // Step 1 landed, then the call stopped.
    const a1 = await keep(team.member, l1, 'one.txt', 'one');
    const b1 = await keep(team.member, l1, 'one.txt', 'one, edited');
    expect(await stores.files.claimReplace(scope, l1, a1, b1, server.clock.now())).not.toBeNull();
    expect(await listed(team.member, l1, `f_${a1}`)).toMatchObject({ canEdit: false });
    expect((await replaced(team.member, l1, `f_${a1}`, b1)).ref).toBe(`f_${b1}`);
    expect(await exists('tw_files', a1)).toBe(false);
    // Steps 1 and 2 landed.
    const a2 = await keep(team.member, l1, 'two.txt', 'two');
    const b2 = await keep(team.member, l1, 'two.txt', 'two, edited');
    await place(a2, b2);
    expect((await replaced(team.member, l1, `f_${a2}`, b2)).ref).toBe(`f_${b2}`);
    expect(await exists('tw_files', a2)).toBe(false);
    expect(hasRaw(l1, a2)).toBe(false);
    // Step 3 claimed the old file and stopped: it is no longer listed, and the retry finishes removing it.
    const a3 = await keep(team.member, l1, 'three.txt', 'three');
    const b3 = await keep(team.member, l1, 'three.txt', 'three, edited');
    await place(a3, b3);
    expect(await stores.files.move(scope, a3, ['kept'], 'deleting')).not.toBeNull();
    expect(await listed(team.member, l1, `f_${a3}`)).toBeUndefined();
    expect((await replaced(team.member, l1, `f_${a3}`, b3)).ref).toBe(`f_${b3}`);
    expect(await exists('tw_files', a3)).toBe(false);
    expect(hasRaw(l1, a3)).toBe(false);
    expect((await auditEvents(server)).filter((each) => each.action === 'data.edited').map((each) => (each.target as { id: string }).id))
      .toEqual(expect.arrayContaining([b1, b2, b3]));
    // Done: the same call again answers the item and records nothing.
    const count = (await auditEvents(server)).length;
    expect(await replaced(team.member, l1, `f_${a3}`, b3)).toMatchObject({ ref: `f_${b3}`, name: 'three.txt', canEdit: true });
    expect((await auditEvents(server)).length).toBe(count);
    expect((await list(team.member, `?locationId=${l1}`)).items.map((each) => each.ref).sort()).toEqual([`f_${b1}`, `f_${b2}`, `f_${b3}`].sort());
  });

  it('a second edit saved with another file answers 409 item_changed while the first is saving, and 404 once it is done', async () => {
    const stores = createTownwiseStores(server.connection);
    const l1 = await newLocation();
    const a = await keep(team.member, l1, 'notes.txt', 'shared');
    const first = await keep(team.member, l1, 'notes.txt', 'shared, first edit');
    const second = await keep(team.admin, l1, 'notes.txt', 'shared, second edit');
    await stores.files.claimReplace(scopeOf(team.orgId), l1, a, first, server.clock.now());
    expect(await errorOf(await replace(team.admin, l1, `f_${a}`, second))).toEqual({ status: 409, error: 'item_changed' });
    expect(await fileDoc(second)).toMatchObject({ uploadedBy: team.admin.userId });
    expect(Object.keys(await fileDoc(second) ?? {})).not.toContain('replaces');
    await replaced(team.member, l1, `f_${a}`, first);
    expect(await errorOf(await replace(team.admin, l1, `f_${a}`, second))).toEqual({ status: 404, error: 'not_found' });
    expect(await exists('tw_files', second)).toBe(true);
  });

  it('frees a claim a stopped call left: at once when its file is gone or being deleted, and once stale when that file never took the item’s place', async () => {
    const l1 = await newLocation();
    // Its file is gone, or being deleted: it can never take the item's place, so even a live claim is freed.
    const a1 = await keep(team.member, l1, 'one.txt', 'one');
    await leaveClaim(a1, new Types.ObjectId().toHexString(), server.clock.now());
    const b1 = await keep(team.member, l1, 'one.txt', 'one, edited');
    expect((await replaced(team.member, l1, `f_${a1}`, b1)).ref).toBe(`f_${b1}`);
    expect(await exists('tw_files', a1)).toBe(false);
    const a2 = await keep(team.member, l1, 'two.txt', 'two');
    await leaveClaim(a2, await seedFile(l1, { status: 'deleting' }), server.clock.now());
    const b2 = await keep(team.member, l1, 'two.txt', 'two, edited');
    expect((await replaced(team.member, l1, `f_${a2}`, b2)).ref).toBe(`f_${b2}`);
    expect(await exists('tw_files', a2)).toBe(false);
    // Its file is there and never took the item's place: freed once the claim is stale. The file is left as it was.
    const a3 = await keep(team.member, l1, 'three.txt', 'three');
    const x3 = await keep(team.other, l1, 'three.txt', 'three, someone else’s edit');
    await leaveClaim(a3, x3, staleTime());
    expect(await listed(team.member, l1, `f_${a3}`)).toMatchObject({ canEdit: true });
    const b3 = await keep(team.member, l1, 'three.txt', 'three, edited');
    expect((await replaced(team.member, l1, `f_${a3}`, b3)).ref).toBe(`f_${b3}`);
    expect(await exists('tw_files', a3)).toBe(false);
    expect(await fileDoc(b3)).toMatchObject({ replaces: new Types.ObjectId(a3) });
    const left = await fileDoc(x3);
    expect(left).toMatchObject({ uploadedBy: team.other.userId });
    expect(Object.keys(left ?? {})).not.toContain('replaces');
  });

  it('a live claim whose file is there answers 409 item_changed and stays', async () => {
    const l1 = await newLocation();
    const a = await keep(team.member, l1, 'notes.txt', 'live');
    const x = await keep(team.other, l1, 'notes.txt', 'live, someone else’s edit');
    const at = new Date(server.clock.now().getTime() - REPLACE_CLAIM_MS);
    await leaveClaim(a, x, at);
    expect(await listed(team.member, l1, `f_${a}`)).toMatchObject({ canEdit: false });
    const b = await keep(team.member, l1, 'notes.txt', 'live, edited');
    expect(await errorOf(await replace(team.member, l1, `f_${a}`, b))).toEqual({ status: 409, error: 'item_changed' });
    expect(await fileDoc(a)).toMatchObject({ replacedBy: new Types.ObjectId(x), replacedAt: at });
    expect(Object.keys(await fileDoc(b) ?? {})).not.toContain('replaces');
  });

  it('a stale claim whose file took the item’s place left the item behind: it is removed and the edit answers 409 item_changed', async () => {
    const stores = createTownwiseStores(server.connection);
    const scope = scopeOf(team.orgId);
    const l1 = await newLocation();
    /** Steps 1 and 2 made by a call that stopped there, its claim made at `at`. */
    const leftBehind = async (a: string, x: string, at: Date): Promise<void> => {
      const claimed = await stores.files.claimReplace(scope, l1, a, x, at);
      if (claimed === null) throw new Error('the item was not claimed');
      expect(await stores.files.takePlace(scope, l1, x, { from: claimed, at, by: team.other.userId, byStaff: false })).not.toBeNull();
    };
    const a = await keep(team.member, l1, 'notes.txt', 'behind');
    const x = await keep(team.other, l1, 'notes.txt', 'behind, someone else’s edit');
    await leftBehind(a, x, staleTime());
    const b = await keep(team.member, l1, 'notes.txt', 'behind, edited');
    const count = (await auditEvents(server)).length;
    expect(await errorOf(await replace(team.member, l1, `f_${a}`, b))).toEqual({ status: 409, error: 'item_changed' });
    expect(await exists('tw_files', a)).toBe(false);
    expect(hasRaw(l1, a)).toBe(false);
    expect(await fileDoc(x)).toMatchObject({ replaces: new Types.ObjectId(a), uploadedBy: team.member.userId });
    expect(Object.keys(await fileDoc(b) ?? {})).not.toContain('replaces');
    expect((await auditEvents(server)).length).toBe(count);
    // While the claim is live, the call that made it is still finishing: the item stays for it to remove.
    const a2 = await keep(team.member, l1, 'live.txt', 'live behind');
    const x2 = await keep(team.other, l1, 'live.txt', 'live behind, someone else’s edit');
    await leftBehind(a2, x2, server.clock.now());
    const b2 = await keep(team.member, l1, 'live.txt', 'live behind, edited');
    expect(await errorOf(await replace(team.member, l1, `f_${a2}`, b2))).toEqual({ status: 409, error: 'item_changed' });
    expect(await exists('tw_files', a2)).toBe(true);
  });

  it('step 2 (takePlace) refuses a new file whose original was deleted after it was checked; releasing the claim clears it', async () => {
    const stores = createTownwiseStores(server.connection);
    const scope = scopeOf(team.orgId);
    const l1 = await newLocation();
    const a = await keep(team.member, l1, 'notes.txt', 'kept');
    const b = await keep(team.member, l1, 'notes.txt', 'kept, edited');
    const claimed = await stores.files.claimReplace(scope, l1, a, b, server.clock.now());
    if (claimed === null) throw new Error('the item was not claimed');
    expect(claimed).toMatchObject({ replacedBy: b, replacedAt: server.clock.now() });
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(b) }, { $set: { rawDeletedAt: server.clock.now() } });
    expect(await stores.files.takePlace(scope, l1, b, { from: claimed, at: server.clock.now(), by: team.member.userId, byStaff: false })).toBeNull();
    expect(Object.keys(await fileDoc(b) ?? {})).not.toContain('replaces');
    await stores.files.releaseReplace(scope, a, b);
    const doc = await fileDoc(a);
    expect(Object.keys(doc ?? {})).not.toContain('replacedBy');
    expect(Object.keys(doc ?? {})).not.toContain('replacedAt');
  });

  it('refuses a new file that is not the caller’s, is a day old, is a sales file, is the item itself or already took another item’s place', async () => {
    const l1 = await newLocation();
    const a = await keep(team.member, l1, 'notes.txt', 'the item');
    const others = await keep(team.other, l1, 'notes.txt', 'someone else’s');
    const old = await keep(team.member, l1, 'notes.txt', 'a day old');
    await server.connection.collection('tw_files').updateOne(
      { _id: new Types.ObjectId(old) }, { $set: { uploadedAt: new Date(server.clock.now().getTime() - DAY_MS - 1) } },
    );
    const sales = await seedFile(l1, { purpose: 'history', importId: new Types.ObjectId(), outcome: 'needs_help', name: 'sales.csv' });
    const placedElsewhere = await seedFile(l1, { replaces: new Types.ObjectId() });
    const gone = await seedFile(l1, { rawDeletedAt: server.clock.now() });
    for (const fileId of [others, old, sales, a, placedElsewhere, gone]) {
      expect({ fileId, ...(await errorOf(await replace(team.member, l1, `f_${a}`, fileId))) }).toEqual({ fileId, status: 400, error: 'invalid_request' });
    }
    for (const body of [{}, { fileId: 'nope' }, { fileId: others, more: 1 }]) {
      const res = await call(server, `${itemPath(l1, `f_${a}`)}/replace`, { session: team.member, json: body });
      expect({ body, ...(await errorOf(res)) }).toEqual({ body, status: 400, error: 'invalid_request' });
    }
    expect(await exists('tw_files', a)).toBe(true);
    expect(Object.keys(await fileDoc(a) ?? {})).not.toContain('replacedBy');
  });

  it('a new file at another location, in another organization or unknown answers 404; so does another organization’s item', async () => {
    const l1 = await newLocation();
    const l2 = await newLocation();
    const a = await keep(team.member, l1, 'notes.txt', 'here');
    const elsewhere = await keep(team.member, l2, 'notes.txt', 'there');
    const t = await newTeam('Replace Elsewhere');
    const foreign = await addLocation(server, { orgId: t.orgId, name: 'Theirs' });
    const theirs = await seedFile(foreign, { orgId: new Types.ObjectId(t.orgId), uploadedBy: t.admin.userId });
    for (const fileId of [elsewhere, theirs, new Types.ObjectId().toHexString()]) {
      expect({ fileId, ...(await errorOf(await replace(team.member, l1, `f_${a}`, fileId))) }).toEqual({ fileId, status: 404, error: 'not_found' });
    }
    const mine = await keep(team.admin, l1, 'notes.txt', 'the admin’s');
    for (const [locationId, ref] of [[l1, `f_${theirs}`], [foreign, `f_${a}`], [l2, `f_${a}`]] as const) {
      expect({ ref, ...(await errorOf(await replace(team.admin, locationId, ref, mine))) }).toEqual({ ref, status: 404, error: 'not_found' });
    }
    expect(await exists('tw_files', a)).toBe(true);
    expect(await exists('tw_files', theirs)).toBe(true);
    expect(Object.keys(await fileDoc(theirs) ?? {})).not.toContain('replacedBy');
  });

  it('the item: someone else’s is 403 for a member, an upload or sales file 400, one not kept 409; stored files off 503', async () => {
    const l1 = await newLocation();
    const theirs = await keep(team.other, l1, 'notes.txt', 'theirs');
    const mine = await keep(team.member, l1, 'notes.txt', 'mine');
    expect(await errorOf(await replace(team.member, l1, `f_${theirs}`, mine))).toEqual({ status: 403, error: 'forbidden' });
    const upload = await send(team.member, l1, '2026-05-01', 1);
    const sales = await seedFile(l1, { purpose: 'history', importId: new Types.ObjectId(), outcome: 'needs_help', name: 'sales.csv' });
    const gone = await seedFile(l1, { rawDeletedAt: server.clock.now() });
    for (const ref of [`u_${upload}`, `f_${sales}`, `f_${gone}`]) {
      expect({ ref, ...(await errorOf(await replace(team.member, l1, ref, mine))) }).toEqual({ ref, status: 400, error: 'invalid_request' });
    }
    const created = await call(server, filesPath(l1), { session: team.member, json: { name: 'menu.txt', sizeBytes: 10, purpose: 'reference' } });
    const uploading = (await created.json() as { file: { id: string } }).file.id;
    expect(await errorOf(await replace(team.member, l1, `f_${uploading}`, mine))).toEqual({ status: 409, error: 'item_busy' });
    const offMember = await signIn(off, team.memberEmail);
    for (const ref of [`f_${theirs}`, `u_${upload}`]) {
      expect({ ref, ...(await errorOf(await replace(offMember, l1, ref, mine, off))) }).toEqual({ ref, status: 503, error: 'files_unavailable' });
    }
    expect(await exists('tw_files', theirs)).toBe(true);
    expect(Object.keys(await fileDoc(mine) ?? {})).not.toContain('replaces');
  });
});

describe('an item’s edit fields', () => {
  it('canEdit: a kept reference item with its original, for the people who may turn it off; never an upload, a sales file or a gone original', async () => {
    const l1 = await newLocation();
    const own = await seedFile(l1);
    const upload = await send(team.member, l1, '2026-05-01', 1);
    const sales = await seedFile(l1, { purpose: 'history', importId: new Types.ObjectId(), outcome: 'needs_help', name: 'sales.csv' });
    const gone = await seedFile(l1, { rawDeletedAt: server.clock.now(), name: 'Text file' });
    const saving = await seedFile(l1, { replacedBy: new Types.ObjectId(), replacedAt: new Date(server.clock.now().getTime() - REPLACE_CLAIM_MS) });
    // A claim older than REPLACE_CLAIM_MS, or with no time, was left by a call that stopped: it does not block an edit.
    const stale = await seedFile(l1, { replacedBy: new Types.ObjectId(), replacedAt: new Date(server.clock.now().getTime() - REPLACE_CLAIM_MS - 1) });
    const untimed = await seedFile(l1, { replacedBy: new Types.ObjectId() });
    const staffs = await seedFile(l1, { byStaff: true });
    const canEdit = async (session: TestSession): Promise<Record<string, boolean>> => Object.fromEntries(
      (await list(session, `?locationId=${l1}`)).items.map((each) => [each.ref, each.canEdit]),
    );
    expect(await canEdit(team.member)).toEqual({
      [`f_${own}`]: true, [`u_${upload}`]: false, [`f_${sales}`]: false, [`f_${gone}`]: false, [`f_${saving}`]: false,
      [`f_${stale}`]: true, [`f_${untimed}`]: true, [`f_${staffs}`]: false,
    });
    expect(await canEdit(team.other)).toEqual({
      [`f_${own}`]: false, [`u_${upload}`]: false, [`f_${sales}`]: false, [`f_${gone}`]: false, [`f_${saving}`]: false,
      [`f_${stale}`]: false, [`f_${untimed}`]: false, [`f_${staffs}`]: false,
    });
    expect(await canEdit(team.admin)).toEqual({
      [`f_${own}`]: true, [`u_${upload}`]: false, [`f_${sales}`]: false, [`f_${gone}`]: false, [`f_${saving}`]: false,
      [`f_${stale}`]: true, [`f_${untimed}`]: true, [`f_${staffs}`]: true,
    });
  });

  it('editedAt and editedByEmail: null if never edited, else when and who, as Townwise staff for staff and Deleted person once gone', async () => {
    const l1 = await newLocation();
    const at = new Date(server.clock.now().getTime() - 1000);
    const never = await seedFile(l1);
    const byOther = await seedFile(l1, { replaces: new Types.ObjectId(), editedAt: at, editedBy: team.other.userId });
    const byStaff = await seedFile(l1, { replaces: new Types.ObjectId(), editedAt: at, editedBy: new Types.ObjectId().toHexString(), editedByStaff: true });
    const byGone = await seedFile(l1, { replaces: new Types.ObjectId(), editedAt: at, editedBy: new Types.ObjectId().toHexString() });
    const fields = Object.fromEntries((await list(team.member, `?locationId=${l1}`)).items.map((each) => [each.ref, [each.editedAt, each.editedByEmail]]));
    expect(fields).toEqual({
      [`f_${never}`]: [null, null],
      [`f_${byOther}`]: [at.toISOString(), team.otherEmail],
      [`f_${byStaff}`]: [at.toISOString(), 'Townwise staff'],
      [`f_${byGone}`]: [at.toISOString(), 'Deleted person'],
    });
    const upload = await send(team.member, l1, '2026-05-01', 1);
    expect(await listed(team.member, l1, `u_${upload}`)).toMatchObject({ editedAt: null, editedByEmail: null });
  });
});

describe('DELETE /api/org/locations/:locationId/data/:ref', () => {
  it('an org admin deletes an upload: the days it still holds, its record and its stored file go; days a later upload replaced stay', async () => {
    const l1 = await newLocation();
    const a = await seedReadFileUpload(l1, '2026-05-01', 10);          // a stored file that wrote 05-01..05-10
    tick();
    await send(team.admin, l1, '2026-05-06', 10);
    expect(await del(team.admin, l1, `u_${a.uploadId}`)).toEqual({ status: 200, body: { deletedDays: 5, deletedFiles: 1 } });
    expect(await dates(l1)).toEqual(range('2026-05-06', '2026-05-15'));
    expect(await exists('tw_files', a.fileId)).toBe(false);
    expect(await exists('tw_uploads', a.uploadId)).toBe(false);
    const ref = { locationId: l1, fileId: a.fileId };
    expect(blobs.raw.has(rawBlobName(scopeOf(team.orgId), ref))).toBe(false);
    expect(blobs.clean.has(cleanBlobName(scopeOf(team.orgId), ref))).toBe(false);
  });

  it('a member deleting an upload answers 403 forbidden, even their own', async () => {
    const l1 = await newLocation();
    const own = await send(team.member, l1, '2026-05-01', 2);
    expect(await del(team.member, l1, `u_${own}`)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await exists('tw_uploads', own)).toBe(true);
    expect(await dayCount(l1)).toBe(2);
  });

  it('the uploader deletes their own reference item; another member gets 403', async () => {
    const l1 = await newLocation();
    const added = await uploadFile(server, l1, team.member, 'notes.txt', Buffer.from('hello'), { purpose: 'reference' });
    expect(added.status).toBe(200);
    const fileId = added.body.file?.id ?? '';
    const ref = { locationId: l1, fileId };
    expect(blobs.raw.has(rawBlobName(scopeOf(team.orgId), ref))).toBe(true);
    expect(await del(team.other, l1, `f_${fileId}`)).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    expect(await del(team.member, l1, `f_${fileId}`)).toEqual({ status: 200, body: { deletedDays: 0, deletedFiles: 1 } });
    expect(await exists('tw_files', fileId)).toBe(false);
    expect(blobs.raw.has(rawBlobName(scopeOf(team.orgId), ref))).toBe(false);
    const event = await lastEvent('file.deleted');
    expect(event).toMatchObject({ target: { type: 'file', id: fileId }, details: { locationId: l1, kind: 'text', reason: 'owner' } });
  });

  it('records sales.upload_deleted with locationId, deletedDays and deletedFiles only', async () => {
    const l1 = await newLocation();
    const id = await send(team.admin, l1, '2026-05-01', 4);
    expect((await del(team.admin, l1, `u_${id}`)).status).toBe(200);
    const event = await lastEvent('sales.upload_deleted');
    expect(event).toMatchObject({ target: { type: 'upload', id }, details: { locationId: l1, deletedDays: 4, deletedFiles: 0 } });
    expect(Object.keys(event.details).sort()).toEqual(['deletedDays', 'deletedFiles', 'locationId']);
    expect(summaryOf('sales.upload_deleted', event.details)).toBe('Deleted an upload and 4 days');
  });

  it('an upload with a stored file while stored files are off answers 503 files_unavailable and deletes nothing', async () => {
    const l1 = await newLocation();
    const a = await seedReadFileUpload(l1, '2026-05-01', 3);
    const plain = await send(team.admin, l1, '2026-05-10', 2);
    const offAdmin = await signIn(off, team.adminEmail);
    expect(await del(offAdmin, l1, `u_${a.uploadId}`, off)).toMatchObject({ status: 503, body: { error: 'files_unavailable' } });
    expect(await dayCount(l1)).toBe(5);
    expect(await exists('tw_uploads', a.uploadId)).toBe(true);
    expect(await exists('tw_files', a.fileId)).toBe(true);
    // With stored files off, an upload with no file still turns off and on and deletes; a file ref answers 503.
    expect(await patched(offAdmin, l1, `u_${plain}`, false, off)).toMatchObject({ enabled: false });
    expect(await patched(offAdmin, l1, `u_${plain}`, true, off)).toMatchObject({ enabled: true });
    expect(await errorOf(await patch(offAdmin, l1, `f_${a.fileId}`, { enabled: false }, off))).toEqual({ status: 503, error: 'files_unavailable' });
    expect(await del(offAdmin, l1, `u_${plain}`, off)).toEqual({ status: 200, body: { deletedDays: 2, deletedFiles: 0 } });
    expect(await dayCount(l1)).toBe(3);
  });

  it('an upload whose stored file Townwise is reading answers 409 file_busy and deletes nothing', async () => {
    const l1 = await newLocation();
    const a = await seedReadFileUpload(l1, '2026-05-01', 3);
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(a.fileId) }, { $set: { status: 'reading' } });
    expect(await del(team.admin, l1, `u_${a.uploadId}`)).toMatchObject({ status: 409, body: { error: 'file_busy' } });
    expect(await dayCount(l1)).toBe(3);
    expect(await exists('tw_uploads', a.uploadId)).toBe(true);
    expect(await exists('tw_files', a.fileId)).toBe(true);
  });

  it('deleting twice answers 404 the second time', async () => {
    const l1 = await newLocation();
    const id = await send(team.admin, l1, '2026-05-01', 1);
    expect((await del(team.admin, l1, `u_${id}`)).status).toBe(200);
    expect(await del(team.admin, l1, `u_${id}`)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    const fileId = await seedFile(l1);
    expect((await del(team.member, l1, `f_${fileId}`)).status).toBe(200);
    expect(await del(team.member, l1, `f_${fileId}`)).toMatchObject({ status: 404, body: { error: 'not_found' } });
  });
});
