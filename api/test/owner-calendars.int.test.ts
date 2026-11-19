// The owner calendar routes (src/handlers/owner-calendars.ts; openspec change connect-owner-calendar: the owner-calendar
// and calendar-subscription specs, design decisions 7 and 10): importing a file, adding a link, the failures that store
// nothing, the 1 MB file and the link-add budget, the 5 calendar limit, "Refresh now" and its one per 5 minutes,
// removal, the events read and its range, tenant isolation, view-as and open as admin, and the audit events' exact
// fields. Nothing here reaches the network: links go through the real guarded fetcher (calendar/fetch.ts) with the real
// address policy, its https.request and its own pinned lookup, to an HTTPS server on 127.0.0.1 whose self-signed
// certificate names the link hosts. The injected lookup answers the test names; the injected transport only changes the
// port, trusts that certificate alone, and, as a NAT on the way would, moves the one public address the names resolve
// to onto 127.0.0.1. No answer, audit event or log line may hold a link's address. Every title here is made up.
// connect-google-calendar: the list answers `google` (off here unless a Google client is passed), and "Refresh now"
// takes a Google calendar, read through helpers/google.ts's fake client, while a file still answers not_a_link. The
// Google routes and the Google add are tested in google-calendars.int.test.ts, ending access in google-access.int.test.ts.
import { createSecretKey, randomBytes, randomUUID } from 'node:crypto';
import type { LookupAddress } from 'node:dns';
import { once } from 'node:events';
import { createServer, request as httpsRequest, type RequestOptions } from 'node:https';
import type { AddressInfo, LookupFunction } from 'node:net';
import type { TLSSocket } from 'node:tls';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { summaryOf } from '../src/audit.ts';
import { createCalendarFetcher, type CalendarFetcher } from '../src/calendar/fetch.ts';
import { MAX_ICS_BYTES } from '../src/calendar/ics.ts';
import { open, seal } from '../src/calendar/secret.ts';
import { utcDay } from '../src/dates.ts';
import { LINK_ADD_BUDGET, type OwnerCalendarView } from '../src/handlers/owner-calendars.ts';
import { MAX_CALENDARS, REFRESH_INTERVAL_MS } from '../src/stores/owner-calendars.ts';
import { localDay } from '../src/time-zones.ts';
import { addGrant, addLocation, addOpenAsAdminGrant, addOwnerCalendar, addSeat, auditEvents, createOrg } from './helpers/fixtures.ts';
import { allDay, AUTH_CODE, createFakeGoogle, GOOGLE_CLIENT_ID, linkGoogle, SHARED_ID } from './helpers/google.ts';
import {
  call, MINUTE, removeStaffFactor, signIn, signInStaff, startTownwiseServer, type TestSession, type TownwiseTestServer,
} from './helpers/server.ts';
import { selfSignedCertificate } from './helpers/tls.ts';

/** The secret part of every link address here: no answer, audit event or log line may hold it. */
const TOKEN = 'owner-secret-token-7f3a';
const ADDRESS = `https://calendar.google.com/calendar/ical/${TOKEN}/basic.ics`;
const LABEL = 'Front desk bookings';
const KEY = createSecretKey(randomBytes(32));
/** A public address the real policy allows; the transport never connects to it, but to the feed server instead. */
const PUBLIC_ADDRESS = '93.184.215.14';
const PUBLIC: readonly LookupAddress[] = [{ address: PUBLIC_ADDRESS, family: 4 }];
const FEED_ADDRESS = '127.0.0.1';
const NAMES: Readonly<Record<string, readonly LookupAddress[]>> = {
  'calendar.google.com': PUBLIC,
  'bookings.example.com': PUBLIC,
  // Public too, but the feed server's certificate does not name it.
  'other.example.net': PUBLIC,
  // The managed-identity endpoint.
  'metadata.example.com': [{ address: '169.254.169.254', family: 4 }],
};
/** The feed server's certificate, naming the link hosts; the transport trusts it and no other. */
const TLS = selfSignedCertificate(['calendar.google.com', 'bookings.example.com']);

function vevent(...lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

function ics(...events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Townwise test//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');
}

/** Two single events in June 2026 (the test clock starts at 2026-06-01T12:00Z), and one repeating event. */
const FIRST = ics(
  vevent('UID:dinner@example.test', 'SUMMARY:Rehearsal dinner', 'DTSTART:20260610T180000', 'DTEND:20260610T210000',
    'DESCRIPTION:Gate code 4417', 'LOCATION:Back room', 'ATTENDEE:mailto:guest@example.test', 'ORGANIZER:mailto:host@example.test'),
  vevent('UID:party@example.test', 'SUMMARY:Office party', 'DTSTART;VALUE=DATE:20260620', 'DTEND;VALUE=DATE:20260621'),
  vevent('UID:trivia@example.test', 'SUMMARY:Weekly trivia', 'DTSTART:20260602T190000', 'RRULE:FREQ=WEEKLY'),
);
/**
 * A calendar CSV export (learn-from-calendar-bookings, D58), its columns as the owner's tool writes them: one event 700
 * days before the test clock's today (2026-06-01), one ahead, one row whose start can't be read, and private columns
 * that must never be kept. Made up.
 */
const CSV_EXPORT = [
  'calendar_id,event_id,title,description,location,start_at,end_at,timezone,status,organizer_email,google_calendar_url',
  'sentinel-calendar@group.example.test,csv-old,Summer reunion,"Call 603-555-0199\nSentinel-description",Sentinel-location,2024-07-01T18:00:00-04:00,2024-07-01T22:00:00-04:00,America/New_York,confirmed,sentinel-organizer@example.test,https://www.google.com/calendar/event?eid=SENTINEL',
  'sentinel-calendar@group.example.test,csv-new,Graduation dinner,,,2026-06-12T19:00:00-04:00,2026-06-12T23:00:00-04:00,America/New_York,confirmed,,',
  'sentinel-calendar@group.example.test,csv-bad,Unreadable,,,someday,,America/New_York,confirmed,,',
].join('\r\n');

/** What the same link answers later: three single events. */
const SECOND = ics(
  vevent('UID:wine@example.test', 'SUMMARY:Wine tasting', 'DTSTART;VALUE=DATE:20260612'),
  vevent('UID:club@example.test', 'SUMMARY:Book club', 'DTSTART;VALUE=DATE:20260615'),
  vevent('UID:lunch@example.test', 'SUMMARY:Graduation lunch', 'DTSTART;VALUE=DATE:20260627'),
);
const JUNE = '?from=2026-06-01&to=2026-06-30';
/** The list's `google` while Google calendars are off (connect-google-calendar): no Google client is passed here. */
const GOOGLE_OFF = { available: false, connected: false, clientId: null, canConnect: false };
/** The list's `bookingSort` with no model here (learn-from-calendar-bookings, D58). */
const SORT_OFF = { available: false };
/** A new file calendar's bookings (D58): unsorted, every event unlabeled. */
function unsorted(events: number): OwnerCalendarView['bookings'] {
  return { state: 'unsorted', sortedAt: null, confirmedAt: null, counts: { buyout: 0, party: 0, own_event: 0, other: 0, unlabeled: events } };
}

/** FIRST padded to exactly `bytes` bytes with lines of 40 to 79 bytes that the parser passes over: about 26,000 CRLFs. */
function padded(bytes: number): string {
  const end = 'END:VCALENDAR\r\n';
  const line = (size: number): string => `X-PAD:${'a'.repeat(size - 8)}\r\n`;
  const room = bytes - FIRST.length;
  const lines = Math.floor(room / 40) - 1;
  return `${FIRST.slice(0, -end.length)}${line(40).repeat(lines)}${line(room - 40 * lines)}${end}`;
}

// The feed server, over HTTPS: what the calendar link answers is set per test.
let feed: { status: number; body: string } = { status: 200, body: FIRST };
/** The TLS server name (SNI) each request to the feed server came with. */
const servernames: (string | false | null)[] = [];
const feedServer = createServer({ key: TLS.key, cert: TLS.cert }, (req, res) => {
  servernames.push((req.socket as TLSSocket).servername);
  const path = new URL(req.url ?? '', 'https://feed.test').pathname;
  if (path === '/page') res.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Bookings</title>');
  else if (path === '/to-private') res.writeHead(302, { Location: 'https://127.0.0.1/cal.ics' }).end();
  else res.writeHead(feed.status, { 'Content-Type': 'text/calendar' }).end(feed.body);
});
let feedPort = 0;
/** Every request the fetcher sent, so a test can see that none was. */
const sent: RequestOptions[] = [];

/**
 * The fetcher's own lookup, which answers only the address it judged, with that answer moved to the feed server's: the
 * public address becomes 127.0.0.1, and any other answer fails the connection.
 */
function throughNat(pinned: LookupFunction): LookupFunction {
  return (hostname, options, callback) => {
    pinned(hostname, options, (error, address, family) => {
      const answered = typeof address === 'string' ? [address] : address.map((entry) => entry.address);
      if (error !== null || answered.some((answer) => answer !== PUBLIC_ADDRESS)) callback(error ?? new Error('not the judged address'), '');
      else if (typeof address === 'string') callback(null, FEED_ADDRESS, family);
      else callback(null, address.map((entry) => ({ ...entry, address: FEED_ADDRESS })));
    });
  };
}

/**
 * The production fetcher and address policy, over the injected lookup and https.request to the feed server: the port
 * changed, the feed server's certificate the only trusted one, and the fetcher's pinned lookup kept (through the NAT).
 */
const fetcher: CalendarFetcher = createCalendarFetcher({
  lookup: (hostname) => {
    const found = NAMES[hostname];
    return found === undefined ? Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' })) : Promise.resolve(found);
  },
  request: (options, onResponse) => {
    sent.push(options);
    if (options.lookup === undefined) throw new Error('the fetcher pinned no address');
    return httpsRequest({ ...options, port: feedPort, ca: TLS.cert, lookup: throughNat(options.lookup) }, onResponse);
  },
  timeoutMs: 2000,
});

let server: TownwiseTestServer;

beforeAll(async () => {
  feedServer.listen(0, FEED_ADDRESS);
  await once(feedServer, 'listening');
  feedPort = (feedServer.address() as AddressInfo).port;
});
afterAll(() => {
  feedServer.closeAllConnections();
  feedServer.close();
});

interface Tenant { orgId: string; locationId: string; member: TestSession; admin: TestSession }

async function tenant(name: string): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `${name} ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  const seat = async (role: 'member' | 'org_admin'): Promise<TestSession> => {
    const email = `${role}-${randomUUID().slice(0, 8)}@example.test`;
    const session = await signIn(server, email);
    await addSeat(server, { orgId, userId: session.userId, email, role });
    return session;
  };
  return { orgId, locationId, member: await seat('member'), admin: await seat('org_admin') };
}

/** Every answer's text, for the check that none holds an address. */
const answers: string[] = [];

async function send(path: string, session: TestSession, init: { method?: string; json?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown>; res: Response }> {
  const res = await call(server, path, { session, ...init });
  const text = await res.text();
  answers.push(text);
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) as Record<string, unknown>, res };
}

function base(t: Pick<Tenant, 'locationId'>, locationId = t.locationId): string {
  return `/api/org/locations/${locationId}/owner-calendars`;
}

function addFile(t: Tenant, label: string, text = FIRST, session = t.member) {
  return send(base(t), session, { json: { kind: 'file', label, ics: text } });
}

function addLink(t: Tenant, url = ADDRESS, session = t.member) {
  return send(base(t), session, { json: { kind: 'link', label: LABEL, url } });
}

function calendarOf(answer: { body: Record<string, unknown> }): OwnerCalendarView {
  return answer.body.calendar as OwnerCalendarView;
}

function sourceCount(t: Pick<Tenant, 'locationId'>): Promise<number> {
  return server.connection.collection('tw_calendar_sources').countDocuments({ locationId: new Types.ObjectId(t.locationId) });
}

function eventRows(calendarId: string) {
  return server.connection.collection('tw_calendar_events').find({ sourceId: new Types.ObjectId(calendarId) }).toArray();
}

async function auditOf(calendarId: string): Promise<Record<string, unknown>[]> {
  return (await auditEvents(server)).filter((event) => (event.target as { id: string }).id === calendarId);
}

async function titles(t: Tenant, query = JUNE): Promise<string[]> {
  const read = await send(`${base(t)}/events${query}`, t.member);
  expect(read.status).toBe(200);
  return (read.body.events as { title: string }[]).map((event) => event.title);
}

describe('with the calendar key', () => {
  beforeAll(async () => { server = await startTownwiseServer({ calendarKey: KEY, calendarFetcher: fetcher }); });
  afterAll(async () => { await server.close(); });
  beforeEach(async () => {
    await server.redis.flushdb();
    feed = { status: 200, body: FIRST };
    sent.length = 0;
    servernames.length = 0;
  });

  it('imports a calendar file: parsed with the town’s today, only titles, dates and hours stored, and audited by ids and counts', async () => {
    const t = await tenant('File Tavern');
    const now = server.clock.now().toISOString();
    const added = await addFile(t, `  ${LABEL}  `);
    expect(added.status).toBe(201);
    const calendar = calendarOf(added);
    expect(calendar).toEqual({
      id: expect.any(String) as string, label: LABEL, kind: 'file', host: null, eventCount: 2, skippedRepeating: 1, status: 'ok',
      lastSuccessAt: now, lastAttemptAt: now, createdAt: now, mine: false, format: 'ics', bookings: unsorted(2),
    });
    expect(added.body.skippedRows).toBe(0);
    expect(sent).toEqual([]);
    expect((await send(base(t), t.admin)).body).toEqual({ calendars: [calendar], google: GOOGLE_OFF, bookingSort: SORT_OFF });

    // An event keeps its UID, title, dates and hours: never its description, location, attendees or organizer.
    const rows = await eventRows(calendar.id);
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['_id', 'endDate', 'endTime', 'generation', 'keyed', 'locationId', 'orgId', 'sourceId', 'startDate', 'startTime', 'title', 'uid']);
    for (const text of ['Gate code', 'Back room', 'guest@example.test', 'host@example.test']) expect(JSON.stringify(rows)).not.toContain(text);

    const read = await send(`${base(t)}/events${JUNE}`, t.member);
    expect(read.body).toEqual({
      events: [
        {
          calendarId: calendar.id, calendar: LABEL, uid: 'dinner@example.test', title: 'Rehearsal dinner', startDate: '2026-06-10',
          endDate: '2026-06-10', startTime: '18:00', endTime: '21:00', booking: null, bookingBy: null,
        },
        {
          calendarId: calendar.id, calendar: LABEL, uid: 'party@example.test', title: 'Office party', startDate: '2026-06-20',
          endDate: '2026-06-20', startTime: null, endTime: null, booking: null, bookingBy: null,
        },
      ],
    });

    const [event, ...more] = await auditOf(calendar.id);
    expect(more).toEqual([]);
    expect(event).toMatchObject({
      action: 'owner_calendar.added', actorUserId: t.member.userId, actorRole: 'member', viewAsGrantId: null,
      orgId: new Types.ObjectId(t.orgId), target: { type: 'owner_calendar', id: calendar.id },
    });
    expect(event?.details).toEqual({ locationId: t.locationId, calendarId: calendar.id, kind: 'file', eventCount: 2, status: 'ok' });
  });

  it('refuses a file that is not a calendar (400 not_calendar) and a bad label or body (400 invalid_request), storing nothing', async () => {
    const t = await tenant('Not Calendar Cafe');
    expect(await addFile(t, LABEL, 'Date,Guests\n2026-06-01,40\n')).toMatchObject({ status: 400, body: { error: 'not_calendar' } });
    for (const json of [
      { kind: 'file', label: '   ', ics: FIRST }, { kind: 'file', label: 'x'.repeat(61), ics: FIRST }, { kind: 'file', label: LABEL },
      { kind: 'feed', label: LABEL, ics: FIRST }, { kind: 'link', label: LABEL, url: '' },
    ]) {
      expect(await send(base(t), t.member, { json })).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await sourceCount(t)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('stores the weekly titles notice on a file or link only when the add says it showed it (titlesNotice: 1), and refuses any other value', async () => {
    const t = await tenant('Notice Grill');
    const shown = calendarOf(await send(base(t), t.member, { json: { kind: 'file', label: LABEL, ics: FIRST, titlesNotice: 1 } }));
    const unshown = calendarOf(await addFile(t, LABEL));
    const link = calendarOf(await send(base(t), t.member, { json: { kind: 'link', label: LABEL, url: ADDRESS, titlesNotice: 1 } }));
    const raw = async (id: string) => server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(id) });
    expect(await raw(shown.id)).toMatchObject({ titlesNotice: 1 });
    expect(await raw(unshown.id)).not.toHaveProperty('titlesNotice');
    expect(await raw(link.id)).toMatchObject({ kind: 'link', titlesNotice: 1 });
    // The answer is the calendar as before: the notice is not part of it.
    expect(Object.keys(shown)).not.toContain('titlesNotice');
    for (const titlesNotice of [2, 0, true, '1', null]) {
      expect(await send(base(t), t.member, { json: { kind: 'file', label: LABEL, ics: FIRST, titlesNotice } }))
        .toMatchObject({ status: 400, body: { error: 'invalid_request' } });
    }
    expect(await sourceCount(t)).toBe(3);
  });

  it('imports a file of exactly 1 MB, whose JSON body is larger still, and refuses one byte more with 400 too_large', async () => {
    const t = await tenant('Big File Inn');
    const atLimit = padded(MAX_ICS_BYTES);
    expect(Buffer.byteLength(atLimit)).toBe(MAX_ICS_BYTES);
    // Every CRLF is 4 bytes in JSON, so the body is over 1 MB by about 5%.
    expect(Buffer.byteLength(JSON.stringify({ kind: 'file', label: LABEL, ics: atLimit }))).toBeGreaterThan(1.05 * MAX_ICS_BYTES);
    expect(await addFile(t, LABEL, atLimit)).toMatchObject({ status: 201, body: { calendar: { kind: 'file', eventCount: 2, skippedRepeating: 1 } } });
    expect(await addFile(t, LABEL, padded(MAX_ICS_BYTES + 1))).toMatchObject({ status: 400, body: { error: 'too_large' } });
    expect(await sourceCount(t)).toBe(1);
  });

  it('imports a calendar CSV (D58): its format stored, rows skipped counted, 700 days back readable, and its other columns kept nowhere', async () => {
    const t = await tenant('Csv Diner');
    const added = await addFile(t, 'Master calendar', CSV_EXPORT);
    expect(added.status).toBe(201);
    const calendar = calendarOf(added);
    expect(calendar).toMatchObject({ kind: 'file', format: 'csv', eventCount: 2, skippedRepeating: 0, bookings: unsorted(2) });
    expect(added.body.skippedRows).toBe(1);
    const rows = await eventRows(calendar.id);
    expect(rows.map((row) => row.uid as string).sort()).toEqual(['csv-new', 'csv-old']);
    const source = await server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(calendar.id) });
    expect(source?.format).toBe('csv');
    const kept = JSON.stringify([rows, source, answers.at(-1), await auditOf(calendar.id)]);
    for (const text of ['Sentinel', 'sentinel', '603-555', 'google.com', 'Unreadable']) expect(kept).not.toContain(text);
    // 700 days back, in the town's wall time.
    expect(await titles(t, '?from=2024-07-01&to=2024-07-31')).toEqual(['Summer reunion']);
    const [event] = await auditOf(calendar.id);
    expect(event?.details).toEqual({ locationId: t.locationId, calendarId: calendar.id, kind: 'file', eventCount: 2, status: 'ok' });

    // A sales export is not a calendar, and stores nothing.
    const before = await sourceCount(t);
    expect(await addFile(t, 'Sales', 'date,guests,net_sales\r\n2026-05-01,120,2400.00\r\n')).toMatchObject({ status: 400, body: { error: 'not_calendar' } });
    expect(await addFile(t, 'Half', 'event_id,title,start_at\r\nx,Party,2026-06-10\r\n')).toMatchObject({ status: 400, body: { error: 'not_calendar' } });
    expect(await sourceCount(t)).toBe(before);
  });

  it('with no model, Sort with TownwiseAI answers 503 chat_unavailable, and with the lab off a confirm says the refresh will learn (D58)', async () => {
    const t = await tenant('Quiet Kitchen');
    const calendar = calendarOf(await addFile(t, 'Master calendar', CSV_EXPORT));
    const bookings = `${base(t)}/${calendar.id}/bookings`;
    expect(await send(`${bookings}/sort`, t.admin, { method: 'POST' })).toMatchObject({ status: 503, body: { error: 'chat_unavailable' } });
    expect(await send(bookings, t.admin, { method: 'PATCH', json: { uid: 'csv-new', booking: 'party' } })).toMatchObject({ status: 200 });
    const confirmed = await send(`${bookings}/confirm`, t.admin, { method: 'POST' });
    expect(confirmed).toMatchObject({ status: 200, body: { notesMade: 1, calibration: { status: 'lab_unavailable', id: null } } });
  });

  it('adds a link: fetched through the guarded fetcher, stored sealed with its host, and shown by its label and host only', async () => {
    const t = await tenant('Link Bistro');
    const now = server.clock.now();
    const added = await addLink(t);
    expect(added.status).toBe(201);
    const calendar = calendarOf(added);
    expect(calendar).toEqual({
      id: expect.any(String) as string, label: LABEL, kind: 'link', host: 'calendar.google.com', eventCount: 2, skippedRepeating: 1,
      status: 'ok', lastSuccessAt: now.toISOString(), lastAttemptAt: now.toISOString(), createdAt: now.toISOString(), mine: false,
      format: null, bookings: null,
    });
    // One request, to the address's path, naming itself only as the calendar reader.
    expect(sent.map((options) => [options.hostname, options.path, options.headers])).toEqual([
      ['calendar.google.com', `/calendar/ical/${TOKEN}/basic.ics`, { 'User-Agent': 'Townwise calendar reader', Accept: 'text/calendar, */*;q=0.5' }],
    ]);
    // Over TLS to the pinned address, with the hostname as the server name the certificate was checked against.
    expect(servernames).toEqual(['calendar.google.com']);

    // The database holds the address only sealed under the key, and the host in plain text; the next refresh is 6 hours out.
    const raw = await server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(calendar.id) });
    expect(raw).toMatchObject({ kind: 'link', host: 'calendar.google.com', nextRefreshAt: new Date(now.getTime() + REFRESH_INTERVAL_MS) });
    expect(JSON.stringify(raw)).not.toContain(TOKEN);
    expect(open(KEY, String(raw?.sealedAddress))).toEqual({ ok: true, text: ADDRESS });

    const listed = await send(base(t), t.member);
    expect(listed.body).toEqual({ calendars: [calendar], google: GOOGLE_OFF, bookingSort: SORT_OFF });
    expect(await titles(t)).toEqual(['Rehearsal dinner', 'Office party']);
    const [event] = await auditOf(calendar.id);
    expect(event?.action).toBe('owner_calendar.added');
    expect(event?.details).toEqual({ locationId: t.locationId, calendarId: calendar.id, kind: 'link', eventCount: 2, status: 'ok' });

    // A webcal: address is fetched as https:.
    expect(calendarOf(await addLink(t, ADDRESS.replace('https:', 'webcal:')))).toMatchObject({ kind: 'link', host: 'calendar.google.com', eventCount: 2 });
  });

  it('refuses a link that answers no calendar, a blocked address and a plain HTTP one, with their codes, storing nothing', async () => {
    const t = await tenant('Refused Diner');
    expect(await addLink(t, 'https://bookings.example.com/page')).toMatchObject({ status: 400, body: { error: 'not_calendar' } });
    expect(sent).toHaveLength(1);
    // A private address, and a name that resolves to the metadata endpoint: no connection is made.
    sent.length = 0;
    expect(await addLink(t, 'https://10.0.0.5/cal.ics')).toMatchObject({ status: 400, body: { error: 'blocked_address' } });
    expect(await addLink(t, 'https://metadata.example.com/metadata/identity/oauth2/token')).toMatchObject({ status: 400, body: { error: 'blocked_address' } });
    expect(sent).toEqual([]);
    // A public address that redirects to a private one: the redirect is not followed.
    expect(await addLink(t, 'https://bookings.example.com/to-private')).toMatchObject({ status: 400, body: { error: 'blocked_address' } });
    expect(sent.map((options) => options.path)).toEqual(['/to-private']);
    sent.length = 0;
    expect(await addLink(t, 'http://calendar.google.com/basic.ics')).toMatchObject({ status: 400, body: { error: 'bad_link' } });
    expect(await addLink(t, 'https://unknown.example.com/basic.ics')).toMatchObject({ status: 400, body: { error: 'unreachable' } });
    // A public name the server's certificate does not name: TLS checks the hostname, not the pinned address.
    servernames.length = 0;
    expect(await addLink(t, 'https://other.example.net/basic.ics')).toMatchObject({ status: 400, body: { error: 'unreachable' } });
    expect(servernames).toEqual([]);
    feed = { status: 500, body: 'broken' };
    expect(await addLink(t)).toMatchObject({ status: 400, body: { error: 'http_error' } });
    expect(await sourceCount(t)).toBe(0);
    expect(await server.connection.collection('tw_calendar_events').countDocuments({ locationId: new Types.ObjectId(t.locationId) })).toBe(0);
    expect((await auditEvents(server)).filter((event) => (event.details as { locationId?: string }).locationId === t.locationId)).toEqual([]);
  });

  it('spends one of the account’s 12 link adds an hour on each add, failed or removed: the next answers 429 and fetches nothing', async () => {
    const t = await tenant('Busy Booker');
    expect(await addLink(t, 'https://bookings.example.com/page')).toMatchObject({ status: 400, body: { error: 'not_calendar' } });
    // Removing a link and adding it again fetches it each time, so each add spends one.
    for (let index = 1; index < LINK_ADD_BUDGET.limit; index += 1) {
      const added = await addLink(t);
      expect(added.status).toBe(201);
      expect((await send(`${base(t)}/${calendarOf(added).id}`, t.member, { method: 'DELETE' })).status).toBe(204);
    }
    expect(sent).toHaveLength(LINK_ADD_BUDGET.limit);
    const refused = await addLink(t);
    expect(refused).toMatchObject({ status: 429, body: { error: 'rate_limited', retryAfterSeconds: expect.any(Number) as number } });
    expect(Number(refused.res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(sent).toHaveLength(LINK_ADD_BUDGET.limit);
    expect(await sourceCount(t)).toBe(0);
    // A file import fetches nothing and spends nothing, and another member's link adds are their own.
    expect((await addFile(t, LABEL)).status).toBe(201);
    expect((await addLink(t, ADDRESS, t.admin)).status).toBe(201);
  });

  it('answers 409 calendar_limit for a sixth calendar, file or link, storing nothing and fetching nothing', async () => {
    const t = await tenant('Full House');
    for (let index = 0; index < MAX_CALENDARS; index += 1) expect((await addFile(t, `Calendar ${String(index)}`)).status).toBe(201);
    expect(await addFile(t, 'One too many')).toMatchObject({ status: 409, body: { error: 'calendar_limit' } });
    expect(await addLink(t)).toMatchObject({ status: 409, body: { error: 'calendar_limit' } });
    expect(sent).toEqual([]);
    expect(await sourceCount(t)).toBe(MAX_CALENDARS);
  });

  it('refresh now: replaces the events, then answers 429 with no fetch inside 5 minutes; a failed refresh keeps the events and records its code', async () => {
    const t = await tenant('Refresh Room');
    const calendar = calendarOf(await addLink(t));
    const addedAt = server.clock.now();
    const refreshPath = `${base(t)}/${calendar.id}/refresh`;

    server.clock.advance(MINUTE);
    feed = { status: 200, body: SECOND };
    sent.length = 0;
    const refreshed = await send(refreshPath, t.member, { method: 'POST' });
    const firstAt = server.clock.now().toISOString();
    expect(refreshed.status).toBe(200);
    expect(calendarOf(refreshed)).toEqual({ ...calendar, eventCount: 3, skippedRepeating: 0, lastSuccessAt: firstAt, lastAttemptAt: firstAt });
    expect(sent).toHaveLength(1);
    expect(await titles(t)).toEqual(['Wine tasting', 'Book club', 'Graduation lunch']);

    // A second within 5 minutes: 429, and nothing is fetched.
    server.clock.advance(4 * MINUTE);
    const tooSoon = await send(refreshPath, t.member, { method: 'POST' });
    expect(tooSoon).toMatchObject({ status: 429, body: { error: 'rate_limited', retryAfterSeconds: 60 } });
    expect(tooSoon.res.headers.get('retry-after')).toBe('60');
    expect(sent).toHaveLength(1);

    // 5 minutes after the last one, the feed is down: the events stay, and the status says why.
    server.clock.advance(MINUTE);
    feed = { status: 503, body: 'down' };
    const failed = await send(refreshPath, t.member, { method: 'POST' });
    const failedAt = server.clock.now().toISOString();
    expect(failed.status).toBe(200);
    expect(calendarOf(failed)).toEqual({
      ...calendar, eventCount: 3, skippedRepeating: 0, status: 'http_error', lastSuccessAt: firstAt, lastAttemptAt: failedAt,
    });
    expect(sent).toHaveLength(2);
    expect(await titles(t)).toEqual(['Wine tasting', 'Book club', 'Graduation lunch']);
    expect(await server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(calendar.id) }))
      .toMatchObject({ consecutiveFailures: 1, nextRefreshAt: new Date(addedAt.getTime() + REFRESH_INTERVAL_MS) });

    expect((await auditOf(calendar.id)).map((event) => [event.action, event.details])).toEqual([
      ['owner_calendar.added', { locationId: t.locationId, calendarId: calendar.id, kind: 'link', eventCount: 2, status: 'ok' }],
      ['owner_calendar.refreshed', { locationId: t.locationId, calendarId: calendar.id, kind: 'link', eventCount: 3, status: 'ok' }],
      ['owner_calendar.refreshed', { locationId: t.locationId, calendarId: calendar.id, kind: 'link', eventCount: 3, status: 'http_error' }],
    ]);
  });

  it('two refreshes at once: one passes, the other answers 429, and the link is fetched once', async () => {
    const t = await tenant('Race Room');
    const calendar = calendarOf(await addLink(t));
    sent.length = 0;
    const both = await Promise.all([1, 2].map(() => send(`${base(t)}/${calendar.id}/refresh`, t.member, { method: 'POST' })));
    expect(both.map((answer) => answer.status).sort()).toEqual([200, 429]);
    expect(sent).toHaveLength(1);
    expect((await auditOf(calendar.id)).map((event) => event.action)).toEqual(['owner_calendar.added', 'owner_calendar.refreshed']);
  });

  it('refreshing a file answers 400 not_a_link, and nothing changes', async () => {
    const t = await tenant('File Refresh');
    const calendar = calendarOf(await addFile(t, LABEL));
    const before = await server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(calendar.id) });
    expect(await send(`${base(t)}/${calendar.id}/refresh`, t.member, { method: 'POST' })).toMatchObject({ status: 400, body: { error: 'not_a_link' } });
    expect(await server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(calendar.id) })).toEqual(before);
    expect(sent).toEqual([]);
  });

  it('a link sealed under another key: the refresh fetches nothing, keeps the events and records key_mismatch', async () => {
    const t = await tenant('Lost Key Lodge');
    const linkId = await addOwnerCalendar(server, { orgId: t.orgId, locationId: t.locationId });
    await server.connection.collection('tw_calendar_sources').updateOne({ _id: new Types.ObjectId(linkId) }, {
      $set: { kind: 'link', sealedAddress: seal(createSecretKey(randomBytes(32)), ADDRESS), host: 'calendar.google.com' },
    });
    const refreshed = await send(`${base(t)}/${linkId}/refresh`, t.member, { method: 'POST' });
    expect(refreshed.status).toBe(200);
    expect(calendarOf(refreshed)).toMatchObject({ kind: 'link', status: 'key_mismatch', eventCount: 2, lastAttemptAt: server.clock.now().toISOString() });
    expect(sent).toEqual([]);
    expect(await eventRows(linkId)).toHaveLength(2);
    expect((await auditOf(linkId)).map((event) => event.details)).toEqual([
      { locationId: t.locationId, calendarId: linkId, kind: 'link', eventCount: 2, status: 'key_mismatch' },
    ]);
  });

  it('removing a calendar deletes it and its events, audited by ids and counts; a second removal is 404', async () => {
    const t = await tenant('Remove Room');
    const kept = calendarOf(await addFile(t, 'Kept', ics(vevent('UID:kept@example.test', 'SUMMARY:Kept event', 'DTSTART;VALUE=DATE:20260605'))));
    const gone = calendarOf(await addLink(t));
    expect((await send(`${base(t)}/${gone.id}`, t.member, { method: 'DELETE' })).status).toBe(204);
    expect(await eventRows(gone.id)).toEqual([]);
    expect(await titles(t)).toEqual(['Kept event']);
    expect((await send(base(t), t.member)).body).toEqual({ calendars: [kept], google: GOOGLE_OFF, bookingSort: SORT_OFF });
    const removed = (await auditOf(gone.id)).at(-1);
    expect(removed).toMatchObject({ action: 'owner_calendar.removed', target: { type: 'owner_calendar', id: gone.id } });
    expect(removed?.details).toEqual({ locationId: t.locationId, calendarId: gone.id, kind: 'link', eventCount: 2 });
    expect(await send(`${base(t)}/${gone.id}`, t.member, { method: 'DELETE' })).toMatchObject({ status: 404, body: { error: 'not_found' } });
  });

  it('reads events over at most 92 days, ending at most 400 days after the town’s today; any other range is 400 bad_range', async () => {
    const t = await tenant('Range Room');
    await addFile(t, LABEL);
    const today = localDay(server.clock.now(), 'America/New_York');
    const day = (offset: number): string => utcDay(new Date(`${today}T00:00:00.000Z`), offset);
    const read = (query: string) => send(`${base(t)}/events${query}`, t.member);
    // 92 days, both ends counted.
    expect((await read(`?from=${today}&to=${day(91)}`)).status).toBe(200);
    expect((await read(`?from=${day(400 - 91)}&to=${day(400)}`)).status).toBe(200);
    for (const query of [
      `?from=${today}&to=${day(92)}`, `?from=${today}&to=${day(119)}`, `?from=${day(401 - 91)}&to=${day(401)}`, `?from=${day(5)}&to=${today}`,
      `?from=${today}`, '', '?from=2026-02-30&to=2026-03-01', '?from=2026-06-01&to=2026-06-30&extra=1', '?from=June&to=July',
    ]) {
      expect({ query, ...(await read(query)).body }).toMatchObject({ query, error: 'bad_range' });
    }
  });

  it('a calendar of another organization or another location answers 404 on every route, and nothing changes', async () => {
    const a = await tenant('Alpine Tavern');
    const b = await tenant('Beachside Bistro');
    const bCalendar = calendarOf(await addLink(b));
    const aPatio = await addLocation(server, { orgId: a.orgId, name: 'Patio' });
    const aCalendar = calendarOf(await addFile(a, LABEL));
    const snapshot = async (): Promise<string> => JSON.stringify([
      await server.connection.collection('tw_calendar_sources').find({ orgId: new Types.ObjectId(b.orgId) }).toArray(),
      await server.connection.collection('tw_calendar_events').find({ orgId: new Types.ObjectId(b.orgId) }).toArray(),
    ]);
    const before = await snapshot();
    sent.length = 0;
    for (const path of [`${base(a)}/${bCalendar.id}`, `${base(b)}/${bCalendar.id}`, `${base(a, aPatio)}/${aCalendar.id}`]) {
      expect(await send(path, a.admin, { method: 'DELETE' })).toMatchObject({ status: 404, body: { error: 'not_found' } });
      expect(await send(`${path}/refresh`, a.admin, { method: 'POST' })).toMatchObject({ status: 404, body: { error: 'not_found' } });
    }
    expect(await send(base(b), a.admin)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await send(`${base(b)}/events${JUNE}`, a.admin)).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await send(base(b), a.admin, { json: { kind: 'file', label: LABEL, ics: FIRST } })).toMatchObject({ status: 404, body: { error: 'not_found' } });
    expect(await snapshot()).toBe(before);
    expect(await sourceCount(a)).toBe(1);
    expect(sent).toEqual([]);
  });

  it('staff viewing as a member read the calendars, and every write is refused by the view-as guard', async () => {
    const t = await tenant('View As Inn');
    const calendar = calendarOf(await addLink(t));
    const staff = await signInStaff(server);
    await addGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, targetUserId: t.member.userId, orgId: t.orgId });
    const before = (await auditEvents(server)).length;
    sent.length = 0;
    expect((await send(base(t), staff)).body).toEqual({ calendars: [calendar], google: GOOGLE_OFF, bookingSort: SORT_OFF });
    expect((await send(`${base(t)}/events${JUNE}`, staff)).status).toBe(200);
    for (const [path, init] of [
      [base(t), { json: { kind: 'file', label: LABEL, ics: FIRST } }], [`${base(t)}/${calendar.id}/refresh`, { method: 'POST' }],
      [`${base(t)}/${calendar.id}`, { method: 'DELETE' }],
    ] as const) {
      expect(await send(path, staff, init)).toMatchObject({ status: 403, body: { error: 'view_as_read_only' } });
    }
    expect(await sourceCount(t)).toBe(1);
    expect(sent).toEqual([]);
    expect((await auditEvents(server)).length).toBe(before);
    await removeStaffFactor(server);
  });

  it('staff with an organization open as its admin add a calendar, recorded as staff', async () => {
    const orgId = await createOrg(server, { name: `Setup Kitchen ${randomUUID().slice(0, 6)}` });
    const locationId = await addLocation(server, { orgId, name: 'Setup Room' });
    const staff = await signInStaff(server);
    const grantId = await addOpenAsAdminGrant(server, { actorUserId: staff.userId, sessionId: staff.sessionId, orgId });
    const added = await send(base({ locationId }), staff, { json: { kind: 'file', label: LABEL, ics: FIRST } });
    expect(added.status).toBe(201);
    const [event] = await auditOf(calendarOf(added).id);
    expect(event).toMatchObject({ action: 'owner_calendar.added', actorUserId: staff.userId, actorRole: 'superadmin', viewAsGrantId: grantId });
    await removeStaffFactor(server);
  });

  it('words the audit events by kind, count and status only', () => {
    expect(summaryOf('owner_calendar.added', { kind: 'link', eventCount: 12, status: 'ok' })).toBe('Added a calendar link with 12 events');
    expect(summaryOf('owner_calendar.added', { kind: 'file', eventCount: 3, status: 'ok' })).toBe('Added a calendar file with 3 events');
    expect(summaryOf('owner_calendar.removed', { kind: 'file', eventCount: 3 })).toBe('Removed a calendar file');
    expect(summaryOf('owner_calendar.refreshed', { kind: 'link', eventCount: 4, status: 'ok' })).toBe('Refreshed a calendar link: 4 events');
    expect(summaryOf('owner_calendar.refreshed', { kind: 'link', eventCount: 4, status: 'timeout' })).toBe('Refreshing a calendar link failed (timeout)');
  });

  it('no answer, audit event or log line held a link’s address, and no audit event or log line a label, host or title', async () => {
    expect(answers.length).toBeGreaterThan(20);
    for (const text of answers) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(ADDRESS);
    }
    const audit = JSON.stringify(await auditEvents(server));
    const logs = server.logs.join('\n');
    expect(audit).toContain('owner_calendar.refreshed');
    for (const secret of [TOKEN, 'calendar.google.com', LABEL, 'Rehearsal dinner', 'Office party', 'Wine tasting']) {
      expect(audit).not.toContain(secret);
      expect(logs).not.toContain(secret);
    }
  });
});

describe('without the calendar key', () => {
  const fetch = vi.fn<CalendarFetcher['fetch']>();

  beforeAll(async () => { server = await startTownwiseServer({ calendarFetcher: { fetch } }); });
  afterAll(async () => { await server.close(); });

  it('adding or refreshing a link answers 503 calendar_links_unavailable and fetches nothing, while a file still imports', async () => {
    const t = await tenant('Keyless Kitchen');
    expect(await addLink(t)).toMatchObject({ status: 503, body: { error: 'calendar_links_unavailable' } });
    expect(await sourceCount(t)).toBe(0);

    // A link stored while the key was set.
    const linkId = await addOwnerCalendar(server, { orgId: t.orgId, locationId: t.locationId });
    await server.connection.collection('tw_calendar_sources').updateOne(
      { _id: new Types.ObjectId(linkId) }, { $set: { kind: 'link', sealedAddress: 'v1:sealed', host: 'calendar.google.com' } },
    );
    expect(await send(`${base(t)}/${linkId}/refresh`, t.member, { method: 'POST' })).toMatchObject({ status: 503, body: { error: 'calendar_links_unavailable' } });
    expect(await server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(linkId) })).toMatchObject({ lastManualRefreshAt: null });

    expect(await addFile(t, LABEL)).toMatchObject({ status: 201, body: { calendar: { kind: 'file', eventCount: 2 } } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('with Google calendars on', () => {
  const google = createFakeGoogle();

  beforeAll(async () => {
    server = await startTownwiseServer({
      calendarKey: KEY, calendarFetcher: fetcher, googleCalendar: google.client, googleCalendarClientId: GOOGLE_CLIENT_ID, revokeGoogle: google.revoke,
    });
  });
  afterAll(async () => { await server.close(); });
  beforeEach(async () => {
    await server.redis.flushdb();
    google.reset();
    sent.length = 0;
  });

  it('lists a Google calendar with the list’s google, refreshes it now as any member, and still refuses a file’s refresh with not_a_link', async () => {
    const t = await tenant('Google Grill');
    await linkGoogle(server, t.member.userId, 'google-subject-grill');
    google.state.subject = 'google-subject-grill';
    google.state.events = { [SHARED_ID]: [allDay('shared-1', 'Wine tasting', '2026-06-12')] };
    const file = calendarOf(await addFile(t, LABEL));
    expect((await send(`/api/org/locations/${t.locationId}/google-calendars/connect`, t.member, { json: { code: AUTH_CODE, agreed: true } })).status).toBe(200);
    const added = await send(base(t), t.member, { json: { kind: 'google', googleCalendarId: SHARED_ID } });
    expect(added.status).toBe(201);
    const calendar = calendarOf(added);
    expect(calendar).toMatchObject({ kind: 'google', host: null, eventCount: 1, skippedRepeating: 0, status: 'ok', mine: true });
    // Connected and mine are the caller's own: the admin, who never connected and added no Google calendar, reads false.
    expect((await send(base(t), t.member)).body).toEqual({
      calendars: [file, calendar], google: { available: true, connected: true, clientId: GOOGLE_CLIENT_ID, canConnect: true }, bookingSort: SORT_OFF,
    });
    expect((await send(base(t), t.admin)).body).toEqual({
      calendars: [file, { ...calendar, mine: false }], google: { available: true, connected: false, clientId: GOOGLE_CLIENT_ID, canConnect: true },
      bookingSort: SORT_OFF,
    });

    google.state.events[SHARED_ID] = [allDay('shared-2', 'Book club', '2026-06-15'), allDay('shared-3', 'Graduation lunch', '2026-06-27')];
    server.clock.advance(MINUTE);
    const refreshed = await send(`${base(t)}/${calendar.id}/refresh`, t.admin, { method: 'POST' });
    const at = server.clock.now().toISOString();
    expect(refreshed.status).toBe(200);
    expect(calendarOf(refreshed)).toEqual({ ...calendar, eventCount: 2, lastSuccessAt: at, lastAttemptAt: at, mine: false });
    expect(await titles(t)).toEqual(['Rehearsal dinner', 'Book club', 'Office party', 'Graduation lunch']);
    expect((await auditOf(calendar.id)).map((event) => [event.action, event.details])).toEqual([
      ['owner_calendar.added', { locationId: t.locationId, calendarId: calendar.id, kind: 'google', eventCount: 1, status: 'ok' }],
      ['owner_calendar.refreshed', { locationId: t.locationId, calendarId: calendar.id, kind: 'google', eventCount: 2, status: 'ok' }],
    ]);
    expect(await send(`${base(t)}/${file.id}/refresh`, t.member, { method: 'POST' })).toMatchObject({ status: 400, body: { error: 'not_a_link' } });
    expect(sent).toEqual([]);
  });
});
