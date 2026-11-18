// Every deletion path of stored files (spec 11A, 10.7): a location's sales data, a location, an organization, the
// owner's "delete originals", and the staff purge for a person's deletion request. Each removes the rows it covers
// and both blobs of each file; none writes a file name to a log or an audit event.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { cleanBlobName, rawBlobName } from '../src/files/blobs.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { addLocation, addSalesDay, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { filesPath, putChunk, seedReadFile, uploadFile, type Created } from './helpers/files.ts';
import {
  call, signIn, signInStaff, startTownwiseServer, writesDuring, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const SENTINEL_NAME = 'Zqxj Party Of Twelve.csv';

let server: TownwiseTestServer;
let blobs: MemoryFileBlobs;
let staff: TestSession;

interface Team { orgId: string; admin: TestSession; member: TestSession }

async function team(name: string): Promise<Team> {
  const orgId = await createOrg(server, { name });
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, adminEmail);
  const member = await signIn(server, memberEmail);
  await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(server, { orgId, userId: member.userId, email: memberEmail });
  return { orgId, admin, member };
}

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  server = await startTownwiseServer({ files: blobs, reader: {} });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  staff = await signInStaff(server);
});
afterEach(async () => { await server.authStores.totp.remove(staff.userId); });

const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
const count = (collection: string, filter: Record<string, unknown>): Promise<number> => server.connection.collection(collection).countDocuments(filter);
const blobsUnder = (prefix: string): string[] => [...blobs.raw.keys(), ...blobs.clean.keys(), ...blobs.staged.keys()].filter((name) => name.startsWith(prefix));
const base = (locationId: string): string => `/api/org/locations/${locationId}`;

/** A file still uploading, with one chunk staged and its day's bytes counted. */
async function unfinished(orgId: string, locationId: string, userId: string): Promise<string> {
  const _id = new Types.ObjectId();
  const now = server.clock.now();
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: oid(orgId), locationId: oid(locationId), importId: new Types.ObjectId(), purpose: 'history', uploadedBy: userId,
    uploaderRole: 'member', uploadedAt: now, name: SENTINEL_NAME, kind: 'text', sizeBytes: 3, fingerprint: null, status: 'uploading',
    outcome: null, upload: { chunkSize: 8, chunkCount: 1, chunks: [null], head: null, expiresAt: new Date(now.getTime() + 3_600_000) },
    progress: null, readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null,
    rawDeletedAt: null, attempts: 0,
  });
  const name = rawBlobName({ orgId } as unknown as OrgScope, { locationId, fileId: _id.toHexString() });
  blobs.staged.set(name, new Map([[0, Buffer.from('abc')]]));
  return _id.toHexString();
}

async function addEntry(orgId: string, locationId: string, fileId: string): Promise<void> {
  await server.connection.collection('tw_file_entries').insertOne({
    orgId: oid(orgId), locationId: oid(locationId), fileId: oid(fileId), index: 0, path: SENTINEL_NAME, depth: 1, kind: 'text',
    sizeBytes: 1, status: 'used', outcome: null, family: null, dayCount: null,
  });
}

describe('deleting a location’s sales data', () => {
  it('deletes its stored files: rows, entry lists, imports and both blobs; refused while one is being read', async () => {
    const { orgId, admin, member } = await team('Sales Delete Grill');
    const locationId = await addLocation(server, { orgId, name: 'Main' });
    const read = await seedReadFile(server, blobs, { orgId, locationId, uploadedBy: member.userId, name: SENTINEL_NAME, raw: Buffer.from('r'), clean: 'date\r\n' });
    await addEntry(orgId, locationId, read);
    await unfinished(orgId, locationId, member.userId);
    await addSalesDay(server, { orgId, locationId, date: '2025-01-01', guests: 1, netSalesCents: 100 });
    const reading = new Types.ObjectId();
    await server.connection.collection('tw_imports').insertOne({
      _id: reading, orgId: oid(orgId), locationId: oid(locationId), activeLocation: oid(locationId), createdBy: member.userId,
      createdAt: server.clock.now(), lastDropAt: server.clock.now(), status: 'reading', startedAt: server.clock.now(), finishedAt: null,
      question: null, appliedVersion: 0, drops: 0, lease: null, claimedAt: null, bytesRead: 0, msRead: 0,
    });
    const refused = await call(server, `${base(locationId)}/sales`, { session: admin, method: 'DELETE' });
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([409, 'import_running']);
    expect(await count('tw_files', { locationId: oid(locationId) })).toBe(2);

    await server.connection.collection('tw_imports').updateOne({ _id: reading }, { $set: { status: 'open' } });
    server.logs.length = 0;
    const res = await call(server, `${base(locationId)}/sales`, { session: admin, method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deletedDays: 1, deletedUploads: 0, deletedFiles: 2 });
    for (const collection of ['tw_files', 'tw_file_entries', 'tw_imports', 'tw_sales_days']) {
      expect({ collection, n: await count(collection, { locationId: oid(locationId) }) }).toEqual({ collection, n: 0 });
    }
    expect(blobsUnder(`${orgId}/${locationId}/`)).toEqual([]);
    const event = (await auditEvents(server)).find((e) => e.action === 'sales.deleted' && String(e.orgId) === orgId);
    expect(event?.details).toEqual({ locationId, deletedDays: 1, deletedFiles: 2 });
    expect(JSON.stringify([...server.logs, await auditEvents(server)])).not.toContain('Zqxj');
  });
});

describe('deleting a location', () => {
  // D43: one press deletes the location with its stored files, but never while Townwise is reading one of them.
  it('deletes the location with its stored files and blobs; while a file is being read it is 409 import_running and nothing goes', async () => {
    const { orgId, admin, member } = await team('Location Delete Grill');
    const locationId = await addLocation(server, { orgId, name: 'Annex' });
    await seedReadFile(server, blobs, { orgId, locationId, uploadedBy: member.userId, name: 'a.csv', raw: Buffer.from('r'), clean: 'date\r\n' });
    await addSalesDay(server, { orgId, locationId, date: '2025-01-01', guests: 1, netSalesCents: 100 });
    const reading = new Types.ObjectId();
    await server.connection.collection('tw_imports').insertOne({
      _id: reading, orgId: oid(orgId), locationId: oid(locationId), activeLocation: oid(locationId), createdBy: member.userId,
      createdAt: server.clock.now(), lastDropAt: server.clock.now(), status: 'reading', startedAt: server.clock.now(), finishedAt: null,
      question: null, appliedVersion: 0, drops: 0, lease: null, claimedAt: null, bytesRead: 0, msRead: 0,
    });
    const refused = await call(server, base(locationId), { session: admin, method: 'DELETE' });
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([409, 'import_running']);
    expect({ files: await count('tw_files', { locationId: oid(locationId) }), days: await count('tw_sales_days', { locationId: oid(locationId) }) })
      .toEqual({ files: 1, days: 1 });

    await server.connection.collection('tw_imports').updateOne({ _id: reading }, { $set: { status: 'open' } });
    expect((await call(server, base(locationId), { session: admin, method: 'DELETE' })).status).toBe(204);
    for (const collection of ['tw_files', 'tw_imports', 'tw_sales_days', 'tw_locations']) {
      const filter = collection === 'tw_locations' ? { _id: oid(locationId) } : { locationId: oid(locationId) };
      expect({ collection, n: await count(collection, filter) }).toEqual({ collection, n: 0 });
    }
    expect(blobsUnder(`${orgId}/${locationId}/`)).toEqual([]);
    const event = (await auditEvents(server)).find((e) => e.action === 'location.deleted' && (e.target as { id: string }).id === locationId);
    expect(event?.details).toEqual({ name: 'Annex', townId: 'hanover-nh', deletedDays: 1, deletedFiles: 1, deletedNotes: 0 });
  });
});

describe('deleting an organization', () => {
  it('deletes its files, entry lists, imports, day counters, AI spend and blobs, discarding unfinished uploads', async () => {
    const { orgId, member } = await team('Org Delete Grill');
    const kept = await team('Org Kept Grill');
    const locationId = await addLocation(server, { orgId, name: 'Main' });
    const keptLocation = await addLocation(server, { orgId: kept.orgId, name: 'Main' });
    const read = await seedReadFile(server, blobs, { orgId, locationId, uploadedBy: member.userId, name: SENTINEL_NAME, raw: Buffer.from('r'), clean: 'date\r\n' });
    await seedReadFile(server, blobs, { orgId: kept.orgId, locationId: keptLocation, uploadedBy: kept.member.userId, name: 'k.csv', raw: Buffer.from('k'), clean: 'date\r\n' });
    await addEntry(orgId, locationId, read);
    await unfinished(orgId, locationId, member.userId);
    await server.connection.collection('tw_upload_days').insertOne({ orgId: oid(orgId), day: '2026-06-01', bytes: 3, updatedAt: server.clock.now() });
    await server.connection.collection('tw_files_usage').insertOne({ orgId: oid(orgId), month: '2026-06', costMicroUsd: 10, updatedAt: server.clock.now() });
    await server.connection.collection('tw_orgs').updateOne({ _id: oid(orgId) }, { $set: { status: 'suspended', suspendedAt: server.clock.now() } });

    const res = await call(server, `/api/admin/orgs/${orgId}`, { session: staff, method: 'DELETE' });
    expect(res.status).toBe(200);
    for (const collection of ['tw_files', 'tw_file_entries', 'tw_imports', 'tw_upload_days', 'tw_files_usage']) {
      expect({ collection, n: await count(collection, { orgId: oid(orgId) }) }).toEqual({ collection, n: 0 });
    }
    expect(blobsUnder(`${orgId}/`)).toEqual([]);
    expect(await count('tw_files', { orgId: oid(kept.orgId) })).toBe(1);
    expect(blobsUnder(`${kept.orgId}/`)).toHaveLength(2);
  });
});

describe('deleting originals', () => {
  it('lets an org admin delete every original of a location the reader is done with; members cannot', async () => {
    const { orgId, admin, member } = await team('Originals Grill');
    const locationId = await addLocation(server, { orgId, name: 'Main' });
    const done = await seedReadFile(server, blobs, { orgId, locationId, uploadedBy: member.userId, name: SENTINEL_NAME, raw: Buffer.from('r'), clean: 'date\r\n' });
    const waiting = await seedReadFile(server, blobs, { orgId, locationId, uploadedBy: member.userId, name: 'w.csv', raw: Buffer.from('w'), clean: 'date\r\n' });
    await server.connection.collection('tw_files').updateOne({ _id: oid(waiting) }, { $set: { status: 'stored' } });
    await addEntry(orgId, locationId, done);
    const refused = await call(server, `${base(locationId)}/originals`, { session: member, method: 'DELETE' });
    expect(refused.status).toBe(403);
    const res = await call(server, `${base(locationId)}/originals`, { session: admin, method: 'DELETE' });
    expect(await res.json()).toEqual({ deletedOriginals: 1, skippedBusy: 1 });
    const scope = { orgId } as unknown as OrgScope;
    expect(blobs.raw.has(rawBlobName(scope, { locationId, fileId: done }))).toBe(false);
    expect(blobs.clean.has(cleanBlobName(scope, { locationId, fileId: done }))).toBe(true);
    expect(blobs.raw.has(rawBlobName(scope, { locationId, fileId: waiting }))).toBe(true);
    expect(await server.connection.collection('tw_files').findOne({ _id: oid(done) })).toMatchObject({ name: 'CSV or text file', rawDeletedAt: expect.any(Date) as unknown });
    expect(await server.connection.collection('tw_file_entries').findOne({ fileId: oid(done) })).toMatchObject({ path: null });
    const event = (await auditEvents(server)).find((e) => e.action === 'files.raw_deleted_all' && String(e.orgId) === orgId);
    expect(event?.details).toEqual({ locationId, count: 1 });
  });

  it('leaves every item kept for reference whole (D28): its original is the item', async () => {
    const { orgId, admin, member } = await team('Reference Grill');
    const locationId = await addLocation(server, { orgId, name: 'Main' });
    const sales = await seedReadFile(server, blobs, { orgId, locationId, uploadedBy: member.userId, name: 'sales.csv', raw: Buffer.from('r'), clean: 'date\r\n' });
    const item = await seedReadFile(server, blobs, { orgId, locationId, uploadedBy: member.userId, name: 'Catering.txt', raw: Buffer.from('kept'), clean: '' });
    await server.connection.collection('tw_files').updateOne({ _id: oid(item) }, {
      $set: { purpose: 'reference', importId: null, uploadId: null, status: 'kept', outcome: 'reference', result: null, report: null, cleanBytes: null },
    });
    const res = await call(server, `${base(locationId)}/originals`, { session: admin, method: 'DELETE' });
    expect(await res.json()).toEqual({ deletedOriginals: 1, skippedBusy: 0 });
    const scope = { orgId } as unknown as OrgScope;
    expect(blobs.raw.has(rawBlobName(scope, { locationId, fileId: sales }))).toBe(false);
    expect(blobs.raw.has(rawBlobName(scope, { locationId, fileId: item }))).toBe(true);
    expect(await server.connection.collection('tw_files').findOne({ _id: oid(item) })).toMatchObject({ name: 'Catering.txt', rawDeletedAt: null });
  });
});

describe('the staff purge of originals', () => {
  it('records the event first, with an enum basis, then deletes every original without reading one, unread ones too', async () => {
    const { orgId, member } = await team('Purge Grill');
    const locationId = await addLocation(server, { orgId, name: 'Main' });
    const done = await seedReadFile(server, blobs, { orgId, locationId, uploadedBy: member.userId, name: SENTINEL_NAME, raw: Buffer.from('r'), clean: 'date\r\n' });
    const uploaded = await uploadFile(server, locationId, member, SENTINEL_NAME, Buffer.from('Date,Guests\n2025-01-01,1\n'));
    const later = uploaded.body.file?.id ?? '';
    const path = `/api/admin/orgs/${orgId}/originals/delete`;
    const free = await call(server, path, { session: staff, json: { basis: `request from ${SENTINEL_NAME}` } });
    expect(free.status).toBe(400);

    server.logs.length = 0;
    let res: Response | undefined;
    const writes = await writesDuring(server, async () => { res = await call(server, path, { session: staff, json: { basis: 'data_subject_request' } }); });
    expect(await res?.json()).toEqual({ deletedOriginals: 2, skippedBusy: 0 });
    expect(writes[0]).toBe('insert tw_audit_events');
    const event = (await auditEvents(server)).find((e) => e.action === 'org.originals_deleted' && String(e.orgId) === orgId);
    expect(event).toMatchObject({ actorRole: 'superadmin', target: { type: 'org', id: orgId }, details: { count: 2, basis: 'data_subject_request' } });
    const scope = { orgId } as unknown as OrgScope;
    expect(blobs.raw.has(rawBlobName(scope, { locationId, fileId: done }))).toBe(false);
    // A file in an import nobody started goes now too: kept unread, never read afterwards.
    expect(blobs.raw.has(rawBlobName(scope, { locationId, fileId: later }))).toBe(false);
    expect(await server.connection.collection('tw_files').findOne({ _id: oid(later) })).toMatchObject({
      status: 'kept', outcome: 'raw_deleted', name: 'CSV or text file', rawDeletedAt: expect.any(Date) as unknown,
    });
    const importId = (uploaded.body.import as { id: string }).id;
    await call(server, `${base(locationId)}/imports/${importId}/start`, { session: member, json: {} });
    await server.reader?.settled();
    expect(await server.connection.collection('tw_files').findOne({ _id: oid(later) })).toMatchObject({ status: 'kept', outcome: 'raw_deleted', result: null });
    expect(await count('tw_sales_days', { orgId: oid(orgId) })).toBe(0);
    expect(JSON.stringify([...server.logs, await auditEvents(server)])).not.toContain('Zqxj');
    expect(server.logs.join('\n')).toContain('"by":"staff"');
  });

  it('deletes the original of a file waiting on a question, and drops the question so its import finishes', async () => {
    const { orgId, member } = await team('Purge Waiting Grill');
    const locationId = await addLocation(server, { orgId, name: 'Main' });
    const uploaded = await uploadFile(server, locationId, member, 'either.csv', Buffer.from('Date,Guests\n03/04/2025,60\n04/03/2025,50\n'));
    const fileId = uploaded.body.file?.id ?? '';
    const importId = (uploaded.body.import as { id: string }).id;
    await call(server, `${base(locationId)}/imports/${importId}/start`, { session: member, json: {} });
    await server.reader?.settled();
    expect(await server.connection.collection('tw_imports').findOne({ _id: oid(importId) })).toMatchObject({ status: 'waiting', question: { fileId } });

    const res = await call(server, `/api/admin/orgs/${orgId}/originals/delete`, { session: staff, json: { basis: 'data_subject_request' } });
    expect(await res.json()).toEqual({ deletedOriginals: 1, skippedBusy: 0 });
    expect(blobs.raw.has(rawBlobName({ orgId } as unknown as OrgScope, { locationId, fileId }))).toBe(false);
    expect(await server.connection.collection('tw_files').findOne({ _id: oid(fileId) })).toMatchObject({ status: 'kept', outcome: 'raw_deleted' });
    await server.reader?.settled();
    expect(await server.connection.collection('tw_imports').findOne({ _id: oid(importId) })).toMatchObject({ status: 'done', question: null });
  });

  it('flags a file still uploading, and never reads it once its upload completes', async () => {
    const { orgId, member } = await team('Purge Uploading Grill');
    const locationId = await addLocation(server, { orgId, name: 'Main' });
    const bytes = Buffer.from('Date,Guests\n2025-01-01,1\n');
    const created = await call(server, filesPath(locationId), { session: member, json: { name: SENTINEL_NAME, sizeBytes: bytes.length, purpose: 'history' } });
    const { file, import: { id: importId } } = await created.json() as Created;

    const res = await call(server, `/api/admin/orgs/${orgId}/originals/delete`, { session: staff, json: { basis: 'data_subject_request' } });
    expect(await res.json()).toEqual({ deletedOriginals: 0, skippedBusy: 1 });
    const event = (await auditEvents(server)).find((e) => e.action === 'org.originals_deleted' && String(e.orgId) === orgId);
    expect(event?.details).toMatchObject({ count: 1 });
    expect(await server.connection.collection('tw_files').findOne({ _id: oid(file.id) })).toMatchObject({ status: 'uploading', purgeRaw: true });

    expect((await putChunk(server, filesPath(locationId, `/${file.id}/chunks/0`), member, bytes)).status).toBe(200);
    expect((await call(server, filesPath(locationId, `/${file.id}/complete`), { session: member, json: {} })).status).toBe(200);
    await call(server, `${base(locationId)}/imports/${importId}/start`, { session: member, json: {} });
    await server.reader?.settled();
    expect(await server.connection.collection('tw_files').findOne({ _id: oid(file.id) })).toMatchObject({
      status: 'kept', outcome: 'raw_deleted', name: 'CSV or text file', rawDeletedAt: expect.any(Date) as unknown,
    });
    expect(blobs.raw.has(rawBlobName({ orgId } as unknown as OrgScope, { locationId, fileId: file.id }))).toBe(false);
    expect(await count('tw_sales_days', { orgId: oid(orgId) })).toBe(0);
  });

  it('answers 404 for an unknown organization', async () => {
    const res = await call(server, `/api/admin/orgs/${new Types.ObjectId().toHexString()}/originals/delete`, { session: staff, json: { basis: 'other' } });
    expect(res.status).toBe(404);
  });
});

describe('files routes', () => {
  it('answer 404 on another organization’s originals route', async () => {
    const mine = await team('Mine Grill');
    const theirs = await team('Theirs Grill');
    const locationId = await addLocation(server, { orgId: theirs.orgId, name: 'Main' });
    const res = await call(server, `${base(locationId)}/originals`, { session: mine.admin, method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
