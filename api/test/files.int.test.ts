// Stored files through the API (spec 10.11, 11A): chunked uploads, refusals, back-pressure, downloads, deletion,
// view-as and tenant isolation, with no file name in any log line or audit event.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { FileView } from '../src/handlers/files.ts';
import { CHUNK_BYTES, DAILY_UPLOAD_BYTES, MAX_CHUNK_STREAMS, MAX_FILE_BYTES, RAW_PART_BYTES } from '../src/files/limits.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { addGrant, addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { filesPath, openPut, putChunk, seedReadFile, uploadFile, type Created } from './helpers/files.ts';
import {
  call, logLines, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const SENTINEL_NAME = 'Zqxj Party Of Twelve.csv';

let server: TownwiseTestServer;
let blobs: MemoryFileBlobs;

interface Team { orgId: string; admin: TestSession; member: TestSession; memberEmail: string; other: TestSession }
let team: Team;

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  server = await startTownwiseServer({ files: blobs });
  const orgId = await createOrg(server, { name: 'Files Kitchen' });
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
  const otherEmail = `other-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, adminEmail);
  const member = await signIn(server, memberEmail);
  const other = await signIn(server, otherEmail);
  await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(server, { orgId, userId: member.userId, email: memberEmail });
  await addSeat(server, { orgId, userId: other.userId, email: otherEmail });
  team = { orgId, admin, member, memberEmail, other };
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

function newLocation(): Promise<string> {
  return addLocation(server, { orgId: team.orgId, name: `Room ${randomUUID().slice(0, 6)}` });
}

function csv(rows: number, seed = 'a'): Buffer {
  const lines = ['Date,Guests,Net Sales'];
  for (let index = 0; index < rows; index += 1) lines.push(`2025-01-${String((index % 28) + 1).padStart(2, '0')},${String(index)},${seed}`);
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

async function create(locationId: string, session: TestSession, body: Record<string, unknown>): Promise<Response> {
  return call(server, filesPath(locationId), { session, json: body });
}

async function created(locationId: string, session: TestSession, sizeBytes: number, name = 'sales.csv'): Promise<Created> {
  const res = await create(locationId, session, { name, sizeBytes, purpose: 'history' });
  expect(res.status).toBe(201);
  return await res.json() as Created;
}

async function errorOf(res: Response | { status: number; json: () => unknown }): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

function fileDoc(fileId: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(fileId) });
}

describe('uploading a file', () => {
  it('creates a session, takes the chunk, and stores the file with its kind and fingerprint, naming it nowhere but the row', async () => {
    const locationId = await newLocation();
    server.logs.length = 0;
    const bytes = csv(5);
    const res = await create(locationId, team.member, { name: SENTINEL_NAME, sizeBytes: bytes.length, purpose: 'history' });
    expect(res.status).toBe(201);
    const body = await res.json() as Created;
    expect(body.file).toMatchObject({
      name: SENTINEL_NAME, status: 'uploading', kind: 'text', sizeBytes: bytes.length,
      upload: { chunkSize: CHUNK_BYTES, chunkCount: 1, receivedBytes: 0, nextChunk: 0 },
    });
    expect(body.import.status).toBe('open');
    expect(body.limits).toMatchObject({ maxFileBytes: MAX_FILE_BYTES, chunkSize: CHUNK_BYTES, filesLeftInImport: 49 });

    const sent = await putChunk(server, filesPath(locationId, `/${body.file.id}/chunks/0`), team.member, bytes);
    expect(sent.status).toBe(200);
    expect(sent.json()).toEqual({ index: 0, receivedBytes: bytes.length, chunksReceived: 1 });

    const done = await call(server, filesPath(locationId, `/${body.file.id}/complete`), { session: team.member, json: {} });
    expect(done.status).toBe(200);
    const stored = (await done.json() as { file: FileView }).file;
    expect(stored).toMatchObject({ status: 'stored', kind: 'text', upload: null, canDownloadRaw: true, canDownloadClean: false });
    const doc = await fileDoc(body.file.id);
    expect(doc).toMatchObject({ status: 'stored', upload: null });
    expect(typeof doc?.fingerprint).toBe('string');
    expect([...blobs.raw.values()].some((blob) => blob.equals(bytes))).toBe(true);
    // The blob's name is ids only.
    expect([...blobs.raw.keys()].every((name) => !name.includes('Zqxj'))).toBe(true);

    const events = (await auditEvents(server)).filter((event) => event.action === 'file.uploaded');
    expect(events.at(-1)).toMatchObject({ target: { type: 'file', id: body.file.id }, details: { locationId, kind: 'text', sizeBytes: bytes.length } });
    const everything = JSON.stringify([...server.logs, ...await auditEvents(server)]);
    expect(everything).not.toContain('Zqxj');
    expect(logLines(server).map((line) => line.msg)).toEqual(expect.arrayContaining(['townwise.file_upload_started', 'townwise.file_stored']));
  });

  it('takes a file of several chunks in order, and a chunk sent again replaces the first', async () => {
    const locationId = await newLocation();
    const bytes = Buffer.alloc(CHUNK_BYTES + 10, 0x61);
    bytes.write('Date,Guests\n', 0);
    const { file } = await created(locationId, team.member, bytes.length);
    expect(file.upload).toMatchObject({ chunkCount: 2 });
    const first = filesPath(locationId, `/${file.id}/chunks/0`);
    expect((await putChunk(server, first, team.member, Buffer.alloc(CHUNK_BYTES, 0x62))).status).toBe(200);
    expect((await putChunk(server, first, team.member, bytes.subarray(0, CHUNK_BYTES))).status).toBe(200);
    expect((await putChunk(server, filesPath(locationId, `/${file.id}/chunks/1`), team.member, bytes.subarray(CHUNK_BYTES))).json())
      .toEqual({ index: 1, receivedBytes: bytes.length, chunksReceived: 2 });
    expect((await call(server, filesPath(locationId, `/${file.id}/complete`), { session: team.member, json: {} })).status).toBe(200);
    const blob = [...blobs.raw.entries()].find(([name]) => name.endsWith(file.id))?.[1];
    expect(blob?.equals(bytes)).toBe(true);
  });

  it('refuses a bad create in order: shape, purpose, location, size, then the caps', async () => {
    const locationId = await newLocation();
    const ok = { name: 'a.csv', sizeBytes: 10, purpose: 'history' };
    expect(await errorOf(await create(locationId, team.member, { ...ok, extra: 1 }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await create(locationId, team.member, { ...ok, name: '\u0007' }))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await create(locationId, team.member, { ...ok, purpose: 'calendar' }))).toEqual({ status: 400, error: 'purpose_unavailable' });
    expect(await errorOf(await create(new Types.ObjectId().toHexString(), team.member, ok))).toEqual({ status: 404, error: 'not_found' });
    const big = await create(locationId, team.member, { ...ok, sizeBytes: MAX_FILE_BYTES + 1 });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: 'file_too_large', maxBytes: MAX_FILE_BYTES });
  });

  it('refuses the eleventh unfinished upload in a location, and the 51st file of an import', async () => {
    const locationId = await newLocation();
    for (let index = 0; index < 10; index += 1) await created(locationId, team.member, 10, `f${String(index)}.csv`);
    expect(await errorOf(await create(locationId, team.member, { name: 'g.csv', sizeBytes: 10, purpose: 'history' })))
      .toEqual({ status: 409, error: 'too_many_uploading' });
    await server.connection.collection('tw_files').updateMany({ locationId: new Types.ObjectId(locationId) }, { $set: { status: 'stored', upload: null } });
    const importId = (await server.connection.collection('tw_imports').findOne({ locationId: new Types.ObjectId(locationId) }))?._id;
    const docs = Array.from({ length: 40 }, () => ({
      orgId: new Types.ObjectId(team.orgId), locationId: new Types.ObjectId(locationId), importId, status: 'stored', sizeBytes: 1, rawDeletedAt: null,
    }));
    await server.connection.collection('tw_files').insertMany(docs);
    expect(await errorOf(await create(locationId, team.member, { name: 'h.csv', sizeBytes: 10, purpose: 'history' })))
      .toEqual({ status: 409, error: 'import_full' });
  });

  it('counts an upload session past its expiry toward no cap: uploading, the import, the location or stored bytes', async () => {
    const orgId = await createOrg(server, { name: `Abandoned ${randomUUID().slice(0, 6)}` });
    const email = `abandoned-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId, userId: session.userId, email });
    const locationId = await addLocation(server, { orgId, name: 'Abandoned Room' });
    for (let index = 0; index < 10; index += 1) await created(locationId, session, 10, `f${String(index)}.csv`);
    // Ten sessions left a day ago, one of them as large as the organization's whole allowance.
    await server.connection.collection('tw_files').updateMany({ locationId: new Types.ObjectId(locationId) }, {
      $set: { 'upload.expiresAt': new Date(server.clock.now().getTime() - 1000) },
    });
    await server.connection.collection('tw_files').updateOne({ locationId: new Types.ObjectId(locationId) }, { $set: { sizeBytes: 5 * 1024 ** 3 } });
    const res = await create(locationId, session, { name: 'g.csv', sizeBytes: 10, purpose: 'history' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ limits: { filesLeftInImport: 49, storedBytesLeft: 5 * 1024 ** 3 - 10 } });
  });

  it('refuses past the organization’s stored bytes, and past its daily bytes across two people, saying when it resets', async () => {
    const orgId = await createOrg(server, { name: `Caps ${randomUUID().slice(0, 6)}` });
    const aEmail = `a-${randomUUID().slice(0, 8)}@example.test`;
    const bEmail = `b-${randomUUID().slice(0, 8)}@example.test`;
    const a = await signIn(server, aEmail);
    const b = await signIn(server, bEmail);
    await addSeat(server, { orgId, userId: a.userId, email: aEmail });
    await addSeat(server, { orgId, userId: b.userId, email: bEmail });
    const locationId = await addLocation(server, { orgId, name: 'Caps Room' });
    // Earlier uploads today left 100 bytes of the day's allowance.
    await server.connection.collection('tw_upload_days').insertOne({
      orgId: new Types.ObjectId(orgId), day: '2026-06-01', bytes: DAILY_UPLOAD_BYTES - 100, updatedAt: server.clock.now(),
    });
    expect((await create(locationId, a, { name: 'a.csv', sizeBytes: 50, purpose: 'history' })).status).toBe(201);
    expect((await create(locationId, b, { name: 'b.csv', sizeBytes: 50, purpose: 'history' })).status).toBe(201);
    const over = await create(locationId, b, { name: 'c.csv', sizeBytes: 1, purpose: 'history' });
    expect(over.status).toBe(409);
    expect(await over.json()).toMatchObject({ error: 'daily_upload_limit', resetsAt: '2026-06-02T00:00:00.000Z' });

    await server.connection.collection('tw_files').insertOne({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), status: 'read', sizeBytes: 5 * 1024 ** 3, rawDeletedAt: null,
    });
    await server.connection.collection('tw_upload_days').deleteMany({ orgId: new Types.ObjectId(orgId) });
    const full = await create(locationId, a, { name: 'd.csv', sizeBytes: 1, purpose: 'history' });
    expect(full.status).toBe(409);
    expect(await full.json()).toMatchObject({ error: 'storage_full', storedBytesLeft: 0 });
  });

  it('refuses a chunk with the wrong length, out of range, from another person, or in view-as; and closes the connection', async () => {
    const locationId = await newLocation();
    const bytes = csv(3);
    const { file } = await created(locationId, team.member, bytes.length);
    const path = filesPath(locationId, `/${file.id}/chunks/0`);
    const short = await putChunk(server, path, team.member, bytes.subarray(1));
    expect(short.status).toBe(400);
    expect(short.headers.connection).toBe('close');
    expect((await putChunk(server, path, team.member, bytes, null)).status).toBe(400);
    expect((await putChunk(server, filesPath(locationId, `/${file.id}/chunks/1`), team.member, bytes)).status).toBe(400);
    expect((await putChunk(server, filesPath(locationId, `/${file.id}/chunks/x`), team.member, bytes)).status).toBe(400);
    const stranger = await putChunk(server, path, team.other, bytes);
    expect({ status: stranger.status, error: stranger.json<{ error: string }>().error }).toEqual({ status: 403, error: 'forbidden' });
    expect((await fileDoc(file.id))?.upload).toMatchObject({ chunks: [null] });
  });

  it('answers 409 chunks_missing listing what has not arrived, and 410 once the session expired', async () => {
    const locationId = await newLocation();
    const { file } = await created(locationId, team.member, CHUNK_BYTES * 2);
    const missing = await call(server, filesPath(locationId, `/${file.id}/complete`), { session: team.member, json: {} });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: 'chunks_missing', missing: [0, 1] });
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(file.id) }, { $set: { 'upload.expiresAt': new Date(0) } });
    const late = await putChunk(server, filesPath(locationId, `/${file.id}/chunks/0`), team.member, Buffer.alloc(CHUNK_BYTES));
    expect(late.status).toBe(410);
  });

  it('removes a second copy of a file already stored for the location: 409 file_duplicate naming the first', async () => {
    const locationId = await newLocation();
    const bytes = csv(4, 'dup');
    const first = await uploadFile(server, locationId, team.member, 'one.csv', bytes);
    expect(first.status).toBe(200);
    const before = blobs.raw.size;
    const second = await uploadFile(server, locationId, team.admin, 'two.csv', bytes);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ error: 'file_duplicate', fileId: first.body.file?.id });
    expect(blobs.raw.size).toBe(before);
    expect(await server.connection.collection('tw_files').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(1);
  });

  it('cancels an unfinished upload: staged chunks are discarded and its bytes given back', async () => {
    const locationId = await newLocation();
    const bytes = csv(3, 'cancel');
    const { file } = await created(locationId, team.member, bytes.length);
    expect((await putChunk(server, filesPath(locationId, `/${file.id}/chunks/0`), team.member, bytes)).status).toBe(200);
    const usedBefore = (await server.connection.collection('tw_upload_days').findOne({ orgId: new Types.ObjectId(team.orgId) }))?.bytes as number;
    const res = await call(server, filesPath(locationId, `/${file.id}`), { session: team.member, method: 'DELETE' });
    expect(await res.json()).toEqual({ deleted: true, daysKept: 0 });
    expect([...blobs.staged.keys()].some((name) => name.endsWith(file.id))).toBe(false);
    expect(await fileDoc(file.id)).toBeNull();
    const usedAfter = (await server.connection.collection('tw_upload_days').findOne({ orgId: new Types.ObjectId(team.orgId) }))?.bytes as number;
    expect(usedBefore - usedAfter).toBe(bytes.length);
  });

  it('queues a file that completes after its import started', async () => {
    const locationId = await newLocation();
    const first = await uploadFile(server, locationId, team.member, 'a.csv', csv(2, 'first'));
    const importId = (first.body.import as { id: string }).id;
    const later = await created(locationId, team.member, csv(2, 'later').length, 'b.csv');
    expect(later.import.id).toBe(importId);
    expect((await call(server, `/api/org/locations/${locationId}/imports/${importId}/start`, { session: team.member, json: {} })).status).toBe(202);
    expect((await putChunk(server, filesPath(locationId, `/${later.file.id}/chunks/0`), team.member, csv(2, 'later'))).status).toBe(200);
    const done = await call(server, filesPath(locationId, `/${later.file.id}/complete`), { session: team.member, json: {} });
    expect((await done.json() as { file: FileView }).file.status).toBe('queued');
  });

  describe('a file that completes after its import finished', () => {
    async function lateFile(locationId: string): Promise<{ fileId: string; importId: string }> {
      const first = await uploadFile(server, locationId, team.member, 'a.csv', csv(2, 'first'));
      const importId = (first.body.import as { id: string }).id;
      const later = await created(locationId, team.member, csv(2, 'late').length, 'late.csv');
      await call(server, `/api/org/locations/${locationId}/imports/${importId}/start`, { session: team.member, json: {} });
      // The reader finished the import while this file was still uploading.
      await server.connection.collection('tw_imports').updateOne({ _id: new Types.ObjectId(importId) }, {
        $set: { status: 'done', finishedAt: server.clock.now() }, $unset: { activeLocation: '' },
      });
      expect((await putChunk(server, filesPath(locationId, `/${later.file.id}/chunks/0`), team.member, csv(2, 'late'))).status).toBe(200);
      return { fileId: later.file.id, importId };
    }

    it('starts a new import of its own and is queued in it', async () => {
      const locationId = await newLocation();
      const { fileId, importId } = await lateFile(locationId);
      const done = await call(server, filesPath(locationId, `/${fileId}/complete`), { session: team.member, json: {} });
      const body = await done.json() as { file: FileView; import: { id: string; status: string } };
      expect(body.import.id).not.toBe(importId);
      expect(body).toMatchObject({ file: { status: 'queued', importId: body.import.id }, import: { status: 'queued' } });
    });

    it('joins another person’s open import as stored, leaving it for them to start', async () => {
      const locationId = await newLocation();
      const { fileId, importId } = await lateFile(locationId);
      const theirs = await uploadFile(server, locationId, team.other, 'theirs.csv', csv(3, 'theirs'));
      const openId = (theirs.body.import as { id: string }).id;
      expect(openId).not.toBe(importId);
      const done = await call(server, filesPath(locationId, `/${fileId}/complete`), { session: team.member, json: {} });
      expect(await done.json()).toMatchObject({ file: { status: 'stored', importId: openId }, import: { id: openId, status: 'open' } });
      expect(await fileDoc(theirs.body.file?.id ?? '')).toMatchObject({ status: 'stored' });
    });
  });
});

describe('back-pressure', () => {
  it('answers 503 uploads_busy with Retry-After: 2 past 12 chunk streams on a replica, and a client abort records nothing', async () => {
    const locationId = await newLocation();
    const { file } = await created(locationId, team.member, CHUNK_BYTES);
    const path = filesPath(locationId, `/${file.id}/chunks/0`);
    const held = Array.from({ length: MAX_CHUNK_STREAMS }, () => openPut(server, path, team.member, CHUNK_BYTES));
    for (const { req } of held) req.write(Buffer.alloc(1024));
    // Every held stream reaches the handler before the extra one is sent.
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    const busy = await putChunk(server, path, team.member, Buffer.alloc(CHUNK_BYTES));
    expect(busy.status).toBe(503);
    expect(busy.headers['retry-after']).toBe('2');
    expect(busy.json()).toMatchObject({ error: 'uploads_busy' });
    for (const { req, response } of held) {
      response.catch(() => undefined);
      req.destroy();
    }
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect((await fileDoc(file.id))?.upload).toMatchObject({ chunks: [null] });
    // The gate is free again.
    expect((await putChunk(server, path, team.member, Buffer.alloc(CHUNK_BYTES))).status).toBe(200);
  });
});

describe('downloads and deletion', () => {
  it('streams the original to its uploader and an org admin, in 32 MiB parts on request, with safe headers', async () => {
    const locationId = await newLocation();
    const raw = Buffer.from('Date,Guests\r\n2026-05-01,10\r\n', 'utf8');
    const fileId = await seedReadFile(server, blobs, {
      orgId: team.orgId, locationId, uploadedBy: team.member.userId, name: 'Sales é.csv', raw, clean: 'date,guests,net_sales\r\n2026-05-01,10,\r\n',
    });
    const res = await call(server, filesPath(locationId, `/${fileId}/raw`), { session: team.member });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(raw)).toBe(true);
    expect(Object.fromEntries(['content-type', 'content-length', 'content-disposition', 'x-content-type-options', 'cache-control', 'content-security-policy']
      .map((name) => [name, res.headers.get(name)]))).toEqual({
      'content-type': 'application/octet-stream',
      'content-length': String(raw.length),
      'content-disposition': `attachment; filename="Sales e.csv"; filename*=UTF-8''Sales%20%C3%A9.csv`,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    const part = await call(server, filesPath(locationId, `/${fileId}/raw?part=0`), { session: team.admin });
    expect(Buffer.from(await part.arrayBuffer()).equals(raw.subarray(0, RAW_PART_BYTES))).toBe(true);
    expect((await call(server, filesPath(locationId, `/${fileId}/raw?part=1`), { session: team.admin })).status).toBe(400);
    expect(await errorOf(await call(server, filesPath(locationId, `/${fileId}/raw`), { session: team.other }))).toEqual({ status: 403, error: 'forbidden' });
    const clean = await call(server, filesPath(locationId, `/${fileId}/clean`), { session: team.other });
    expect(clean.status).toBe(200);
    expect(clean.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(clean.headers.get('content-disposition')).toBe(`attachment; filename="Sales e-townwise.csv"; filename*=UTF-8''Sales%20%C3%A9-townwise.csv`);
    expect(await clean.text()).toBe('date,guests,net_sales\r\n2026-05-01,10,\r\n');
  });

  it('deletes only the original: the cleaned copy and days stay, the name becomes the kind, and the original is gone', async () => {
    const locationId = await newLocation();
    const fileId = await seedReadFile(server, blobs, {
      orgId: team.orgId, locationId, uploadedBy: team.member.userId, name: SENTINEL_NAME, raw: Buffer.from('x'), clean: 'date\r\n',
    });
    expect(await errorOf(await call(server, filesPath(locationId, `/${fileId}/raw`), { session: team.other, method: 'DELETE' })))
      .toEqual({ status: 403, error: 'forbidden' });
    const res = await call(server, filesPath(locationId, `/${fileId}/raw`), { session: team.member, method: 'DELETE' });
    expect(await res.json()).toEqual({ deleted: true });
    const view = (await (await call(server, filesPath(locationId, `/${fileId}`), { session: team.member })).json() as { file: FileView }).file;
    expect(view).toMatchObject({ name: 'CSV or text file', rawAvailable: false, rawExpiresAt: null, hasClean: true, canDownloadRaw: false });
    expect((await call(server, filesPath(locationId, `/${fileId}/raw`), { session: team.member })).status).toBe(410);
    expect((await call(server, filesPath(locationId, `/${fileId}/clean`), { session: team.member })).status).toBe(200);
    expect((await call(server, filesPath(locationId, `/${fileId}/raw`), { session: team.member, method: 'DELETE' })).status).toBe(410);
    const event = (await auditEvents(server)).filter((candidate) => candidate.action === 'file.raw_deleted').at(-1);
    expect(event).toMatchObject({ details: { locationId, kind: 'text' } });
    expect(JSON.stringify(await auditEvents(server))).not.toContain('Zqxj');
  });

  it('keeps the original of a file not yet read: 409 file_busy while it is stored or queued', async () => {
    const locationId = await newLocation();
    const stored = await uploadFile(server, locationId, team.member, 'unread.csv', csv(2, 'unread'));
    const fileId = stored.body.file?.id ?? '';
    expect(stored.body.file).toMatchObject({ status: 'stored', canDeleteRaw: false, canDelete: true });
    expect(await errorOf(await call(server, filesPath(locationId, `/${fileId}/raw`), { session: team.member, method: 'DELETE' })))
      .toEqual({ status: 409, error: 'file_busy' });
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(fileId) }, { $set: { status: 'queued' } });
    expect(await errorOf(await call(server, filesPath(locationId, `/${fileId}/raw`), { session: team.member, method: 'DELETE' })))
      .toEqual({ status: 409, error: 'file_busy' });
    expect(await fileDoc(fileId)).toMatchObject({ rawDeletedAt: null });
  });

  it('deletes a file: original, cleaned copy and row, saying how many days stay', async () => {
    const locationId = await newLocation();
    const fileId = await seedReadFile(server, blobs, {
      orgId: team.orgId, locationId, uploadedBy: team.member.userId, name: 'gone.csv', raw: Buffer.from('y'), clean: 'date\r\n',
    });
    const res = await call(server, filesPath(locationId, `/${fileId}`), { session: team.admin, method: 'DELETE' });
    expect(await res.json()).toEqual({ deleted: true, daysKept: 1 });
    expect([...blobs.raw.keys(), ...blobs.clean.keys()].some((name) => name.includes(fileId))).toBe(false);
    expect((await call(server, filesPath(locationId, `/${fileId}`), { session: team.admin })).status).toBe(404);
    expect((await auditEvents(server)).filter((event) => event.action === 'file.deleted').at(-1)).toMatchObject({
      target: { type: 'file', id: fileId }, details: { locationId, kind: 'text', reason: 'owner' },
    });
  });

  it('lists newest first, leaving out other people’s unfinished uploads', async () => {
    const locationId = await newLocation();
    const mine = await created(locationId, team.member, 10, 'mine.csv');
    await created(locationId, team.other, 10, 'theirs.csv');
    const stored = await uploadFile(server, locationId, team.other, 'done.csv', csv(2, 'listed'));
    const res = await call(server, filesPath(locationId), { session: team.member });
    const files = (await res.json() as { files: FileView[] }).files;
    expect(files.map((file) => file.id)).toEqual([stored.body.file?.id, mine.file.id]);
  });
});

describe('view-as', () => {
  let staff: TestSession;
  afterEach(async () => { await removeStaffFactor(server); });

  it('shows files without names or downloads, and refuses every write', async () => {
    const locationId = await newLocation();
    const fileId = await seedReadFile(server, blobs, {
      orgId: team.orgId, locationId, uploadedBy: team.member.userId, name: SENTINEL_NAME, raw: Buffer.from('z'), clean: 'date\r\n',
    });
    staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: team.member.userId, orgId: team.orgId });
    const list = await call(server, filesPath(locationId), { session: staff });
    const view = (await list.json() as { files: FileView[] }).files[0];
    expect(view).toMatchObject({ name: null, canDownloadRaw: false, canDownloadClean: false, canDelete: false, canDeleteRaw: false });
    expect(await errorOf(await call(server, filesPath(locationId, `/${fileId}/raw`), { session: staff }))).toEqual({ status: 403, error: 'view_as_no_download' });
    expect(await errorOf(await call(server, filesPath(locationId, `/${fileId}/clean`), { session: staff }))).toEqual({ status: 403, error: 'view_as_no_download' });
    expect(await errorOf(await create(locationId, staff, { name: 'a.csv', sizeBytes: 1, purpose: 'history' }))).toEqual({ status: 403, error: 'view_as_read_only' });
    expect((await putChunk(server, filesPath(locationId, `/${fileId}/chunks/0`), staff, Buffer.from('a'))).status).toBe(403);
    expect(await errorOf(await call(server, filesPath(locationId, `/${fileId}`), { session: staff, method: 'DELETE' }))).toEqual({ status: 403, error: 'view_as_read_only' });
  });

  it('lists a ZIP’s entries without their paths', async () => {
    const locationId = await newLocation();
    const fileId = await seedReadFile(server, blobs, {
      orgId: team.orgId, locationId, uploadedBy: team.member.userId, name: 'export.zip', raw: Buffer.from('z'), clean: 'date\r\n',
    });
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(fileId) }, { $set: { kind: 'zip' } });
    await server.connection.collection('tw_file_entries').insertOne({
      orgId: new Types.ObjectId(team.orgId), locationId: new Types.ObjectId(locationId), fileId: new Types.ObjectId(fileId), index: 0,
      path: SENTINEL_NAME, depth: 1, kind: 'text', sizeBytes: 1, status: 'used', outcome: null, family: null, dayCount: null,
    });
    const own = await call(server, filesPath(locationId, `/${fileId}/entries`), { session: team.member });
    expect(await own.json()).toEqual({ entries: [expect.objectContaining({ index: 0, path: SENTINEL_NAME, status: 'used' })], next: null });
    staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: team.member.userId, orgId: team.orgId });
    const viewed = await call(server, filesPath(locationId, `/${fileId}/entries`), { session: staff });
    expect(await viewed.json()).toEqual({ entries: [expect.objectContaining({ index: 0, path: null, status: 'used' })], next: null });
  });
});

describe('isolation', () => {
  it('answers 404 for another organization’s location, file and import on every route', async () => {
    const otherOrg = await createOrg(server, { name: `Other ${randomUUID().slice(0, 6)}` });
    const otherEmail = `x-${randomUUID().slice(0, 8)}@example.test`;
    const outsider = await signIn(server, otherEmail);
    await addSeat(server, { orgId: otherOrg, userId: outsider.userId, email: otherEmail, role: 'org_admin' });
    const outsiderLocation = await addLocation(server, { orgId: otherOrg, name: 'Elsewhere' });

    const locationId = await newLocation();
    const fileId = await seedReadFile(server, blobs, {
      orgId: team.orgId, locationId, uploadedBy: team.member.userId, name: 'secret.csv', raw: Buffer.from('s'), clean: 'date\r\n',
    });
    const importId = (await fileDoc(fileId))?.importId as Types.ObjectId;
    const theirs = [`/api/org/locations/${locationId}`, `/api/org/locations/${outsiderLocation}`];
    for (const base of theirs) {
      const ofLocation = base.endsWith(locationId) ? [
        { method: 'GET', path: `${base}/files` },
        { method: 'POST', path: `${base}/files`, json: { name: 'a.csv', sizeBytes: 1, purpose: 'history' } },
        { method: 'GET', path: `${base}/imports/current` },
      ] : [];
      const asked = [
        ...ofLocation,
        { method: 'GET', path: `${base}/files/${fileId}` },
        { method: 'GET', path: `${base}/files/${fileId}/raw` },
        { method: 'GET', path: `${base}/files/${fileId}/entries` },
        { method: 'GET', path: `${base}/files/${fileId}/clean` },
        { method: 'POST', path: `${base}/files/${fileId}/complete`, json: {} },
        { method: 'DELETE', path: `${base}/files/${fileId}/raw` },
        { method: 'DELETE', path: `${base}/files/${fileId}` },
        { method: 'GET', path: `${base}/imports/${importId.toHexString()}` },
        { method: 'POST', path: `${base}/imports/${importId.toHexString()}/start`, json: {} },
        { method: 'POST', path: `${base}/imports/${importId.toHexString()}/answer`, json: { questionId: 'q', choice: 'not_sure' } },
      ];
      for (const request of asked) {
        const init = { session: outsider, method: request.method, ...(request.json === undefined ? {} : { json: request.json }) };
        const res = await call(server, request.path, init);
        // The outsider's own location has no such file or import; the team's location is not theirs.
        expect({ path: request.path, method: request.method, ...(await errorOf(res)) }).toMatchObject({ status: 404, error: 'not_found' });
      }
      const chunk = await putChunk(server, `${base}/files/${fileId}/chunks/0`, outsider, Buffer.from('a'));
      expect(chunk.status).toBe(404);
    }
    expect(blobs.raw.has(`${team.orgId}/${locationId}/${fileId}`)).toBe(true);
  });
});
