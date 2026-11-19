// D59 slice 2 (openspec change auto-apply-agent-reads design decisions 1, 3, 6, 7, 10 and 13), end to end: a calendar CSV
// imported while TownwiseAI works on its own is sorted by the TownwiseAI reader's loop with no press. Its labels (never
// `unsure`) are written as TownwiseAI's, the calendar is confirmed by TownwiseAI, the upcoming buyouts get linked notes,
// each through the ledger, and a past booking wants a refit. Nothing is queued with either switch off, with calendar
// titles off, or for staff open as admin; a spent month skips it and the press still works; every batch failing puts it
// back for a retry. Undo per calendar takes back its notes (but one a person edited), its labels and its confirm. The
// model is scripted: no call leaves the test. The test clock starts at 2026-06-01T12:00Z, Hanover's 2026-06-01. Every
// title, name and number here is made up.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { OrgScope } from '../src/access/policy.ts';
import { autoSortKeyOf } from '../src/calendar/auto-sort.ts';
import type { AgentChangeView } from '../src/agent/changes.ts';
import type { FileReaderModel } from '../src/files/extract/reader.ts';
import { createMemoryFileBlobs } from '../src/files/memory-blobs.ts';
import type { AgentPanel } from '../src/handlers/agent.ts';
import type { OwnerCalendarView } from '../src/handlers/owner-calendars.ts';
import { addChatUsage, addLocation, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { message, scriptedModel, text, type ScriptedModel } from './helpers/chat-model.ts';
import { seedHistory } from './helpers/lab.ts';
import { call, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

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
const TITLES = ['Summer reunion', 'Trivia night', 'Staff meeting', 'Smith wedding', 'Birthday party'];

/** The file reader is never asked here; a call would fail the test. */
const fileModel: FileReaderModel = { readFile: () => Promise.reject(new Error('no file read in this test')) };

let server: TownwiseTestServer;
let model: ScriptedModel;

interface Tenant { orgId: string; locationId: string; member: TestSession; admin: TestSession }

async function tenant(): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Sorting Grill ${randomUUID().slice(0, 6)}` });
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

/** Imports the export as `session` and lets the reader's loop finish whatever it queued. */
async function importExport(t: Tenant, session: TestSession = t.member): Promise<OwnerCalendarView> {
  const added = await send(`/api/org/locations/${t.locationId}/owner-calendars`, session, { json: { kind: 'file', label: SENTINEL_LABEL, ics: EXPORT } });
  expect(added.status).toBe(201);
  await settle();
  return added.body.calendar as OwnerCalendarView;
}

async function settle(): Promise<void> {
  server.aiReader?.nudge();
  await server.aiReader?.settled();
}

async function source(calendarId: string): Promise<Record<string, unknown> | null> {
  return server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(calendarId) });
}

async function labels(calendarId: string): Promise<Record<string, [string | null, string | null]>> {
  const rows = await server.connection.collection('tw_calendar_events').find({ sourceId: new Types.ObjectId(calendarId) }).toArray();
  return Object.fromEntries(rows.map((row) => [row.uid as string, [(row.booking as string | undefined) ?? null, (row.bookingBy as string | undefined) ?? null]]));
}

function notesOf(t: Tenant) {
  return server.connection.collection('tw_notes').find({ locationId: new Types.ObjectId(t.locationId) }).sort({ startDate: 1 }).toArray();
}

function changesOf(t: Tenant) {
  return server.connection.collection('tw_agent_changes').find({ locationId: new Types.ObjectId(t.locationId) }).sort({ appliedAt: 1, _id: 1 }).toArray();
}

/** The scripted answer for a batch: labels by ref. */
function answer(byRef: Record<string, string>) {
  const kept = Object.entries(byRef).map(([ref, booking]) => ({ ref, booking }));
  return { kind: 'message' as const, message: message([text(JSON.stringify({ labels: kept }))], { usage: { input: 2_000, output: 300 } }) };
}

/** p1 a party, p2 their own event, u3 not a booking, u1 a buyout, u2 unsure. */
const ANSWER = answer({ e1: 'party', e2: 'own_event', e3: 'other', e4: 'buyout', e5: 'unsure' });

async function setOrg(t: Tenant, fields: Record<string, unknown>): Promise<void> {
  await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(t.orgId) }, { $set: fields });
}

beforeAll(async () => {
  model = scriptedModel();
  server = await startTownwiseServer({ chat: model, files: createMemoryFileBlobs(), aiReader: { model: fileModel } });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await settle();
  await server.redis.flushdb();
});

describe('a calendar file imported while TownwiseAI works on its own', () => {
  it('is sorted with no press, its labels used for forecasts, its upcoming buyout noted, each through the ledger', async () => {
    const t = await tenant();
    await seedHistory(server, { orgId: t.orgId, locationId: t.locationId, from: '2025-01-01', to: '2026-05-31' });
    const calls = model.calls.length;
    model.script(ANSWER);
    const calendar = await importExport(t);
    expect(model.calls).toHaveLength(calls + 1);
    const wire = JSON.stringify(model.calls.at(-1)?.params);
    expect(wire).toContain('Birthday party, call [removed]');
    for (const sentinel of ['603-555', SENTINEL_LABEL, calendar.id, '"u1"', 'Sentinel-description', 'host@example.test', 'made-up@group']) {
      expect(wire).not.toContain(sentinel);
    }
    expect(await labels(calendar.id)).toEqual({
      p1: ['party', 'ai'], p2: ['own_event', 'ai'], u3: ['other', 'ai'], u1: ['buyout', 'ai'], u2: [null, null],
    });
    const stored = await source(calendar.id);
    expect(stored?.bookings).toMatchObject({ state: 'confirmed', confirmedBy: 'townwise_ai' });
    expect(stored?.autoSort).toMatchObject({ status: 'done', attempts: 1, reason: null });

    // One change for the calendar's labels, and one for the buyout's note.
    const changes = await changesOf(t);
    expect(changes.map((row): unknown[] => [row.action, row.sourceKind, row.sourceId, row.status, row.count ?? null, row.startDate, row.endDate, row.why]))
      .toEqual([
        ['booking.label', 'calendar', calendar.id, 'applied', 4, '2025-07-12', '2026-06-20', null],
        ['note.add', 'calendar', calendar.id, 'applied', null, '2026-06-20', '2026-06-20', null],
      ]);
    expect(changes[0]?.dedupeKey).toBe(autoSortKeyOf(calendar.id));
    const notes = await notesOf(t);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      kind: 'private_event', startDate: '2026-06-20', effect: 'closed', createdBy: 'townwise_ai', fromEvent: { uid: 'u1' },
      agent: { changeId: changes[1]?._id },
    });
    // The confirmed labels reach the lab input: the past party and the upcoming buyout.
    const scope = { orgId: t.orgId } as OrgScope;
    expect(await server.ctx.stores.ownerCalendars.bookingsBetween(scope, t.locationId, { from: '2025-01-01', to: '2027-12-31' }))
      .toEqual([{ startDate: '2025-07-12', endDate: '2025-07-12', booking: 'party' }, { startDate: '2026-06-20', endDate: '2026-06-20', booking: 'buyout' }]);
    // A past booking changed the training days: a refit is wanted, and no calibration was started.
    const location = await server.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(t.locationId) });
    expect((location?.refit as { wantedAt?: Date } | undefined)?.wantedAt).toBeInstanceOf(Date);
    expect(await server.connection.collection('tw_calibrations').countDocuments({ orgId: new Types.ObjectId(t.orgId) })).toBe(0);
    // Charged to the TownwiseAI month.
    const usage = await server.connection.collection('tw_chat_usage').findOne({ orgId: new Types.ObjectId(t.orgId) });
    expect(usage?.costMicroUsd).toBeGreaterThan(0);

    // Audit and logs: ids, codes and counts only.
    const applied = (await auditEvents(server)).filter((each) => each.action === 'agent.change_applied' && each.orgId?.toString() === t.orgId);
    expect(applied.map((each) => [each.actorUserId, each.details])).toEqual([
      ['townwise_ai', { locationId: t.locationId, action: 'booking.label', sourceKind: 'calendar' }],
      ['townwise_ai', { locationId: t.locationId, action: 'note.add', sourceKind: 'calendar' }],
    ]);
    const sorted = server.logs.filter((line) => line.includes('townwise.calendar_auto_sorted') && line.includes(calendar.id));
    expect(sorted).toHaveLength(1);
    expect(JSON.parse(sorted[0] ?? '{}')).toMatchObject({ sent: 5, labeled: 4, batchesFailed: 0, notes: 1, notesSkipped: 0 });
    const said = JSON.stringify([...server.logs, ...(await auditEvents(server))]);
    for (const title of TITLES) expect(said).not.toContain(title);

    // The activity shows one line for the labels with their count, which only an org admin may undo.
    const panel = async (session: TestSession) => (await send(`/api/org/locations/${t.locationId}/agent`, session)).body as unknown as AgentPanel;
    const item = (await panel(t.admin)).activity.find((each) => each.kind === 'agent_change' && each.action === 'booking.label');
    expect(item).toMatchObject({ sourceKind: 'calendar', status: 'applied', count: 4, startDate: '2025-07-12', endDate: '2026-06-20', undoable: true });
    expect((await panel(t.member)).activity.find((each) => each.kind === 'agent_change' && each.action === 'booking.label'))
      .toMatchObject({ undoable: false });

    // It is never sorted on its own again: the queue entry is spent and the press is the only way back in.
    expect(await server.ctx.stores.ownerCalendars.queueAutoSort(scope, t.locationId, calendar.id, server.clock.now())).toBe(false);
  });

  it('queues nothing with the organization’s switch off, with calendar titles off, or for staff open as admin', async () => {
    const calls = model.calls.length;
    const off = await tenant();
    await setOrg(off, { agentAuto: { on: false, at: server.clock.now(), by: null } });
    const titlesOff = await tenant();
    await setOrg(titlesOff, { calendarTitlesToAi: { on: false, at: server.clock.now(), by: null } });
    for (const t of [off, titlesOff]) {
      const calendar = await importExport(t);
      expect((await source(calendar.id))?.autoSort).toBeUndefined();
      expect(calendar.bookings).toMatchObject({ state: 'unsorted' });
    }
    const staffed = await tenant();
    await removeStaffFactor(server);
    const staff = await signInStaff(server);
    await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId: staffed.orgId });
    const calendar = await importExport(staffed, staff);
    expect((await source(calendar.id))?.autoSort).toBeUndefined();
    await removeStaffFactor(server);
    expect(model.calls).toHaveLength(calls);
  });

  it('is skipped budget_spent when the month can’t cover it, before any call, and the press still sorts', async () => {
    const t = await tenant();
    await addChatUsage(server, { orgId: t.orgId, month: server.clock.now().toISOString().slice(0, 7), costMicroUsd: 19_990_000 });
    const calls = model.calls.length;
    const calendar = await importExport(t);
    expect(model.calls).toHaveLength(calls);
    expect((await source(calendar.id))?.autoSort).toMatchObject({ status: 'skipped', reason: 'budget_spent' });
    expect(await changesOf(t)).toEqual([]);
    await server.connection.collection('tw_chat_usage').deleteMany({ orgId: new Types.ObjectId(t.orgId) });
    model.script(ANSWER);
    expect(await send(`/api/org/locations/${t.locationId}/owner-calendars/${calendar.id}/bookings/sort`, t.admin, { method: 'POST' }))
      .toMatchObject({ status: 200, body: { labeled: 4 } });
  });

  it('puts the sort back when every batch fails, and the retry sorts it', async () => {
    const t = await tenant();
    model.script({ kind: 'error', error: new Error('overloaded') });
    const calendar = await importExport(t);
    expect((await source(calendar.id))?.autoSort).toMatchObject({ status: 'queued', attempts: 1 });
    expect(await changesOf(t)).toEqual([]);
    // After the wait (1 minute after a first attempt).
    server.clock.advance(61_000);
    model.script(ANSWER);
    await settle();
    expect((await source(calendar.id))?.autoSort).toMatchObject({ status: 'done', attempts: 2 });
    expect((await changesOf(t)).map((row): unknown => row.action)).toEqual(['booking.label', 'note.add']);
  });
});

describe('Undo per calendar', () => {
  it('takes back the notes nobody changed, every label nobody changed and the confirm, once, for an org admin only', async () => {
    const t = await tenant();
    model.script(answer({ e1: 'party', e2: 'own_event', e3: 'buyout', e4: 'buyout', e5: 'party' }));
    const calendar = await importExport(t);
    const changes = await changesOf(t);
    expect(changes.map((row): unknown => row.action)).toEqual(['booking.label', 'note.add', 'note.add', 'note.add']);
    const labelChange = String(changes[0]?._id);
    // Later, a person relabels one event and edits one of the notes: both are theirs now.
    server.clock.advance(60_000);
    expect((await send(`/api/org/locations/${t.locationId}/owner-calendars/${calendar.id}/bookings`, t.admin, { method: 'PATCH', json: { uid: 'p2', booking: 'other' } })).status)
      .toBe(200);
    const edited = (await notesOf(t)).find((note) => (note.fromEvent as { uid: string }).uid === 'u2');
    expect((await send(`/api/org/locations/${t.locationId}/notes/${String(edited?._id)}`, t.admin, {
      method: 'PATCH',
      json: { kind: 'private_event', startDate: '2026-06-27', endDate: '2026-06-27', weekdays: null, effect: 'more_guests', expectedGuests: 25, detail: null },
    })).status).toBe(200);

    const undo = (session: TestSession) => send(`/api/org/locations/${t.locationId}/agent/changes/${labelChange}/undo`, session, { method: 'POST' });
    expect(await undo(t.member)).toMatchObject({ status: 403 });
    const undone = await undo(t.admin);
    expect(undone.status).toBe(200);
    expect(undone.body.change as AgentChangeView).toMatchObject({ action: 'booking.label', status: 'undone', undoable: false, count: 5 });
    expect(await labels(calendar.id)).toEqual({
      p1: [null, null], p2: ['other', 'person'], u3: [null, null], u1: [null, null], u2: [null, null],
    });
    expect((await source(calendar.id))?.bookings).toMatchObject({ state: 'sorted', confirmedBy: null });
    expect((await notesOf(t)).map((note) => (note.fromEvent as { uid: string }).uid)).toEqual(['u2']);
    expect((await changesOf(t)).map((row): unknown[] => [row.action, row.status])).toEqual([
      ['booking.label', 'undone'], ['note.add', 'undone'], ['note.add', 'undone'], ['note.add', 'adopted'],
    ]);
    const undoneEvents = (await auditEvents(server)).filter((each) => each.action === 'agent.change_undone' && each.orgId?.toString() === t.orgId);
    expect(undoneEvents.map((each) => each.details)).toEqual([
      { locationId: t.locationId, action: 'note.add', sourceKind: 'calendar' },
      { locationId: t.locationId, action: 'note.add', sourceKind: 'calendar' },
      { locationId: t.locationId, action: 'booking.label', sourceKind: 'calendar' },
    ]);
    // Again: the same answer, nothing recorded twice.
    expect(await undo(t.admin)).toMatchObject({ status: 200, body: { change: { status: 'undone' } } });
    expect((await auditEvents(server)).filter((each) => each.action === 'agent.change_undone' && each.orgId?.toString() === t.orgId)).toHaveLength(3);
  });
});
