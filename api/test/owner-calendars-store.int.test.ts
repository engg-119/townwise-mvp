// The owner's calendars store (src/stores/owner-calendars.ts, openspec change connect-owner-calendar, design decisions 1
// and 2): a link's address kept only sealed and never in a record, replace by generation (a reader never sees a mix,
// and a crash before the switch leaves rows the next replace or the removal deletes), 5 calendars per location against
// concurrent adds, 2,000 events per calendar, range reads, removal and tenant scoping. Every title here is made up.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { MAX_EVENTS, type IcsEvent } from '../src/calendar/ics.ts';
import {
  createOwnerCalendarStore, MAX_CALENDARS, REFRESH_INTERVAL_MS, type OwnerCalendarRecord, type OwnerCalendarStore, type ParsedCalendar,
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

function event(uid: string, startDate: string, opts: { title?: string; endDate?: string; startTime?: string; endTime?: string } = {}): IcsEvent {
  return {
    uid, title: opts.title ?? `Event ${uid}`, startDate, endDate: opts.endDate ?? startDate, startTime: opts.startTime ?? null,
    endTime: opts.endTime ?? null,
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
      lastManualRefreshAt: null, createdBy: 'user-0001', createdAt: now,
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
      '_id', 'endDate', 'endTime', 'generation', 'locationId', 'orgId', 'sourceId', 'startDate', 'startTime', 'title', 'uid',
    ]);
    expect(rows[0]).toMatchObject({ generation: 1, uid: 'a1', title: 'Rehearsal dinner', startDate: '2026-11-05', startTime: '18:00', endTime: '21:00' });
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
      startTime: null, endTime: null,
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
    let replaced: boolean | undefined;
    const writes = await writesDuring(server, async () => {
      replaced = await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([
        event('c', '2026-11-05', { title: 'New one' }), event('d', '2026-11-06', { title: 'New two' }), event('e', '2026-11-07', { title: 'New three' }),
      ], 1), later);
    });
    expect(replaced).toBe(true);
    expect(writes).toEqual(['findAndModify tw_calendar_sources', 'insert tw_calendar_events', 'update tw_calendar_sources', 'delete tw_calendar_events']);
    expect(await calendars.find(t.scope, t.locationId, added.id)).toMatchObject({
      eventCount: 3, skippedRepeating: 1, status: 'ok', lastSuccessAt: later, lastAttemptAt: later, consecutiveFailures: 0,
    });
    expect((await rowsOf(added.id)).map((row) => row.generation)).toEqual([2, 2, 2]);
    expect(await titlesIn(t)).toEqual(['New one', 'New two', 'New three']);

    // A calendar whose events all went is emptied.
    expect(await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([]), later)).toBe(true);
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

    expect(await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('f', '2026-11-08', { title: 'Newest' })]), server.clock.now())).toBe(true);
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
      expect(await first).toBe(true);
      hold.release(2);
      expect(await second).toBe(false);
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
      expect(await older).toBe(true);
      expect((await rowsOf(added.id)).map((row) => row.generation)).toEqual([2, 3, 3]);
      hold.release(2);
      expect(await newer).toBe(true);
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
    expect(await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('b', '2026-11-04', { title: 'New one' })]), server.clock.now())).toBe(true);
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
      expect(await calendars.replaceEvents(t.scope, t.locationId, added.id, parsed([event('late', '2026-11-05', { title: 'Late fetch' })]), server.clock.now())).toBe(true);
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
      expect(await calendars.replaceEvents(a.scope, locationId, calendarId, parsed([event('x', '2026-11-05')]), server.clock.now())).toBe(false);
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
