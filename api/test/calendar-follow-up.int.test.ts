// The deterministic follow-up at the three places a replace switches in a calendar's events (src/calendar/follow-up.ts
// followLinkedNotes, openspec change calendar-event-suggestions, design decision 3): the refresh loop and Refresh now
// each make one `move` for a moved party and a `remove` for a canceled one, change nothing on a second refresh, make
// none after a failed one, and leave an open one as it is; an add whose Google connection ended meanwhile removes its
// calendar before any follow-up runs; a location deleted while it ran keeps nothing; and a follow-up that fails is
// logged by the calendar's id while the refresh stands. Log lines hold no uid or title. Every title here is made up; the
// test clock reads Mon, Jun 1, 2026 (Hanover).
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';

import { createLogger } from '@ckeith26/server-core';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import type { CalendarFetcher, CalendarFetchResult } from '../src/calendar/fetch.ts';
import { followLinkedNotes } from '../src/calendar/follow-up.ts';
import { parseIcs } from '../src/calendar/ics.ts';
import { createCalendarRefresher } from '../src/calendar/refresher.ts';
import { seal } from '../src/calendar/secret.ts';
import type { NoteView } from '../src/handlers/notes.ts';
import { createTownwiseStores, type TownwiseStores } from '../src/stores/index.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { AUTH_CODE, createFakeGoogle, GOOGLE_CLIENT_ID, linkGoogle, SHARED_ID, allDay } from './helpers/google.ts';
import { call, MINUTE, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const KEY = createSecretKey(randomBytes(32));
const HOST = 'calendar.google.com';
const TOWN = { today: '2026-06-01', timeZone: 'America/New_York' };
const PARTY = 'party-0001@bookings.example.test';
const LUNCH = 'lunch-0002@bookings.example.test';
const PARTY_TITLE = 'Sentinel Pemberton rehearsal dinner';

function vevent(...lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

function ics(...events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Townwise test//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');
}

const party = (day: string): string => vevent(`UID:${PARTY}`, `SUMMARY:${PARTY_TITLE}`, `DTSTART:${day}T180000`, `DTEND:${day}T220000`);
const lunch = vevent(`UID:${LUNCH}`, 'SUMMARY:Graduation lunch', 'DTSTART;VALUE=DATE:20260615');
/** The party on Sat, Jun 13, then moved a week to Sat, Jun 20, then canceled. */
const ON_13 = ics(party('20260613'), lunch);
const ON_20 = ics(party('20260620'), lunch);
const CANCELED = ics(lunch);

let server: TownwiseTestServer;
let stores: TownwiseStores;
const google = createFakeGoogle();
/** What the link answers next. */
let answer: CalendarFetchResult = { ok: true, text: ON_13, host: HOST };
const fetcher: CalendarFetcher = { fetch: () => Promise.resolve(answer) };
const loopLogs: string[] = [];
const logger = createLogger({ LOG_LEVEL: 'info' }, { destination: { write: (line: string) => { loopLogs.push(line); } } });

beforeAll(async () => {
  server = await startTownwiseServer({
    calendarKey: KEY, calendarFetcher: fetcher, googleCalendar: google.client, googleCalendarClientId: GOOGLE_CLIENT_ID, revokeGoogle: google.revoke,
  });
  stores = createTownwiseStores(server.connection);
});
afterAll(async () => { await server.close(); });
afterEach(() => {
  vi.restoreAllMocks();
  google.reset();
  answer = { ok: true, text: ON_13, host: HOST };
});

interface Tenant { orgId: string; locationId: string; scope: OrgScope; member: TestSession; subject: string }

async function tenant(): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Follow Bistro ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  const email = `member-${randomUUID().slice(0, 8)}@example.test`;
  const member = await signIn(server, email);
  await addSeat(server, { orgId, userId: member.userId, email, role: 'member' });
  const subject = `google-${randomUUID()}`;
  await linkGoogle(server, member.userId, subject);
  return { orgId, locationId, scope: scopeForNewOrg(STAFF, orgId), member, subject };
}

/** A link calendar holding ON_13, stored as an add leaves it. */
async function addLink(t: Tenant): Promise<string> {
  const parsed = parseIcs(ON_13, TOWN);
  if ('error' in parsed) throw new Error(parsed.error);
  const added = await stores.ownerCalendars.add(t.scope, t.locationId, {
    kind: 'link', label: 'Front desk bookings', sealedAddress: seal(KEY, `https://${HOST}/calendar/ical/secret-${randomUUID()}/basic.ics`), host: HOST,
  }, parsed, { createdBy: t.member.userId, now: server.clock.now() });
  if (added === 'calendar_limit') throw new Error('calendar_limit');
  return added.id;
}

/** Make a note on the party, as a member: a buyout of 40, linked to the event. */
async function partyNote(t: Tenant, calendarId: string): Promise<NoteView> {
  const res = await call(server, `/api/org/locations/${t.locationId}/notes`, {
    session: t.member,
    json: {
      kind: 'private_event', startDate: '2026-06-13', endDate: '2026-06-13', startTime: '18:00', endTime: '22:00', effect: 'closed',
      expectedGuests: 40, fromEvent: { calendarId, uid: PARTY },
    },
  });
  expect(res.status).toBe(201);
  const { note } = await res.json() as { note: NoteView };
  expect(note.fromEvent).toMatchObject({ calendarId, uid: PARTY, startDate: '2026-06-13' });
  return note;
}

/** Only this calendar is due, so the loop claims nothing of another test's. */
async function onlyDue(calendarId: string): Promise<void> {
  const sources = server.connection.collection('tw_calendar_sources');
  await sources.updateMany({}, { $set: { nextRefreshAt: new Date('2099-01-01T00:00:00.000Z') } });
  await sources.updateOne({ _id: new Types.ObjectId(calendarId) }, { $set: { nextRefreshAt: server.clock.now() } });
}

async function loop(calendarId: string, deps: { stores?: TownwiseStores } = {}): Promise<number> {
  await onlyDue(calendarId);
  return createCalendarRefresher({
    connection: server.connection, stores: deps.stores ?? stores, key: KEY, logger, now: server.clock.now, fetcher,
    googleCalendar: google.client, revokeGoogle: google.revoke,
  }).drain();
}

function refreshNow(t: Tenant, calendarId: string): Promise<Response> {
  return call(server, `/api/org/locations/${t.locationId}/owner-calendars/${calendarId}/refresh`, { session: t.member, method: 'POST' });
}

function suggestionRows(t: Tenant) {
  return server.connection.collection('tw_agent_suggestions').find({ locationId: new Types.ObjectId(t.locationId) }).sort({ _id: 1 }).toArray();
}

/** The loop's log lines with this message, without pino's own fields. */
function logged(msg: string): Record<string, unknown>[] {
  return loopLogs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === msg)
    .map((line) => Object.fromEntries(Object.entries(line).filter(([key]) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key))));
}

describe('the follow-up where events are switched in', () => {
  it('the refresh loop makes one move for a moved party, leaving the note as it is; a second refresh changes nothing', async () => {
    const t = await tenant();
    const calendarId = await addLink(t);
    const note = await partyNote(t, calendarId);
    loopLogs.length = 0;
    answer = { ok: true, text: ON_20, host: HOST };
    expect(await loop(calendarId)).toBe(1);

    const [move, ...others] = await suggestionRows(t);
    expect(others).toEqual([]);
    expect(move).toMatchObject({
      type: 'move', status: 'open', week: '2026-06-01', why: null, openFollowFor: new Types.ObjectId(note.id),
      content: { kind: 'private_event', startDate: '2026-06-20', endDate: '2026-06-20', startTime: '18:00', endTime: '22:00', expectedGuests: 40 },
      follow: { noteId: new Types.ObjectId(note.id), change: 'moved', from: { startDate: '2026-06-13' }, to: { startDate: '2026-06-20' } },
    });
    expect(await stores.notes.find(t.scope, t.locationId, note.id)).toMatchObject({ startDate: '2026-06-13', fromEvent: { startDate: '2026-06-13' } });
    expect(logged('townwise.calendar_followups')).toEqual([{ calendarId, moved: 1, gone: 0, expired: 0 }]);
    for (const secret of [PARTY, PARTY_TITLE]) expect(loopLogs.join('\n')).not.toContain(secret);

    server.clock.advance(MINUTE);
    expect(await loop(calendarId)).toBe(1);
    expect(await suggestionRows(t)).toEqual([move]);
    expect(logged('townwise.calendar_followups')).toHaveLength(1);
  });

  it('Refresh now makes one move, then a removal in its place once the party is canceled', async () => {
    const t = await tenant();
    const calendarId = await addLink(t);
    const note = await partyNote(t, calendarId);
    server.logs.length = 0;
    answer = { ok: true, text: ON_20, host: HOST };
    expect((await refreshNow(t, calendarId)).status).toBe(200);
    const [move] = await suggestionRows(t);
    expect(move).toMatchObject({ type: 'move', content: { startDate: '2026-06-20' } });

    server.clock.advance(6 * MINUTE);
    answer = { ok: true, text: CANCELED, host: HOST };
    expect((await refreshNow(t, calendarId)).status).toBe(200);
    const rows = await suggestionRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      _id: move?._id, type: 'remove', status: 'open', content: { startDate: '2026-06-13' }, follow: { change: 'gone', to: null },
    });
    expect(await stores.notes.find(t.scope, t.locationId, note.id)).not.toBeNull();
    for (const secret of [PARTY, PARTY_TITLE]) expect(server.logs.join('\n')).not.toContain(secret);
  });

  it('a failed refresh makes none, and leaves an open follow-up as it is', async () => {
    const t = await tenant();
    const calendarId = await addLink(t);
    await partyNote(t, calendarId);
    answer = { ok: false, code: 'unreachable' };
    expect(await loop(calendarId)).toBe(1);
    expect(await suggestionRows(t)).toEqual([]);

    answer = { ok: true, text: ON_20, host: HOST };
    server.clock.advance(MINUTE);
    await loop(calendarId);
    const open = await suggestionRows(t);
    expect(open).toHaveLength(1);
    answer = { ok: false, code: 'unreachable' };
    server.clock.advance(MINUTE);
    await loop(calendarId);
    expect(await suggestionRows(t)).toEqual(open);
  });

  it('an add runs it after the Google check, so an add whose connection ended meanwhile removes its calendar first', async () => {
    const t = await tenant();
    const find = vi.spyOn(server.connection.models.TwNote as unknown as Record<'find', (...args: unknown[]) => unknown>, 'find');
    const followUpReads = () => find.mock.calls.filter(([filter]) => JSON.stringify(filter).includes('fromEvent.calendarId')).length;
    // A file add runs it once.
    const file = await call(server, `/api/org/locations/${t.locationId}/owner-calendars`, {
      session: t.member, json: { kind: 'file', label: 'Bookings', ics: ON_13 },
    });
    expect(file.status).toBe(201);
    expect(followUpReads()).toBe(1);

    google.state.subject = t.subject;
    expect((await call(server, `/api/org/locations/${t.locationId}/google-calendars/connect`, { session: t.member, json: { code: AUTH_CODE, agreed: true } })).status).toBe(200);
    google.on('listEvents', async () => {
      await server.connection.collection('tw_google_connections').deleteOne({ orgId: new Types.ObjectId(t.orgId), userId: t.member.userId });
      return { items: [allDay('raced-1', PARTY_TITLE, '2026-06-13')], nextPageToken: null };
    });
    const added = await call(server, `/api/org/locations/${t.locationId}/owner-calendars`, { session: t.member, json: { kind: 'google', googleCalendarId: SHARED_ID } });
    expect(added.status).toBe(409);
    expect(followUpReads()).toBe(1);
    expect(await server.connection.collection('tw_calendar_sources').countDocuments({ locationId: new Types.ObjectId(t.locationId), kind: 'google' })).toBe(0);
    expect(await suggestionRows(t)).toEqual([]);
  });

  it('a location deleted while it ran keeps nothing it wrote', async () => {
    const t = await tenant();
    const calendarId = await addLink(t);
    await partyNote(t, calendarId);
    answer = { ok: true, text: ON_20, host: HOST };
    const parsed = parseIcs(ON_20, TOWN);
    if ('error' in parsed) throw new Error(parsed.error);
    const replaced = await stores.ownerCalendars.replaceEvents(t.scope, t.locationId, calendarId, parsed, server.clock.now());
    if (!replaced.switched) throw new Error('not switched');
    const location = await stores.locations.find(t.scope, t.locationId);
    if (location === null) throw new Error('no location');
    // Gone by the time the follow-up looks again, after its writes.
    const gone: TownwiseStores = { ...stores, locations: { ...stores.locations, find: () => Promise.resolve(null) } };
    await followLinkedNotes({ stores: gone, logger }, t.scope, location, calendarId, replaced, server.clock.now());
    expect(await suggestionRows(t)).toEqual([]);
    // With the location there, the same run keeps its move.
    await followLinkedNotes({ stores, logger }, t.scope, location, calendarId, replaced, server.clock.now());
    expect((await suggestionRows(t)).map((row): unknown => row.type)).toEqual(['move']);
  });

  it('a follow-up that fails is logged by the calendar’s id only, and the refresh stands', async () => {
    const t = await tenant();
    const calendarId = await addLink(t);
    await partyNote(t, calendarId);
    loopLogs.length = 0;
    answer = { ok: true, text: ON_20, host: HOST };
    const failing: TownwiseStores = { ...stores, notes: { ...stores.notes, linkedTo: () => Promise.reject(new Error(`boom ${PARTY}`)) } };
    expect(await loop(calendarId, { stores: failing })).toBe(1);
    expect(logged('townwise.calendar_followup_failed')).toEqual([{ calendarId }]);
    expect(logged('townwise.calendar_refreshed')).toEqual([expect.objectContaining({ calendarId, status: 'ok' })]);
    expect((await stores.ownerCalendars.eventsBetween(t.scope, t.locationId, { from: '2026-06-01', to: '2026-06-30' })).map((event) => event.startDate))
      .toEqual(['2026-06-15', '2026-06-20']);
    expect(await suggestionRows(t)).toEqual([]);
    expect(loopLogs.join('\n')).not.toContain(PARTY);
  });
});
