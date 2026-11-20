// Notes, the tuning step (spec 10.5, 12, P14): range, weekday, effect and kind rules; author-or-admin edits;
// notes reachable only through their own location; the 1,000 cap; detail never in logs or audit events; hours and
// buyout guests (the calendar change); the store's overlapping read; titles and a TownwiseAI note's source ref (D49).
// A note made from an owner-calendar event keeps a link to it (openspec change calendar-event-suggestions, design
// decision 2): only to a keyed event of this location's calendar, with the stored row's dates, never the request's; the
// store's linkedTo, moveIf and removeIf.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { TOWNWISE_AI_AUTHOR } from '../src/agent/apply.ts';
import type { IcsEvent } from '../src/calendar/ics.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import { readNoteContent, sameNoteContent, type NoteView } from '../src/handlers/notes.ts';
import { createNoteStore } from '../src/stores/notes.ts';
import { createOwnerCalendarStore } from '../src/stores/owner-calendars.ts';
import { addLocation, addSalesDay, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;
/** The same database with stored files on. Each start drops the database, so both start before any fixture. */
let withFiles: TownwiseTestServer;

beforeAll(async () => {
  server = await startTownwiseServer();
  withFiles = await startTownwiseServer({ files: createMemoryFileBlobs() });
});
afterAll(async () => {
  await server.close();
  await withFiles.close();
});
beforeEach(async () => { await server.redis.flushdb(); });

// The test clock starts at 2026-06-01T12:00Z, so the latest start date is 2028-06-01.
const NOTE = {
  kind: 'closure', startDate: '2026-07-04', endDate: '2026-07-05', weekdays: null, effect: 'closed', expectedGuests: null, detail: null,
};

interface Person { session: TestSession; email: string }
let orgId: string;
let locationId: string;
let otherLocationId: string;
let admin: Person;
let author: Person;
let colleague: Person;

async function person(name: string, role: 'org_admin' | 'member'): Promise<Person> {
  const email = `${name}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  return { session, email };
}

beforeAll(async () => {
  orgId = await createOrg(server, { name: 'Notes Tavern' });
  locationId = await addLocation(server, { orgId, name: 'Taproom' });
  otherLocationId = await addLocation(server, { orgId, name: 'Patio' });
  admin = await person('admin', 'org_admin');
  author = await person('author', 'member');
  colleague = await person('colleague', 'member');
});

function notesPath(location = locationId): string {
  return `/api/org/locations/${location}/notes`;
}

function post(body: unknown, who = author, location = locationId): Promise<Response> {
  return call(server, notesPath(location), { session: who.session, json: body });
}

async function created(body: unknown, who = author, location = locationId): Promise<NoteView> {
  const res = await post(body, who, location);
  expect(res.status).toBe(201);
  return (await res.json() as { note: NoteView }).note;
}

async function errorOf(res: Response): Promise<{ status: number; error: string }> {
  const body = await res.json() as { error: string };
  return { status: res.status, error: body.error };
}

describe('POST /api/org/locations/:locationId/notes', () => {
  it('a member adds a note; it is stored field by field, and logs and the audit event never hold its detail', async () => {
    server.logs.length = 0;
    const detail = 'Sentinel rehearsal dinner for a wedding party';
    const note = await created({
      kind: 'private_event', startDate: '2026-08-14', endDate: '2026-08-16', weekdays: [6, 5], effect: 'more_guests',
      expectedGuests: 180, detail: `  ${detail} `,
    });
    expect(note).toEqual({
      id: note.id, kind: 'private_event', startDate: '2026-08-14', endDate: '2026-08-16', weekdays: [5, 6], effect: 'more_guests',
      expectedGuests: 180, detail, title: null, startTime: null, endTime: null, createdByEmail: author.email, createdAt: server.clock.now().toISOString(),
      updatedAt: server.clock.now().toISOString(), canEdit: true, source: null, fromEvent: null,
    });
    const stored = await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) });
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      '_id', 'createdAt', 'createdBy', 'detail', 'effect', 'endDate', 'endTime', 'expectedGuests', 'kind', 'locationId', 'orgId', 'startDate',
      'startTime', 'title', 'updatedAt', 'weekdays',
    ]);
    expect(stored).toMatchObject({ createdBy: author.session.userId, weekdays: [5, 6] });

    const event = (await auditEvents(server)).find((e) => (e.target as { id: string }).id === note.id);
    expect(event).toMatchObject({ action: 'note.created', actorUserId: author.session.userId, actorRole: 'member' });
    expect(event?.details).toEqual({ locationId, kind: 'private_event', startDate: '2026-08-14', endDate: '2026-08-16' });
    expect(JSON.stringify(await auditEvents(server))).not.toContain('Sentinel');
    expect(server.logs.join('\n')).not.toContain('Sentinel');
  });

  it('reads a missing weekdays, expected guests or detail as null', async () => {
    const note = await created({ kind: 'opening', startDate: '2026-09-01', endDate: '2026-09-01', effect: 'unknown' });
    expect(note).toMatchObject({ weekdays: null, expectedGuests: null, detail: null });
  });

  it('holds the range, weekday, effect and kind rules', async () => {
    const refused: Record<string, unknown>[] = [
      { endDate: '2026-07-03' },                                         // ends before it starts
      { startDate: '2026-07-04', endDate: '2027-07-06' },                // 367 days after the start
      { startDate: '2009-12-31', endDate: '2009-12-31' },                // before 2010-01-01
      { startDate: '2028-06-02', endDate: '2028-06-02' },                // after today plus two years
      { startDate: '2026-02-30', endDate: '2026-03-01' },                // not a real date
      { startDate: '2026-7-4' },
      { weekdays: [] }, { weekdays: [7] }, { weekdays: [-1] }, { weekdays: [1, 1] }, { weekdays: [1.5] },
      { expectedGuests: 40 },                                            // closed, with expected guests
      { effect: 'more_guests', expectedGuests: 0 }, { effect: 'more_guests', expectedGuests: 20_001 },
      { effect: 'more_guests', expectedGuests: 12.5 },
      { kind: 'other', effect: 'unknown' }, { kind: 'other', effect: 'unknown', detail: '   ' },
      { detail: 'x'.repeat(281) },
      { kind: 'holiday' }, { effect: 'busy' }, { kind: undefined },
      { title: 'x'.repeat(121) }, { title: 42 },
    ];
    const before = await server.connection.collection('tw_notes').countDocuments({});
    for (const change of refused) {
      expect({ change, ...(await errorOf(await post({ ...NOTE, ...change }))) }).toEqual({ change, status: 400, error: 'invalid_request' });
    }
    expect(await server.connection.collection('tw_notes').countDocuments({})).toBe(before);

    const accepted: Record<string, unknown>[] = [
      { startDate: '2026-07-04', endDate: '2027-07-05' },                // 366 days after the start
      { startDate: '2010-01-01', endDate: '2010-01-01' },
      { startDate: '2028-06-01', endDate: '2028-06-03' },                // starts today plus two years
      { weekdays: [0, 1, 2, 3, 4, 5, 6] },
      { effect: 'fewer_guests', expectedGuests: 1 }, { effect: 'more_guests', expectedGuests: 20_000 },
      { kind: 'other', effect: 'unknown', detail: 'Road closed for the parade' },
      { detail: 'x'.repeat(280) },
      { title: 'x'.repeat(120) }, { title: '\u{1F389}'.repeat(120) },          // 120 code points, an emoji two UTF-16 units each
      { kind: 'other', effect: 'unknown', title: 'Road race' },          // an other note with only a title
    ];
    for (const change of accepted) expect({ change, status: (await post({ ...NOTE, ...change })).status }).toEqual({ change, status: 201 });
  });

  it('the 1,001st note on a location is 409 note_limit; another location still takes notes', async () => {
    const full = await addLocation(server, { orgId, name: 'Full Room' });
    const now = server.clock.now();
    await server.connection.collection('tw_notes').insertMany(Array.from({ length: 1000 }, () => ({
      orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(full), kind: 'closure', startDate: '2026-05-01',
      endDate: '2026-05-01', weekdays: null, effect: 'closed', expectedGuests: null, detail: null, createdBy: author.session.userId,
      createdAt: now, updatedAt: now,
    })));
    expect(await errorOf(await post(NOTE, author, full))).toEqual({ status: 409, error: 'note_limit' });
    expect((await post(NOTE, author, otherLocationId)).status).toBe(201);
  });
});

describe('GET, PATCH and DELETE', () => {
  it('lists notes by start date, with canEdit for the author and for org admins only', async () => {
    const location = await addLocation(server, { orgId, name: 'List Room' });
    const late = await created({ ...NOTE, startDate: '2026-12-24', endDate: '2026-12-26' }, author, location);
    const early = await created({ ...NOTE, startDate: '2026-01-01', endDate: '2026-01-01' }, colleague, location);
    const middle = await created({ ...NOTE, startDate: '2026-07-04', endDate: '2026-07-04' }, admin, location);
    const list = async (who: Person) => (await (await call(server, notesPath(location), { session: who.session })).json() as { notes: NoteView[] }).notes;

    const asAuthor = await list(author);
    expect(asAuthor.map((n) => [n.id, n.createdByEmail, n.canEdit])).toEqual([
      [early.id, colleague.email, false], [middle.id, admin.email, false], [late.id, author.email, true],
    ]);
    expect((await list(admin)).map((n) => n.canEdit)).toEqual([true, true, true]);
  });

  it('a member editing or deleting another member’s note is 403 and changes nothing; the author and an org admin can', async () => {
    const note = await created(NOTE);
    const path = `${notesPath()}/${note.id}`;
    const before = await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) });
    const change = { ...NOTE, kind: 'other', effect: 'unknown', detail: 'Changed by someone else' };
    expect(await errorOf(await call(server, path, { method: 'PATCH', session: colleague.session, json: change }))).toEqual({ status: 403, error: 'forbidden' });
    expect(await errorOf(await call(server, path, { method: 'DELETE', session: colleague.session }))).toEqual({ status: 403, error: 'forbidden' });
    expect(await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) })).toEqual(before);

    server.clock.advance(60 * 1000);
    const replaced = { kind: 'private_event', startDate: '2026-07-10', endDate: '2026-07-10', effect: 'more_guests', expectedGuests: 60 };
    const res = await call(server, path, { method: 'PATCH', session: author.session, json: replaced });
    expect(res.status).toBe(200);
    expect((await res.json() as { note: NoteView }).note).toMatchObject({
      ...replaced, weekdays: null, detail: null, createdByEmail: author.email, createdAt: note.createdAt,
      updatedAt: server.clock.now().toISOString(), canEdit: true,
    });
    expect((await call(server, path, { method: 'PATCH', session: admin.session, json: NOTE })).status).toBe(200);
    expect((await call(server, path, { method: 'DELETE', session: admin.session })).status).toBe(204);
    expect(await server.connection.collection('tw_notes').countDocuments({ _id: new Types.ObjectId(note.id) })).toBe(0);
    expect(await errorOf(await call(server, path, { method: 'DELETE', session: admin.session }))).toEqual({ status: 404, error: 'not_found' });

    const events = (await auditEvents(server)).filter((e) => (e.target as { id: string }).id === note.id);
    expect(events.map((e) => [e.action, e.actorUserId])).toEqual([
      ['note.created', author.session.userId], ['note.updated', author.session.userId],
      ['note.updated', admin.session.userId], ['note.deleted', admin.session.userId],
    ]);
    expect(events[3]?.details).toEqual({ locationId, kind: 'closure', startDate: '2026-07-04', endDate: '2026-07-05' });
  });

  it('any member edits and deletes a note TownwiseAI wrote as itself, as its Undo allows (item 16)', async () => {
    const location = await addLocation(server, { orgId, name: 'Agent Room' });
    const content = readNoteContent({ ...NOTE, detail: 'From a file' }, '2026-06-01');
    if (content === null) throw new Error('fixture');
    const note = await createNoteStore(server.connection).create(({ orgId }) as unknown as OrgScope, location, content, {
      createdBy: TOWNWISE_AI_AUTHOR, now: server.clock.now(),
    });
    const path = `${notesPath(location)}/${note.id}`;
    const listed = await (await call(server, notesPath(location), { session: colleague.session })).json() as { notes: NoteView[] };
    expect(listed.notes.find((n) => n.id === note.id)).toMatchObject({ createdByEmail: 'TownwiseAI', canEdit: true });
    const fixed = { ...NOTE, kind: 'private_event', effect: 'more_guests', expectedGuests: 40 };
    const res = await call(server, path, { method: 'PATCH', session: colleague.session, json: fixed });
    expect(res.status).toBe(200);
    expect((await res.json() as { note: NoteView }).note).toMatchObject({ expectedGuests: 40, canEdit: true });
    expect((await call(server, path, { method: 'DELETE', session: author.session })).status).toBe(204);
    expect(await server.connection.collection('tw_notes').countDocuments({ _id: new Types.ObjectId(note.id) })).toBe(0);
  });

  it('a note is reachable only through its own location: another location’s path answers 404', async () => {
    const note = await created(NOTE);
    const elsewhere = `${notesPath(otherLocationId)}/${note.id}`;
    expect(await errorOf(await call(server, elsewhere, { method: 'PATCH', session: admin.session, json: NOTE }))).toEqual({ status: 404, error: 'not_found' });
    expect(await errorOf(await call(server, elsewhere, { method: 'DELETE', session: admin.session }))).toEqual({ status: 404, error: 'not_found' });
    const listed = await (await call(server, notesPath(otherLocationId), { session: admin.session })).json() as { notes: NoteView[] };
    expect(listed.notes.map((n) => n.id)).not.toContain(note.id);
    expect(await errorOf(await call(server, `${notesPath()}/not-an-id`, { method: 'DELETE', session: admin.session }))).toEqual({ status: 400, error: 'invalid_request' });
  });
});

// The calendar change: optional local hours on a note, and a buyout (private event, closed) may carry its party's size.
describe('note hours and buyout guests', () => {
  const EVENT = {
    kind: 'private_event', startDate: '2026-08-21', endDate: '2026-08-21', weekdays: null, effect: 'more_guests', expectedGuests: 70, detail: null,
  };

  it('stores startTime and endTime, and reads a missing pair and an older note as null', async () => {
    const location = await addLocation(server, { orgId, name: 'Hours Room' });
    const note = await created({ ...EVENT, startTime: '18:30', endTime: '21:00' }, author, location);
    expect(note).toMatchObject({ startTime: '18:30', endTime: '21:00', expectedGuests: 70 });
    const stored = await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) });
    expect(stored).toMatchObject({ startTime: '18:30', endTime: '21:00' });

    const path = `${notesPath(location)}/${note.id}`;
    const res = await call(server, path, { method: 'PATCH', session: author.session, json: EVENT });
    expect(res.status).toBe(200);
    expect((await res.json() as { note: NoteView }).note).toMatchObject({ startTime: null, endTime: null });
    expect(await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) })).toMatchObject({ startTime: null, endTime: null });

    const older = new Types.ObjectId();
    const now = server.clock.now();
    await server.connection.collection('tw_notes').insertOne({
      _id: older, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(location), kind: 'closure', startDate: '2026-09-01',
      endDate: '2026-09-01', weekdays: null, effect: 'closed', expectedGuests: null, detail: null, createdBy: author.session.userId,
      createdAt: now, updatedAt: now,
    });
    const listed = await (await call(server, notesPath(location), { session: author.session })).json() as { notes: NoteView[] };
    expect(listed.notes.find((n) => n.id === older.toHexString())).toMatchObject({ startTime: null, endTime: null });

    const content = readNoteContent({ ...EVENT, startTime: '18:30', endTime: '21:00' }, '2026-06-01');
    expect(content).not.toBeNull();
    if (content === null) return;
    expect(sameNoteContent(content, content)).toBe(true);
    expect(sameNoteContent(content, { ...content, startTime: '18:00' })).toBe(false);
    expect(sameNoteContent(content, { ...content, endTime: '22:00' })).toBe(false);
  });

  it('holds the time rules: both or neither, HH:MM, start before end, none on a closure', async () => {
    const refused: Record<string, unknown>[] = [
      { startTime: '18:00' }, { endTime: '21:00' }, { startTime: '18:00', endTime: null },   // one without the other
      { startTime: '6:00', endTime: '21:00' }, { startTime: '18:00', endTime: '24:00' },     // not HH:MM
      { startTime: '18:60', endTime: '21:00' }, { startTime: '18:00:00', endTime: '21:00:00' },
      { startTime: 1800, endTime: 2100 }, { startTime: '', endTime: '' },
      { startTime: '21:00', endTime: '18:00' }, { startTime: '18:00', endTime: '18:00' },   // not start before end
      { kind: 'closure', effect: 'closed', expectedGuests: null, startTime: '09:00', endTime: '12:00' },  // a closure
    ];
    const before = await server.connection.collection('tw_notes').countDocuments({});
    for (const change of refused) {
      expect({ change, ...(await errorOf(await post({ ...EVENT, ...change }))) }).toEqual({ change, status: 400, error: 'invalid_request' });
    }
    expect(await server.connection.collection('tw_notes').countDocuments({})).toBe(before);

    const accepted: Record<string, unknown>[] = [
      { startTime: '00:00', endTime: '23:59' }, { startTime: '18:00', endTime: '18:01' }, { startTime: null, endTime: null },
      { effect: 'closed', startTime: '17:00', endTime: '23:00' },                              // a buyout's hours
      { kind: 'opening', effect: 'unknown', expectedGuests: null, startTime: '11:00', endTime: '14:00' },
    ];
    for (const change of accepted) expect({ change, status: (await post({ ...EVENT, ...change })).status }).toEqual({ change, status: 201 });
  });

  it('a buyout may carry expected guests; any other closed note may not', async () => {
    const buyout = await created({ ...EVENT, effect: 'closed', expectedGuests: 70 });
    expect(buyout).toMatchObject({ kind: 'private_event', effect: 'closed', expectedGuests: 70 });
    expect(await created({ ...EVENT, effect: 'closed', expectedGuests: null })).toMatchObject({ effect: 'closed', expectedGuests: null });

    const refused: Record<string, unknown>[] = [
      { kind: 'closure', effect: 'closed', expectedGuests: 70 },
      { kind: 'opening', effect: 'closed', expectedGuests: 70 },
      { kind: 'other', effect: 'closed', expectedGuests: 70, detail: 'Road closed for the parade' },
    ];
    for (const change of refused) {
      expect({ change, ...(await errorOf(await post({ ...EVENT, ...change }))) }).toEqual({ change, status: 400, error: 'invalid_request' });
    }
  });

  it('the audit event holds no time, guests or detail', async () => {
    const note = await created({ ...EVENT, startTime: '18:30', endTime: '21:15', expectedGuests: 73, detail: 'Sentinel anniversary party' });
    const path = `${notesPath()}/${note.id}`;
    const change = { ...EVENT, effect: 'closed', startTime: '17:45', endTime: '22:10', expectedGuests: 91, detail: 'Sentinel buyout' };
    expect((await call(server, path, { method: 'PATCH', session: author.session, json: change })).status).toBe(200);

    const events = (await auditEvents(server)).filter((e) => (e.target as { id: string }).id === note.id);
    expect(events.map((e) => e.action)).toEqual(['note.created', 'note.updated']);
    // The details are the whole free-form part of an event (the rest is ids, the actor and the time).
    for (const event of events) {
      expect(event.details).toEqual({ locationId, kind: 'private_event', startDate: '2026-08-21', endDate: '2026-08-21' });
    }
    expect(JSON.stringify(events)).not.toContain('Sentinel');
  });
});

// D49: a note's optional event name, one line of 1 to 120 code points, the person's own words.
describe('note titles', () => {
  const EVENT = {
    kind: 'private_event', startDate: '2026-08-21', endDate: '2026-08-21', weekdays: null, effect: 'closed', expectedGuests: 70, detail: null,
  };
  const stored = (id: string) => server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(id) });
  const patch = (id: string, json: unknown, who = author) => call(server, `${notesPath()}/${id}`, { method: 'PATCH', session: who.session, json });

  it('saves, reads and clears a title; an empty one is none, and runs of white space collapse', async () => {
    const note = await created({ ...EVENT, title: '  Holiday   party ' });
    expect(note.title).toBe('Holiday party');
    expect(await stored(note.id)).toMatchObject({ title: 'Holiday party' });
    const listed = await (await call(server, notesPath(), { session: author.session })).json() as { notes: NoteView[] };
    expect(listed.notes.find((n) => n.id === note.id)?.title).toBe('Holiday party');

    const cleared = await patch(note.id, { ...EVENT, title: null });
    expect((await cleared.json() as { note: NoteView }).note.title).toBeNull();
    expect(await stored(note.id)).toMatchObject({ title: null });
    expect((await created({ ...EVENT, title: '' })).title).toBeNull();
    expect((await created({ ...EVENT, title: '   ' })).title).toBeNull();
    expect((await created({ ...EVENT, title: 'Café night' })).title).toBe('Café night');   // NFC
  });

  it('refuses a control or format character, a newline included, and stores nothing', async () => {
    const before = await server.connection.collection('tw_notes').countDocuments({});
    for (const title of ['Holiday\nparty', 'Holiday\tparty', 'Holiday ‮ytrap', 'Zero​width', 'Bell\u0007', 'Holiday party\r\n']) {
      expect({ title, ...(await errorOf(await post({ ...EVENT, title }))) }).toEqual({ title, status: 400, error: 'invalid_request' });
    }
    expect(await server.connection.collection('tw_notes').countDocuments({})).toBe(before);
  });

  it('an edit with no title key keeps the stored title, and an older client may edit an other note that has only a title', async () => {
    const note = await created({ ...EVENT, title: 'Rehearsal dinner' });
    const kept = await patch(note.id, { ...EVENT, expectedGuests: 80 });
    expect(kept.status).toBe(200);
    expect((await kept.json() as { note: NoteView }).note).toMatchObject({ title: 'Rehearsal dinner', expectedGuests: 80 });
    expect(await stored(note.id)).toMatchObject({ title: 'Rehearsal dinner' });

    const other = await created({ kind: 'other', startDate: '2026-09-12', endDate: '2026-09-12', effect: 'unknown', title: 'Road race' });
    expect(other).toMatchObject({ kind: 'other', title: 'Road race', detail: null });
    const older = await patch(other.id, { kind: 'other', startDate: '2026-09-13', endDate: '2026-09-13', weekdays: null, effect: 'unknown', expectedGuests: null, detail: null });
    expect(older.status).toBe(200);
    expect((await older.json() as { note: NoteView }).note).toMatchObject({ title: 'Road race', startDate: '2026-09-13' });
    // Cleared on purpose, an other note with no detail is refused.
    expect(await errorOf(await patch(other.id, { kind: 'other', startDate: '2026-09-13', endDate: '2026-09-13', effect: 'unknown', title: null })))
      .toEqual({ status: 400, error: 'invalid_request' });
  });

  it('the title counts in sameNoteContent', () => {
    const content = readNoteContent({ ...EVENT, title: 'Holiday party' }, '2026-06-01');
    expect(content?.title).toBe('Holiday party');
    if (content === null) return;
    expect(sameNoteContent(content, { ...content, title: 'Holiday party' })).toBe(true);
    expect(sameNoteContent(content, { ...content, title: null })).toBe(false);
  });

  it('a sentinel title reaches no log line and no audit event', async () => {
    server.logs.length = 0;
    const note = await created({ ...EVENT, title: 'Sentinel gala' });
    expect((await patch(note.id, { ...EVENT, title: 'Sentinel gala two' })).status).toBe(200);
    expect((await call(server, notesPath(), { session: author.session })).status).toBe(200);
    expect((await call(server, `${notesPath()}/${note.id}`, { method: 'DELETE', session: author.session })).status).toBe(204);
    const events = (await auditEvents(server)).filter((e) => (e.target as { id: string }).id === note.id);
    expect(events.map((e) => e.action)).toEqual(['note.created', 'note.updated', 'note.deleted']);
    for (const event of events) {
      expect(event.details).toEqual({ locationId, kind: 'private_event', startDate: '2026-08-21', endDate: '2026-08-21' });
    }
    expect(JSON.stringify(events)).not.toContain('Sentinel');
    expect(server.logs.join('\n')).not.toContain('Sentinel');
  });
});

// D49: a note TownwiseAI made links to the Your data item of the file it was read from, while that item exists.
describe('a TownwiseAI note’s source ref', () => {
  const scope = (): OrgScope => ({ orgId }) as unknown as OrgScope;

  /** A tw_files row written straight in, as the reader leaves a stored file it finished. */
  async function seedFile(location: string, over: Record<string, unknown> = {}): Promise<string> {
    const _id = new Types.ObjectId();
    await server.connection.collection('tw_files').insertOne({
      _id, orgId: new Types.ObjectId(orgId), locationId: new Types.ObjectId(location), importId: null, purpose: 'reference',
      uploadedBy: author.session.userId, uploaderRole: 'member', uploadedAt: server.clock.now(), name: 'events.txt', kind: 'text',
      sizeBytes: 5, fingerprint: _id.toHexString().padStart(64, '0'), upload: null, status: 'kept', outcome: 'reference',
      progress: null, readStartedAt: null, readMs: null, answers: {}, uploadId: null, result: null, report: null, cleanBytes: null,
      rawDeletedAt: null, attempts: 0, ...over,
    });
    return _id.toHexString();
  }

  async function aiNote(location: string, fileId: string): Promise<string> {
    const content = readNoteContent({ ...NOTE, detail: 'From a file' }, '2026-06-01');
    if (content === null) throw new Error('fixture');
    const note = await createNoteStore(server.connection).create(scope(), location, content, {
      createdBy: author.session.userId, now: server.clock.now(), source: { via: 'ai_file', fileId },
    });
    return note.id;
  }

  async function sourceOf(on: TownwiseTestServer, location: string, noteId: string): Promise<NoteView['source'] | undefined> {
    // A session is the server's own: sign in on it.
    const session = on === server ? author.session : await signIn(on, author.email);
    const res = await call(on, notesPath(location), { session });
    return (await res.json() as { notes: NoteView[] }).notes.find((note) => note.id === noteId)?.source;
  }

  it('is f_ for a stored file, u_ for a file that wrote days, and null once it is gone, being deleted, or files are off', async () => {
    const location = await addLocation(server, { orgId, name: 'Source Room' });
    const stored = await seedFile(location);
    const uploadId = new Types.ObjectId().toHexString();
    const wroteDays = await seedFile(location, { purpose: 'sales', uploadId: new Types.ObjectId(uploadId) });
    const deleting = await seedFile(location, { status: 'deleting' });
    const gone = new Types.ObjectId().toHexString();
    const [a, b, c, d] = [await aiNote(location, stored), await aiNote(location, wroteDays), await aiNote(location, deleting), await aiNote(location, gone)];

    expect(await sourceOf(withFiles, location, a)).toEqual({ via: 'ai_file', fileId: stored, ref: `f_${stored}` });
    expect(await sourceOf(withFiles, location, b)).toEqual({ via: 'ai_file', fileId: wroteDays, ref: `u_${uploadId}` });
    expect(await sourceOf(withFiles, location, c)).toEqual({ via: 'ai_file', fileId: deleting, ref: null });
    expect(await sourceOf(withFiles, location, d)).toEqual({ via: 'ai_file', fileId: gone, ref: null });
    for (const id of [a, b]) expect((await sourceOf(server, location, id))?.ref).toBeNull();

    // An edit's answer carries it too; a note the person typed has none.
    const edited = await call(withFiles, `${notesPath(location)}/${a}`, { method: 'PATCH', session: await signIn(withFiles, author.email), json: NOTE });
    expect((await edited.json() as { note: NoteView }).note.source).toEqual({ via: 'ai_file', fileId: stored, ref: `f_${stored}` });
    expect((await created(NOTE, author, location)).source).toBeNull();
  });
});

describe('NoteStore.overlapping', () => {
  it('overlapping returns this location’s notes that touch the range, never another’s', async () => {
    const store = createNoteStore(server.connection);
    const scope = { orgId } as unknown as OrgScope;
    const location = await addLocation(server, { orgId, name: 'Overlap Room' });
    const other = await addLocation(server, { orgId, name: 'Overlap Patio' });
    const otherOrg = await createOrg(server, { name: 'Other Overlap Tavern' });
    const make = async (where: string, startDate: string, endDate: string): Promise<string> => {
      server.clock.advance(1000);
      return (await created({ ...NOTE, startDate, endDate }, author, where)).id;
    };

    await make(location, '2026-10-01', '2026-10-31');                // ends the day before the range
    const touchesStart = await make(location, '2026-10-15', '2026-11-01');
    const spans = await make(location, '2026-10-20', '2026-12-10');
    const inside = await make(location, '2026-11-12', '2026-11-12');
    const insideLater = await make(location, '2026-11-12', '2026-11-13');
    const touchesEnd = await make(location, '2026-11-30', '2026-12-05');
    await make(location, '2026-12-01', '2026-12-02');                // starts the day after the range
    await make(other, '2026-11-12', '2026-11-12');                    // another location
    const now = server.clock.now();
    await server.connection.collection('tw_notes').insertOne({        // another organization, the same location id
      orgId: new Types.ObjectId(otherOrg), locationId: new Types.ObjectId(location), kind: 'closure', startDate: '2026-11-12',
      endDate: '2026-11-12', weekdays: null, effect: 'closed', expectedGuests: null, detail: null, createdBy: 'fixture',
      createdAt: now, updatedAt: now,
    });

    const found = await store.overlapping(scope, location, { from: '2026-11-01', to: '2026-11-30' });
    expect(found.map((note) => note.id)).toEqual([touchesStart, spans, inside, insideLater, touchesEnd]);
    expect(found.every((note) => note.startTime === null && note.endTime === null)).toBe(true);
    expect(await store.overlapping(scope, location, { from: '2027-01-01', to: '2027-01-31' })).toEqual([]);
    expect(await store.overlapping({ orgId: otherOrg } as unknown as OrgScope, other, { from: '2026-11-01', to: '2026-11-30' })).toEqual([]);
  });
});

describe('a note made from an owner-calendar event (calendar-event-suggestions)', () => {
  const PARTY = 'party-0001@bookings.example.test';
  const scopeOf = (id: string): OrgScope => ({ orgId: id }) as unknown as OrgScope;
  const ownerEvent = (uid: string, keyed = true): IcsEvent => ({
    uid, title: 'Sentinel Pemberton party', startDate: '2026-08-14', endDate: '2026-08-14', startTime: '18:00', endTime: '22:00', keyed,
  });
  const PARTY_NOTE = {
    kind: 'private_event', startDate: '2026-08-14', endDate: '2026-08-14', effect: 'closed', expectedGuests: 40, startTime: '18:00',
    endTime: '22:00', detail: 'Buyout upstairs',
  };

  async function calendarWith(events: IcsEvent[], where = locationId, org = orgId): Promise<string> {
    const added = await createOwnerCalendarStore(server.connection).add(scopeOf(org), where, { kind: 'file', label: 'Bookings' },
      { events, skippedRepeating: 0 }, { createdBy: 'fixture', now: server.clock.now() });
    if (added === 'calendar_limit') throw new Error('calendar_limit');
    return added.id;
  }

  it('links a note to a keyed event of this location, with the stored event’s dates and hours, and an edit keeps the link', async () => {
    server.logs.length = 0;
    const calendarId = await calendarWith([ownerEvent(PARTY)]);
    // The note's own dates may differ; the link holds the event's as stored.
    const note = await created({ ...PARTY_NOTE, startDate: '2026-08-15', endDate: '2026-08-15', fromEvent: { calendarId, uid: PARTY } });
    const linkedAt = server.clock.now().toISOString();
    const link = { calendarId, uid: PARTY, startDate: '2026-08-14', endDate: '2026-08-14', startTime: '18:00', endTime: '22:00', linkedAt };
    expect(note).toMatchObject({ startDate: '2026-08-15', detail: 'Buyout upstairs', fromEvent: link });
    const stored = await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) });
    expect(stored?.fromEvent).toEqual({ ...link, calendarId: new Types.ObjectId(calendarId), linkedAt: new Date(linkedAt) });
    // No title is stored, and the uid is in no log line or audit event.
    expect(JSON.stringify(stored)).not.toContain('Sentinel');
    expect(server.logs.join('\n')).not.toContain(PARTY);
    expect(JSON.stringify(await auditEvents(server))).not.toContain(PARTY);

    server.clock.advance(1000);
    const res = await call(server, `${notesPath()}/${note.id}`, { session: author.session, method: 'PATCH', json: { ...PARTY_NOTE, expectedGuests: 45 } });
    expect(res.status).toBe(200);
    expect((await res.json() as { note: NoteView }).note).toMatchObject({ expectedGuests: 45, fromEvent: link });
  });

  it('saves the note unlinked when the event is gone, unkeyed, or another location’s or organization’s', async () => {
    const calendarId = await calendarWith([ownerEvent(PARTY), ownerEvent('event-2', false)]);
    const patioCalendar = await calendarWith([ownerEvent(PARTY)], otherLocationId);
    const otherOrg = await createOrg(server, { name: 'Other Link Tavern' });
    const otherOrgCalendar = await calendarWith([ownerEvent(PARTY)], await addLocation(server, { orgId: otherOrg, name: 'Elsewhere' }), otherOrg);
    const cases = [
      { calendarId, uid: 'gone@bookings.example.test' },
      { calendarId, uid: 'event-2' },
      { calendarId: patioCalendar, uid: PARTY },
      { calendarId: otherOrgCalendar, uid: PARTY },
      { calendarId: new Types.ObjectId().toHexString(), uid: PARTY },
    ];
    for (const fromEvent of cases) {
      const note = await created({ ...PARTY_NOTE, fromEvent });
      expect(note.fromEvent).toBeNull();
      const stored = await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) });
      expect(stored).not.toHaveProperty('fromEvent');
    }
  });

  it('refuses a malformed link: extra keys (the request’s dates), a uid over 1,024 characters, an empty uid, a bad id', async () => {
    const calendarId = await calendarWith([ownerEvent(PARTY)]);
    for (const fromEvent of [
      { calendarId, uid: PARTY, startDate: '2026-08-21' },
      { calendarId, uid: 'u'.repeat(1_025) },
      { calendarId, uid: '' },
      { calendarId: 'not-an-id', uid: PARTY },
    ]) {
      expect(await errorOf(await post({ ...PARTY_NOTE, fromEvent }))).toEqual({ status: 400, error: 'invalid_request' });
    }
    // A uid of exactly 1,024 characters is read (and, absent here, leaves the note unlinked).
    expect((await created({ ...PARTY_NOTE, fromEvent: { calendarId, uid: 'u'.repeat(1_024) } })).fromEvent).toBeNull();
  });

  it('linkedTo answers this location’s notes linked to the calendar; moveIf and removeIf refuse a changed updatedAt', async () => {
    const store = createNoteStore(server.connection);
    const scope = scopeOf(orgId);
    const calendarId = await calendarWith([ownerEvent(PARTY), ownerEvent('lunch@bookings.example.test')]);
    const other = await calendarWith([ownerEvent(PARTY)]);
    server.clock.advance(1000);
    const linked = await created({ ...PARTY_NOTE, fromEvent: { calendarId, uid: PARTY } });
    const second = await created({ ...PARTY_NOTE, detail: null, fromEvent: { calendarId, uid: 'lunch@bookings.example.test' } });
    await created({ ...PARTY_NOTE, fromEvent: { calendarId: other, uid: PARTY } });
    await created(PARTY_NOTE);
    expect((await store.linkedTo(scope, locationId, calendarId)).map((note) => note.id).sort()).toEqual([linked.id, second.id].sort());
    expect(await store.linkedTo(scope, otherLocationId, calendarId)).toEqual([]);

    const dates = { startDate: '2026-08-21', endDate: '2026-08-21', startTime: '19:00', endTime: '23:00' };
    const before = await store.find(scope, locationId, linked.id);
    if (before === null) throw new Error('no note');
    const now = new Date(server.clock.now().getTime() + 5000);
    // A stale updatedAt changes nothing.
    expect(await store.moveIf(scope, locationId, linked.id, { updatedAt: new Date(before.updatedAt.getTime() - 1), dates, link: dates, now })).toBeNull();
    expect(await store.find(scope, locationId, linked.id)).toEqual(before);
    // Another location's path finds nothing.
    expect(await store.moveIf(scope, otherLocationId, linked.id, { updatedAt: before.updatedAt, dates, link: dates, now })).toBeNull();

    const moved = await store.moveIf(scope, locationId, linked.id, { updatedAt: before.updatedAt, dates, link: dates, now });
    expect(moved).toEqual({
      ...before, ...dates, updatedAt: now,
      fromEvent: { ...before.fromEvent, ...dates },
    });
    // Kind, guests, detail and weekdays are as they were.
    expect(moved).toMatchObject({ kind: 'private_event', effect: 'closed', expectedGuests: 40, detail: 'Buyout upstairs', weekdays: null });

    expect(await store.removeIf(scope, locationId, linked.id, before.updatedAt)).toBe(false);
    expect(await store.removeIf(scope, otherLocationId, linked.id, now)).toBe(false);
    expect(await store.find(scope, locationId, linked.id)).not.toBeNull();
    expect(await store.removeIf(scope, locationId, linked.id, now)).toBe(true);
    expect(await store.find(scope, locationId, linked.id)).toBeNull();
  });
});

describe('a note marking past days’ guest counts wrong (D67)', () => {
  // The test clock reads 2026-06-01, in Hanover too: 12:00 UTC is 08:00 there.
  const MARK = {
    kind: 'other', startDate: '2025-10-31', endDate: '2025-11-01', weekdays: null, effect: 'wrong_guest_count', expectedGuests: null,
  };

  async function wantedAt(location: string): Promise<Date | undefined> {
    const doc = await server.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(location) });
    return (doc?.refit as { wantedAt?: Date } | undefined)?.wantedAt;
  }

  it('a member marks Halloween weekend with no title or detail; it is stored, listed, and wants a refit', async () => {
    const location = await addLocation(server, { orgId, name: 'Marked Room' });
    await addSalesDay(server, { orgId, locationId: location, date: '2025-11-02', guests: 90, netSalesCents: 180_000 });
    const note = await created(MARK, author, location);
    expect(note).toMatchObject({ ...MARK, detail: null, title: null, startTime: null, endTime: null, fromEvent: null });
    const stored = await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) });
    expect(stored?.effect).toBe('wrong_guest_count');
    const listed = await call(server, notesPath(location), { session: colleague.session });
    expect((await listed.json() as { notes: NoteView[] }).notes.map((each) => [each.id, each.effect])).toEqual([[note.id, 'wrong_guest_count']]);
    expect(await wantedAt(location)).toEqual(server.clock.now());
    const event = (await auditEvents(server)).find((e) => (e.target as { id: string }).id === note.id);
    expect(event?.details).toEqual({ locationId: location, kind: 'other', startDate: '2025-10-31', endDate: '2025-11-01' });
  });

  it('takes weekdays, and days up to yesterday in the town', async () => {
    expect((await created({ ...MARK, startDate: '2026-05-01', endDate: '2026-05-29', weekdays: [5] })).weekdays).toEqual([5]);
    expect((await created({ ...MARK, startDate: '2026-05-31', endDate: '2026-05-31' })).endDate).toBe('2026-05-31');
  });

  it('refuses today, a later day, guests, hours, and any kind but Other, and stores nothing', async () => {
    const location = await addLocation(server, { orgId, name: 'Refused Mark Room' });
    for (const bad of [
      { ...MARK, startDate: '2026-06-01', endDate: '2026-06-01' },
      { ...MARK, endDate: '2026-06-01' },
      { ...MARK, startDate: '2026-06-02', endDate: '2026-06-02' },
      { ...MARK, expectedGuests: 120 },
      { ...MARK, startTime: '18:00', endTime: '22:00' },
      { ...MARK, kind: 'private_event' },
      { ...MARK, kind: 'closure' },
      { ...MARK, kind: 'opening' },
    ]) {
      expect({ bad, ...(await errorOf(await post(bad, author, location))) }).toEqual({ bad, status: 400, error: 'invalid_request' });
    }
    expect(await server.connection.collection('tw_notes').countDocuments({ locationId: new Types.ObjectId(location) })).toBe(0);
  });

  it('reads the town’s date: at 21:00 in Hanover, already tomorrow in UTC, today is still refused', async () => {
    const hours = 13 * 60 * 60 * 1000;
    server.clock.advance(hours); // 2026-06-02T01:00Z, 2026-06-01 21:00 in Hanover
    try {
      const late = await person('late', 'member'); // signed in after the clock moved
      expect(await errorOf(await post({ ...MARK, startDate: '2026-06-01', endDate: '2026-06-01' }, late)))
        .toEqual({ status: 400, error: 'invalid_request' });
      expect((await post({ ...MARK, startDate: '2026-05-31', endDate: '2026-05-31' }, late)).status).toBe(201);
    } finally {
      server.clock.advance(-hours);
    }
  });

  it('the author and an org admin edit it, another member is 403; an edit into the mark on a later day is refused', async () => {
    const note = await created(MARK);
    const path = `${notesPath()}/${note.id}`;
    expect((await call(server, path, { session: colleague.session, method: 'PATCH', json: { ...MARK, endDate: '2025-10-31' } })).status).toBe(403);
    const edited = await call(server, path, { session: author.session, method: 'PATCH', json: { ...MARK, endDate: '2025-10-31' } });
    expect((await edited.json() as { note: NoteView }).note).toMatchObject({ endDate: '2025-10-31', effect: 'wrong_guest_count' });
    expect((await call(server, path, { session: admin.session, method: 'PATCH', json: { ...MARK, weekdays: [5] } })).status).toBe(200);
    expect(await errorOf(await call(server, path, { session: author.session, method: 'PATCH', json: { ...MARK, endDate: '2026-06-03' } })))
      .toEqual({ status: 400, error: 'invalid_request' });
    const other = await created({ kind: 'other', startDate: '2026-07-01', endDate: '2026-07-01', effect: 'unknown', detail: 'Patio work' });
    expect(await errorOf(await call(server, `${notesPath()}/${other.id}`, { session: author.session, method: 'PATCH', json: { ...MARK, startDate: '2026-07-01', endDate: '2026-07-01' } })))
      .toEqual({ status: 400, error: 'invalid_request' });
    expect((await call(server, path, { session: admin.session, method: 'DELETE' })).status).toBe(204);
  });

  it('saves a mark made from a past calendar event unlinked', async () => {
    const location = await addLocation(server, { orgId, name: 'Linked Mark Room' });
    const added = await createOwnerCalendarStore(server.connection).add({ orgId } as unknown as OrgScope, location, { kind: 'file', label: 'Past' }, {
      events: [{ uid: 'halloween@bookings.example.test', title: 'Costume night', startDate: '2025-10-31', endDate: '2025-10-31', startTime: null, endTime: null, keyed: true }],
      skippedRepeating: 0,
    }, { createdBy: 'fixture', now: server.clock.now() });
    if (added === 'calendar_limit') throw new Error('calendar_limit');
    const note = await created({ ...MARK, endDate: '2025-10-31', fromEvent: { calendarId: added.id, uid: 'halloween@bookings.example.test' } }, author, location);
    expect(note.fromEvent).toBeNull();
    const stored = await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) });
    expect(stored).not.toHaveProperty('fromEvent');
  });

  it('drops the link when a note made from a past calendar event is edited into a mark; an edit that stays keeps it', async () => {
    const location = await addLocation(server, { orgId, name: 'Edited Mark Room' });
    const added = await createOwnerCalendarStore(server.connection).add({ orgId } as unknown as OrgScope, location, { kind: 'file', label: 'Past' }, {
      events: [{ uid: 'fall-fest@bookings.example.test', title: 'Fall fest', startDate: '2025-10-31', endDate: '2025-10-31', startTime: null, endTime: null, keyed: true }],
      skippedRepeating: 0,
    }, { createdBy: 'fixture', now: server.clock.now() });
    if (added === 'calendar_limit') throw new Error('calendar_limit');
    const plain = { kind: 'other', startDate: '2025-10-31', endDate: '2025-10-31', effect: 'unknown', detail: 'Synthetic detail' };
    const note = await created({ ...plain, fromEvent: { calendarId: added.id, uid: 'fall-fest@bookings.example.test' } }, author, location);
    expect(note.fromEvent).not.toBeNull();
    const path = `${notesPath(location)}/${note.id}`;
    const kept = await call(server, path, { session: author.session, method: 'PATCH', json: { ...plain, detail: 'Other synthetic detail' } });
    expect((await kept.json() as { note: NoteView }).note.fromEvent).not.toBeNull();
    const marked = await call(server, path, { session: author.session, method: 'PATCH', json: { ...MARK, endDate: '2025-10-31' } });
    expect((await marked.json() as { note: NoteView }).note).toMatchObject({ effect: 'wrong_guest_count', fromEvent: null });
    const stored = await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) });
    expect(stored).not.toHaveProperty('fromEvent');
  });

  it('readNoteContent refuses the mark without the town’s date, so TownwiseAI can never save one', () => {
    expect(readNoteContent(MARK, '2026-06-01')).toBeNull();
    expect(readNoteContent(MARK, '2026-06-01', { townToday: '2026-06-01' })).toMatchObject({ effect: 'wrong_guest_count', detail: null, title: null });
  });
});
