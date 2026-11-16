// Connecting, picking, adding and refreshing Google calendars through the API (src/handlers/google-calendars.ts and the
// Google parts of src/handlers/owner-calendars.ts; openspec change connect-google-calendar: the google-calendar spec,
// design decisions 3, 4, 5, 8, 9, 12 and 13). Google is the fake client of helpers/google.ts, so nothing reaches the
// network and every Google call is recorded. The tokens and code are made up and must never show in plain text in a
// row, an answer, an audit event or a log line; a Google calendar's id shows only in the picker's answer to its person.
// Every name and title here is made up.
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { summaryOf } from '../src/audit.ts';
import { CHECK_INTERVAL_MS } from '../src/stores/google-connections.ts';
import { open, seal } from '../src/calendar/secret.ts';
import type { OwnerCalendarView } from '../src/handlers/owner-calendars.ts';
import { addGrant, addLocation, addOpenAsAdminGrant, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import {
  ACCESS_TOKEN, ALL_SCOPES, allDay, AUTH_CODE, createFakeGoogle, GOOGLE_CLIENT_ID, googleError, linkGoogle, PRIMARY_ID, REFRESH_TOKEN, SHARED_ID,
} from './helpers/google.ts';
import {
  call, limiterKey, logLines, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, writesDuring, type TestSession,
  type TownwiseTestServer,
} from './helpers/server.ts';

const KEY = createSecretKey(randomBytes(32));
const OTHER_KEY = createSecretKey(randomBytes(32));
const SHARED_NAME = 'Front desk bookings';
const TITLE = 'Holiday party';
const LATER_TITLE = 'Retirement dinner';
/** pino's own fields on every line. */
const LOG_BASE = new Set(['level', 'time', 'pid', 'hostname', 'msg']);

const google = createFakeGoogle();
let server: TownwiseTestServer;
/** Every answer's text, for the check that none holds a token or the code. */
const answers: string[] = [];

interface Person { email: string; session: TestSession; subject: string }
interface Tenant { orgId: string; locationId: string; member: Person; teammate: Person; admin: Person }

async function person(orgId: string, role: 'member' | 'org_admin' = 'member'): Promise<Person> {
  const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
  const session = await signIn(server, email);
  await addSeat(server, { orgId, userId: session.userId, email, role });
  const subject = `google-${randomUUID()}`;
  await linkGoogle(server, session.userId, subject);
  return { email, session, subject };
}

async function tenant(name: string): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `${name} ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, locationId, member: await person(orgId), teammate: await person(orgId), admin: await person(orgId, 'org_admin') };
}

async function send(path: string, session: TestSession, init: { method?: string; json?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await call(server, path, { session, ...init });
  const text = await res.text();
  answers.push(text);
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) as Record<string, unknown> };
}

function calendarsPath(t: Pick<Tenant, 'locationId'>): string {
  return `/api/org/locations/${t.locationId}/owner-calendars`;
}

function choicesPath(t: Pick<Tenant, 'locationId'>): string {
  return `/api/org/locations/${t.locationId}/google-calendars`;
}

/** Connects `p`'s Google account: the fake's next exchange names them. */
function connect(t: Pick<Tenant, 'locationId'>, p: Person, body: unknown = { code: AUTH_CODE, agreed: true }) {
  google.state.subject = p.subject;
  return send(`${choicesPath(t)}/connect`, p.session, { json: body });
}

function choices(t: Pick<Tenant, 'locationId'>, p: Person) {
  return send(choicesPath(t), p.session);
}

function addGoogle(t: Pick<Tenant, 'locationId'>, p: Person, googleCalendarId: string) {
  return send(calendarsPath(t), p.session, { json: { kind: 'google', googleCalendarId } });
}

function refreshNow(t: Pick<Tenant, 'locationId'>, p: Person, calendarId: string) {
  return send(`${calendarsPath(t)}/${calendarId}/refresh`, p.session, { method: 'POST' });
}

function connectionRow(t: Pick<Tenant, 'orgId'>, p: Person) {
  return server.connection.collection('tw_google_connections').findOne({ orgId: new Types.ObjectId(t.orgId), userId: p.session.userId });
}

function sourceRow(calendarId: string) {
  return server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(calendarId) });
}

function sourceCount(t: Pick<Tenant, 'locationId'>): Promise<number> {
  return server.connection.collection('tw_calendar_sources').countDocuments({ locationId: new Types.ObjectId(t.locationId) });
}

function eventTitles(calendarId: string): Promise<string[]> {
  return server.connection.collection('tw_calendar_events').find({ sourceId: new Types.ObjectId(calendarId) }).sort({ startDate: 1 }).toArray()
    .then((rows) => rows.map((row) => String(row.title)));
}

function calendarOf(answer: { body: Record<string, unknown> }): OwnerCalendarView {
  return answer.body.calendar as OwnerCalendarView;
}

/** Connects `p` and adds `id`, answering its calendar. */
async function connectedWith(t: Tenant, p: Person, id = SHARED_ID): Promise<OwnerCalendarView> {
  expect((await connect(t, p)).status).toBe(200);
  const added = await addGoogle(t, p, id);
  expect(added.status).toBe(201);
  return calendarOf(added);
}

/** A source written straight to the collection: `slot` free, with one event titled `title`. */
async function insertSource(t: Pick<Tenant, 'orgId' | 'locationId'>, input: { slot: number; kind: 'file' | 'link'; label: string; title?: string }): Promise<string> {
  const _id = new Types.ObjectId();
  const orgId = new Types.ObjectId(t.orgId);
  const locationId = new Types.ObjectId(t.locationId);
  const at = server.clock.now();
  await server.connection.collection('tw_calendar_sources').insertOne({
    _id, orgId, locationId, slot: input.slot, kind: input.kind, label: input.label,
    sealedAddress: input.kind === 'link' ? seal(KEY, 'https://calendar.example.test/feed.ics') : null,
    host: input.kind === 'link' ? 'calendar.example.test' : null, googleConnectionId: null, generation: 1, reservedGeneration: 1,
    eventCount: input.title === undefined ? 0 : 1, skippedRepeating: 0, status: 'ok', lastSuccessAt: at, lastAttemptAt: at,
    nextRefreshAt: input.kind === 'link' ? new Date(at.getTime() + 6 * 60 * MINUTE) : null, leaseUntil: null, consecutiveFailures: 0,
    lastManualRefreshAt: null, createdBy: 'fixture', createdAt: at,
  });
  if (input.title !== undefined) {
    await server.connection.collection('tw_calendar_events').insertOne({
      orgId, locationId, sourceId: _id, generation: 1, uid: `${_id.toHexString()}@example.test`, title: input.title,
      startDate: '2026-06-05', endDate: '2026-06-05', startTime: null, endTime: null,
    });
  }
  return _id.toHexString();
}

/** The `townwise.google_calendar_failed` lines logged while `run` runs, each with its fields beyond pino's own. */
async function failuresDuring(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const from = server.logs.length;
  await run();
  return logLines(server).slice(from).filter((line) => line.msg === 'townwise.google_calendar_failed')
    .map((line) => Object.fromEntries(Object.entries(line).filter(([key]) => !LOG_BASE.has(key))));
}

beforeAll(async () => {
  server = await startTownwiseServer({
    calendarKey: KEY, googleCalendar: google.client, googleCalendarClientId: GOOGLE_CLIENT_ID, revokeGoogle: google.revoke,
  });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  google.reset();
  google.state.calendars = [
    { id: SHARED_ID, name: SHARED_NAME, primary: false, accessRole: 'reader' },
    { id: PRIMARY_ID, name: PRIMARY_ID, primary: true, accessRole: 'owner' },
  ];
  google.state.events = { [SHARED_ID]: [allDay('shared-1', TITLE, '2026-06-05')], [PRIMARY_ID]: [allDay('primary-1', 'Dentist', '2026-06-09')] };
});

describe('connecting exchanges the code on the server for the person’s own account', () => {
  it('a first connect stores one sealed connection with the agreement and answers the choices, the primary first', async () => {
    const t = await tenant('First Connect Cafe');
    const now = server.clock.now();
    const res = await connect(t, t.member);
    expect(res).toEqual({
      status: 200,
      body: {
        calendars: [
          { id: PRIMARY_ID, name: PRIMARY_ID, primary: true, added: false },
          { id: SHARED_ID, name: SHARED_NAME, primary: false, added: false },
        ],
      },
    });
    expect(google.callsOf('exchangeCode').map((each) => each.args[0])).toEqual([AUTH_CODE]);
    // The access token the exchange gave reads the list: no second token call.
    expect(google.calls.map((each) => each.method)).toEqual(['exchangeCode', 'listCalendars']);
    const rows = await server.connection.collection('tw_google_connections').find({ orgId: new Types.ObjectId(t.orgId) }).toArray();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('no connection row');
    expect(row).toMatchObject({
      userId: t.member.session.userId, scopes: ALL_SCOPES, agreedAt: now, connectedAt: now, updatedAt: now, revokedAt: null,
      checkAt: new Date(now.getTime() + CHECK_INTERVAL_MS), leaseUntil: null,
    });
    expect(String(row.sealedRefreshToken)).toMatch(/^v1:/);
    expect(open(KEY, String(row.sealedRefreshToken))).toEqual({ ok: true, text: REFRESH_TOKEN });
    expect(Object.keys(row).sort()).toEqual([
      '_id', 'agreedAt', 'checkAt', 'connectedAt', 'leaseUntil', 'orgId', 'revokedAt', 'scopes', 'sealedRefreshToken', 'updatedAt', 'userId',
    ]);
    const events = (await auditEvents(server)).filter((event) => event.action === 'google_calendar.connected' && event.orgId?.toString() === t.orgId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: t.member.session.userId, actorRole: 'member', target: { type: 'google_connection', id: row._id.toString() },
      details: { connectionId: row._id.toString() },
    });
  });

  it('another Google account answers 409 google_other_account and stores nothing', async () => {
    const t = await tenant('Other Account Diner');
    google.state.subject = 'someone-else';
    const res = await send(`${choicesPath(t)}/connect`, t.member.session, { json: { code: AUTH_CODE, agreed: true } });
    expect(res).toMatchObject({ status: 409, body: { error: 'google_other_account' } });
    expect(await connectionRow(t, t.member)).toBeNull();
    expect(google.calls.map((each) => each.method)).toEqual(['exchangeCode']);
  });

  it('no refresh token and no connection: the access token is revoked, nothing is stored, 409 google_connect_again', async () => {
    const t = await tenant('No Refresh Grill');
    google.state.refreshToken = null;
    expect(await connect(t, t.member)).toMatchObject({ status: 409, body: { error: 'google_connect_again' } });
    expect(google.callsOf('revoke').map((each) => each.args[0])).toEqual([ACCESS_TOKEN]);
    expect(await connectionRow(t, t.member)).toBeNull();
  });

  it('a stored token that opens is kept when Google sends none, and the choices answer', async () => {
    const t = await tenant('Kept Token Bistro');
    expect((await connect(t, t.member)).status).toBe(200);
    const before = await connectionRow(t, t.member);
    google.state.refreshToken = null;
    server.clock.advance(MINUTE);
    expect((await connect(t, t.member)).status).toBe(200);
    const after = await connectionRow(t, t.member);
    expect(after?.sealedRefreshToken).toBe(before?.sealedRefreshToken);
    expect(after?.connectedAt).toEqual(server.clock.now());
    expect(google.callsOf('revoke')).toEqual([]);
  });

  it('reconnecting heals revoked calendars: the token replaced, revokedAt cleared, both calendars due at once', async () => {
    const t = await tenant('Healed Tavern');
    const first = await connectedWith(t, t.member, SHARED_ID);
    const second = calendarOf(await addGoogle(t, t.member, PRIMARY_ID));
    await server.connection.collection('tw_google_connections').updateOne(
      { orgId: new Types.ObjectId(t.orgId), userId: t.member.session.userId }, { $set: { revokedAt: server.clock.now() } },
    );
    await server.connection.collection('tw_calendar_sources').updateMany(
      { locationId: new Types.ObjectId(t.locationId) }, { $set: { status: 'google_revoked' } },
    );
    server.clock.advance(MINUTE);
    google.state.refreshToken = '1//fake-refresh-token-renewed';
    expect((await connect(t, t.member)).status).toBe(200);
    const row = await connectionRow(t, t.member);
    expect(row?.revokedAt).toBeNull();
    expect(open(KEY, String(row?.sealedRefreshToken))).toEqual({ ok: true, text: '1//fake-refresh-token-renewed' });
    for (const id of [first.id, second.id]) expect((await sourceRow(id))?.nextRefreshAt).toEqual(server.clock.now());
  });

  it('a dead connection reconnected without a refresh token: revoked, or one the key no longer opens, stays as it is and answers 409 google_connect_again', async () => {
    const t = await tenant('Dead Token Deli');
    expect((await connect(t, t.member)).status).toBe(200);
    google.state.refreshToken = null;
    for (const dead of [{ revokedAt: server.clock.now() }, { revokedAt: null, sealedRefreshToken: seal(OTHER_KEY, REFRESH_TOKEN) }]) {
      await server.connection.collection('tw_google_connections').updateOne(
        { orgId: new Types.ObjectId(t.orgId), userId: t.member.session.userId }, { $set: dead },
      );
      const before = await connectionRow(t, t.member);
      google.calls.length = 0;
      expect(await connect(t, t.member)).toMatchObject({ status: 409, body: { error: 'google_connect_again' } });
      expect(google.callsOf('revoke').map((each) => each.args[0])).toEqual([ACCESS_TOKEN]);
      expect(await connectionRow(t, t.member)).toEqual(before);
    }
  });

  it('refuses a body without agreed: true, a code over 512 characters or another key with 400 invalid_request, calling nothing', async () => {
    const t = await tenant('Strict Body Cafe');
    for (const body of [{ code: AUTH_CODE }, { code: AUTH_CODE, agreed: false }, { code: 'c'.repeat(513), agreed: true }, { code: AUTH_CODE, agreed: true, scope: 'x' }, { code: '', agreed: true }]) {
      expect(await connect(t, t.member, body)).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(google.calls).toEqual([]);
  });

  it('a code Google refuses is 400 google_code_invalid, Google failing is 503 google_unavailable, a missing scope 400 google_scope_missing; nothing is stored', async () => {
    const t = await tenant('Refused Code Kitchen');
    google.on('exchangeCode', () => Promise.reject(googleError('invalid_grant', 400)));
    expect(await connect(t, t.member)).toMatchObject({ status: 400, body: { error: 'google_code_invalid' } });
    google.on('exchangeCode', () => Promise.reject(googleError('unavailable', 503)));
    expect(await connect(t, t.member)).toMatchObject({ status: 503, body: { error: 'google_unavailable' } });
    google.reset();
    google.state.scopes = ['openid', ALL_SCOPES[1] ?? ''];
    expect(await connect(t, t.member)).toMatchObject({ status: 400, body: { error: 'google_scope_missing' } });
    expect(google.callsOf('revoke')).toEqual([]);
    expect(await connectionRow(t, t.member)).toBeNull();
  });
});

describe('Google’s access is sealed and never shown', () => {
  it('the database holds the refresh token and the calendar id only as v1: strings, no access token, and the list carries no Google id', async () => {
    const t = await tenant('Sealed Steakhouse');
    const calendar = await connectedWith(t, t.member, PRIMARY_ID);
    const row = await connectionRow(t, t.member);
    const source = await sourceRow(calendar.id);
    expect(String(row?.sealedRefreshToken)).toMatch(/^v1:/);
    expect(String(source?.sealedAddress)).toMatch(/^v1:/);
    expect(open(KEY, String(source?.sealedAddress))).toEqual({ ok: true, text: PRIMARY_ID });
    expect(source).toMatchObject({ kind: 'google', host: null, googleConnectionId: row?._id, label: 'Google calendar' });
    const stored = JSON.stringify([
      await server.connection.collection('tw_google_connections').find({}).toArray(),
      await server.connection.collection('tw_calendar_sources').find({}).toArray(),
      await server.connection.collection('tw_calendar_events').find({}).toArray(),
      await auditEvents(server),
    ]);
    for (const secret of [REFRESH_TOKEN, ACCESS_TOKEN, AUTH_CODE, PRIMARY_ID]) expect(stored).not.toContain(secret);
    const listed = await send(calendarsPath(t), t.member.session);
    expect(JSON.stringify(listed.body)).not.toContain(PRIMARY_ID);
    expect(listed.body).toEqual({
      calendars: [{ ...calendar }],
      google: { available: true, connected: true, clientId: GOOGLE_CLIENT_ID },
    });
  });
});

describe('the picker lists the person’s own Google calendars', () => {
  it('marks a calendar already on the location as added, the primary first', async () => {
    const t = await tenant('Picker Pub');
    await connectedWith(t, t.member, PRIMARY_ID);
    expect(await choices(t, t.member)).toEqual({
      status: 200,
      body: {
        calendars: [
          { id: PRIMARY_ID, name: PRIMARY_ID, primary: true, added: true },
          { id: SHARED_ID, name: SHARED_NAME, primary: false, added: false },
        ],
      },
    });
  });

  it('409 google_not_connected with no connection, google_reconnect when the refresh answers invalid_grant (written nowhere: a GET only reads) and for a revoked one (no Google call)', async () => {
    const t = await tenant('Reconnect Roadhouse');
    expect(await choices(t, t.member)).toMatchObject({ status: 409, body: { error: 'google_not_connected' } });
    expect((await connect(t, t.member)).status).toBe(200);
    google.on('refreshAccess', () => Promise.reject(googleError('invalid_grant', 400)));
    google.calls.length = 0;
    expect(await writesDuring(server, async () => {
      expect(await choices(t, t.member)).toMatchObject({ status: 409, body: { error: 'google_reconnect' } });
    })).toEqual([]);
    expect((await connectionRow(t, t.member))?.revokedAt).toBeNull();
    expect(google.calls.map((each) => each.method)).toEqual(['refreshAccess']);
    // The next write path records it: here an add, whose refresh Google refuses the same way.
    expect(await addGoogle(t, t.member, SHARED_ID)).toMatchObject({ status: 409, body: { error: 'google_reconnect' } });
    expect((await connectionRow(t, t.member))?.revokedAt).toEqual(server.clock.now());
    google.calls.length = 0;
    expect(await choices(t, t.member)).toMatchObject({ status: 409, body: { error: 'google_reconnect' } });
    expect(google.calls).toEqual([]);
  });

  it('a calendar list Google refuses as unauthorized is 409 google_reconnect, with no write; a rate limit, api_disabled and a 500 are 503 google_unavailable; none is 401', async () => {
    const t = await tenant('List Failure Lounge');
    expect((await connect(t, t.member)).status).toBe(200);
    const statuses: number[] = [];
    for (const [error, answer] of [
      [googleError('rate_limited', 429), 'google_unavailable'], [googleError('api_disabled', 403), 'google_unavailable'],
      [googleError('unavailable', 500), 'google_unavailable'], [googleError('unauthorized', 401), 'google_reconnect'],
    ] as const) {
      google.on('listCalendars', () => Promise.reject(error));
      const writes = await writesDuring(server, async () => {
        const res = await choices(t, t.member);
        statuses.push(res.status);
        expect(res).toMatchObject({ status: answer === 'google_reconnect' ? 409 : 503, body: { error: answer } });
      });
      expect(writes).toEqual([]);
    }
    expect(statuses).not.toContain(401);
    expect((await connectionRow(t, t.member))?.revokedAt).toBeNull();
  });

  it('a new refresh token Google sends to the choices is not kept: the GET writes nothing, and the stored token stays', async () => {
    const t = await tenant('Rotated Picker Pub');
    expect((await connect(t, t.member)).status).toBe(200);
    google.state.rotatedRefreshToken = '1//fake-refresh-token-rotated';
    expect(await writesDuring(server, async () => {
      expect((await choices(t, t.member)).status).toBe(200);
    })).toEqual([]);
    expect(open(KEY, String((await connectionRow(t, t.member))?.sealedRefreshToken))).toEqual({ ok: true, text: REFRESH_TOKEN });
  });

  it('a connect whose choices Google refuses keeps the connection and answers as the picker does', async () => {
    const t = await tenant('Connect List Cafe');
    google.on('listCalendars', () => Promise.reject(googleError('unauthorized', 401)));
    expect(await connect(t, t.member)).toMatchObject({ status: 409, body: { error: 'google_reconnect' } });
    expect((await connectionRow(t, t.member))?.revokedAt).toEqual(server.clock.now());
  });

  it('under view-as the choices answer 403 view_as_read_only and Google is not called; open as admin, every Google route answers 403 open_as_admin_refused', async () => {
    const t = await tenant('Watched Wine Bar');
    expect((await connect(t, t.member)).status).toBe(200);
    google.calls.length = 0;
    const viewing = await signInStaff(server);
    await addGrant(server, { actorUserId: viewing.userId, sessionId: viewing.sessionId, targetUserId: t.member.session.userId, orgId: t.orgId });
    expect(await send(choicesPath(t), viewing)).toMatchObject({ status: 403, body: { error: 'view_as_read_only' } });
    expect(await send(`${choicesPath(t)}/connect`, viewing, { json: { code: AUTH_CODE, agreed: true } }))
      .toMatchObject({ status: 403, body: { error: 'view_as_read_only' } });
    expect(google.calls).toEqual([]);
    await removeStaffFactor(server);

    const orgId = await createOrg(server, { name: `Setup Kitchen ${randomUUID().slice(0, 6)}` });
    const locationId = await addLocation(server, { orgId, name: 'Setup Room' });
    const staff = await signInStaff(server);
    await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId });
    for (const [path, init] of [
      [choicesPath({ locationId }), {}], [`${choicesPath({ locationId })}/connect`, { json: { code: AUTH_CODE, agreed: true } }],
      ['/api/org/google-connection', { method: 'DELETE' }],
      [calendarsPath({ locationId }), { json: { kind: 'google', googleCalendarId: SHARED_ID } }],
    ] as const) {
      expect(await send(path, staff, init)).toMatchObject({ status: 403, body: { error: 'open_as_admin_refused' } });
    }
    expect(google.calls).toEqual([]);
    await removeStaffFactor(server);
  });
});

describe('adding a Google calendar checks it before storing anything', () => {
  it('adds it: 201 with its label and no host, its events stored, the connection’s check pushed on, audited with kind google', async () => {
    const t = await tenant('Added Arcade');
    const calendar = await connectedWith(t, t.member, SHARED_ID);
    expect(calendar).toMatchObject({ label: SHARED_NAME, kind: 'google', host: null, eventCount: 1, skippedRepeating: 0, status: 'ok' });
    expect(await eventTitles(calendar.id)).toEqual([TITLE]);
    expect((await connectionRow(t, t.member))?.checkAt).toEqual(new Date(server.clock.now().getTime() + CHECK_INTERVAL_MS));
    const [event] = (await auditEvents(server)).filter((each) => (each.target as { id: string }).id === calendar.id);
    expect(event).toMatchObject({
      action: 'owner_calendar.added',
      details: { locationId: t.locationId, calendarId: calendar.id, kind: 'google', eventCount: 1, status: 'ok' },
    });
    expect(summaryOf('owner_calendar.added', { kind: 'google', eventCount: 1, status: 'ok' })).toBe('Added a Google calendar with 1 events');
  });

  it('a full location answers 409 calendar_limit with no Google call', async () => {
    const t = await tenant('Full House');
    expect((await connect(t, t.member)).status).toBe(200);
    for (let slot = 0; slot < 5; slot += 1) await insertSource(t, { slot, kind: 'file', label: `File ${String(slot)}` });
    google.calls.length = 0;
    expect(await addGoogle(t, t.member, SHARED_ID)).toMatchObject({ status: 409, body: { error: 'calendar_limit' } });
    expect(google.calls).toEqual([]);
    expect(await sourceCount(t)).toBe(5);
  });

  it('409 google_not_connected without a connection and google_reconnect for a revoked one, with no Google call', async () => {
    const t = await tenant('Unconnected Oyster Bar');
    expect(await addGoogle(t, t.member, SHARED_ID)).toMatchObject({ status: 409, body: { error: 'google_not_connected' } });
    expect((await connect(t, t.member)).status).toBe(200);
    await server.connection.collection('tw_google_connections').updateOne(
      { orgId: new Types.ObjectId(t.orgId), userId: t.member.session.userId }, { $set: { revokedAt: server.clock.now() } },
    );
    google.calls.length = 0;
    expect(await addGoogle(t, t.member, SHARED_ID)).toMatchObject({ status: 409, body: { error: 'google_reconnect' } });
    expect(google.calls).toEqual([]);
  });

  it('the same calendar twice, across two members, is 409 calendar_already_added', async () => {
    const t = await tenant('Shared Shack');
    await connectedWith(t, t.member, SHARED_ID);
    expect((await connect(t, t.teammate)).status).toBe(200);
    expect(await addGoogle(t, t.teammate, SHARED_ID)).toMatchObject({ status: 409, body: { error: 'calendar_already_added' } });
    expect(await sourceCount(t)).toBe(1);
  });

  it('a calendar a teammate added that the caller can’t see answers 400 google_not_found, never calendar_already_added', async () => {
    const t = await tenant('Hidden Hall');
    await connectedWith(t, t.member, SHARED_ID);
    expect((await connect(t, t.teammate)).status).toBe(200);
    google.state.calendars = google.state.calendars.filter((entry) => entry.id !== SHARED_ID);
    expect(await addGoogle(t, t.teammate, SHARED_ID)).toMatchObject({ status: 400, body: { error: 'google_not_found' } });
    expect(await sourceCount(t)).toBe(1);
  });

  it('the primary alias is caught as a duplicate of the stored primary', async () => {
    const t = await tenant('Primary Place');
    await connectedWith(t, t.member, PRIMARY_ID);
    expect(await addGoogle(t, t.member, 'primary')).toMatchObject({ status: 409, body: { error: 'calendar_already_added' } });
    expect(google.callsOf('getCalendar').at(-1)?.args[1]).toBe('primary');
    expect(await sourceCount(t)).toBe(1);
  });

  it('a calendar shared as free and busy only is 400 google_forbidden', async () => {
    const t = await tenant('Busy Bee Bakery');
    google.state.calendars.push({ id: 'c_busy@group.calendar.google.com', name: 'Busy only', primary: false, accessRole: 'freeBusyReader' });
    expect((await connect(t, t.member)).status).toBe(200);
    expect(await addGoogle(t, t.member, 'c_busy@group.calendar.google.com')).toMatchObject({ status: 400, body: { error: 'google_forbidden' } });
    expect(await sourceCount(t)).toBe(0);
  });

  it('names the primary and an email-like name "Google calendar", and cuts a long name at 60 without splitting a pair', async () => {
    const t = await tenant('Label Lodge');
    const long = `${'A'.repeat(59)}\u{1F37D}more`;
    google.state.calendars.push(
      { id: 'c_person@group.calendar.google.com', name: 'alex.guest@example.test', primary: false, accessRole: 'reader' },
      { id: 'c_long@group.calendar.google.com', name: long, primary: false, accessRole: 'writer' },
    );
    expect((await connect(t, t.member)).status).toBe(200);
    const labels: string[] = [];
    for (const id of [PRIMARY_ID, 'primary-skip', 'c_person@group.calendar.google.com', 'c_long@group.calendar.google.com']) {
      if (id === 'primary-skip') continue;
      const added = await addGoogle(t, t.member, id);
      expect(added.status).toBe(201);
      labels.push(calendarOf(added).label);
    }
    expect(labels).toEqual(['Google calendar', 'Google calendar', 'A'.repeat(59)]);
    const stored = JSON.stringify(await server.connection.collection('tw_calendar_sources').find({ locationId: new Types.ObjectId(t.locationId) }).toArray());
    expect(stored).not.toContain('alex.guest@example.test');
  });

  it('a read that fails stores nothing: 503 google_unavailable, logged with its call, status and code only', async () => {
    const t = await tenant('Failed Read Fish House');
    expect((await connect(t, t.member)).status).toBe(200);
    google.on('listEvents', () => Promise.reject(googleError('unavailable', 503)));
    const lines = await failuresDuring(async () => {
      expect(await addGoogle(t, t.member, SHARED_ID)).toMatchObject({ status: 503, body: { error: 'google_unavailable' } });
    });
    expect(lines).toEqual([{ op: 'events', status: 503, code: 'unavailable' }]);
    expect(await sourceCount(t)).toBe(0);
    google.on('listEvents', () => Promise.reject(googleError('not_found', 404)));
    expect(await addGoogle(t, t.member, SHARED_ID)).toMatchObject({ status: 400, body: { error: 'google_not_found' } });
    google.on('listEvents', () => Promise.reject(googleError('forbidden', 403)));
    expect(await addGoogle(t, t.member, SHARED_ID)).toMatchObject({ status: 400, body: { error: 'google_forbidden' } });
    expect(await sourceCount(t)).toBe(0);
  });

  it('a connection ended between the read and the store takes the new calendar with it: 409 google_not_connected', async () => {
    const t = await tenant('Raced Ramen');
    expect((await connect(t, t.member)).status).toBe(200);
    google.on('listEvents', async () => {
      await server.connection.collection('tw_google_connections').deleteOne({ orgId: new Types.ObjectId(t.orgId), userId: t.member.session.userId });
      return { items: [allDay('raced-1', TITLE, '2026-06-05')], nextPageToken: null };
    });
    expect(await addGoogle(t, t.member, SHARED_ID)).toMatchObject({ status: 409, body: { error: 'google_not_connected' } });
    expect(await sourceCount(t)).toBe(0);
    expect(await server.connection.collection('tw_calendar_events').countDocuments({ locationId: new Types.ObjectId(t.locationId) })).toBe(0);
  });
});

describe('refresh now on a Google calendar', () => {
  it('replaces the events, answers 200 ok, and audits owner_calendar.refreshed with kind google; a second one within 5 minutes is 429 with no Google call', async () => {
    const t = await tenant('Refreshed Rotisserie');
    const calendar = await connectedWith(t, t.member, SHARED_ID);
    google.state.events[SHARED_ID] = [allDay('shared-2', LATER_TITLE, '2026-06-12'), allDay('shared-3', 'Graduation lunch', '2026-06-20')];
    server.clock.advance(MINUTE);
    const res = await refreshNow(t, t.member, calendar.id);
    expect(res).toMatchObject({ status: 200, body: { calendar: { id: calendar.id, kind: 'google', status: 'ok', eventCount: 2, host: null } } });
    expect(await eventTitles(calendar.id)).toEqual([LATER_TITLE, 'Graduation lunch']);
    const refreshed = (await auditEvents(server)).filter((each) => each.action === 'owner_calendar.refreshed' && (each.target as { id: string }).id === calendar.id);
    expect(refreshed.map((each) => each.details)).toEqual([{ locationId: t.locationId, calendarId: calendar.id, kind: 'google', eventCount: 2, status: 'ok' }]);
    google.calls.length = 0;
    expect(await refreshNow(t, t.teammate, calendar.id)).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
    expect(google.calls).toEqual([]);
  });

  it('a new refresh token from Google replaces the stored one; invalid_grant records google_revoked, marks the connection revoked, and its other calendar then fails with no Google call', async () => {
    const t = await tenant('Rotated Rib Shack');
    const first = await connectedWith(t, t.member, SHARED_ID);
    const second = calendarOf(await addGoogle(t, t.member, PRIMARY_ID));
    google.state.rotatedRefreshToken = '1//fake-refresh-token-rotated';
    expect((await refreshNow(t, t.member, first.id)).status).toBe(200);
    expect(open(KEY, String((await connectionRow(t, t.member))?.sealedRefreshToken))).toEqual({ ok: true, text: '1//fake-refresh-token-rotated' });
    expect(google.callsOf('refreshAccess').at(-1)?.args[0]).toBe(REFRESH_TOKEN);

    server.clock.advance(6 * MINUTE);
    google.on('refreshAccess', () => Promise.reject(googleError('invalid_grant', 400)));
    expect(await refreshNow(t, t.member, first.id)).toMatchObject({ status: 200, body: { calendar: { status: 'google_revoked', eventCount: 1 } } });
    expect((await connectionRow(t, t.member))?.revokedAt).toEqual(server.clock.now());
    google.calls.length = 0;
    expect(await refreshNow(t, t.member, second.id)).toMatchObject({ status: 200, body: { calendar: { status: 'google_revoked' } } });
    expect(google.calls).toEqual([]);
    expect(await eventTitles(first.id)).toEqual([TITLE]);
  });

  it('a token the key no longer opens records key_mismatch and keeps the events, with no Google call', async () => {
    const t = await tenant('Rekeyed Rotisserie');
    const calendar = await connectedWith(t, t.member, SHARED_ID);
    await server.connection.collection('tw_google_connections').updateOne(
      { orgId: new Types.ObjectId(t.orgId), userId: t.member.session.userId }, { $set: { sealedRefreshToken: seal(OTHER_KEY, REFRESH_TOKEN) } },
    );
    google.calls.length = 0;
    expect(await refreshNow(t, t.member, calendar.id)).toMatchObject({ status: 200, body: { calendar: { status: 'key_mismatch', eventCount: 1 } } });
    expect(google.calls).toEqual([]);
    expect(await eventTitles(calendar.id)).toEqual([TITLE]);
  });

  it('Google refusing the client logs exactly op, status and code, and records google_unavailable', async () => {
    const t = await tenant('Client Refused Cantina');
    const calendar = await connectedWith(t, t.member, SHARED_ID);
    google.on('refreshAccess', () => Promise.reject(googleError('invalid_client', 400)));
    const lines = await failuresDuring(async () => {
      expect(await refreshNow(t, t.member, calendar.id)).toMatchObject({ status: 200, body: { calendar: { status: 'google_unavailable' } } });
    });
    expect(lines).toEqual([{ op: 'token', status: 400, code: 'invalid_client' }]);
  });

  it('a person with no seat any more: their access ends, the calendar is gone (404), and Google’s calendar is not read', async () => {
    const t = await tenant('Departed Diner');
    const calendar = await connectedWith(t, t.member, SHARED_ID);
    // Their seat removed by a request that never ended their access.
    await server.connection.collection('tw_members').updateOne(
      { orgId: new Types.ObjectId(t.orgId), userId: t.member.session.userId }, { $set: { status: 'removed', removedAt: server.clock.now() }, $unset: { activeUserId: '' } },
    );
    google.calls.length = 0;
    expect(await refreshNow(t, t.teammate, calendar.id)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(google.calls.map((each) => each.method)).toEqual(['revoke']);
    expect(google.callsOf('revoke')[0]?.args[0]).toBe(REFRESH_TOKEN);
    expect(await sourceRow(calendar.id)).toBeNull();
    expect(await eventTitles(calendar.id)).toEqual([]);
    expect(await connectionRow(t, t.member)).toBeNull();
  });
});

describe('Google calls are bounded', () => {
  it('the 31st connect or choices call in an hour answers 429 rate_limited and Google is not called', async () => {
    const t = await tenant('Bounded Bar');
    await server.redis.set(limiterKey('townwise:google-calendars', t.member.session.userId), '30', 'EX', 3600);
    expect(await choices(t, t.member)).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
    expect(await connect(t, t.member)).toMatchObject({ status: 429, body: { error: 'rate_limited' } });
    expect(google.calls).toEqual([]);
  });
});

describe('Google connections are audited and logged without content', () => {
  it('Cancel drops an unused connection: revoked, deleted, audited with reason unused; 409 while it backs a calendar, 404 with none', async () => {
    const t = await tenant('Cancelled Creperie');
    expect((await connect(t, t.member)).status).toBe(200);
    const id = String((await connectionRow(t, t.member))?._id);
    expect(await send('/api/org/google-connection', t.member.session, { method: 'DELETE' })).toEqual({ status: 204, body: {} });
    expect(google.callsOf('revoke').map((each) => each.args[0])).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(t, t.member)).toBeNull();
    const [event] = (await auditEvents(server)).filter((each) => each.action === 'google_calendar.disconnected' && (each.target as { id: string }).id === id);
    expect(event).toMatchObject({ target: { type: 'google_connection', id }, details: { connectionId: id, calendarCount: 0, reason: 'unused' } });
    expect(summaryOf('google_calendar.disconnected', { connectionId: id, calendarCount: 0, reason: 'unused' })).toBe('Disconnected a Google account from calendars');
    expect(summaryOf('google_calendar.connected', { connectionId: id })).toBe('Connected a Google account for calendars');
    expect(await send('/api/org/google-connection', t.member.session, { method: 'DELETE' })).toMatchObject({ status: 404, body: { error: 'not_found' } });

    await connectedWith(t, t.member, SHARED_ID);
    expect(await send('/api/org/google-connection', t.member.session, { method: 'DELETE' })).toMatchObject({ status: 409, body: { error: 'google_connection_in_use' } });
    expect(await sourceCount(t)).toBe(1);
  });

  it('each Google failure is one line of exactly op, status and code, and no line holds a token, a code, an id, a name, a title or a URL', async () => {
    const t = await tenant('Logged Lounge');
    expect((await connect(t, t.member)).status).toBe(200);
    const lines = await failuresDuring(async () => {
      google.on('getCalendar', () => Promise.reject(googleError('rate_limited', 429)));
      expect(await addGoogle(t, t.member, SHARED_ID)).toMatchObject({ status: 503, body: { error: 'google_unavailable' } });
      google.on('listCalendars', () => Promise.reject(googleError('api_disabled', 403)));
      expect(await choices(t, t.member)).toMatchObject({ status: 503, body: { error: 'google_unavailable' } });
    });
    expect(lines).toEqual([{ op: 'calendar', status: 429, code: 'rate_limited' }, { op: 'calendar_list', status: 403, code: 'api_disabled' }]);
  });
});

describe('staff never connect, and view-as shows no Google calendar’s name or event title', () => {
  it('under view-as the list and the events show "Google calendar" and "Google calendar event", while a link keeps its own; google.connected is false', async () => {
    const t = await tenant('Private Pavilion');
    google.state.calendars = [{ id: SHARED_ID, name: 'Bookings', primary: false, accessRole: 'reader' }];
    const calendar = await connectedWith(t, t.member, SHARED_ID);
    expect(calendar.label).toBe('Bookings');
    const linkId = await insertSource(t, { slot: 4, kind: 'link', label: 'Trivia nights', title: 'Quiz finals' });
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: t.member.session.userId, orgId: t.orgId });
    google.calls.length = 0;
    const listed = await send(calendarsPath(t), staff);
    expect(listed.status).toBe(200);
    expect((listed.body.calendars as OwnerCalendarView[]).map(({ id, label, kind, host }) => ({ id, label, kind, host }))).toEqual([
      { id: calendar.id, label: 'Google calendar', kind: 'google', host: null },
      { id: linkId, label: 'Trivia nights', kind: 'link', host: 'calendar.example.test' },
    ].sort((a, b) => (a.id === calendar.id ? -1 : b.id === calendar.id ? 1 : 0)));
    expect(listed.body.google).toEqual({ available: true, connected: false, clientId: GOOGLE_CLIENT_ID });
    const events = await send(`${calendarsPath(t)}/events?from=2026-06-01&to=2026-06-30`, staff);
    expect(events.body.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ calendarId: calendar.id, calendar: 'Google calendar', title: 'Google calendar event', startDate: '2026-06-05', endDate: '2026-06-05' }),
      expect.objectContaining({ calendarId: linkId, calendar: 'Trivia nights', title: 'Quiz finals' }),
    ]));
    for (const text of [JSON.stringify(listed.body), JSON.stringify(events.body)]) {
      expect(text).not.toContain('Bookings');
      expect(text).not.toContain(TITLE);
    }
    expect(google.calls).toEqual([]);
    await removeStaffFactor(server);
    // The person themselves sees both.
    const own = await send(`${calendarsPath(t)}/events?from=2026-06-01&to=2026-06-30`, t.member.session);
    expect(JSON.stringify(own.body)).toContain(TITLE);
    expect(JSON.stringify(own.body)).toContain('Bookings');
  });
});

describe('tenant isolation', () => {
  it('another organization’s location or calendar answers 404 on every Google path, with no Google call', async () => {
    const a = await tenant('Alpha Arepas');
    const b = await tenant('Beta Bagels');
    const bCalendar = await connectedWith(b, b.member, SHARED_ID);
    expect((await connect(a, a.member)).status).toBe(200);
    google.calls.length = 0;
    expect(await connect(b, a.member)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await choices(b, a.member)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await addGoogle(b, a.member, SHARED_ID)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await refreshNow(a, a.member, bCalendar.id)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await send(`${calendarsPath(a)}/${bCalendar.id}`, a.member.session, { method: 'DELETE' })).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(google.calls).toEqual([]);
    expect(await sourceRow(bCalendar.id)).not.toBeNull();
    expect(await connectionRow(b, b.member)).not.toBeNull();
  });
});

describe('what this file sent and wrote', () => {
  it('no answer held a token or the code, and no audit event or log line a token, the code, a Google calendar id, a name, a title or a Google URL', async () => {
    expect(answers.length).toBeGreaterThan(40);
    for (const text of answers) {
      for (const secret of [REFRESH_TOKEN, ACCESS_TOKEN, AUTH_CODE, 'fake-refresh-token']) expect(text).not.toContain(secret);
    }
    const audit = JSON.stringify(await auditEvents(server));
    const logs = server.logs.join('\n');
    expect(logs).toContain('townwise.google_calendar_failed');
    expect(logs).toContain('townwise.google_access_ended');
    for (const secret of [
      REFRESH_TOKEN, ACCESS_TOKEN, AUTH_CODE, 'fake-refresh-token', PRIMARY_ID, SHARED_ID, SHARED_NAME, 'Bookings', TITLE, LATER_TITLE,
      'alex.guest@example.test', 'googleapis', 'error_description',
    ]) {
      expect(audit).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  });
});
