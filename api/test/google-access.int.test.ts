// Ending Townwise's Google access through the API (src/calendar/google-access.ts and its callers; openspec change
// connect-google-calendar: the google-calendar spec's "Townwise's access ends when it is no longer needed" and "A
// revoke never ends another connection", design decisions 10, 11 and 14). Team removal, leaving and staff removal mark
// the person's connection and then end it; a last_admin refusal ends nothing; Remove of the last Google calendar ends
// it, whoever presses it; deleting a location ends the connections left backing nothing; deleting an organization
// revokes through revokeForOrg; a failed revoke still deletes; the revoke runs with the Google client off; and a
// connection in another organization keeps the grant. Google is the fake of helpers/google.ts, which records every
// call. The refresh loop's connection check, which finishes an interrupted end and pushes a checked connection 24
// hours on, is calendar/refresher.ts's (task 3.3, calendar-refresher.int.test.ts); here an interrupted request leaves
// the connection due at once, and a Google read's seat check ends it. Every name and title here is made up.
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { SEAT_SETTLE_MS } from '../src/calendar/google-access.ts';
import { addLocation, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  addGoogleCalendar, addGoogleConnection, allDay, AUTH_CODE, createFakeGoogle, GOOGLE_CLIENT_ID, googleError, linkGoogle, PRIMARY_ID, REFRESH_TOKEN,
  SHARED_ID,
} from './helpers/google.ts';
import {
  call, logLines, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';

const KEY = createSecretKey(randomBytes(32));
/** A second person's refresh token, so a test can tell whose grant was revoked. */
const TEAMMATE_TOKEN = '1//fake-refresh-token-teammate';
/** pino's own fields on every line. */
const LOG_BASE = new Set(['level', 'time', 'pid', 'hostname', 'msg']);

const google = createFakeGoogle();
let server: TownwiseTestServer;

interface Person { email: string; session: TestSession; subject: string; seatId: string }
interface Tenant { orgId: string; locationId: string; member: Person; teammate: Person; admin: Person }

async function person(orgId: string, role: 'member' | 'org_admin' = 'member'): Promise<Person> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  const seatId = await addSeat(server, { orgId, userId: session.userId, email, role });
  const subject = `google-${randomUUID()}`;
  await linkGoogle(server, session.userId, subject);
  return { email, session, subject, seatId };
}

async function tenant(name: string): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `${name} ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, locationId, member: await person(orgId), teammate: await person(orgId), admin: await person(orgId, 'org_admin') };
}

async function send(path: string, session: TestSession, init: { method?: string; json?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call(server, path, { session, ...init });
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) as Record<string, unknown> };
}

function calendarsPath(locationId: string): string {
  return `/api/org/locations/${locationId}/owner-calendars`;
}

/** Connects `p`'s Google account, the fake's exchange answering `refreshToken`. */
async function connect(locationId: string, p: Person, refreshToken = REFRESH_TOKEN): Promise<void> {
  google.state.subject = p.subject;
  google.state.refreshToken = refreshToken;
  expect((await send(`/api/org/locations/${locationId}/google-calendars/connect`, p.session, { json: { code: AUTH_CODE, agreed: true } })).status).toBe(200);
}

/** Adds the Google calendar `googleCalendarId` to the location as `p`, answering its id. */
async function addGoogle(locationId: string, p: Person, googleCalendarId: string): Promise<string> {
  const added = await send(calendarsPath(locationId), p.session, { json: { kind: 'google', googleCalendarId } });
  expect(added.status).toBe(201);
  return (added.body.calendar as { id: string }).id;
}

function removeCalendar(locationId: string, p: Person, calendarId: string) {
  return send(`${calendarsPath(locationId)}/${calendarId}`, p.session, { method: 'DELETE' });
}

function connectionRow(orgId: string, p: Pick<Person, 'session'>) {
  return server.connection.collection('tw_google_connections').findOne({ orgId: new Types.ObjectId(orgId), userId: p.session.userId });
}

async function connectionIdOf(orgId: string, p: Person): Promise<string> {
  const row = await connectionRow(orgId, p);
  if (row === null) throw new Error('no connection row');
  return row._id.toHexString();
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

/** The location's calendars and their events. */
async function stored(locationId: string): Promise<{ calendars: number; events: number }> {
  const filter = { locationId: new Types.ObjectId(locationId) };
  return { calendars: await count('tw_calendar_sources', filter), events: await count('tw_calendar_events', filter) };
}

/** The lines named `msg` logged while `run` runs, each with its fields beyond pino's own. */
async function linesDuring(msg: string, run: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const from = server.logs.length;
  await run();
  return logLines(server).slice(from).filter((line) => line.msg === msg)
    .map((line) => Object.fromEntries(Object.entries(line).filter(([key]) => !LOG_BASE.has(key))));
}

function revoked(): unknown[] {
  return google.callsOf('revoke').map((each) => each.args[0]);
}

async function disconnectedEvents(connectionId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => event.action === 'google_calendar.disconnected' && (event.target as { id: string }).id === connectionId);
}

/** Makes the next deleteMany of a model fail, as a request that stops there would. */
function failNextDeleteMany(modelName: string): { mockRestore: () => void } {
  const model = server.connection.models[modelName] as unknown as { deleteMany: (...args: unknown[]) => unknown };
  return vi.spyOn(model, 'deleteMany').mockImplementationOnce(() => { throw new Error('interrupted'); });
}

describe('with Google calendars on', () => {
  beforeAll(async () => {
    server = await startTownwiseServer({ calendarKey: KEY, googleCalendar: google.client, googleCalendarClientId: GOOGLE_CLIENT_ID, revokeGoogle: google.revoke });
  });
  afterAll(async () => { await server.close(); });
  beforeEach(async () => {
    await server.redis.flushdb();
    google.reset();
    google.state.events = { [SHARED_ID]: [allDay('shared-1', 'Holiday party', '2026-06-05')], [PRIMARY_ID]: [allDay('primary-1', 'Dentist', '2026-06-09')] };
  });

  /** `t.member` connected, with two Google calendars on the main location. */
  async function connectedMember(name: string): Promise<{ t: Tenant; connectionId: string }> {
    const t = await tenant(name);
    await connect(t.locationId, t.member);
    await addGoogle(t.locationId, t.member, SHARED_ID);
    await addGoogle(t.locationId, t.member, PRIMARY_ID);
    google.calls.length = 0;
    return { t, connectionId: await connectionIdOf(t.orgId, t.member) };
  }

  /** After a seat loss: the calendars and events gone, the grant revoked, the row deleted, and no audit event of its own. */
  async function expectEnded(t: Tenant, connectionId: string, lines: Record<string, unknown>[], reason: string): Promise<void> {
    expect(lines).toEqual([{ connectionId, calendars: 2, reason }]);
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await stored(t.locationId)).toEqual({ calendars: 0, events: 0 });
    expect(await connectionRow(t.orgId, t.member)).toBeNull();
    expect(await disconnectedEvents(connectionId)).toEqual([]);
    // The read path is never taken: nothing but the revoke reached Google.
    expect(google.calls.map((each) => each.method)).toEqual(['revoke']);
  }

  it('an org admin removing the member ends their access (reason seat_removed)', async () => {
    const { t, connectionId } = await connectedMember('Removed Member Grill');
    const lines = await linesDuring('townwise.google_access_ended', async () => {
      expect((await send(`/api/org/members/${t.member.seatId}`, t.admin.session, { method: 'DELETE' })).status).toBe(204);
    });
    await expectEnded(t, connectionId, lines, 'seat_removed');
    expect((await auditEvents(server)).filter((event) => event.action === 'member.removed' && (event.target as { id: string }).id === t.member.seatId)).toHaveLength(1);
  });

  it('the member leaving ends their access (reason left)', async () => {
    const { t, connectionId } = await connectedMember('Leaving Member Diner');
    const lines = await linesDuring('townwise.google_access_ended', async () => {
      expect((await send('/api/org/leave', t.member.session, { json: {} })).status).toBe(200);
    });
    await expectEnded(t, connectionId, lines, 'left');
  });

  it('staff removing the member from the console end their access (reason seat_removed)', async () => {
    const { t, connectionId } = await connectedMember('Staff Removed Bistro');
    const staff = await signInStaff(server);
    try {
      const lines = await linesDuring('townwise.google_access_ended', async () => {
        expect((await send(`/api/admin/orgs/${t.orgId}/members/${t.member.seatId}`, staff, { method: 'DELETE' })).status).toBe(204);
      });
      await expectEnded(t, connectionId, lines, 'seat_removed');
    } finally {
      await removeStaffFactor(server);
    }
  });

  it('the connection is marked before the seat goes: a removal stopped after it leaves the connection due at once, and the next Google read ends the access', async () => {
    const { t } = await connectedMember('Interrupted Removal Cafe');
    const [calendarId] = (await server.connection.collection('tw_calendar_sources').find({ locationId: new Types.ObjectId(t.locationId) }).toArray())
      .map((row) => row._id.toHexString());
    server.clock.advance(MINUTE);
    // The request stops at ending the access, the seat already gone: its retry would answer 404.
    const spy = failNextDeleteMany('TwCalendarEvent');
    try {
      expect(await send(`/api/org/members/${t.member.seatId}`, t.admin.session, { method: 'DELETE' })).toMatchObject({ status: 500, body: { error: 'internal' } });
    } finally {
      spy.mockRestore();
    }
    expect(await server.connection.collection('tw_members').findOne({ _id: new Types.ObjectId(t.member.seatId) })).toMatchObject({ status: 'removed' });
    expect(await send(`/api/org/members/${t.member.seatId}`, t.admin.session, { method: 'DELETE' })).toMatchObject({ status: 404 });
    expect(await connectionRow(t.orgId, t.member)).toMatchObject({ checkAt: server.clock.now(), revokedAt: null });
    expect(await stored(t.locationId)).toEqual({ calendars: 2, events: 2 });
    expect(revoked()).toEqual([]);

    // Within SEAT_SETTLE_MS of the removal the seat may still come back (a last admin's refusal restores it), so a
    // teammate's Refresh now reads nothing, ends nothing and records nothing.
    const refreshPath = `${calendarsPath(t.locationId)}/${calendarId ?? ''}/refresh`;
    expect(await send(refreshPath, t.teammate.session, { method: 'POST' })).toMatchObject({ status: 503, body: { error: 'google_unavailable' } });
    expect(google.calls).toEqual([]);
    expect(await stored(t.locationId)).toEqual({ calendars: 2, events: 2 });
    expect(await connectionRow(t.orgId, t.member)).toMatchObject({ checkAt: server.clock.now(), revokedAt: null });

    // Past it (and past Refresh now's 5 minutes), the next Refresh now finds no seat and ends the access without reading Google.
    server.clock.advance(5 * MINUTE);
    expect(5 * MINUTE).toBeGreaterThan(SEAT_SETTLE_MS);
    expect(await send(refreshPath, t.teammate.session, { method: 'POST' }))
      .toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(google.calls.map((each) => each.method)).toEqual(['revoke']);
    expect(await stored(t.locationId)).toEqual({ calendars: 0, events: 0 });
    expect(await connectionRow(t.orgId, t.member)).toBeNull();
  });

  it('a last_admin refusal ends nothing: the connection, its token and its calendars stay, marked for the check, which finds the seat', async () => {
    const { t } = await connectedMember('Last Admin Lodge');
    // The org admin connects too; they are the only admin, so they cannot leave.
    await connect(t.locationId, t.admin, TEAMMATE_TOKEN);
    const before = await connectionRow(t.orgId, t.admin);
    server.clock.advance(MINUTE);
    google.calls.length = 0;
    const lines = await linesDuring('townwise.google_access_ended', async () => {
      expect(await send('/api/org/leave', t.admin.session, { json: {} })).toMatchObject({ status: 409, body: { error: 'last_admin' } });
    });
    expect(lines).toEqual([]);
    expect(google.calls).toEqual([]);
    expect(await connectionRow(t.orgId, t.admin)).toEqual({ ...before, checkAt: server.clock.now() });
    expect(await stored(t.locationId)).toEqual({ calendars: 2, events: 2 });
  });

  it('a Google read in the moment a removal has taken the seat and a last_admin refusal has not yet put it back ends nothing', async () => {
    const { t, connectionId } = await connectedMember('Restored Seat Saloon');
    const [calendarId] = (await server.connection.collection('tw_calendar_sources').find({ locationId: new Types.ObjectId(t.locationId) }).toArray())
      .map((row) => row._id.toHexString());
    const refreshPath = `${calendarsPath(t.locationId)}/${calendarId ?? ''}/refresh`;
    const seat = { _id: new Types.ObjectId(t.member.seatId) };
    const members = server.connection.collection('tw_members');
    server.clock.advance(MINUTE);
    // removeActiveSeat's remove, as the members store writes it; its recount and restore have not run yet.
    await members.updateOne(seat, { $set: { status: 'removed', removedAt: server.clock.now(), removedBy: t.admin.session.userId }, $unset: { activeUserId: '' } });
    const before = await connectionRow(t.orgId, t.member);
    const lines = await linesDuring('townwise.google_access_ended', async () => {
      expect(await send(refreshPath, t.teammate.session, { method: 'POST' })).toMatchObject({ status: 503, body: { error: 'google_unavailable' } });
    });
    expect(lines).toEqual([]);
    expect(google.calls).toEqual([]);
    expect(await connectionRow(t.orgId, t.member)).toEqual(before);
    expect(await stored(t.locationId)).toEqual({ calendars: 2, events: 2 });
    // The restore, as the members store writes it: the seat is back, and the next read goes on as before.
    await members.updateOne(seat, { $set: { status: 'active', activeUserId: t.member.session.userId, removedAt: null, removedBy: null } });
    server.clock.advance(5 * MINUTE);
    expect(await send(refreshPath, t.teammate.session, { method: 'POST' })).toMatchObject({ status: 200, body: { calendar: { status: 'ok' } } });
    expect(google.calls[0]?.method).toBe('refreshAccess');
    expect(google.calls.map((each) => each.method)).toContain('listEvents');
    expect(google.calls.map((each) => each.method)).not.toContain('revoke');
    expect(await connectionIdOf(t.orgId, t.member)).toBe(connectionId);
  });

  it('removing the last Google calendar ends the connection, whoever removes it; removing one that leaves another keeps it', async () => {
    const { t, connectionId } = await connectedMember('Last Calendar Kitchen');
    const [first, second] = (await server.connection.collection('tw_calendar_sources').find({ locationId: new Types.ObjectId(t.locationId) }).sort({ slot: 1 }).toArray())
      .map((row) => row._id.toHexString());
    server.clock.advance(MINUTE);
    expect((await removeCalendar(t.locationId, t.teammate, first ?? '')).status).toBe(204);
    expect(revoked()).toEqual([]);
    // Marked for the check before the removal; the check finds it in use and pushes it on.
    expect(await connectionRow(t.orgId, t.member)).toMatchObject({ checkAt: server.clock.now() });
    expect(await disconnectedEvents(connectionId)).toEqual([]);

    const lines = await linesDuring('townwise.google_access_ended', async () => {
      expect((await removeCalendar(t.locationId, t.teammate, second ?? '')).status).toBe(204);
    });
    expect(lines).toEqual([{ connectionId, calendars: 0, reason: 'last_calendar' }]);
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(t.orgId, t.member)).toBeNull();
    const [event, ...more] = await disconnectedEvents(connectionId);
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      actorUserId: t.teammate.session.userId, target: { type: 'google_connection', id: connectionId },
      details: { connectionId, calendarCount: 0, reason: 'last_calendar' },
    });
  });

  it('a Google calendar an add stores while the revoke runs goes with the connection: no calendar is left for a deleted connection', async () => {
    const t = await tenant('Racing Add Rotisserie');
    await connect(t.locationId, t.member);
    const calendarId = await addGoogle(t.locationId, t.member, SHARED_ID);
    const connectionId = await connectionIdOf(t.orgId, t.member);
    server.clock.advance(MINUTE);
    // The member's add of another calendar lands while ending the access waits on Google's revoke: the connection row
    // is still there, so the add's own check after storing passes and it answers 201.
    google.on('revoke', async () => { await addGoogle(t.locationId, t.member, PRIMARY_ID); });
    const lines = await linesDuring('townwise.google_access_ended', async () => {
      expect((await removeCalendar(t.locationId, t.teammate, calendarId)).status).toBe(204);
    });
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(t.orgId, t.member)).toBeNull();
    // Swept again once the row is gone: no calendar or event is left whose access has ended.
    expect(await stored(t.locationId)).toEqual({ calendars: 0, events: 0 });
    expect(lines).toEqual([{ connectionId, calendars: 1, reason: 'last_calendar' }]);
    expect(await disconnectedEvents(connectionId)).toEqual([
      expect.objectContaining({ details: { connectionId, calendarCount: 1, reason: 'last_calendar' } }),
    ]);
  });

  it('a revoke that fails still deletes the connection, logging its status only', async () => {
    const t = await tenant('Failed Revoke Fish House');
    await connect(t.locationId, t.member);
    const calendarId = await addGoogle(t.locationId, t.member, SHARED_ID);
    // Google's revoke endpoint timing out: no status was read.
    google.on('revoke', () => Promise.reject(googleError('unavailable')));
    const lines = await linesDuring('townwise.google_revoke_failed', async () => {
      expect((await removeCalendar(t.locationId, t.member, calendarId)).status).toBe(204);
    });
    expect(lines).toEqual([{ status: null }]);
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(t.orgId, t.member)).toBeNull();
  });

  it('deleting a location ends the connections left backing nothing and keeps one that backs another location’s calendar', async () => {
    const t = await tenant('Two Rooms Tavern');
    const patio = await addLocation(server, { orgId: t.orgId, name: 'Patio' });
    await connect(t.locationId, t.member);
    await addGoogle(t.locationId, t.member, SHARED_ID);
    await connect(t.locationId, t.teammate, TEAMMATE_TOKEN);
    await addGoogle(t.locationId, t.teammate, PRIMARY_ID);
    const kept = await addGoogle(patio, t.teammate, SHARED_ID);
    const memberConnection = await connectionIdOf(t.orgId, t.member);
    server.clock.advance(MINUTE);
    google.calls.length = 0;
    const lines = await linesDuring('townwise.google_access_ended', async () => {
      expect((await send(`/api/org/locations/${t.locationId}`, t.admin.session, { method: 'DELETE' })).status).toBe(204);
    });
    expect(lines).toEqual([{ connectionId: memberConnection, calendars: 0, reason: 'location_deleted' }]);
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(t.orgId, t.member)).toBeNull();
    expect(await stored(t.locationId)).toEqual({ calendars: 0, events: 0 });
    // The teammate's connection still backs the patio's calendar: marked first, and kept.
    expect(await connectionRow(t.orgId, t.teammate)).toMatchObject({ checkAt: server.clock.now(), revokedAt: null });
    expect(await count('tw_calendar_sources', { _id: new Types.ObjectId(kept) })).toBe(1);
  });

  it('a location deletion stopped after the location row is gone leaves the connection already due at once (the refresh loop finishes it)', async () => {
    const t = await tenant('Interrupted Room Deli');
    await addLocation(server, { orgId: t.orgId, name: 'Patio' });
    await connect(t.locationId, t.member);
    await addGoogle(t.locationId, t.member, SHARED_ID);
    server.clock.advance(MINUTE);
    google.calls.length = 0;
    // removeLocation stops at its first sweep after locations.remove.
    const spy = failNextDeleteMany('TwUpload');
    try {
      expect(await send(`/api/org/locations/${t.locationId}`, t.admin.session, { method: 'DELETE' })).toMatchObject({ status: 500, body: { error: 'internal' } });
    } finally {
      spy.mockRestore();
    }
    expect(await count('tw_locations', { _id: new Types.ObjectId(t.locationId) })).toBe(0);
    expect(await stored(t.locationId)).toEqual({ calendars: 1, events: 1 });
    expect(await connectionRow(t.orgId, t.member)).toMatchObject({ checkAt: server.clock.now(), revokedAt: null });
    expect(google.calls).toEqual([]);
  });

  it('deleting an organization revokes each connection through revokeForOrg and deletes them with their calendars', async () => {
    const t = await tenant('Closing Time Bar');
    await connect(t.locationId, t.member);
    await addGoogle(t.locationId, t.member, SHARED_ID);
    await connect(t.locationId, t.teammate, TEAMMATE_TOKEN);
    await addGoogle(t.locationId, t.teammate, PRIMARY_ID);
    const ids = [await connectionIdOf(t.orgId, t.member), await connectionIdOf(t.orgId, t.teammate)];
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(t.orgId) }, { $set: { status: 'suspended', suspendedAt: server.clock.now() } });
    google.calls.length = 0;
    const staff = await signInStaff(server);
    try {
      const lines = await linesDuring('townwise.google_access_ended', async () => {
        expect((await send(`/api/admin/orgs/${t.orgId}`, staff, { method: 'DELETE' })).status).toBe(200);
      });
      expect(lines).toEqual(ids.map((connectionId) => ({ connectionId, calendars: 1, reason: 'org_deleted' })));
    } finally {
      await removeStaffFactor(server);
    }
    expect(revoked()).toEqual([REFRESH_TOKEN, TEAMMATE_TOKEN]);
    expect(await count('tw_google_connections', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
    expect(await count('tw_calendar_sources', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
    expect(await count('tw_calendar_events', { orgId: new Types.ObjectId(t.orgId) })).toBe(0);
  });

  it('a connection in another organization keeps the grant: the leftover row is deleted without revoking, and the other organization’s calendar keeps refreshing', async () => {
    const a = await tenant('Former Workplace Inn');
    const b = await tenant('New Workplace Cafe');
    // b.member connected in B, where they hold their seat.
    await connect(b.locationId, b.member);
    const bCalendar = await addGoogle(b.locationId, b.member, SHARED_ID);
    const bBefore = await connectionRow(b.orgId, b.member);
    // A row and a calendar of theirs left in A, which they hold no seat in.
    const leftover = await addGoogleConnection(server, { orgId: a.orgId, userId: b.member.session.userId, key: KEY });
    const aCalendar = await addGoogleCalendar(server, {
      orgId: a.orgId, locationId: a.locationId, connectionId: leftover, key: KEY, googleCalendarId: SHARED_ID,
    });
    google.calls.length = 0;
    const lines = await linesDuring('townwise.google_access_ended', async () => {
      expect(await send(`${calendarsPath(a.locationId)}/${aCalendar}/refresh`, a.teammate.session, { method: 'POST' }))
        .toMatchObject({ status: 404, body: { error: 'not_found' } });
    });
    expect(lines).toEqual([{ connectionId: leftover, calendars: 1, reason: 'seat_gone' }]);
    expect(google.calls).toEqual([]);
    expect(await count('tw_google_connections', { _id: new Types.ObjectId(leftover) })).toBe(0);
    expect(await stored(a.locationId)).toEqual({ calendars: 0, events: 0 });
    expect(await connectionRow(b.orgId, b.member)).toEqual(bBefore);
    server.clock.advance(6 * MINUTE);
    expect(await send(`${calendarsPath(b.locationId)}/${bCalendar}/refresh`, b.member.session, { method: 'POST' }))
      .toMatchObject({ status: 200, body: { calendar: { status: 'ok' } } });
  });

  it('no audit event or log line held a token, the code or a Google calendar id', async () => {
    const audit = JSON.stringify(await auditEvents(server));
    const logs = server.logs.join('\n');
    expect(logs).toContain('townwise.google_access_ended');
    for (const secret of [REFRESH_TOKEN, TEAMMATE_TOKEN, 'fake-refresh-token', 'fake-access-token', AUTH_CODE, PRIMARY_ID, SHARED_ID]) {
      expect(audit).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  });
});

describe('with Google calendars off and the calendar key set', () => {
  beforeAll(async () => { server = await startTownwiseServer({ calendarKey: KEY, revokeGoogle: google.revoke }); });
  afterAll(async () => { await server.close(); });
  beforeEach(async () => {
    await server.redis.flushdb();
    google.reset();
  });

  it('removing the last Google calendar still revokes the grant and deletes the connection, while every Google read and route answers 503', async () => {
    const t = await tenant('Switched Off Steakhouse');
    const connectionId = await addGoogleConnection(server, { orgId: t.orgId, userId: t.member.session.userId, key: KEY });
    const calendarId = await addGoogleCalendar(server, {
      orgId: t.orgId, locationId: t.locationId, connectionId, key: KEY, googleCalendarId: SHARED_ID,
    });
    const listed = await send(calendarsPath(t.locationId), t.member.session);
    expect(listed.body.google).toEqual({ available: false, connected: false, clientId: null });
    expect(listed.body.calendars).toEqual([expect.objectContaining({ id: calendarId, kind: 'google', host: null })]);
    expect(await send(`${calendarsPath(t.locationId)}/${calendarId}/refresh`, t.member.session, { method: 'POST' }))
      .toMatchObject({ status: 503, body: { error: 'google_calendar_unavailable' } });
    expect(await server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(calendarId) })).toMatchObject({ lastManualRefreshAt: null });
    for (const [path, init] of [
      [`/api/org/locations/${t.locationId}/google-calendars`, {}],
      [`/api/org/locations/${t.locationId}/google-calendars/connect`, { json: { code: AUTH_CODE, agreed: true } }],
      ['/api/org/google-connection', { method: 'DELETE' }],
      [calendarsPath(t.locationId), { json: { kind: 'google', googleCalendarId: PRIMARY_ID } }],
    ] as const) {
      expect(await send(path, t.member.session, init)).toMatchObject({ status: 503, body: { error: 'google_calendar_unavailable' } });
    }
    expect(google.calls).toEqual([]);

    expect((await removeCalendar(t.locationId, t.member, calendarId)).status).toBe(204);
    expect(google.calls.map((each) => [each.method, each.args[0]])).toEqual([['revoke', REFRESH_TOKEN]]);
    expect(await count('tw_google_connections', { _id: new Types.ObjectId(connectionId) })).toBe(0);
    expect(await disconnectedEvents(connectionId)).toEqual([
      expect.objectContaining({ details: { connectionId, calendarCount: 0, reason: 'last_calendar' } }),
    ]);
  });
});
