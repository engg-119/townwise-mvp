// D66's cross-tenant research lookups (openspec change town-research-agent, design decisions 2, 6, 8 and 14): the towns
// in use and the location candidates leave out an organization that is not active or has research off; the location
// thread claim takes the thread due first and holds an organization to one live thread; the merge claim waits for every
// thread to end, takes over a stale merge, and is won by one of two callers; the stale sweep finds a dead lane's thread.
// Every answer is ids only. Fixtures are made-up organizations.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, scopeForResearch, type OrgScope } from '../src/access/policy.ts';
import {
  claimLocationResearchMerge, claimNextLocationResearchThread, researchLocationCandidates, researchTownsInUse,
  staleLocationResearchThreads,
} from '../src/stores/cross-tenant.ts';
import type { TownwiseStores } from '../src/stores/index.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const MINUTE = 60_000;
const LEASE = 90_000;
const NOW = new Date('2026-11-16T12:00:00Z');
const later = (minutes: number) => new Date(NOW.getTime() + minutes * MINUTE);

let server: TownwiseTestServer;
let stores: TownwiseStores;

beforeAll(async () => {
  server = await startTownwiseServer();
  ({ stores } = server.ctx);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  for (const name of ['tw_orgs', 'tw_locations', 'tw_location_research_runs', 'tw_location_research_threads']) {
    await server.connection.collection(name).deleteMany({});
  }
});

interface Tenant { orgId: string; locationId: string; scope: OrgScope }

async function tenant(opts: { status?: 'active' | 'suspended'; researchOn?: boolean } = {}): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Research Cafe ${randomUUID().slice(0, 6)}`, ...(opts.status === undefined ? {} : { status: opts.status }) });
  if (opts.researchOn !== undefined) {
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(orgId) }, { $set: { research: { on: opts.researchOn, at: NOW, by: null } } });
  }
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { orgId, locationId, scope: scopeForNewOrg(STAFF, orgId) };
}

/** A queued location run of `threads`, each due `due` minutes from NOW. */
async function queuedRun(t: Tenant, threads: readonly ('neighborhood' | 'competitors')[] = ['neighborhood', 'competitors'], due = 0) {
  const run = await stores.researchLocations.insertRun(t.scope, {
    locationId: t.locationId, key: `w:${randomUUID()}`, trigger: 'weekly', placeId: null, town: 'hanover-nh', threads, now: NOW,
  });
  if (run === null) throw new Error('run not inserted');
  await stores.researchLocations.insertThreads(t.scope, run, threads.map((thread) => ({ thread, notBefore: later(due) })), NOW);
  return run;
}

const NO_DROPS = {
  events: { bad_shape: 0, over_cap: 0, no_source: 0, unknown_source: 0, bad_dates: 0, bad_title: 0, bad_competitor: 0 },
  entities: { bad_shape: 0, over_cap: 0, bad_ref: 0, bad_name: 0, no_source: 0 },
};
const ended = { status: 'empty' as const, code: 'no_sources', found: null, drops: NO_DROPS, spentMicroUsd: 0, searches: 0, fetches: 0, now: NOW };

describe('the towns in use and the location candidates', () => {
  it('leave out an organization that is suspended or has research off; absent reads on', async () => {
    const on = await tenant();
    const switchedOn = await tenant({ researchOn: true });
    await tenant({ researchOn: false });
    await tenant({ status: 'suspended' });
    expect(await researchTownsInUse(server.connection)).toEqual(['hanover-nh']);
    const candidates = await researchLocationCandidates(server.connection);
    expect(candidates).toEqual([
      { orgId: on.orgId, locationId: on.locationId }, { orgId: switchedOn.orgId, locationId: switchedOn.locationId },
    ]);
  });

  it('answer no town for a town outside the twelve, and none while no organization may be researched', async () => {
    expect(await researchTownsInUse(server.connection)).toEqual([]);
    const t = await tenant();
    await server.connection.collection('tw_locations').updateOne(
      { _id: new Types.ObjectId(t.locationId) }, { $set: { town: { townId: null, name: 'Elsewhere', state: 'VT' } } },
    );
    expect(await researchTownsInUse(server.connection)).toEqual([]);
    expect(await researchLocationCandidates(server.connection)).toEqual([{ orgId: t.orgId, locationId: t.locationId }]);
  });
});

describe('the location thread claim', () => {
  const claim = (owner: string, now = NOW) => claimNextLocationResearchThread(server.connection, { owner, now, leaseMs: LEASE, perOrgLive: 1 });

  it('takes the thread due first, counts the attempt, and leaves a thread not yet due', async () => {
    const t = await tenant();
    const run = await queuedRun(t, ['neighborhood'], 30);
    await stores.researchLocations.insertThreads(t.scope, run, [{ thread: 'competitors', notBefore: later(-5) }], NOW);
    const claimed = await claim('lane-a');
    if (claimed === null) throw new Error('nothing claimed');
    expect(claimed).toMatchObject({ orgId: t.orgId, locationId: t.locationId, runId: run.id, attempt: 1 });
    const threads = await stores.researchLocations.threadsOf(scopeForResearch(claimed), run.id);
    expect(threads.find((thread) => thread.id === claimed.id)).toMatchObject({
      thread: 'competitors', status: 'running', owner: 'lane-a', attempts: 1, leaseUntil: new Date(NOW.getTime() + LEASE),
    });
    expect(threads.find((thread) => thread.thread === 'neighborhood')?.status).toBe('queued');
    await stores.researchLocations.finishThread(t.scope, claimed.id, 'lane-a', ended);
    expect(await claim('lane-b')).toBeNull();
  });

  it('holds an organization to one live thread, while another organization’s thread is claimed', async () => {
    const a = await tenant();
    const b = await tenant();
    await queuedRun(a);
    await queuedRun(b, ['neighborhood'], 1);
    expect((await claim('lane-a'))?.orgId).toBe(a.orgId);
    // a's second thread waits while the first's lease lives; b's is next, though due later.
    expect((await claim('lane-b', later(1)))?.orgId).toBe(b.orgId);
    expect(await claim('lane-c', later(1))).toBeNull();
  });

  it('a thread whose lease passed no longer holds its organization', async () => {
    const t = await tenant();
    await queuedRun(t);
    await claim('lane-a');
    expect(await claim('lane-b', later(1))).toBeNull();
    expect((await claim('lane-b', later(2)))?.orgId).toBe(t.orgId);
  });

  it('claims nothing of an organization that is suspended or has research off', async () => {
    const off = await tenant();
    const held = await tenant();
    await queuedRun(off);
    await queuedRun(held);
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(off.orgId) }, { $set: { research: { on: false, at: NOW, by: null } } });
    await server.connection.collection('tw_orgs').updateOne({ _id: new Types.ObjectId(held.orgId) }, { $set: { status: 'suspended' } });
    expect(await claim('lane-a')).toBeNull();
  });

  it('two lanes claiming at once take different threads', async () => {
    const a = await tenant();
    const b = await tenant();
    await queuedRun(a, ['neighborhood']);
    await queuedRun(b, ['neighborhood']);
    const [one, two] = await Promise.all([claim('lane-a'), claim('lane-b')]);
    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(one?.id).not.toBe(two?.id);
  });
});

describe('the merge claim', () => {
  async function runningRun(t: Tenant) {
    const run = await queuedRun(t);
    await stores.researchLocations.markRunRunning(t.scope, run.id, NOW);
    return run;
  }

  async function endThreads(t: Tenant, runId: string, count: number) {
    for (const thread of (await stores.researchLocations.threadsOf(t.scope, runId)).slice(0, count)) {
      await server.connection.collection('tw_location_research_threads').updateOne({ _id: new Types.ObjectId(thread.id) }, { $set: { status: 'running', owner: 'x' } });
      expect(await stores.researchLocations.finishThread(t.scope, thread.id, 'x', ended)).toBe(true);
    }
  }

  const merge = (owner: string, runId?: string, now = NOW) => claimLocationResearchMerge(server.connection, {
    ...(runId === undefined ? {} : { runId }), owner, now, leaseMs: LEASE,
  });

  it('waits until every thread is terminal, then the lane’s claim of its run wins once of two callers', async () => {
    const t = await tenant();
    const run = await runningRun(t);
    await endThreads(t, run.id, 1);
    expect(await merge('lane-a', run.id)).toBeNull();
    await endThreads(t, run.id, 2);
    const [one, two] = await Promise.all([merge('lane-a', run.id), merge('lane-b', run.id)]);
    expect([one, two].filter((claimed) => claimed !== null)).toEqual([{ runId: run.id, orgId: t.orgId, locationId: t.locationId }]);
    expect((await stores.researchLocations.findRun(t.scope, run.id))?.status).toBe('merging');
  });

  it('the sweep takes any organization’s run whose threads all ended, and a merge whose lease passed', async () => {
    const a = await tenant();
    const b = await tenant();
    const open = await runningRun(a);
    const done = await runningRun(b);
    await endThreads(b, done.id, 2);
    expect(await merge('sweep')).toEqual({ runId: done.id, orgId: b.orgId, locationId: b.locationId });
    expect(await merge('sweep-2', undefined, later(1))).toBeNull();
    expect(await merge('sweep-2', undefined, later(2))).toEqual({ runId: done.id, orgId: b.orgId, locationId: b.locationId });
    expect((await stores.researchLocations.findRun(a.scope, open.id))?.status).toBe('running');
  });

  it('claims no run while a thread it planned has no row yet (a plan that crashed between its thread rows)', async () => {
    const t = await tenant();
    const run = await stores.researchLocations.insertRun(t.scope, {
      locationId: t.locationId, key: `w:${randomUUID()}`, trigger: 'weekly', placeId: null, town: 'hanover-nh', threads: ['neighborhood', 'competitors'], now: NOW,
    });
    if (run === null) throw new Error('run not inserted');
    await stores.researchLocations.insertThreads(t.scope, run, [{ thread: 'neighborhood', notBefore: NOW }], NOW);
    await stores.researchLocations.markRunRunning(t.scope, run.id, NOW);
    await endThreads(t, run.id, 1);
    expect(await merge('lane-a', run.id)).toBeNull();
    expect(await merge('sweep')).toBeNull();
    await stores.researchLocations.insertThreads(t.scope, run, [{ thread: 'competitors', notBefore: NOW }], NOW);
    await endThreads(t, run.id, 2);
    expect(await merge('sweep')).toEqual({ runId: run.id, orgId: t.orgId, locationId: t.locationId });
  });

  it('never claims a queued or an ended run', async () => {
    const t = await tenant();
    const run = await queuedRun(t);
    await endThreads(t, run.id, 2);
    expect(await merge('sweep')).toBeNull();
    await stores.researchLocations.finishRun(t.scope, run.id, { status: 'off', code: 'place_changed', counts: { found: 0, added: 0, updated: 0, dropped: 0 }, costMicroUsd: 0, now: NOW });
    expect(await merge('sweep', run.id)).toBeNull();
  });
});

describe('the stale sweep', () => {
  it('finds running threads whose lease passed, in any organization, by id', async () => {
    const a = await tenant();
    const b = await tenant();
    await queuedRun(a, ['neighborhood']);
    const run = await queuedRun(b, ['neighborhood'], 1);
    const first = await claimNextLocationResearchThread(server.connection, { owner: 'lane-a', now: NOW, leaseMs: LEASE, perOrgLive: 1 });
    const second = await claimNextLocationResearchThread(server.connection, { owner: 'lane-b', now: later(1), leaseMs: LEASE, perOrgLive: 1 });
    expect(await staleLocationResearchThreads(server.connection, later(1))).toEqual([]);
    expect(await staleLocationResearchThreads(server.connection, later(2))).toEqual([
      { id: first?.id, orgId: a.orgId, locationId: a.locationId, runId: first?.runId },
    ]);
    expect(await staleLocationResearchThreads(server.connection, later(3))).toEqual([
      { id: first?.id, orgId: a.orgId, locationId: a.locationId, runId: first?.runId },
      { id: second?.id, orgId: b.orgId, locationId: b.locationId, runId: run.id },
    ]);
  });
});
