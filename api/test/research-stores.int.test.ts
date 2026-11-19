// D66's research stores (openspec change town-research-agent, design decisions 2, 6, 7, 9 and 11): one live run per
// subject under the unique partial index and its release when the run ends, unique run and thread keys, the thread and
// run moves as compare-and-sets (claim, heartbeat, finish, requeue, stale reclaim, the merge claimed once), tenancy (an
// organization reads nothing of another's), the town month and its per-town slice, the TownwiseAI month's research part
// with the automatic share and headroom, append-only revisions, and the organization's research switch. Fixtures are
// made-up places and organizations.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import { deletePersonRecords } from '../src/stores/cross-tenant.ts';
import type { EventInsertBase, StoredFound, ThreadEnd } from '../src/stores/research-shared.ts';
import type { TownwiseStores } from '../src/stores/index.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const MINUTE = 60_000;
const USD = 1_000_000;
const NOW = new Date('2026-11-16T12:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);

let server: TownwiseTestServer;
let stores: TownwiseStores;

beforeAll(async () => {
  server = await startTownwiseServer();
  ({ stores } = server.ctx);
});
afterAll(async () => { await server.close(); });

interface Tenant { orgId: string; locationId: string; scope: OrgScope }

async function tenant(): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Research Cafe ${randomUUID().slice(0, 6)}` });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, locationId, scope: scopeForNewOrg(STAFF, orgId) };
}

/** A town key no other test uses, typed as a TownId (the store takes any of the twelve). */
const TOWNS = ['hanover-nh', 'amherst-ma', 'ithaca-ny', 'burlington-vt', 'middlebury-vt', 'stowe-vt'] as const;
let townIndex = 0;
async function freshTown() {
  const townKey = TOWNS[townIndex % TOWNS.length] ?? 'hanover-nh';
  townIndex += 1;
  await server.connection.collection('tw_town_research_runs').deleteMany({ townKey });
  return townKey;
}

function eventInput(runId: string, over: Partial<EventInsertBase> = {}): EventInsertBase {
  return {
    title: 'Riverbank Trivia Night', titleKey: 'riverbank trivia night', kind: 'event', category: 'dining', start: '2026-12-03',
    end: '2026-12-03', weekdays: null, startTime: '19:00', status: 'scheduled', venueId: null, hostId: null, confidence: 'medium',
    sources: [{ label: 'example.test', url: 'https://example.test/trivia' }], firstRunId: runId, lastRunId: runId,
    firstSeenAt: NOW, lastSeenAt: NOW, seenCount: 1, ...over,
  };
}

const FOUND: StoredFound = {
  events: [{
    title: 'Riverbank Trivia Night', kind: 'event', category: 'dining', start: '2026-12-03', end: '2026-12-03', weekdays: null,
    startTime: '19:00', status: 'scheduled', venueRef: 'v1', hostRef: null, competitor: null,
    sources: [{ label: 'example.test', url: 'https://example.test/trivia' }], grounded: true, codeConfidence: 'medium', confidence: 'medium',
  }],
  entities: [{ ref: 'v1', type: 'venue', name: 'Riverbank Hall', sources: [{ label: 'example.test', url: 'https://example.test/trivia' }] }],
};

function recorded(over: Partial<ThreadEnd> = {}): ThreadEnd {
  return {
    status: 'recorded', code: null, found: FOUND, spentMicroUsd: 120_000, searches: 3, fetches: 0, now: later(5),
    drops: {
      events: { bad_shape: 0, over_cap: 0, no_source: 1, unknown_source: 0, bad_dates: 0, bad_title: 0, bad_competitor: 0 },
      entities: { bad_shape: 0, over_cap: 0, bad_ref: 0, bad_name: 0, no_source: 0 },
    },
    ...over,
  };
}

describe('town runs', () => {
  it('holds one live run per town: a second insert answers null until the run ends, and a key once used stays used', async () => {
    const townKey = await freshTown();
    const run = await stores.researchTowns.insertRun({ townKey, key: 'w:2026-11-16', threads: ['schools', 'sports'], now: NOW });
    expect(run).toMatchObject({ townKey, key: 'w:2026-11-16', status: 'queued', threads: ['schools', 'sports'], startedAt: null });
    if (run === null) throw new Error('not inserted');
    expect(await stores.researchTowns.insertRun({ townKey, key: 'w:2026-11-23', threads: ['schools'], now: NOW })).toBeNull();
    expect((await stores.researchTowns.liveRun(townKey))?.id).toBe(run.id);
    // Another town is free.
    const other = await freshTown();
    expect(await stores.researchTowns.insertRun({ townKey: other, key: 'w:2026-11-16', threads: ['civic'], now: NOW })).not.toBeNull();

    expect(await stores.researchTowns.markRunRunning(run.id, later(1))).toBe(true);
    expect(await stores.researchTowns.markRunRunning(run.id, later(1))).toBe(false);
    const end = { status: 'done', code: null, counts: { found: 4, added: 3, updated: 1, dropped: 0 }, costMicroUsd: 900_000, now: later(9) } as const;
    expect(await stores.researchTowns.finishRun(run.id, end)).toBe(true);
    expect(await stores.researchTowns.finishRun(run.id, end)).toBe(false);
    expect(await stores.researchTowns.liveRun(townKey)).toBeNull();
    const raw = await server.connection.collection('tw_town_research_runs').findOne({ _id: new Types.ObjectId(run.id) });
    expect(raw).not.toHaveProperty('liveSubject');
    expect(await stores.researchTowns.findRun(run.id)).toMatchObject({ status: 'done', counts: end.counts, finishedAt: end.now });

    expect(await stores.researchTowns.insertRun({ townKey, key: 'w:2026-11-16', threads: ['schools'], now: later(10) })).toBeNull();
    const next = await stores.researchTowns.insertRun({ townKey, key: 'w:2026-11-23', threads: ['schools'], now: later(10) });
    expect(next).not.toBeNull();
    expect((await stores.researchTowns.lastRun(townKey))?.id).toBe(next?.id);
  });

  it('inserts a run’s missing thread rows once, claims each queued thread due by now for one owner, and moves it only for that owner', async () => {
    await server.connection.collection('tw_town_research_threads').deleteMany({});
    const townKey = await freshTown();
    const run = await stores.researchTowns.insertRun({ townKey, key: 'w:2026-11-16', threads: ['schools', 'sports'], now: NOW });
    if (run === null) throw new Error('not inserted');
    const plan = [{ thread: 'schools', notBefore: NOW }, { thread: 'sports', notBefore: later(60) }] as const;
    expect(await stores.researchTowns.insertThreads(run, plan, NOW)).toBe(2);
    expect(await stores.researchTowns.insertThreads(run, plan, NOW)).toBe(0);

    // Two lanes at once: one gets the due thread, the other nothing (sports is not due yet).
    const claims = await Promise.all(['lane-a', 'lane-b'].map((owner) => stores.researchTowns.claimThread({ owner, now: NOW, leaseMs: 90_000 })));
    const won = claims.filter((claim) => claim !== null);
    expect(won).toHaveLength(1);
    const thread = won[0];
    if (thread === undefined) throw new Error('not claimed');
    expect(thread).toMatchObject({ thread: 'schools', status: 'running', attempts: 1 });
    const owner = thread.owner ?? '';
    const other = owner === 'lane-a' ? 'lane-b' : 'lane-a';

    expect(await stores.researchTowns.reserveThread(thread.id, other, { reservedMicroUsd: 5 * USD, month: '2026-11' })).toBe(false);
    expect(await stores.researchTowns.reserveThread(thread.id, owner, { reservedMicroUsd: 5 * USD, month: '2026-11' })).toBe(true);
    const tally = { spentMicroUsd: 40_000, searches: 1, fetches: 0, now: later(1), leaseMs: 90_000 };
    expect(await stores.researchTowns.heartbeat(thread.id, other, tally)).toBe(false);
    expect(await stores.researchTowns.heartbeat(thread.id, owner, tally)).toBe(true);
    expect(await stores.researchTowns.finishThread(thread.id, other, recorded())).toBe(false);
    expect(await stores.researchTowns.finishThread(thread.id, owner, recorded())).toBe(true);
    // Once ended, a heartbeat misses (the lane aborts) and nothing finishes it again.
    expect(await stores.researchTowns.heartbeat(thread.id, owner, tally)).toBe(false);
    expect(await stores.researchTowns.finishThread(thread.id, owner, recorded())).toBe(false);
    const [schools] = await stores.researchTowns.threadsOf(run.id);
    expect(schools).toMatchObject({
      status: 'recorded', owner: null, reservedMicroUsd: 5 * USD, month: '2026-11', spentMicroUsd: 120_000, searches: 3, found: FOUND,
    });
    expect(schools?.drops?.events.no_source).toBe(1);

    // The later thread, once due: a retry puts it back with the attempt counted, and the next claim counts another.
    const sports = await stores.researchTowns.claimThread({ owner: 'lane-a', now: later(60), leaseMs: 90_000 });
    expect(sports).toMatchObject({ thread: 'sports', attempts: 1 });
    if (sports === null) throw new Error('not claimed');
    expect(await stores.researchTowns.requeueThread(sports.id, 'lane-a', { spentMicroUsd: 10_000, searches: 1, fetches: 0, notBefore: later(70), code: 'timeout' })).toBe(true);
    expect(await stores.researchTowns.claimThread({ owner: 'lane-a', now: later(65), leaseMs: 90_000 })).toBeNull();
    expect(await stores.researchTowns.claimThread({ owner: 'lane-b', now: later(70), leaseMs: 90_000 })).toMatchObject({ thread: 'sports', attempts: 2, spentMicroUsd: 10_000 });
  });

  it('takes back a thread only once its lease passed, answering its last written tally; and claims a run’s merge once, after every thread ended', async () => {
    await server.connection.collection('tw_town_research_threads').deleteMany({});
    const townKey = await freshTown();
    const run = await stores.researchTowns.insertRun({ townKey, key: 'w:2026-11-16', threads: ['civic', 'sports'], now: NOW });
    if (run === null) throw new Error('not inserted');
    await stores.researchTowns.insertThreads(run, [{ thread: 'civic', notBefore: NOW }, { thread: 'sports', notBefore: NOW }], NOW);
    await stores.researchTowns.markRunRunning(run.id, NOW);
    const first = await stores.researchTowns.claimThread({ owner: 'dead', now: NOW, leaseMs: 90_000 });
    const second = await stores.researchTowns.claimThread({ owner: 'lane', now: NOW, leaseMs: 90_000 });
    if (first === null || second === null) throw new Error('not claimed');
    await stores.researchTowns.heartbeat(first.id, 'dead', { spentMicroUsd: 77_000, searches: 2, fetches: 0, now: NOW, leaseMs: 90_000 });

    expect(await stores.researchTowns.staleThreads(later(1))).toEqual([]);
    expect(await stores.researchTowns.reclaimThread(first.id, { now: later(1), next: { status: 'queued', notBefore: later(11) } })).toBeNull();
    expect(await stores.researchTowns.staleThreads(later(2))).toEqual(expect.arrayContaining([first.id]));
    const taken = await stores.researchTowns.reclaimThread(first.id, { now: later(2), next: { status: 'failed', code: 'internal' } });
    expect(taken).toMatchObject({ status: 'running', owner: 'dead', spentMicroUsd: 77_000 });
    expect(await stores.researchTowns.reclaimThread(first.id, { now: later(2), next: { status: 'failed', code: 'internal' } })).toBeNull();
    // The dead lane's late heartbeat misses.
    expect(await stores.researchTowns.heartbeat(first.id, 'dead', { spentMicroUsd: 1, searches: 0, fetches: 0, now: later(2), leaseMs: 1 })).toBe(false);

    // One thread still running: no merge yet.
    expect(await stores.researchTowns.claimMerge({ runId: run.id, owner: 'lane', now: later(3), leaseMs: 90_000 })).toBe(false);
    await stores.researchTowns.finishThread(second.id, 'lane', recorded());
    const claims = await Promise.all(['lane', 'sweep'].map((owner) => stores.researchTowns.claimMerge({ runId: run.id, owner, now: later(4), leaseMs: 90_000 })));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await stores.researchTowns.findRun(run.id))?.status).toBe('merging');
    // A merge whose lease passed is taken over; one still leased is not.
    expect(await stores.researchTowns.claimMerge({ runId: run.id, owner: 'sweep-2', now: later(5), leaseMs: 90_000 })).toBe(false);
    expect(await stores.researchTowns.claimMerge({ runId: run.id, owner: 'sweep-2', now: later(6), leaseMs: 90_000 })).toBe(true);

    await stores.researchTowns.clearFound(run.id);
    expect((await stores.researchTowns.threadsOf(run.id)).map((thread) => thread.found)).toEqual([null, null]);
    expect((await stores.researchTowns.threadsOf(run.id)).find((thread) => thread.status === 'recorded')?.drops?.events.no_source).toBe(1);
  });

  it('claims no merge of a run while a thread it planned has no row yet (a plan that crashed between its thread rows)', async () => {
    await server.connection.collection('tw_town_research_threads').deleteMany({});
    const townKey = await freshTown();
    const run = await stores.researchTowns.insertRun({ townKey, key: 'w:2026-11-16', threads: ['civic', 'sports'], now: NOW });
    if (run === null) throw new Error('not inserted');
    await stores.researchTowns.insertThreads(run, [{ thread: 'civic', notBefore: NOW }], NOW);
    await stores.researchTowns.markRunRunning(run.id, NOW);
    const civic = await stores.researchTowns.claimThread({ owner: 'lane', now: NOW, leaseMs: 90_000 });
    if (civic?.runId !== run.id) throw new Error('not claimed');
    await stores.researchTowns.finishThread(civic.id, 'lane', recorded());
    expect(await stores.researchTowns.claimMerge({ runId: run.id, owner: 'lane', now: later(1), leaseMs: 90_000 })).toBe(false);
    // The planner's next tick completes the row; once it ends too, the run merges.
    await stores.researchTowns.insertThreads(run, [{ thread: 'sports', notBefore: NOW }], NOW);
    const sports = await stores.researchTowns.claimThread({ owner: 'lane', now: later(1), leaseMs: 90_000 });
    if (sports?.runId !== run.id) throw new Error('not claimed');
    await stores.researchTowns.finishThread(sports.id, 'lane', recorded());
    expect(await stores.researchTowns.claimMerge({ runId: run.id, owner: 'lane', now: later(2), leaseMs: 90_000 })).toBe(true);
  });

  it('stores events and entities by town, updates a row without touching its title, dates or suppression, and upserts an entity by name key', async () => {
    const townKey = await freshTown();
    await server.connection.collection('tw_town_events').deleteMany({ townKey });
    await server.connection.collection('tw_town_entities').deleteMany({ townKey });
    const runId = new Types.ObjectId().toHexString();
    const event = await stores.researchTowns.insertEvent(townKey, eventInput(runId));
    expect(event).toMatchObject({ townKey, title: 'Riverbank Trivia Night', suppressed: null, seenCount: 1 });
    await server.connection.collection('tw_town_events').updateOne({ _id: new Types.ObjectId(event.id) }, { $set: { suppressed: { at: NOW, code: 'wrong' } } });
    const nextRun = new Types.ObjectId().toHexString();
    expect(await stores.researchTowns.updateEvent(townKey, event.id, {
      lastRunId: nextRun, lastSeenAt: later(1), seenCount: 2, confidence: 'high', status: 'cancelled',
      sources: [{ label: 'a.example.test', url: 'https://a.example.test/' }, { label: 'b.example.test', url: 'https://b.example.test/' }],
    })).toBe(true);
    expect(await stores.researchTowns.updateEvent('nantucket-ma', event.id, {
      lastRunId: nextRun, lastSeenAt: later(1), seenCount: 9, confidence: 'low', status: 'scheduled', sources: [],
    })).toBe(false);
    expect(await stores.researchTowns.events(townKey)).toEqual([expect.objectContaining({
      title: 'Riverbank Trivia Night', start: '2026-12-03', end: '2026-12-03', status: 'cancelled', confidence: 'high', seenCount: 2,
      lastRunId: nextRun, firstRunId: runId, suppressed: { at: NOW, code: 'wrong' },
    })]);

    const sources = [{ label: 'example.test', url: 'https://example.test/hall' }];
    const id = await stores.researchTowns.upsertEntity(townKey, { type: 'venue', name: 'Riverbank Hall', nameKey: 'riverbank hall', sources, now: NOW });
    expect(await stores.researchTowns.upsertEntity(townKey, { type: 'venue', name: 'The Riverbank Hall', nameKey: 'riverbank hall', sources, now: later(1) })).toBe(id);
    expect(await stores.researchTowns.upsertEntity(townKey, { type: 'organization', name: 'Riverbank Hall', nameKey: 'riverbank hall', sources, now: NOW })).not.toBe(id);
    expect((await stores.researchTowns.entities(townKey)).map((entity) => [entity.type, entity.name])).toEqual([
      ['venue', 'The Riverbank Hall'], ['organization', 'Riverbank Hall'],
    ]);
  });
});

describe('location runs', () => {
  it('holds one live run per location, never another location’s or organization’s, and frees it when the run ends', async () => {
    const a = await tenant();
    const input = { locationId: a.locationId, key: 'w:2026-11-16', trigger: 'weekly', placeId: 'place-a', town: 'hanover-nh', threads: ['neighborhood', 'competitors'], now: NOW } as const;
    const run = await stores.researchLocations.insertRun(a.scope, input);
    expect(run).toMatchObject({ locationId: a.locationId, trigger: 'weekly', placeId: 'place-a', town: 'hanover-nh', status: 'queued' });
    if (run === null) throw new Error('not inserted');
    expect(await stores.researchLocations.insertRun(a.scope, { ...input, key: 's:early', trigger: 'early' })).toBeNull();
    const patio = await addLocation(server, { orgId: a.orgId, name: 'Patio' });
    expect(await stores.researchLocations.insertRun(a.scope, { ...input, locationId: patio })).not.toBeNull();

    expect(await stores.researchLocations.finishRun(a.scope, run.id, { status: 'off', code: 'place_changed', counts: { found: 0, added: 0, updated: 0, dropped: 0 }, costMicroUsd: 0, now: later(1) })).toBe(true);
    expect(await stores.researchLocations.liveRun(a.scope, a.locationId)).toBeNull();
    expect(await stores.researchLocations.findRun(a.scope, run.id)).toMatchObject({ status: 'off', code: 'place_changed' });
    expect(await stores.researchLocations.insertRun(a.scope, input)).toBeNull();
    const press = await stores.researchLocations.insertRun(a.scope, { ...input, key: 'p:press', trigger: 'press' });
    expect(press).toMatchObject({ trigger: 'press' });
    expect((await stores.researchLocations.lastRun(a.scope, a.locationId))?.id).toBe(press?.id);
    // No person is recorded on a run.
    const raw = await server.connection.collection('tw_location_research_runs').findOne({ _id: new Types.ObjectId(press?.id) });
    expect(Object.keys(raw ?? {}).sort()).toEqual([
      '_id', 'code', 'costMicroUsd', 'counts', 'createdAt', 'finishedAt', 'key', 'liveSubject', 'locationId', 'mergeOwner', 'mergeUntil',
      'orgId', 'placeId', 'startedAt', 'status', 'threads', 'town', 'trigger',
    ]);
  });

  it('another organization reads nothing and moves nothing of a location’s research', async () => {
    const a = await tenant();
    const b = await tenant();
    const run = await stores.researchLocations.insertRun(a.scope, {
      locationId: a.locationId, key: 'w:2026-11-16', trigger: 'weekly', placeId: null, town: 'hanover-nh', threads: ['neighborhood'], now: NOW,
    });
    if (run === null) throw new Error('not inserted');
    await stores.researchLocations.insertThreads(a.scope, run, [{ thread: 'neighborhood', notBefore: NOW }], NOW);
    const event = await stores.researchLocations.insertEvent(a.scope, a.locationId, {
      ...eventInput(run.id), placeId: null, town: 'hanover-nh', origin: 'neighborhood', competitorEntityId: null, competitorPlaceId: null,
    });
    await stores.researchLocations.upsertEntity(a.scope, a.locationId, {
      type: 'venue', name: 'Riverbank Hall', nameKey: 'riverbank hall', placeId: null, town: 'hanover-nh', townEntityId: null, sources: [], now: NOW,
    });
    await stores.researchRevisions.append(a.scope, {
      locationId: a.locationId, eventId: `l-${event.id}`, op: 'hide', fields: null, reverts: null, basedOn: 'base', by: { kind: 'person', userId: 'member-a' }, now: NOW,
    });

    // B asks with A's ids: nothing.
    expect(await stores.researchLocations.findRun(b.scope, run.id)).toBeNull();
    expect(await stores.researchLocations.liveRun(b.scope, a.locationId)).toBeNull();
    expect(await stores.researchLocations.lastRun(b.scope, a.locationId)).toBeNull();
    expect(await stores.researchLocations.threadsOf(b.scope, run.id)).toEqual([]);
    expect(await stores.researchLocations.events(b.scope, a.locationId)).toEqual([]);
    expect(await stores.researchLocations.entities(b.scope, a.locationId)).toEqual([]);
    expect(await stores.researchRevisions.list(b.scope, a.locationId)).toEqual([]);
    expect(await stores.researchRevisions.count(b.scope, a.locationId)).toBe(0);
    expect(await stores.researchLocations.markRunRunning(b.scope, run.id, NOW)).toBe(false);
    expect(await stores.researchLocations.finishRun(b.scope, run.id, { status: 'failed', code: null, counts: { found: 0, added: 0, updated: 0, dropped: 0 }, costMicroUsd: 0, now: NOW })).toBe(false);
    expect(await stores.researchLocations.updateEvent(b.scope, a.locationId, event.id, {
      lastRunId: run.id, lastSeenAt: NOW, seenCount: 5, sources: [], confidence: 'low', status: 'cancelled',
    })).toBe(false);
    expect(await stores.researchLocations.removeForLocation(b.scope, a.locationId)).toBe(0);
    expect(await stores.researchRevisions.removeForOrg(b.scope)).toBe(0);
    // A still has every row.
    expect(await stores.researchLocations.liveRun(a.scope, a.locationId)).toMatchObject({ id: run.id, status: 'queued' });
    expect(await stores.researchLocations.events(a.scope, a.locationId)).toEqual([expect.objectContaining({ id: event.id, status: 'scheduled', origin: 'neighborhood' })]);
    expect(await stores.researchRevisions.count(a.scope, a.locationId)).toBe(1);
  });

  it('moves a location thread by compare-and-set under the organization’s scope only', async () => {
    const a = await tenant();
    const b = await tenant();
    const run = await stores.researchLocations.insertRun(a.scope, {
      locationId: a.locationId, key: 'w:2026-11-16', trigger: 'weekly', placeId: null, town: 'hanover-nh', threads: ['neighborhood', 'competitors'], now: NOW,
    });
    if (run === null) throw new Error('not inserted');
    const plan = [{ thread: 'neighborhood', notBefore: NOW }, { thread: 'competitors', notBefore: NOW }] as const;
    expect(await stores.researchLocations.insertThreads(a.scope, run, plan, NOW)).toBe(2);
    expect(await stores.researchLocations.insertThreads(a.scope, run, plan, NOW)).toBe(0);
    // The claim is cross-tenant (task 3.2); here a thread is put in a lane's hands directly.
    const [first] = await stores.researchLocations.threadsOf(a.scope, run.id);
    if (first === undefined) throw new Error('no thread');
    await server.connection.collection('tw_location_research_threads').updateOne(
      { _id: new Types.ObjectId(first.id) }, { $set: { status: 'running', owner: 'lane', leaseUntil: later(1), attempts: 1 } },
    );
    const tally = { spentMicroUsd: 5_000, searches: 1, fetches: 0, now: NOW, leaseMs: 90_000 };
    expect(await stores.researchLocations.heartbeat(b.scope, first.id, 'lane', tally)).toBe(false);
    expect(await stores.researchLocations.heartbeat(a.scope, first.id, 'lane', tally)).toBe(true);
    expect(await stores.researchLocations.finishThread(b.scope, first.id, 'lane', recorded())).toBe(false);
    expect(await stores.researchLocations.finishThread(a.scope, first.id, 'lane', recorded({ status: 'empty', code: 'no_place', found: null, drops: null }))).toBe(true);
    expect((await stores.researchLocations.threadsOf(a.scope, run.id)).map((thread) => [thread.thread, thread.status, thread.code])).toEqual([
      ['neighborhood', 'empty', 'no_place'], ['competitors', 'queued', null],
    ]);
  });
});

describe('town spend', () => {
  it('reserves against the month’s cap and the town’s slice, refusing past either and giving the month back when the slice refuses', async () => {
    const month = `2099-${randomUUID().slice(0, 6)}`;
    const reserve = (townKey: 'hanover-nh' | 'amherst-ma', cost: number) => stores.researchSpend.reserve({
      month, townKey, costMicroUsd: cost * USD, capMicroUsd: 40 * USD, sliceMicroUsd: 20 * USD,
    });
    expect(await reserve('hanover-nh', 6)).toBe(true);
    expect(await reserve('hanover-nh', 6)).toBe(true);
    expect(await reserve('hanover-nh', 6)).toBe(true);
    // A fourth would pass Hanover's $20 slice: refused, and the month is as it was.
    expect(await reserve('hanover-nh', 6)).toBe(false);
    expect(await stores.researchSpend.spent(month, 'hanover-nh')).toEqual({ month: 18 * USD, town: 18 * USD });
    // Amherst has its own slice; together they meet the $40 month.
    expect(await reserve('amherst-ma', 20)).toBe(true);
    expect(await reserve('amherst-ma', 1)).toBe(false);
    expect(await reserve('hanover-nh', 2)).toBe(true);
    expect(await reserve('hanover-nh', 1)).toBe(false);
    // A thread settles to what it cost, which frees room.
    await stores.researchSpend.add({ month, townKey: 'hanover-nh', costMicroUsd: -4 * USD });
    expect(await stores.researchSpend.spent(month, 'hanover-nh')).toEqual({ month: 36 * USD, town: 16 * USD });
    expect(await reserve('hanover-nh', 4)).toBe(true);
    expect(await stores.researchSpend.spent(month, 'amherst-ma')).toEqual({ month: 40 * USD, town: 20 * USD });
  });

  it('two reservations racing the last room of a slice: only one fits', async () => {
    const month = `2098-${randomUUID().slice(0, 6)}`;
    const results = await Promise.all([1, 2, 3].map(() => stores.researchSpend.reserve({
      month, townKey: 'conway-nh', costMicroUsd: 4 * USD, capMicroUsd: 40 * USD, sliceMicroUsd: 5 * USD,
    })));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await stores.researchSpend.spent(month, 'conway-nh')).toEqual({ month: 4 * USD, town: 4 * USD });
  });
});

describe('the TownwiseAI month’s research part', () => {
  const automatic = { shareMicroUsd: 6 * USD, headroomMicroUsd: 5 * USD };

  it('holds automatic research to the $6 share and $5 of headroom, while Research now may use the rest of the month', async () => {
    const t = await tenant();
    const month = '2026-11';
    const reserve = (cost: number, auto: boolean) => stores.chatUsage.reserveResearch(
      t.scope, month, cost * USD, { budgetMicroUsd: 20 * USD, automatic: auto ? automatic : null }, NOW,
    );
    expect(await reserve(3.5, true)).toBe(true);
    expect(await reserve(2.5, true)).toBe(true);
    // The share is spent: an automatic thread is refused, nothing added.
    expect(await reserve(0.5, true)).toBe(false);
    expect(await stores.chatUsage.researchMicroUsd(t.scope, month)).toBe(6 * USD);
    expect(await stores.chatUsage.costMicroUsd(t.scope, month)).toBe(6 * USD);
    // Research now is not bound by the share.
    expect(await reserve(4, false)).toBe(true);
    expect(await stores.chatUsage.researchMicroUsd(t.scope, month)).toBe(10 * USD);
    // A settle gives back what a thread did not spend, from both.
    await stores.chatUsage.addResearch(t.scope, month, -5 * USD, NOW);
    expect(await stores.chatUsage.researchMicroUsd(t.scope, month)).toBe(5 * USD);
    expect(await stores.chatUsage.costMicroUsd(t.scope, month)).toBe(5 * USD);
    // Chat spends the month too; an automatic thread must leave $5 of the $20, with room in its share or not.
    await stores.chatUsage.add(t.scope, month, 9.5 * USD, NOW);
    expect(await reserve(1, true)).toBe(false);
    expect(await reserve(0.5, true)).toBe(true);
    expect(await stores.chatUsage.costMicroUsd(t.scope, month)).toBe(15 * USD);
    // Research now stops only at the budget.
    expect(await reserve(5.5, false)).toBe(false);
    expect(await reserve(5, false)).toBe(true);
    expect(await stores.chatUsage.costMicroUsd(t.scope, month)).toBe(20 * USD);
  });

  it('never recreates a deleted month on a settle (a late lane of a deleted organization)', async () => {
    const t = await tenant();
    const month = '2026-11';
    expect(await stores.chatUsage.reserveResearch(t.scope, month, 2 * USD, { budgetMicroUsd: 20 * USD, automatic: null }, NOW)).toBe(true);
    await stores.chatUsage.removeForOrg(t.scope);
    await stores.chatUsage.addResearch(t.scope, month, -2 * USD, NOW);
    await stores.chatUsage.addResearch(t.scope, month, 1 * USD, NOW);
    expect(await server.connection.collection('tw_chat_usage').countDocuments({ orgId: new Types.ObjectId(t.scope.orgId) })).toBe(0);
  });

  it('reads a month chat began before research as no research yet, and refuses a first reservation past the share', async () => {
    const t = await tenant();
    const month = '2026-10';
    await stores.chatUsage.add(t.scope, month, 2 * USD, NOW);
    expect(await stores.chatUsage.researchMicroUsd(t.scope, month)).toBe(0);
    expect(await stores.chatUsage.reserveResearch(t.scope, month, 7 * USD, { budgetMicroUsd: 20 * USD, automatic }, NOW)).toBe(false);
    expect(await stores.chatUsage.reserveResearch(t.scope, month, 6 * USD, { budgetMicroUsd: 20 * USD, automatic }, NOW)).toBe(true);
    expect(await stores.chatUsage.costMicroUsd(t.scope, month)).toBe(8 * USD);
    const fresh = await tenant();
    expect(await stores.chatUsage.reserveResearch(fresh.scope, month, 7 * USD, { budgetMicroUsd: 20 * USD, automatic }, NOW)).toBe(false);
    expect(await stores.chatUsage.costMicroUsd(fresh.scope, month)).toBe(0);
  });
});

describe('revisions', () => {
  it('appends one child per revision, keeps who made it, and takes a planned id', async () => {
    const t = await tenant();
    const eventId = `l-${new Types.ObjectId().toHexString()}`;
    const base = { locationId: t.locationId, eventId, reverts: null, now: NOW } as const;
    const edit = await stores.researchRevisions.append(t.scope, {
      ...base, op: 'edit', fields: { title: 'Trivia at the Hall', weekdays: null, where: 'Riverbank Hall' }, basedOn: 'base', by: { kind: 'person', userId: 'member-1' },
    });
    expect(edit).toMatchObject({ op: 'edit', basedOn: 'base', fields: { title: 'Trivia at the Hall', weekdays: null, where: 'Riverbank Hall' }, by: { kind: 'person', userId: 'member-1' } });
    if (edit === null) throw new Error('not appended');
    // A second child of `base` loses on the index.
    expect(await stores.researchRevisions.append(t.scope, { ...base, op: 'hide', fields: null, basedOn: 'base', by: { kind: 'person', userId: 'member-2' } })).toBeNull();
    const planned = new Types.ObjectId().toHexString();
    const conversationId = new Types.ObjectId().toHexString();
    const changeId = new Types.ObjectId().toHexString();
    const correction = await stores.researchRevisions.append(t.scope, {
      ...base, id: planned, op: 'edit', fields: { start: '2026-12-10', end: '2026-12-10' }, basedOn: edit.id, by: { kind: 'chat', conversationId, changeId },
    });
    expect(correction).toMatchObject({ id: planned, basedOn: edit.id, by: { kind: 'chat', conversationId, changeId } });
    const revert = await stores.researchRevisions.append(t.scope, { ...base, op: 'revert', fields: null, reverts: planned, basedOn: planned, by: { kind: 'person', userId: null } });
    expect(revert).toMatchObject({ op: 'revert', reverts: planned });
    // The same id again is a duplicate too (a retried apply finds its own row).
    expect(await stores.researchRevisions.append(t.scope, { ...base, id: planned, op: 'hide', fields: null, basedOn: 'other', by: { kind: 'person', userId: null } })).toBeNull();
    expect((await stores.researchRevisions.list(t.scope, t.locationId)).map((revision) => revision.op)).toEqual(['edit', 'edit', 'revert']);
    expect(await stores.researchRevisions.find(t.scope, t.locationId, planned)).toMatchObject({ fields: { start: '2026-12-10', end: '2026-12-10' } });
  });
});

describe('the organization’s research switch', () => {
  it('reads on before anyone switched it, records who did, and a deleted person’s id leaves it and their edits', async () => {
    const t = await tenant();
    expect((await stores.orgs.findById(t.orgId))?.research).toEqual({ on: true, at: null });
    expect(await stores.orgs.setResearch(t.scope, { on: false, at: NOW, by: 'admin-gone' })).toBe(true);
    expect((await stores.orgs.findById(t.orgId))?.research).toEqual({ on: false, at: NOW });
    await stores.researchRevisions.append(t.scope, {
      locationId: t.locationId, eventId: `t-${new Types.ObjectId().toHexString()}`, op: 'hide', fields: null, reverts: null, basedOn: 'base',
      by: { kind: 'person', userId: 'admin-gone' }, now: NOW,
    });
    await deletePersonRecords(server.connection, { userId: 'admin-gone', email: 'gone@example.test' });
    const org = await server.connection.collection('tw_orgs').findOne({ _id: new Types.ObjectId(t.orgId) });
    expect(org?.research).toEqual({ on: false, at: NOW, by: null });
    expect((await stores.researchRevisions.list(t.scope, t.locationId)).map((revision) => revision.by)).toEqual([{ kind: 'person', userId: null }]);
    expect(await server.connection.collection('tw_research_revisions').countDocuments({ 'by.userId': 'admin-gone' })).toBe(0);
  });
});
