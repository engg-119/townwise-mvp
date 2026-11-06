// The daily file sweep (spec 11A, retention), each job against the database with a fake clock: unfinished uploads
// after 24 hours, originals after a year, never-read drops after 30 days, staff purges of files that were busy, day
// counters after 3 days, and orphan blobs a day old. One replica a day, under a lease.
import { randomUUID } from 'node:crypto';

import { createLogger } from '@ckeith26/server-core';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { cleanBlobName, rawBlobName } from '../src/files/blobs.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { createFileSweeper, type FileSweeper } from '../src/files/sweeper.ts';
import { createTownwiseStores } from '../src/stores/index.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { seedReadFile } from './helpers/files.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const DAY = 24 * 60 * 60 * 1000;
const SENTINEL_NAME = 'Zqxj Party Of Twelve.csv';

let server: TownwiseTestServer;
let blobs: MemoryFileBlobs;
let sweeper: FileSweeper;
const logs: string[] = [];
let orgId: string;
let locationId: string;
let scope: OrgScope;

beforeAll(async () => {
  blobs = createMemoryFileBlobs(() => server.clock.now());
  server = await startTownwiseServer({ files: blobs });
  const logger = createLogger({ LOG_LEVEL: 'info' }, { destination: { write: (line: string) => { logs.push(line); } } });
  sweeper = createFileSweeper({ connection: server.connection, stores: createTownwiseStores(server.connection), blobs, logger, now: server.clock.now, replicaId: 'one' });
  orgId = await createOrg(server, { name: 'Sweep Kitchen' });
  locationId = await addLocation(server, { orgId, name: 'Main' });
  scope = { orgId } as unknown as OrgScope;
});
afterAll(async () => { await server.close(); });
beforeEach(() => {
  // A day since the last sweep, so this one is due.
  server.clock.advance(DAY + 60_000);
  logs.length = 0;
});

const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
function fileDoc(id: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_files').findOne({ _id: oid(id) });
}

async function seed(name = SENTINEL_NAME): Promise<string> {
  return seedReadFile(server, blobs, { orgId, locationId, uploadedBy: 'user-1', name, raw: Buffer.from('r'), clean: 'date\r\n' });
}

describe('the daily file sweep', () => {
  it('discards upload sessions past their 24 hours, and keeps live ones', async () => {
    const expired = new Types.ObjectId();
    const live = new Types.ObjectId();
    const importId = new Types.ObjectId();
    for (const [_id, expiresAt] of [[expired, new Date(server.clock.now().getTime() - 1000)], [live, new Date(server.clock.now().getTime() + DAY)]] as const) {
      await server.connection.collection('tw_files').insertOne({
        _id, orgId: oid(orgId), locationId: oid(locationId), importId, purpose: 'history', uploadedBy: 'user-1', uploaderRole: 'member',
        uploadedAt: server.clock.now(), name: 'u.csv', kind: 'text', sizeBytes: 3, fingerprint: null, status: 'uploading', outcome: null,
        upload: { chunkSize: 8, chunkCount: 1, chunks: [null], head: null, expiresAt }, progress: null, readStartedAt: null, readMs: null,
        answers: {}, uploadId: null, result: null, report: null, cleanBytes: null, rawDeletedAt: null, attempts: 0,
      });
      blobs.staged.set(rawBlobName(scope, { locationId, fileId: _id.toHexString() }), new Map([[0, Buffer.from('abc')]]));
    }
    expect(await sweeper.runOnce()).toMatchObject({ expiredUploads: 1 });
    expect(await fileDoc(expired.toHexString())).toBeNull();
    expect(blobs.staged.has(rawBlobName(scope, { locationId, fileId: expired.toHexString() }))).toBe(false);
    expect(await fileDoc(live.toHexString())).toMatchObject({ status: 'uploading' });
  });

  it('deletes originals a year after upload, keeping the cleaned copy and replacing the name', async () => {
    const old = await seed();
    const recent = await seed('recent.csv');
    await server.connection.collection('tw_files').updateOne({ _id: oid(old) }, { $set: { uploadedAt: new Date(server.clock.now().getTime() - 366 * DAY) } });
    expect(await sweeper.runOnce()).toMatchObject({ expiredOriginals: 1 });
    expect(await fileDoc(old)).toMatchObject({ name: 'CSV or text file', rawDeletedAt: expect.any(Date) as unknown });
    expect(blobs.raw.has(rawBlobName(scope, { locationId, fileId: old }))).toBe(false);
    expect(blobs.clean.has(cleanBlobName(scope, { locationId, fileId: old }))).toBe(true);
    expect(await fileDoc(recent)).toMatchObject({ rawDeletedAt: null });
    const lines = logs.join('\n');
    expect(lines).toContain('"by":"retention"');
    expect(lines).not.toContain('Zqxj');
  });

  it('deletes files dropped but never sent for reading after 30 days, with their import', async () => {
    const stale = new Types.ObjectId();
    await server.connection.collection('tw_imports').insertOne({
      _id: stale, orgId: oid(orgId), locationId: oid(locationId), createdBy: 'user-1', createdAt: server.clock.now(),
      lastDropAt: new Date(server.clock.now().getTime() - 31 * DAY), status: 'open', startedAt: null, finishedAt: null, question: null,
      appliedVersion: 0, drops: 1, lease: null, claimedAt: null, bytesRead: 0, msRead: 0,
    });
    const dropped = await seedReadFile(server, blobs, {
      orgId, locationId, uploadedBy: 'user-1', name: 'drop.csv', raw: Buffer.from('d'), clean: 'date\r\n', importId: stale.toHexString(),
    });
    await server.connection.collection('tw_files').updateOne({ _id: oid(dropped) }, { $set: { status: 'stored', cleanBytes: null } });
    expect(await sweeper.runOnce()).toMatchObject({ abandonedFiles: 1 });
    expect(await fileDoc(dropped)).toBeNull();
    expect(await server.connection.collection('tw_imports').findOne({ _id: stale })).toBeNull();
    expect(blobs.raw.has(rawBlobName(scope, { locationId, fileId: dropped }))).toBe(false);
  });

  it('finishes a staff purge of a file that was busy, once it is read', async () => {
    const flagged = await seed('flagged.csv');
    await server.connection.collection('tw_files').updateOne({ _id: oid(flagged) }, { $set: { purgeRaw: true } });
    expect(await sweeper.runOnce()).toMatchObject({ purged: 1 });
    expect(await fileDoc(flagged)).toMatchObject({ rawDeletedAt: expect.any(Date) as unknown });
    expect((await fileDoc(flagged))?.purgeRaw).toBeUndefined();
  });

  it('drops daily upload counters after 3 days', async () => {
    const today = server.clock.now().toISOString().slice(0, 10);
    const old = new Date(server.clock.now().getTime() - 4 * DAY).toISOString().slice(0, 10);
    await server.connection.collection('tw_upload_days').insertMany([
      { orgId: oid(orgId), day: today, bytes: 1, updatedAt: server.clock.now() },
      { orgId: oid(orgId), day: old, bytes: 1, updatedAt: server.clock.now() },
    ]);
    expect(await sweeper.runOnce()).toMatchObject({ uploadDays: 1 });
    expect(await server.connection.collection('tw_upload_days').find({ orgId: oid(orgId) }).map((doc) => doc.day as string).toArray()).toEqual([today]);
  });

  it('deletes blobs whose file row is gone once they are a day old, and never one with a row or a young one', async () => {
    const withRow = await seed('row.csv');
    const ghostOld = new Types.ObjectId().toHexString();
    const ghostYoung = new Types.ObjectId().toHexString();
    const name = (fileId: string): string => rawBlobName(scope, { locationId, fileId });
    blobs.raw.set(name(ghostOld), Buffer.from('o'));
    blobs.modified.set(`raw:${name(ghostOld)}`, new Date(server.clock.now().getTime() - 2 * DAY));
    blobs.raw.set(name(ghostYoung), Buffer.from('y'));
    blobs.modified.set(`raw:${name(ghostYoung)}`, server.clock.now());
    blobs.raw.set(`not-ours/${randomUUID()}`, Buffer.from('x'));
    const counts = await sweeper.runOnce();
    expect(counts?.orphans).toBe(1);
    expect(blobs.raw.has(name(ghostOld))).toBe(false);
    expect(blobs.raw.has(name(ghostYoung))).toBe(true);
    expect(blobs.raw.has(name(withRow))).toBe(true);
    expect([...blobs.raw.keys()].some((key) => key.startsWith('not-ours/'))).toBe(true);
  });

  it('runs once a day on one replica: not again the same day, and not on another replica meanwhile', async () => {
    expect(await sweeper.runOnce()).not.toBeNull();
    expect(await sweeper.runOnce()).toBeNull();
    const logger = createLogger({ LOG_LEVEL: 'info' }, { destination: { write: () => undefined } });
    const other = createFileSweeper({ connection: server.connection, stores: createTownwiseStores(server.connection), blobs, logger, now: server.clock.now, replicaId: 'two' });
    expect(await other.runOnce()).toBeNull();
    server.clock.advance(DAY);
    expect(await other.runOnce()).not.toBeNull();
  });
});
