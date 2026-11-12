// Notes, the tuning step (spec 10.5, 12, P14): range, weekday, effect and kind rules; author-or-admin edits;
// notes reachable only through their own location; the 1,000 cap; detail never in logs or audit events.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { NoteView } from '../src/handlers/notes.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
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
      expectedGuests: 180, detail, createdByEmail: author.email, createdAt: server.clock.now().toISOString(),
      updatedAt: server.clock.now().toISOString(), canEdit: true, source: null,
    });
    const stored = await server.connection.collection('tw_notes').findOne({ _id: new Types.ObjectId(note.id) });
    expect(Object.keys(stored ?? {}).sort()).toEqual([
      '_id', 'createdAt', 'createdBy', 'detail', 'effect', 'endDate', 'expectedGuests', 'kind', 'locationId', 'orgId', 'startDate',
      'updatedAt', 'weekdays',
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
