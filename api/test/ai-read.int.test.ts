// Reading with TownwiseAI (spec 11A.9, D34) end to end against the database: the opt-in route (who may, refusals,
// 409 while running, a double press, the queue cap, audit), the item's canAiRead and ai fields, and the reader (claim
// order, lease takeover, one read an organization at a time, attempts and their backoff, the budget checked before the
// original is read and reserved before the call, each input kind, skips, the cut, refusal, an answer cut at max_tokens,
// a refused request, the answer checked, the onRead seam, and a request that holds no file, organization or location
// name). The model is a scripted fake: no call leaves the test.
import { randomUUID } from 'node:crypto';

import { createRateLimiter } from '@ckeith26/rate-limit';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import type { AiFileRead } from '../src/files/ai-reader.ts';
import type { FileReaderModel, ReaderAnswer, ReaderRequest } from '../src/files/extract/reader.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import type { DataItemView } from '../src/handlers/data.ts';
import { readerCeilingMicroUsd } from '../src/files/extract/reader.ts';
import { addGrant, addLocation, addSeat, addUpload, auditEvents, createOrg } from './helpers/fixtures.ts';
import { pdfOf, row } from './helpers/pdf.ts';
import { xlsxOf, zipOf } from './helpers/zip.ts';
import {
  call, logLines, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const SENTINEL = 'Zqxj';
const MIB = 1024 * 1024;

const ANSWER = {
  kind: 'calendar', confidence: 'high', summary: 'A list of June events.', facts: ['Three events in June'],
  events: [{ title: 'Wedding dinner', startDate: '2026-06-14', endDate: '2026-06-14', kind: 'private_event', effect: 'more', expectedGuests: 80, detail: 'Back room' }],
  days: [{ date: '2026-05-01', guests: 120, netSales: 3456.5 }],
};

// ---- The fake model and the onRead seam -------------------------------------------------------------------------

let answers: ReaderAnswer[] = [];
const requests: ReaderRequest[] = [];
/** While set, a call waits for it; `calling` resolves once a call has started. */
let gate: Promise<void> | null = null;
let started: (() => void) | null = null;
const model: FileReaderModel = {
  async readFile(request) {
    requests.push(request);
    started?.();
    if (gate !== null) await gate;
    return answers.shift() ?? { kind: 'answered', output: ANSWER, costMicroUsd: 2500 };
  },
};

interface Hooked { fileId: string; status: unknown; saved: boolean; read: AiFileRead }
const hooked: Hooked[] = [];
let hookThrows = 0;

let server: TownwiseTestServer;
let noAi: TownwiseTestServer;
let filesOff: TownwiseTestServer;
let blobs: MemoryFileBlobs;

interface Team {
  orgId: string; orgName: string;
  admin: TestSession; adminEmail: string;
  member: TestSession; memberEmail: string;
  other: TestSession; otherEmail: string;
}
let team: Team;

async function newTeam(name: string): Promise<Team> {
  const orgName = `${name} ${randomUUID().slice(0, 6)}`;
  const orgId = await createOrg(server, { name: orgName });
  const [adminEmail, memberEmail, otherEmail] = ['admin', 'member', 'other'].map((who) => `${who}-${randomUUID().slice(0, 8)}@example.test`) as [string, string, string];
  const admin = await signIn(server, adminEmail);
  const member = await signIn(server, memberEmail);
  const other = await signIn(server, otherEmail);
  await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(server, { orgId, userId: member.userId, email: memberEmail });
  await addSeat(server, { orgId, userId: other.userId, email: otherEmail });
  return { orgId, orgName, admin, adminEmail, member, memberEmail, other, otherEmail };
}

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  // Each start drops the database, so all three start before any fixture.
  filesOff = await startTownwiseServer();
  noAi = await startTownwiseServer({ files: createMemoryFileBlobs() });
  server = await startTownwiseServer({
    files: blobs,
    aiReader: {
      model,
      onRead: async (_scope, file, read) => {
        const doc = await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(file.id) });
        const ai = doc?.ai as { status?: unknown; result?: unknown } | undefined;
        hooked.push({ fileId: file.id, status: ai?.status, saved: ai?.result !== null && ai?.result !== undefined, read });
        if (hookThrows > 0) {
          hookThrows -= 1;
          throw new Error('hook failed');
        }
        return null;
      },
    },
  });
  team = await newTeam(`${SENTINEL} Org`);
});
afterAll(async () => {
  await server.close();
  await noAi.close();
  await filesOff.close();
});
beforeEach(async () => {
  answers = [];
  requests.length = 0;
  hooked.length = 0;
  hookThrows = 0;
  gate = null;
  started = null;
  await server.redis.flushdb();
  await server.connection.collection('tw_files_usage').deleteMany({});
  // Reads left queued by an earlier test never run in a later one.
  await server.connection.collection('tw_files').updateMany({ 'ai.status': { $in: ['queued', 'reading'] } }, { $set: { 'ai.status': 'skipped' } });
});

const scopeOf = (orgId: string): OrgScope => ({ orgId }) as unknown as OrgScope;

function newLocation(orgId = team.orgId): Promise<string> {
  return addLocation(server, { orgId, name: `${SENTINEL} Room ${randomUUID().slice(0, 6)}` });
}

interface Seed {
  name?: string; kind?: string; raw?: Buffer | null; by?: TestSession; role?: 'org_admin' | 'member'; status?: string;
  purpose?: 'history' | 'reference'; sizeBytes?: number; uploadId?: string; rawDeletedAt?: Date; ai?: Record<string, unknown>;
  orgId?: string; byStaff?: boolean;
}

/** A tw_files row written straight in, with its original in the memory blobs (none for `raw: null`). */
async function seedStored(locationId: string, seed: Seed = {}): Promise<string> {
  const _id = new Types.ObjectId();
  const raw = seed.raw === undefined ? Buffer.from(`Date,Event\n2026-06-14,${SENTINEL} wedding\n`) : seed.raw;
  const orgId = seed.orgId ?? team.orgId;
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), importId: null, purpose: seed.purpose ?? 'reference',
    uploadedBy: (seed.by ?? team.member).userId, uploaderRole: seed.role ?? (seed.by === team.admin ? 'org_admin' : 'member'),
    ...(seed.byStaff === true ? { byStaff: true } : {}),
    uploadedAt: server.clock.now(), name: seed.name ?? `${SENTINEL} events.csv`, kind: seed.kind ?? 'text',
    sizeBytes: seed.sizeBytes ?? raw?.length ?? 10, fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: seed.status ?? 'kept',
    outcome: 'reference', progress: null, readStartedAt: null, readMs: null, answers: {},
    uploadId: seed.uploadId === undefined ? null : new Types.ObjectId(seed.uploadId), result: null, report: null, cleanBytes: null,
    rawDeletedAt: seed.rawDeletedAt ?? null, attempts: 0, ...(seed.ai === undefined ? {} : { ai: seed.ai }),
  });
  if (raw !== null) await blobs.writeRaw(scopeOf(orgId), { locationId, fileId: _id.toHexString() }, raw, 'application/octet-stream');
  return _id.toHexString();
}

/** An `ai` subdocument as the route writes one, with `over` on top. */
function aiDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'queued', requestedBy: team.member.userId, requestedByRole: 'member', requestedByStaff: false, requestedGrantId: null,
    requestedAt: server.clock.now(), attempts: 0, leaseUntil: null, startedAt: null, finishedAt: null, reason: null, partial: false,
    costMicroUsd: 0, result: null, ...over,
  };
}

const itemPath = (locationId: string, ref: string): string => `/api/org/locations/${locationId}/data/${ref}`;

function ask(session: TestSession, locationId: string, ref: string, on: TownwiseTestServer = server, json: unknown = {}): Promise<Response> {
  return call(on, `${itemPath(locationId, ref)}/ai`, { session, json });
}

async function itemOf(session: TestSession, locationId: string, ref: string): Promise<DataItemView> {
  const res = await call(server, itemPath(locationId, ref), { session });
  expect(res.status).toBe(200);
  return (await res.json() as { item: DataItemView }).item;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: (await res.json() as { error: string }).error };
}

async function aiOf(fileId: string): Promise<Record<string, unknown>> {
  const doc = await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(fileId) });
  return (doc?.ai ?? {}) as Record<string, unknown>;
}

/** Runs the reader until it has nothing left it can claim. */
async function read(): Promise<void> {
  server.aiReader?.nudge();
  await server.aiReader?.settled();
}

/**
 * Runs the reader again as if every backoff had passed (the queued reads' notBefore cleared rather than the clock moved
 * on, which would end the test sessions).
 */
async function readAfterBackoff(): Promise<void> {
  await server.connection.collection('tw_files').updateMany({ 'ai.status': 'queued' }, { $set: { 'ai.notBefore': null } });
  await read();
}

async function usageOf(orgId = team.orgId): Promise<number> {
  const doc = await server.connection.collection('tw_files_usage').findOne({ orgId: new Types.ObjectId(orgId) });
  return Number(doc?.costMicroUsd ?? 0);
}

async function eventsOf(action: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => event.action === action);
}

// ---- The route ------------------------------------------------------------------------------------------------------

describe('POST /api/org/locations/:locationId/data/:ref/ai', () => {
  it('lets the person who added a file ask: 202 queued, audited with the location and kind only, then read and shown on the item', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    const before = await itemOf(team.member, l1, `f_${fileId}`);
    expect(before).toMatchObject({ canAiRead: true, ai: null });
    const res = await ask(team.member, l1, `f_${fileId}`);
    expect(res.status).toBe(202);
    const queued = (await res.json() as { item: DataItemView }).item;
    expect(queued).toMatchObject({ ref: `f_${fileId}`, canAiRead: false, ai: { status: 'queued', reason: null, partial: false, kind: null, summary: null, facts: null } });
    const requested = (await eventsOf('file.ai_read_requested')).at(-1);
    expect(requested).toMatchObject({
      actorUserId: team.member.userId, actorRole: 'member', target: { type: 'file', id: fileId }, details: { locationId: l1, kind: 'text' },
    });
    expect(String(requested?.orgId)).toBe(team.orgId);
    expect(Object.keys(requested?.details as object).sort()).toEqual(['kind', 'locationId']);
    expect(JSON.stringify(requested)).not.toContain(SENTINEL);

    await read();
    const done = await itemOf(team.member, l1, `f_${fileId}`);
    expect(done).toMatchObject({ canAiRead: false });
    expect(done.ai).toEqual({
      status: 'done', reason: null, partial: false, kind: 'calendar', summary: 'A list of June events.', facts: ['Three events in June'],
      daysCut: false, notes: [], notesSkipped: null, daysWritten: 0, daysAlreadyHad: 0, uploadRef: null, itemRef: null, daysReason: null,
      itemReason: null, calibration: null, canUndo: false, rulesSuggested: 0, rulesWaiting: 0,
    });
    expect(await aiOf(fileId)).toMatchObject({ status: 'done', attempts: 1, leaseUntil: null, costMicroUsd: 2500, requestedBy: team.member.userId });
    const readEvent = (await eventsOf('file.ai_read')).at(-1);
    expect(readEvent).toMatchObject({
      actorUserId: team.member.userId, actorEmail: team.memberEmail, actorRole: 'member', viewAsGrantId: null, target: { type: 'file', id: fileId },
      details: { locationId: l1, kind: 'calendar', events: 1, days: 1 },
    });
    expect(JSON.stringify(readEvent)).not.toMatch(/Zqxj|June events|Wedding/);
    const line = logLines(server).filter((each) => each.msg === 'townwise.ai_read').at(-1);
    expect(line).toMatchObject({ fileId, kind: 'calendar', confidence: 'high', events: 1, days: 1, partial: false, costMicroUsd: 2500 });
    expect(server.logs.join('\n')).not.toMatch(/Zqxj|June events|Wedding dinner/);
    // The reservation made before the call became what it cost.
    expect(await usageOf()).toBe(2500);
  });

  it('refuses a read while the organization has 10 queued or reading (429 ai_read_queue_full)', async () => {
    const l1 = await newLocation();
    const waiting = await Promise.all(Array.from({ length: 10 }, () => seedStored(l1, { ai: aiDoc({ status: 'queued', notBefore: new Date(server.clock.now().getTime() + 3_600_000) }) })));
    const fileId = await seedStored(l1);
    expect(await errorOf(await ask(team.member, l1, `f_${fileId}`))).toEqual({ status: 429, error: 'ai_read_queue_full' });
    expect(await aiOf(fileId)).toEqual({});
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(waiting[0] ?? '') }, { $set: { 'ai.status': 'done' } });
    expect((await ask(team.member, l1, `f_${fileId}`)).status).toBe(202);
    await server.connection.collection('tw_files').updateMany({ _id: { $in: waiting.map((id) => new Types.ObjectId(id)) } }, { $set: { 'ai.status': 'skipped' } });
    await read();
  });

  it('counts each request against the route’s own limiter: 30 an hour per account', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    const limiter = createRateLimiter({ redis: server.redis, name: 'townwise:ai-reads', limit: 30, windowSeconds: 3600 });
    for (let index = 0; index < 30; index += 1) await limiter.consume(`acct:${team.member.userId}`);
    expect((await ask(team.member, l1, `f_${fileId}`)).status).toBe(429);
    expect(await aiOf(fileId)).toEqual({});
  });

  it('lets an org admin ask for a member’s file, and refuses another member (403), whose canAiRead is false', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    expect((await itemOf(team.other, l1, `f_${fileId}`)).canAiRead).toBe(false);
    expect(await errorOf(await ask(team.other, l1, `f_${fileId}`))).toEqual({ status: 403, error: 'forbidden' });
    expect(await aiOf(fileId)).toEqual({});
    expect((await itemOf(team.admin, l1, `f_${fileId}`)).canAiRead).toBe(true);
    expect((await ask(team.admin, l1, `f_${fileId}`)).status).toBe(202);
    expect(await aiOf(fileId)).toMatchObject({ requestedBy: team.admin.userId, requestedByRole: 'org_admin', requestedByStaff: false });
    await read();
  });

  it('lets only an org admin ask for a file Townwise staff stored', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { by: team.member, byStaff: true });
    expect(await errorOf(await ask(team.member, l1, `f_${fileId}`))).toEqual({ status: 403, error: 'forbidden' });
    expect((await ask(team.admin, l1, `f_${fileId}`)).status).toBe(202);
    await read();
  });

  it('reads the stored file an upload was read from (a u_ ref), and refuses an upload with no stored file (400)', async () => {
    const l1 = await newLocation();
    const uploadId = await addUpload(server, { orgId: team.orgId, locationId: l1, uploadedAt: server.clock.now(), status: 'applied', uploadedBy: team.member.userId });
    const fileId = await seedStored(l1, { purpose: 'history', status: 'read', uploadId });
    const res = await ask(team.member, l1, `u_${uploadId}`);
    expect(res.status).toBe(202);
    expect((await res.json() as { item: DataItemView }).item).toMatchObject({ ref: `u_${uploadId}`, ai: { status: 'queued' } });
    await read();
    expect(await aiOf(fileId)).toMatchObject({ status: 'done', requestedBy: team.member.userId });
    expect((await itemOf(team.member, l1, `u_${uploadId}`)).ai).toMatchObject({ status: 'done', kind: 'calendar' });
    const browser = await addUpload(server, { orgId: team.orgId, locationId: l1, uploadedAt: server.clock.now(), status: 'applied', uploadedBy: team.member.userId });
    expect((await itemOf(team.member, l1, `u_${browser}`)).canAiRead).toBe(false);
    expect(await errorOf(await ask(team.member, l1, `u_${browser}`))).toEqual({ status: 400, error: 'invalid_request' });
  });

  it('answers 404 for an unknown item, another organization’s item or location, like any unknown id', async () => {
    const l1 = await newLocation();
    const other = await newTeam('Other');
    const theirLocation = await newLocation(other.orgId);
    const theirFile = await seedStored(theirLocation, { orgId: other.orgId, by: other.member });
    for (const [location, ref] of [[l1, `f_${new Types.ObjectId().toHexString()}`], [l1, `f_${theirFile}`], [theirLocation, `f_${theirFile}`]] as const) {
      const res = await ask(team.admin, location, ref);
      const text = await res.text();
      expect({ location, ref, status: res.status }).toEqual({ location, ref, status: 404 });
      expect(JSON.parse(text)).toMatchObject({ error: 'not_found' });
      expect(text).not.toContain(SENTINEL);
    }
    expect(await aiOf(theirFile)).toEqual({});
    expect(await errorOf(await ask(team.admin, l1, 'f_nothex'))).toEqual({ status: 400, error: 'invalid_request' });
    expect(await errorOf(await ask(team.admin, l1, `f_${new Types.ObjectId().toHexString()}`, server, { now: true }))).toEqual({ status: 400, error: 'invalid_request' });
  });

  it('answers 409 ai_read_running while a read is queued or reading, then the item unchanged once done, recording nothing more', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    let open: () => void = () => undefined;
    gate = new Promise((resolve) => { open = resolve; });
    const calling = new Promise<void>((resolve) => { started = resolve; });
    expect((await ask(team.member, l1, `f_${fileId}`)).status).toBe(202);
    expect(await errorOf(await ask(team.member, l1, `f_${fileId}`))).toEqual({ status: 409, error: 'ai_read_running' });
    await calling;
    expect(await aiOf(fileId)).toMatchObject({ status: 'reading' });
    expect(await errorOf(await ask(team.admin, l1, `f_${fileId}`))).toEqual({ status: 409, error: 'ai_read_running' });
    open();
    await server.aiReader?.settled();
    const requested = (await eventsOf('file.ai_read_requested')).length;
    const again = await ask(team.member, l1, `f_${fileId}`);
    expect(again.status).toBe(200);
    expect((await again.json() as { item: DataItemView }).item.ai).toMatchObject({ status: 'done', summary: 'A list of June events.' });
    expect((await eventsOf('file.ai_read_requested')).length).toBe(requested);
    await read();
    expect(requests).toHaveLength(1);
    expect(await aiOf(fileId)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('lets a failed or skipped read be asked for again', async () => {
    const l1 = await newLocation();
    const failed = await seedStored(l1, { ai: aiDoc({ status: 'failed', reason: 'refused' }) });
    const skipped = await seedStored(l1, { ai: aiDoc({ status: 'skipped', reason: 'budget_spent' }) });
    for (const fileId of [failed, skipped]) {
      expect((await itemOf(team.member, l1, `f_${fileId}`)).canAiRead).toBe(true);
      const res = await ask(team.member, l1, `f_${fileId}`);
      expect(res.status).toBe(202);
      expect((await res.json() as { item: DataItemView }).item.ai).toMatchObject({ status: 'queued', reason: null });
    }
    await read();
    for (const fileId of [failed, skipped]) expect(await aiOf(fileId)).toMatchObject({ status: 'done', reason: null, attempts: 1 });
  });

  it('refuses a file whose original was deleted, or one Townwise is still reading (400)', async () => {
    const l1 = await newLocation();
    const gone = await seedStored(l1, { rawDeletedAt: server.clock.now(), raw: null });
    const busy = await seedStored(l1, { purpose: 'history', status: 'queued' });
    for (const fileId of [gone, busy]) {
      expect((await itemOf(team.member, l1, `f_${fileId}`)).canAiRead).toBe(false);
      expect(await errorOf(await ask(team.member, l1, `f_${fileId}`))).toEqual({ status: 400, error: 'invalid_request' });
      expect(await aiOf(fileId)).toEqual({});
    }
  });

  it('answers 503 files_unavailable while stored files are off, and 503 ai_unavailable while reading with TownwiseAI is off', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1);
    const offMember = await signIn(filesOff, team.memberEmail);
    expect(await errorOf(await ask(offMember, l1, `f_${fileId}`, filesOff))).toEqual({ status: 503, error: 'files_unavailable' });
    const noAiMember = await signIn(noAi, team.memberEmail);
    expect(await errorOf(await ask(noAiMember, l1, `f_${fileId}`, noAi))).toEqual({ status: 503, error: 'ai_unavailable' });
    const item = (await (await call(noAi, itemPath(l1, `f_${fileId}`), { session: noAiMember })).json() as { item: DataItemView }).item;
    expect(item.canAiRead).toBe(false);
    expect(await aiOf(fileId)).toEqual({});
  });

  describe('view-as', () => {
    afterEach(async () => { await removeStaffFactor(server); });

    it('refuses the request (403 view_as_read_only) and shows a done read with no summary or facts', async () => {
      const l1 = await newLocation();
      const fileId = await seedStored(l1, { ai: aiDoc({ status: 'done', result: { ...ANSWER } }) });
      const fresh = await seedStored(l1);
      const staff = await signInStaff(server);
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: team.admin.userId, orgId: team.orgId });
      expect(await errorOf(await ask(staff, l1, `f_${fresh}`))).toEqual({ status: 403, error: 'view_as_read_only' });
      const item = await itemOf(staff, l1, `f_${fileId}`);
      expect(item).toMatchObject({ canAiRead: false, ai: { status: 'done', kind: 'calendar', summary: null, facts: null } });
      expect((await itemOf(staff, l1, `f_${fresh}`)).canAiRead).toBe(false);
      expect((await itemOf(team.admin, l1, `f_${fileId}`)).ai).toMatchObject({ summary: 'A list of June events.', facts: ['Three events in June'] });
    });
  });
});

// ---- The reader -----------------------------------------------------------------------------------------------------

/** The serialized request the model was sent for the file whose text includes `marker`. */
function requestWith(marker: string): string {
  const found = requests.map((request) => JSON.stringify(request)).find((text) => text.includes(marker));
  if (found === undefined) throw new Error(`no request with ${marker}`);
  return found;
}

function contentOf(request: ReaderRequest | undefined): Record<string, unknown>[] {
  const content = request?.messages[0]?.content;
  return Array.isArray(content) ? content as unknown as Record<string, unknown>[] : [];
}

describe('the TownwiseAI reader', () => {
  it('reads the oldest request first', async () => {
    const l1 = await newLocation();
    const at = server.clock.now().getTime();
    const later = await seedStored(l1, { raw: Buffer.from('second file'), ai: aiDoc({ requestedAt: new Date(at - 1000) }) });
    const earlier = await seedStored(l1, { raw: Buffer.from('first file'), ai: aiDoc({ requestedAt: new Date(at - 5000) }) });
    await read();
    expect(hooked.map((each) => each.fileId)).toEqual([earlier, later]);
    expect(JSON.stringify(requests[0])).toContain('first file');
  });

  it('takes over a read whose lease ran out, and leaves one under a live lease', async () => {
    const l1 = await newLocation();
    const other = await newTeam('Lease');
    const theirs = await newLocation(other.orgId);
    const now = server.clock.now().getTime();
    const stopped = await seedStored(l1, { ai: aiDoc({ status: 'reading', attempts: 1, leaseUntil: new Date(now - 1000), startedAt: new Date(now - 100_000) }) });
    const live = await seedStored(theirs, {
      orgId: other.orgId, by: other.member, ai: aiDoc({ requestedBy: other.member.userId, status: 'reading', attempts: 1, leaseUntil: new Date(now + 60_000) }),
    });
    await read();
    expect(await aiOf(stopped)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await aiOf(live)).toMatchObject({ status: 'reading', attempts: 1 });
    server.clock.advance(61_000);
    await read();
    expect(await aiOf(live)).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('never claims a second read of an organization that has one reading under a live lease', async () => {
    const l1 = await newLocation();
    const other = await newTeam('Fair');
    const theirs = await newLocation(other.orgId);
    const now = server.clock.now().getTime();
    const running = await seedStored(l1, { ai: aiDoc({ status: 'reading', attempts: 1, leaseUntil: new Date(now + 60_000), requestedAt: new Date(now - 9000) }) });
    const waiting = await seedStored(l1, { ai: aiDoc({ requestedAt: new Date(now - 8000) }) });
    const later = await seedStored(theirs, { orgId: other.orgId, by: other.member, ai: aiDoc({ requestedBy: other.member.userId, requestedAt: new Date(now - 1000) }) });
    await read();
    expect(await aiOf(waiting)).toMatchObject({ status: 'queued', attempts: 0 });
    expect(await aiOf(later)).toMatchObject({ status: 'done' });
    // The live read's replica stopped: once its lease runs out both of the organization's reads are taken, one at a time.
    server.clock.advance(61_000);
    await read();
    expect(await aiOf(running)).toMatchObject({ status: 'done', attempts: 2 });
    expect(await aiOf(waiting)).toMatchObject({ status: 'done', attempts: 1 });
  });

  it('puts a read back after a failed call to wait 1, then 2 minutes, and fails it internal after three attempts, writing nothing else', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { ai: aiDoc() });
    answers = [1, 2, 3].map(() => ({ kind: 'failed', errType: 'APIConnectionError', status: null }));
    const start = server.clock.now().getTime();
    await read();
    expect(requests).toHaveLength(1);
    expect(await aiOf(fileId)).toMatchObject({ status: 'queued', attempts: 1, notBefore: new Date(start + 60_000) });
    server.clock.advance(59_000);
    await read();
    expect(requests).toHaveLength(1);
    server.clock.advance(1000);
    await read();
    expect(requests).toHaveLength(2);
    expect(await aiOf(fileId)).toMatchObject({ status: 'queued', attempts: 2, notBefore: new Date(start + 60_000 + 120_000) });
    await readAfterBackoff();
    await readAfterBackoff();
    expect(requests).toHaveLength(3);
    expect(await aiOf(fileId)).toMatchObject({ status: 'failed', reason: 'internal', attempts: 4, result: null, costMicroUsd: 0, leaseUntil: null });
    expect(hooked).toEqual([]);
    expect(logLines(server).filter((each) => each.msg === 'townwise.ai_read_model_failed' && each.fileId === fileId)).toHaveLength(3);
    // Each reservation was given back: no call answered.
    expect(await usageOf()).toBe(0);
  });

  it('fails a read at once when the API refuses the request itself (a 4xx but 408, 409 and 429), and retries a rate limit', async () => {
    const l1 = await newLocation();
    const refused = await seedStored(l1, { ai: aiDoc() });
    answers = [{ kind: 'failed', errType: 'BadRequestError', status: 400 }];
    await read();
    expect(requests).toHaveLength(1);
    expect(await aiOf(refused)).toMatchObject({ status: 'failed', reason: 'internal', attempts: 1, result: null, costMicroUsd: 0 });
    const limited = await seedStored(l1, { ai: aiDoc() });
    answers = [{ kind: 'failed', errType: 'RateLimitError', status: 429 }];
    await read();
    expect(await aiOf(limited)).toMatchObject({ status: 'queued', attempts: 1 });
    await readAfterBackoff();
    expect(await aiOf(limited)).toMatchObject({ status: 'done', attempts: 2 });
    expect(requests).toHaveLength(3);
  });

  it('skips a read once the month’s budget is spent, without a call and before reading the original', async () => {
    const l1 = await newLocation();
    await server.connection.collection('tw_files_usage').insertOne({
      orgId: new Types.ObjectId(team.orgId), month: server.clock.now().toISOString().slice(0, 7), costMicroUsd: 5_000_000, updatedAt: server.clock.now(),
    });
    const fileId = await seedStored(l1, { ai: aiDoc() });
    // Its original is missing too: the budget answers first.
    const missing = await seedStored(l1, { raw: null, ai: aiDoc() });
    await read();
    expect(requests).toEqual([]);
    expect(await aiOf(fileId)).toMatchObject({ status: 'skipped', reason: 'budget_spent', result: null });
    expect(await aiOf(missing)).toMatchObject({ status: 'skipped', reason: 'budget_spent' });
    expect((await itemOf(team.member, l1, `f_${fileId}`))).toMatchObject({ canAiRead: true, ai: { status: 'skipped', reason: 'budget_spent', summary: null } });
  });

  it('reserves the most the call can cost before it, skipping a read the rest of the budget cannot cover', async () => {
    const l1 = await newLocation();
    const text = 'Date,Covers\n2026-05-01,120\n';
    const ceiling = readerCeilingMicroUsd({ type: 'text', form: 'text', text, cut: false }, null);
    const month = server.clock.now().toISOString().slice(0, 7);
    await server.connection.collection('tw_files_usage').insertOne({
      orgId: new Types.ObjectId(team.orgId), month, costMicroUsd: 5_000_000 - ceiling + 1, updatedAt: server.clock.now(),
    });
    const short = await seedStored(l1, { raw: Buffer.from(text), ai: aiDoc() });
    await read();
    expect(requests).toEqual([]);
    expect(await aiOf(short)).toMatchObject({ status: 'skipped', reason: 'budget_spent' });

    await server.connection.collection('tw_files_usage').updateOne({ orgId: new Types.ObjectId(team.orgId), month }, { $set: { costMicroUsd: 5_000_000 - ceiling } });
    let open: () => void = () => undefined;
    gate = new Promise((resolve) => { open = resolve; });
    const calling = new Promise<void>((resolve) => { started = resolve; });
    const fits = await seedStored(l1, { raw: Buffer.from(text), ai: aiDoc() });
    server.aiReader?.nudge();
    await calling;
    const during = await usageOf();
    open();
    await server.aiReader?.settled();
    expect(during).toBe(5_000_000);
    expect(await aiOf(fits)).toMatchObject({ status: 'done', costMicroUsd: 2500 });
    expect(await usageOf()).toBe(5_000_000 - ceiling + 2500);
  });

  it('holds a suspended organization’s reads until it is active again', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { ai: aiDoc() });
    const orgs = server.connection.collection('tw_orgs');
    await orgs.updateOne({ _id: new Types.ObjectId(team.orgId) }, { $set: { status: 'suspended' } });
    try {
      await read();
      expect(await aiOf(fileId)).toMatchObject({ status: 'queued', attempts: 0 });
    } finally {
      await orgs.updateOne({ _id: new Types.ObjectId(team.orgId) }, { $set: { status: 'active' } });
    }
    await read();
    expect(await aiOf(fileId)).toMatchObject({ status: 'done' });
  });

  describe('input', () => {
    it('sends a PDF whole as a document, and checks the answer’s days against its text', async () => {
      const l1 = await newLocation();
      const pdf = pdfOf([{ texts: [{ text: 'Banquet schedule', x: 72, y: 760 }, ...row(700, [[72, '2026-05-01'], [200, '120'], [300, '$3,456.50']])] }]);
      await seedStored(l1, { kind: 'pdf', name: 'events.pdf', raw: pdf, ai: aiDoc() });
      await read();
      expect(contentOf(requests[0])[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } });
      expect(hooked[0]?.read.result.daysBorneOut).toEqual([0]);
    });

    it('sends a picture as an image by its bytes, whatever its name or kind, without its metadata, with no text to check against', async () => {
      const l1 = await newLocation();
      const chunk = (type: string, data: Buffer): Buffer => {
        const length = Buffer.alloc(4);
        length.writeUInt32BE(data.length);
        return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
      };
      const header = Buffer.concat([Buffer.from([0, 0, 0, 40, 0, 0, 0, 30]), Buffer.from([8, 2, 0, 0, 0])]);
      const pngOf = (...extra: Buffer[]): Buffer => Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), ...extra, chunk('IDAT', Buffer.from('pixels')), chunk('IEND', Buffer.alloc(0)),
      ]);
      await seedStored(l1, { kind: 'other', name: 'menu.txt', raw: pngOf(chunk('tEXt', Buffer.from('Author\0Sentinel-metadata')), chunk('eXIf', Buffer.from('Sentinel-gps'))), ai: aiDoc() });
      await read();
      expect(contentOf(requests[0])[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pngOf().toString('base64') } });
      expect(JSON.stringify(requests[0])).not.toMatch(/Sentinel/);
      expect(hooked[0]?.read.result.daysBorneOut).toBeNull();
    });

    it('sends a text file, a workbook and a Word document as text, and checks the answer’s days against each', async () => {
      const l1 = await newLocation();
      await seedStored(l1, { raw: Buffer.from('Date,Covers,Net\n2026-05-01,120,3456.50\n'), ai: aiDoc() });
      await seedStored(l1, { kind: 'xlsx', name: 'book.xlsx', raw: xlsxOf([{ name: 'Daily', rows: [['Date', 'Covers', 'Net'], ['2026-05-01', 120, 3456.5]] }]), ai: aiDoc() });
      const docx = zipOf([
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>Staff rota</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>2026-05-01</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>120</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$3,456.50</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>' },
      ]);
      await seedStored(l1, { kind: 'docx', name: 'rota.docx', raw: docx, ai: aiDoc() });
      await read();
      expect(requests).toHaveLength(3);
      expect(requestWith('Covers,Net\\n2026-05-01,120,3456.50')).toContain('The file is a text file');
      expect(requestWith('Sheet: Daily\\nDate\\tCovers\\tNet\\n2026-05-01\\t120\\t3456.5')).toContain('The file is an Excel workbook');
      expect(requestWith('Staff rota\\n2026-05-01\\t120\\t$3,456.50')).toContain('The file is a Word document');
      for (const request of requests) expect(contentOf(request)).toHaveLength(1);
      expect(hooked.map((each) => each.read.result.daysBorneOut)).toEqual([[0], [0], [0]]);
    });

    it('skips what it does not read, says why, and calls no model', async () => {
      const l1 = await newLocation();
      const cases: [Seed, string][] = [
        [{ kind: 'pdf', name: 'big.pdf', raw: Buffer.from('%PDF-1.4\n'), sizeBytes: 11 * MIB }, 'too_large'],
        // 3,750,000 bytes at most, so its base64 stays within the API's 5 MB.
        [{ kind: 'other', name: 'big.png', raw: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), sizeBytes: 3_750_001 }, 'too_large'],
        [{ kind: 'other', name: 'broken.png', raw: Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('rest of a picture')]) }, 'not_readable'],
        [{ kind: 'zip', name: 'all.zip', raw: zipOf([{ name: 'photo.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) }]) }, 'kind_not_read'],
        [{ kind: 'xls', name: 'old.xls', raw: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) }, 'kind_not_read'],
        [{ kind: 'other', name: 'locked.xlsx', raw: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1]) }, 'encrypted'],
        [{ kind: 'pdf', name: 'locked.pdf', raw: pdfOf([{ texts: [{ text: 'x', x: 72, y: 700 }] }], { encrypted: true }) }, 'encrypted'],
        [{ raw: null }, 'raw_missing'],
      ];
      const ids: string[] = [];
      for (const [seed] of cases) ids.push(await seedStored(l1, { ...seed, ai: aiDoc() }));
      await read();
      expect(requests).toEqual([]);
      for (const [index, [, reason]] of cases.entries()) expect({ index, ai: await aiOf(ids[index] ?? '') }).toMatchObject({ index, ai: { status: 'skipped', reason } });
      expect(hooked).toEqual([]);
    });

    it('cuts a text past 300,000 characters, marks the read partial and says so in the request', async () => {
      const l1 = await newLocation();
      const raw = Buffer.from(`${'a'.repeat(300_000)}TAIL-MARK${'b'.repeat(100_000)}`);
      const fileId = await seedStored(l1, { raw, ai: aiDoc() });
      await read();
      const text = contentOf(requests[0])[0]?.text as string;
      expect(text).toContain('only its start follows (at most 300,000 characters)');
      expect(text.slice(text.indexOf('--- FILE CONTENT ---\n') + '--- FILE CONTENT ---\n'.length)).toHaveLength(300_000);
      expect(text).not.toContain('TAIL-MARK');
      expect(await aiOf(fileId)).toMatchObject({ status: 'done', partial: true });
      expect(hooked[0]?.read.partial).toBe(true);
      expect((await itemOf(team.member, l1, `f_${fileId}`)).ai).toMatchObject({ partial: true });
    });
  });

  it('fails a read whose answer was cut at max_tokens as answer_too_long, charged, with no retry', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { ai: aiDoc() });
    answers = [{ kind: 'too_long', costMicroUsd: 1_300_000 }];
    await read();
    await readAfterBackoff();
    expect(requests).toHaveLength(1);
    expect(await aiOf(fileId)).toMatchObject({ status: 'failed', reason: 'answer_too_long', result: null, costMicroUsd: 1_300_000 });
    expect(await usageOf()).toBe(1_300_000);
    expect(hooked).toEqual([]);
  });

  it('fails a refused read as refused, charging it and writing no answer', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { ai: aiDoc() });
    answers = [{ kind: 'refused', costMicroUsd: 900 }];
    await read();
    expect(await aiOf(fileId)).toMatchObject({ status: 'failed', reason: 'refused', result: null, costMicroUsd: 900 });
    expect(await server.connection.collection('tw_files_usage').findOne({ orgId: new Types.ObjectId(team.orgId) })).toMatchObject({ costMicroUsd: 900 });
    expect(hooked).toEqual([]);
    expect((await eventsOf('file.ai_read')).filter((event) => (event.target as { id: string }).id === fileId)).toEqual([]);
    expect((await itemOf(team.member, l1, `f_${fileId}`))).toMatchObject({ canAiRead: true, ai: { status: 'failed', reason: 'refused', kind: null } });
  });

  it('keeps the answer checked again: malformed entries dropped, lists capped', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { ai: aiDoc() });
    answers = [{
      kind: 'answered', costMicroUsd: 100,
      output: { ...ANSWER, kind: 'secret', facts: ['ok', 'x'.repeat(500)], events: [{ ...ANSWER.events[0], startDate: 'June 14' }], days: [...ANSWER.days, { date: '2026-05-01', guests: 3, netSales: null }] },
    }];
    await read();
    expect((await aiOf(fileId)).result).toEqual({
      ...ANSWER, kind: 'other', facts: ['ok'], events: [], daysCut: false, eventCount: 0, dayCount: 1, daysBorneOut: [], closedPatterns: [],
    });
  });

  it('fails a read whose answer is not JSON as internal, charged, with no retry', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { ai: aiDoc() });
    answers = [{ kind: 'answered', output: null, costMicroUsd: 700 }];
    await read();
    expect(requests).toHaveLength(1);
    expect(await aiOf(fileId)).toMatchObject({ status: 'failed', reason: 'internal', result: null, costMicroUsd: 700 });
  });

  it('calls onRead once, after the answer is saved and before the read is done; a throw retries it on the saved answer without another call or the original', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { ai: aiDoc() });
    hookThrows = 1;
    await read();
    expect(hooked).toHaveLength(1);
    expect(await aiOf(fileId)).toMatchObject({ status: 'queued', attempts: 1 });
    // The retry needs neither: its original is gone from storage now.
    await blobs.deleteRaw(scopeOf(team.orgId), { locationId: l1, fileId });
    await readAfterBackoff();
    expect(requests).toHaveLength(1);
    expect(hooked).toHaveLength(2);
    for (const each of hooked) {
      expect(each).toMatchObject({ fileId, status: 'reading', saved: true, read: { partial: false, costMicroUsd: 2500 } });
      expect(each.read.result).toEqual({ ...ANSWER, daysCut: false, eventCount: 1, dayCount: 1, daysBorneOut: [], closedPatterns: [] });
    }
    expect(await aiOf(fileId)).toMatchObject({ status: 'done', attempts: 2, costMicroUsd: 2500 });
    expect(await usageOf()).toBe(2500);
  });

  it('sends no file name, organization name, location name or email: only the file’s content, the date and the time zone', async () => {
    const l1 = await newLocation();
    const fileId = await seedStored(l1, { name: `${SENTINEL} Private Party.csv`, raw: Buffer.from('Date,Covers\n2026-05-01,120\n') });
    expect((await ask(team.member, l1, `f_${fileId}`)).status).toBe(202);
    await read();
    const sent = JSON.stringify(requests[0]);
    expect(sent).toContain('2026-05-01,120');
    expect(sent).toContain('Today is 2026-06-01 in the restaurant\'s time zone, America/New_York.');
    for (const secret of [SENTINEL, team.orgName, team.memberEmail, team.adminEmail, 'Private Party', l1, fileId, team.orgId]) {
      expect(sent).not.toContain(secret);
    }
  });
});
