// Reference items (D28): any file kept as it is, pasted text kept as a .txt file, and the reader TownwiseAI's tools
// use for a text item. Synthetic data only; no title or text reaches an audit event.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { createItemReader, READ_ITEM_BYTES, READ_ITEM_MAX_CHARS, saveTextItem } from '../src/files/items.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { createTownwiseStores } from '../src/stores/index.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { filesPath, putChunk, uploadFile, type Created } from './helpers/files.ts';
import { call, startTownwiseServer, signIn, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;
let blobs: MemoryFileBlobs;
let orgId: string;
let member: TestSession;
let l1: string;
let l2: string;
const pdf = Buffer.from('%PDF-1.4\nsynthetic\n', 'utf8');

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  server = await startTownwiseServer({ files: blobs });
  orgId = await createOrg(server, { name: 'Intake Kitchen' });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  member = await signIn(server, email);
  await addSeat(server, { orgId, userId: member.userId, email });
  l1 = await addLocation(server, { orgId, name: 'Intake One' });
  l2 = await addLocation(server, { orgId, name: 'Intake Two' });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

const scope = (): OrgScope => ({ orgId }) as unknown as OrgScope;
const textPath = (locationId: string): string => `/api/org/locations/${locationId}/data/text`;
const paste = (locationId: string, json: unknown): Promise<Response> => call(server, textPath(locationId), { session: member, json });

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

async function lastEvent(action: string): Promise<{ details: Record<string, unknown> }> {
  const found = (await auditEvents(server)).filter((event) => event.action === action).at(-1);
  expect(found).toBeDefined();
  return found as unknown as { details: Record<string, unknown> };
}

/** A reference text item written straight into a row and the blobs, with the fields a test changes. */
async function seedItem(locationId: string, bytes: Buffer, over: Record<string, unknown> = {}): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), importId: null, purpose: 'reference',
    uploadedBy: member.userId, uploaderRole: 'member', uploadedAt: server.clock.now(), name: 'notes.txt', kind: 'text',
    sizeBytes: bytes.length, fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference',
    progress: null, readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null,
    rawDeletedAt: null, attempts: 0, disabledAt: null, ...over,
  });
  await blobs.writeRaw(scope(), { locationId, fileId: _id.toHexString() }, bytes, 'text/plain');
  return _id.toHexString();
}

describe('reference items (D28)', () => {
  it('a file added for reference is stored as it is: kept with outcome reference, in no import, and never read', async () => {
    const res = await call(server, filesPath(l1), { session: member, json: { name: 'menu.pdf', sizeBytes: pdf.length, purpose: 'reference' } });
    expect(res.status).toBe(201);
    const created = await res.json() as Omit<Created, 'import'> & { import: null };
    expect(created).toMatchObject({ file: { purpose: 'reference', importId: null }, import: null });
    const sent = await putChunk(server, filesPath(l1, `/${created.file.id}/chunks/0`), member, pdf);
    expect(sent.status).toBe(200);
    const done = await call(server, filesPath(l1, `/${created.file.id}/complete`), { session: member, json: {} });
    expect(await done.json()).toMatchObject({ file: { status: 'kept', outcome: 'reference', purpose: 'reference', kind: 'pdf' }, import: null });
    expect(await server.connection.collection('tw_imports').countDocuments({})).toBe(0);
    expect(await server.connection.collection('tw_uploads').countDocuments({})).toBe(0);
  });

  it('refuses a purpose that is neither history nor reference', async () => {
    const res = await call(server, filesPath(l1), { session: member, json: { name: 'a.csv', sizeBytes: 3, purpose: 'other' } });
    expect(await errorOf(res)).toEqual({ status: 400, error: 'purpose_unavailable' });
  });

  it('pasted text becomes a .txt reference item named from its title, sized in UTF-8 bytes', async () => {
    const res = await paste(l1, { title: 'Catering list', text: 'Café ✓' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { file: unknown }).file).toMatchObject({
      name: 'Catering list.txt', kind: 'text', purpose: 'reference', status: 'kept', sizeBytes: 9, importId: null,
    });
  });

  it('pasted text is refused when empty, over 10,000 characters, or with a title over 120 characters', async () => {
    for (const json of [{ title: 'a', text: '' }, { title: 'a', text: 'x'.repeat(10_001) }, { title: 'x'.repeat(121), text: 'a' }, { title: 'a', text: 'a', extra: 1 }]) {
      expect(await errorOf(await paste(l1, json))).toEqual({ status: 400, error: 'invalid_request' });
    }
  });

  it('a reference item downloads as an octet-stream attachment with nosniff and a sandbox CSP, whatever its bytes say', async () => {
    const uploaded = await uploadFile(server, l1, member, 'page.html', Buffer.from('<script>alert(1)</script>'), { purpose: 'reference' });
    expect(uploaded.status).toBe(200);
    const id = uploaded.body.file?.id ?? '';
    const res = await call(server, filesPath(l1, `/${id}/raw`), { session: member });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
  });

  it('deleting a reference item removes its row and its blob', async () => {
    const created = await (await paste(l1, { title: 'Gone soon', text: 'abc' })).json() as { file: { id: string } };
    const res = await call(server, filesPath(l1, `/${created.file.id}`), { session: member, method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await server.connection.collection('tw_files').countDocuments({ _id: new Types.ObjectId(created.file.id) })).toBe(0);
    expect([...blobs.raw.keys()].some((name) => name.endsWith(created.file.id))).toBe(false);
  });

  it('readText gives a reference text item’s first 64 KiB, decoded, at most 20,000 characters', async () => {
    const reader = createItemReader(createTownwiseStores(server.connection), blobs);
    expect(reader.on).toBe(true);
    const long = await seedItem(l1, Buffer.from('a'.repeat(30_000), 'latin1'));
    const out = await reader.readText(scope(), l1, long);
    expect(out).toMatchObject({ status: 'ok', truncated: true });
    expect(out.status === 'ok' ? out.text.length : -1).toBe(READ_ITEM_MAX_CHARS);
    const huge = await seedItem(l1, Buffer.from('b'.repeat(READ_ITEM_BYTES + 5), 'latin1'));
    expect(await reader.readText(scope(), l1, huge)).toMatchObject({ status: 'ok', truncated: true });
    const small = await seedItem(l1, Buffer.from([0x43, 0x61, 0x66, 0xe9]));
    expect(await reader.readText(scope(), l1, small)).toEqual({ status: 'ok', text: 'Café', truncated: false });
  });

  it('readText drops a character cut at the edge of the bytes read', async () => {
    const reader = createItemReader(createTownwiseStores(server.connection), blobs);
    const id = await seedItem(l1, Buffer.from(`${'a'.repeat(READ_ITEM_BYTES - 1)}é`, 'utf8'));
    const out = await reader.readText(scope(), l1, id);
    expect(out).toMatchObject({ status: 'ok', truncated: true });
    expect(out.status === 'ok' ? out.text.length : -1).toBe(READ_ITEM_MAX_CHARS);
  });

  it('readText refuses a history file, a PDF kept for reference, a turned-off item, a deleted original and another location’s id', async () => {
    const reader = createItemReader(createTownwiseStores(server.connection), blobs);
    const historyCsvId = await seedItem(l1, Buffer.from('Date,Guests\n'), { purpose: 'history', importId: new Types.ObjectId(), status: 'read' });
    const refPdfId = await seedItem(l1, pdf, { kind: 'pdf' });
    const offTextId = await seedItem(l1, Buffer.from('hello'), { disabledAt: server.clock.now() });
    const rawDeletedId = await seedItem(l1, Buffer.from('hello'), { rawDeletedAt: server.clock.now() });
    const textId = await seedItem(l1, Buffer.from('hello'));
    expect(await reader.readText(scope(), l1, historyCsvId)).toEqual({ status: 'not_readable' });
    expect(await reader.readText(scope(), l1, refPdfId)).toEqual({ status: 'not_readable' });
    expect(await reader.readText(scope(), l1, offTextId)).toEqual({ status: 'turned_off' });
    expect(await reader.readText(scope(), l1, rawDeletedId)).toEqual({ status: 'gone' });
    expect(await reader.readText(scope(), l2, textId)).toEqual({ status: 'not_found' });
    expect(await reader.readText(scope(), l1, 'not-an-id')).toEqual({ status: 'not_found' });
    expect(await reader.readText({ orgId: new Types.ObjectId().toHexString() } as unknown as OrgScope, l1, textId)).toEqual({ status: 'not_found' });
    expect(await createItemReader(createTownwiseStores(server.connection), null).readText(scope(), l1, textId)).toEqual({ status: 'files_off' });
  });

  it('a retried save with the same id answers the stored item and reserves no more bytes', async () => {
    const stores = createTownwiseStores(server.connection);
    const id = new Types.ObjectId().toHexString();
    const input = { id, title: 'Retry', text: 'twice', uploadedBy: member.userId, uploaderRole: 'member' as const, addedVia: 'townwise_ai' as const, now: server.clock.now() };
    const day = server.clock.now().toISOString().slice(0, 10);
    const first = await saveTextItem(stores, blobs, scope(), l1, input);
    expect(first).toMatchObject({ created: true, file: { id, addedVia: 'townwise_ai', purpose: 'reference' } });
    const used = await stores.uploadDays.used(scope(), day);
    const second = await saveTextItem(stores, blobs, scope(), l1, input);
    expect(second).toMatchObject({ created: false, file: { id } });
    expect(await stores.uploadDays.used(scope(), day)).toBe(used);
  });

  it('file.uploaded carries purpose and sizes, and nothing from the text or the title', async () => {
    const res = await paste(l1, { title: 'Catering secret', text: 'Café ✓' });
    expect(res.status).toBe(201);
    expect((await lastEvent('file.uploaded')).details).toEqual({ locationId: l1, kind: 'text', sizeBytes: 9, purpose: 'reference' });
    const everything = JSON.stringify([...server.logs, ...await auditEvents(server)]);
    expect(everything).not.toContain('Catering');
    expect(everything).not.toContain('Café');
  });
});
