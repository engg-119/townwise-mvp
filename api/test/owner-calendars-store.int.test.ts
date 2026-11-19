// The owner's calendars store (src/stores/owner-calendars.ts, openspec change connect-owner-calendar, design decisions 1
// and 2): a link's address kept only sealed and never in a record, replace by generation (a reader never sees a mix,
// and a crash before the switch leaves rows the next replace or the removal deletes), 5 calendars per location against
// concurrent adds, 2,000 events per calendar, range reads, removal and tenant scoping. Google calendars (openspec change
// connect-google-calendar, design decision 6): a slot each, their sealed ids and connections read only by googleSource
// and googleSources, a connection's calendars counted, made due and removed, and "Refresh now" for them. Every title
// here is made up.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { MAX_EVENTS, type IcsEvent } from '../src/calendar/ics.ts';
import {
  createOwnerCalendarStore, MANUAL_REFRESH_INTERVAL_MS, MAX_CALENDARS, REFRESH_INTERVAL_MS, type OwnerCalendarRecord, type OwnerCalendarStore,
  type ParsedCalendar,
} from '../src/stores/owner-calendars.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { holdCalls } from './helpers/hold.ts';
import { MINUTE, startTownwiseServer, writesDuring, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
/** What calendar/secret.ts would hand the store: opaque here. */
const SEALED = 'sealed-address-placeholder-0001';
const NOVEMBER = { from: '2026-11-01', to: '2026-11-30' };

let server: TownwiseTestServer;
let calendars: OwnerCalendarStore;

beforeAll(async () => {
  server = await startTownwiseServer();
  calendars = createOwnerCalendarStore(server.connection);
});
afterAll(async () => { await server.close(); });
afterEach(() => { vi.restoreAllMocks(); });

interface Tenant { orgId: string; locationId: string; scope: OrgScope }

async function tenant(): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Calendar Cafe ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, locationId, scope: scopeForNewOrg(STAFF, orgId) };
}

function event(uid: string, startDate: string, opts: { title?: string; endDate?: string; startTime?: string; endTime?: string; keyed?: boolean } = {}): IcsEvent {
  return {
    uid, title: opts.title ?? `Event ${uid}`, startDate, endDate: opts.endDate ?? startDate, startTime: opts.startTime ?? null,
    endTime: opts.endTime ?? null, keyed: opts.keyed ?? true,
  };
}

function parsed(events: IcsEvent[], skippedRepeating = 0): ParsedCalendar {
  return { events, skippedRepeating };
}

function addCalendar(t: Tenant, label: string, events: IcsEvent[], locationId = t.locationId): Promise<OwnerCalendarRecord | 'calendar_limit'> {
  return calendars.add(t.scope, locationId, { kind: 'file', label }, parsed(events), { createdBy: 'user-0001', now: server.clock.now() });
}

async function addFile(t: Tenant, label: string, events: IcsEvent[], locationId = t.locationId): Promise<OwnerCalendarRecord> {
  const added = await addCalendar(t, label, events, locationId);
  if (added === 'calendar_limit') throw new Error('calendar_limit');
  return added;
}

/** The fields of a raw tw_calendar_events row the tests read. */
interface EventRow { generation: number; uid: string; title: string }

function rowsOf(calendarId: string) {
  return server.connection.collection<EventRow>('tw_calendar_events').find({ sourceId: new Types.ObjectId(calendarId) }).sort({ generation: 1, _id: 1 }).toArray();
}

async function titlesIn(t: Tenant): Promise<string[]> {
  return (await calendars.eventsBetween(t.scope, t.locationId, NOVEMBER)).map((each) => each.title);
}

function count(collection: string, filter: Record<string, unknown>): Promise<number> {
  return server.connection.collection(collection).countDocuments(filter);
}

/** Both collections' documents of one organization, serialized, so any write shows. */
async function snapshotOf(orgId: string): Promise<string> {
  const filter = { orgId: new Types.ObjectId(orgId) };
  return JSON.stringify([
    await server.connection.collection('tw_calendar_sources').find(filter).sort({ _id: 1 }).toArray(),
    await server.connection.collection('tw_calendar_events').find(filter).sort({ _id: 1 }).toArray(),
  ]);
}

function sourceModel(): Record<'updateOne', (...args: unknown[]) => unknown> {
  return server.connection.models.TwCalendarSource as unknown as Record<'updateOne', (...args: unknown[]) => unknown>;
}

/** A replace that stops after writing its events, before switching the calendar to them, as a crash would. */
async function crashBeforeSwitch(t: Tenant, calendarId: string, events: IcsEvent[]): Promise<void> {
  vi.spyOn(sourceModel(), 'updateOne').mockImplementationOnce(() => Promise.reject(new Error('crashed')));
  await expect(calendars.replaceEvents(t.scope, t.locationId, calendarId, parsed(events), server.clock.now())).rejects.toThrow('crashed');
}

describe('adding and listing', () => {
  it('adds a file calendar with its events, and a link with its sealed address and host, which no record carries', async () => {
    const t = await tenant();
    const now = server.clock.now();
    const file = await calendars.add(t.scope, t.locationId, { kind: 'file', label: 'Bookings' }, parsed([
      event('a1', '2026-11-05', { title: 'Rehearsal dinner', startTime: '18:00', endTime: '21:00' }), event('a2', '2026-11-06'), event('a3', '2026-11-07'),
    ], 2), { createdBy: 'user-0001', now });
    const link = await calendars.add(t.scope, t.locationId, { kind: 'link', label: 'Google', sealedAddress: SEALED, host: 'calendar.google.com' },
      parsed([event('b1', '2026-11-08')]), { createdBy: 'user-0002', now });
    if (file === 'calendar_limit' || link === 'calendar_limit') throw new Error('calendar_limit');

    expect(file).toEqual({
      id: expect.any(String) as string, locationId: t.locationId, kind: 'file', label: 'Bookings', host: null, eventCount: 3, skippedRepeating: 2,
      status: 'ok', lastSuccessAt: now, lastAttemptAt: now, nextRefreshAt: null, leaseUntil: null, consecutiveFailures: 0,
      lastManualRefreshAt: null, createdBy: 'user-0001', createdAt: now, format: 'ics',
      bookings: { state: 'unsorted', sortedAt: null, confirmedAt: null, confirmedBy: null }, fromFileId: null, autoSort: null,
    });
    // A link is fetched again 6 hours after it is added; a file never is.
    expect(link).toMatchObject({
      kind: 'link', label: 'Google', host: 'calendar.google.com', eventCount: 1, nextRefreshAt: new Date(now.getTime() + REFRESH_INTERVAL_MS),
    });
    expect(await calendars.find(t.scope, t.locationId, file.id)).toEqual(file);
    expect(await calendars.find(t.scope, t.locationId, link.id)).toEqual(link);
    const listed = await calendars.list(t.scope, t.locationId);
    expect(listed).toEqual([file, link]);
    expect(JSON.stringify([file, link, listed])).not.toContain(SEALED);
    expect(Object.keys(link)).not.toContain('sealedAddress');

    // The database holds the address only as the sealed string, and the host in plain text.
    const raw = await server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(link.id) });
    expect(raw).toMatchObject({ kind: 'link', sealedAddress: SEALED, host: 'calendar.google.com', generation: 1, slot: 1 });
    expect(await calendars.sealedAddress(t.scope, t.locationId, link.id)).toBe(SEALED);
    expect(await calendars.sealedAddress(t.scope, t.locationId, file.id)).toBeNull();
    const patio = await addLocation(server, { orgId: t.orgId, name: 'Patio' });
    expect(await calendars.sealedAddress(t.scope, patio, link.id)).toBeNull();

    // An event keeps its UID, title, dates and hours, and nothing else.
    const rows = await rowsOf(file.id);
    expect(rows).toHaveLength(3);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      '_id', 'endDate', 'endTime', 'generation', 'keyed', 'locationId', 'orgId', 'sourceId', 'startDate', 'startTime', 'title', 'uid',
    ]);
    expect(rows[0]).toMatchObject({ generation: 1, uid: 'a1', title: 'Rehearsal dinner', startDate: '2026-11-05', startTime: '18:00', endTime: '21:00', keyed: true });
  });

  it('reads the events overlapping a range from each calendar, with its name, by start, and none from another location', async () => {
    const t = await tenant();
    const bookings = await addFile(t, 'Bookings', [
      event('long', '2026-10-30', { title: 'Inventory', endDate: '2026-11-01' }),
      event('dinner', '2026-11-05', { title: 'Rehearsal dinner', startTime: '18:00', endTime: '21:00' }),
      event('october', '2026-10-20', { title: 'Staff training' }),
      event('december', '2026-12-01', { title: 'Holiday party' }),
    ]);
    const catering = await addFile(t, 'Catering', [event('lunch', '2026-11-05', { title: 'Office lunch' }), event('last', '2026-11-30', { title: 'Wedding' })]);
    const patio = await addLocation(server, { orgId: t.orgId, name: 'Patio' });
    await addFile(t, 'Patio bookings', [event('patio', '2026-11-10', { title: 'Patio party' })], patio);

    const events = await calendars.eventsBetween(t.scope, t.locationId, NOVEMBER);
    expect(events.map((each) => [each.calendar, each.title, each.startDate, each.endDate, each.startTime, each.endTime])).toEqual([
      ['Bookings', 'Inventory', '2026-10-30', '2026-11-01', null, null],
      ['Catering', 'Office lunch', '2026-11-05', '2026-11-05', null, null],
      ['Bookings', 'Rehearsal dinner', '2026-11-05', '2026-11-05', '18:00', '21:00'],
      ['Catering', 'Wedding', '2026-11-30', '2026-11-30', null, null],
    ]);
    expect(events[0]).toEqual({
      calendarId: bookings.id, calendar: 'Bookings', uid: 'long', title: 'Inventory', startDate: '2026-10-30', endDate: '2026-11-01',
      startTime: null, endTime: null, booking: null, bookingBy: null,
    });
    expect(events[1]?.calendarId).toBe(catering.id);
    expect((await calendars.eventsBetween(t.scope, patio, NOVEMBER)).map((each) => each.title)).toEqual(['Patio party']);
  });

  it('keeps at most 2,000 events per calendar, the first ones given', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Busy', Array.from({ length: MAX_EVENTS + 1 }, (_, index) => event(`many-${String(index)}`, '2026-11-15')));
    expect(added.eventCount).toBe(MAX_EVENTS);
    const rows = await rowsOf(added.id);
    expect(rows).toHaveLength(MAX_EVENTS);
    expect(rows.map((row) => row.uid)).not.toContain(`many-${String(MAX_EVENTS)}`);
    expect(await calendars.find(t.scope, t.locationId, added.id)).toMatchObject({ eventCount: MAX_EVENTS });
  });
});

describe('replace by generation', () => {
  it('writes the new events under the next generation, switches the calendar to them, then deletes the old ones', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [event('a', '2026-11-03', { title: 'Old one' }), event('b', '2026-11-04', { title: 'Old two' })]);
    server.clock.advance(MINUTE);
    const later = server.clock.now();
    let replaced: { switched: boolean } | undefined;
    const writes = await writesDuring(server, async () => {
      replaced = await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([
        event('c', '2026-11-05', { title: 'New one' }), event('d', '2026-11-06', { title: 'New two' }), event('e', '2026-11-07', { title: 'New three' }),
      ], 1), later);
    });
    expect(replaced?.switched).toBe(true);
    expect(writes).toEqual(['findAndModify tw_calendar_sources', 'insert tw_calendar_events', 'update tw_calendar_sources', 'delete tw_calendar_events']);
    expect(await calendars.find(t.scope, t.locationId, added.id)).toMatchObject({
      eventCount: 3, skippedRepeating: 1, status: 'ok', lastSuccessAt: later, lastAttemptAt: later, consecutiveFailures: 0,
    });
    expect((await rowsOf(added.id)).map((row) => row.generation)).toEqual([2, 2, 2]);
    expect(await titlesIn(t)).toEqual(['New one', 'New two', 'New three']);

    // A calendar whose events all went is emptied.
    expect((await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([]), later)).switched).toBe(true);
    expect(await rowsOf(added.id)).toEqual([]);
    expect(await calendars.find(t.scope, t.locationId, added.id)).toMatchObject({ eventCount: 0 });
  });

  it('a crash after the new events are written but before the switch: reads return the old events, and the next replace deletes the unused rows', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [event('a', '2026-11-03', { title: 'Old one' }), event('b', '2026-11-04', { title: 'Old two' })]);
    await crashBeforeSwitch(t, added.id, [event('c', '2026-11-05', { title: 'New one' }), event('d', '2026-11-06', { title: 'New two' })]);
    expect((await rowsOf(added.id)).map((row) => row.generation)).toEqual([1, 1, 2, 2]);
    expect(await titlesIn(t)).toEqual(['Old one', 'Old two']);
    expect(await calendars.find(t.scope, t.locationId, added.id)).toMatchObject({ eventCount: 2 });

    expect((await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('f', '2026-11-08', { title: 'Newest' })]), server.clock.now())).switched).toBe(true);
    expect((await rowsOf(added.id)).map((row) => [row.generation, row.title])).toEqual([[3, 'Newest']]);
    expect(await titlesIn(t)).toEqual(['Newest']);
  });

  it('a crash before the switch, then removal: the calendar goes with every row, the unused ones included', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [event('a', '2026-11-03', { title: 'Old one' })]);
    await crashBeforeSwitch(t, added.id, [event('c', '2026-11-05', { title: 'New one' })]);
    expect(await rowsOf(added.id)).toHaveLength(2);
    expect(await calendars.remove(t.scope, t.locationId, added.id)).toBe(true);
    expect(await rowsOf(added.id)).toEqual([]);
    expect(await calendars.find(t.scope, t.locationId, added.id)).toBeNull();
    expect(await titlesIn(t)).toEqual([]);
    expect(await calendars.remove(t.scope, t.locationId, added.id)).toBe(false);
  });

  it('an add that fails after writing its events, before the switch, removes the calendar and its rows, and a retry adds it once', async () => {
    const t = await tenant();
    const org = { orgId: new Types.ObjectId(t.orgId) };
    vi.spyOn(sourceModel(), 'updateOne').mockImplementationOnce(() => Promise.reject(new Error('crashed')));
    await expect(addCalendar(t, 'Bookings', [event('a', '2026-11-05', { title: 'Rehearsal dinner' })])).rejects.toThrow('crashed');
    expect(await count('tw_calendar_sources', org)).toBe(0);
    expect(await count('tw_calendar_events', org)).toBe(0);

    const retried = await addFile(t, 'Bookings', [event('a', '2026-11-05', { title: 'Rehearsal dinner' })]);
    expect(await calendars.list(t.scope, t.locationId)).toEqual([retried]);
    expect(await server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(retried.id) })).toMatchObject({ slot: 0, generation: 1 });
    expect(await titlesIn(t)).toEqual(['Rehearsal dinner']);
  });

  it('an add whose calendar is removed before its events are switched in fails rather than answer a record, and leaves nothing', async () => {
    const t = await tenant();
    const hold = holdCalls(server, 'updateOne', 'TwCalendarSource');
    try {
      const adding = addCalendar(t, 'Bookings', [event('a', '2026-11-05', { title: 'Rehearsal dinner' })]);
      // Created, its events written, about to switch.
      await hold.arrived(1);
      const [created] = await calendars.list(t.scope, t.locationId);
      expect(await calendars.remove(t.scope, t.locationId, created?.id ?? '')).toBe(true);
      hold.release(1);
      await expect(adding).rejects.toThrow('removed or refreshed');
    } finally {
      hold.restore();
    }
    const org = { orgId: new Types.ObjectId(t.orgId) };
    expect(await count('tw_calendar_sources', org)).toBe(0);
    expect(await count('tw_calendar_events', org)).toBe(0);
  });

  it('of two replaces started together, the one that switches second loses its compare-and-set and deletes its own rows', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [event('a', '2026-11-03', { title: 'Old one' })]);
    const hold = holdCalls(server, 'updateOne', 'TwCalendarSource');
    try {
      const first = calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([
        event('x1', '2026-11-05', { title: 'First fetch' }), event('x2', '2026-11-06', { title: 'First fetch' }),
      ]), server.clock.now());
      await hold.arrived(1);
      const second = calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('y1', '2026-11-05', { title: 'Second fetch' })]), server.clock.now());
      await hold.arrived(2);
      // Each wrote its rows under a generation of its own before either switched.
      expect((await rowsOf(added.id)).map((row) => row.generation)).toEqual([1, 2, 2, 3]);
      hold.release(1);
      expect((await first).switched).toBe(true);
      hold.release(2);
      expect((await second).switched).toBe(false);
    } finally {
      hold.restore();
    }
    expect((await rowsOf(added.id)).map((row) => [row.generation, row.title])).toEqual([[2, 'First fetch'], [2, 'First fetch']]);
    expect(await calendars.find(t.scope, t.locationId, added.id)).toMatchObject({ eventCount: 2 });
  });

  it('a replace deletes only older generations, so a newer replace already writing keeps all of its rows', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [event('a', '2026-11-03', { title: 'Old one' })]);
    const hold = holdCalls(server, 'deleteMany', 'TwCalendarEvent');
    try {
      const older = calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('x1', '2026-11-05', { title: 'Older fetch' })]), server.clock.now());
      // Switched to generation 2, about to delete what is older.
      await hold.arrived(1);
      const newer = calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([
        event('y1', '2026-11-05', { title: 'Newer fetch' }), event('y2', '2026-11-06', { title: 'Newer fetch' }),
      ]), server.clock.now());
      // Switched from 2 to 3, about to delete what is older.
      await hold.arrived(2);
      hold.release(1);
      expect((await older).switched).toBe(true);
      expect((await rowsOf(added.id)).map((row) => row.generation)).toEqual([2, 3, 3]);
      hold.release(2);
      expect((await newer).switched).toBe(true);
    } finally {
      hold.restore();
    }
    expect((await rowsOf(added.id)).map((row) => [row.generation, row.title])).toEqual([[3, 'Newer fetch'], [3, 'Newer fetch']]);
    expect(await titlesIn(t)).toEqual(['Newer fetch', 'Newer fetch']);
  });

  it('a read that raced a replace, its generation deleted under it, reads again at the new one', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [event('a', '2026-11-03', { title: 'Old one' })]);
    // The calendar as a read saw it just before the replace switched it: generation 1.
    const stale = await server.connection.collection('tw_calendar_sources').find({ _id: new Types.ObjectId(added.id) }).toArray();
    expect((await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('b', '2026-11-04', { title: 'New one' })]), server.clock.now())).switched).toBe(true);
    const model = server.connection.models.TwCalendarSource as unknown as Record<'find', (...args: unknown[]) => unknown>;
    vi.spyOn(model, 'find').mockImplementationOnce(() => ({ sort: () => ({ lean: () => Promise.resolve(stale) }) }));
    expect(await titlesIn(t)).toEqual(['New one']);
  });

  it('a replace that switches while the calendar is being removed loses its rows to the removal’s second pass', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [event('a', '2026-11-03', { title: 'Old one' })]);
    const hold = holdCalls(server, 'deleteMany', 'TwCalendarSource');
    try {
      const removal = calendars.remove(t.scope, t.locationId, added.id);
      // The events are deleted, the calendar not yet.
      await hold.arrived(1);
      expect((await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('late', '2026-11-05', { title: 'Late fetch' })]), server.clock.now())).switched).toBe(true);
      expect(await rowsOf(added.id)).toHaveLength(1);
      hold.release(1);
      expect(await removal).toBe(true);
    } finally {
      hold.restore();
    }
    expect(await rowsOf(added.id)).toEqual([]);
    expect(await calendars.find(t.scope, t.locationId, added.id)).toBeNull();
  });
});

describe('stable keys (calendar-event-suggestions, design decisions 1 and 12)', () => {
  const kept = (result: Awaited<ReturnType<OwnerCalendarStore['replaceEvents']>>) =>
    (result.switched ? { keptKeys: result.keptKeys, hadKeys: result.hadKeys } : null);

  it('findEvent reads one event of the current generation with whether it is keyed, and eventsByUid the keyed ones asked for', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [
      event('party@example.test', '2026-11-05', { title: 'Private party', startTime: '18:00', endTime: '22:00' }),
      event('event-2', '2026-11-06', { keyed: false }),
      event('lunch@example.test', '2026-11-07'),
    ]);
    expect(await calendars.findEvent(t.scope, t.locationId, added.id, 'party@example.test')).toEqual({
      uid: 'party@example.test', title: 'Private party', startDate: '2026-11-05', endDate: '2026-11-05', startTime: '18:00', endTime: '22:00', keyed: true,
    });
    expect(await calendars.findEvent(t.scope, t.locationId, added.id, 'event-2')).toMatchObject({ uid: 'event-2', keyed: false });
    expect(await calendars.findEvent(t.scope, t.locationId, added.id, 'missing@example.test')).toBeNull();

    const read = await calendars.eventsByUid(t.scope, t.locationId, added.id, ['party@example.test', 'event-2', 'missing@example.test']);
    expect(read).toEqual({ generation: 1, eventCount: 3, events: [expect.objectContaining({ uid: 'party@example.test', keyed: true })] });
    expect(await calendars.eventsByUid(t.scope, t.locationId, added.id, [])).toEqual({ generation: 1, eventCount: 3, events: [] });

    // After a replace, the old generation's events are not found.
    expect((await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('lunch@example.test', '2026-11-08')]), server.clock.now())).switched).toBe(true);
    expect(await calendars.findEvent(t.scope, t.locationId, added.id, 'party@example.test')).toBeNull();
    expect(await calendars.findEvent(t.scope, t.locationId, added.id, 'lunch@example.test')).toMatchObject({ startDate: '2026-11-08' });
  });

  it('keyedEventsBetween answers the keyed events with their calendar’s id, kind, connection and whether its add showed the notice, never its name', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Sentinel Bookings', [
      event('party@example.test', '2026-11-05', { title: 'Private party' }), event('event-2', '2026-11-06', { keyed: false }),
    ]);
    const read = await calendars.keyedEventsBetween(t.scope, t.locationId, NOVEMBER);
    expect(read).toEqual([{
      uid: 'party@example.test', title: 'Private party', startDate: '2026-11-05', endDate: '2026-11-05', startTime: null, endTime: null, keyed: true,
      calendarId: added.id, kind: 'file', connectionId: null, titlesNotice: false, labeled: false,
    }]);
    expect(JSON.stringify(read)).not.toContain('Sentinel Bookings');
    const noticed = await calendars.add(t.scope, t.locationId, { kind: 'file', label: 'Noticed', titlesNotice: 1 }, parsed([event('lunch@example.test', '2026-11-07')]), {
      createdBy: 'user-0001', now: server.clock.now(),
    });
    if (noticed === 'calendar_limit') throw new Error('calendar_limit');
    expect((await calendars.keyedEventsBetween(t.scope, t.locationId, NOVEMBER)).map((each) => [each.uid, each.titlesNotice])).toEqual([
      ['party@example.test', false], ['lunch@example.test', true],
    ]);
  });

  it('eventsByUid answers null when a replace switched the calendar while it read', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [event('a@example.test', '2026-11-03')]);
    const model = server.connection.models.TwCalendarSource as unknown as Record<'findOne', (...args: unknown[]) => unknown>;
    const findOne = model.findOne.bind(model);
    let calls = 0;
    vi.spyOn(model, 'findOne').mockImplementation((...args: unknown[]) => {
      calls += 1;
      // The second read, after the events were read, sees a newer generation.
      return calls === 2 ? { lean: () => Promise.resolve({ generation: 2 }) } : findOne(...args);
    });
    expect(await calendars.eventsByUid(t.scope, t.locationId, added.id, ['a@example.test'])).toBeNull();
  });

  it('replaceEvents counts the keyed uids it kept from the generation it replaced: 3 kept, then 0', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', ['k1', 'k2', 'k3', 'k4'].map((uid) => event(uid, '2026-11-05')));
    expect(kept(await calendars.replaceEvents(t.scope, t.locationId, added.id,
      parsed([event('k1', '2026-11-05'), event('k2', '2026-11-06'), event('k3', '2026-11-07'), event('new', '2026-11-08')]), server.clock.now())))
      .toEqual({ keptKeys: 3, hadKeys: 4 });
    expect(kept(await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('x', '2026-11-05'), event('y', '2026-11-06')]), server.clock.now())))
      .toEqual({ keptKeys: 0, hadKeys: 4 });
    // A calendar with no events had no keys.
    expect(kept(await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([]), server.clock.now()))).toEqual({ keptKeys: 0, hadKeys: 2 });
    expect(kept(await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('x', '2026-11-05')]), server.clock.now()))).toEqual({ keptKeys: 0, hadKeys: 0 });
  });

  it('a feed of UID-less events whose stated UIDs are all rewritten answers keptKeys 0, though its event-{n} keys repeat', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [
      event('event-1', '2026-11-03', { keyed: false }), event('event-2', '2026-11-04', { keyed: false }),
      event('r1-first-fetch', '2026-11-05'), event('r2-first-fetch', '2026-11-06'),
    ]);
    expect(kept(await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([
      event('event-1', '2026-11-03', { keyed: false }), event('event-2', '2026-11-04', { keyed: false }),
      event('r1-second-fetch', '2026-11-05'), event('r2-second-fetch', '2026-11-06'),
    ]), server.clock.now()))).toEqual({ keptKeys: 0, hadKeys: 2 });
  });

  it('an old row without keyed reads as not keyed, and counts as no key', async () => {
    const t = await tenant();
    const added = await addFile(t, 'Bookings', [event('old@example.test', '2026-11-05')]);
    await server.connection.collection('tw_calendar_events').updateMany({ sourceId: new Types.ObjectId(added.id) }, { $unset: { keyed: '' } });
    expect(await calendars.findEvent(t.scope, t.locationId, added.id, 'old@example.test')).toMatchObject({ uid: 'old@example.test', keyed: false });
    expect(await calendars.eventsByUid(t.scope, t.locationId, added.id, ['old@example.test'])).toMatchObject({ events: [] });
    expect(kept(await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('old@example.test', '2026-11-05')]), server.clock.now())))
      .toEqual({ keptKeys: 0, hadKeys: 0 });
  });
});

describe('the limit', () => {
  it('refuses a sixth calendar with calendar_limit and stores nothing; another location has its own five, and a removal frees a slot', async () => {
    const t = await tenant();
    for (let n = 1; n <= MAX_CALENDARS; n += 1) await addFile(t, `Calendar ${String(n)}`, [event(`e${String(n)}`, '2026-11-05')]);
    const before = await snapshotOf(t.orgId);
    expect(await addCalendar(t, 'Sixth', [event('six', '2026-11-05', { title: 'Sixth event' })])).toBe('calendar_limit');
    expect(await snapshotOf(t.orgId)).toBe(before);

    const patio = await addLocation(server, { orgId: t.orgId, name: 'Patio' });
    await addFile(t, 'Patio bookings', [event('patio', '2026-11-05')], patio);

    const [oldest] = await calendars.list(t.scope, t.locationId);
    expect(await calendars.remove(t.scope, t.locationId, oldest?.id ?? '')).toBe(true);
    expect(await addCalendar(t, 'Sixth', [event('six', '2026-11-05', { title: 'Sixth event' })])).toMatchObject({ label: 'Sixth', eventCount: 1 });
    expect((await calendars.list(t.scope, t.locationId)).map((each) => each.label)).toEqual(['Calendar 2', 'Calendar 3', 'Calendar 4', 'Calendar 5', 'Sixth']);
  });

  it('two adds racing for the last slot: the unique slot index takes one, and the other is calendar_limit with no events stored', async () => {
    const t = await tenant();
    for (let n = 1; n < MAX_CALENDARS; n += 1) await addFile(t, `Calendar ${String(n)}`, [event(`e${String(n)}`, '2026-11-05')]);
    const hold = holdCalls(server, 'create', 'TwCalendarSource');
    let results: (OwnerCalendarRecord | 'calendar_limit')[];
    try {
      const racing = ['Racer A', 'Racer B'].map((label) => addCalendar(t, label, [event('race', '2026-11-05', { title: `${label} event` })]));
      // Both read four taken slots, and both are about to insert into the fifth.
      await hold.arrived(1);
      await hold.arrived(2);
      hold.open();
      results = await Promise.all(racing);
    } finally {
      hold.restore();
    }
    const winner = results.find((result) => result !== 'calendar_limit');
    expect(results.filter((result) => result === 'calendar_limit')).toHaveLength(1);
    expect(await calendars.list(t.scope, t.locationId)).toHaveLength(MAX_CALENDARS);
    const loser = winner?.label === 'Racer A' ? 'Racer B' : 'Racer A';
    expect(await count('tw_calendar_events', { orgId: new Types.ObjectId(t.orgId), title: `${loser} event` })).toBe(0);
    expect(await count('tw_calendar_events', { orgId: new Types.ObjectId(t.orgId), title: `${winner?.label ?? ''} event` })).toBe(1);

    // Unheld, three adds at once onto three calendars: two fit.
    const u = await tenant();
    for (let n = 1; n <= 3; n += 1) await addFile(u, `Calendar ${String(n)}`, [event(`e${String(n)}`, '2026-11-05')]);
    const three = await Promise.all(['One', 'Two', 'Three'].map((label) => addCalendar(u, label, [event('race', '2026-11-05')])));
    expect(three.filter((result) => result === 'calendar_limit')).toHaveLength(1);
    expect(await calendars.list(u.scope, u.locationId)).toHaveLength(MAX_CALENDARS);
  });
});

describe('a stored file’s calendar (D60)', () => {
  const fileCalendar = { kind: 'file', label: 'From Your data' } as const;
  const addFromFile = (t: Tenant, fileId: string, title: string) => calendars.addFromFile(
    t.scope, t.locationId, fileId, fileCalendar, parsed([event('e1', '2026-11-05', { title })]), { createdBy: 'user-0001', now: server.clock.now() },
  );

  it('keeps the file’s id, and a second add of the same file is file_imported with nothing stored', async () => {
    const t = await tenant();
    const fileId = new Types.ObjectId().toHexString();
    const first = await addFromFile(t, fileId, 'First');
    expect(first).toMatchObject({ kind: 'file', fromFileId: fileId });
    expect(await addFromFile(t, fileId, 'Second')).toBe('file_imported');
    expect(await calendars.list(t.scope, t.locationId)).toHaveLength(1);
    expect(await count('tw_calendar_events', { orgId: new Types.ObjectId(t.orgId), title: 'Second' })).toBe(0);
    // A plain add keeps no file.
    expect(await addFile(t, 'Plain', [event('p', '2026-11-05')])).toMatchObject({ fromFileId: null });
  });

  it('two adds of one file racing past the check: the unique index takes one, and the other is file_imported', async () => {
    const t = await tenant();
    const fileId = new Types.ObjectId().toHexString();
    const hold = holdCalls(server, 'create', 'TwCalendarSource');
    let results: (OwnerCalendarRecord | 'calendar_limit' | 'file_imported')[];
    try {
      const racing = ['Racer A', 'Racer B'].map((title) => addFromFile(t, fileId, title));
      // Both found no calendar of the file and are about to insert, into different free slots.
      await hold.arrived(1);
      await hold.arrived(2);
      hold.open();
      results = await Promise.all(racing);
    } finally {
      hold.restore();
    }
    expect(results.filter((result) => result === 'file_imported')).toHaveLength(1);
    expect(await calendars.list(t.scope, t.locationId)).toHaveLength(1);
    expect(await count('tw_calendar_events', { orgId: new Types.ObjectId(t.orgId) })).toBe(1);
  });

  it('a second calendar of one file is refused by the unique index even in another slot', async () => {
    const t = await tenant();
    const fileId = new Types.ObjectId().toHexString();
    const first = await addFromFile(t, fileId, 'First');
    if (typeof first === 'string') throw new Error(first);
    const row = await server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(first.id) });
    await expect(server.connection.collection('tw_calendar_sources').insertOne({ ...row, _id: new Types.ObjectId(), slot: 4 }))
      .rejects.toMatchObject({ code: 11000 });
  });
});

describe('removal and isolation', () => {
  it('answers another organization’s or another location’s calendar like an unknown one, and changes nothing', async () => {
    const a = await tenant();
    const b = await tenant();
    const ours = await addFile(a, 'Bookings', [event('a', '2026-11-05', { title: 'Our event' })]);
    const theirs = await calendars.add(b.scope, b.locationId, { kind: 'link', label: 'Theirs', sealedAddress: SEALED, host: 'calendar.google.com' },
      parsed([event('b', '2026-11-05', { title: 'Their event' })]), { createdBy: 'user-0003', now: server.clock.now() });
    if (theirs === 'calendar_limit') throw new Error('calendar_limit');
    const patio = await addLocation(server, { orgId: a.orgId, name: 'Patio' });
    const aBefore = await snapshotOf(a.orgId);
    const bBefore = await snapshotOf(b.orgId);

    const cases: [string, string][] = [[b.locationId, theirs.id], [a.locationId, theirs.id], [patio, ours.id], [a.locationId, new Types.ObjectId().toHexString()]];
    for (const [locationId, calendarId] of cases) {
      expect(await calendars.find(a.scope, locationId, calendarId)).toBeNull();
      expect(await calendars.sealedAddress(a.scope, locationId, calendarId)).toBeNull();
      expect(await calendars.findEvent(a.scope, locationId, calendarId, 'b')).toBeNull();
      expect(await calendars.findEvent(a.scope, locationId, calendarId, 'a')).toBeNull();
      expect(await calendars.eventsByUid(a.scope, locationId, calendarId, ['a', 'b'])).toBeNull();
      expect((await calendars.replaceEvents(a.scope, locationId, calendarId, parsed([event('x', '2026-11-05')]), server.clock.now())).switched).toBe(false);
      expect(await calendars.remove(a.scope, locationId, calendarId)).toBe(false);
    }
    expect(await calendars.list(a.scope, b.locationId)).toEqual([]);
    expect(await calendars.eventsBetween(a.scope, b.locationId, NOVEMBER)).toEqual([]);
    expect(await calendars.removeForLocation(a.scope, b.locationId)).toBe(0);
    expect(await snapshotOf(a.orgId)).toBe(aBefore);
    expect(await snapshotOf(b.orgId)).toBe(bBefore);
  });

  it('removeForLocation and removeForOrg delete the calendars and every row, unused ones included, and no one else’s', async () => {
    const a = await tenant();
    const b = await tenant();
    const patio = await addLocation(server, { orgId: a.orgId, name: 'Patio' });
    const main = await addFile(a, 'Main', [event('m1', '2026-11-05'), event('m2', '2026-11-06')]);
    await crashBeforeSwitch(a, main.id, [event('m3', '2026-11-07')]);
    await addFile(a, 'Patio bookings', [event('p1', '2026-11-05')], patio);
    await addFile(b, 'Other', [event('o1', '2026-11-05')]);
    const bBefore = await snapshotOf(b.orgId);

    expect(await calendars.removeForLocation(a.scope, a.locationId)).toBe(1);
    const mainLocation = { locationId: new Types.ObjectId(a.locationId) };
    expect(await count('tw_calendar_events', mainLocation)).toBe(0);
    expect(await count('tw_calendar_sources', mainLocation)).toBe(0);
    expect((await calendars.eventsBetween(a.scope, patio, NOVEMBER)).map((each) => each.uid)).toEqual(['p1']);

    expect(await calendars.removeForOrg(a.scope)).toBe(1);
    const org = { orgId: new Types.ObjectId(a.orgId) };
    expect(await count('tw_calendar_events', org)).toBe(0);
    expect(await count('tw_calendar_sources', org)).toBe(0);
    expect(await snapshotOf(b.orgId)).toBe(bBefore);
  });
});

describe('Google calendars (connect-google-calendar)', () => {
  /** What calendar/secret.ts would hand the store for a Google calendar id: opaque here. */
  const SEALED_ID = 'sealed-google-calendar-id-placeholder-0001';
  const connection = (): string => new Types.ObjectId().toHexString();

  async function addGoogle(t: Tenant, label: string, events: IcsEvent[], googleConnectionId: string, opts: { locationId?: string; sealed?: string } = {}): Promise<OwnerCalendarRecord> {
    const added = await calendars.add(t.scope, opts.locationId ?? t.locationId, { kind: 'google', label, sealedAddress: opts.sealed ?? SEALED_ID, googleConnectionId },
      parsed(events), { createdBy: 'user-0001', now: server.clock.now() });
    if (added === 'calendar_limit') throw new Error('calendar_limit');
    return added;
  }

  function rawSource(calendarId: string) {
    return server.connection.collection('tw_calendar_sources').findOne({ _id: new Types.ObjectId(calendarId) });
  }

  it('a Google calendar takes a slot and is due like a link, with no host, and its sealed id and connection in no record', async () => {
    const t = await tenant();
    const conn = connection();
    const now = server.clock.now();
    for (const label of ['File one', 'File two']) await addFile(t, label, [event(label, '2026-11-05')]);
    const links: (OwnerCalendarRecord | 'calendar_limit')[] = [];
    for (const label of ['Link one', 'Link two']) {
      links.push(await calendars.add(t.scope, t.locationId, { kind: 'link', label, sealedAddress: SEALED, host: 'calendar.google.com' }, parsed([]), { createdBy: 'user-0001', now }));
    }
    const google = await addGoogle(t, 'Google calendar', [event('g1', '2026-11-06', { title: 'Private party' })], conn);
    expect(google).toEqual({
      id: expect.any(String) as string, locationId: t.locationId, kind: 'google', label: 'Google calendar', host: null, eventCount: 1, skippedRepeating: 0,
      status: 'ok', lastSuccessAt: now, lastAttemptAt: now, nextRefreshAt: new Date(now.getTime() + REFRESH_INTERVAL_MS), leaseUntil: null,
      consecutiveFailures: 0, lastManualRefreshAt: null, createdBy: 'user-0001', createdAt: now, format: null, bookings: null, fromFileId: null, autoSort: null,
    });
    // The sixth calendar, a Google one, finds no slot.
    const before = await snapshotOf(t.orgId);
    expect(await calendars.add(t.scope, t.locationId, { kind: 'google', label: 'Another', sealedAddress: SEALED_ID, googleConnectionId: conn },
      parsed([event('g2', '2026-11-07')]), { createdBy: 'user-0001', now })).toBe('calendar_limit');
    expect(await snapshotOf(t.orgId)).toBe(before);

    const listed = await calendars.list(t.scope, t.locationId);
    expect(listed).toHaveLength(MAX_CALENDARS);
    expect(JSON.stringify([google, listed, await calendars.find(t.scope, t.locationId, google.id)])).not.toMatch(new RegExp(`${SEALED_ID}|${conn}`));
    expect(await rawSource(google.id)).toMatchObject({ kind: 'google', sealedAddress: SEALED_ID, host: null, googleConnectionId: new Types.ObjectId(conn) });
    // Files and links carry no connection, and sealedAddress stays a link's.
    const link = links[0];
    if (link === undefined || link === 'calendar_limit') throw new Error('no link');
    expect(await rawSource(link.id)).toMatchObject({ kind: 'link', googleConnectionId: null });
    expect(await calendars.sealedAddress(t.scope, t.locationId, google.id)).toBeNull();
    expect(await calendars.sealedAddress(t.scope, t.locationId, link.id)).toBe(SEALED);
  });

  it('googleSource and googleSources answer only this location’s Google calendars, oldest first', async () => {
    const a = await tenant();
    const b = await tenant();
    const patio = await addLocation(server, { orgId: a.orgId, name: 'Patio' });
    const [x, y] = [connection(), connection()];
    const first = await addGoogle(a, 'Bookings', [], x, { sealed: 'sealed-1' });
    server.clock.advance(MINUTE);
    const second = await addGoogle(a, 'Shared', [], y, { sealed: 'sealed-2' });
    const onPatio = await addGoogle(a, 'Patio bookings', [], x, { locationId: patio, sealed: 'sealed-3' });
    const file = await addFile(a, 'File', []);
    const theirs = await addGoogle(b, 'Theirs', [], x, { sealed: 'sealed-4' });

    expect(await calendars.googleSource(a.scope, a.locationId, first.id)).toEqual({ calendarId: first.id, connectionId: x, sealedCalendarId: 'sealed-1' });
    expect(await calendars.googleSources(a.scope, a.locationId)).toEqual([
      { calendarId: first.id, connectionId: x, sealedCalendarId: 'sealed-1' },
      { calendarId: second.id, connectionId: y, sealedCalendarId: 'sealed-2' },
    ]);
    expect(await calendars.googleSources(a.scope, patio)).toEqual([{ calendarId: onPatio.id, connectionId: x, sealedCalendarId: 'sealed-3' }]);
    // A file, another location's, another organization's and an unknown id answer null.
    for (const [locationId, calendarId] of [[a.locationId, file.id], [a.locationId, onPatio.id], [b.locationId, theirs.id], [a.locationId, theirs.id], [a.locationId, new Types.ObjectId().toHexString()]] as const) {
      expect(await calendars.googleSource(a.scope, locationId, calendarId)).toBeNull();
    }
    expect(await calendars.googleSources(a.scope, b.locationId)).toEqual([]);
  });

  it('countForConnection, markDueForConnection and removeForConnection reach only that connection’s Google calendars in the organization', async () => {
    const a = await tenant();
    const b = await tenant();
    const patio = await addLocation(server, { orgId: a.orgId, name: 'Patio' });
    const [x, y] = [connection(), connection()];
    const main = await addGoogle(a, 'Bookings', [event('m1', '2026-11-05'), event('m2', '2026-11-06')], x);
    const onPatio = await addGoogle(a, 'Patio bookings', [event('p1', '2026-11-05')], x, { locationId: patio });
    // A crash before a switch leaves unused rows, which the removal deletes too.
    await crashBeforeSwitch({ ...a, locationId: patio }, onPatio.id, [event('p2', '2026-11-07')]);
    expect(await rowsOf(onPatio.id)).toHaveLength(2);
    const other = await addGoogle(a, 'Shared', [event('o1', '2026-11-05')], y);
    const link = await calendars.add(a.scope, a.locationId, { kind: 'link', label: 'Link', sealedAddress: SEALED, host: 'calendar.google.com' },
      parsed([event('l1', '2026-11-05')]), { createdBy: 'user-0001', now: server.clock.now() });
    if (link === 'calendar_limit') throw new Error('calendar_limit');
    // Another organization's calendar under the same connection id still is not this organization's.
    const theirs = await addGoogle(b, 'Theirs', [event('t1', '2026-11-05')], x);
    const bBefore = await snapshotOf(b.orgId);

    expect(await calendars.countForConnection(a.scope, x)).toBe(2);
    expect(await calendars.countForConnection(a.scope, y)).toBe(1);
    expect(await calendars.countForConnection(b.scope, x)).toBe(1);
    expect(await calendars.countForConnection(a.scope, connection())).toBe(0);

    server.clock.advance(MINUTE);
    const later = server.clock.now();
    expect(await calendars.markDueForConnection(a.scope, x, later)).toBe(2);
    for (const id of [main.id, onPatio.id]) expect(await calendars.find(a.scope, id === main.id ? a.locationId : patio, id)).toMatchObject({ nextRefreshAt: later });
    expect((await calendars.find(a.scope, a.locationId, other.id))?.nextRefreshAt).toEqual(other.nextRefreshAt);
    expect((await calendars.find(a.scope, a.locationId, link.id))?.nextRefreshAt).toEqual(link.nextRefreshAt);

    let removed: number | undefined;
    const writes = await writesDuring(server, async () => { removed = await calendars.removeForConnection(a.scope, x); });
    expect(removed).toBe(2);
    expect(writes).toEqual(['delete tw_calendar_events', 'delete tw_calendar_sources', 'delete tw_calendar_events']);
    expect(await rowsOf(main.id)).toEqual([]);
    expect(await rowsOf(onPatio.id)).toEqual([]);
    expect(await calendars.find(a.scope, a.locationId, main.id)).toBeNull();
    expect(await calendars.find(a.scope, patio, onPatio.id)).toBeNull();
    expect((await calendars.list(a.scope, a.locationId)).map((each) => each.id)).toEqual([other.id, link.id]);
    expect(await rowsOf(other.id)).toHaveLength(1);
    expect(await rowsOf(link.id)).toHaveLength(1);
    expect(await snapshotOf(b.orgId)).toBe(bBefore);
    expect(await calendars.find(b.scope, b.locationId, theirs.id)).not.toBeNull();

    // Nothing left: no write at all.
    expect(await writesDuring(server, async () => { expect(await calendars.removeForConnection(a.scope, x)).toBe(0); })).toEqual([]);
    expect(await calendars.markDueForConnection(a.scope, x, later)).toBe(0);
  });

  it('"Refresh now" claims a Google calendar once per 5 minutes, as a link, and never a file', async () => {
    const t = await tenant();
    const google = await addGoogle(t, 'Google calendar', [], connection());
    const file = await addFile(t, 'File', []);
    const claim = (calendarId: string): Promise<boolean> => calendars.claimManualRefresh(t.scope, t.locationId, calendarId, server.clock.now());
    expect(await claim(google.id)).toBe(true);
    expect(await calendars.find(t.scope, t.locationId, google.id)).toMatchObject({ lastManualRefreshAt: server.clock.now() });
    server.clock.advance(MANUAL_REFRESH_INTERVAL_MS - 1);
    expect(await claim(google.id)).toBe(false);
    server.clock.advance(1);
    expect(await claim(google.id)).toBe(true);
    // Two at once: one wins.
    server.clock.advance(MANUAL_REFRESH_INTERVAL_MS);
    expect((await Promise.all([claim(google.id), claim(google.id)])).sort()).toEqual([false, true]);
    expect(await claim(file.id)).toBe(false);
    expect(await calendars.find(t.scope, t.locationId, file.id)).toMatchObject({ lastManualRefreshAt: null });
  });
});

describe('booking labels (learn-from-calendar-bookings, D58)', () => {
  const DECEMBER = { from: '2026-12-01', to: '2026-12-31' };

  it('writes the AI’s labels only where no one labeled, never over a person’s (a cleared one included), and marks the calendar sorted', async () => {
    const t = await tenant();
    const file = await addFile(t, 'Master', [event('a', '2026-12-01'), event('b', '2026-12-02'), event('c', '2026-12-03'), event('d', '2026-12-04')]);
    expect(file.bookings).toEqual({ state: 'unsorted', sortedAt: null, confirmedAt: null, confirmedBy: null });
    const now = server.clock.now();
    expect(await calendars.setLabel(t.scope, t.locationId, file.id, 'a', 'other', now)).toMatchObject({ uid: 'a', booking: null, bookingBy: null });
    expect(await calendars.setLabel(t.scope, t.locationId, file.id, 'b', null, now)).toMatchObject({ uid: 'b', booking: null, bookingBy: null });
    expect(await calendars.find(t.scope, t.locationId, file.id)).toMatchObject({ bookings: { state: 'sorted', sortedAt: null } });
    expect((await calendars.labeledEvents(t.scope, t.locationId, file.id, { unlabeled: true }))?.map((each) => each.uid)).toEqual(['c', 'd']);

    const labeled = await calendars.setLabels(t.scope, t.locationId, file.id, [
      { uid: 'a', booking: 'party' }, { uid: 'b', booking: 'buyout' }, { uid: 'c', booking: 'party' }, { uid: 'gone', booking: 'party' },
    ], now);
    expect(labeled).toBe(1);
    expect((await calendars.labeledEvents(t.scope, t.locationId, file.id))?.map((each) => [each.uid, each.booking, each.bookingBy])).toEqual([
      ['a', 'other', 'person'], ['b', null, 'person'], ['c', 'party', 'ai'], ['d', null, null],
    ]);
    expect(await calendars.find(t.scope, t.locationId, file.id)).toMatchObject({ bookings: { state: 'sorted', sortedAt: now } });
    expect((await calendars.labelCounts(t.scope, t.locationId)).get(file.id)).toEqual({ buyout: 0, party: 1, own_event: 0, other: 1, unlabeled: 2 });
    // A person's later label replaces the AI's, and answers the row as it was.
    expect(await calendars.setLabel(t.scope, t.locationId, file.id, 'c', 'buyout', now)).toMatchObject({ booking: 'party', bookingBy: 'ai' });
    expect(await calendars.setLabel(t.scope, t.locationId, file.id, 'nope', 'buyout', now)).toBeNull();
    const shown = await calendars.eventsBetween(t.scope, t.locationId, DECEMBER);
    expect(shown.map((each) => [each.uid, each.booking, each.bookingBy])).toEqual([['a', 'other', 'person'], ['b', null, 'person'], ['c', 'buyout', 'person'], ['d', null, null]]);
  });

  it('confirms once by compare-and-set, and only a confirmed calendar’s buyouts and parties reach bookingsBetween, as dates and label', async () => {
    const t = await tenant();
    const file = await addFile(t, 'Master', [
      event('party', '2026-12-05', { title: 'Sentinel party' }), event('buyout', '2026-12-06', { endDate: '2026-12-07' }),
      event('own', '2026-12-08'), event('other', '2026-12-09'), event('none', '2026-12-10'),
    ]);
    const now = server.clock.now();
    await calendars.setLabels(t.scope, t.locationId, file.id, [
      { uid: 'party', booking: 'party' }, { uid: 'buyout', booking: 'buyout' }, { uid: 'own', booking: 'own_event' }, { uid: 'other', booking: 'other' },
    ], now);
    expect(await calendars.bookingsBetween(t.scope, t.locationId, DECEMBER)).toEqual([]);
    expect((await calendars.keyedEventsBetween(t.scope, t.locationId, DECEMBER)).some((each) => each.labeled)).toBe(false);

    const confirms = await Promise.all([
      calendars.confirmBookings(t.scope, t.locationId, file.id, { by: 'admin-0001', now }),
      calendars.confirmBookings(t.scope, t.locationId, file.id, { by: 'admin-0002', now }),
    ]);
    expect(confirms.sort()).toEqual(['already', 'confirmed']);
    expect(await calendars.find(t.scope, t.locationId, file.id)).toMatchObject({ bookings: { state: 'confirmed', confirmedAt: now, sortedAt: now } });
    const booked = await calendars.bookingsBetween(t.scope, t.locationId, DECEMBER);
    expect(booked).toEqual([
      { startDate: '2026-12-05', endDate: '2026-12-05', booking: 'party' },
      { startDate: '2026-12-06', endDate: '2026-12-07', booking: 'buyout' },
    ]);
    expect(JSON.stringify(booked)).not.toContain('Sentinel');
    expect(await calendars.bookingsBetween(t.scope, t.locationId, { from: '2026-12-07', to: '2026-12-07' })).toHaveLength(1);
    // Labeled events of a confirmed calendar are marked for the weekly call to leave out; an unlabeled one is not.
    expect((await calendars.keyedEventsBetween(t.scope, t.locationId, DECEMBER)).map((each) => [each.uid, each.labeled])).toEqual([
      ['party', true], ['buyout', true], ['own', true], ['other', true], ['none', false],
    ]);

    // A calendar confirmed with no sort (labeled by hand, or not at all) confirms too.
    const plain = await addFile(t, 'Plain', [event('p1', '2026-12-11')]);
    expect(await calendars.confirmBookings(t.scope, t.locationId, plain.id, { by: 'admin-0001', now })).toBe('confirmed');
    expect(await calendars.find(t.scope, t.locationId, plain.id)).toMatchObject({ bookings: { state: 'confirmed', sortedAt: null } });
  });

  it('refuses labels on a link, and reads nothing of another organization’s calendar', async () => {
    const t = await tenant();
    const other = await tenant();
    const now = server.clock.now();
    const link = await calendars.add(t.scope, t.locationId, { kind: 'link', label: 'Link', sealedAddress: SEALED, host: 'calendar.google.com' },
      parsed([event('l1', '2026-12-01')]), { createdBy: 'user-0001', now });
    if (link === 'calendar_limit') throw new Error('calendar_limit');
    expect(link.bookings).toBeNull();
    expect(await calendars.setLabels(t.scope, t.locationId, link.id, [{ uid: 'l1', booking: 'party' }], now)).toBeNull();
    expect(await calendars.setLabel(t.scope, t.locationId, link.id, 'l1', 'party', now)).toBeNull();
    expect(await calendars.confirmBookings(t.scope, t.locationId, link.id, { by: 'admin-0001', now })).toBeNull();
    expect(await calendars.labeledEvents(t.scope, t.locationId, link.id)).toBeNull();
    expect((await calendars.labelCounts(t.scope, t.locationId)).has(link.id)).toBe(false);

    const file = await addFile(t, 'Master', [event('f1', '2026-12-01')]);
    await calendars.setLabels(t.scope, t.locationId, file.id, [{ uid: 'f1', booking: 'party' }], now);
    await calendars.confirmBookings(t.scope, t.locationId, file.id, { by: 'admin-0001', now });
    const before = await snapshotOf(t.orgId);
    expect(await calendars.setLabels(other.scope, t.locationId, file.id, [{ uid: 'f1', booking: 'buyout' }], now)).toBeNull();
    expect(await calendars.setLabel(other.scope, t.locationId, file.id, 'f1', 'buyout', now)).toBeNull();
    expect(await calendars.confirmBookings(other.scope, t.locationId, file.id, { by: 'admin-0009', now })).toBeNull();
    expect(await calendars.labeledEvents(other.scope, t.locationId, file.id)).toBeNull();
    expect(await calendars.bookingsBetween(other.scope, t.locationId, DECEMBER)).toEqual([]);
    expect((await calendars.labelCounts(other.scope, t.locationId)).size).toBe(0);
    expect(await snapshotOf(t.orgId)).toBe(before);
    expect(await calendars.bookingsBetween(t.scope, t.locationId, DECEMBER)).toHaveLength(1);
  });
});
