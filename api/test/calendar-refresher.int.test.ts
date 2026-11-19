// The calendar refresh loop (src/calendar/refresher.ts; openspec change connect-owner-calendar: the
// calendar-subscription spec, design decision 6), against the database with the test clock and an injected fetcher, so
// nothing reaches the network: the cross-tenant claim and its lease, two refreshers racing for the same due links, a
// success that replaces the events, a failure that keeps them and records its code, the backoff (6 hours, then 24), an
// address the key no longer opens, a suspended organization, a location or organization deleted mid-refresh, a refresh
// that throws and one that outlives its lease, the loop's start and close (a fetch in flight dropped inside a shutdown
// hook's 2 seconds, the writes in flight waited for), and log lines that hold no address, host, label or title.
// Google calendars and the connection check (openspec change connect-google-calendar: the google-calendar spec, design
// decision 10), through the fake client of helpers/google.ts, which records every call: a refresh, a refused refresh
// token, a missing connection, a seat removed with its access never ended (and one removed moments ago), a key that no
// longer opens, the client off, Google's rate limit and the Calendar API switched off, claims across kinds; the check
// ending an unused connection, one with no seat, an interrupted end and an interrupted location deletion, leaving a
// seat that may yet come back, pushing a connection in use 24 hours on, keeping a new unused one through a last
// admin's refused removal until a day after its connect, and keeping a connection due when a mark comes in during its
// check; close aborting a Google read and a check's revoke; and two replicas never checking one connection twice.
// Every title and name here is made up.
import { createSecretKey, randomBytes, randomUUID, type KeyObject } from 'node:crypto';

import { createLogger } from '@ckeith26/server-core';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import type { CalendarFetcher, CalendarFetchResult } from '../src/calendar/fetch.ts';
import { SEAT_SETTLE_MS } from '../src/calendar/google-access.ts';
import type { IcsEvent } from '../src/calendar/ics.ts';
import { createCalendarRefresher, type CalendarRefresher } from '../src/calendar/refresher.ts';
import { open, seal } from '../src/calendar/secret.ts';
import { claimDueCalendar, claimDueGoogleConnection } from '../src/stores/cross-tenant.ts';
import type { GoogleConnectionStore } from '../src/stores/google-connections.ts';
import { createTownwiseStores, type TownwiseStores } from '../src/stores/index.ts';
import type { OwnerCalendarRecord, OwnerCalendarStore } from '../src/stores/owner-calendars.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import {
  ACCESS_TOKEN, addGoogleCalendar, addGoogleConnection, allDay, createFakeGoogle, googleError, PRIMARY_ID, REFRESH_TOKEN, SHARED_ID,
} from './helpers/google.ts';
import { MINUTE, startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const HOUR = 60 * MINUTE;
/** A claim's lease, calendars and connection checks alike (refresher.ts LEASE_MS). */
const LEASE = 5 * MINUTE;
const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const KEY = createSecretKey(randomBytes(32));
/** The secret part of every address here: no log line may hold it, nor the host, the label or a title. */
const TOKEN = 'owner-secret-token-41c9';
const HOST = 'calendar.google.com';
const LABEL = 'Front desk bookings';
/** The test clock starts at 2026-06-01T12:00Z. */
const JUNE = { from: '2026-06-01', to: '2026-06-30' };

function vevent(...lines: string[]): string {
  return ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');
}

function ics(...events: string[]): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Townwise test//EN', ...events, 'END:VCALENDAR', ''].join('\r\n');
}

/** What a link holds when it is added: two single events. */
const ADDED: IcsEvent[] = [
  { uid: 'dinner@example.test', title: 'Rehearsal dinner', startDate: '2026-06-10', endDate: '2026-06-10', startTime: '18:00', endTime: '21:00', keyed: true },
  { uid: 'party@example.test', title: 'Office party', startDate: '2026-06-20', endDate: '2026-06-20', startTime: null, endTime: null, keyed: true },
];
/** What the link answers later: three single events and a repeating one. */
const LATER = ics(
  vevent('UID:wine@example.test', 'SUMMARY:Wine tasting', 'DTSTART;VALUE=DATE:20260612'),
  vevent('UID:club@example.test', 'SUMMARY:Book club', 'DTSTART;VALUE=DATE:20260615'),
  vevent('UID:lunch@example.test', 'SUMMARY:Graduation lunch', 'DTSTART;VALUE=DATE:20260627'),
  vevent('UID:trivia@example.test', 'SUMMARY:Weekly trivia', 'DTSTART:20260602T190000', 'RRULE:FREQ=WEEKLY'),
);
const ADDED_TITLES = ['Rehearsal dinner', 'Office party'];
const LATER_TITLES = ['Wine tasting', 'Book club', 'Graduation lunch'];
/** server-core's budget for each shutdown hook (lifecycle.ts): Redis and Mongo close after it, done or not. */
const HOOK_BUDGET_MS = 2000;
/** What every Google calendar here holds when it is added (helpers/google.ts addGoogleCalendar). */
const STORED_TITLE = 'Private dinner';
/** What the fake answers for the shared calendar later. */
const GOOGLE_TITLES = ['Staff holiday party', 'Wine dinner'];
/** A refresh token Google sends with an access token, replacing the stored one. */
const ROTATED_TOKEN = '1//fake-rotated-refresh-token-5e0d';

let server: TownwiseTestServer;
let stores: TownwiseStores;
const logs: string[] = [];
const logger = createLogger({ LOG_LEVEL: 'info' }, { destination: { write: (line: string) => { logs.push(line); } } });
const google = createFakeGoogle();

beforeAll(async () => {
  server = await startTownwiseServer();
  stores = createTownwiseStores(server.connection);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  // Each test sees only its own calendars and connections: the loop claims due ones in every organization.
  await server.connection.collection('tw_calendar_sources').deleteMany({});
  await server.connection.collection('tw_calendar_events').deleteMany({});
  await server.connection.collection('tw_google_connections').deleteMany({});
  logs.length = 0;
  google.reset();
  google.state.events = { [SHARED_ID]: [allDay('google-1', 'Staff holiday party', '2026-06-12'), allDay('google-2', 'Wine dinner', '2026-06-18')] };
});

interface Tenant { orgId: string; locationId: string; scope: OrgScope }

async function tenant(status: 'active' | 'suspended' = 'active'): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Refresh Cafe ${randomUUID().slice(0, 6)}`, status });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, locationId, scope: scopeForNewOrg(STAFF, orgId) };
}

let links = 0;

/** A link calendar holding ADDED, sealed under `key`, due now. Resolves it and its address. */
async function addLink(t: Tenant, key: KeyObject = KEY): Promise<{ calendar: OwnerCalendarRecord; address: string }> {
  links += 1;
  const address = `https://${HOST}/calendar/ical/${TOKEN}-${String(links)}/basic.ics`;
  const added = await stores.ownerCalendars.add(t.scope, t.locationId, { kind: 'link', label: LABEL, sealedAddress: seal(key, address), host: HOST },
    { events: ADDED, skippedRepeating: 0 }, { createdBy: 'user-0001', now: server.clock.now() });
  if (added === 'calendar_limit') throw new Error('calendar_limit');
  await makeDue(added.id);
  return { calendar: added, address };
}

function source(calendarId: string) {
  return server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(calendarId) });
}

function setSource(calendarId: string, fields: Record<string, unknown>) {
  return server.connection.collection('tw_calendar_sources').updateOne({ _id: new Types.ObjectId(calendarId) }, { $set: fields });
}

function makeDue(calendarId: string) {
  return setSource(calendarId, { nextRefreshAt: server.clock.now() });
}

function eventRows(calendarId: string): Promise<number> {
  return server.connection.collection('tw_calendar_events').countDocuments({ sourceId: new Types.ObjectId(calendarId) });
}

async function titlesOf(t: Tenant): Promise<string[]> {
  return (await stores.ownerCalendars.eventsBetween(t.scope, t.locationId, JUNE)).map((event) => event.title);
}

function calendarOf(t: Tenant, calendarId: string): Promise<OwnerCalendarRecord | null> {
  return stores.ownerCalendars.find(t.scope, t.locationId, calendarId);
}

interface FakeFetcher extends CalendarFetcher { readonly calls: string[] }

/** A fetcher that answers `answer` and records each address it was asked for. */
function fakeFetcher(answer: (address: string) => CalendarFetchResult | Promise<CalendarFetchResult>): FakeFetcher {
  const calls: string[] = [];
  return {
    calls,
    async fetch(address) {
      calls.push(address);
      return answer(address);
    },
  };
}

const feed = (text: string): CalendarFetchResult => ({ ok: true, text, host: HOST });

/** A refresher over `fetcher` for links and the fake Google client (null with `googleOff`, the revoke kept). */
function refresherOf(fetcher: CalendarFetcher, opts: { key?: KeyObject; firstTickMs?: number; stores?: TownwiseStores; googleOff?: true } = {}): CalendarRefresher {
  return createCalendarRefresher({
    connection: server.connection, stores: opts.stores ?? stores, key: opts.key ?? KEY, logger, now: server.clock.now, fetcher,
    googleCalendar: opts.googleOff === true ? null : google.client, revokeGoogle: google.revoke,
    ...(opts.firstTickMs === undefined ? {} : { firstTickMs: opts.firstTickMs }),
  });
}

function at(ms: number): Date {
  return new Date(server.clock.now().getTime() + ms);
}

/** The log lines with this message, without pino's own fields. */
function logged(msg: string): Record<string, unknown>[] {
  return logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === msg)
    .map((line) => Object.fromEntries(Object.entries(line).filter(([key]) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key))));
}

/** 'done' when `work` settles within `ms`, else 'late'. */
async function within(ms: number, work: Promise<unknown>): Promise<'done' | 'late'> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<'late'>((resolve) => { timer = setTimeout(() => { resolve('late'); }, ms); });
  try {
    return await Promise.race([work.then(() => 'done' as const), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A refresher for Google calendars: no link is fetched. */
function googleRefresher(opts: { googleOff?: true } = {}): CalendarRefresher {
  return refresherOf(fakeFetcher(() => feed(LATER)), opts);
}

/** A person with a seat in `t`'s organization and a Google connection there, as a connect leaves it (the check a day away). */
async function connected(t: Tenant, opts: { key?: KeyObject } = {}): Promise<{ userId: string; connectionId: string }> {
  const userId = `user-${randomUUID()}`;
  await addSeat(server, { orgId: t.orgId, userId, email: `${userId}@example.test` });
  return { userId, connectionId: await addGoogleConnection(server, { orgId: t.orgId, userId, key: opts.key ?? KEY }) };
}

/** A Google calendar on `t`'s location read through `connectionId`, holding STORED_TITLE, due now unless `due` is false. */
async function addGoogle(t: Tenant, connectionId: string, opts: { googleCalendarId?: string; key?: KeyObject; due?: false } = {}): Promise<string> {
  const slot = await server.connection.collection('tw_calendar_sources').countDocuments({ locationId: new Types.ObjectId(t.locationId) });
  const calendarId = await addGoogleCalendar(server, {
    orgId: t.orgId, locationId: t.locationId, connectionId, key: opts.key ?? KEY, googleCalendarId: opts.googleCalendarId ?? SHARED_ID, slot, label: LABEL,
    title: STORED_TITLE,
  });
  if (opts.due !== false) await makeDue(calendarId);
  return calendarId;
}

function connectionRow(connectionId: string) {
  return server.connection.collection('tw_google_connections').findOne({ _id: new Types.ObjectId(connectionId) });
}

/** Due for a check now, as markForCheck leaves it before a step that may leave it unused or unowned. */
function markDue(connectionId: string) {
  return server.connection.collection('tw_google_connections').updateOne({ _id: new Types.ObjectId(connectionId) }, { $set: { checkAt: server.clock.now() } });
}

/** Connected a day ago, so the check ends it as soon as it backs no calendar (a newer one is given a day from its connect). */
function dayOld(connectionId: string) {
  return server.connection.collection('tw_google_connections').updateOne({ _id: new Types.ObjectId(connectionId) }, { $set: { connectedAt: at(-24 * HOUR) } });
}

/** The person's seat removed at `removedAt`, as the members store writes it. */
function removeSeat(userId: string, removedAt: Date) {
  return server.connection.collection('tw_members').updateOne(
    { activeUserId: userId }, { $set: { status: 'removed', removedAt, removedBy: 'user-admin' }, $unset: { activeUserId: '' } },
  );
}

/** The seat put back, as a last admin's refused removal restores it. */
function restoreSeat(userId: string) {
  return server.connection.collection('tw_members').updateOne(
    { userId, status: 'removed' }, { $set: { status: 'active', activeUserId: userId, removedAt: null, removedBy: null } },
  );
}

/** The location's calendars and their events. */
async function stored(t: Tenant): Promise<{ calendars: number; events: number }> {
  const filter = { locationId: new Types.ObjectId(t.locationId) };
  return {
    calendars: await server.connection.collection('tw_calendar_sources').countDocuments(filter),
    events: await server.connection.collection('tw_calendar_events').countDocuments(filter),
  };
}

/** The tokens Google was asked to revoke, in order. */
function revoked(): unknown[] {
  return google.callsOf('revoke').map((call) => call.args[0]);
}

function googleMethods(): string[] {
  return google.calls.map((call) => call.method);
}

describe('the claim', () => {
  it('takes one due link under no live lease, the longest due first, and answers its ids only', async () => {
    const t = await tenant();
    await stores.ownerCalendars.add(t.scope, t.locationId, { kind: 'file', label: 'Imported' }, { events: ADDED, skippedRepeating: 0 },
      { createdBy: 'user-0001', now: server.clock.now() });
    const notDue = await addLink(t);
    await setSource(notDue.calendar.id, { nextRefreshAt: at(1) });
    const leased = await addLink(t);
    await setSource(leased.calendar.id, { nextRefreshAt: at(-2 * HOUR), leaseUntil: at(1) });
    const due = await addLink(t);
    await setSource(due.calendar.id, { nextRefreshAt: at(-HOUR) });
    const later = await addLink(t);

    const leaseUntil = at(2 * MINUTE);
    expect(await claimDueCalendar(server.connection, { now: server.clock.now(), leaseUntil }))
      .toEqual({ calendarId: due.calendar.id, orgId: t.orgId, locationId: t.locationId, kind: 'link' });
    expect(await source(due.calendar.id)).toMatchObject({ leaseUntil });
    expect(await claimDueCalendar(server.connection, { now: server.clock.now(), leaseUntil }))
      .toEqual({ calendarId: later.calendar.id, orgId: t.orgId, locationId: t.locationId, kind: 'link' });
    // The file, the link not due yet and the two under live leases are not claimed.
    expect(await claimDueCalendar(server.connection, { now: server.clock.now(), leaseUntil })).toBeNull();

    // A lease that ran out (its replica stopped) is taken again.
    await setSource(leased.calendar.id, { leaseUntil: at(-1) });
    expect(await claimDueCalendar(server.connection, { now: server.clock.now(), leaseUntil }))
      .toMatchObject({ calendarId: leased.calendar.id });
  });

  it('takes link and Google calendars alike, the longest due first, and answers the kind', async () => {
    const t = await tenant();
    await stores.ownerCalendars.add(t.scope, t.locationId, { kind: 'file', label: 'Imported' }, { events: ADDED, skippedRepeating: 0 },
      { createdBy: 'user-0001', now: server.clock.now() });
    const recent = await addLink(t);
    await setSource(recent.calendar.id, { nextRefreshAt: at(-HOUR) });
    const googleId = await addGoogle(t, new Types.ObjectId().toHexString());
    await setSource(googleId, { nextRefreshAt: at(-3 * HOUR) });
    const older = await addLink(t);
    await setSource(older.calendar.id, { nextRefreshAt: at(-2 * HOUR) });

    const claim = () => claimDueCalendar(server.connection, { now: server.clock.now(), leaseUntil: at(LEASE) });
    expect(await claim()).toEqual({ calendarId: googleId, orgId: t.orgId, locationId: t.locationId, kind: 'google' });
    expect(await claim()).toEqual({ calendarId: older.calendar.id, orgId: t.orgId, locationId: t.locationId, kind: 'link' });
    expect(await claim()).toEqual({ calendarId: recent.calendar.id, orgId: t.orgId, locationId: t.locationId, kind: 'link' });
    // The file is never due.
    expect(await claim()).toBeNull();
  });

  it('gives a due link to exactly one of the claims racing for it', async () => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimDueCalendar(server.connection, {
      now: server.clock.now(), leaseUntil: at(2 * MINUTE),
    })));
    expect(claims.filter((claim) => claim !== null)).toEqual([{ calendarId: calendar.id, orgId: t.orgId, locationId: t.locationId, kind: 'link' }]);
  });
});

describe('refreshing', () => {
  it('fetches each due link exactly once when two refreshers drain at the same moment', async () => {
    const [first, second] = [await tenant(), await tenant()];
    const added = [{ t: first, ...await addLink(first) }, { t: first, ...await addLink(first) }, { t: second, ...await addLink(second) }];
    // Each fetch yields, so both drains are in flight together.
    const fetcher = fakeFetcher(async () => {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return feed(LATER);
    });
    const counts = await Promise.all([refresherOf(fetcher).drain(), refresherOf(fetcher).drain()]);

    expect(counts[0] + counts[1]).toBe(3);
    expect([...fetcher.calls].sort()).toEqual(added.map((link) => link.address).sort());
    for (const { t, calendar } of added) {
      expect(await calendarOf(t, calendar.id)).toMatchObject({ status: 'ok', eventCount: 3, nextRefreshAt: at(6 * HOUR), leaseUntil: null });
    }
  });

  it('replaces the events on success, records it, holds a 5 minute lease meanwhile, and is next due in 6 hours', async () => {
    const t = await tenant();
    const { calendar, address } = await addLink(t);
    await setSource(calendar.id, { status: 'timeout', consecutiveFailures: 1 });
    let lease: unknown;
    const fetcher = fakeFetcher(async () => {
      lease = (await source(calendar.id))?.leaseUntil;
      return feed(LATER);
    });
    expect(await titlesOf(t)).toEqual(ADDED_TITLES);

    expect(await refresherOf(fetcher).drain()).toBe(1);

    expect(fetcher.calls).toEqual([address]);
    expect(lease).toEqual(at(LEASE));
    expect(await titlesOf(t)).toEqual(LATER_TITLES);
    // The older generation's rows are gone.
    expect(await eventRows(calendar.id)).toBe(3);
    expect(await calendarOf(t, calendar.id)).toMatchObject({
      status: 'ok', eventCount: 3, skippedRepeating: 1, lastSuccessAt: server.clock.now(), lastAttemptAt: server.clock.now(),
      consecutiveFailures: 0, nextRefreshAt: at(6 * HOUR), leaseUntil: null,
    });
    // Not due again until then.
    expect(await refresherOf(fetcher).drain()).toBe(0);
    expect(fetcher.calls).toHaveLength(1);
  });

  it('keeps the events on failure, records the code and the attempt, and tries again in 6 hours', async () => {
    const t = await tenant();
    const down = await addLink(t);
    const page = await addLink(t);
    const addedAt = server.clock.now();
    server.clock.advance(MINUTE);
    await makeDue(down.calendar.id);
    await makeDue(page.calendar.id);
    const fetcher = fakeFetcher((address) => (address === down.address
      ? { ok: false, code: 'timeout' }
      : feed('<!doctype html><title>Bookings</title>')));

    expect(await refresherOf(fetcher).drain()).toBe(2);

    for (const [{ calendar }, code] of [[down, 'timeout'], [page, 'not_calendar']] as const) {
      expect(await calendarOf(t, calendar.id)).toMatchObject({
        status: code, eventCount: 2, lastSuccessAt: addedAt, lastAttemptAt: server.clock.now(), consecutiveFailures: 1,
        nextRefreshAt: at(6 * HOUR), leaseUntil: null,
      });
      expect(await eventRows(calendar.id)).toBe(2);
    }
    expect(await titlesOf(t)).toEqual(['Rehearsal dinner', 'Rehearsal dinner', 'Office party', 'Office party']);
  });

  it('backs off 6 hours after the first failure in a row and 24 after two or more, and goes back to 6 after a success', async () => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    let answer: CalendarFetchResult = { ok: false, code: 'http_error' };
    const fetcher = fakeFetcher(() => answer);
    const refresher = refresherOf(fetcher);
    const expectNext = async (failures: number, waitMs: number): Promise<void> => {
      expect(await calendarOf(t, calendar.id)).toMatchObject({ consecutiveFailures: failures, nextRefreshAt: at(waitMs), leaseUntil: null });
    };

    expect(await refresher.drain()).toBe(1);
    await expectNext(1, 6 * HOUR);
    server.clock.advance(6 * HOUR - MINUTE);
    expect(await refresher.drain()).toBe(0);
    server.clock.advance(MINUTE);
    expect(await refresher.drain()).toBe(1);
    await expectNext(2, 24 * HOUR);
    server.clock.advance(24 * HOUR - MINUTE);
    expect(await refresher.drain()).toBe(0);
    server.clock.advance(MINUTE);
    expect(await refresher.drain()).toBe(1);
    await expectNext(3, 24 * HOUR);
    server.clock.advance(24 * HOUR);
    answer = feed(LATER);
    expect(await refresher.drain()).toBe(1);
    await expectNext(0, 6 * HOUR);
    expect(fetcher.calls).toHaveLength(4);
  });

  it('records key_mismatch, without a fetch, for an address the key no longer opens, keeps the events and backs off', async () => {
    const t = await tenant();
    const { calendar } = await addLink(t, createSecretKey(randomBytes(32)));
    const fetcher = fakeFetcher(() => feed(LATER));
    const refresher = refresherOf(fetcher);

    expect(await refresher.drain()).toBe(1);
    expect(fetcher.calls).toEqual([]);
    expect(await calendarOf(t, calendar.id)).toMatchObject({
      status: 'key_mismatch', consecutiveFailures: 1, nextRefreshAt: at(6 * HOUR), leaseUntil: null, eventCount: 2,
    });
    expect(await titlesOf(t)).toEqual(ADDED_TITLES);
    server.clock.advance(6 * HOUR);
    expect(await refresher.drain()).toBe(1);
    expect(await calendarOf(t, calendar.id)).toMatchObject({ status: 'key_mismatch', consecutiveFailures: 2, nextRefreshAt: at(24 * HOUR) });
    expect(fetcher.calls).toEqual([]);
  });

  it('does not fetch a suspended organization’s links, and looks at them again in 6 hours', async () => {
    const t = await tenant('suspended');
    const { calendar } = await addLink(t);
    const before = await calendarOf(t, calendar.id);
    const fetcher = fakeFetcher(() => feed(LATER));

    expect(await refresherOf(fetcher).drain()).toBe(1);

    expect(fetcher.calls).toEqual([]);
    expect(await calendarOf(t, calendar.id)).toEqual({ ...before, nextRefreshAt: at(6 * HOUR), leaseUntil: null });
    expect(await titlesOf(t)).toEqual(ADDED_TITLES);
  });

  it('goes on to the next link after a refresh that throws, logs its id and error type only, and leaves its lease to run out', async () => {
    const t = await tenant();
    const broken = await addLink(t);
    // Claimed first.
    await setSource(broken.calendar.id, { nextRefreshAt: at(-HOUR) });
    const next = await addLink(t);
    const before = await calendarOf(t, broken.calendar.id);
    // Against its contract, a fetcher that throws, with the address in its message.
    const fetcher = fakeFetcher((address) => {
      if (address === broken.address) throw new TypeError(`could not read ${address}`);
      return feed(LATER);
    });

    expect(await refresherOf(fetcher).drain()).toBe(2);

    expect(await calendarOf(t, next.calendar.id)).toMatchObject({ status: 'ok', eventCount: 3, leaseUntil: null });
    expect(await calendarOf(t, broken.calendar.id)).toEqual({ ...before, leaseUntil: at(LEASE) });
    expect(logged('townwise.calendar_refresh_failed')).toEqual([{ calendarId: broken.calendar.id, errType: 'TypeError' }]);
    const text = logs.join('\n');
    for (const secret of [TOKEN, HOST, LABEL, ...ADDED_TITLES]) expect(text).not.toContain(secret);
    // Once its lease has run out, a later look tries it again.
    server.clock.advance(LEASE + 1);
    expect(await refresherOf(fakeFetcher(() => feed(LATER))).drain()).toBe(1);
    expect(await calendarOf(t, broken.calendar.id)).toMatchObject({ status: 'ok', eventCount: 3, leaseUntil: null });
  });

  it('lets go of its own lease only: a refresh that outlived its lease leaves the lease of the claim that took the link over', async () => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    const before = await calendarOf(t, calendar.id);
    const takeover = at(LEASE + 1 + LEASE);
    let claimed: unknown;
    const fetcher = fakeFetcher(async () => {
      // The fetch outlives the 5 minute lease, and another replica claims the link meanwhile.
      server.clock.advance(LEASE + 1);
      claimed = await claimDueCalendar(server.connection, { now: server.clock.now(), leaseUntil: takeover });
      return feed(LATER);
    });

    expect(await refresherOf(fetcher).drain()).toBe(1);

    expect(claimed).toMatchObject({ calendarId: calendar.id });
    // The other replica's lease stands, so no third one claims the link while it refreshes; its own release ends it.
    expect(await calendarOf(t, calendar.id)).toMatchObject({ leaseUntil: takeover, nextRefreshAt: before?.nextRefreshAt });
    expect(await stores.ownerCalendars.releaseRefresh(t.scope, t.locationId, calendar.id, { leaseUntil: at(-1), nextRefreshAt: at(6 * HOUR) }))
      .toBe(false);
    expect(await stores.ownerCalendars.releaseRefresh(t.scope, t.locationId, calendar.id, { leaseUntil: takeover, nextRefreshAt: at(6 * HOUR) }))
      .toBe(true);
    expect(await calendarOf(t, calendar.id)).toMatchObject({ leaseUntil: null, nextRefreshAt: at(6 * HOUR) });
  });
});

describe('a location or organization deleted', () => {
  /** What each deletion does while the link is being fetched. */
  const deletions: [string, (t: Tenant) => Promise<unknown>][] = [
    // handlers/locations.ts removeLocation: the location, then (last) its calendars.
    ['the location, then its calendars', async (t) => {
      await stores.locations.remove(t.scope, t.locationId);
      await stores.ownerCalendars.removeForLocation(t.scope, t.locationId);
    }],
    // A location deletion that has removed the location row and not yet reached its calendars, or stopped there.
    ['the location row only', (t) => stores.locations.remove(t.scope, t.locationId)],
    // handlers/deletion.ts deleteOrg: the calendars well before the locations and the organization.
    ['the organization’s calendars', (t) => stores.ownerCalendars.removeForOrg(t.scope)],
  ];

  it.each(deletions)('mid-refresh (%s) keeps no calendar and no events of it', async (_name, remove) => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    const fetcher = fakeFetcher(async () => {
      await remove(t);
      return feed(LATER);
    });

    expect(await refresherOf(fetcher).drain()).toBe(1);

    expect(await source(calendar.id)).toBeNull();
    expect(await eventRows(calendar.id)).toBe(0);
  });

  it.each(deletions)('mid-refresh (%s), on a failed fetch, keeps no calendar and no events of it', async (_name, remove) => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    const fetcher = fakeFetcher(async () => {
      await remove(t);
      return { ok: false, code: 'unreachable' };
    });

    expect(await refresherOf(fetcher).drain()).toBe(1);

    expect(await source(calendar.id)).toBeNull();
    expect(await eventRows(calendar.id)).toBe(0);
  });

  it('before the claim, with its calendar left behind, takes the calendar and fetches nothing', async () => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    await stores.locations.remove(t.scope, t.locationId);
    const fetcher = fakeFetcher(() => feed(LATER));

    expect(await refresherOf(fetcher).drain()).toBe(1);

    expect(fetcher.calls).toEqual([]);
    expect(await source(calendar.id)).toBeNull();
    expect(await eventRows(calendar.id)).toBe(0);
  });
});

describe('the loop', () => {
  it('looks shortly after start, and close drops a fetch in flight within a shutdown hook’s 2 seconds and writes nothing', async () => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    const before = await calendarOf(t, calendar.id);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = fakeFetcher(async () => {
      await held;
      return feed(LATER);
    });
    const refresher = refresherOf(fetcher, { firstTickMs: 1 });
    refresher.start();
    await vi.waitFor(() => { expect(fetcher.calls).toHaveLength(1); });

    // A fetch may take its whole 10 seconds; close does not wait for it.
    expect(await within(HOOK_BUDGET_MS, refresher.close())).toBe('done');
    // Its answer, come too late, writes nothing: the link keeps its events, and its lease runs out.
    release();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(await calendarOf(t, calendar.id)).toEqual({ ...before, leaseUntil: at(LEASE) });
    expect(await titlesOf(t)).toEqual(ADDED_TITLES);
    expect(logged('townwise.calendar_refresh_skipped')).toEqual([{ calendarId: calendar.id, reason: 'stopped' }]);
    // Closed, it claims nothing more; once the lease has run out, another replica refreshes the link.
    expect(await refresher.drain()).toBe(0);
    server.clock.advance(LEASE + 1);
    expect(await refresherOf(fakeFetcher(() => feed(LATER))).drain()).toBe(1);
    expect(await calendarOf(t, calendar.id)).toMatchObject({ status: 'ok', eventCount: 3, leaseUntil: null });
  });

  it('close waits for the writes in flight, so they end while the database is still open', async () => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let arrived: () => void = () => undefined;
    const writing = new Promise<void>((resolve) => { arrived = resolve; });
    const replaceEvents: OwnerCalendarStore['replaceEvents'] = async (...args) => {
      arrived();
      await held;
      return stores.ownerCalendars.replaceEvents(...args);
    };
    const refresher = refresherOf(fakeFetcher(() => feed(LATER)), {
      stores: { ...stores, ownerCalendars: { ...stores.ownerCalendars, replaceEvents } },
    });
    const draining = refresher.drain();
    await writing;

    let closed = false;
    const closing = refresher.close().then(() => { closed = true; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(closed).toBe(false);
    release();
    await closing;

    expect(await draining).toBe(1);
    expect(await calendarOf(t, calendar.id)).toMatchObject({ status: 'ok', eventCount: 3, leaseUntil: null });
  });

  it('logs the calendar id, the status, the counts and the duration only: never the address, host, label or a title', async () => {
    const t = await tenant();
    const ok = await addLink(t);
    const failed = await addLink(t);
    const fetcher = fakeFetcher((address) => (address === ok.address ? feed(LATER) : { ok: false, code: 'http_error' }));

    expect(await refresherOf(fetcher).drain()).toBe(2);

    const refreshed = logged('townwise.calendar_refreshed');
    expect(refreshed).toHaveLength(2);
    expect(refreshed).toEqual(expect.arrayContaining([
      { calendarId: ok.calendar.id, status: 'ok', eventCount: 3, skippedRepeating: 1, durationMs: 0 },
      { calendarId: failed.calendar.id, status: 'http_error', eventCount: 2, skippedRepeating: 0, durationMs: 0 },
    ]));
    const text = logs.join('\n');
    for (const secret of [TOKEN, HOST, LABEL, ...ADDED_TITLES, ...LATER_TITLES, 'Weekly trivia']) expect(text).not.toContain(secret);
  });
});

describe('Google calendars', () => {
  it('refreshes a Google calendar through google-access.ts: one token call, then the events, replaced and logged with ids and counts only', async () => {
    const t = await tenant();
    const { connectionId } = await connected(t);
    const calendarId = await addGoogle(t, connectionId);
    google.state.rotatedRefreshToken = ROTATED_TOKEN;
    expect(await titlesOf(t)).toEqual([STORED_TITLE]);

    expect(await googleRefresher().drain()).toBe(1);

    expect(await titlesOf(t)).toEqual(GOOGLE_TITLES);
    expect(await eventRows(calendarId)).toBe(2);
    expect(await calendarOf(t, calendarId)).toMatchObject({
      status: 'ok', eventCount: 2, skippedRepeating: 0, consecutiveFailures: 0, lastSuccessAt: server.clock.now(), nextRefreshAt: at(6 * HOUR),
      leaseUntil: null,
    });
    // The window ahead and the four slices before, each with the opened Google calendar id, under the loop's close signal.
    expect(googleMethods()).toEqual(['refreshAccess', 'listEvents', 'listEvents', 'listEvents', 'listEvents', 'listEvents']);
    expect(google.callsOf('refreshAccess')[0]?.args[0]).toBe(REFRESH_TOKEN);
    for (const call of google.calls) expect((call.args.at(-1) as { signal?: unknown }).signal).toBeInstanceOf(AbortSignal);
    for (const call of google.callsOf('listEvents')) expect(call.args[1]).toBe(SHARED_ID);
    // The refresh token Google sent replaced the stored one, sealed, through google-access.ts.
    const sealed = (await connectionRow(connectionId))?.sealedRefreshToken as string;
    expect(sealed).not.toContain(ROTATED_TOKEN);
    expect(open(KEY, sealed)).toEqual({ ok: true, text: ROTATED_TOKEN });
    expect(logged('townwise.calendar_refreshed')).toEqual([{ calendarId, status: 'ok', eventCount: 2, skippedRepeating: 0, durationMs: 0 }]);
    const text = logs.join('\n');
    for (const secret of [REFRESH_TOKEN, ROTATED_TOKEN, ACCESS_TOKEN, SHARED_ID, LABEL, STORED_TITLE, ...GOOGLE_TITLES]) expect(text).not.toContain(secret);
  });

  it('records google_revoked on invalid_grant, marks the connection revoked, and fails its second calendar with no Google call', async () => {
    const t = await tenant();
    const { connectionId } = await connected(t);
    const first = await addGoogle(t, connectionId, { googleCalendarId: SHARED_ID });
    await setSource(first, { nextRefreshAt: at(-HOUR) });
    const second = await addGoogle(t, connectionId, { googleCalendarId: PRIMARY_ID });
    google.on('refreshAccess', () => Promise.reject(googleError('invalid_grant', 400)));

    expect(await googleRefresher().drain()).toBe(2);

    for (const calendarId of [first, second]) {
      expect(await calendarOf(t, calendarId)).toMatchObject({ status: 'google_revoked', eventCount: 1, consecutiveFailures: 1, nextRefreshAt: at(6 * HOUR), leaseUntil: null });
    }
    expect(await titlesOf(t)).toEqual([STORED_TITLE, STORED_TITLE]);
    expect(googleMethods()).toEqual(['refreshAccess']);
    expect(await connectionRow(connectionId)).toMatchObject({ revokedAt: server.clock.now() });
    expect(logged('townwise.google_calendar_failed')).toEqual([{ op: 'token', status: 400, code: 'invalid_grant' }]);
  });

  it('removes a Google calendar whose connection is gone, with its events, and calls Google for nothing', async () => {
    const t = await tenant();
    const calendarId = await addGoogle(t, new Types.ObjectId().toHexString());

    expect(await googleRefresher().drain()).toBe(1);

    expect(await source(calendarId)).toBeNull();
    expect(await eventRows(calendarId)).toBe(0);
    expect(google.calls).toEqual([]);
    expect(logged('townwise.calendar_refresh_skipped')).toEqual([{ calendarId, reason: 'removed' }]);
  });

  it('ends the access of a person whose seat was removed with their access never ended, without reading Google', async () => {
    const t = await tenant();
    const { userId, connectionId } = await connected(t);
    const first = await addGoogle(t, connectionId, { googleCalendarId: SHARED_ID });
    await setSource(first, { nextRefreshAt: at(-HOUR) });
    await addGoogle(t, connectionId, { googleCalendarId: PRIMARY_ID });
    // The removal stopped before endGoogleAccess, and longer ago than a refused removal takes to put a seat back.
    await removeSeat(userId, at(-2 * SEAT_SETTLE_MS));
    // The connection's own check is a day away: the seat check on the Google read is what finds it.
    expect(await connectionRow(connectionId)).toMatchObject({ checkAt: at(24 * HOUR) });

    expect(await googleRefresher().drain()).toBe(1);

    expect(await stored(t)).toEqual({ calendars: 0, events: 0 });
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(connectionId)).toBeNull();
    // No token refresh and no events call: only the revoke reached Google.
    expect(googleMethods()).toEqual(['revoke']);
    expect(logged('townwise.google_access_ended')).toEqual([{ connectionId, calendars: 2, reason: 'seat_gone' }]);
    expect(logged('townwise.calendar_refresh_skipped')).toEqual([{ calendarId: first, reason: 'removed' }]);
  });

  it('neither reads nor ends a Google calendar whose person lost their seat moments ago, writing nothing, and decides once it settles', async () => {
    const t = await tenant();
    const { userId, connectionId } = await connected(t);
    const calendarId = await addGoogle(t, connectionId);
    // removeActiveSeat has taken the seat; a last admin's refusal may yet put it back.
    await removeSeat(userId, at(-10_000));
    const before = await calendarOf(t, calendarId);
    const row = await connectionRow(connectionId);

    expect(await googleRefresher().drain()).toBe(1);

    expect(google.calls).toEqual([]);
    expect(await calendarOf(t, calendarId)).toEqual({ ...before, leaseUntil: at(LEASE) });
    expect(await connectionRow(connectionId)).toEqual(row);
    expect(await stored(t)).toEqual({ calendars: 1, events: 1 });
    expect(logged('townwise.calendar_refresh_skipped')).toEqual([{ calendarId, reason: 'unsettled' }]);
    expect(logged('townwise.google_access_ended')).toEqual([]);

    // The removal stood: once the lease has run out, the next look finds no seat and ends the access.
    server.clock.advance(LEASE + 1);
    expect(await googleRefresher().drain()).toBe(1);
    expect(googleMethods()).toEqual(['revoke']);
    expect(await stored(t)).toEqual({ calendars: 0, events: 0 });
    expect(await connectionRow(connectionId)).toBeNull();
  });

  it('records key_mismatch, with no Google call, for a Google calendar id or a refresh token the key no longer opens, and keeps the events', async () => {
    const t = await tenant();
    const other = createSecretKey(randomBytes(32));
    const idMismatch = await addGoogle(t, (await connected(t)).connectionId, { key: other });
    const tokenMismatch = await addGoogle(t, (await connected(t, { key: other })).connectionId);

    expect(await googleRefresher().drain()).toBe(2);

    for (const calendarId of [idMismatch, tokenMismatch]) {
      expect(await calendarOf(t, calendarId)).toMatchObject({ status: 'key_mismatch', eventCount: 1, consecutiveFailures: 1, nextRefreshAt: at(6 * HOUR), leaseUntil: null });
    }
    expect(google.calls).toEqual([]);
    expect(await titlesOf(t)).toEqual([STORED_TITLE, STORED_TITLE]);
  });

  it('records google_unavailable with the Google client off, keeps the events, and calls Google for nothing', async () => {
    const t = await tenant();
    const calendarId = await addGoogle(t, (await connected(t)).connectionId);

    expect(await googleRefresher({ googleOff: true }).drain()).toBe(1);

    expect(await calendarOf(t, calendarId)).toMatchObject({ status: 'google_unavailable', eventCount: 1, consecutiveFailures: 1, nextRefreshAt: at(6 * HOUR) });
    expect(await titlesOf(t)).toEqual([STORED_TITLE]);
    expect(google.calls).toEqual([]);
  });

  it('records google_rate_limited when Google is busy, keeps the events, and tries again 6 hours later', async () => {
    const t = await tenant();
    const calendarId = await addGoogle(t, (await connected(t)).connectionId);
    google.on('listEvents', () => Promise.reject(googleError('rate_limited', 403)));
    const refresher = googleRefresher();

    expect(await refresher.drain()).toBe(1);

    expect(await calendarOf(t, calendarId)).toMatchObject({ status: 'google_rate_limited', eventCount: 1, consecutiveFailures: 1, nextRefreshAt: at(6 * HOUR), leaseUntil: null });
    expect(await titlesOf(t)).toEqual([STORED_TITLE]);
    // The read stops at the refusal.
    expect(googleMethods()).toEqual(['refreshAccess', 'listEvents']);
    expect(logged('townwise.google_calendar_failed')).toEqual([{ op: 'events', status: 403, code: 'rate_limited' }]);
    server.clock.advance(6 * HOUR - MINUTE);
    expect(await refresher.drain()).toBe(0);
    server.clock.advance(MINUTE);
    expect(await refresher.drain()).toBe(1);
    expect(google.callsOf('listEvents')).toHaveLength(2);
  });

  it('records google_unavailable, not google_forbidden, when the Calendar API is not enabled, logging exactly the op, status and code', async () => {
    const t = await tenant();
    const calendarId = await addGoogle(t, (await connected(t)).connectionId);
    // calendar/google.ts maps a 403 accessNotConfigured (or SERVICE_DISABLED) to api_disabled.
    google.on('listEvents', () => Promise.reject(googleError('api_disabled', 403)));

    expect(await googleRefresher().drain()).toBe(1);

    expect(await calendarOf(t, calendarId)).toMatchObject({ status: 'google_unavailable', eventCount: 1, consecutiveFailures: 1 });
    expect(logged('townwise.google_calendar_failed')).toEqual([{ op: 'events', status: 403, code: 'api_disabled' }]);
  });

  it('close during a Google events page aborts the call, requests no further page and writes nothing', async () => {
    const t = await tenant();
    const calendarId = await addGoogle(t, (await connected(t)).connectionId);
    const before = await calendarOf(t, calendarId);
    let signal: AbortSignal | undefined;
    // A page that would take its whole 10 seconds, ended only by the signal (calendar/google.ts answers an aborted call unavailable).
    google.on('listEvents', (_token, _calendarId, _query, opts) => new Promise((_resolve, reject) => {
      signal = opts?.signal;
      signal?.addEventListener('abort', () => { reject(googleError('unavailable')); });
    }));
    const refresher = googleRefresher();
    const draining = refresher.drain();
    await vi.waitFor(() => { expect(google.callsOf('listEvents')).toHaveLength(1); });

    expect(await within(HOOK_BUDGET_MS, refresher.close())).toBe('done');

    expect(await draining).toBe(1);
    expect(signal?.aborted).toBe(true);
    expect(google.callsOf('listEvents')).toHaveLength(1);
    expect(await calendarOf(t, calendarId)).toEqual({ ...before, leaseUntil: at(LEASE) });
    expect(await titlesOf(t)).toEqual([STORED_TITLE]);
    expect(logged('townwise.calendar_refresh_skipped')).toEqual([{ calendarId, reason: 'stopped' }]);
    // An aborted read is not Google failing.
    expect(logged('townwise.google_calendar_failed')).toEqual([]);
    // Once the lease has run out, another replica refreshes it.
    google.reset();
    google.state.events = { [SHARED_ID]: [allDay('google-1', 'Staff holiday party', '2026-06-12')] };
    server.clock.advance(LEASE + 1);
    expect(await googleRefresher().drain()).toBe(1);
    expect(await calendarOf(t, calendarId)).toMatchObject({ status: 'ok', eventCount: 1, leaseUntil: null });
  });
});

describe('the connection check', () => {
  it('takes one due connection under no live lease, the longest due first, and answers its ids and the checkAt it claimed', async () => {
    const t = await tenant();
    const notDue = (await connected(t)).connectionId;
    const leased = (await connected(t)).connectionId;
    await server.connection.collection('tw_google_connections').updateOne({ _id: new Types.ObjectId(leased) }, { $set: { checkAt: at(-2 * HOUR), leaseUntil: at(1) } });
    const due = (await connected(t)).connectionId;
    await server.connection.collection('tw_google_connections').updateOne({ _id: new Types.ObjectId(due) }, { $set: { checkAt: at(-HOUR) } });
    const later = (await connected(t)).connectionId;
    await markDue(later);

    const claim = () => claimDueGoogleConnection(server.connection, { now: server.clock.now(), leaseUntil: at(LEASE) });
    expect(await claim()).toEqual({ connectionId: due, orgId: t.orgId, checkAt: at(-HOUR) });
    expect(await connectionRow(due)).toMatchObject({ leaseUntil: at(LEASE) });
    expect(await claim()).toEqual({ connectionId: later, orgId: t.orgId, checkAt: server.clock.now() });
    expect(await claim()).toBeNull();
    expect(await connectionRow(notDue)).toMatchObject({ leaseUntil: null });
    // A lease that ran out (its replica stopped) is taken again.
    await server.connection.collection('tw_google_connections').updateOne({ _id: new Types.ObjectId(leased) }, { $set: { leaseUntil: at(-1) } });
    expect(await claim()).toEqual({ connectionId: leased, orgId: t.orgId, checkAt: at(-2 * HOUR) });
  });

  it('gives a due connection to exactly one of the claims racing for it, and two refreshers draining at once revoke it once', async () => {
    const t = await tenant();
    const { connectionId } = await connected(t);
    await dayOld(connectionId);
    await markDue(connectionId);
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimDueGoogleConnection(server.connection, {
      now: server.clock.now(), leaseUntil: at(LEASE),
    })));
    expect(claims.filter((claim) => claim !== null)).toEqual([{ connectionId, orgId: t.orgId, checkAt: server.clock.now() }]);

    // Unused, and due again once that lease has run out.
    server.clock.advance(LEASE + 1);
    const counts = await Promise.all([googleRefresher().drain(), googleRefresher().drain()]);
    expect(counts[0] + counts[1]).toBe(1);
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(connectionId)).toBeNull();
  });

  it('goes on to the next connection after a check that throws, logs its id and error type only, and leaves its lease to run out', async () => {
    const t = await tenant();
    const broken = (await connected(t)).connectionId;
    await server.connection.collection('tw_google_connections').updateOne({ _id: new Types.ObjectId(broken) }, { $set: { checkAt: at(-HOUR) } });
    const next = (await connected(t)).connectionId;
    await dayOld(next);
    await markDue(next);
    const find: GoogleConnectionStore['find'] = (scope, connectionId) => (connectionId === broken
      ? Promise.reject(new TypeError('check failed'))
      : stores.googleConnections.find(scope, connectionId));
    const refresher = refresherOf(fakeFetcher(() => feed(LATER)), { stores: { ...stores, googleConnections: { ...stores.googleConnections, find } } });

    expect(await refresher.drain()).toBe(2);

    expect(await connectionRow(next)).toBeNull();
    expect(await connectionRow(broken)).toMatchObject({ checkAt: at(-HOUR), leaseUntil: at(LEASE) });
    expect(logged('townwise.calendar_refresh_failed')).toEqual([{ connectionId: broken, errType: 'TypeError' }]);
  });

  it('ends a connection still unused 24 hours after a connect, revoking it with the Google client off too', async () => {
    const t = await tenant();
    const { connectionId } = await connected(t);
    // Google calendars switched off: the revoke needs only the stored token and the key (design decision 14).
    const refresher = googleRefresher({ googleOff: true });

    expect(await refresher.drain()).toBe(0);
    server.clock.advance(24 * HOUR - MINUTE);
    expect(await refresher.drain()).toBe(0);
    expect(google.calls).toEqual([]);
    server.clock.advance(MINUTE);
    expect(await refresher.drain()).toBe(1);

    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(googleMethods()).toEqual(['revoke']);
    expect(await connectionRow(connectionId)).toBeNull();
    expect(logged('townwise.google_access_ended')).toEqual([{ connectionId, calendars: 0, reason: 'unused' }]);
  });

  it('ends a connection whose person holds no seat in the organization, with its calendars and their events', async () => {
    const t = await tenant();
    const { userId, connectionId } = await connected(t);
    await addGoogle(t, connectionId, { due: false });
    await removeSeat(userId, at(-2 * SEAT_SETTLE_MS));
    // Seat loss marks the connection before the seat goes.
    await markDue(connectionId);

    expect(await googleRefresher().drain()).toBe(1);

    expect(await stored(t)).toEqual({ calendars: 0, events: 0 });
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(googleMethods()).toEqual(['revoke']);
    expect(await connectionRow(connectionId)).toBeNull();
    expect(logged('townwise.google_access_ended')).toEqual([{ connectionId, calendars: 1, reason: 'seat_gone' }]);
  });

  it('completes an interrupted end: a departed member’s calendars removed and the grant not yet revoked', async () => {
    const t = await tenant();
    const { userId, connectionId } = await connected(t);
    await removeSeat(userId, at(-2 * SEAT_SETTLE_MS));
    // endGoogleAccess marked the connection and removed its calendars, then stopped before the revoke.
    await markDue(connectionId);

    expect(await googleRefresher().drain()).toBe(1);

    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(connectionId)).toBeNull();
    expect(logged('townwise.google_access_ended')).toEqual([{ connectionId, calendars: 0, reason: 'seat_gone' }]);
  });

  it('completes an interrupted location deletion: the refresh marks the connection as it removes the calendar, and the check ends it', async () => {
    const t = await tenant();
    const { connectionId } = await connected(t);
    await dayOld(connectionId);
    const calendarId = await addGoogle(t, connectionId);
    // removeLocation stopped after the location row went, before its calendars did.
    await stores.locations.remove(t.scope, t.locationId);
    expect(await connectionRow(connectionId)).toMatchObject({ checkAt: at(24 * HOUR) });

    // The calendar, then the check its removal made due.
    expect(await googleRefresher().drain()).toBe(2);

    expect(await source(calendarId)).toBeNull();
    expect(await eventRows(calendarId)).toBe(0);
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(googleMethods()).toEqual(['revoke']);
    expect(await connectionRow(connectionId)).toBeNull();
    expect(logged('townwise.calendar_refresh_skipped')).toEqual([{ calendarId, reason: 'removed' }]);
    expect(logged('townwise.google_access_ended')).toEqual([{ connectionId, calendars: 0, reason: 'unused' }]);
  });

  it('pushes a connection in use 24 hours on, every day, and ends nothing', async () => {
    const t = await tenant();
    const { connectionId } = await connected(t);
    const calendarId = await addGoogle(t, connectionId, { due: false });
    // Not due for a refresh in the two days below, so only the check runs.
    await setSource(calendarId, { nextRefreshAt: at(72 * HOUR) });
    await markDue(connectionId);
    const refresher = googleRefresher();

    expect(await refresher.drain()).toBe(1);
    expect(await connectionRow(connectionId)).toMatchObject({ checkAt: at(24 * HOUR), leaseUntil: null, revokedAt: null });
    server.clock.advance(24 * HOUR);
    expect(await refresher.drain()).toBe(1);
    expect(await connectionRow(connectionId)).toMatchObject({ checkAt: at(24 * HOUR), leaseUntil: null });

    expect(google.calls).toEqual([]);
    expect(await stored(t)).toEqual({ calendars: 1, events: 1 });
    expect(logged('townwise.google_access_ended')).toEqual([]);
  });

  it('leaves a connection due while its person’s seat may yet come back, and pushes it 24 hours on once a last admin’s refusal restores it', async () => {
    const t = await tenant();
    const { userId, connectionId } = await connected(t);
    await addGoogle(t, connectionId, { due: false });
    // A last admin's removal: the connection marked, the seat taken, the recount not yet done.
    await markDue(connectionId);
    await removeSeat(userId, at(-10_000));
    const before = await connectionRow(connectionId);

    expect(await googleRefresher().drain()).toBe(1);

    expect(google.calls).toEqual([]);
    expect(await stored(t)).toEqual({ calendars: 1, events: 1 });
    // Nothing written but the claim's lease, so it is still due once that runs out.
    expect(await connectionRow(connectionId)).toEqual({ ...before, leaseUntil: at(LEASE) });
    await restoreSeat(userId);
    expect(await googleRefresher().drain()).toBe(0);
    server.clock.advance(LEASE + 1);
    expect(await googleRefresher().drain()).toBe(1);

    expect(await connectionRow(connectionId)).toMatchObject({ checkAt: at(24 * HOUR), leaseUntil: null, revokedAt: null });
    expect(google.calls).toEqual([]);
    expect(logged('townwise.google_access_ended')).toEqual([]);
  });

  it('keeps a new connection that backs no calendar through a last admin’s refused removal, and ends it a day after its connect', async () => {
    const t = await tenant();
    const { userId, connectionId } = await connected(t);
    const before = await connectionRow(connectionId);
    // A last admin presses Leave before adding a calendar: the connection marked, the seat taken, then put back.
    await markDue(connectionId);
    await removeSeat(userId, at(-10_000));
    await restoreSeat(userId);

    expect(await googleRefresher().drain()).toBe(1);

    // Nothing about the connection changed: its next check is still a day after its connect.
    expect(await connectionRow(connectionId)).toEqual(before);
    expect(google.calls).toEqual([]);
    expect(logged('townwise.google_access_ended')).toEqual([]);
    server.clock.advance(24 * HOUR);
    expect(await googleRefresher().drain()).toBe(1);
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(connectionId)).toBeNull();
    expect(logged('townwise.google_access_ended')).toEqual([{ connectionId, calendars: 0, reason: 'unused' }]);
  });

  it('keeps a connection due when a mark comes in during its check, so a calendar removed meanwhile ends it at the next look', async () => {
    const t = await tenant();
    const { connectionId } = await connected(t);
    await dayOld(connectionId);
    const calendarId = await addGoogle(t, connectionId, { due: false });
    await setSource(calendarId, { nextRefreshAt: at(72 * HOUR) });
    // Due an hour ago, so a mark written now changes checkAt.
    await server.connection.collection('tw_google_connections').updateOne({ _id: new Types.ObjectId(connectionId) }, { $set: { checkAt: at(-HOUR) } });
    let raced = false;
    // Once the check has counted the calendar, another replica (its refresh finding the location gone, or a Remove)
    // marks the connection and removes the calendar.
    const countForConnection: OwnerCalendarStore['countForConnection'] = async (scope, id) => {
      const counted = await stores.ownerCalendars.countForConnection(scope, id);
      if (!raced) {
        raced = true;
        await stores.googleConnections.markForCheck(scope, id, server.clock.now());
        await stores.ownerCalendars.remove(scope, t.locationId, calendarId);
      }
      return counted;
    };
    const refresher = refresherOf(fakeFetcher(() => feed(LATER)), {
      stores: { ...stores, ownerCalendars: { ...stores.ownerCalendars, countForConnection } },
    });

    // The check that counted the calendar, then the look the mark kept due.
    expect(await refresher.drain()).toBe(2);

    expect(await stored(t)).toEqual({ calendars: 0, events: 0 });
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(connectionId)).toBeNull();
    expect(logged('townwise.google_access_ended')).toEqual([{ connectionId, calendars: 0, reason: 'unused' }]);
  });

  it('close during a check’s revoke aborts it, keeps the connection due, logs neither an end nor a failed revoke, and a later look ends it', async () => {
    const t = await tenant();
    const { connectionId } = await connected(t);
    await dayOld(connectionId);
    await markDue(connectionId);
    let signal: AbortSignal | undefined;
    // A revoke that would take its whole 10 seconds, ended only by the signal (calendar/google.ts answers an aborted call unavailable).
    google.on('revoke', (_token, opts) => new Promise((_resolve, reject) => {
      signal = opts?.signal;
      signal?.addEventListener('abort', () => { reject(googleError('unavailable')); });
    }));
    const refresher = googleRefresher();
    const draining = refresher.drain();
    await vi.waitFor(() => { expect(google.callsOf('revoke')).toHaveLength(1); });

    expect(await within(HOOK_BUDGET_MS, refresher.close())).toBe('done');

    expect(await draining).toBe(1);
    expect(signal?.aborted).toBe(true);
    // The revoke may not have reached Google, so the row stays, due at once, under the claim's lease.
    expect(await connectionRow(connectionId)).toMatchObject({ checkAt: server.clock.now(), leaseUntil: at(LEASE) });
    expect(logged('townwise.google_access_ended')).toEqual([]);
    // A cancelled revoke is not Google failing.
    expect(logged('townwise.google_revoke_failed')).toEqual([]);
    // Once the lease has run out, another replica ends it.
    google.reset();
    server.clock.advance(LEASE + 1);
    expect(await googleRefresher().drain()).toBe(1);
    expect(revoked()).toEqual([REFRESH_TOKEN]);
    expect(await connectionRow(connectionId)).toBeNull();
    expect(logged('townwise.google_access_ended')).toEqual([{ connectionId, calendars: 0, reason: 'unused' }]);
  });
});

describe('bringing the weekly pass forward (D59 slice 3)', () => {
  async function earlyPassOf(t: Tenant): Promise<unknown> {
    return (await server.connection.collection('tw_locations').findOne({ _id: new Types.ObjectId(t.locationId) }))?.earlyPass;
  }

  it('a refresh that adds or moves a keyed event in the next 91 days marks the location; one that changes nothing ahead does not', async () => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    // Moves the dinner by a day and drops the party: the location's weekly pass is brought forward.
    expect(await refresherOf(fakeFetcher(() => feed(ics(
      vevent('UID:dinner@example.test', 'SUMMARY:Rehearsal dinner', 'DTSTART:20260611T180000', 'DTEND:20260611T210000'),
    )))).drain()).toBe(1);
    expect(await earlyPassOf(t)).toEqual({ wantedAt: server.clock.now() });
    expect(logged('townwise.weekly_pass_brought_forward')).toEqual([{ calendarId: calendar.id, changed: 2 }]);
    expect(logs.join('\n')).not.toContain('Rehearsal dinner');

    // The same event again, and one past the 91 days: nothing new ahead.
    await server.connection.collection('tw_locations').updateOne({ _id: new Types.ObjectId(t.locationId) }, { $unset: { earlyPass: 1 } });
    server.clock.advance(MINUTE);
    await makeDue(calendar.id);
    expect(await refresherOf(fakeFetcher(() => feed(ics(
      vevent('UID:dinner@example.test', 'SUMMARY:Rehearsal dinner', 'DTSTART:20260611T180000', 'DTEND:20260611T210000'),
      vevent('UID:gala@example.test', 'SUMMARY:Autumn gala', 'DTSTART;VALUE=DATE:20261010'),
    )))).drain()).toBe(1);
    expect(await earlyPassOf(t)).toBeUndefined();
  });
});
