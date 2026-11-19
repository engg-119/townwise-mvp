// Your data's folders and calendars (D61; src/data/folders.ts, the list in src/handlers/data.ts and the calendars list's
// `fromFile` in src/handlers/owner-calendars.ts): every item carries its folder, from what Townwise knows of it (a sales
// upload, a calendar file, saved text, a TownwiseAI read's kind, or the file's own `folder`), never its name; the list
// answers the scope's calendars, and leaves out a file a calendar was imported from while that calendar exists; and the
// calendar names the file it came from while the file is kept. Every name, title and text here is made up.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import type { DataCalendarView, DataItemView } from '../src/handlers/data.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { createTownwiseStores } from '../src/stores/index.ts';
import { addLocation, addSeat, addUpload, createOrg } from './helpers/fixtures.ts';
import { uploadFile } from './helpers/files.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

function ics(uid: string): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Townwise test//EN',
    'BEGIN:VEVENT', `UID:${uid}`, 'SUMMARY:Sentinel-title tasting', 'DTSTART:20260610T180000', 'DTEND:20260610T210000', 'END:VEVENT',
    'END:VCALENDAR', '',
  ].join('\r\n');
}

let server: TownwiseTestServer;
let blobs: MemoryFileBlobs;

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  server = await startTownwiseServer({ files: blobs });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

interface Place { orgId: string; session: TestSession; locationId: string }

async function freshPlace(): Promise<Place> {
  const orgId = await createOrg(server, { name: `Folder Kitchen ${randomUUID().slice(0, 6)}` });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email });
  const locationId = await addLocation(server, { orgId, name: 'Folder One' });
  return { orgId, session, locationId };
}

const scopeOf = (orgId: string): OrgScope => ({ orgId }) as unknown as OrgScope;

function tick(): void {
  server.clock.advance(1000);
}

async function keep(place: Place, name: string, bytes: string, locationId = place.locationId): Promise<string> {
  const done = await uploadFile(server, locationId, place.session, name, Buffer.from(bytes, 'utf8'), { purpose: 'reference' });
  expect(done.status).toBe(200);
  tick();
  return done.body.file?.id ?? '';
}

async function list(place: Place, query = `?locationId=${place.locationId}`): Promise<{ items: DataItemView[]; calendars: DataCalendarView[] }> {
  const res = await call(server, `/api/org/data${query}`, { session: place.session });
  expect(res.status).toBe(200);
  return await res.json() as { items: DataItemView[]; calendars: DataCalendarView[] };
}

function folders(items: readonly DataItemView[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.ref, item.folder]));
}

/** A reference file TownwiseAI read as `kind`, as the reader leaves one. */
async function seedRead(place: Place, kind: string): Promise<string> {
  const _id = new Types.ObjectId();
  await server.connection.collection('tw_files').insertOne({
    _id, orgId: new Types.ObjectId(place.orgId), locationId: new Types.ObjectId(place.locationId), importId: null, purpose: 'reference',
    uploadedBy: place.session.userId, uploaderRole: 'member', uploadedAt: server.clock.now(), name: 'Sentinel-name read.pdf', kind: 'pdf',
    sizeBytes: 10, fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference', progress: null,
    readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null, rawDeletedAt: null, attempts: 0,
    ai: {
      status: 'done', requestedBy: place.session.userId, requestedByRole: 'member', requestedByStaff: false, requestedGrantId: null,
      requestedAt: server.clock.now(), attempts: 1, leaseUntil: null, startedAt: null, finishedAt: server.clock.now(), reason: null,
      partial: false, costMicroUsd: 0,
      result: { kind, confidence: 'high', summary: 'A synthetic summary.', facts: [], events: [], days: [] },
    },
  });
  tick();
  return _id.toHexString();
}

async function calendarsOf(place: Place): Promise<{ id: string; label: string; fromFile: string | null }[]> {
  const res = await call(server, `/api/org/locations/${place.locationId}/owner-calendars`, { session: place.session });
  expect(res.status).toBe(200);
  return (await res.json() as { calendars: { id: string; label: string; fromFile: string | null }[] }).calendars;
}

describe('folders (D61)', () => {
  it('files each item by what Townwise knows of it, never by its name', async () => {
    const place = await freshPlace();
    const upload = await addUpload(server, { orgId: place.orgId, locationId: place.locationId, uploadedAt: server.clock.now(), status: 'applied' });
    tick();
    const text = await call(server, `/api/org/locations/${place.locationId}/data/text`, {
      session: place.session, json: { title: 'Sentinel-name menu notes', text: 'Synthetic pasted text.' },
    });
    expect(text.status).toBe(201);
    const pasted = (await text.json() as { file: { id: string } }).file.id;
    tick();
    // Named like a menu, but nothing has read it: Not sorted yet.
    const plain = await keep(place, 'dinner menu.txt', 'Synthetic words.');
    const notCalendar = await keep(place, 'broken.ics', 'Synthetic, no calendar here.');
    const menu = await seedRead(place, 'menu');
    const inventory = await seedRead(place, 'inventory');
    const staffing = await seedRead(place, 'staffing');
    const other = await seedRead(place, 'other');
    const sales = await seedRead(place, 'sales');
    const { items } = await list(place);
    expect(folders(items)).toEqual({
      [`u_${upload}`]: 'sales', [`f_${pasted}`]: 'notes', [`f_${plain}`]: 'unsorted', [`f_${notCalendar}`]: 'unsorted',
      [`f_${menu}`]: 'menus', [`f_${inventory}`]: 'inventory', [`f_${staffing}`]: 'staffing', [`f_${other}`]: 'other', [`f_${sales}`]: 'sales',
    });
    // The item's own page says the same.
    const one = await call(server, `/api/org/locations/${place.locationId}/data/f_${menu}`, { session: place.session });
    expect((await one.json() as { item: DataItemView }).item.folder).toBe('menus');
  });

  it('a file’s own folder outranks a read’s kind, never a calendar or sales; null forgets it (the hook D59 files with)', async () => {
    const place = await freshPlace();
    const stores = createTownwiseStores(server.connection);
    const scope = scopeOf(place.orgId);
    const read = await seedRead(place, 'menu');
    const plain = await keep(place, 'notes.txt', 'Synthetic words.');
    expect(await stores.files.setFolder(scope, read, 'inventory')).toBe(true);
    expect(await stores.files.setFolder(scope, plain, 'staffing')).toBe(true);
    expect(folders((await list(place)).items)).toMatchObject({ [`f_${read}`]: 'inventory', [`f_${plain}`]: 'staffing' });
    expect(await stores.files.setFolder(scope, read, null)).toBe(true);
    expect(folders((await list(place)).items)).toMatchObject({ [`f_${read}`]: 'menus' });
    // Another organization's file is not found.
    const elsewhere = await freshPlace();
    expect(await stores.files.setFolder(scopeOf(elsewhere.orgId), plain, 'other')).toBe(false);
    expect(folders((await list(place)).items)).toMatchObject({ [`f_${plain}`]: 'staffing' });
  });

  it('an edit of pasted text stays in Notes', async () => {
    const place = await freshPlace();
    const text = await call(server, `/api/org/locations/${place.locationId}/data/text`, {
      session: place.session, json: { title: 'Sentinel-name hours', text: 'Synthetic pasted text.' },
    });
    const pasted = (await text.json() as { file: { id: string } }).file.id;
    tick();
    const edit = await keep(place, 'Sentinel-name hours.txt', 'Synthetic pasted text, edited.');
    const res = await call(server, `/api/org/locations/${place.locationId}/data/f_${pasted}/replace`, { session: place.session, json: { fileId: edit } });
    expect(res.status).toBe(200);
    expect((await res.json() as { item: DataItemView }).item).toMatchObject({ ref: `f_${edit}`, folder: 'notes' });
  });
});

describe('calendars in the list (D61)', () => {
  it('answers the location’s calendars and leaves out a file imported as one while that calendar exists', async () => {
    const place = await freshPlace();
    const kept = await keep(place, 'Sentinel-name bookings.ics', ics('a@example.test'));
    const plain = await keep(place, 'notes.txt', 'Synthetic words.');
    const added = await call(server, `/api/org/locations/${place.locationId}/owner-calendars`, {
      session: place.session, json: { kind: 'file', label: 'Front desk', ics: ics('b@example.test') },
    });
    expect(added.status).toBe(201);
    const { items, calendars } = await list(place);
    expect(items.map((item) => item.ref)).toEqual([`f_${plain}`]);
    expect(calendars).toEqual([
      expect.objectContaining({ locationId: place.locationId, label: 'Sentinel-name bookings', kind: 'file', host: null, eventCount: 1, status: 'ok' }),
      expect.objectContaining({ locationId: place.locationId, label: 'Front desk', kind: 'file', eventCount: 1 }),
    ]);
    expect(Object.keys(calendars[0] ?? {}).sort()).toEqual(
      ['createdAt', 'eventCount', 'host', 'id', 'kind', 'label', 'lastSuccessAt', 'locationId', 'skippedRepeating', 'status'],
    );
    // The imported file's own page still answers, in Calendars.
    const one = await call(server, `/api/org/locations/${place.locationId}/data/f_${kept}`, { session: place.session });
    expect((await one.json() as { item: DataItemView }).item).toMatchObject({ folder: 'calendars', calendar: { status: 'added' } });

    // Once its calendar is removed the file is listed again, still in Calendars.
    const [first] = calendars;
    const removed = await call(server, `/api/org/locations/${place.locationId}/owner-calendars/${first?.id ?? ''}`, { method: 'DELETE', session: place.session });
    expect(removed.status).toBe(204);
    const after = await list(place);
    expect(folders(after.items)).toEqual({ [`f_${plain}`]: 'unsorted', [`f_${kept}`]: 'calendars' });
    expect(after.calendars.map((calendar) => calendar.label)).toEqual(['Front desk']);
  });

  it('with no location answers every location’s calendars, and never another organization’s', async () => {
    const place = await freshPlace();
    const second = await addLocation(server, { orgId: place.orgId, name: 'Folder Two' });
    await keep(place, 'one.ics', ics('one@example.test'));
    await keep(place, 'two.ics', ics('two@example.test'), second);
    const elsewhere = await freshPlace();
    await keep(elsewhere, 'theirs.ics', ics('theirs@example.test'));
    const { items, calendars } = await list(place, '');
    expect(items).toEqual([]);
    expect(calendars.map((calendar) => [calendar.label, calendar.locationId]).sort()).toEqual([['one', place.locationId], ['two', second]].sort());
    expect((await list(place)).calendars.map((calendar) => calendar.label)).toEqual(['one']);
  });
});

describe('the calendar’s file (D61)', () => {
  it('names the Your data item a calendar was imported from while that file is kept', async () => {
    const place = await freshPlace();
    const fileId = await keep(place, 'Sentinel-name bookings.ics', ics('a@example.test'));
    const added = await call(server, `/api/org/locations/${place.locationId}/owner-calendars`, {
      session: place.session, json: { kind: 'file', label: 'Front desk', ics: ics('b@example.test') },
    });
    expect(added.status).toBe(201);
    expect((await calendarsOf(place)).map((calendar) => [calendar.label, calendar.fromFile])).toEqual([
      ['Sentinel-name bookings', `f_${fileId}`], ['Front desk', null],
    ]);
    const deleted = await call(server, `/api/org/locations/${place.locationId}/data/f_${fileId}`, { method: 'DELETE', session: place.session });
    expect(deleted.status).toBe(200);
    expect((await calendarsOf(place)).map((calendar) => calendar.fromFile)).toEqual([null, null]);
  });
});
