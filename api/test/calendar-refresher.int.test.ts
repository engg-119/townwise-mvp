// The calendar refresh loop (src/calendar/refresher.ts; openspec change connect-owner-calendar: the
// calendar-subscription spec, design decision 6), against the database with the test clock and an injected fetcher, so
// nothing reaches the network: the cross-tenant claim and its lease, two refreshers racing for the same due links, a
// success that replaces the events, a failure that keeps them and records its code, the backoff (6 hours, then 24), an
// address the key no longer opens, a suspended organization, a location or organization deleted mid-refresh, the loop's
// start and close, and log lines that hold no address, host, label or title. Every title here is made up.
import { createSecretKey, randomBytes, randomUUID, type KeyObject } from 'node:crypto';

import { createLogger } from '@ckeith26/server-core';
import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import type { CalendarFetcher, CalendarFetchResult } from '../src/calendar/fetch.ts';
import type { IcsEvent } from '../src/calendar/ics.ts';
import { createCalendarRefresher, type CalendarRefresher } from '../src/calendar/refresher.ts';
import { seal } from '../src/calendar/secret.ts';
import { claimDueCalendar } from '../src/stores/cross-tenant.ts';
import { createTownwiseStores, type TownwiseStores } from '../src/stores/index.ts';
import type { OwnerCalendarRecord } from '../src/stores/owner-calendars.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { MINUTE, startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const HOUR = 60 * MINUTE;
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
  { uid: 'dinner@example.test', title: 'Rehearsal dinner', startDate: '2026-06-10', endDate: '2026-06-10', startTime: '18:00', endTime: '21:00' },
  { uid: 'party@example.test', title: 'Office party', startDate: '2026-06-20', endDate: '2026-06-20', startTime: null, endTime: null },
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

let server: TownwiseTestServer;
let stores: TownwiseStores;
const logs: string[] = [];
const logger = createLogger({ LOG_LEVEL: 'info' }, { destination: { write: (line: string) => { logs.push(line); } } });

beforeAll(async () => {
  server = await startTownwiseServer();
  stores = createTownwiseStores(server.connection);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  // Each test sees only its own calendars: the loop claims due links in every organization.
  await server.connection.collection('tw_calendar_sources').deleteMany({});
  await server.connection.collection('tw_calendar_events').deleteMany({});
  logs.length = 0;
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

function refresherOf(fetcher: CalendarFetcher, opts: { key?: KeyObject; firstTickMs?: number } = {}): CalendarRefresher {
  return createCalendarRefresher({
    connection: server.connection, stores, key: opts.key ?? KEY, logger, now: server.clock.now, fetcher,
    ...(opts.firstTickMs === undefined ? {} : { firstTickMs: opts.firstTickMs }),
  });
}

function at(ms: number): Date {
  return new Date(server.clock.now().getTime() + ms);
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
      .toEqual({ calendarId: due.calendar.id, orgId: t.orgId, locationId: t.locationId });
    expect(await source(due.calendar.id)).toMatchObject({ leaseUntil });
    expect(await claimDueCalendar(server.connection, { now: server.clock.now(), leaseUntil }))
      .toEqual({ calendarId: later.calendar.id, orgId: t.orgId, locationId: t.locationId });
    // The file, the link not due yet and the two under live leases are not claimed.
    expect(await claimDueCalendar(server.connection, { now: server.clock.now(), leaseUntil })).toBeNull();

    // A lease that ran out (its replica stopped) is taken again.
    await setSource(leased.calendar.id, { leaseUntil: at(-1) });
    expect(await claimDueCalendar(server.connection, { now: server.clock.now(), leaseUntil }))
      .toMatchObject({ calendarId: leased.calendar.id });
  });

  it('gives a due link to exactly one of the claims racing for it', async () => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimDueCalendar(server.connection, {
      now: server.clock.now(), leaseUntil: at(2 * MINUTE),
    })));
    expect(claims.filter((claim) => claim !== null)).toEqual([{ calendarId: calendar.id, orgId: t.orgId, locationId: t.locationId }]);
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

  it('replaces the events on success, records it, holds a 2 minute lease meanwhile, and is next due in 6 hours', async () => {
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
    expect(lease).toEqual(at(2 * MINUTE));
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
  it('looks shortly after start, and close waits for the refresh in flight', async () => {
    const t = await tenant();
    const { calendar } = await addLink(t);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const fetcher = fakeFetcher(async () => {
      await held;
      return feed(LATER);
    });
    const refresher = refresherOf(fetcher, { firstTickMs: 1 });
    refresher.start();
    await vi.waitFor(() => { expect(fetcher.calls).toHaveLength(1); });

    let closed = false;
    const closing = refresher.close().then(() => { closed = true; });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(closed).toBe(false);
    release();
    await closing;

    expect(await calendarOf(t, calendar.id)).toMatchObject({ status: 'ok', eventCount: 3, leaseUntil: null });
    // Closed, it claims nothing more.
    await makeDue(calendar.id);
    expect(await refresher.drain()).toBe(0);
  });

  it('logs the calendar id, the status, the counts and the duration only: never the address, host, label or a title', async () => {
    const t = await tenant();
    const ok = await addLink(t);
    const failed = await addLink(t);
    const fetcher = fakeFetcher((address) => (address === ok.address ? feed(LATER) : { ok: false, code: 'http_error' }));

    expect(await refresherOf(fetcher).drain()).toBe(2);

    const lines = logs.map((line) => JSON.parse(line) as Record<string, unknown>);
    const refreshed = lines.filter((line) => line.msg === 'townwise.calendar_refreshed');
    expect(refreshed).toHaveLength(2);
    // Without pino's own fields.
    const fields = (line: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(line)
      .filter(([key]) => !['level', 'time', 'pid', 'hostname', 'msg'].includes(key)));
    expect(refreshed.map(fields)).toEqual(expect.arrayContaining([
      { calendarId: ok.calendar.id, status: 'ok', eventCount: 3, skippedRepeating: 1, durationMs: 0 },
      { calendarId: failed.calendar.id, status: 'http_error', eventCount: 2, skippedRepeating: 0, durationMs: 0 },
    ]));
    const text = logs.join('\n');
    for (const secret of [TOKEN, HOST, LABEL, ...ADDED_TITLES, ...LATER_TITLES, 'Weekly trivia']) expect(text).not.toContain(secret);
  });
});
