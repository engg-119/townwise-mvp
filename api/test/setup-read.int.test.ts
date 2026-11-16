// Reading the ordering setup with TownwiseAI (spec D41) end to end against the database, over a scripted model (no call
// leaves the test): each input kind and what the request holds (the content and the saved names, never a point-of-sale,
// organization, location or file name), the answer, `canReadWithAi`, off, the files AI budget (spent, reserved before
// the call, corrected after it, a failed call charged what its stream reported, a refusal charged), the person leaving,
// the time limit from the request's start, a busy parse thread, who may read (view-as, staff opened as admin, another
// organization), the 400s and the body limit, the bytes a replica holds, nothing stored, and logs and audit that carry
// no name. Synthetic content only.
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { gzipSync } from 'node:zlib';

import { createRateLimiter } from '@ckeith26/rate-limit';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FileReaderModel, ReaderAnswer, ReaderRequest } from '../src/files/extract/reader.ts';
import type { AiTextInput, AiTextOutcome } from '../src/files/parse/ai-text.ts';
import { SlotBusy } from '../src/files/parse/thread-slot.ts';
import { setupCeilingMicroUsd } from '../src/files/extract/setup-reader.ts';
import { SETUP_FILE_BYTES, SETUP_READ_BODY_BYTES, SETUP_READ_BYTES_IN_FLIGHT } from '../src/files/limits.ts';
import { setupReadBytes } from '../src/handlers/order-setup-read.ts';
import { addGrant, addInvite, addLocation, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { pdfOf } from './helpers/pdf.ts';
import {
  call, logLines, removeStaffFactor, signIn, signInStaff, startTownwiseServer, writesDuring, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';
import { docxOf, xlsxOf, zipOf } from './helpers/zip.ts';

/** In every name the content and the answer hold: none of it may reach a log line or an audit event. */
const SENTINEL = 'Zqxj';
/** In names the request must never hold. */
const POS_SENTINEL = 'Posqv';
const ORG_SENTINEL = 'Orgqv';
const ROOM_SENTINEL = 'Roomqv';

const CONTENT = `${SENTINEL} Beverage invoice\nItem,Pack\n${SENTINEL} IPA,1/2 bbl\nReceived by ${SENTINEL} Person, 603-555-0142\n`;

const ANSWER = {
  kind: 'invoice', confidence: 'high',
  suppliers: [{ name: `${SENTINEL} Beverage`, deliveries: [{ deliveryWeekday: 2, cutoffWeekday: 0, cutoffTime: '14:00' }] }],
  items: [{
    name: `${SENTINEL} IPA`, supplier: `${SENTINEL} Beverage`, category: 'draft', unit: 'kegs', servingsPerUnit: 124, servingsEstimated: true,
    dealSize: null, posNames: [{ name: `${SENTINEL} pint`, perSale: 1 }], note: `${SENTINEL} estimate`, par: 4, neverRunOut: true,
  }],
  itemsCut: false,
};

/** The answer as the API answers it for CONTENT. */
const READ = {
  kind: 'invoice', confidence: 'high', suppliers: ANSWER.suppliers,
  items: [{
    name: `${SENTINEL} IPA`, supplier: `${SENTINEL} Beverage`, category: 'draft', unit: 'kegs', servingsPerUnit: 124, servingsEstimated: true,
    dealSize: null, posNames: [{ name: `${SENTINEL} pint`, perSale: 1 }], note: `${SENTINEL} estimate`, inFile: true,
  }],
  itemsCut: false, partial: false,
};

// ---- The scripted model -----------------------------------------------------------------------------------------

let answers: ReaderAnswer[] = [];
const requests: ReaderRequest[] = [];
/** While set, a call waits for it; `started` resolves once a call has begun. */
let gate: Promise<void> | null = null;
let started: (() => void) | null = null;
const model: FileReaderModel = {
  async readFile(request) {
    requests.push(request);
    started?.();
    if (gate !== null) await gate;
    return answers.shift() ?? { kind: 'answered', output: ANSWER, costMicroUsd: 3000 };
  },
};
/** What the slow model answers once its signal ends the call: by default, a call whose stream reported nothing. */
let endedAnswer: ReaderAnswer = { kind: 'failed', errType: 'APIUserAbortError', status: null };
/** Each slow call: its signal, and how long after it began the signal ended it. */
const calls: { signal: AbortSignal; endedAfterMs: number | null }[] = [];
/** Answers only once its signal ends the call, as the real client does; `started` resolves once a call has begun. */
const slowModel: FileReaderModel = {
  readFile(request, signal) {
    requests.push(request);
    const call: { signal: AbortSignal; endedAfterMs: number | null } = { signal, endedAfterMs: null };
    calls.push(call);
    const begun = Date.now();
    started?.();
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => {
        call.endedAfterMs = Date.now() - begun;
        resolve(endedAnswer);
      }, { once: true });
    });
  },
};

// ---- The scripted AI text thread (a workbook's, Word file's or PDF's text) ----------------------------------------

/** While set, making a file's text waits for it; `textBegun` resolves once it has begun. */
let textGate: Promise<void> | null = null;
let textBegun: (() => void) | null = null;
/** Thrown instead of the text (SlotBusy: the parse thread stayed busy). */
let textThrows: Error | null = null;
async function scriptedText(input: AiTextInput): Promise<AiTextOutcome> {
  textBegun?.();
  if (textGate !== null) await textGate;
  if (textThrows !== null) throw textThrows;
  return { kind: 'text', text: `${SENTINEL} IPA, half-barrel`, cut: false, pages: input.kind === 'pdf' ? 1 : null };
}

let server: TownwiseTestServer;
let off: TownwiseTestServer;
let noBudget: TownwiseTestServer;
let slow: TownwiseTestServer;
/** The slow model, the scripted text thread, and a second's time limit. */
let scripted: TownwiseTestServer;

interface Person { session: TestSession; email: string }
let orgId: string;
let member: Person;
let otherMember: Person;
let locationId: string;

async function person(org: string, name: string, role: 'org_admin' | 'member'): Promise<Person> {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId: org, userId: session.userId, email, role });
  return { session, email };
}

/** A saved setup: its supplier and item names may be sent; its point-of-sale names never. */
const SETUP = {
  suppliers: [{ key: 'north', name: 'Saved Supplier', deliveries: [{ deliveryWeekday: 4, cutoffWeekday: 3, cutoffTime: '14:00' }] }],
  items: [{
    name: 'Saved Item', supplierId: 'north', category: 'bottles_cans', unit: 'cases', servingsPerUnit: 24, par: 3, dealSize: null,
    neverRunOut: true, posNames: [{ name: `${POS_SENTINEL} Lager 12oz` }, { name: `${POS_SENTINEL} Lager pitcher`, perSale: 4 }],
  }],
};

beforeAll(async () => {
  // Each start drops the database, so all of them start before any fixture.
  off = await startTownwiseServer();
  noBudget = await startTownwiseServer({ setupReader: model, env: { TOWNWISE_FILES_MONTHLY_BUDGET_USD: '0' } });
  slow = await startTownwiseServer({ setupReader: slowModel, setupReadTimeMs: 300 });
  scripted = await startTownwiseServer({ setupReader: slowModel, setupReadTimeMs: 1000, setupReadText: scriptedText });
  server = await startTownwiseServer({ setupReader: model });
  orgId = await createOrg(server, { name: `${ORG_SENTINEL} Tavern` });
  member = await person(orgId, 'member', 'member');
  const otherOrg = await createOrg(server, { name: 'Other Tavern' });
  otherMember = await person(otherOrg, 'other', 'member');
  locationId = await addLocation(server, { orgId, name: `${ROOM_SENTINEL} Bar` });
  const saved = await call(server, `/api/org/locations/${locationId}/orders/setup`, {
    method: 'PUT', session: member.session, json: { expectedVersion: 0, setup: SETUP },
  });
  expect(saved.status).toBe(200);
});
afterAll(async () => {
  await server.close();
  await off.close();
  await noBudget.close();
  await slow.close();
  await scripted.close();
});
beforeEach(async () => {
  answers = [];
  requests.length = 0;
  gate = null;
  started = null;
  endedAnswer = { kind: 'failed', errType: 'APIUserAbortError', status: null };
  calls.length = 0;
  textGate = null;
  textBegun = null;
  textThrows = null;
  await server.redis.flushdb();
  await server.connection.collection('tw_files_usage').deleteMany({});
});

const readPath = (location = locationId): string => `/api/org/locations/${location}/orders/setup/read`;

function read(json: unknown, session: TestSession = member.session, on: TownwiseTestServer = server, location = locationId): Promise<Response> {
  return call(on, readPath(location), { session, json });
}
const pasted = (text = CONTENT): unknown => ({ source: { type: 'text', text } });
const file = (kind: string, bytes: Buffer): unknown => ({ source: { type: 'file', kind, data: bytes.toString('base64') } });

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: (await res.json() as { error: string }).error };
}

/** A read the person leaves: its fetch, which `leaving` aborts; resolves to the error's name once aborted. */
function readLeaving(on: TownwiseTestServer, session: TestSession, json: unknown, leaving: AbortSignal): Promise<unknown> {
  return fetch(new URL(readPath(), on.url), {
    method: 'POST', body: JSON.stringify(json), signal: leaving,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}` },
  }).catch((err: unknown) => (err instanceof Error ? err.name : 'error'));
}

/** Once the replica's byte gate holds `bytes` again (each read gives back what it held when its response is done). */
async function gateHolds(bytes = 0): Promise<void> {
  await vi.waitFor(() => { expect(setupReadBytes.held).toBe(bytes); });
}

/** A request over a bare socket, for headers fetch always sets: `body` sent chunked unless `headers` has a length. */
function rawRead(session: TestSession, headers: Record<string, string>, body?: string): Promise<{ status: number; error: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(readPath(), server.url);
    const req = httpRequest(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.accessToken}`, ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { text += chunk; });
      res.on('end', () => {
        req.destroy();
        resolve({ status: res.statusCode ?? 0, error: (JSON.parse(text) as { error: string }).error });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    // A declared length with no body: the headers go now, and the answer comes before the body would.
    if (headers['content-length'] === undefined) req.end();
    else req.flushHeaders();
  });
}

/** The last townwise.setup_read_failed line `on` logged since `from`, once there is one. */
async function failedLine(on: TownwiseTestServer, from: number): Promise<Record<string, unknown>> {
  let line: Record<string, unknown> | undefined;
  await vi.waitFor(() => {
    line = logLines(on).slice(from).findLast((each) => each.msg === 'townwise.setup_read_failed');
    expect(line).toBeDefined();
  });
  return line ?? {};
}

async function usage(org = orgId): Promise<number> {
  const doc = await server.connection.collection('tw_files_usage').findOne({ orgId: new Types.ObjectId(org) });
  return Number(doc?.costMicroUsd ?? 0);
}

async function setUsage(costMicroUsd: number): Promise<void> {
  await server.connection.collection('tw_files_usage').updateOne(
    { orgId: new Types.ObjectId(orgId), month: server.clock.now().toISOString().slice(0, 7) },
    { $set: { costMicroUsd, updatedAt: server.clock.now() } }, { upsert: true },
  );
}

async function readEvents(): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => event.action === 'order.setup_read');
}

/** The last request's content blocks. */
function contentOf(request: ReaderRequest | undefined): Record<string, unknown>[] {
  const content = request?.messages[0]?.content;
  return Array.isArray(content) ? content as unknown as Record<string, unknown>[] : [];
}
function lastText(request: ReaderRequest | undefined): string {
  const text = contentOf(request).at(-1)?.text;
  return typeof text === 'string' ? text : '';
}

/** The most the last request could cost, as the handler reserved it. */
function ceilingOf(request: ReaderRequest | undefined): number {
  if (request === undefined) throw new Error('no request');
  return setupCeilingMicroUsd(request, { type: 'text', form: 'text', text: '', cut: false }, null);
}

// A PNG: its signature, then chunks (a length, a type, the data, a CRC nothing here checks).
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
}
function pngOf(width: number, height: number, ...extra: Buffer[]): Buffer {
  const size = Buffer.alloc(8);
  size.writeUInt32BE(width);
  size.writeUInt32BE(height, 4);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', Buffer.concat([size, Buffer.from([8, 2, 0, 0, 0])])), ...extra,
    pngChunk('IDAT', Buffer.from('pixels')), pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('POST /api/org/locations/:locationId/orders/setup/read', () => {
  it('reads pasted text: 200 with the checked suggestions, the reservation corrected to the cost, audited and logged with counts only', async () => {
    const before = logLines(server).length;
    const res = await read(pasted());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ read: READ });
    expect(requests).toHaveLength(1);
    expect(await usage()).toBe(3000);
    const event = (await readEvents()).at(-1);
    expect(event).toMatchObject({
      actorUserId: member.session.userId, actorEmail: member.email, actorRole: 'member', viewAsGrantId: null,
      target: { type: 'location', id: locationId },
      details: { locationId, inputKind: 'text', outcome: 'read', suppliers: 1, items: 1 },
    });
    expect(Object.keys(event?.details as object).sort()).toEqual(['inputKind', 'items', 'locationId', 'outcome', 'suppliers']);
    const line = logLines(server).slice(before).find((each) => each.msg === 'townwise.setup_read');
    expect(line).toMatchObject({
      locationId, inputKind: 'text', fileKind: null, confidence: 'high', suppliers: 1, items: 1, estimated: 1, notInFile: 0, itemsCut: false,
      partial: false, costMicroUsd: 3000,
    });
    expect(typeof line?.durationMs).toBe('number');
    await gateHolds(0);
  });

  it('sends each kind of file as the model reads it: a PDF as a document, a workbook, a Word file and a text file as text, a picture without its metadata', async () => {
    const pdf = pdfOf([{ texts: [{ text: `${SENTINEL} IPA 1/2 bbl`, x: 72, y: 700 }] }]);
    const res = await read(file('pdf', pdf));
    expect(res.status).toBe(200);
    // The PDF's own text says the item's name is in it.
    expect((await res.json() as { read: { items: { inFile: unknown }[] } }).read.items[0]?.inFile).toBe(true);
    expect(contentOf(requests.at(-1))[0]).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } });
    expect(lastText(requests.at(-1))).toContain('The file is the PDF document above.');

    expect((await read(file('xlsx', xlsxOf([{ name: 'Guide', rows: [['Item', 'Pack'], [`${SENTINEL} IPA`, '1/2 bbl']] }])))).status).toBe(200);
    expect(lastText(requests.at(-1))).toContain(`an Excel workbook, made into text`);
    expect(lastText(requests.at(-1))).toContain(`${SENTINEL} IPA\t1/2 bbl`);
    expect((await read(file('docx', docxOf([`${SENTINEL} IPA, half-barrel`])))).status).toBe(200);
    expect(lastText(requests.at(-1))).toContain('a Word document, made into text');
    expect((await read(file('text', Buffer.from(CONTENT)))).status).toBe(200);
    expect(lastText(requests.at(-1))).toMatch(new RegExp(`--- FILE CONTENT ---\\n${SENTINEL} Beverage invoice`));

    const picture = await read(file('picture', pngOf(40, 30, pngChunk('tEXt', Buffer.from('Author\0Sentinel-metadata')))));
    expect(picture.status).toBe(200);
    expect((await picture.json() as { read: { items: { inFile: unknown }[] } }).read.items[0]?.inFile).toBeNull();
    const image = contentOf(requests.at(-1))[0] as { type: string; source: { media_type: string; data: string } };
    expect(image.type).toBe('image');
    expect(image.source.media_type).toBe('image/png');
    expect(Buffer.from(image.source.data, 'base64')).toEqual(pngOf(40, 30));
    expect(JSON.stringify(requests)).not.toContain('Sentinel-metadata');
    expect(requests).toHaveLength(5);
  });

  it('sends the content and the saved setup’s supplier and item names only: never a point-of-sale, organization, location or file name, or an email', async () => {
    expect((await read(pasted())).status).toBe(200);
    const sent = JSON.stringify(requests.at(-1));
    expect(lastText(requests.at(-1))).toContain('Suppliers already in the setup: ["Saved Supplier"]\nItems already in the setup: ["Saved Item"]');
    expect(sent).not.toContain(POS_SENTINEL);
    expect(sent).not.toContain(ORG_SENTINEL);
    expect(sent).not.toContain(ROOM_SENTINEL);
    expect(sent).not.toContain(member.email);
    // The file's name never reaches the API: a body that carries one is refused before any call.
    expect(await errorOf(await read({ source: { type: 'file', kind: 'text', data: Buffer.from(CONTENT).toString('base64'), name: `${SENTINEL}.csv` } })))
      .toEqual({ status: 400, error: 'invalid_request' });
    expect(requests).toHaveLength(1);
  });

  it('cuts pasted text past 100,000 characters, reads its start and says the text was cut', async () => {
    const res = await read(pasted(`${CONTENT}${'x'.repeat(150_000)}`));
    expect(res.status).toBe(200);
    expect((await res.json() as { read: { partial: unknown } }).read.partial).toBe(true);
    const text = lastText(requests.at(-1));
    expect(text).toContain('only its start follows (at most 100,000 characters)');
    expect(text.slice(text.indexOf('--- FILE CONTENT ---\n') + '--- FILE CONTENT ---\n'.length)).toHaveLength(100_000);
  });

  it('stores nothing: no file, no Your data item, and the setup’s version unchanged; only the budget and the audit are written', async () => {
    const setupPath = `/api/org/locations/${locationId}/orders/setup`;
    const before = await (await call(server, setupPath, { session: member.session })).json() as { setup: { version: number } };
    const counts = async (): Promise<number[]> => Promise.all(['tw_files', 'tw_uploads', 'tw_notes', 'tw_order_setups'].map((name) => server.connection.collection(name).countDocuments()));
    const counted = await counts();
    const writes = await writesDuring(server, async () => {
      expect((await read(file('text', Buffer.from(CONTENT)))).status).toBe(200);
      expect((await read(pasted())).status).toBe(200);
    });
    expect([...new Set(writes.map((write) => write.split(' ')[1]))].sort()).toEqual(['tw_audit_events', 'tw_files_usage']);
    expect(await counts()).toEqual(counted);
    const after = await (await call(server, setupPath, { session: member.session })).json() as { setup: { version: number } };
    expect(after.setup.version).toBe(before.setup.version);
    expect(after).toEqual(before);
  });

  it('logs and audits a read and a failed read with ids, kinds, codes and counts only, never a name from the content or the answer', async () => {
    const before = logLines(server).length;
    const events = (await auditEvents(server)).length;
    expect((await read(pasted())).status).toBe(200);
    answers = [{ kind: 'refused', costMicroUsd: 500 }];
    expect((await read(file('text', Buffer.from(CONTENT)))).status).toBe(422);
    expect((await read(file('pdf', Buffer.from(CONTENT)))).status).toBe(400);
    const lines = logLines(server).slice(before);
    expect(lines.map((line) => line.msg)).toEqual(expect.arrayContaining(['townwise.setup_read', 'townwise.setup_read_failed']));
    expect(lines.find((line) => line.msg === 'townwise.setup_read_failed' && line.code === 'extract_refused')).toMatchObject({
      locationId, inputKind: 'file', fileKind: 'text', code: 'extract_refused', errType: null, status: null,
    });
    const logged = server.logs.slice(before).join('\n');
    expect(logged).not.toContain(SENTINEL);
    expect(logged).not.toContain('555-0142');
    const audited = JSON.stringify((await auditEvents(server)).slice(events));
    expect(audited).not.toContain(SENTINEL);
    expect((await readEvents()).slice(-2).map((event) => (event.details as { outcome: unknown }).outcome)).toEqual(['read', 'refused']);
  });

  it('answers canReadWithAi on the setup: true with a model and a budget, false without either, and 503 ai_unavailable then', async () => {
    const setupPath = `/api/org/locations/${locationId}/orders/setup`;
    expect((await (await call(server, setupPath, { session: member.session })).json() as { canReadWithAi: unknown }).canReadWithAi).toBe(true);
    for (const on of [off, noBudget]) {
      const session = await signIn(on, member.email);
      expect((await (await call(on, setupPath, { session })).json() as { canReadWithAi: unknown }).canReadWithAi).toBe(false);
      expect(await errorOf(await read(pasted(), session, on))).toEqual({ status: 503, error: 'ai_unavailable' });
    }
    expect(requests).toHaveLength(0);
  });

  describe('the files AI budget', () => {
    it('refuses a read once the month’s spend has reached the budget (409), before the content is read and with no call', async () => {
      await setUsage(5_000_000);
      const events = (await readEvents()).length;
      expect(await errorOf(await read(pasted()))).toEqual({ status: 409, error: 'files_ai_budget_exhausted' });
      // Checked before the content: a file it would refuse answers the spent budget.
      expect(await errorOf(await read(file('text', zipOf([{ name: 'a.txt', data: 'x' }]))))).toEqual({ status: 409, error: 'files_ai_budget_exhausted' });
      expect(requests).toHaveLength(0);
      expect(await usage()).toBe(5_000_000);
      expect(await readEvents()).toHaveLength(events);
    });

    it('reserves the most the call can cost before it, refusing a read the rest of the budget cannot cover', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      gate = held;
      const begun = new Promise<void>((resolve) => { started = resolve; });
      const pending = read(pasted());
      await begun;
      const reserved = ceilingOf(requests[0]);
      expect(reserved).toBeGreaterThan(500_000);
      expect(await usage()).toBe(reserved);
      release();
      expect((await pending).status).toBe(200);
      expect(await usage()).toBe(3000);
      // A month already spent so far that the reservation does not fit: 409, and no call.
      await server.connection.collection('tw_files_usage').updateOne({ orgId: new Types.ObjectId(orgId) }, { $set: { costMicroUsd: 5_000_000 - reserved + 1 } });
      expect(await errorOf(await read(pasted()))).toEqual({ status: 409, error: 'files_ai_budget_exhausted' });
      expect(requests).toHaveLength(1);
      expect(await usage()).toBe(5_000_000 - reserved + 1);
    });

    it('charges a refusal, an answer cut at max_tokens and an answer that is not JSON (422), nothing for an API error before the stream, and what the stream reported for one during it (503 extract_failed)', async () => {
      answers = [
        { kind: 'refused', costMicroUsd: 700 },
        { kind: 'too_long', costMicroUsd: 900 },
        { kind: 'answered', output: 'not an answer', costMicroUsd: 1100 },
        { kind: 'failed', errType: 'InternalServerError', status: 529 },
        { kind: 'failed', errType: 'APIError', status: null, streamedMicroUsd: 400 },
      ];
      expect(await errorOf(await read(pasted()))).toEqual({ status: 422, error: 'extract_refused' });
      expect(await usage()).toBe(700);
      expect(await errorOf(await read(pasted()))).toEqual({ status: 422, error: 'extract_answer_too_long' });
      expect(await usage()).toBe(1600);
      expect(await errorOf(await read(pasted()))).toEqual({ status: 422, error: 'extract_invalid_answer' });
      expect(await usage()).toBe(2700);
      const before = logLines(server).length;
      expect(await errorOf(await read(pasted()))).toEqual({ status: 503, error: 'extract_failed' });
      expect(await usage()).toBe(2700);
      expect(logLines(server).slice(before).find((line) => line.msg === 'townwise.setup_read_failed'))
        .toMatchObject({ code: 'extract_failed', errType: 'InternalServerError', status: 529 });
      expect(await errorOf(await read(pasted()))).toEqual({ status: 503, error: 'extract_failed' });
      expect(await usage()).toBe(3100);
      expect((await readEvents()).slice(-5).map((event) => (event.details as { outcome: unknown }).outcome))
        .toEqual(['refused', 'too_long', 'invalid_answer', 'failed', 'failed']);
    });

    it('ends the call at the read’s time limit, charging what its stream reported (503 extract_timed_out, logged as such)', async () => {
      endedAnswer = { kind: 'failed', errType: 'APIUserAbortError', status: null, streamedMicroUsd: 2500 };
      const session = await signIn(slow, member.email);
      const before = logLines(slow).length;
      expect(await errorOf(await read(pasted(), session, slow))).toEqual({ status: 503, error: 'extract_timed_out' });
      expect(await failedLine(slow, before)).toMatchObject({ code: 'extract_timed_out', errType: 'APIUserAbortError', status: null });
      expect(requests).toHaveLength(1);
      expect(await usage()).toBe(2500);
    });

    it('keeps the whole reservation for a call the time limit ends before its stream reported anything', async () => {
      const session = await signIn(slow, member.email);
      expect(await errorOf(await read(pasted(), session, slow))).toEqual({ status: 503, error: 'extract_timed_out' });
      expect(requests).toHaveLength(1);
      expect(await usage()).toBe(ceilingOf(requests[0]));
    });
  });

  describe('when the person leaves, the time runs out or the parse thread is busy', () => {
    const docx = (): unknown => file('docx', docxOf([`${SENTINEL} IPA, half-barrel`]));

    it('makes no call and charges nothing when the person leaves while the content is parsed (logged extract_left)', async () => {
      const session = await signIn(scripted, member.email);
      let release: () => void = () => undefined;
      textGate = new Promise<void>((resolve) => { release = resolve; });
      const begun = new Promise<void>((resolve) => { textBegun = resolve; });
      const before = logLines(scripted).length;
      const leaving = new AbortController();
      const pending = readLeaving(scripted, session, docx(), leaving.signal);
      await begun;
      leaving.abort();
      expect(await pending).toBe('AbortError');
      // Give the server the closed connection before the text is done.
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      expect(await failedLine(scripted, before)).toMatchObject({ code: 'extract_left', inputKind: 'file', fileKind: 'docx', errType: null });
      expect(requests).toHaveLength(0);
      expect(await usage()).toBe(0);
    });

    it('ends the call when the person leaves during it: the model’s signal aborts, charged by what its stream reported (logged extract_left)', async () => {
      const session = await signIn(scripted, member.email);
      const begun = new Promise<void>((resolve) => { started = resolve; });
      const before = logLines(scripted).length;
      const leaving = new AbortController();
      const pending = readLeaving(scripted, session, pasted(), leaving.signal);
      await begun;
      leaving.abort();
      expect(await pending).toBe('AbortError');
      await vi.waitFor(() => { expect(calls[0]?.signal.aborted).toBe(true); });
      expect(await failedLine(scripted, before)).toMatchObject({ code: 'extract_left', inputKind: 'text', errType: 'APIUserAbortError' });
      // Its stream reported nothing, so the whole reservation stays.
      expect(await usage()).toBe(ceilingOf(requests[0]));
    });

    it('counts the time limit from the request’s start: time spent making the text is taken from the call’s', async () => {
      const session = await signIn(scripted, member.email);
      textGate = new Promise<void>((resolve) => { setTimeout(resolve, 600); });
      expect(await errorOf(await read(docx(), session, scripted))).toEqual({ status: 503, error: 'extract_timed_out' });
      expect(calls).toHaveLength(1);
      // About 400 ms of the second were left; counted from the call it would have run the whole 1,000.
      expect(calls[0]?.endedAfterMs).toBeLessThan(800);
    });

    it('makes no call for a read already past its time limit once the text is made (503 extract_timed_out, nothing charged)', async () => {
      const session = await signIn(scripted, member.email);
      textGate = new Promise<void>((resolve) => { setTimeout(resolve, 1200); });
      const before = logLines(scripted).length;
      expect(await errorOf(await read(docx(), session, scripted))).toEqual({ status: 503, error: 'extract_timed_out' });
      expect(await failedLine(scripted, before)).toMatchObject({ code: 'extract_timed_out', errType: null });
      expect(requests).toHaveLength(0);
      expect(await usage()).toBe(0);
    });

    it('answers 503 extract_busy when the parse thread stays busy, with no call and nothing charged', async () => {
      const session = await signIn(scripted, member.email);
      textThrows = new SlotBusy();
      const res = await read(docx(), session, scripted);
      expect(res.headers.get('retry-after')).toBe('5');
      expect(await errorOf(res)).toEqual({ status: 503, error: 'extract_busy' });
      expect(requests).toHaveLength(0);
      expect(await usage()).toBe(0);
    });
  });

  describe('who may read', () => {
    afterEach(async () => {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    });

    it('refuses staff viewing as a member (403 view_as_read_only), with no call and nothing recorded', async () => {
      const staff = await signInStaff(server);
      await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: member.session.userId, orgId });
      const events = (await readEvents()).length;
      expect(await errorOf(await read(pasted(), staff))).toEqual({ status: 403, error: 'view_as_read_only' });
      expect(requests).toHaveLength(0);
      expect(await usage()).toBe(0);
      expect(await readEvents()).toHaveLength(events);
    });

    it('lets staff opened as admin read, audited as Townwise staff under the grant', async () => {
      const staff = await signInStaff(server);
      const setupOrg = await createOrg(server, { name: 'Setup Tavern' });
      await addInvite(server, {
        orgId: setupOrg, email: `first-admin-${randomUUID().slice(0, 8)}@example.test`, invitedBy: staff.userId, role: 'org_admin', addedByStaff: true,
      });
      const room = await addLocation(server, { orgId: setupOrg, name: 'Setup Bar' });
      const grantId = await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: setupOrg });
      const res = await read(pasted(), staff, server, room);
      expect(res.status).toBe(200);
      expect((await readEvents()).at(-1)).toMatchObject({
        actorUserId: staff.userId, actorRole: 'superadmin', viewAsGrantId: grantId, target: { type: 'location', id: room },
        details: { locationId: room, inputKind: 'text', outcome: 'read' },
      });
      expect(await usage(setupOrg)).toBe(3000);
    });

    it('answers 404 for another organization’s location exactly as for an unknown one, with no call', async () => {
      const other = await errorOf(await read(pasted(), otherMember.session));
      const unknown = await errorOf(await read(pasted(), member.session, server, new Types.ObjectId().toHexString()));
      expect(other).toEqual({ status: 404, error: 'not_found' });
      expect(unknown).toEqual(other);
      expect(requests).toHaveLength(0);
      expect(await usage()).toBe(0);
    });

    it('counts each read against the ai_reads limiter, 30 an hour per account, shared with reading a stored file', async () => {
      const limiter = createRateLimiter({ redis: server.redis, name: 'townwise:ai-reads', limit: 30, windowSeconds: 3600 });
      for (let index = 0; index < 30; index += 1) await limiter.consume(`acct:${member.session.userId}`);
      expect(await errorOf(await read(pasted()))).toEqual({ status: 429, error: 'rate_limited' });
      expect(requests).toHaveLength(0);
    });
  });

  describe('content it does not read (400, with no call and nothing charged)', () => {
    it('refuses a ZIP, a password, bytes of another kind, an empty file, a PDF over 30 pages, a picture over 8,000 pixels and a file over 5 MB', async () => {
      const ole = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(100)]);
      const page = { texts: [{ text: 'Vorlan IPA', x: 72, y: 700 }] };
      const cases: [unknown, string][] = [
        [file('text', zipOf([{ name: 'a.txt', data: 'x' }])), 'extract_kind_not_read'],
        [file('xlsx', ole), 'extract_encrypted'],
        [file('xlsx', pdfOf([page])), 'extract_kind_mismatch'],
        [file('picture', Buffer.from(CONTENT)), 'extract_kind_mismatch'],
        [file('text', Buffer.from('  \n\t ')), 'extract_empty'],
        [pasted(' \n '), 'extract_empty'],
        [file('pdf', pdfOf(Array.from({ length: 31 }, () => page))), 'extract_too_large'],
        [file('picture', pngOf(8001, 20)), 'extract_too_large'],
        [file('text', Buffer.alloc(SETUP_FILE_BYTES + 1, 0x61)), 'extract_too_large'],
        [file('xlsx', zipOf([{ name: 'a.txt', data: 'x' }])), 'extract_not_readable'],
      ];
      for (const [body, error] of cases) {
        expect(await errorOf(await read(body))).toEqual({ status: 400, error });
      }
      expect(requests).toHaveLength(0);
      expect(await usage()).toBe(0);
      await gateHolds(0);
    });

    it('refuses a malformed body (400 invalid_request) and one over 8 MB (413)', async () => {
      for (const body of [
        {}, { source: { type: 'file', kind: 'zip', data: 'AAAA' } }, { source: { type: 'file', kind: 'text', data: 'not base64!' } },
        { source: { type: 'file', kind: 'text', data: 'AAA' } }, { source: { type: 'text', text: '' } }, { source: { type: 'text', text: 'x' }, extra: 1 },
      ]) expect(await errorOf(await read(body))).toEqual({ status: 400, error: 'invalid_request' });
      const huge = await call(server, readPath(), { session: member.session, rawBody: JSON.stringify({ source: { type: 'text', text: 'x'.repeat(8.5 * 1024 * 1024) } }) });
      expect(await errorOf(huge)).toEqual({ status: 413, error: 'payload_too_large' });
      expect(requests).toHaveLength(0);
    });

    it('answers 503 extract_busy while this replica holds too much content, and gives back what each read held', async () => {
      expect(setupReadBytes.reserve(SETUP_READ_BYTES_IN_FLIGHT)).toBe(true);
      try {
        const res = await read(pasted());
        expect(res.headers.get('retry-after')).toBe('5');
        expect(await errorOf(res)).toEqual({ status: 503, error: 'extract_busy' });
        expect(requests).toHaveLength(0);
      } finally {
        setupReadBytes.release(SETUP_READ_BYTES_IN_FLIGHT);
      }
      expect((await read(pasted())).status).toBe(200);
      await gateHolds(0);
    });
  });

  describe('the bytes a replica holds, counted before the body is parsed', () => {
    afterEach(async () => {
      setupReadBytes.release(SETUP_READ_BYTES_IN_FLIGHT);
      await gateHolds(0);
    });

    it('holds two full bodies at most (16 MiB)', () => {
      expect(SETUP_READ_BODY_BYTES).toBe(8 * 1024 * 1024);
      expect(SETUP_READ_BYTES_IN_FLIGHT).toBe(2 * SETUP_READ_BODY_BYTES);
    });

    it('refuses a read by its Content-Length before parsing it when the gate is full: 503 extract_busy, even for a body that is not JSON', async () => {
      const body = JSON.stringify(pasted());
      expect(setupReadBytes.reserve(SETUP_READ_BYTES_IN_FLIGHT - Buffer.byteLength(body) + 1)).toBe(true);
      const before = logLines(server).length;
      const notJson = await call(server, readPath(), { session: member.session, rawBody: 'not json'.padEnd(body.length, ' ') });
      expect(notJson.headers.get('retry-after')).toBe('5');
      expect(await errorOf(notJson)).toEqual({ status: 503, error: 'extract_busy' });
      expect(await errorOf(await call(server, readPath(), { session: member.session, rawBody: body }))).toEqual({ status: 503, error: 'extract_busy' });
      expect(logLines(server).slice(before).find((line) => line.msg === 'townwise.setup_read_failed')).toEqual(expect.objectContaining({
        code: 'extract_busy', locationId: null, inputKind: null, fileKind: null,
      }));
      expect(requests).toHaveLength(0);
      // One byte more room, and the same body is read.
      setupReadBytes.release(1);
      expect((await call(server, readPath(), { session: member.session, rawBody: body })).status).toBe(200);
      await gateHolds(SETUP_READ_BYTES_IN_FLIGHT - Buffer.byteLength(body));
    });

    it('refuses a body with no length or one longer than 8 MiB as the parser does (413), before reading it', async () => {
      expect(await rawRead(member.session, { 'transfer-encoding': 'chunked' }, JSON.stringify(pasted()))).toEqual({ status: 413, error: 'payload_too_large' });
      expect(await rawRead(member.session, { 'content-length': String(SETUP_READ_BODY_BYTES + 1) })).toEqual({ status: 413, error: 'payload_too_large' });
      expect(requests).toHaveLength(0);
      await gateHolds(0);
    });

    it('holds the whole 8 MiB for a compressed body, which may inflate to it', async () => {
      expect(setupReadBytes.reserve(SETUP_READ_BYTES_IN_FLIGHT - SETUP_READ_BODY_BYTES + 1)).toBe(true);
      const json = JSON.stringify(pasted());
      const gzipped = await fetch(new URL(readPath(), server.url), {
        method: 'POST', body: gzipSync(json),
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${member.session.accessToken}` },
      });
      expect(await errorOf(gzipped)).toEqual({ status: 503, error: 'extract_busy' });
      expect((await call(server, readPath(), { session: member.session, rawBody: json })).status).toBe(200);
      setupReadBytes.release(SETUP_READ_BYTES_IN_FLIGHT - SETUP_READ_BODY_BYTES + 1);
      expect((await fetch(new URL(readPath(), server.url), {
        method: 'POST', body: gzipSync(json),
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', authorization: `Bearer ${member.session.accessToken}` },
      })).status).toBe(200);
    });

    it('gives back exactly what each read held, once, on every answer', async () => {
      // Held by "another read" throughout: giving back twice would take from it.
      const other = 1000;
      expect(setupReadBytes.reserve(other)).toBe(true);
      const offSession = await signIn(off, member.email);
      const scriptedSession = await signIn(scripted, member.email);
      const slowSession = await signIn(slow, member.email);
      const answersTo: [() => Promise<Response>, number, string | null][] = [
        [() => read(pasted()), 200, null],
        [() => read(pasted(), otherMember.session), 404, 'not_found'],
        [() => read(pasted(), offSession, off), 503, 'ai_unavailable'],
        [() => read({ source: { type: 'text', text: '' } }), 400, 'invalid_request'],
        [() => call(server, readPath(), { session: member.session, rawBody: '{not json' }), 400, 'malformed_json'],
        [() => read(file('text', zipOf([{ name: 'a.txt', data: 'x' }]))), 400, 'extract_kind_not_read'],
        [() => { answers = [{ kind: 'refused', costMicroUsd: 1 }]; return read(pasted()); }, 422, 'extract_refused'],
        [() => { answers = [{ kind: 'failed', errType: 'InternalServerError', status: 500 }]; return read(pasted()); }, 503, 'extract_failed'],
        [() => { textThrows = new SlotBusy(); return read(file('docx', docxOf(['x'])), scriptedSession, scripted); }, 503, 'extract_busy'],
        [() => read(pasted(), slowSession, slow), 503, 'extract_timed_out'],
        [() => call(server, readPath(), { session: member.session, rawBody: JSON.stringify({ source: { type: 'text', text: 'x'.repeat(8.5 * 1024 * 1024) } }) }), 413, 'payload_too_large'],
        [async () => { await setUsage(5_000_000); return read(pasted()); }, 409, 'files_ai_budget_exhausted'],
        [async () => {
          const limiter = createRateLimiter({ redis: server.redis, name: 'townwise:ai-reads', limit: 30, windowSeconds: 3600 });
          for (let index = 0; index < 30; index += 1) await limiter.consume(`acct:${member.session.userId}`);
          return read(pasted());
        }, 429, 'rate_limited'],
      ];
      for (const [send, status, error] of answersTo) {
        const res = await send();
        expect(error === null ? { status: res.status } : await errorOf(res)).toEqual(error === null ? { status } : { status, error });
        await gateHolds(other);
      }
      setupReadBytes.release(other);
    });

    it('gives back what a read held when the person leaves, during the parse and during the call', async () => {
      const session = await signIn(scripted, member.email);
      let release: () => void = () => undefined;
      textGate = new Promise<void>((resolve) => { release = resolve; });
      const parsing = new Promise<void>((resolve) => { textBegun = resolve; });
      const leaving = new AbortController();
      const pending = readLeaving(scripted, session, file('docx', docxOf(['x'])), leaving.signal);
      await parsing;
      expect(setupReadBytes.held).toBeGreaterThan(0);
      leaving.abort();
      await pending;
      await gateHolds(0);
      release();
      const calling = new Promise<void>((resolve) => { started = resolve; });
      const leavingCall = new AbortController();
      const pendingCall = readLeaving(scripted, session, pasted(), leavingCall.signal);
      await calling;
      expect(setupReadBytes.held).toBeGreaterThan(0);
      leavingCall.abort();
      await pendingCall;
      await gateHolds(0);
    });
  });
});
