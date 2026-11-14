// Reading with TownwiseAI, the actions (spec 11A.9, D34) end to end against the database: notes from the answer's events
// (the person who asked as author, the file as source, duplicates, the 50 and 1,000 caps, the closed-note guard), daily
// totals as one upload when the file's text bears them out (only new days, for everyone), the summary item, the model
// update (a fake lab, decided by the requester's role now), a requester who left, retries after a throw, a file
// deleted or its original purged while it is read, ZIP input, the item's fields, and the undo route (a read that
// stopped part way too). The model is a scripted fake and the lab a fake runner: no call leaves the test. Every figure
// is synthetic.
import { randomUUID } from 'node:crypto';

import { createRateLimiter } from '@ckeith26/rate-limit';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import type { OnAiRead } from '../src/files/ai-reader.ts';
import type { FileBlobs } from '../src/files/blobs.ts';
import type { FileReaderModel, ReaderAnswer, ReaderRequest } from '../src/files/extract/reader.ts';
import { DAILY_UPLOAD_BYTES } from '../src/files/limits.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import type { DataItemView } from '../src/handlers/data.ts';
import type { NoteView } from '../src/handlers/notes.ts';
import {
  addChatUsage, addGrant, addLocation, addNote, addOpenAsAdminGrant, addSalesDay, addSeat, addUpload, auditEvents, createOrg,
} from './helpers/fixtures.ts';
import { fakeLabRunner, seedHistory, type FakeLabRunner } from './helpers/lab.ts';
import { xlsxOf, zipOf } from './helpers/zip.ts';
import {
  call, logLines, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const SENTINEL = 'Qvzx';

interface Day { date: string; guests: number | null; netSales: number | null }
interface Event { title: string; startDate: string; endDate: string; kind: string; effect: string; expectedGuests: number | null; detail: string }

const EVENT: Event = {
  title: 'Wedding dinner', startDate: '2026-06-14', endDate: '2026-06-14', kind: 'private_event', effect: 'more', expectedGuests: 80, detail: 'Back room',
};

function answer(over: Record<string, unknown> = {}): ReaderAnswer {
  return {
    kind: 'answered', costMicroUsd: 1000,
    output: { kind: 'calendar', confidence: 'high', summary: 'A list of June events.', facts: ['Three events in June'], events: [EVENT], days: [], ...over },
  };
}

function salesAnswer(days: readonly Day[], over: Record<string, unknown> = {}): ReaderAnswer {
  return answer({ kind: 'sales', summary: 'Daily totals for May.', facts: [], events: [], days, ...over });
}

/** A CSV of the days, net sales as dollars with thousands commas. */
function salesCsv(days: readonly Day[]): Buffer {
  const money = (value: number): string => `"$${value.toLocaleString('en-US', { minimumFractionDigits: 2 })}"`;
  return Buffer.from(['Date,Guests,Net Sales', ...days.map((day) => `${day.date},${String(day.guests ?? '')},${day.netSales === null ? '' : money(day.netSales)}`)].join('\n'));
}

/** `count` days from 2026-05-01, each with its own figures. */
function mayDays(count: number, from = 1): Day[] {
  return Array.from({ length: count }, (_, index) => ({
    date: `2026-05-${String(from + index).padStart(2, '0')}`, guests: 100 + from + index, netSales: 2000 + (from + index) * 10.25,
  }));
}

// ---- The fake model, blobs and lab -----------------------------------------------------------------------------------

let answers: ReaderAnswer[] = [];
const requests: ReaderRequest[] = [];
const model: FileReaderModel = {
  readFile(request) {
    requests.push(request);
    return Promise.resolve(answers.shift() ?? answer());
  },
};

const memory = createMemoryFileBlobs();
/** The next raw writes that fail (the summary item's blob), as a blob outage would. */
let failRawWrites = 0;
const blobs: FileBlobs = {
  ...memory,
  writeRaw: (...args) => {
    if (failRawWrites > 0) {
      failRawWrites -= 1;
      return Promise.reject(new Error('blob outage'));
    }
    return memory.writeRaw(...args);
  },
};

/** Runs before the actions (to delete the file, or suspend the organization), and how many runs throw after them. */
let before: ((orgId: string, fileId: string) => Promise<void>) | null = null;
let throwAfter = 0;
const around = (actions: OnAiRead): OnAiRead => async (scope, file, read) => {
  await before?.(scope.orgId, file.id);
  const end = await actions(scope, file, read);
  if (throwAfter > 0) {
    throwAfter -= 1;
    throw new Error('after the actions');
  }
  return end;
};

let server: TownwiseTestServer;
let noLab: TownwiseTestServer;
let runner: FakeLabRunner;

interface Team { orgId: string; admin: TestSession; adminEmail: string; member: TestSession; memberEmail: string; other: TestSession }
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
  return { orgId, admin, adminEmail, member, memberEmail, other };
}

beforeAll(async () => {
  runner = fakeLabRunner();
  // Each start drops the database, so both start before any fixture. Only the server a test nudges reads.
  noLab = await startTownwiseServer({ files: blobs, aiReader: { model } });
  server = await startTownwiseServer({ files: blobs, aiReader: { model, aroundOnRead: around }, labRunner: runner });
  team = await newTeam(`${SENTINEL} Org`);
});
afterAll(async () => {
  await server.close();
  await noLab.close();
});
beforeEach(async () => {
  answers = [];
  requests.length = 0;
  failRawWrites = 0;
  before = null;
  throwAfter = 0;
  runner.onStart = null;
  await server.redis.flushdb();
  await server.connection.collection('tw_files_usage').deleteMany({});
  await server.connection.collection('tw_upload_days').deleteMany({});
  await server.connection.collection('tw_files').updateMany({ 'ai.status': { $in: ['queued', 'reading'] } }, { $set: { 'ai.status': 'skipped' } });
});

const scopeOf = (orgId: string): OrgScope => ({ orgId }) as unknown as OrgScope;

function newLocation(orgId = team.orgId): Promise<string> {
  return addLocation(server, { orgId, name: `${SENTINEL} Room ${randomUUID().slice(0, 6)}` });
}

interface Seed { name?: string; kind?: string; raw?: Buffer; by?: TestSession; role?: 'org_admin' | 'member'; status?: string; uploadId?: string }

/** A finished stored file with its original, as Your data's item `f_<id>`. */
async function seedStored(locationId: string, seed: Seed = {}): Promise<string> {
  const _id = new Types.ObjectId();
  const raw = seed.raw ?? Buffer.from(`Date,Event\n2026-06-14,${SENTINEL} wedding\n`);
  const by = seed.by ?? team.member;
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: new Types.ObjectId(team.orgId), locationId: new Types.ObjectId(locationId), importId: null, purpose: 'reference',
    uploadedBy: by.userId, uploaderRole: seed.role ?? (by === team.admin ? 'org_admin' : 'member'), uploadedAt: server.clock.now(),
    name: seed.name ?? `${SENTINEL} events.csv`, kind: seed.kind ?? 'text', sizeBytes: raw.length, fingerprint: _id.toHexString().padStart(64, '0'),
    upload: null, status: seed.status ?? 'kept', outcome: 'reference', progress: null, readStartedAt: null, readMs: null, answers: {},
    uploadId: seed.uploadId === undefined ? null : new Types.ObjectId(seed.uploadId), result: null, report: null, cleanBytes: null,
    rawDeletedAt: null, attempts: 0,
  });
  await memory.writeRaw(scopeOf(team.orgId), { locationId, fileId: _id.toHexString() }, raw, 'application/octet-stream');
  return _id.toHexString();
}

const itemPath = (locationId: string, ref: string): string => `/api/org/locations/${locationId}/data/${ref}`;

/** Asks TownwiseAI to read the file as `session`, then runs the reader until it has nothing left. */
async function readAs(session: TestSession, locationId: string, fileId: string, on = server): Promise<void> {
  const res = await call(on, `${itemPath(locationId, `f_${fileId}`)}/ai`, { session, json: {} });
  expect(res.status).toBe(202);
  on.aiReader?.nudge();
  await on.aiReader?.settled();
}

/** Runs the reader again as if every backoff had passed (notBefore cleared rather than the clock moved on). */
async function rerun(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await server.connection.collection('tw_files').updateMany({ 'ai.status': 'queued' }, { $set: { 'ai.notBefore': null } });
    server.aiReader?.nudge();
    await server.aiReader?.settled();
  }
}

/** A new person with a seat in the team's organization. */
async function newPerson(role: 'org_admin' | 'member'): Promise<TestSession & { email: string }> {
  const email = `person-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId: team.orgId, userId: session.userId, email, role });
  return { ...session, email };
}

/** Asks for the read as `session` without running the reader. */
async function ask(session: TestSession, locationId: string, fileId: string): Promise<void> {
  expect((await call(server, `${itemPath(locationId, `f_${fileId}`)}/ai`, { session, json: {} })).status).toBe(202);
}

async function runReader(): Promise<void> {
  server.aiReader?.nudge();
  await server.aiReader?.settled();
}

function undo(session: TestSession, locationId: string, ref: string): Promise<Response> {
  return call(server, `${itemPath(locationId, ref)}/ai`, { session, method: 'DELETE' });
}

async function itemOf(session: TestSession, locationId: string, ref: string): Promise<DataItemView> {
  const res = await call(server, itemPath(locationId, ref), { session });
  expect(res.status).toBe(200);
  return (await res.json() as { item: DataItemView }).item;
}

async function aiOf(fileId: string): Promise<Record<string, unknown>> {
  const doc = await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(fileId) });
  return (doc?.ai ?? {}) as Record<string, unknown>;
}

async function outcomeOf(fileId: string): Promise<Record<string, unknown>> {
  return ((await aiOf(fileId)).actions as { outcome: Record<string, unknown> } | null)?.outcome ?? {};
}

async function notesOf(locationId: string): Promise<NoteView[]> {
  const res = await call(server, `/api/org/locations/${locationId}/notes`, { session: team.admin });
  return (await res.json() as { notes: NoteView[] }).notes;
}

async function eventsOf(action: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => event.action === action);
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

const oid = (id: string): Types.ObjectId => new Types.ObjectId(id);

// ---- Notes ----------------------------------------------------------------------------------------------------------

describe('notes from the events', () => {
  it('makes each event a note by the person who asked, marked with the file, and shows them on the item; audit and log carry counts only', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    const closure = { title: 'Closed for the floor', startDate: '2026-07-01', endDate: '2026-07-02', kind: 'closure', effect: 'closed', expectedGuests: 30, detail: '' };
    answers = [answer({ events: [EVENT, closure] })];
    await readAs(team.member, l1, fileId);

    const notes = await notesOf(l1);
    expect(notes.map(({ kind, startDate, endDate, effect, expectedGuests, detail, createdByEmail, source }) => ({
      kind, startDate, endDate, effect, expectedGuests, detail, createdByEmail, source,
    }))).toEqual([
      { kind: 'private_event', startDate: '2026-06-14', endDate: '2026-06-14', effect: 'more_guests', expectedGuests: 80, detail: 'Wedding dinner: Back room', createdByEmail: team.memberEmail, source: { via: 'ai_file', fileId } },
      { kind: 'closure', startDate: '2026-07-01', endDate: '2026-07-02', effect: 'closed', expectedGuests: null, detail: 'Closed for the floor', createdByEmail: team.memberEmail, source: { via: 'ai_file', fileId } },
    ]);
    const stored = await server.connection.collection('tw_notes').findOne({ _id: oid(notes[0]?.id ?? '') });
    expect(stored).toMatchObject({ createdBy: team.member.userId, source: { via: 'ai_file', fileId: oid(fileId) } });
    expect(stored?.byStaff).toBeUndefined();

    const item = await itemOf(team.member, l1, `f_${fileId}`);
    expect(item.ai).toMatchObject({
      status: 'done', daysWritten: 0, uploadRef: null, daysReason: 'not_sales', itemReason: null, calibration: { status: 'not_admin', id: null }, canUndo: true,
      notes: [
        { id: notes[0]?.id, title: 'Wedding dinner', startDate: '2026-06-14', endDate: '2026-06-14' },
        { id: notes[1]?.id, title: 'Closed for the floor', startDate: '2026-07-01', endDate: '2026-07-02' },
      ],
    });
    expect((await itemOf(team.other, l1, `f_${fileId}`)).ai?.canUndo).toBe(false);
    expect((await itemOf(team.admin, l1, `f_${fileId}`)).ai?.canUndo).toBe(true);
    expect(await outcomeOf(fileId)).toMatchObject({ notesSkipped: { duplicate: 0, cap: 0, invalid: 0, guard: 0 }, daysReason: 'not_sales' });

    const read = (await eventsOf('file.ai_read')).at(-1);
    expect(read).toMatchObject({ details: { locationId: l1, kind: 'calendar', events: 2, days: 0, notes: 2, daysWritten: 0, item: true, calibration: 'not_admin' } });
    expect(JSON.stringify(read)).not.toMatch(/Qvzx|Wedding|Back room|floor|June events/);
    const line = logLines(server).filter((each) => each.msg === 'townwise.ai_read').at(-1);
    expect(line).toMatchObject({ fileId, notes: 2, daysWritten: 0, daysReason: 'not_sales', item: true, itemReason: null, calibration: 'not_admin' });
    expect(server.logs.join('\n')).not.toMatch(/Qvzx|Wedding|Back room|Closed for the floor/);
  });

  it('skips an event an existing note already says (title case and spacing aside) and a repeat in the same file', async () => {
    const l1 = await newLocation();
    await addNote(server, { orgId: team.orgId, locationId: l1, detail: '  wedding   DINNER ', startDate: '2026-06-14' });
    await server.connection.collection('tw_notes').updateOne({ locationId: oid(l1) }, { $set: { kind: 'private_event', effect: 'more_guests' } });
    const fileId = await seedStored(l1);
    const other = { ...EVENT, title: 'Rehearsal', startDate: '2026-06-13', endDate: '2026-06-13' };
    answers = [answer({ events: [EVENT, other, { ...other, title: 'rehearsal ', detail: 'again' }] })];
    await readAs(team.member, l1, fileId);
    expect(await count('tw_notes', { locationId: oid(l1) })).toBe(2);
    expect(await outcomeOf(fileId)).toMatchObject({ notesSkipped: { duplicate: 2, cap: 0, invalid: 0, guard: 0 } });
  });

  it('makes at most 50 notes a file, and stops at the location’s 1,000 notes, counting what it skipped', async () => {
    const l1 = await newLocation();
    const many = Array.from({ length: 60 }, (_, index) => ({ ...EVENT, title: `Event ${String(index)}` }));
    const fileId = await seedStored(l1);
    answers = [answer({ events: many })];
    await readAs(team.member, l1, fileId);
    expect(await count('tw_notes', { locationId: oid(l1) })).toBe(50);

    const l2 = await newLocation();
    await server.connection.collection('tw_notes').insertMany(Array.from({ length: 999 }, (_, index) => ({
      orgId: oid(team.orgId), locationId: oid(l2), kind: 'other', startDate: '2026-01-01', endDate: '2026-01-01', weekdays: null, effect: 'unknown',
      expectedGuests: null, detail: `filler ${String(index)}`, createdBy: 'fixture', createdAt: server.clock.now(), updatedAt: server.clock.now(),
    })));
    const second = await seedStored(l2);
    answers = [answer({ events: many.slice(0, 3) })];
    await readAs(team.member, l2, second);
    expect(await count('tw_notes', { locationId: oid(l2) })).toBe(1000);
    expect(await outcomeOf(second)).toMatchObject({ notesSkipped: { duplicate: 0, cap: 2, invalid: 0, guard: 0 } });
    expect((await outcomeOf(second)).notes).toHaveLength(1);
  });

  it('a buyout keeps its party’s size, which books the day (D30); a closure never has one', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    answers = [answer({ events: [
      { ...EVENT, title: 'Buyout', detail: 'Whole room', effect: 'closed', expectedGuests: 60 },
      { ...EVENT, title: 'Closed', detail: '', kind: 'closure', effect: 'closed', startDate: '2026-07-01', endDate: '2026-07-01', expectedGuests: 60 },
    ] })];
    await readAs(team.member, l1, fileId);
    const notes = await notesOf(l1);
    expect(notes.map(({ kind, effect, expectedGuests }) => [kind, effect, expectedGuests])).toEqual([
      ['private_event', 'closed', 60], ['closure', 'closed', null],
    ]);
  });

  it('skips an event the notes route would refuse, and leaves out a guest count it would refuse', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    answers = [answer({ events: [
      { ...EVENT, startDate: '2029-01-01', endDate: '2029-01-01' },
      { ...EVENT, startDate: '2026-01-01', endDate: '2027-06-01' },
      { ...EVENT, title: 'Huge fair', expectedGuests: 50_000 },
    ] })];
    await readAs(team.member, l1, fileId);
    const notes = await notesOf(l1);
    expect(notes.map((note) => [note.detail, note.expectedGuests])).toEqual([['Huge fair: Back room', null]]);
    expect(await outcomeOf(fileId)).toMatchObject({ notesSkipped: { duplicate: 0, cap: 0, invalid: 2, guard: 0 } });
  });

  it('never makes a closed note over 14 days, nor more than 31 closed days a read, counting what the guard skipped', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    const closed = (title: string, startDate: string, endDate: string, kind = 'closure', effect = 'closed'): Event => (
      { title, startDate, endDate, kind, effect, expectedGuests: null, detail: '' }
    );
    answers = [answer({ events: [
      closed('Renovation', '2026-08-01', '2026-08-15'),
      closed('Winter break', '2026-01-05', '2026-01-14'),
      closed('Spring break', '2026-03-02', '2026-03-11'),
      closed('Private buyout', '2026-04-06', '2026-04-15', 'private_event'),
      closed('Fall break', '2026-10-05', '2026-10-06'),
      { ...EVENT, title: 'Long festival', startDate: '2026-07-01', endDate: '2026-07-31' },
    ] })];
    await readAs(team.member, l1, fileId);
    const notes = await notesOf(l1);
    expect(notes.map((note) => note.detail)).toEqual(['Winter break', 'Spring break', 'Private buyout', 'Long festival: Back room']);
    expect(await outcomeOf(fileId)).toMatchObject({ notesSkipped: { duplicate: 0, cap: 0, invalid: 0, guard: 2 } });
    expect((await itemOf(team.member, l1, `f_${fileId}`)).ai?.notesSkipped).toEqual({ duplicate: 0, cap: 0, invalid: 0, guard: 2 });
  });

  /** A read Townwise staff asked for while open as admin under `grantId`, queued straight into the file. */
  async function queueAsStaff(fileId: string, grantId: string): Promise<void> {
    await server.connection.collection('tw_files').updateOne({ _id: oid(fileId) }, { $set: {
      ai: {
        status: 'queued', requestedBy: team.admin.userId, requestedByRole: 'org_admin', requestedByStaff: true, requestedGrantId: grantId,
        requestedAt: server.clock.now(), attempts: 0, leaseUntil: null, startedAt: null, finishedAt: null, reason: null, partial: false, costMicroUsd: 0, result: null,
      },
    } });
  }

  it('marks a note made for Townwise staff open as admin as staff’s, while their grant lasts', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    const grantId = await addOpenAsAdminGrant(server, { actorUserId: team.admin.userId, sessionId: randomUUID(), orgId: team.orgId });
    await queueAsStaff(fileId, grantId);
    await runReader();
    expect((await notesOf(l1))[0]).toMatchObject({ createdByEmail: 'Townwise staff', source: { via: 'ai_file', fileId } });
  });

  it('writes nothing once the person who asked has left the organization, or staff’s grant ended: skipped requester_gone', async () => {
    const l1 = await newLocation();
    const days = mayDays(2);
    const leaver = await newPerson('member');
    const fileId = await seedStored(l1, { raw: salesCsv(days), by: leaver });
    answers = [salesAnswer(days, { events: [EVENT] })];
    await ask(leaver, l1, fileId);
    await server.connection.collection('tw_members').updateOne(
      { activeUserId: leaver.userId }, { $set: { status: 'removed', removedAt: server.clock.now() }, $unset: { activeUserId: '' } },
    );
    await runReader();
    expect(await aiOf(fileId)).toMatchObject({ status: 'skipped', reason: 'requester_gone', actions: null });
    expect(await count('tw_notes', { 'source.fileId': oid(fileId) })).toBe(0);
    expect(await count('tw_uploads', { 'source.fileId': oid(fileId) })).toBe(0);
    expect(await count('tw_files', { 'source.fileId': oid(fileId) })).toBe(0);
    expect(await itemOf(team.admin, l1, `f_${fileId}`)).toMatchObject({ canAiRead: true, ai: { status: 'skipped', reason: 'requester_gone', canUndo: false } });

    const staffFile = await seedStored(l1);
    const grantId = await addOpenAsAdminGrant(server, { actorUserId: team.admin.userId, sessionId: randomUUID(), orgId: team.orgId });
    await server.connection.collection('tw_view_as_grants').updateOne({ _id: oid(grantId) }, { $set: { endedAt: server.clock.now(), endReason: 'ended' } });
    await queueAsStaff(staffFile, grantId);
    await runReader();
    expect(await aiOf(staffFile)).toMatchObject({ status: 'skipped', reason: 'requester_gone' });
    expect(await count('tw_notes', { 'source.fileId': oid(staffFile) })).toBe(0);
  });
});

// ---- Days -----------------------------------------------------------------------------------------------------------

describe('days from the daily totals', () => {
  it('writes verified days as one upload made by TownwiseAI from the file, never replacing a stored day, even for an org admin', async () => {
    const l1 = await newLocation();
    await addSalesDay(server, { orgId: team.orgId, locationId: l1, date: '2026-05-01', guests: 5, netSalesCents: 500 });
    const earlier = String((await server.connection.collection('tw_sales_days').findOne({ locationId: oid(l1), date: '2026-05-01' }))?.uploadId);
    const days = mayDays(3);
    const fileId = await seedStored(l1, { name: `${SENTINEL} may.csv`, raw: salesCsv(days), by: team.admin });
    // The answer has no guest count for the stored day: a null is never written over a figure either.
    answers = [salesAnswer(days.map((day, index) => (index === 0 ? { ...day, guests: null } : day)))];
    await readAs(team.admin, l1, fileId);

    const outcome = await outcomeOf(fileId);
    expect(outcome).toMatchObject({ daysWritten: 2, daysAlreadyHad: 1, daysReason: null });
    const uploadId = String(outcome.uploadId);
    expect(await server.connection.collection('tw_uploads').findOne({ _id: oid(uploadId) })).toMatchObject({
      uploadedBy: team.admin.userId, status: 'applied', dayCount: 3, inserted: 2, replaced: 0, kept: 1, firstDate: '2026-05-01', lastDate: '2026-05-03',
      source: { via: 'ai_file', fileId: oid(fileId) },
    });
    const stored = await server.connection.collection('tw_sales_days').find({ locationId: oid(l1) }).sort({ date: 1 }).toArray();
    expect(stored.map((doc) => [String(doc.date), Number(doc.guests), Number(doc.netSalesCents), String(doc.uploadId)])).toEqual([
      ['2026-05-01', 5, 500, earlier], ['2026-05-02', 102, 202_050, uploadId], ['2026-05-03', 103, 203_075, uploadId],
    ]);
    // The source file has no upload of its own: deleting the upload never takes the file.
    expect((await server.connection.collection('tw_files').findOne({ _id: oid(fileId) }))?.uploadId).toBeNull();

    const upload = await itemOf(team.admin, l1, `u_${uploadId}`);
    expect(upload).toMatchObject({ via: 'townwise_ai', kind: 'daily_totals', fromAiRead: `f_${fileId}`, canTurnOff: true, canDelete: true, ai: null });
    expect((await itemOf(team.admin, l1, `f_${fileId}`)).ai).toMatchObject({ daysWritten: 2, daysAlreadyHad: 1, uploadRef: `u_${uploadId}`, daysReason: null });
    const uploaded = (await eventsOf('sales.uploaded')).at(-1);
    expect(uploaded).toMatchObject({
      actorUserId: team.admin.userId, actorRole: 'org_admin', target: { type: 'upload', id: uploadId },
      details: { locationId: l1, dayCount: 3, inserted: 2, replaced: 0, fileId, via: 'townwise_ai' },
    });

    // As any upload: turned off, then deleted; only the days it added go, and the day it found stays.
    const off = await call(server, itemPath(l1, `u_${uploadId}`), { session: team.admin, method: 'PATCH', json: { enabled: false } });
    expect(off.status).toBe(200);
    const deleted = await call(server, itemPath(l1, `u_${uploadId}`), { session: team.admin, method: 'DELETE' });
    expect(await deleted.json()).toEqual({ deletedDays: 2, deletedFiles: 0 });
    expect(await server.connection.collection('tw_sales_days').findOne({ locationId: oid(l1), date: '2026-05-01' })).toMatchObject({ guests: 5, netSalesCents: 500 });
    expect(await count('tw_files', { _id: oid(fileId) })).toBe(1);
    expect((await itemOf(team.admin, l1, `f_${fileId}`)).ai?.uploadRef).toBeNull();
  });

  it('adds only new days for a member, keeping the days already there', async () => {
    const l1 = await newLocation();
    await addSalesDay(server, { orgId: team.orgId, locationId: l1, date: '2026-05-01', guests: 5, netSalesCents: 500 });
    const days = mayDays(3);
    const fileId = await seedStored(l1, { raw: salesCsv(days) });
    answers = [salesAnswer(days)];
    await readAs(team.member, l1, fileId);
    const outcome = await outcomeOf(fileId);
    expect(outcome).toMatchObject({ daysWritten: 2, daysAlreadyHad: 1, daysReason: null, calibration: { status: 'not_admin', id: null } });
    expect(await server.connection.collection('tw_uploads').findOne({ _id: oid(String(outcome.uploadId)) })).toMatchObject({ inserted: 2, replaced: 0, kept: 1 });
    expect(await server.connection.collection('tw_sales_days').findOne({ locationId: oid(l1), date: '2026-05-01' })).toMatchObject({ guests: 5, netSalesCents: 500 });
  });

  it('makes no upload when the location already has every verified day, an org admin’s or a member’s: already_had_days', async () => {
    const l1 = await newLocation();
    const days = mayDays(2);
    for (const day of days) await addSalesDay(server, { orgId: team.orgId, locationId: l1, date: day.date, guests: 1, netSalesCents: 100 });
    for (const who of [team.admin, team.member]) {
      const fileId = await seedStored(l1, { raw: salesCsv(days), by: who });
      answers = [salesAnswer(days)];
      await readAs(who, l1, fileId);
      expect(await outcomeOf(fileId)).toMatchObject({ uploadId: null, daysWritten: 0, daysAlreadyHad: 2, daysReason: 'already_had_days' });
      expect((await itemOf(who, l1, `f_${fileId}`)).ai).toMatchObject({ daysReason: 'already_had_days', daysAlreadyHad: 2, uploadRef: null });
    }
    expect(await count('tw_uploads', { locationId: oid(l1) })).toBe(0);
    expect(await count('tw_sales_days', { locationId: oid(l1), guests: 1 })).toBe(2);
  });

  it('writes nothing below 95% verified, and only the verified days at or above it', async () => {
    const l1 = await newLocation();
    const days = mayDays(20);
    // A guest count the file never states.
    const twoOff = days.map((day, index) => (index < 2 ? { ...day, guests: 9999 } : day));
    const below = await seedStored(l1, { raw: salesCsv(days) });
    answers = [salesAnswer(twoOff)];
    await readAs(team.admin, l1, below);
    expect(await outcomeOf(below)).toMatchObject({ uploadId: null, daysWritten: 0, daysReason: 'days_not_verified' });
    expect(await count('tw_sales_days', { locationId: oid(l1) })).toBe(0);

    const oneOff = days.map((day, index) => (index === 0 ? { ...day, date: '2026-04-30' } : day));
    const at = await seedStored(l1, { raw: salesCsv(days) });
    answers = [salesAnswer(oneOff)];
    await readAs(team.admin, l1, at);
    expect(await outcomeOf(at)).toMatchObject({ daysWritten: 19, daysReason: null });
    expect(await count('tw_sales_days', { locationId: oid(l1), date: '2026-04-30' })).toBe(0);
  });

  it('writes no day whose figures are another day’s: rows read shifted by one are not borne out', async () => {
    const l1 = await newLocation();
    const days = mayDays(3);
    const shifted = days.map((day, index) => ({ ...day, guests: days[(index + 1) % 3]?.guests ?? null, netSales: days[(index + 1) % 3]?.netSales ?? null }));
    const fileId = await seedStored(l1, { raw: salesCsv(days), by: team.admin });
    answers = [salesAnswer(shifted)];
    await readAs(team.admin, l1, fileId);
    expect(await outcomeOf(fileId)).toMatchObject({ uploadId: null, daysWritten: 0, daysReason: 'days_not_verified' });
    expect(await count('tw_sales_days', { locationId: oid(l1) })).toBe(0);
  });

  it('drops the answer’s days once they are used, keeping their count, and says when the file had more than were read', async () => {
    const l1 = await newLocation();
    const days = mayDays(2);
    const fileId = await seedStored(l1, { raw: salesCsv(days), by: team.member });
    answers = [salesAnswer(days, { daysCut: true })];
    await readAs(team.member, l1, fileId);
    expect((await aiOf(fileId)).result).toMatchObject({ days: [], daysBorneOut: [], dayCount: 2, daysCut: true, kind: 'sales' });
    expect(await outcomeOf(fileId)).toMatchObject({ daysWritten: 2 });
    expect((await itemOf(team.member, l1, `f_${fileId}`)).ai).toMatchObject({ daysCut: true, daysWritten: 2 });
  });

  it('writes no days from a picture, a file that wrote days itself, an answer short of high confidence, or one that is not sales', async () => {
    const l1 = await newLocation();
    const days = mayDays(2);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), salesCsv(days)]);
    const picture = await seedStored(l1, { kind: 'other', name: 'till.png', raw: png });
    answers = [salesAnswer(days)];
    await readAs(team.admin, l1, picture);
    expect(await outcomeOf(picture)).toMatchObject({ daysReason: 'picture', uploadId: null });

    const own = await addUpload(server, { orgId: team.orgId, locationId: l1, uploadedAt: server.clock.now(), status: 'applied', uploadedBy: team.admin.userId });
    const history = await seedStored(l1, { raw: salesCsv(days), status: 'read', uploadId: own, by: team.admin });
    answers = [salesAnswer(days)];
    const res = await call(server, `${itemPath(l1, `u_${own}`)}/ai`, { session: team.admin, json: {} });
    expect(res.status).toBe(202);
    server.aiReader?.nudge();
    await server.aiReader?.settled();
    expect(await outcomeOf(history)).toMatchObject({ daysReason: 'file_wrote_days' });

    const unsure = await seedStored(l1, { raw: salesCsv(days) });
    answers = [salesAnswer(days, { confidence: 'medium' })];
    await readAs(team.admin, l1, unsure);
    expect(await outcomeOf(unsure)).toMatchObject({ daysReason: 'not_high_confidence' });

    const calendar = await seedStored(l1, { raw: salesCsv(days) });
    answers = [salesAnswer(days, { kind: 'calendar' })];
    await readAs(team.admin, l1, calendar);
    expect(await outcomeOf(calendar)).toMatchObject({ daysReason: 'not_sales' });
    expect(await count('tw_sales_days', { locationId: oid(l1) })).toBe(0);
    expect(await count('tw_uploads', { locationId: oid(l1), source: { $exists: true } })).toBe(0);
  });
});

// ---- The summary item -----------------------------------------------------------------------------------------------

describe('the summary item', () => {
  it('keeps the summary and facts as a reference text item TownwiseAI added for the person, naming the file it came from', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { name: `${SENTINEL} June bookings.csv` });
    answers = [answer({ facts: ['Three events', 'One closure'] })];
    await readAs(team.member, l1, fileId);
    const { itemId } = await outcomeOf(fileId);
    const item = await itemOf(team.member, l1, `f_${String(itemId)}`);
    expect(item).toMatchObject({
      via: 'townwise_ai', kind: 'text', name: `TownwiseAI’s notes on ${SENTINEL} June bookings.txt`, addedByEmail: team.memberEmail,
      state: 'kept', fromAiRead: `f_${fileId}`, enabled: true,
    });
    const body = memory.raw.get([...memory.raw.keys()].find((key) => key.includes(String(itemId))) ?? '');
    expect(body?.toString('utf8')).toBe('A list of June events.\n\n- Three events\n- One closure');
    expect(await server.connection.collection('tw_files').findOne({ _id: oid(String(itemId)) })).toMatchObject({
      purpose: 'reference', addedVia: 'townwise_ai', uploadedBy: team.member.userId, source: { via: 'ai_file', fileId: oid(fileId) },
    });
    expect((await itemOf(team.member, l1, `f_${fileId}`)).ai?.itemRef).toBe(`f_${String(itemId)}`);
    expect((await eventsOf('file.uploaded')).at(-1)).toMatchObject({ target: { type: 'file', id: itemId }, details: { via: 'townwise_ai', purpose: 'reference' } });
  });

  it('names the file as it is called when the item is kept: a rename while it is read counts', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { name: `${SENTINEL} old name.csv` });
    before = async (_orgId, id) => {
      await server.connection.collection('tw_files').updateOne({ _id: oid(id) }, { $set: { name: `${SENTINEL} new name.csv` } });
    };
    await readAs(team.member, l1, fileId);
    const { itemId } = await outcomeOf(fileId);
    expect((await itemOf(team.member, l1, `f_${String(itemId)}`)).name).toBe(`TownwiseAI’s notes on ${SENTINEL} new name.txt`);
  });

  it('skips the item when a cap refuses it, or when there is no summary, and the read still finishes', async () => {
    const l1 = await newLocation();
    await server.connection.collection('tw_upload_days').insertOne({
      orgId: oid(team.orgId), day: server.clock.now().toISOString().slice(0, 10), bytes: DAILY_UPLOAD_BYTES, updatedAt: server.clock.now(),
    });
    const full = await seedStored(l1);
    await readAs(team.member, l1, full);
    expect(await aiOf(full)).toMatchObject({ status: 'done' });
    expect(await outcomeOf(full)).toMatchObject({ itemId: null, itemReason: 'daily_upload_limit' });
    expect((await notesOf(l1))).toHaveLength(1);

    const empty = await seedStored(l1);
    answers = [answer({ summary: '', events: [] })];
    await readAs(team.member, l1, empty);
    expect(await outcomeOf(empty)).toMatchObject({ itemId: null, itemReason: 'no_summary' });
    expect((await itemOf(team.member, l1, `f_${full}`)).ai).toMatchObject({ itemRef: null, itemReason: 'daily_upload_limit' });
    expect((await itemOf(team.member, l1, `f_${empty}`)).ai).toMatchObject({ itemRef: null, itemReason: 'no_summary' });
  });
});

// ---- Retries and deletion -------------------------------------------------------------------------------------------

describe('retries', () => {
  it('a throw part way (the summary item’s blob write) puts the read back, and the retry writes no note, day, item or calibration twice', async () => {
    const l1 = await newLocation();
    await seedHistory(server, { orgId: team.orgId, locationId: l1, from: '2024-09-01', to: '2026-04-30' });
    const days = mayDays(3);
    const fileId = await seedStored(l1, { raw: salesCsv(days), by: team.admin });
    answers = [salesAnswer(days, { events: [EVENT] })];
    failRawWrites = 1;
    const jobs = runner.jobs.length;
    await readAs(team.admin, l1, fileId);
    expect(await aiOf(fileId)).toMatchObject({ status: 'queued', attempts: 1 });
    await rerun();
    expect(requests).toHaveLength(1);
    expect(await aiOf(fileId)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await count('tw_notes', { 'source.fileId': oid(fileId) })).toBe(1);
    expect(await count('tw_uploads', { 'source.fileId': oid(fileId) })).toBe(1);
    expect(await count('tw_files', { 'source.fileId': oid(fileId) })).toBe(1);
    expect(runner.jobs.length).toBe(jobs + 1);
    const outcome = await outcomeOf(fileId);
    expect(outcome).toMatchObject({ daysWritten: 3, calibration: { status: 'started' } });
    expect(await server.connection.collection('tw_uploads').findOne({ _id: oid(String(outcome.uploadId)) })).toMatchObject({ inserted: 3, replaced: 0 });
    // The failed write gave its day's bytes back, so the item is reserved once.
    expect(await server.connection.collection('tw_upload_days').findOne({ orgId: oid(team.orgId) })).toMatchObject({ bytes: Buffer.byteLength('Daily totals for May.') });
  });

  it('a throw after every write retries them all on the saved answer, and each is found, not written again', async () => {
    const l1 = await newLocation();
    await seedHistory(server, { orgId: team.orgId, locationId: l1, from: '2024-09-01', to: '2026-04-30' });
    const days = mayDays(2);
    const fileId = await seedStored(l1, { raw: salesCsv(days), by: team.member });
    answers = [salesAnswer(days, { events: [EVENT] })];
    throwAfter = 1;
    const jobs = runner.jobs.length;
    await readAs(team.admin, l1, fileId);
    await rerun();
    expect(requests).toHaveLength(1);
    expect(await aiOf(fileId)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await count('tw_notes', { 'source.fileId': oid(fileId) })).toBe(1);
    expect(await count('tw_uploads', { 'source.fileId': oid(fileId) })).toBe(1);
    expect(await count('tw_files', { 'source.fileId': oid(fileId) })).toBe(1);
    expect(runner.jobs.length).toBe(jobs + 1);
    expect(await count('tw_sales_days', { locationId: oid(l1), date: { $gte: '2026-05-01' } })).toBe(2);
    expect((await eventsOf('sales.uploaded')).filter((event) => (event.details as { fileId?: string }).fileId === fileId)).toHaveLength(1);
    expect((await eventsOf('calibration.requested')).filter((event) => (event.details as { via?: string }).via === 'file').length).toBeGreaterThanOrEqual(1);
  });

  it('writes nothing for a file deleted while it was read', async () => {
    const l1 = await newLocation();
    const days = mayDays(2);
    const fileId = await seedStored(l1, { raw: salesCsv(days) });
    answers = [salesAnswer(days, { events: [EVENT] })];
    before = async (_orgId, id) => {
      await server.connection.collection('tw_files').updateOne({ _id: oid(id) }, { $set: { status: 'deleting' } });
    };
    await readAs(team.admin, l1, fileId);
    expect(await count('tw_notes', { locationId: oid(l1) })).toBe(0);
    expect(await count('tw_uploads', { locationId: oid(l1) })).toBe(0);
    expect(await count('tw_files', { 'source.fileId': oid(fileId) })).toBe(0);
    expect((await aiOf(fileId)).actions).toBeNull();
  });

  it('writes nothing once the original is purged while it is read, and skips the read raw_missing', async () => {
    const l1 = await newLocation();
    const days = mayDays(2);
    const fileId = await seedStored(l1, { raw: salesCsv(days) });
    answers = [salesAnswer(days, { events: [EVENT] })];
    // The original goes after the answer was saved, as the actions begin.
    before = async (_orgId, id) => {
      await server.connection.collection('tw_files').updateOne({ _id: oid(id) }, { $set: { rawDeletedAt: server.clock.now() } });
    };
    await readAs(team.member, l1, fileId);
    expect(await aiOf(fileId)).toMatchObject({ status: 'skipped', reason: 'raw_missing', actions: { outcome: null } });
    expect(await count('tw_notes', { 'source.fileId': oid(fileId) })).toBe(0);
    expect(await count('tw_uploads', { 'source.fileId': oid(fileId) })).toBe(0);
    expect(await count('tw_files', { 'source.fileId': oid(fileId) })).toBe(0);
  });

  it('fails a read whose actions throw three times, and lets what they wrote be undone', async () => {
    const l1 = await newLocation();
    const days = mayDays(2);
    const fileId = await seedStored(l1, { raw: salesCsv(days), by: team.member });
    answers = [salesAnswer(days, { events: [EVENT] })];
    // The summary item's blob write fails every time: notes and days are written, the outcome never recorded.
    failRawWrites = 10;
    await readAs(team.member, l1, fileId);
    await rerun(3);
    expect(requests).toHaveLength(1);
    expect(await aiOf(fileId)).toMatchObject({ status: 'failed', reason: 'internal', actions: { outcome: null } });
    expect(await count('tw_notes', { 'source.fileId': oid(fileId) })).toBe(1);
    expect(await count('tw_uploads', { 'source.fileId': oid(fileId) })).toBe(1);
    failRawWrites = 0;
    expect((await itemOf(team.member, l1, `f_${fileId}`)).ai).toMatchObject({ status: 'failed', canUndo: true });
    const res = await undo(team.member, l1, `f_${fileId}`);
    expect(res.status).toBe(200);
    expect(await count('tw_notes', { 'source.fileId': oid(fileId) })).toBe(0);
    expect(await count('tw_uploads', { 'source.fileId': oid(fileId) })).toBe(0);
    expect(await count('tw_sales_days', { locationId: oid(l1) })).toBe(0);
    expect(await aiOf(fileId)).toMatchObject({ status: 'undone', actions: null, result: null });
  });
});

// ---- The model update -----------------------------------------------------------------------------------------------

describe('the model update', () => {
  it('starts a calibration as the org admin who asked, through the lab’s checks, recorded as started from a file', async () => {
    const l1 = await newLocation();
    await seedHistory(server, { orgId: team.orgId, locationId: l1, from: '2024-10-01', to: '2026-05-31' });
    const fileId = await seedStored(l1, { by: team.admin });
    const jobs = runner.jobs.length;
    await readAs(team.admin, l1, fileId);
    const { calibration } = await outcomeOf(fileId) as { calibration: { status: string; id: string } };
    expect(calibration.status).toBe('started');
    expect(runner.jobs.length).toBe(jobs + 1);
    expect(await server.connection.collection('tw_calibrations').findOne({ _id: oid(calibration.id) })).toMatchObject({
      locationId: oid(l1), requestedBy: { userId: team.admin.userId, role: 'org_admin', via: 'file' },
    });
    expect((await eventsOf('calibration.requested')).at(-1)).toMatchObject({
      actorUserId: team.admin.userId, actorRole: 'org_admin', target: { type: 'calibration', id: calibration.id },
      details: { locationId: l1, calibrationId: calibration.id, via: 'file', hasRegime: false },
    });
    expect((await itemOf(team.admin, l1, `f_${fileId}`)).ai?.calibration).toEqual({ status: 'started', id: calibration.id });
    expect((await eventsOf('file.ai_read')).at(-1)).toMatchObject({ details: { calibration: 'started' } });
  });

  it('records why not when the lab refuses, never failing the read', async () => {
    const cases: [string, (locationId: string) => Promise<void>, string][] = [
      ['no history', () => Promise.resolve(), 'not_enough_history'],
      ['budget', async (locationId) => {
        await seedHistory(server, { orgId: team.orgId, locationId, from: '2024-10-01', to: '2026-05-31' });
        await addChatUsage(server, { orgId: team.orgId, month: '2026-06', costMicroUsd: 1_000_000_000 });
      }, 'budget_spent'],
      ['running', async (locationId) => {
        await seedHistory(server, { orgId: team.orgId, locationId, from: '2024-10-01', to: '2026-05-31' });
        await server.connection.collection('tw_calibrations').insertOne({
          orgId: oid(team.orgId), locationId: oid(locationId), requestedBy: { userId: null, role: 'superadmin', via: 'console' }, regimeStart: null,
          status: 'queued', championRunId: null, dataThrough: null, inputSha256: null, imageDigest: null, codeVersion: null, runId: null,
          scorecardJson: null, gate: null, failure: null, chargedMicroUsd: 0, requestedAt: server.clock.now(), startedAt: null, finishedAt: null,
          liveLocation: oid(locationId), tokenExpiresAt: new Date(server.clock.now().getTime() + 60_000),
        });
      }, 'in_progress'],
      ['four today', async (locationId) => {
        await seedHistory(server, { orgId: team.orgId, locationId, from: '2024-10-01', to: '2026-05-31' });
        const limiter = createRateLimiter({ redis: server.redis, name: 'townwise:calibrations', limit: 4, windowSeconds: 86_400 });
        for (let index = 0; index < 4; index += 1) await limiter.consume(`org:${team.orgId}`);
      }, 'daily_limit'],
      ['start failed', async (locationId) => {
        await seedHistory(server, { orgId: team.orgId, locationId, from: '2024-10-01', to: '2026-05-31' });
        runner.failNext(new Error('job did not start'));
      }, 'start_failed'],
      ['suspended', async (locationId) => {
        await seedHistory(server, { orgId: team.orgId, locationId, from: '2024-10-01', to: '2026-05-31' });
        before = async (orgId) => {
          before = null;
          await server.connection.collection('tw_orgs').updateOne({ _id: oid(orgId) }, { $set: { status: 'suspended' } });
        };
      }, 'org_not_active'],
    ];
    for (const [label, setUp, status] of cases) {
      await server.connection.collection('tw_chat_usage').deleteMany({});
      await server.redis.flushdb();
      const l1 = await newLocation();
      await setUp(l1);
      const fileId = await seedStored(l1, { by: team.admin });
      try {
        await readAs(team.admin, l1, fileId);
      } finally {
        await server.connection.collection('tw_orgs').updateOne({ _id: oid(team.orgId) }, { $set: { status: 'active' } });
      }
      expect({ label, ai: await aiOf(fileId), outcome: await outcomeOf(fileId) }).toMatchObject({
        label, ai: { status: 'done' }, outcome: { calibration: { status, id: null } },
      });
    }
  });

  it('decides by the role the person who asked has now: promoted since, it starts; demoted since, it does not', async () => {
    const l1 = await newLocation();
    await seedHistory(server, { orgId: team.orgId, locationId: l1, from: '2024-10-01', to: '2026-05-31' });
    const promoted = await newPerson('member');
    const first = await seedStored(l1, { by: promoted });
    await ask(promoted, l1, first);
    await server.connection.collection('tw_members').updateOne({ activeUserId: promoted.userId }, { $set: { role: 'org_admin' } });
    await runReader();
    expect(await outcomeOf(first)).toMatchObject({ calibration: { status: 'started' } });
    expect((await eventsOf('calibration.requested')).at(-1)).toMatchObject({ actorUserId: promoted.userId, actorRole: 'org_admin' });

    const demoted = await newPerson('org_admin');
    const second = await seedStored(l1, { by: demoted });
    answers = [answer({ events: [{ ...EVENT, title: 'Brunch' }] })];
    await ask(demoted, l1, second);
    await server.connection.collection('tw_members').updateOne({ activeUserId: demoted.userId }, { $set: { role: 'member' } });
    await runReader();
    expect(await outcomeOf(second)).toMatchObject({ calibration: { status: 'not_admin', id: null } });
  });

  it('says the lab is off without a runner, the requester is no org admin, or nothing was written', async () => {
    const l1 = await newLocation();
    await seedHistory(server, { orgId: team.orgId, locationId: l1, from: '2024-10-01', to: '2026-05-31' });
    const off = await seedStored(l1, { by: team.admin });
    const admin = await signIn(noLab, team.adminEmail);
    await readAs(admin, l1, off, noLab);
    expect(await outcomeOf(off)).toMatchObject({ calibration: { status: 'lab_unavailable', id: null } });

    const member = await seedStored(l1);
    answers = [answer({ events: [{ ...EVENT, title: 'Brunch' }] })];
    await readAs(team.member, l1, member);
    expect(await outcomeOf(member)).toMatchObject({ calibration: { status: 'not_admin', id: null } });

    const nothing = await seedStored(l1, { by: team.admin });
    answers = [answer({ kind: 'menu', events: [] })];
    await readAs(team.admin, l1, nothing);
    expect(await outcomeOf(nothing)).toMatchObject({ notes: [], daysWritten: 0, calibration: { status: 'not_needed', id: null } });
  });
});

// ---- ZIP input ------------------------------------------------------------------------------------------------------

describe('a ZIP', () => {
  it('is read as its entries’ text under "Entry n" lines, with no entry path or file name in the request, pictures counted and skipped', async () => {
    const l1 = await newLocation();
    const days = mayDays(2);
    const zip = zipOf([
      { name: `${SENTINEL} Party/covers.csv`, data: salesCsv(days) },
      { name: `${SENTINEL} Party/photo.png`, data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]) },
      { name: 'book.xlsx', data: xlsxOf([{ name: 'Daily', rows: [['Date', 'Covers'], ['2026-05-09', 77]] }]) },
    ]);
    const fileId = await seedStored(l1, { kind: 'zip', name: `${SENTINEL} export.zip`, raw: zip, by: team.admin });
    answers = [salesAnswer(days)];
    await readAs(team.admin, l1, fileId);
    const sent = JSON.stringify(requests[0]);
    expect(sent).toContain('The file is a ZIP archive');
    expect(sent).toContain('1 other entry in it was not read');
    expect(sent).toContain('Entry 1 (a text file):\\nDate,Guests,Net Sales');
    expect(sent).toContain('Entry 2 (an Excel workbook):\\nSheet: Daily');
    expect(sent).not.toMatch(/Qvzx|covers\.csv|book\.xlsx|photo|export\.zip/);
    // Its entries' text is what the days are checked against.
    expect(await outcomeOf(fileId)).toMatchObject({ daysWritten: 2, daysReason: null });
    expect(await aiOf(fileId)).toMatchObject({ status: 'done', partial: false });
  });

  it('is partial when more than 20 entries could be read', async () => {
    const l1 = await newLocation();
    const zip = zipOf(Array.from({ length: 21 }, (_, index) => ({ name: `day${String(index)}.csv`, data: `row ${String(index)}` })));
    const fileId = await seedStored(l1, { kind: 'zip', name: 'days.zip', raw: zip });
    await readAs(team.member, l1, fileId);
    expect(await aiOf(fileId)).toMatchObject({ status: 'done', partial: true });
    expect(JSON.stringify(requests[0])).toContain('from at most its first 20 entries read');
  });
});

// ---- Undo -----------------------------------------------------------------------------------------------------------

describe('DELETE /api/org/locations/:locationId/data/:ref/ai', () => {
  /** A read by `who` that made two notes, an upload of three days and a summary item. */
  async function madeRead(who: TestSession, locationId: string): Promise<{ fileId: string; outcome: Record<string, unknown> }> {
    const days = mayDays(3);
    const fileId = await seedStored(locationId, { raw: salesCsv(days), by: who });
    answers = [salesAnswer(days, { events: [EVENT, { ...EVENT, title: 'Brunch', startDate: '2026-06-15', endDate: '2026-06-15' }] })];
    await readAs(who, locationId, fileId);
    return { fileId, outcome: await outcomeOf(fileId) };
  }

  it('removes the notes (an edited one too), the upload with the days it still holds, and the summary item; leaves a started calibration', async () => {
    const l1 = await newLocation();
    await seedHistory(server, { orgId: team.orgId, locationId: l1, from: '2024-09-01', to: '2026-04-30' });
    const { fileId, outcome } = await madeRead(team.admin, l1);
    const [edited] = outcome.notes as string[];
    const note = await call(server, `/api/org/locations/${l1}/notes/${String(edited)}`, {
      session: team.admin, method: 'PATCH', json: { kind: 'other', startDate: '2026-06-20', endDate: '2026-06-20', effect: 'unknown', detail: 'Moved' },
    });
    expect(note.status).toBe(200);
    // A later upload replaces one of the read's days: that day stays.
    const later = await call(server, `/api/org/locations/${l1}/sales/uploads`, {
      session: team.admin, json: { days: [{ date: '2026-05-03', guests: 1, netSalesCents: 100 }] },
    });
    expect(later.status).toBe(201);
    const { calibration } = outcome as { calibration: { status: string; id: string } };
    expect(calibration.status).toBe('started');

    const res = await undo(team.admin, l1, `f_${fileId}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { item: DataItemView; calibrationKept: string | null };
    expect(body.calibrationKept).toBe(calibration.id);
    expect(body.item).toMatchObject({
      canAiRead: true,
      ai: {
        status: 'undone', summary: null, facts: null, notes: [], notesSkipped: null, daysWritten: 0, daysAlreadyHad: 0, uploadRef: null, itemRef: null,
        daysReason: null, itemReason: null, calibration: null, canUndo: false,
      },
    });
    expect(await count('tw_notes', { locationId: oid(l1) })).toBe(0);
    expect(await count('tw_uploads', { _id: oid(String(outcome.uploadId)) })).toBe(0);
    expect(await count('tw_sales_days', { uploadId: oid(String(outcome.uploadId)) })).toBe(0);
    expect(await server.connection.collection('tw_sales_days').findOne({ locationId: oid(l1), date: '2026-05-03' })).toMatchObject({ guests: 1 });
    expect(await count('tw_files', { _id: oid(String(outcome.itemId)) })).toBe(0);
    expect(await count('tw_files', { _id: oid(fileId) })).toBe(1);
    expect(await count('tw_calibrations', { _id: oid(calibration.id) })).toBe(1);
    expect(await aiOf(fileId)).toMatchObject({ status: 'undone', actions: null, result: null });
    expect((await aiOf(fileId)).undoing).toBeUndefined();

    const undone = (await eventsOf('file.ai_undone')).at(-1);
    expect(undone).toMatchObject({
      actorUserId: team.admin.userId, actorRole: 'org_admin', target: { type: 'file', id: fileId }, details: { locationId: l1, notes: 2, days: 2, items: 1 },
    });
    expect(Object.keys(undone?.details as object).sort()).toEqual(['days', 'items', 'locationId', 'notes']);
    expect(JSON.stringify(undone)).not.toMatch(/Qvzx|Wedding|Brunch|Moved/);
    expect(logLines(server).filter((line) => line.msg === 'townwise.ai_read_undone').at(-1)).toMatchObject({ fileId, notes: 2, days: 2, items: 1 });

    // Asking again after an undo reads the file afresh.
    expect((await call(server, `${itemPath(l1, `f_${fileId}`)}/ai`, { session: team.admin, json: {} })).status).toBe(202);
  });

  it('finishes an undo that stopped part way, and answers a second one with the item as it is, recording nothing more', async () => {
    const l1 = await newLocation();
    const { fileId, outcome } = await madeRead(team.member, l1);
    // An undo that stopped after marking the read and removing the notes.
    await server.connection.collection('tw_files').updateOne({ _id: oid(fileId) }, { $set: { 'ai.undoing': true } });
    await server.connection.collection('tw_notes').deleteMany({ locationId: oid(l1) });
    expect((await itemOf(team.member, l1, `f_${fileId}`)).ai?.canUndo).toBe(true);
    const res = await undo(team.member, l1, `f_${fileId}`);
    expect(res.status).toBe(200);
    expect(await count('tw_uploads', { _id: oid(String(outcome.uploadId)) })).toBe(0);
    expect(await count('tw_files', { _id: oid(String(outcome.itemId)) })).toBe(0);
    const recorded = (await eventsOf('file.ai_undone')).length;
    const again = await undo(team.member, l1, `f_${fileId}`);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ item: { ai: { status: 'undone' } }, calibrationKept: null });
    expect((await eventsOf('file.ai_undone')).length).toBe(recorded);
  });

  it('lets the person who asked or an org admin undo, and refuses anyone else (403) and view-as', async () => {
    const l1 = await newLocation();
    const { fileId } = await madeRead(team.member, l1);
    expect((await undo(team.other, l1, `f_${fileId}`)).status).toBe(403);
    expect((await itemOf(team.other, l1, `f_${fileId}`)).ai?.canUndo).toBe(false);
    const staff = await signInStaff(server);
    try {
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: team.admin.userId, orgId: team.orgId });
      const res = await undo(staff, l1, `f_${fileId}`);
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'view_as_read_only' });
      const seen = await itemOf(staff, l1, `f_${fileId}`);
      expect(seen.ai).toMatchObject({ canUndo: false, summary: null });
      expect(seen.ai?.notes.map((note) => note.title)).toEqual([null, null]);
      expect(seen.ai?.notes).toHaveLength(2);
    } finally {
      await removeStaffFactor(server);
    }
    expect((await undo(team.admin, l1, `f_${fileId}`)).status).toBe(200);
  });

  it('answers 409 while the read is queued or reading, and 400 nothing_to_undo when there is nothing to undo', async () => {
    const l1 = await newLocation();
    const queued = await seedStored(l1);
    expect((await call(server, `${itemPath(l1, `f_${queued}`)}/ai`, { session: team.member, json: {} })).status).toBe(202);
    const running = await undo(team.member, l1, `f_${queued}`);
    expect({ status: running.status, body: await running.json() as unknown }).toMatchObject({ status: 409, body: { error: 'ai_read_running' } });
    await server.connection.collection('tw_files').updateOne({ _id: oid(queued) }, { $set: { 'ai.status': 'reading' } });
    expect((await undo(team.member, l1, `f_${queued}`)).status).toBe(409);
    await server.connection.collection('tw_files').updateOne({ _id: oid(queued) }, { $set: { 'ai.status': 'skipped' } });

    const never = await seedStored(l1);
    const failed = await seedStored(l1);
    await server.connection.collection('tw_files').updateOne({ _id: oid(failed) }, { $set: {
      ai: { status: 'failed', reason: 'refused', requestedBy: team.member.userId, requestedByRole: 'member', requestedByStaff: false, requestedGrantId: null,
        requestedAt: server.clock.now(), attempts: 1, leaseUntil: null, startedAt: null, finishedAt: null, partial: false, costMicroUsd: 0, result: null },
    } });
    const nothing = await seedStored(l1);
    answers = [answer({ kind: 'menu', summary: '', events: [] })];
    await readAs(team.member, l1, nothing);
    for (const fileId of [never, failed, nothing]) {
      const res = await undo(team.member, l1, `f_${fileId}`);
      expect({ fileId, status: res.status, body: await res.json() as unknown }).toMatchObject({ fileId, status: 400, body: { error: 'nothing_to_undo' } });
    }
    expect((await itemOf(team.member, l1, `f_${nothing}`)).ai?.canUndo).toBe(false);
    const unknown = await undo(team.member, l1, `f_${new Types.ObjectId().toHexString()}`);
    expect(unknown.status).toBe(404);
  });
});

// ---- The original deleted ---------------------------------------------------------------------------------------------

describe('a read whose original is deleted', () => {
  it('loses what TownwiseAI kept of the file’s content when its owner deletes the original; its kind and counts stay', async () => {
    const l1 = await newLocation();
    const days = mayDays(2);
    const fileId = await seedStored(l1, { raw: salesCsv(days), by: team.member, status: 'read' });
    answers = [salesAnswer(days, { summary: 'Daily totals for May.', facts: ['Two days'], events: [EVENT] })];
    await readAs(team.member, l1, fileId);
    const res = await call(server, `/api/org/locations/${l1}/files/${fileId}/raw`, { session: team.member, method: 'DELETE' });
    expect(res.status).toBe(200);
    expect((await aiOf(fileId)).result).toEqual({
      kind: 'sales', confidence: 'high', summary: '', facts: [], events: [], days: [], daysCut: false, eventCount: 1, dayCount: 2, daysBorneOut: [],
    });
    const item = await itemOf(team.member, l1, `f_${fileId}`);
    expect(item.ai).toMatchObject({ status: 'done', kind: 'sales', summary: '', facts: [], daysWritten: 2 });
    expect(item.ai?.notes.map((note) => note.title)).toEqual([null]);
    // The summary item stays: the owner deleted the original only.
    expect(await count('tw_files', { 'source.fileId': oid(fileId) })).toBe(1);
  });

  it('removes the summary items TownwiseAI kept from a file when staff purge the organization’s originals', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    await readAs(team.member, l1, fileId);
    const { itemId } = await outcomeOf(fileId);
    expect(await count('tw_files', { _id: oid(String(itemId)) })).toBe(1);
    const staff = await signInStaff(server);
    try {
      const res = await call(server, `/api/admin/orgs/${team.orgId}/originals/delete`, { session: staff, json: { basis: 'data_subject_request' } });
      expect(res.status).toBe(200);
    } finally {
      await removeStaffFactor(server);
    }
    expect(await count('tw_files', { _id: oid(String(itemId)) })).toBe(0);
    expect((await aiOf(fileId)).result).toMatchObject({ summary: '', facts: [], events: [], kind: 'calendar' });
    expect(logLines(server).filter((line) => line.msg === 'townwise.originals_deleted').at(-1)).toMatchObject({ by: 'staff' });
    expect((logLines(server).filter((line) => line.msg === 'townwise.originals_deleted').at(-1)?.deletedSummaries as number)).toBeGreaterThanOrEqual(1);
  });
});
