// D59 (openspec change auto-apply-agent-reads, design decisions 1, 3 and 4): automatic reads end to end. A file added
// to Your data, or dropped on onboarding, with its box checked (`aiAuto: true` on complete) is queued `auto` for its adder
// once Townwise stored it; a sales export read into days, a calendar export, a file whose box was unchecked or that sent
// no box at all, a file turned off, and any file while a switch is off are not. The reader skips a duplicate before
// anything is reserved, the 21st automatic read of a day (not counting a retry of itself), and one that would leave $1
// or less of the files month, while a press still runs. The model is a scripted fake: no call leaves the test. Every
// file and figure is made up.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { AUTO_READS_PER_DAY } from '../src/files/ai-reader.ts';
import { readerCeilingMicroUsd, type FileReaderModel, type ReaderAnswer, type ReaderRequest } from '../src/files/extract/reader.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { uploadFile } from './helpers/files.ts';
import { pdfOf } from './helpers/pdf.ts';
import { call, logLines, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const SENTINEL = 'Pkvw';

const ANSWER = {
  kind: 'calendar', confidence: 'high', summary: 'A list of December events.', facts: [],
  events: [{ title: 'Holiday party', startDate: '2026-12-12', endDate: '2026-12-12', kind: 'private_event', effect: 'more', expectedGuests: 40, detail: '', confidence: 'high' }],
  days: [], daysCut: false, closedPatterns: [],
};

let answers: ReaderAnswer[] = [];
const requests: ReaderRequest[] = [];
const model: FileReaderModel = {
  readFile(request) {
    requests.push(request);
    return Promise.resolve(answers.shift() ?? { kind: 'answered', output: ANSWER, costMicroUsd: 2000 });
  },
};

let server: TownwiseTestServer;
let blobs: MemoryFileBlobs;

interface Team { orgId: string; scope: OrgScope; admin: TestSession; member: TestSession; locationId: string }

async function person(orgId: string, role: 'org_admin' | 'member'): Promise<TestSession> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return session;
}

async function team(): Promise<Team> {
  const orgId = await createOrg(server, { name: `${SENTINEL} Kitchen ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: `${SENTINEL} Room` });
  return { orgId, scope: { orgId } as OrgScope, admin: await person(orgId, 'org_admin'), member: await person(orgId, 'member'), locationId };
}

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  server = await startTownwiseServer({ files: blobs, reader: {}, aiReader: { model } });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  // A read an earlier test's press woke finishes first.
  await server.aiReader?.settled();
  answers = [];
  requests.length = 0;
  await server.redis.flushdb();
  await server.connection.collection('tw_files_usage').deleteMany({});
  await server.connection.collection('tw_files').updateMany({ 'ai.status': { $in: ['queued', 'reading'] } }, { $set: { 'ai.status': 'skipped' } });
});

async function aiOf(fileId: string): Promise<Record<string, unknown> | null> {
  const doc = await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(fileId) });
  return (doc?.ai ?? null) as Record<string, unknown> | null;
}

async function read(): Promise<void> {
  server.aiReader?.nudge();
  await server.aiReader?.settled();
}

async function readHistory(): Promise<void> {
  server.reader?.nudge();
  await server.reader?.settled();
}

async function added(t: Team, name: string, bytes: Buffer, opts: { purpose?: 'history' | 'reference'; aiAuto?: boolean } = {}): Promise<string> {
  const res = await uploadFile(server, t.locationId, t.member, name, bytes, { purpose: 'reference', aiAuto: true, ...opts });
  expect(res.status).toBe(200);
  const id = res.body.file?.id;
  if (id === undefined) throw new Error('no file');
  const importId = (res.body.import as { id?: string; status?: string } | null)?.id;
  // A dropped file waits in its open import until someone starts it, as Read my history does.
  if (importId !== undefined && (res.body.import as { status?: string }).status === 'open') {
    expect((await call(server, `/api/org/locations/${t.locationId}/imports/${importId}/start`, { session: t.member, json: {} })).status).toBe(202);
  }
  return id;
}

function pdf(text: string): Buffer {
  return pdfOf([{ texts: [{ text, x: 72, y: 760 }] }]);
}

/** A stored reference file written straight in, as Townwise leaves one, with `over` on top. */
async function seeded(t: Team, over: Record<string, unknown> = {}): Promise<string> {
  const _id = new Types.ObjectId();
  const raw = Buffer.from(`Date,Event\n2026-12-12,${SENTINEL} party ${_id.toHexString()}\n`);
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(t.locationId), importId: null, purpose: 'reference',
    uploadedBy: t.member.userId, uploaderRole: 'member', uploadedAt: server.clock.now(), name: `${SENTINEL} events.csv`, kind: 'text',
    sizeBytes: raw.length, fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference',
    progress: null, readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null,
    rawDeletedAt: null, attempts: 0, ...over,
  });
  await blobs.writeRaw(t.scope, { locationId: t.locationId, fileId: _id.toHexString() }, raw, 'application/octet-stream');
  return _id.toHexString();
}

function autoAi(t: Team, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'queued', requestedBy: t.member.userId, requestedByRole: 'member', requestedByStaff: false, requestedGrantId: null,
    requestedAt: server.clock.now(), attempts: 0, leaseUntil: null, startedAt: null, finishedAt: null, reason: null, partial: false,
    costMicroUsd: 0, result: null, auto: true, chargedAt: null, ...over,
  };
}

async function usage(t: Team): Promise<number> {
  const doc = await server.connection.collection('tw_files_usage').findOne({ orgId: new Types.ObjectId(t.orgId) });
  return Number(doc?.costMicroUsd ?? 0);
}

describe('automatic reads are queued when a file is stored (D59)', () => {
  it('a PDF added with the box left checked is queued auto for its adder and read with no press, its event as TownwiseAI', async () => {
    const t = await team();
    const id = await added(t, `${SENTINEL} banquet.pdf`, pdf('Holiday party Dec 12'));
    expect(await aiOf(id)).toMatchObject({ status: 'queued', auto: true, requestedBy: t.member.userId, requestedByRole: 'member' });
    await read();
    expect(requests).toHaveLength(1);
    expect(await aiOf(id)).toMatchObject({ status: 'done', auto: true });
    expect((await aiOf(id))?.chargedAt).toBeInstanceOf(Date);
    const event = (await auditEvents(server)).find((each) => each.action === 'file.ai_read' && String(each.orgId) === t.orgId);
    expect(event).toMatchObject({ actorUserId: 'townwise_ai', actorRole: 'system' });
    expect(logLines(server).some((line) => line.msg === 'townwise.ai_read_auto_queued' && line.fileId === id)).toBe(true);
    expect(server.logs.join('\n')).not.toContain(SENTINEL);
  });

  it('a file whose box was unchecked is never queued, and a press still reads it', async () => {
    const t = await team();
    const id = await added(t, 'kept back.pdf', pdf('Kept back'), { aiAuto: false });
    expect(await aiOf(id)).toBeNull();
    expect((await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(id) }))?.aiAuto).toBeUndefined();
    expect((await call(server, `/api/org/locations/${t.locationId}/data/f_${id}/ai`, { session: t.member, json: {} })).status).toBe(202);
    await read();
    expect(await aiOf(id)).toMatchObject({ status: 'done' });
    expect((await aiOf(id))?.auto).toBeUndefined();
  });

  it('an upload that sends no box (a chat attachment, an item’s edit, an older client) is never queued', async () => {
    const t = await team();
    const res = await uploadFile(server, t.locationId, t.member, 'attachment.pdf', pdf('Attached'), { purpose: 'reference' });
    expect(res.status).toBe(200);
    expect(await aiOf(String(res.body.file?.id))).toBeNull();
    await read();
    expect(requests).toHaveLength(0);
  });

  it('the upload’s create says whether TownwiseAI reads files here on its own, so the client knows to send its box', async () => {
    const t = await team();
    const open = (): Promise<Response> => call(server, `/api/org/locations/${t.locationId}/files`, {
      session: t.member, json: { name: 'menu.pdf', sizeBytes: 10, purpose: 'reference' },
    });
    expect(await (await open()).json()).toMatchObject({ autoRead: true });
    // The box's choice now goes on complete, not on create.
    expect((await call(server, `/api/org/locations/${t.locationId}/files`, {
      session: t.member, json: { name: 'menu.pdf', sizeBytes: 10, purpose: 'reference', aiAuto: false },
    })).status).toBe(400);
    expect((await call(server, '/api/org/agent-auto', { method: 'PATCH', session: t.admin, json: { on: false } })).status).toBe(200);
    expect(await (await open()).json()).toMatchObject({ autoRead: false });
  });

  it('a file dropped on onboarding with its box checked is queued once the file reader keeps it', async () => {
    const t = await team();
    const id = await added(t, `${SENTINEL} banquet.pdf`, pdf('Holiday party Dec 12'), { purpose: 'history' });
    expect(await aiOf(id)).toBeNull();
    await readHistory();
    const file = await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(id) });
    expect(file?.status).not.toBe('read');
    expect(await aiOf(id)).toMatchObject({ status: 'queued', auto: true, requestedBy: t.member.userId });
  });

  it('nothing is queued while the organization’s switch is off, and a read queued before it was turned off is skipped', async () => {
    const t = await team();
    expect((await call(server, '/api/org/agent-auto', { method: 'PATCH', session: t.admin, json: { on: false } })).status).toBe(200);
    const queued = await seeded(t, { ai: autoAi(t) });
    const after = await added(t, 'after.pdf', pdf('After'));
    expect(await aiOf(after)).toBeNull();
    await read();
    expect(requests).toHaveLength(0);
    expect(await aiOf(queued)).toMatchObject({ status: 'skipped', reason: 'agent_auto_off' });
    expect(await usage(t)).toBe(0);
  });

  it('a sales export read into days and a calendar export are never queued', async () => {
    const t = await team();
    const sales = Buffer.from(['Date,Guests,Net Sales', '2026-05-01,120,3456.50', '2026-05-02,130,3600.00', '2026-05-03,90,2100.25'].join('\n'));
    const salesId = await added(t, 'pos export.csv', sales, { purpose: 'history' });
    await readHistory();
    const salesFile = await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(salesId) });
    expect(salesFile?.status).toBe('read');
    expect(salesFile?.ai).toBeUndefined();
    const calendar = Buffer.from(['event_id,title,start_at,end_at', `e1,${SENTINEL} party,2026-12-12T18:00,2026-12-12T22:00`].join('\n'));
    const calendarId = await added(t, 'calendar.csv', calendar, { purpose: 'history' });
    await readHistory();
    const calendarFile = await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(calendarId) });
    expect(calendarFile).toMatchObject({ status: 'kept', outcome: 'calendar_export' });
    expect(calendarFile?.ai).toBeUndefined();
  });
});

describe('the reader bounds automatic reads (D59)', () => {
  it('skips a file TownwiseAI already read under another file with the same bytes, before anything is reserved', async () => {
    const t = await team();
    const fingerprint = 'ab'.repeat(32);
    await seeded(t, { fingerprint, ai: autoAi(t, { status: 'done' }) });
    const twin = await seeded(t, { fingerprint, ai: autoAi(t) });
    await read();
    expect(requests).toHaveLength(0);
    expect(await aiOf(twin)).toMatchObject({ status: 'skipped', reason: 'duplicate' });
    expect(await usage(t)).toBe(0);
  });

  it('skips a file turned off while its automatic read waited, before anything is reserved or sent', async () => {
    const t = await team();
    const off = await seeded(t, { disabledAt: server.clock.now(), disabledBy: t.member.userId, ai: autoAi(t) });
    await read();
    expect(requests).toHaveLength(0);
    expect(await aiOf(off)).toMatchObject({ status: 'skipped', reason: 'turned_off' });
    expect(await usage(t)).toBe(0);
  });

  it('a file turned off is never queued for an automatic read', async () => {
    const t = await team();
    const off = await seeded(t, { disabledAt: server.clock.now(), disabledBy: t.member.userId, aiAuto: true });
    const at = server.clock.now();
    const input = { by: t.member.userId, role: 'member' as const, byStaff: false, grantId: null, at };
    expect(await server.ctx.stores.files.requestAutoRead(t.scope, t.locationId, off, input)).toBeNull();
    const on = await seeded(t, { aiAuto: true });
    expect(await server.ctx.stores.files.requestAutoRead(t.scope, t.locationId, on, input)).not.toBeNull();
  });

  it('a retry of the 20th automatic read of the day whose call gave no answer is read, not counted against itself', async () => {
    const t = await team();
    for (let i = 0; i < AUTO_READS_PER_DAY - 1; i += 1) await seeded(t, { ai: autoAi(t, { status: 'done', chargedAt: server.clock.now() }) });
    const twentieth = await seeded(t, { ai: autoAi(t) });
    answers = [{ kind: 'failed', errType: 'overloaded_error', status: 529 }];
    await read();
    expect(await aiOf(twentieth)).toMatchObject({ status: 'queued' });
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(twentieth) }, { $set: { 'ai.notBefore': null } });
    await read();
    expect(await aiOf(twentieth)).toMatchObject({ status: 'done' });
    expect(requests).toHaveLength(2);
  });

  it('reads 20 automatic files a day per organization and skips the 21st, while a press still runs', async () => {
    const t = await team();
    for (let i = 0; i < AUTO_READS_PER_DAY; i += 1) await seeded(t, { ai: autoAi(t, { status: 'done', chargedAt: server.clock.now() }) });
    const twentyFirst = await seeded(t, { ai: autoAi(t) });
    await read();
    expect(await aiOf(twentyFirst)).toMatchObject({ status: 'skipped', reason: 'daily_auto_limit' });
    expect(requests).toHaveLength(0);
    const pressed = await seeded(t);
    expect((await call(server, `/api/org/locations/${t.locationId}/data/f_${pressed}/ai`, { session: t.member, json: {} })).status).toBe(202);
    await read();
    expect(await aiOf(pressed)).toMatchObject({ status: 'done' });
    expect(requests).toHaveLength(1);
  });

  it('skips an automatic read that would leave $1 or less of the files month, while a press on another file still fits', async () => {
    const t = await team();
    const text = `Date,Event\n2026-12-12,${SENTINEL} party ${'0'.repeat(24)}\n`;
    const ceiling = readerCeilingMicroUsd({ type: 'text', form: 'text', text, cut: false }, null);
    const month = server.clock.now().toISOString().slice(0, 7);
    // $0.50 would be left after an automatic read's ceiling: under the $1 reserve.
    await server.connection.collection('tw_files_usage').insertOne({
      orgId: new Types.ObjectId(t.orgId), month, costMicroUsd: 5_000_000 - ceiling - 500_000, updatedAt: server.clock.now(),
    });
    const auto = await seeded(t, { ai: autoAi(t) });
    await read();
    expect(await aiOf(auto)).toMatchObject({ status: 'skipped', reason: 'budget_spent' });
    expect(requests).toHaveLength(0);
    const pressed = await seeded(t);
    expect((await call(server, `/api/org/locations/${t.locationId}/data/f_${pressed}/ai`, { session: t.member, json: {} })).status).toBe(202);
    await read();
    expect(await aiOf(pressed)).toMatchObject({ status: 'done' });
  });

  it('automatic reads never fill the queue a press needs, and a press is claimed before queued automatic reads', async () => {
    const t = await team();
    for (let i = 0; i < 12; i += 1) await seeded(t, { ai: autoAi(t) });
    const pressed = await seeded(t);
    expect((await call(server, `/api/org/locations/${t.locationId}/data/f_${pressed}/ai`, { session: t.member, json: {} })).status).toBe(202);
    // The press is the first read the model sees: each seeded file's text holds its own id.
    await read();
    expect(JSON.stringify(requests[0])).toContain(pressed);
    expect(requests).toHaveLength(13);
    expect(await aiOf(pressed)).toMatchObject({ status: 'done' });
  });
});
