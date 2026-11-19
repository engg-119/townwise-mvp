// D66's planner (openspec change town-research-agent, design decision 2): two planners at once insert each run and
// thread once; the week's key is the Monday in the town's time zone and weekly threads are due over that Monday; a town
// outside the twelve gets no shared run and its location a combined town thread; a plan that crashed between a run and
// its threads is completed; an early run counts as the week's; the merge sweep claims a run whose last lane died; the
// caps at 0 plan nothing. Fixtures are made-up organizations.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import {
  mondayOf, planTick, queueEarlyRun, staggeredStart, startOfLocalDay, townStamp, weekKey, type ClaimedMerge, type PlanContext,
} from '../src/research/plan.ts';
import type { TownwiseStores } from '../src/stores/index.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const DAY = 86_400_000;
const EASTERN = 'America/New_York';
// Wednesday, 2026-11-18, 12:00 Eastern.
const WEDNESDAY = new Date('2026-11-18T17:00:00Z');

let server: TownwiseTestServer;
let stores: TownwiseStores;
let clock = WEDNESDAY;

beforeAll(async () => {
  server = await startTownwiseServer();
  ({ stores } = server.ctx);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  clock = WEDNESDAY;
  for (const name of ['tw_orgs', 'tw_locations', 'tw_location_research_runs', 'tw_location_research_threads', 'tw_town_research_runs', 'tw_town_research_threads']) {
    await server.connection.collection(name).deleteMany({});
  }
});

function context(over: Partial<PlanContext['config']> = {}): PlanContext {
  return {
    connection: server.connection, stores, logger: server.ctx.logger, now: () => clock,
    config: { researchTownMonthlyUsd: 40, researchOrgMonthlyUsd: 6, ...over },
  };
}

interface Tenant { orgId: string; locationId: string; scope: OrgScope }

async function tenant(opts: { researchOn?: boolean } = {}): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Research Cafe ${randomUUID().slice(0, 6)}` });
  if (opts.researchOn !== undefined) {
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(orgId) }, { $set: { research: { on: opts.researchOn, at: clock, by: null } } });
  }
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, locationId, scope: scopeForNewOrg(STAFF, orgId) };
}

const noMerge = (): Promise<void> => Promise.resolve();
const count = (name: string, filter: Record<string, unknown> = {}) => server.connection.collection(name).countDocuments(filter);

describe('keys and times', () => {
  it('the week is the Monday in the town’s time zone, and a weekly thread is due within 12 hours of its start', () => {
    // Monday 2026-11-16, 03:00 UTC is still Sunday evening in Hanover.
    expect(mondayOf(new Date('2026-11-16T03:00:00Z'), EASTERN)).toBe('2026-11-09');
    expect(weekKey(new Date('2026-11-16T05:00:00Z'), EASTERN)).toBe('w:2026-11-16');
    expect(weekKey(new Date('2026-11-22T23:00:00Z'), EASTERN)).toBe('w:2026-11-16');
    expect(startOfLocalDay('2026-11-16', EASTERN).toISOString()).toBe('2026-11-16T05:00:00.000Z');
    expect(startOfLocalDay('2026-07-13', EASTERN).toISOString()).toBe('2026-07-13T04:00:00.000Z');
    const at = staggeredStart('2026-11-16', EASTERN, 'hanover-nh').getTime();
    expect(at).toBeGreaterThanOrEqual(Date.parse('2026-11-16T05:00:00Z'));
    expect(at).toBeLessThan(Date.parse('2026-11-16T17:00:00Z'));
    expect(staggeredStart('2026-11-16', EASTERN, 'hanover-nh').getTime()).toBe(at);
  });

  it('stamps a town of the twelve by its id and a typed town by a key no shared row uses', () => {
    expect(townStamp({ townId: 'hanover-nh', name: 'Hanover', state: 'NH' })).toBe('hanover-nh');
    expect(townStamp({ townId: null, name: 'The Elsewhere', state: 'VT' })).toBe('typed:VT:elsewhere');
  });
});

describe('the tick', () => {
  it('two planners at once insert one town run and one location run, each with its threads once', async () => {
    const t = await tenant();
    const [a, b] = await Promise.all([planTick(context(), 'replica-a', noMerge), planTick(context(), 'replica-b', noMerge)]);
    expect(a.towns + b.towns).toBe(1);
    expect(a.locations + b.locations).toBe(1);
    const [town] = await server.connection.collection('tw_town_research_runs').find({}).toArray();
    expect(town).toMatchObject({ townKey: 'hanover-nh', key: 'w:2026-11-16', status: 'queued', liveSubject: 'hanover-nh' });
    expect(town).not.toHaveProperty('trigger');
    expect(await count('tw_town_research_threads')).toBe(6);
    const run = await stores.researchLocations.liveRun(t.scope, t.locationId);
    expect(run).toMatchObject({ key: 'w:2026-11-16', trigger: 'weekly', town: 'hanover-nh', placeId: null, threads: ['neighborhood', 'competitors'] });
    const threads = await stores.researchLocations.threadsOf(t.scope, run?.id ?? '');
    expect(threads.map((thread) => thread.thread)).toEqual(['neighborhood', 'competitors']);
    // Due over the week's Monday, already past on Wednesday.
    const monday = Date.parse('2026-11-16T05:00:00Z');
    for (const thread of threads) {
      expect(thread.notBefore.getTime()).toBeGreaterThanOrEqual(monday);
      expect(thread.notBefore.getTime()).toBeLessThan(monday + DAY / 2);
    }
  });

  it('a later tick of the same week, or within 6 days of the last run, inserts nothing', async () => {
    await tenant();
    await planTick(context(), 'replica-a', noMerge);
    await server.connection.collection('tw_town_research_runs').updateMany({}, { $set: { status: 'done' }, $unset: { liveSubject: '' } });
    await server.connection.collection('tw_location_research_runs').updateMany({}, { $set: { status: 'done' }, $unset: { liveSubject: '' } });
    // Next Monday is 5 days on: still within 6 days of the run made on Wednesday.
    clock = new Date(WEDNESDAY.getTime() + 5 * DAY);
    expect(await planTick(context(), 'replica-a', noMerge)).toMatchObject({ towns: 0, locations: 0 });
    clock = new Date(WEDNESDAY.getTime() + 6 * DAY);
    expect(await planTick(context(), 'replica-a', noMerge)).toMatchObject({ towns: 1, locations: 1 });
    expect(await count('tw_location_research_runs', { key: 'w:2026-11-23' })).toBe(1);
  });

  it('plans nothing for an organization with research off, and no town or location run while its cap is 0', async () => {
    await tenant({ researchOn: false });
    expect(await planTick(context(), 'replica-a', noMerge)).toMatchObject({ towns: 0, locations: 0 });
    await tenant();
    expect(await planTick(context({ researchTownMonthlyUsd: 0, researchOrgMonthlyUsd: 0 }), 'replica-a', noMerge)).toMatchObject({ towns: 0, locations: 0 });
    expect(await count('tw_town_research_runs') + await count('tw_location_research_runs')).toBe(0);
  });

  it('a town outside the twelve gets no shared run; its location run adds the combined town thread, stamped with the typed town', async () => {
    const t = await tenant();
    await server.connection.collection('tw_locations').updateOne(
      { _id: new Types.ObjectId(t.locationId) }, { $set: { town: { townId: null, name: 'Elsewhere', state: 'TX' }, placeId: 'place-elsewhere' } },
    );
    expect(await planTick(context(), 'replica-a', noMerge)).toMatchObject({ towns: 0, locations: 1 });
    const run = await stores.researchLocations.liveRun(t.scope, t.locationId);
    expect(run).toMatchObject({ threads: ['neighborhood', 'competitors', 'town_overview'], town: 'typed:TX:elsewhere', placeId: 'place-elsewhere' });
    expect(await count('tw_location_research_threads')).toBe(3);
    expect(await count('tw_town_research_runs')).toBe(0);
  });

  it('completes a plan that crashed between a run and its threads', async () => {
    const t = await tenant();
    const run = await stores.researchLocations.insertRun(t.scope, {
      locationId: t.locationId, key: 'w:2026-11-16', trigger: 'weekly', placeId: null, town: 'hanover-nh', threads: ['neighborhood', 'competitors'], now: clock,
    });
    await stores.researchLocations.insertThreads(t.scope, run ?? { id: '', locationId: '' }, [{ thread: 'neighborhood', notBefore: clock }], clock);
    const town = await stores.researchTowns.insertRun({ townKey: 'hanover-nh', key: 'w:2026-11-16', threads: ['schools', 'sports'], now: clock });
    expect(await planTick(context(), 'replica-a', noMerge)).toMatchObject({ towns: 0, locations: 0 });
    expect((await stores.researchLocations.threadsOf(t.scope, run?.id ?? '')).map((thread) => thread.thread)).toEqual(['neighborhood', 'competitors']);
    expect((await stores.researchTowns.threadsOf(town?.id ?? '')).map((thread) => thread.thread)).toEqual(['schools', 'sports']);
  });

  it('completes a Research now run that lost its threads while the organization share is 0', async () => {
    const t = await tenant();
    const run = await stores.researchLocations.insertRun(t.scope, {
      locationId: t.locationId, key: `p:${new Types.ObjectId().toHexString()}`, trigger: 'press', placeId: null, town: 'hanover-nh',
      threads: ['neighborhood', 'competitors'], now: clock,
    });
    await stores.researchLocations.insertThreads(t.scope, run ?? { id: '', locationId: '' }, [{ thread: 'neighborhood', notBefore: clock }], clock);
    expect(await planTick(context({ researchOrgMonthlyUsd: 0 }), 'replica-a', noMerge)).toMatchObject({ locations: 0 });
    const threads = await stores.researchLocations.threadsOf(t.scope, run?.id ?? '');
    expect(threads.map((thread) => [thread.thread, thread.notBefore])).toEqual([['neighborhood', clock], ['competitors', clock]]);
    expect(await count('tw_location_research_runs')).toBe(1);
  });

  it('an early run is due at once, asks for the town’s run, and counts as the week’s for a later tick', async () => {
    const t = await tenant();
    const location = await stores.locations.find(t.scope, t.locationId);
    if (location === null) throw new Error('no location');
    expect(await queueEarlyRun(context(), t.scope, location)).toBe('inserted');
    const run = await stores.researchLocations.liveRun(t.scope, t.locationId);
    expect(run?.trigger).toBe('early');
    expect(run?.key).toMatch(/^s:[0-9a-f]{24}$/);
    for (const thread of await stores.researchLocations.threadsOf(t.scope, run?.id ?? '')) expect(thread.notBefore).toEqual(clock);
    expect(await count('tw_town_research_runs', { townKey: 'hanover-nh', key: 'w:2026-11-16' })).toBe(1);
    // A second early run while the first is live inserts nothing.
    expect(await queueEarlyRun(context(), t.scope, location)).toBe('running');
    await server.connection.collection('tw_location_research_runs').updateMany({}, { $set: { status: 'done' }, $unset: { liveSubject: '' } });
    expect(await planTick(context(), 'replica-a', noMerge)).toMatchObject({ locations: 0 });
    expect(await count('tw_location_research_runs')).toBe(1);
  });

  it('an early run for a new place ends a live run a tick stamped with the old place, and runs now (not after 6 days)', async () => {
    const t = await tenant();
    const location = await stores.locations.find(t.scope, t.locationId);
    if (location === null) throw new Error('no location');
    // A tick read the location before its place changed, and inserted its weekly run after the change's endLive.
    const stale = await stores.researchLocations.insertRun(t.scope, {
      locationId: t.locationId, key: 'w:2026-11-16', trigger: 'weekly', placeId: 'place-before', town: townStamp(location.town), threads: ['neighborhood'], now: clock,
    });
    expect(await queueEarlyRun(context(), t.scope, location)).toBe('inserted');
    expect(await stores.researchLocations.findRun(t.scope, stale?.id ?? '')).toMatchObject({ status: 'off', code: 'place_changed' });
    const live = await stores.researchLocations.liveRun(t.scope, t.locationId);
    expect(live).toMatchObject({ trigger: 'early', placeId: location.placeId });
    // A live run of the same place is left alone.
    expect(await queueEarlyRun(context(), t.scope, location)).toBe('running');
    expect((await stores.researchLocations.liveRun(t.scope, t.locationId))?.id).toBe(live?.id);
  });

  it('queues no early run for an organization with research off', async () => {
    const t = await tenant({ researchOn: false });
    const location = await stores.locations.find(t.scope, t.locationId);
    if (location === null) throw new Error('no location');
    expect(await queueEarlyRun(context(), t.scope, location)).toBe('off');
    expect(await count('tw_location_research_runs') + await count('tw_town_research_runs')).toBe(0);
  });

  it('the merge sweep claims a run whose threads all ended though the lane that ended the last one died, once', async () => {
    const t = await tenant();
    await planTick(context(), 'replica-a', noMerge);
    const run = await stores.researchLocations.liveRun(t.scope, t.locationId);
    const town = await stores.researchTowns.liveRun('hanover-nh');
    await server.connection.collection('tw_location_research_runs').updateMany({}, { $set: { status: 'running' } });
    await server.connection.collection('tw_location_research_threads').updateMany({}, { $set: { status: 'failed', code: 'internal' } });
    await server.connection.collection('tw_town_research_runs').updateMany({}, { $set: { status: 'running' } });
    await server.connection.collection('tw_town_research_threads').updateMany({}, { $set: { status: 'empty', code: 'no_sources' } });
    const merged: ClaimedMerge[] = [];
    const merge = (claimed: ClaimedMerge): Promise<void> => {
      merged.push(claimed);
      return Promise.resolve();
    };
    expect((await planTick(context(), 'replica-b', merge)).merges).toBe(2);
    expect(merged.map((claimed) => [claimed.kind, claimed.runId, claimed.owner])).toEqual([
      ['town', town?.id, 'replica-b'], ['location', run?.id, 'replica-b'],
    ]);
    expect(merged[1]).toMatchObject({ locationId: t.locationId, scope: { orgId: t.orgId } });
    // Claimed and not yet ended: a second sweep within the merge lease takes neither.
    expect((await planTick(context(), 'replica-c', merge)).merges).toBe(0);
  });
});
