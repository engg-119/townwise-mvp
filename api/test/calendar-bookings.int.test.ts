// A file calendar's booking labels over HTTP (src/handlers/calendar-bookings.ts, openspec change
// learn-from-calendar-bookings, D58, design decisions 7, 8, 10, 11 and 15): Sort with TownwiseAI over a scripted model,
// a person's label, Use for forecasts and the notes it makes for upcoming bookings, the refit it starts, who may do
// each, and what the audit events and requests hold. The test clock starts at 2026-06-01T12:00Z, Hanover's 2026-06-01.
// Every title, name and number here is made up.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg } from '../src/access/policy.ts';
import type { OwnerCalendarView } from '../src/handlers/owner-calendars.ts';
import { addChatUsage, addGrant, addLocation, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { message, scriptedModel, text, type ScriptedModel } from './helpers/chat-model.ts';
import { fakeLabRunner, seedHistory, type FakeLabRunner } from './helpers/lab.ts';
import { call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const SENTINEL_LABEL = 'Sentinel master calendar';
/** Two past events, three upcoming; private columns that are never kept. */
const EXPORT = [
  'calendar_id,event_id,title,description,start_at,end_at,status,organizer_email',
  'made-up@group.example.test,p1,Summer reunion,Sentinel-description,2025-07-12T18:00:00-04:00,2025-07-12T22:00:00-04:00,confirmed,host@example.test',
  'made-up@group.example.test,p2,Trivia night,,2025-07-15T19:00:00-04:00,2025-07-15T21:00:00-04:00,confirmed,',
  'made-up@group.example.test,u3,Staff meeting,,2026-06-10T09:00:00-04:00,2026-06-10T10:00:00-04:00,confirmed,',
  'made-up@group.example.test,u1,Smith wedding,,2026-06-20T00:00:00,2026-06-21T00:00:00,confirmed,',
  'made-up@group.example.test,u2,"Birthday party, call 603-555-0142",,2026-06-27T18:00:00-04:00,2026-06-27T22:00:00-04:00,confirmed,',
].join('\r\n');

let server: TownwiseTestServer;
let model: ScriptedModel;
let runner: FakeLabRunner;

interface Tenant { orgId: string; locationId: string; member: TestSession; admin: TestSession }

async function tenant(): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Bookings Grill ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  const seat = async (role: 'member' | 'org_admin'): Promise<TestSession> => {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId, userId: session.userId, email, role });
    return session;
  };
  return { orgId, locationId, member: await seat('member'), admin: await seat('org_admin') };
}

async function send(path: string, session: TestSession, init: { method?: string; json?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call(server, path, { session, ...init });
  const body = await res.text();
  return { status: res.status, body: body === '' ? {} : JSON.parse(body) as Record<string, unknown> };
}

function base(t: Pick<Tenant, 'locationId'>): string {
  return `/api/org/locations/${t.locationId}/owner-calendars`;
}

async function addExport(t: Tenant): Promise<OwnerCalendarView> {
  const added = await send(base(t), t.member, { json: { kind: 'file', label: SENTINEL_LABEL, ics: EXPORT } });
  expect(added.status).toBe(201);
  return added.body.calendar as OwnerCalendarView;
}

function sort(t: Tenant, calendarId: string, session = t.admin) {
  return send(`${base(t)}/${calendarId}/bookings/sort`, session, { method: 'POST' });
}

function label(t: Tenant, calendarId: string, uid: string, booking: string | null, session = t.admin, query = '') {
  return send(`${base(t)}/${calendarId}/bookings${query}`, session, { method: 'PATCH', json: { uid, booking } });
}

function confirm(t: Tenant, calendarId: string, session = t.admin) {
  return send(`${base(t)}/${calendarId}/bookings/confirm`, session, { method: 'POST' });
}

async function labels(t: Tenant, calendarId: string): Promise<Record<string, [string | null, string | null]>> {
  const rows = await server.connection.collection('tw_calendar_events').find({ sourceId: new Types.ObjectId(calendarId) }).toArray();
  return Object.fromEntries(rows.map((row) => [row.uid as string, [(row.booking as string | undefined) ?? null, (row.bookingBy as string | undefined) ?? null]]));
}

function notesOf(t: Tenant) {
  return server.connection.collection('tw_notes').find({ locationId: new Types.ObjectId(t.locationId) }).sort({ startDate: 1 }).toArray();
}

/** The scripted answer for a batch: labels by ref. */
function answer(byRef: Record<string, string>) {
  const labels = Object.entries(byRef).map(([ref, booking]) => ({ ref, booking }));
  return { kind: 'message' as const, message: message([text(JSON.stringify({ labels }))], { usage: { input: 2_000, output: 300 } }) };
}

beforeAll(async () => {
  model = scriptedModel();
  runner = fakeLabRunner();
  server = await startTownwiseServer({ chat: model, labRunner: runner });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => { await server.redis.flushdb(); });

describe('Sort with TownwiseAI', () => {
  it('sends the unlabeled events by ref with phones removed, keeps the checked labels as the AI’s, and charges the month', async () => {
    const t = await tenant();
    const calendar = await addExport(t);
    // A person's label first: it is never sent, and the sort never overwrites it.
    expect((await label(t, calendar.id, 'p2', 'other')).status).toBe(200);
    const calls = model.calls.length;
    model.script(answer({ e1: 'party', e2: 'other', e3: 'buyout', e4: 'party', e9: 'buyout' }));
    const sorted = await sort(t, calendar.id);
    expect(sorted.status).toBe(200);
    expect(sorted.body).toMatchObject({ sent: 4, labeled: 4, batchesFailed: 0 });
    expect((sorted.body.calendar as OwnerCalendarView).bookings).toMatchObject({
      state: 'sorted', counts: { buyout: 1, party: 2, own_event: 0, other: 2, unlabeled: 0 },
    });
    expect(model.calls).toHaveLength(calls + 1);
    const wire = JSON.stringify(model.calls.at(-1)?.params);
    expect(wire).toContain('Birthday party, call [removed]');
    for (const sentinel of ['603-555', SENTINEL_LABEL, calendar.id, '"u1"', 'Sentinel-description', 'host@example.test', 'made-up@group', 'Trivia night']) {
      expect(wire).not.toContain(sentinel);
    }
    expect(await labels(t, calendar.id)).toEqual({
      p1: ['party', 'ai'], p2: ['other', 'person'], u3: ['other', 'ai'], u1: ['buyout', 'ai'], u2: ['party', 'ai'],
    });
    const usage = await server.connection.collection('tw_chat_usage').findOne({ orgId: new Types.ObjectId(t.orgId) });
    expect(usage?.costMicroUsd).toBeGreaterThan(0);
    expect(usage?.costMicroUsd).toBeLessThan(200_000);
    const event = (await auditEvents(server)).filter((each) => each.action === 'owner_calendar.bookings_sorted').at(-1);
    expect(event?.details).toEqual({ locationId: t.locationId, calendarId: calendar.id, sent: 4, labeled: 4 });
    // Nothing is shown changed in the lab input or the notes until confirmed.
    expect(await notesOf(t)).toEqual([]);

    // Again: nothing is left unlabeled, so no call is made.
    expect(await sort(t, calendar.id)).toMatchObject({ status: 200, body: { sent: 0, labeled: 0 } });
    expect(model.calls).toHaveLength(calls + 1);
    // The calendar's 3 sorts an hour (the person's label spent none).
    expect(await sort(t, calendar.id)).toMatchObject({ status: 200 });
    expect(await sort(t, calendar.id)).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
  });

  it('answers 409 chat_budget_exhausted before any call when the month can’t cover it, and leaves a failed batch unlabeled', async () => {
    const t = await tenant();
    const calendar = await addExport(t);
    await addChatUsage(server, { orgId: t.orgId, month: server.clock.now().toISOString().slice(0, 7), costMicroUsd: 19_900_000 });
    const calls = model.calls.length;
    expect(await sort(t, calendar.id)).toMatchObject({ status: 409, body: { error: 'chat_budget_exhausted' } });
    expect(model.calls).toHaveLength(calls);
    await server.connection.collection('tw_chat_usage').deleteMany({ orgId: new Types.ObjectId(t.orgId) });
    model.script({ kind: 'message', message: message([text('')], { stopReason: 'refusal' }) });
    expect(await sort(t, calendar.id)).toMatchObject({ status: 200, body: { sent: 5, labeled: 0, batchesFailed: 1 } });
    expect(Object.values(await labels(t, calendar.id)).every(([booking]) => booking === null)).toBe(true);
  });

  it('is an org admin’s only: a member, staff viewing as the admin and staff open as admin are refused, and nothing is sent', async () => {
    const t = await tenant();
    const calendar = await addExport(t);
    const calls = model.calls.length;
    expect(await sort(t, calendar.id, t.member)).toMatchObject({ status: 403 });
    const viewer = await signInStaff(server);
    await addGrant(server, { actorUserId: viewer.userId, sessionId: viewer.sessionId, targetUserId: t.admin.userId, orgId: t.orgId });
    expect(await sort(t, calendar.id, viewer)).toMatchObject({ status: 403, body: { error: 'view_as_read_only' } });
    expect(await confirm(t, calendar.id, viewer)).toMatchObject({ status: 403, body: { error: 'view_as_read_only' } });
    expect(await label(t, calendar.id, 'u1', 'party', viewer)).toMatchObject({ status: 403, body: { error: 'view_as_read_only' } });
    await removeStaffFactor(server);
    const staff = await signInStaff(server);
    await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: t.orgId });
    expect(await sort(t, calendar.id, staff)).toMatchObject({ status: 403, body: { error: 'open_as_admin_refused' } });
    expect(model.calls).toHaveLength(calls);
    // Staff open as admin may label and confirm.
    expect(await label(t, calendar.id, 'p1', 'party', staff)).toMatchObject({ status: 200 });
    expect(await confirm(t, calendar.id, staff)).toMatchObject({ status: 200 });
    await removeStaffFactor(server);
  });
});

describe('labels and Use for forecasts', () => {
  it('confirms, notes each upcoming buyout and party once, starts a refit as the admin, and audits counts only', async () => {
    const t = await tenant();
    await seedHistory(server, { orgId: t.orgId, locationId: t.locationId, from: '2024-09-01', to: '2026-05-31' });
    const calendar = await addExport(t);
    // A member sees the labels but can't set one, and a uid in the query is never read.
    expect(await label(t, calendar.id, 'u1', 'buyout', t.member)).toMatchObject({ status: 403 });
    expect(await label(t, calendar.id, 'p1', 'party', t.admin, '?uid=u1')).toMatchObject({ status: 200, body: { noteMade: false, noteKept: false } });
    expect(await labels(t, calendar.id)).toMatchObject({ p1: ['party', 'person'], u1: [null, null] });
    for (const [uid, booking] of [['u1', 'buyout'], ['u2', 'party'], ['u3', 'other']] as const) {
      expect((await label(t, calendar.id, uid, booking)).status).toBe(200);
    }
    expect(await label(t, calendar.id, 'nope', 'party')).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await label(t, calendar.id, 'u1', 'closed')).toMatchObject({ status: 400 });
    expect(await notesOf(t)).toEqual([]);

    const jobs = runner.jobs.length;
    const confirmed = await confirm(t, calendar.id);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ notesMade: 2, notesLeft: 0, calibration: { status: 'started' } });
    expect((confirmed.body.calendar as OwnerCalendarView).bookings).toMatchObject({ state: 'confirmed' });
    expect(runner.jobs).toHaveLength(jobs + 1);
    const notes = await notesOf(t);
    expect(notes.map((note): unknown[] => [note.kind, note.startDate, note.endDate, note.effect, note.expectedGuests, note.detail, note.title ?? null,
      note.startTime ?? null, note.endTime ?? null, (note.fromEvent as { uid: string }).uid])).toEqual([
      ['private_event', '2026-06-20', '2026-06-20', 'closed', null, null, null, null, null, 'u1'],
      ['private_event', '2026-06-27', '2026-06-27', 'more_guests', null, null, null, '18:00', '22:00', 'u2'],
    ]);
    const event = (await auditEvents(server)).filter((each) => each.action === 'owner_calendar.bookings_confirmed').at(-1);
    expect(event?.details).toEqual({ locationId: t.locationId, calendarId: calendar.id, buyouts: 1, parties: 2, notes: 2 });
    expect(JSON.stringify(await auditEvents(server))).not.toContain('Smith');
    const calibration = await server.connection.collection('tw_calibrations').findOne({ _id: new Types.ObjectId((confirmed.body.calibration as { id: string }).id) });
    expect(calibration).toMatchObject({ requestedBy: { userId: t.admin.userId, role: 'org_admin', via: 'file' } });

    // A second press makes no second note and starts no second refit.
    expect(await confirm(t, calendar.id)).toMatchObject({ status: 200, body: { notesMade: 0, notesLeft: 0, calibration: null } });
    expect(await notesOf(t)).toHaveLength(2);
    expect(runner.jobs).toHaveLength(jobs + 1);

    // After confirming, a label set to party on an upcoming event makes its note, and one moved off keeps it.
    expect(await label(t, calendar.id, 'u3', 'party')).toMatchObject({ status: 200, body: { noteMade: true, noteKept: false } });
    expect(await label(t, calendar.id, 'u1', 'other')).toMatchObject({ status: 200, body: { noteMade: false, noteKept: true } });
    expect((await notesOf(t)).map((note) => (note.fromEvent as { uid: string }).uid)).toEqual(['u3', 'u1', 'u2']);
    // A past event's label changes no note.
    expect(await label(t, calendar.id, 'p2', 'buyout')).toMatchObject({ status: 200, body: { noteMade: false, noteKept: false } });
    expect(await notesOf(t)).toHaveLength(3);
  });

  it('a sort that labels a confirmed calendar sends it back to sorted, so its new labels train nothing until confirmed again', async () => {
    const t = await tenant();
    const calendar = await addExport(t);
    await label(t, calendar.id, 'p1', 'party');
    expect(await confirm(t, calendar.id)).toMatchObject({ status: 200 });
    model.script(answer({ e1: 'buyout', e2: 'other', e3: 'party', e4: 'party' }));
    const sorted = await sort(t, calendar.id);
    expect(sorted).toMatchObject({ status: 200, body: { sent: 4, labeled: 4 } });
    expect((sorted.body.calendar as OwnerCalendarView).bookings).toMatchObject({ state: 'sorted' });
    const scope = scopeForNewOrg(STAFF, t.orgId);
    expect(await server.ctx.stores.ownerCalendars.bookingsBetween(scope, t.locationId, { from: '2025-01-01', to: '2027-12-31' })).toEqual([]);
    expect(await notesOf(t)).toEqual([]);
    // Confirming again uses them and notes the upcoming bookings.
    expect(await confirm(t, calendar.id)).toMatchObject({ status: 200, body: { notesMade: 2 } });
    expect(await server.ctx.stores.ownerCalendars.bookingsBetween(scope, t.locationId, { from: '2025-01-01', to: '2027-12-31' })).toHaveLength(4);
  });

  it('skips an upcoming booking a private-event or closure note already covers', async () => {
    const t = await tenant();
    const calendar = await addExport(t);
    const covering = await send(`/api/org/locations/${t.locationId}/notes`, t.admin, {
      json: { kind: 'private_event', startDate: '2026-06-27', endDate: '2026-06-27', weekdays: null, effect: 'more_guests', expectedGuests: 30, detail: null },
    });
    expect(covering.status).toBe(201);
    for (const [uid, booking] of [['u1', 'buyout'], ['u2', 'party']] as const) await label(t, calendar.id, uid, booking);
    expect(await confirm(t, calendar.id)).toMatchObject({ status: 200, body: { notesMade: 1, notesLeft: 0 } });
    expect((await notesOf(t)).map((note) => (note.fromEvent as { uid: string } | undefined)?.uid ?? null)).toEqual(['u1', null]);
  });

  it('answers 409 not_a_file_calendar for a link, and 404 for another organization’s calendar', async () => {
    const t = await tenant();
    const other = await tenant();
    const calendar = await addExport(t);
    const linkId = new Types.ObjectId();
    await server.connection.collection('tw_calendar_sources').insertOne({
      _id: linkId, orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(t.locationId), slot: 4, kind: 'link', label: 'Link',
      sealedAddress: 'sealed', host: 'calendar.example.test', googleConnectionId: null, generation: 1, reservedGeneration: 1, eventCount: 0,
      skippedRepeating: 0, status: 'ok', lastSuccessAt: null, lastAttemptAt: null, nextRefreshAt: null, leaseUntil: null, consecutiveFailures: 0,
      lastManualRefreshAt: null, createdBy: 'fixture', createdAt: server.clock.now(),
    });
    for (const answered of [await sort(t, linkId.toHexString()), await label(t, linkId.toHexString(), 'x', 'party'), await confirm(t, linkId.toHexString())]) {
      expect(answered).toMatchObject({ status: 409, body: { error: 'not_a_file_calendar' } });
    }
    const theirs = { ...other, locationId: t.locationId };
    for (const answered of [await sort(theirs, calendar.id), await label(theirs, calendar.id, 'u1', 'party'), await confirm(theirs, calendar.id)]) {
      expect(answered.status).toBe(404);
    }
    expect(await labels(t, calendar.id)).toMatchObject({ u1: [null, null] });
  });
});
