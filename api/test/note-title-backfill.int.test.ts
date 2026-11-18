// The boot-time title backfill (D49): notes TownwiseAI made from a file before notes had titles are named once, exactly
// from the file's stored read, with their detail unchanged; an event no longer stored names nothing; a second run, or
// two at once, write nothing more; a note made after the change is never touched; only counts are logged. The model is
// a scripted fake: no call leaves the test. Every name is synthetic.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import type { FileReaderModel, ReaderAnswer } from '../src/files/extract/reader.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { backfillNoteTitles } from '../src/files/note-titles.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, logLines, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const EVENTS = [
  { title: 'Rehearsal dinner', startDate: '2026-06-14', endDate: '2026-06-14', kind: 'private_event', effect: 'closed', expectedGuests: 60, detail: 'party of 60' },
  { title: 'Harvest fair', startDate: '2026-06-20', endDate: '2026-06-20', kind: 'other', effect: 'more', expectedGuests: null, detail: '' },
];

let answers: ReaderAnswer[] = [];
const model: FileReaderModel = {
  readFile: () => Promise.resolve(answers.shift() ?? { kind: 'answered', costMicroUsd: 1000, output: calendar() }),
};

function calendar(): Record<string, unknown> {
  return { kind: 'calendar', confidence: 'high', summary: 'June events.', facts: [], events: EVENTS, days: [] };
}

const blobs = createMemoryFileBlobs();
let server: TownwiseTestServer;
let orgId: string;
let member: TestSession;

const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);
const scopeOf = (id: string): OrgScope => ({ orgId: id }) as unknown as OrgScope;
const notes = () => server.connection.collection('tw_notes');

beforeAll(async () => {
  server = await startTownwiseServer({ files: blobs, aiReader: { model } });
  orgId = await createOrg(server, { name: 'Backfill Tavern' });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  member = await signIn(server, email);
  await addSeat(server, { orgId, userId: member.userId, email, role: 'member' });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.aiReader?.settled();
  await server.redis.flushdb();
  await notes().deleteMany({});
  answers = [];
});

/** A stored file TownwiseAI read, whose two events became notes; then made to look as a note from before titles did. */
async function olderRead(): Promise<{ locationId: string; fileId: string; noteIds: string[] }> {
  const locationId = await addLocation(server, { orgId, name: `Room ${randomUUID().slice(0, 6)}` });
  const _id = new Types.ObjectId();
  const raw = Buffer.from('Date,Event\n2026-06-14,dinner\n');
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: oid(orgId), locationId: oid(locationId), importId: null, purpose: 'reference', uploadedBy: member.userId,
    uploaderRole: 'member', uploadedAt: server.clock.now(), name: 'events.csv', kind: 'text', sizeBytes: raw.length,
    fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference', progress: null,
    readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null, rawDeletedAt: null, attempts: 0,
  });
  const fileId = _id.toHexString();
  await blobs.writeRaw(scopeOf(orgId), { locationId, fileId }, raw, 'application/octet-stream');
  expect((await call(server, `/api/org/locations/${locationId}/data/f_${fileId}/ai`, { session: member, json: {} })).status).toBe(202);
  server.aiReader?.nudge();
  await server.aiReader?.settled();
  const made = await notes().find({ locationId: oid(locationId) }).sort({ startDate: 1 }).toArray();
  expect(made).toHaveLength(2);
  const noteIds = made.map((note) => note._id.toHexString());
  // Before titles, a note had no `title` key and its detail was "title: detail".
  await notes().updateOne({ _id: oid(noteIds[0] ?? '') }, { $unset: { title: 1 }, $set: { detail: 'Rehearsal dinner: party of 60' } });
  await notes().updateOne({ _id: oid(noteIds[1] ?? '') }, { $unset: { title: 1 }, $set: { detail: 'Harvest fair' } });
  return { locationId, fileId, noteIds };
}

function run(): ReturnType<typeof backfillNoteTitles> {
  return backfillNoteTitles({ connection: server.connection, stores: server.ctx.stores, logger: server.ctx.logger });
}

describe('backfillNoteTitles', () => {
  it('names an older note exactly from its read and leaves its detail; a second run writes nothing', async () => {
    const { noteIds } = await olderRead();
    server.logs.length = 0;
    expect(await run()).toEqual({ titled: 2, untitled: 0 });
    const after = await notes().find({ _id: { $in: noteIds.map(oid) } }).sort({ startDate: 1 }).toArray();
    expect(after.map((note) => ({ title: note.title as unknown, detail: note.detail as unknown }))).toEqual([
      { title: 'Rehearsal dinner', detail: 'Rehearsal dinner: party of 60' },
      { title: 'Harvest fair', detail: 'Harvest fair' },
    ]);
    expect(await run()).toEqual({ titled: 0, untitled: 0 });

    const lines = logLines(server).filter((line) => line.msg === 'townwise.note_titles_backfilled');
    expect(lines.map(({ notesTitled, notesUntitled }) => ({ notesTitled, notesUntitled }))).toEqual([
      { notesTitled: 2, notesUntitled: 0 }, { notesTitled: 0, notesUntitled: 0 },
    ]);
    expect(server.logs.join('\n')).not.toMatch(/Rehearsal|Harvest/);
  });

  it('gives null once the event is gone (the original deleted, or the file removed), and does not visit the note again', async () => {
    const purged = await olderRead();
    await server.connection.collection('tw_files').updateOne({ _id: oid(purged.fileId) }, { $set: { 'ai.result.events': [] } });
    const removed = await olderRead();
    await server.connection.collection('tw_files').deleteOne({ _id: oid(removed.fileId) });
    expect(await run()).toEqual({ titled: 0, untitled: 4 });
    const after = await notes().find({ _id: { $in: [...purged.noteIds, ...removed.noteIds].map(oid) } }).toArray();
    expect(after.map((note) => note.title as unknown)).toEqual([null, null, null, null]);
    expect(await run()).toEqual({ titled: 0, untitled: 0 });
  });

  it('two runs at once name each note once between them', async () => {
    await olderRead();
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.titled + b.titled).toBe(2);
  });

  it('never touches a note made after the change, a note the person typed, or another organization’s file', async () => {
    const { locationId, fileId } = await olderRead();
    await notes().updateMany({ locationId: oid(locationId) }, { $set: { title: null } });   // as every write since stores it
    const typed = new Types.ObjectId();
    const otherOrg = await createOrg(server, { name: 'Other Backfill Tavern' });
    const foreign = new Types.ObjectId();
    const now = server.clock.now();
    const older = { kind: 'closure', startDate: '2026-06-14', endDate: '2026-06-14', weekdays: null, effect: 'closed', expectedGuests: null, createdBy: 'fixture', createdAt: now, updatedAt: now };
    await notes().insertMany([
      { _id: typed, orgId: oid(orgId), locationId: oid(locationId), ...older, detail: 'Typed before titles' },
      // A note of another organization naming this file is never named from it.
      { _id: foreign, orgId: oid(otherOrg), locationId: oid(locationId), ...older, detail: null, source: { via: 'ai_file', fileId: oid(fileId) } },
    ]);
    expect(await run()).toEqual({ titled: 0, untitled: 1 });
    // `title: null` in a query also matches a missing key, so the stored null is asked for by its type.
    expect(await notes().countDocuments({ locationId: oid(locationId), title: { $type: 'null' } })).toBe(3);
    expect(await notes().findOne({ _id: typed })).not.toHaveProperty('title');
    expect(await notes().findOne({ _id: foreign })).toMatchObject({ title: null });
  });
});
