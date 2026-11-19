// D66's research routes (openspec change town-research-agent, design decisions 13 and 15; spec 10.19). GET
// .../research: the switch and whether research runs here, the town's last run with no trigger or start, the location's
// with both, a thread waiting to retry shown as queued with its code, the next weekly run's day, the gaps, who and
// where, and the hidden events with their heads; and organization A's new location changes nothing in organization B's
// read but the shared town run. The research server runs no runner: rows are written as a run would leave them.
// Fixtures are made-up places and organizations.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import type { ThreadId } from '../src/research/threads.ts';
import type { EventInsertBase, ThreadEnd } from '../src/stores/research-shared.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { scriptedModel } from './helpers/chat-model.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;

let server: TownwiseTestServer;

beforeAll(async () => {
  server = await startTownwiseServer({ env: { TOWNWISE_CHAT_WEB_SEARCH: 'true' }, chat: scriptedModel() });
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  for (const name of ['tw_town_research_runs', 'tw_town_research_threads', 'tw_town_events', 'tw_town_entities']) {
    await server.connection.collection(name).deleteMany({});
  }
});

interface Tenant { orgId: string; scope: OrgScope; locationId: string; admin: TestSession }

async function tenant(): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Research Routes ${randomUUID().slice(0, 6)}` });
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, email);
  await addSeat(server, { orgId, userId: admin.userId, email, role: 'org_admin' });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, scope: scopeForNewOrg(STAFF, orgId), locationId, admin };
}

interface ResearchBody {
  on: boolean; available: boolean; next: string | null; gaps: string[];
  town: Record<string, unknown> | null; location: Record<string, unknown> | null;
  entities: { id: string; type: string; name: string; events: number }[];
  hidden: { id: string; title: string; start: string; end: string; head: string }[];
}

async function research(t: Tenant, locationId = t.locationId): Promise<ResearchBody> {
  const res = await call(server, `/api/org/locations/${locationId}/research`, { session: t.admin });
  expect(res.status).toBe(200);
  return await res.json() as ResearchBody;
}

const ended = (over: Partial<ThreadEnd> = {}): ThreadEnd => ({
  status: 'recorded', code: null, found: null, drops: null, spentMicroUsd: 1_000, searches: 1, fetches: 0, now: server.clock.now(), ...over,
});

/** A run of `threads`, its threads claimed and ended as given (a missing end leaves the thread queued). */
async function locationRun(t: Tenant, input: { key: string; trigger: 'weekly' | 'early' | 'press'; ends: Partial<Record<ThreadId, Partial<ThreadEnd> | 'retry'>>; finish?: 'done' | 'partial' | 'budget' }) {
  const store = server.ctx.stores.researchLocations;
  const now = server.clock.now();
  const threads: ThreadId[] = ['neighborhood', 'competitors'];
  const run = await store.insertRun(t.scope, { locationId: t.locationId, key: input.key, trigger: input.trigger, placeId: null, town: 'hanover-nh', threads, now });
  if (run === null) throw new Error('run refused');
  await store.insertThreads(t.scope, run, threads.map((thread) => ({ thread, notBefore: now })), now);
  await store.markRunRunning(t.scope, run.id, now);
  for (const row of await store.threadsOf(t.scope, run.id)) {
    const end = input.ends[row.thread];
    if (end === undefined) continue;
    await server.connection.collection('tw_location_research_threads').updateOne({ _id: new Types.ObjectId(row.id) }, { $set: { status: 'running', owner: 'lane' } });
    if (end === 'retry') {
      await store.requeueThread(t.scope, row.id, 'lane', { spentMicroUsd: 0, searches: 0, fetches: 0, notBefore: new Date(now.getTime() + 3_600_000), code: 'provider_overloaded' });
    } else {
      await store.finishThread(t.scope, row.id, 'lane', ended(end));
    }
  }
  if (input.finish !== undefined) {
    await store.finishRun(t.scope, run.id, { status: input.finish, code: null, counts: { found: 4, added: 3, updated: 1, dropped: 0 }, costMicroUsd: 2_000, now });
  }
  return run;
}

function eventRow(over: Partial<EventInsertBase> = {}): EventInsertBase {
  const runId = new Types.ObjectId().toHexString();
  const now = server.clock.now();
  return {
    title: 'Green Lantern Walk', titleKey: 'green lantern walk', kind: 'event', category: 'festival', start: '2026-06-20', end: '2026-06-20',
    weekdays: null, startTime: null, status: 'scheduled', venueId: null, hostId: null, confidence: 'medium',
    sources: [{ label: 'example.test', url: 'https://example.test/walk' }], firstRunId: runId, lastRunId: runId, firstSeenAt: now, lastSeenAt: now,
    seenCount: 1, ...over,
  };
}

describe('GET /api/org/locations/:locationId/research', () => {
  it('answers a location never researched: on, available, no runs, the next run today, and no place as its gap', async () => {
    const t = await tenant();
    expect(await research(t)).toEqual({
      on: true, available: true, town: null, location: null, next: '2026-06-01', gaps: ['no_place'], entities: [], hidden: [],
    });
  });

  it('shows the town’s run with no trigger or start, the location’s with both, and a thread waiting to retry as queued with its code', async () => {
    const t = await tenant();
    const towns = server.ctx.stores.researchTowns;
    const now = server.clock.now();
    const townRun = await towns.insertRun({ townKey: 'hanover-nh', key: 'w:2026-06-01', threads: ['schools', 'sports'], now });
    if (townRun === null) throw new Error('town run refused');
    await towns.insertThreads(townRun, [{ thread: 'schools', notBefore: now }, { thread: 'sports', notBefore: now }], now);
    await towns.markRunRunning(townRun.id, now);
    await locationRun(t, { key: 'w:2026-06-01', trigger: 'weekly', ends: { neighborhood: {}, competitors: 'retry' } });
    const body = await research(t);
    expect(body.town).toEqual({
      status: 'running', finishedAt: null, counts: { found: 0, added: 0, updated: 0, dropped: 0 },
      threads: [{ thread: 'schools', status: 'queued', code: null }, { thread: 'sports', status: 'queued', code: null }],
    });
    expect(body.location).toEqual({
      status: 'running', finishedAt: null, trigger: 'weekly', startedAt: now.toISOString(), counts: { found: 0, added: 0, updated: 0, dropped: 0 },
      threads: [{ thread: 'neighborhood', status: 'recorded', code: null }, { thread: 'competitors', status: 'queued', code: 'provider_overloaded' }],
    });
    // A live run: no next run to name.
    expect(body.next).toBeNull();
  });

  it('names the next weekly run: next Monday after this week’s run, six days after an early run', async () => {
    const t = await tenant();
    await locationRun(t, { key: 'w:2026-06-01', trigger: 'weekly', ends: { neighborhood: {}, competitors: {} }, finish: 'done' });
    expect(await research(t)).toMatchObject({ next: '2026-06-08', location: { status: 'done', counts: { found: 4, added: 3, updated: 1, dropped: 0 } } });
    const u = await tenant();
    await locationRun(u, { key: `s:${new Types.ObjectId().toHexString()}`, trigger: 'early', ends: { neighborhood: {}, competitors: {} }, finish: 'done' });
    expect((await research(u)).next).toBe('2026-06-07');
  });

  it('says why research is short: off, a town outside the twelve, the month’s budget, Google off for the restaurant', async () => {
    const t = await tenant();
    await locationRun(t, { key: 'w:2026-06-01', trigger: 'weekly', ends: { neighborhood: { status: 'empty', code: 'places_off' }, competitors: { status: 'budget', code: 'budget' } }, finish: 'partial' });
    expect((await research(t)).gaps).toEqual(['no_place', 'budget', 'places_off']);
    await server.ctx.stores.orgs.setResearch(t.scope, { on: false, at: server.clock.now(), by: t.admin.userId });
    expect(await research(t)).toMatchObject({ on: false, next: null, gaps: ['no_place', 'off', 'budget', 'places_off'] });
    const u = await tenant();
    await server.connection.collection('tw_locations').updateOne({ _id: new Types.ObjectId(u.locationId) }, { $set: { town: { townId: null, name: 'Smallville', state: 'KS' } } });
    expect(await research(u)).toMatchObject({ town: null, gaps: ['no_place', 'not_researched_town'] });
  });

  it('lists who and where by upcoming events, and the hidden events with the heads to restore from', async () => {
    const t = await tenant();
    const towns = server.ctx.stores.researchTowns;
    const now = server.clock.now();
    const hall = await towns.upsertEntity('hanover-nh', { type: 'venue', name: 'Riverside Hall', nameKey: 'riverside hall', sources: [], now });
    const club = await towns.upsertEntity('hanover-nh', { type: 'organization', name: 'Valley Arts Club', nameKey: 'valley arts club', sources: [], now });
    await towns.insertEvent('hanover-nh', eventRow({ venueId: hall, hostId: club }));
    await towns.insertEvent('hanover-nh', eventRow({ title: 'Riverside Quiz', titleKey: 'riverside quiz', start: '2026-06-25', end: '2026-06-25', venueId: hall }));
    const hiddenRow = await towns.insertEvent('hanover-nh', eventRow({ title: 'Craft Fair', titleKey: 'craft fair', start: '2026-07-04', end: '2026-07-04', venueId: club }));
    const hide = await server.ctx.stores.researchRevisions.append(t.scope, {
      locationId: t.locationId, eventId: `t-${hiddenRow.id}`, op: 'hide', fields: null, reverts: null, basedOn: 'base',
      by: { kind: 'person', userId: t.admin.userId }, now,
    });
    const body = await research(t);
    expect(body.entities).toEqual([
      { id: hall, type: 'venue', name: 'Riverside Hall', events: 2 },
      { id: club, type: 'organization', name: 'Valley Arts Club', events: 1 },
    ]);
    expect(body.hidden).toEqual([{ id: `t-${hiddenRow.id}`, title: 'Craft Fair', start: '2026-07-04', end: '2026-07-04', head: hide?.id }]);
  });

  it('organization A adding a location changes nothing in B’s read but the shared town run', async () => {
    const a = await tenant();
    const b = await tenant();
    const before = await research(b);
    const res = await call(server, '/api/org/locations', { session: a.admin, json: { name: 'Lantern Room', town: { townId: 'hanover-nh' } } });
    expect(res.status).toBe(201);
    const after = await research(b);
    expect(after.town).toMatchObject({ status: 'queued' });
    expect(Object.keys(after.town ?? {}).sort()).toEqual(['counts', 'finishedAt', 'status', 'threads']);
    expect({ ...after, town: null }).toEqual({ ...before, town: null });
  });

  it('answers 404 for another organization’s location', async () => {
    const a = await tenant();
    const b = await tenant();
    const res = await call(server, `/api/org/locations/${b.locationId}/research`, { session: a.admin });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/org researching (D66)', () => {
  async function researching(t: Tenant): Promise<unknown> {
    const res = await call(server, '/api/org', { session: t.admin });
    const body = await res.json() as { locations: { id: string; researching: unknown }[] };
    return body.locations.find((location) => location.id === t.locationId)?.researching;
  }

  it('says researching while the run runs, a thread waiting to retry included, and not while queued, done or switched off', async () => {
    const t = await tenant();
    expect(await researching(t)).toBeNull();
    const queued = await server.ctx.stores.researchLocations.insertRun(t.scope, {
      locationId: t.locationId, key: 'w:2026-06-01', trigger: 'weekly', placeId: null, town: 'hanover-nh', threads: ['neighborhood'], now: server.clock.now(),
    });
    expect(queued).not.toBeNull();
    expect(await researching(t)).toBeNull();
    await server.connection.collection('tw_location_research_runs').deleteMany({ orgId: new Types.ObjectId(t.orgId) });
    const run = await locationRun(t, { key: 'w:2026-06-01', trigger: 'weekly', ends: { neighborhood: {}, competitors: 'retry' } });
    expect(await researching(t)).toEqual({ stage: 'running', since: server.clock.now().toISOString() });
    await server.ctx.stores.orgs.setResearch(t.scope, { on: false, at: server.clock.now(), by: t.admin.userId });
    expect(await researching(t)).toBeNull();
    await server.ctx.stores.orgs.setResearch(t.scope, { on: true, at: server.clock.now(), by: t.admin.userId });
    await server.ctx.stores.researchLocations.finishRun(t.scope, run.id, { status: 'partial', code: null, counts: { found: 0, added: 0, updated: 0, dropped: 0 }, costMicroUsd: 0, now: server.clock.now() });
    expect(await researching(t)).toBeNull();
  });
});
