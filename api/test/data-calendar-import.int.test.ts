// A calendar file kept in Your data becomes one of the location's calendars (D60; src/files/calendar-import.ts, the
// complete route in src/handlers/files.ts, and the item's `calendar` and its retry in src/handlers/data.ts): an .ics
// file and a calendar CSV are imported once their upload completes, through Your calendars' add and its limits, with
// no titlesNotice; any other text file is left alone; an .ics file that is no calendar, one over 1 MB and a sixth
// calendar are refused and say so; the limit's refusal can be retried; and the same stored file is never imported
// twice. Removing the calendar keeps the file and deleting the file keeps the calendar. Every title and name here is
// made up, and no log line or audit event may hold one.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { MAX_ICS_BYTES } from '../src/calendar/ics.ts';
import type { DataItemView } from '../src/handlers/data.ts';
import { createMemoryFileBlobs, type MemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { MAX_CALENDARS } from '../src/stores/owner-calendars.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { filesPath, uploadFile } from './helpers/files.ts';
import { call, logLines, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const TITLE = 'Sentinel-title rehearsal dinner';
const NAME = 'Sentinel-name bookings';

function ics(...uids: string[]): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Townwise test//EN',
    ...uids.flatMap((uid, index) => [
      'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${TITLE}`, `DTSTART:202606${String(10 + index)}T180000`, `DTEND:202606${String(10 + index)}T210000`, 'END:VEVENT',
    ]),
    'END:VCALENDAR', '',
  ].join('\r\n');
}

const CSV = [
  'event_id,title,start_at,end_at,status,organizer_email',
  `csv-1,${TITLE},2026-06-12T19:00:00-04:00,2026-06-12T23:00:00-04:00,confirmed,sentinel-organizer@example.test`,
  `csv-2,${TITLE},2026-06-13T19:00:00-04:00,2026-06-13T23:00:00-04:00,confirmed,`,
].join('\r\n');

let server: TownwiseTestServer;
let blobs: MemoryFileBlobs;

beforeAll(async () => {
  blobs = createMemoryFileBlobs();
  server = await startTownwiseServer({ files: blobs });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

interface Place { orgId: string; session: TestSession; locationId: string }

/** An organization of its own, with one member and one location. */
async function freshPlace(): Promise<Place> {
  const orgId = await createOrg(server, { name: `Calendar Kitchen ${randomUUID().slice(0, 6)}` });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email });
  const locationId = await addLocation(server, { orgId, name: 'Calendar One' });
  return { orgId, session, locationId };
}

async function keep(place: Place, name: string, text: string | Buffer): Promise<string> {
  const done = await uploadFile(server, place.locationId, place.session, name, Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'), { purpose: 'reference' });
  expect(done.status).toBe(200);
  return done.body.file?.id ?? '';
}

async function itemOf(place: Place, fileId: string): Promise<DataItemView> {
  const res = await call(server, `/api/org/locations/${place.locationId}/data/f_${fileId}`, { session: place.session });
  expect(res.status).toBe(200);
  return (await res.json() as { item: DataItemView }).item;
}

function retry(place: Place, fileId: string): Promise<Response> {
  return call(server, `/api/org/locations/${place.locationId}/data/f_${fileId}/calendar`, { session: place.session, json: {} });
}

function sources(place: Place): Promise<Record<string, unknown>[]> {
  return server.connection.collection('tw_calendar_sources').find({ orgId: new Types.ObjectId(place.orgId) }).toArray();
}

async function addFiveCalendars(place: Place): Promise<string[]> {
  const ids: string[] = [];
  for (let index = 0; index < MAX_CALENDARS; index += 1) {
    const res = await call(server, `/api/org/locations/${place.locationId}/owner-calendars`, {
      session: place.session, json: { kind: 'file', label: `Calendar ${String(index)}`, ics: ics(`own-${String(index)}@example.test`) },
    });
    expect(res.status).toBe(201);
    ids.push((await res.json() as { calendar: { id: string } }).calendar.id);
  }
  return ids;
}

describe('a calendar file kept in Your data (D60)', () => {
  it('an .ics file becomes a file calendar labeled from its name, shown on the item, with no titlesNotice', async () => {
    const place = await freshPlace();
    const fileId = await keep(place, `${NAME}.ics`, ics('a@example.test', 'b@example.test'));
    const [source, ...others] = await sources(place);
    expect(others).toEqual([]);
    expect(source).toMatchObject({ kind: 'file', label: NAME, format: 'ics', eventCount: 2, fromFileId: new Types.ObjectId(fileId), createdBy: place.session.userId });
    expect(source).not.toHaveProperty('titlesNotice');
    const item = await itemOf(place, fileId);
    expect(item.calendar).toEqual({ status: 'added', calendarId: String(source?._id), label: NAME, eventCount: 2 });
    // The file stays a reference item, kept as it is.
    expect(item).toMatchObject({ state: 'kept', outcome: 'reference' });
    const file = await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(fileId) });
    expect(file?.calendarImport).toMatchObject({ state: 'added' });
    const added = (await auditEvents(server)).filter((event) => event.action === 'owner_calendar.added' && String(event.orgId) === place.orgId);
    expect(added.map((event) => event.details)).toEqual([
      { locationId: place.locationId, calendarId: String(source?._id), kind: 'file', eventCount: 2, status: 'ok', fileId },
    ]);
    const text = JSON.stringify(await auditEvents(server)) + JSON.stringify(logLines(server));
    expect(text).not.toContain(TITLE);
    expect(text).not.toContain(NAME);
    expect(logLines(server)).toContainEqual(expect.objectContaining({ msg: 'townwise.file_calendar_imported', fileId, outcome: 'added' }));
  });

  it('a calendar CSV becomes a csv file calendar; its other columns are never kept', async () => {
    const place = await freshPlace();
    const fileId = await keep(place, 'master calendar.csv', CSV);
    const [source] = await sources(place);
    expect(source).toMatchObject({ label: 'master calendar', format: 'csv', eventCount: 2 });
    expect(JSON.stringify(await server.connection.collection('tw_calendar_events').find({ sourceId: source?._id }).toArray())).not.toContain('sentinel-organizer');
    expect((await itemOf(place, fileId)).calendar).toMatchObject({ status: 'added', label: 'master calendar', eventCount: 2 });
  });

  it('any other text file is left alone: no calendar, nothing recorded, and its retry answers 400', async () => {
    const place = await freshPlace();
    const fileId = await keep(place, 'notes.txt', 'Dinner prices for June\nBEGIN:VCALENDAR is not at the start\n');
    expect(await sources(place)).toEqual([]);
    expect((await itemOf(place, fileId)).calendar).toBeNull();
    expect(await server.connection.collection('tw_files').findOne({ _id: new Types.ObjectId(fileId) })).not.toHaveProperty('calendarImport');
    const res = await retry(place, fileId);
    expect(res.status).toBe(400);
  });

  it('an .ics file that is no calendar is refused not_calendar, for good', async () => {
    const place = await freshPlace();
    const fileId = await keep(place, 'broken.ics', 'This is not a calendar.');
    expect(await sources(place)).toEqual([]);
    expect((await itemOf(place, fileId)).calendar).toEqual({ status: 'refused', reason: 'not_calendar', retry: false });
    // A retry of a refusal for good answers the item as it is.
    const res = await retry(place, fileId);
    expect(res.status).toBe(200);
    expect((await res.json() as { item: DataItemView }).item.calendar).toEqual({ status: 'refused', reason: 'not_calendar', retry: false });
    expect(await sources(place)).toEqual([]);
  });

  it('an .ics file over 1 MB is refused too_large, unread', async () => {
    const place = await freshPlace();
    const big = ics('big@example.test').replace('END:VCALENDAR', `X-PAD:${'x'.repeat(MAX_ICS_BYTES)}\r\nEND:VCALENDAR`);
    const fileId = await keep(place, 'big.ics', big);
    expect(await sources(place)).toEqual([]);
    expect((await itemOf(place, fileId)).calendar).toEqual({ status: 'refused', reason: 'too_large', retry: false });
  });

  it('a sixth calendar is refused calendar_limit; once one is removed, the retry adds it, and a second retry adds nothing', async () => {
    const place = await freshPlace();
    const own = await addFiveCalendars(place);
    const fileId = await keep(place, `${NAME}.ics`, ics('late@example.test'));
    expect(await sources(place)).toHaveLength(MAX_CALENDARS);
    expect((await itemOf(place, fileId)).calendar).toEqual({ status: 'refused', reason: 'calendar_limit', retry: true });
    // Still full: refused again, and still retryable.
    const full = await retry(place, fileId);
    expect((await full.json() as { item: DataItemView }).item.calendar).toEqual({ status: 'refused', reason: 'calendar_limit', retry: true });
    const removed = await call(server, `/api/org/locations/${place.locationId}/owner-calendars/${own[0] ?? ''}`, { method: 'DELETE', session: place.session });
    expect(removed.status).toBe(204);
    const res = await retry(place, fileId);
    expect(res.status).toBe(200);
    expect((await res.json() as { item: DataItemView }).item.calendar).toMatchObject({ status: 'added', label: NAME, eventCount: 1 });
    const again = await retry(place, fileId);
    expect((await again.json() as { item: DataItemView }).item.calendar).toMatchObject({ status: 'added' });
    expect((await sources(place)).filter((source) => source.fromFileId !== undefined)).toHaveLength(1);
  });

  it('a second complete, the same file dropped again and two retries at once never import it twice', async () => {
    const place = await freshPlace();
    const fileId = await keep(place, `${NAME}.ics`, ics('once@example.test'));
    const twice = await call(server, filesPath(place.locationId, `/${fileId}/complete`), { session: place.session, json: {} });
    expect(twice.status).toBe(409);
    const copy = await uploadFile(server, place.locationId, place.session, `${NAME} copy.ics`, Buffer.from(ics('once@example.test'), 'utf8'), { purpose: 'reference' });
    expect(copy).toMatchObject({ status: 409, body: { error: 'file_duplicate', fileId } });
    // Two imports of one file racing: the unique index lets one store it.
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(fileId) }, { $set: { calendarImport: { state: 'refused', code: 'unavailable', at: server.clock.now() } } });
    await server.connection.collection('tw_calendar_sources').deleteMany({ orgId: new Types.ObjectId(place.orgId) });
    const [first, second] = await Promise.all([retry(place, fileId), retry(place, fileId)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(await sources(place)).toHaveLength(1);
    expect((await itemOf(place, fileId)).calendar).toMatchObject({ status: 'added' });
  });

  it('removing the calendar keeps the file, which says so and is never imported again; deleting a file keeps its calendar', async () => {
    const place = await freshPlace();
    const fileId = await keep(place, `${NAME}.ics`, ics('kept@example.test'));
    const [source] = await sources(place);
    const removed = await call(server, `/api/org/locations/${place.locationId}/owner-calendars/${String(source?._id)}`, { method: 'DELETE', session: place.session });
    expect(removed.status).toBe(204);
    expect((await itemOf(place, fileId)).calendar).toEqual({ status: 'removed' });
    const res = await retry(place, fileId);
    expect((await res.json() as { item: DataItemView }).item.calendar).toEqual({ status: 'removed' });
    expect(await sources(place)).toEqual([]);

    const other = await keep(place, 'second.ics', ics('second@example.test'));
    const deleted = await call(server, `/api/org/locations/${place.locationId}/data/f_${other}`, { method: 'DELETE', session: place.session });
    expect(deleted.status).toBe(200);
    expect(await sources(place)).toHaveLength(1);
  });

  // UI review 2026-11-19: an .ics file kept before D60 has no import record and no calendar. It is filed in Calendars,
  // its item says nothing was tried (`calendar` null), and the retry route imports it once, under the same unique index.
  async function keptBeforeImports(place: Place, name: string, text: string): Promise<string> {
    const fileId = await keep(place, name, text);
    await server.connection.collection('tw_calendar_sources').deleteMany({ orgId: new Types.ObjectId(place.orgId) });
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(fileId) }, { $unset: { calendarImport: '' } });
    return fileId;
  }

  async function folderOfItem(place: Place, ref: string): Promise<string | undefined> {
    const res = await call(server, `/api/org/data?locationId=${place.locationId}`, { session: place.session });
    expect(res.status).toBe(200);
    return (await res.json() as { items: DataItemView[] }).items.find((item) => item.ref === ref)?.folder;
  }

  it('an .ics file kept before calendar files were imported is filed in Calendars, and Import as a calendar adds it once', async () => {
    const place = await freshPlace();
    const fileId = await keptBeforeImports(place, `${NAME}.ics`, ics('legacy@example.test', 'legacy-2@example.test'));
    expect(await sources(place)).toEqual([]);
    expect((await itemOf(place, fileId)).calendar).toBeNull();
    expect(await folderOfItem(place, `f_${fileId}`)).toBe('calendars');
    const [first, second] = await Promise.all([retry(place, fileId), retry(place, fileId)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const [source, ...others] = await sources(place);
    expect(others).toEqual([]);
    expect(source).toMatchObject({ kind: 'file', label: NAME, eventCount: 2, fromFileId: new Types.ObjectId(fileId) });
    expect((await itemOf(place, fileId)).calendar).toEqual({ status: 'added', calendarId: String(source?._id), label: NAME, eventCount: 2 });
    const again = await retry(place, fileId);
    expect((await again.json() as { item: DataItemView }).item.calendar).toMatchObject({ status: 'added' });
    expect(await sources(place)).toHaveLength(1);
  });

  it('an old .ics file that is no calendar is refused not_calendar on import, and one whose original was deleted answers 400', async () => {
    const place = await freshPlace();
    const broken = await keptBeforeImports(place, 'old broken.ics', 'This is not a calendar.');
    const res = await retry(place, broken);
    expect(res.status).toBe(200);
    expect((await res.json() as { item: DataItemView }).item.calendar).toEqual({ status: 'refused', reason: 'not_calendar', retry: false });
    expect(await sources(place)).toEqual([]);

    const gone = await keptBeforeImports(place, 'old gone.ics', ics('gone@example.test'));
    await server.connection.collection('tw_files').updateOne({ _id: new Types.ObjectId(gone) }, { $set: { rawDeletedAt: server.clock.now() } });
    expect((await retry(place, gone)).status).toBe(400);
    expect(await sources(place)).toEqual([]);
  });

  it('a calendar file uploaded as sales history is not imported here', async () => {
    const place = await freshPlace();
    const done = await uploadFile(server, place.locationId, place.session, 'history.ics', Buffer.from(ics('h@example.test'), 'utf8'));
    expect(done.status).toBe(200);
    expect(await sources(place)).toEqual([]);
  });
});
