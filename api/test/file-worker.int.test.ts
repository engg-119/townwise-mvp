// The file reader end to end (spec 11A): uploads, "Read my history", the reader's claim and lease, questions and
// answers, member and admin write rules, kept and failed files, and the privacy of logs, audit and reports.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { FileView, ImportView } from '../src/handlers/files.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { addLocation, addSalesDay, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { uploadFile } from './helpers/files.ts';
import { setupOrg } from './helpers/setup-org.ts';
import {
  call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, writesDuring, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'sales-files');
const fixture = (name: string): Buffer => readFileSync(join(FIXTURES, name));
const SENTINEL = 'Zqxj Party Of Twelve';

let server: TownwiseTestServer;
let blobs: MemoryFileBlobs;
let orgId: string;
let admin: TestSession;
let member: TestSession;

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  server = await startTownwiseServer({ files: blobs, reader: {} });
  orgId = await createOrg(server, { name: 'Reader Kitchen' });
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const memberEmail = `member-${randomUUID().slice(0, 8)}@example.test`;
  admin = await signIn(server, adminEmail);
  member = await signIn(server, memberEmail);
  await addSeat(server, { orgId, userId: admin.userId, email: adminEmail, role: 'org_admin' });
  await addSeat(server, { orgId, userId: member.userId, email: memberEmail });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

const base = (locationId: string): string => `/api/org/locations/${locationId}`;

async function newLocation(name = `Room ${randomUUID().slice(0, 6)}`): Promise<string> {
  return addLocation(server, { orgId, name });
}

async function drop(locationId: string, session: TestSession, name: string, bytes: Buffer): Promise<{ file: FileView; importId: string }> {
  const done = await uploadFile(server, locationId, session, name, bytes);
  expect(done.status).toBe(200);
  const file = done.body.file;
  if (file === undefined) throw new Error('no file in the complete response');
  return { file, importId: (done.body.import as { id: string }).id };
}

async function start(locationId: string, importId: string, session: TestSession = member): Promise<Response> {
  return call(server, `${base(locationId)}/imports/${importId}/start`, { session, json: {} });
}

async function settledImport(locationId: string, importId: string, session: TestSession = member): Promise<ImportView> {
  await server.reader?.settled();
  const res = await call(server, `${base(locationId)}/imports/${importId}`, { session });
  expect(res.status).toBe(200);
  return (await res.json() as { import: ImportView }).import;
}

function days(locationId: string): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_sales_days')
    .find({ locationId: new Types.ObjectId(locationId) }, { projection: { _id: 0, date: 1, guests: 1, netSalesCents: 1 } })
    .sort({ date: 1 }).toArray();
}

describe('reading stored files', () => {
  it('reads a dropped CSV into days, a cleaned copy and a report, once "Read my history" starts it', async () => {
    const locationId = await newLocation();
    const { file, importId } = await drop(locationId, member, 'day-level.csv', fixture('day-level.csv'));
    const before = await call(server, `${base(locationId)}/imports/current`, { session: member });
    expect((await before.json() as { import: ImportView }).import).toMatchObject({ id: importId, status: 'open', files: [{ id: file.id, status: 'stored' }] });

    const started = await start(locationId, importId);
    expect(started.status).toBe(202);
    expect((await started.json() as { import: ImportView }).import).toMatchObject({ status: 'queued', files: [{ status: 'queued', etaSeconds: null, queuePosition: 1 }] });

    const done = await settledImport(locationId, importId);
    expect(done).toMatchObject({
      status: 'done', appliedVersion: 1, etaSeconds: null, question: null,
      progress: { filesTotal: 1, filesDone: 1 },
      found: { dayCount: 3, firstDate: '2025-01-01', lastDate: '2025-01-04', guestsDayCount: 3, netSalesDayCount: 3, missingDays: 1, closedDates: ['2025-01-04'] },
    });
    expect(done.files[0]).toMatchObject({
      status: 'read', outcome: null, hasClean: true, canDownloadClean: true,
      result: { dayCount: 3, firstDate: '2025-01-01', lastDate: '2025-01-04', inserted: 3, replaced: 0, kept: 0, closedDates: ['2025-01-04'], missingDays: 1 },
    });
    expect(await days(locationId)).toEqual([
      { date: '2025-01-01', guests: 120, netSalesCents: 345_600 },
      { date: '2025-01-02', guests: 98, netSalesCents: 289_050 },
      { date: '2025-01-04', guests: 0, netSalesCents: 0 },
    ]);
    const clean = await call(server, `${base(locationId)}/files/${file.id}/clean`, { session: member });
    expect(await clean.text()).toBe('date,guests,net_sales\r\n2025-01-01,120,3456.00\r\n2025-01-02,98,2890.50\r\n2025-01-04,0,0.00\r\n');
    const detail = await call(server, `${base(locationId)}/files/${file.id}`, { session: member });
    expect((await detail.json() as { report: Record<string, unknown> }).report).toMatchObject({
      headerRow: 1, mapping: { date: 'Date', guests: 'Guests', netSales: 'Net Sales', location: null },
      decidedBy: { date: 'rules', guests: 'rules', netSales: 'rules', rowMode: 'rules' }, rowMode: 'day', encoding: 'utf-8',
      overlap: { days: 0, replaced: false },
    });
    const uploaded = (await auditEvents(server)).filter((event) => event.action === 'sales.uploaded').at(-1);
    expect(uploaded).toMatchObject({ actorUserId: member.userId, actorRole: 'member', details: { locationId, dayCount: 3, inserted: 3, fileId: file.id, via: 'file' } });
    // Done within the last day, the import is still current.
    expect((await (await call(server, `${base(locationId)}/imports/current`, { session: member })).json() as { import: ImportView }).import.id).toBe(importId);
  });

  it('asks when no cell proves the date order, waits, and reads the file once the person answers', async () => {
    const locationId = await newLocation();
    const { file, importId } = await drop(locationId, member, 'either.csv', fixture('slash-either.csv'));
    await start(locationId, importId);
    const waiting = await settledImport(locationId, importId);
    expect(waiting).toMatchObject({
      status: 'waiting', files: [{ id: file.id, status: 'waiting' }],
      question: { fileId: file.id, fileName: 'either.csv', sheet: 0, kind: 'date_order', suggested: null },
    });
    const questionId = waiting.question?.id ?? '';
    const answer = (choice: string, id = questionId) => call(server, `${base(locationId)}/imports/${importId}/answer`, { session: member, json: { questionId: id, choice } });
    expect((await answer('sideways')).status).toBe(400);
    expect((await answer('day_first', 'stale')).status).toBe(409);
    expect((await answer('day_first')).status).toBe(200);
    const done = await settledImport(locationId, importId);
    expect(done).toMatchObject({ status: 'done', files: [{ status: 'read' }] });
    expect(await days(locationId)).toEqual([
      { date: '2025-03-04', guests: 60, netSalesCents: null },
      { date: '2025-04-03', guests: 50, netSalesCents: null },
    ]);
    expect((await answer('day_first')).status).toBe(409);
  });

  it('keeps a file the person is not sure about, and finishes the import', async () => {
    const locationId = await newLocation();
    const { importId } = await drop(locationId, member, 'repeats.csv', fixture('repeated-dates.csv'));
    await start(locationId, importId);
    const waiting = await settledImport(locationId, importId);
    expect(waiting.question?.kind).toBe('row_mode');
    await call(server, `${base(locationId)}/imports/${importId}/answer`, { session: member, json: { questionId: waiting.question?.id, choice: 'not_sure' } });
    expect(await settledImport(locationId, importId)).toMatchObject({ status: 'done', files: [{ status: 'kept', outcome: 'needs_help' }] });
  });

  it('adds only new days from a member’s file and replaces days from an admin’s, read in upload order', async () => {
    const locationId = await newLocation();
    await addSalesDay(server, { orgId, locationId, date: '2025-01-01', guests: 1, netSalesCents: 100 });
    const first = await drop(locationId, member, 'member.csv', fixture('day-level.csv'));
    const second = await drop(locationId, admin, 'admin.csv', Buffer.from('Date,Guests\n2025-01-02,7\n2025-01-03,8\n'));
    expect(second.importId).toBe(first.importId);
    await start(locationId, first.importId);
    const done = await settledImport(locationId, first.importId);
    expect(done.appliedVersion).toBe(2);
    expect(done.files.map((file) => [file.status, file.result?.inserted, file.result?.replaced, file.result?.kept])).toEqual([
      ['read', 2, 0, 1],
      ['read', 1, 1, 0],
    ]);
    expect(await days(locationId)).toEqual([
      { date: '2025-01-01', guests: 1, netSalesCents: 100 },
      { date: '2025-01-02', guests: 7, netSalesCents: null },
      { date: '2025-01-03', guests: 8, netSalesCents: null },
      { date: '2025-01-04', guests: 0, netSalesCents: 0 },
    ]);
  });

  it('keeps kinds it does not read with the reason, and fails a file whose original is gone', async () => {
    const locationId = await newLocation();
    const xls = await drop(locationId, member, 'old.xls', Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64)]));
    await drop(locationId, member, 'photo.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]));
    const gone = await drop(locationId, member, 'gone.csv', Buffer.from('Date,Guests\n2025-01-01,1\n'));
    blobs.raw.delete(`${orgId}/${locationId}/${gone.file.id}`);
    await start(locationId, xls.importId);
    const done = await settledImport(locationId, xls.importId);
    expect(done.files.map((file) => [file.kind, file.status, file.outcome])).toEqual([
      ['xls', 'kept', 'old_excel'], ['other', 'kept', 'image'], ['text', 'failed', 'raw_missing'],
    ]);
    expect(done.status).toBe('done');
  });

  it('reads a workbook', async () => {
    const { xlsxOf } = await import('./helpers/zip.ts');
    const locationId = await newLocation();
    const book = xlsxOf([{ name: 'Sales', rows: [['Business Date', 'Guests', 'Net Sales'], [45658, 120, 3456.5]], dateColumns: [0] }]);
    const { importId } = await drop(locationId, member, 'sales.xlsx', book);
    await start(locationId, importId);
    const done = await settledImport(locationId, importId);
    expect(done.files[0]).toMatchObject({ kind: 'xlsx', status: 'read', result: { dayCount: 1 } });
    expect(await days(locationId)).toEqual([{ date: '2025-01-01', guests: 120, netSalesCents: 345_650 }]);
  });

  it('reads a PDF’s table and a Word document’s table, and keeps each with the reason when it has none', async () => {
    const { pdfOf, row } = await import('./helpers/pdf.ts');
    const { zipOf } = await import('./helpers/zip.ts');
    const locationId = await newLocation();
    const pdf = pdfOf([{ texts: [...row(700, [[72, 'Date'], [200, 'Guests']]), ...row(685, [[72, '2025-02-01'], [200, '9']])] }]);
    const letter = pdfOf([{ texts: [{ text: 'Dear owner', x: 72, y: 700 }] }]);
    const word = zipOf([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<w:document><w:body><w:p><w:r><w:t>Only words</w:t></w:r></w:p></w:body></w:document>' },
    ]);
    const { importId } = await drop(locationId, member, 'sales.pdf', pdf);
    await drop(locationId, member, 'letter.pdf', letter);
    await drop(locationId, member, 'notes.docx', word);
    await start(locationId, importId);
    const done = await settledImport(locationId, importId);
    expect(done.files.map((file) => [file.kind, file.status, file.outcome])).toEqual([
      ['pdf', 'read', null], ['pdf', 'kept', 'pdf_no_table'], ['docx', 'kept', 'word_no_table'],
    ]);
    expect(await days(locationId)).toEqual([{ date: '2025-02-01', guests: 9, netSalesCents: null }]);
  });

  it('reads a ZIP in place: its entries listed with what became of each, one question for a family, then its days', async () => {
    const { zipOf } = await import('./helpers/zip.ts');
    const locationId = await newLocation();
    const header = 'Business Date,Total A,Total B\n';
    const zip = zipOf([
      { name: 'export/2025-01-01.csv', data: `${header}2025-01-01,5,50.00\n` },
      { name: 'export/2025-01-02.csv', data: `${header}2025-01-02,6,60.00\n` },
      { name: 'export/readme.txt', data: 'Nothing to see' },
    ]);
    const { file, importId } = await drop(locationId, member, 'export.zip', zip);
    expect(file.kind).toBe('zip');
    await start(locationId, importId);
    const waiting = await settledImport(locationId, importId);
    expect(waiting).toMatchObject({ status: 'waiting', question: { kind: 'columns', family: 'Business Date, Total A, Total B', fileId: file.id } });
    const answered = await call(server, `${base(locationId)}/imports/${importId}/answer`, {
      session: member, json: { questionId: waiting.question?.id, choice: 'guests:1,netSales:2' },
    });
    expect(answered.status).toBe(200);
    const done = await settledImport(locationId, importId);
    expect(done.files[0]).toMatchObject({ status: 'read', entries: { total: 3, used: 2, kept: 1 }, result: { dayCount: 2 } });
    expect(await days(locationId)).toEqual([
      { date: '2025-01-01', guests: 5, netSalesCents: 5000 }, { date: '2025-01-02', guests: 6, netSalesCents: 6000 },
    ]);
    const report = (await (await call(server, `${base(locationId)}/files/${file.id}`, { session: member })).json() as { report: Record<string, unknown> }).report;
    expect(report.families).toEqual([expect.objectContaining({ label: ['Business Date', 'Total A', 'Total B'], entries: 2, used: true, dayCount: 2 })]);
    const listed = async (): Promise<unknown[]> => ((await (await call(server, `${base(locationId)}/files/${file.id}/entries`, { session: member }))
      .json()) as { entries: { path: string | null; status: string; outcome: string | null }[] }).entries.map((entry) => [entry.path, entry.status, entry.outcome]);
    expect(await listed()).toEqual([
      ['export/2025-01-01.csv', 'used', null], ['export/2025-01-02.csv', 'used', null], ['export/readme.txt', 'kept', 'not_a_table'],
    ]);
    // Deleting the original deletes the paths inside it too (a path can name a person); what became of each stays.
    expect((await call(server, `${base(locationId)}/files/${file.id}/raw`, { session: member, method: 'DELETE' })).status).toBe(200);
    expect(await listed()).toEqual([[null, 'used', null], [null, 'used', null], [null, 'kept', 'not_a_table']]);
    const notZip = await drop(locationId, member, 'plain.csv', Buffer.from('Date,Guests\n2024-01-01,1\n'));
    const refused = await call(server, `${base(locationId)}/files/${notZip.file.id}/entries`, { session: member });
    expect([refused.status, ((await refused.json()) as { error: string }).error]).toEqual([404, 'no_entries']);
  });

  it('never puts a ZIP entry path or anything inside the ZIP in a log line or an audit event', async () => {
    const { zipOf } = await import('./helpers/zip.ts');
    const locationId = await newLocation();
    server.logs.length = 0;
    const zip = zipOf([{ name: `${SENTINEL}/sales.csv`, data: `Date,Guests,Net Sales,Notes\n2025-03-01,4,4817.29,${SENTINEL}\n` }]);
    const { importId } = await drop(locationId, member, `${SENTINEL}.zip`, zip);
    await start(locationId, importId);
    const done = await settledImport(locationId, importId);
    expect(done.files[0]).toMatchObject({ status: 'read', entries: { total: 1, used: 1, kept: 0 } });
    const stored = JSON.stringify([...server.logs, await auditEvents(server)]);
    for (const secret of [SENTINEL, '4817.29', 'Notes']) expect(stored).not.toContain(secret);
    expect(server.logs.join('\n')).toContain('townwise.file_entries');
  });

  it('never puts a file name, a header, a location value or a cell in a log line, an audit event or an import view’s report', async () => {
    const locationId = await newLocation('Main Street');
    server.logs.length = 0;
    // Figures with a decimal point, which no id or timestamp in a log line can contain by chance.
    const text = `Date,Location,Guests,Net Sales,Notes\n2025-01-01,Main Street,10,7391.58,${SENTINEL}\n2025-01-01,Elm Street,20,6284.17,${SENTINEL}\n`;
    const { file, importId } = await drop(locationId, member, `${SENTINEL}.csv`, Buffer.from(text));
    await start(locationId, importId);
    const done = await settledImport(locationId, importId);
    expect(done.files[0]?.status).toBe('read');
    const report = (await (await call(server, `${base(locationId)}/files/${file.id}`, { session: member })).json() as { report: unknown }).report;
    const stored = JSON.stringify([...server.logs, await auditEvents(server)]);
    for (const secret of [SENTINEL, 'Elm Street', 'Notes', '7391.58', '6284.17']) expect(stored).not.toContain(secret);
    // The report names headers and the location value chosen, but no other cell.
    expect(JSON.stringify(report)).not.toContain(SENTINEL);
    expect(JSON.stringify(report)).not.toContain('Elm Street');
  });
});

describe('the reader’s claim', () => {
  it('skips a suspended organization’s import and leaves it queued', async () => {
    const suspendedOrg = await createOrg(server, { name: `Paused ${randomUUID().slice(0, 6)}` });
    const email = `paused-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId: suspendedOrg, userId: session.userId, email });
    const locationId = await addLocation(server, { orgId: suspendedOrg, name: 'Paused Room' });
    const { importId } = await drop(locationId, session, 'a.csv', Buffer.from('Date,Guests\n2025-01-01,1\n'));
    // Started just before staff suspended the organization (a suspended organization's members cannot start one).
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(suspendedOrg) }, { $set: { status: 'suspended' } });
    await server.connection.collection('tw_imports').updateOne({ _id: new Types.ObjectId(importId) }, { $set: { status: 'queued', startedAt: server.clock.now() } });
    await server.connection.collection('tw_files').updateMany({ importId: new Types.ObjectId(importId) }, { $set: { status: 'queued' } });
    server.reader?.nudge();
    await server.reader?.settled();
    const record = await server.connection.collection('tw_imports').findOne({ _id: new Types.ObjectId(importId) });
    expect(record).toMatchObject({ status: 'queued' });
    expect(await server.connection.collection('tw_files').findOne({ importId: new Types.ObjectId(importId) })).toMatchObject({ status: 'queued' });
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(suspendedOrg) }, { $set: { status: 'active' } });
  });

  it('takes over an import whose reader stopped (its lease ran out), reusing the file’s upload record', async () => {
    const locationId = await newLocation();
    const { file, importId } = await drop(locationId, member, 'a.csv', Buffer.from('Date,Guests\n2025-01-01,1\n2025-01-02,2\n'));
    const uploadId = new Types.ObjectId();
    await server.connection.collection('tw_uploads').insertOne({
      _id: uploadId, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(locationId), uploadedBy: member.userId,
      uploadedAt: server.clock.now(), status: 'applying', dayCount: 2, inserted: 0, replaced: 0, kept: 0, firstDate: '2025-01-01',
      lastDate: '2025-01-02', hasGuests: true, hasNetSales: false,
    });
    await server.connection.collection('tw_imports').updateOne({ _id: new Types.ObjectId(importId) }, {
      $set: { status: 'reading', startedAt: server.clock.now(), lease: { owner: 'crashed-replica', until: new Date(server.clock.now().getTime() - 1000) } },
    });
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(file.id) }, { $set: { status: 'reading', attempts: 1, uploadId } });
    server.reader?.nudge();
    const done = await settledImport(locationId, importId);
    expect(done).toMatchObject({ status: 'done', files: [{ status: 'read', result: { uploadId: uploadId.toHexString(), dayCount: 2 } }] });
    expect(await server.connection.collection('tw_uploads').countDocuments({ locationId: new Types.ObjectId(locationId) })).toBe(1);
    expect(await server.connection.collection('tw_uploads').findOne({ _id: uploadId })).toMatchObject({ status: 'applied', inserted: 2 });
  });

  it('reads a stored file of a started import, so a claim between start and queueing never finishes past it', async () => {
    const locationId = await newLocation();
    const { file, importId } = await drop(locationId, member, 'a.csv', Buffer.from('Date,Guests\n2025-01-01,1\n'));
    // Start's write has landed and queueStored's has not: a reader polls in between.
    await server.connection.collection('tw_imports').updateOne({ _id: new Types.ObjectId(importId) }, { $set: { status: 'queued', startedAt: server.clock.now() } });
    server.reader?.nudge();
    expect(await settledImport(locationId, importId)).toMatchObject({ status: 'done', files: [{ id: file.id, status: 'read' }] });
  });

  it('moves an answered file back to the queue before the import, so no reader finishes the import past it', async () => {
    const locationId = await newLocation();
    const { importId } = await drop(locationId, member, 'either.csv', fixture('slash-either.csv'));
    await start(locationId, importId);
    const waiting = await settledImport(locationId, importId);
    const writes = await writesDuring(server, async () => {
      const res = await call(server, `${base(locationId)}/imports/${importId}/answer`, { session: member, json: { questionId: waiting.question?.id, choice: 'day_first' } });
      expect(res.status).toBe(200);
    });
    // The nudged reader's own claim may follow; the route's two writes come first, file then import.
    expect(writes.filter((write) => write.endsWith('tw_files') || write.endsWith('tw_imports')).slice(0, 2)).toEqual(['update tw_files', 'update tw_imports']);
    expect(await settledImport(locationId, importId)).toMatchObject({ status: 'done', files: [{ status: 'read' }] });
  });

  it('fails a file after three attempts with internal', async () => {
    const locationId = await newLocation();
    const { importId, file } = await drop(locationId, member, 'a.csv', Buffer.from('Date,Guests\n2025-01-01,1\n'));
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(file.id) }, { $set: { attempts: 3 } });
    await start(locationId, importId);
    expect(await settledImport(locationId, importId)).toMatchObject({ status: 'done', files: [{ status: 'failed', outcome: 'internal' }] });
  });
});

describe('import routes', () => {
  it('refuses to start an import twice or with no stored file, and deleting a waiting file takes its question with it', async () => {
    const locationId = await newLocation();
    const created = await call(server, `${base(locationId)}/files`, { session: member, json: { name: 'a.csv', sizeBytes: 10, purpose: 'history' } });
    const importId = (await created.json() as { import: { id: string } }).import.id;
    expect((await (await start(locationId, importId)).json() as { error: string }).error).toBe('import_empty');

    const waiting = await drop(locationId, member, 'either.csv', fixture('slash-either.csv'));
    const later = await drop(locationId, member, 'day.csv', Buffer.from('Date,Guests\n2025-02-01,5\n'));
    expect(waiting.importId).toBe(importId);
    expect((await start(locationId, importId)).status).toBe(202);
    expect((await (await start(locationId, importId)).json() as { error: string }).error).toBe('import_not_open');
    const asked = await settledImport(locationId, importId);
    expect(asked.question?.fileId).toBe(waiting.file.id);
    const removed = await call(server, `${base(locationId)}/files/${waiting.file.id}`, { session: member, method: 'DELETE' });
    expect(removed.status).toBe(200);
    server.reader?.nudge();
    const done = await settledImport(locationId, importId);
    expect(done.question).toBeNull();
    // The upload still open does not hold the import back; if it completes, it is read in the location's next import.
    expect(done.status).toBe('done');
    expect(done.files.map((file) => file.status)).toEqual(['uploading', 'read']);
    expect(done.files[1]?.id).toBe(later.file.id);
  });
});

/** Staff open a new organization nobody has joined as its admin and add a location; resolves what the tests below need. */
async function openAsAdminOrg(): Promise<{ staff: TestSession; orgId: string; locationId: string; grantId: string }> {
  const staff = await signInStaff(server);
  const setup = await setupOrg(server, staff);
  const started = await call(server, `/api/admin/orgs/${setup.orgId}/open-as-admin`, { method: 'POST', session: staff });
  expect(started.status).toBe(201);
  const grantId = (await started.json() as { openAsAdmin: { id: string } }).openAsAdmin.id;
  const created = await call(server, '/api/org/locations', {
    session: staff, json: { name: 'Main Street', town: { townId: 'hanover-nh' }, orgId: setup.orgId },
  });
  expect(created.status).toBe(201);
  return { staff, orgId: setup.orgId, locationId: (await created.json() as { location: { id: string } }).location.id, grantId };
}

describe('open as admin', () => {
  it('a file stored byStaff is read as Townwise staff: sales.uploaded has actor role superadmin and the upload record byStaff', async () => {
    const { staff, orgId: setupId, locationId: staffLocation } = await openAsAdminOrg();
    try {
      const { file, importId } = await drop(staffLocation, staff, 'day-level.csv', fixture('day-level.csv'));
      expect((await start(staffLocation, importId, staff)).status).toBe(202);
      const done = await settledImport(staffLocation, importId, staff);
      expect(done).toMatchObject({ status: 'done', files: [{ status: 'read', uploadedByEmail: 'Townwise staff' }] });
      const event = (await auditEvents(server)).find((e) => e.action === 'sales.uploaded' && String(e.orgId) === setupId);
      expect(event).toMatchObject({
        actorUserId: staff.userId, actorRole: 'superadmin', viewAsGrantId: null, details: { fileId: file.id, via: 'file' },
      });
      const upload = await server.connection.collection('tw_uploads').findOne({ orgId: new Types.ObjectId(setupId) });
      expect(upload).toMatchObject({ byStaff: true, uploadedBy: staff.userId });
    } finally {
      await removeStaffFactor(server);
      await server.connection.collection('tw_view_as_grants').deleteMany({});
    }
  });
});
