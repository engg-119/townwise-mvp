// D66 (openspec change town-research-agent, design decision 15): research runs in TownwiseAI's "What it's been doing",
// through GET /api/org/locations/:locationId/agent. Each run of the location and of its town that ended with an outcome
// shows as `research_done`, newest first; the town's carries its status and counts only; a live run or one ended `off`
// is left out; another organization's location runs never show, while the shared town run does; and nothing shows once
// the organization turned research off. The server runs no runner: rows are written as a run would leave them.
// Fixtures are made-up places and organizations.
import { randomUUID } from 'node:crypto';

import { Types } from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import type { ThreadId } from '../src/research/threads.ts';
import type { EndedRunStatus, ThreadEnd } from '../src/stores/research-shared.ts';
import { addLocation, addSeat, createOrg } from './helpers/fixtures.ts';
import { call, signIn, startTownwiseServer, type TestSession, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const SENTINEL = 'Zyxwvut Rival Trivia';

let server: TownwiseTestServer;

beforeAll(async () => { server = await startTownwiseServer(); });
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  await server.redis.flushdb();
  for (const name of ['tw_town_research_runs', 'tw_town_research_threads', 'tw_town_events', 'tw_town_entities']) {
    await server.connection.collection(name).deleteMany({});
  }
});

interface Tenant { scope: OrgScope; locationId: string; admin: TestSession }

async function tenant(): Promise<Tenant> {
  const orgId = await createOrg(server, { name: `Research Activity ${randomUUID().slice(0, 6)}` });
  const email = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const admin = await signIn(server, email);
  await addSeat(server, { orgId, userId: admin.userId, email, role: 'org_admin' });
  const locationId = await addLocation(server, { orgId, name: 'Main Room' });
  return { scope: scopeForNewOrg(STAFF, orgId), locationId, admin };
}

interface ResearchItem { kind: string; subject?: string; status?: string }

async function activity(t: Tenant): Promise<ResearchItem[]> {
  const res = await call(server, `/api/org/locations/${t.locationId}/agent`, { session: t.admin });
  expect(res.status).toBe(200);
  const body = await res.json() as { activity: ResearchItem[] };
  return body.activity.filter((item) => item.kind === 'research_done');
}

const minutes = (n: number) => new Date(server.clock.now().getTime() + n * 60_000);

const ended = (at: Date, over: Partial<ThreadEnd> = {}): ThreadEnd => ({
  status: 'recorded', code: null, found: null, drops: null, spentMicroUsd: 1_000, searches: 1, fetches: 0, now: at, ...over,
});

/** A location run whose threads ended as given, finished `finish` at `at` (left running without one). */
async function locationRun(t: Tenant, input: {
  key: string; at: Date; ends: Record<string, Partial<ThreadEnd>>; finish?: EndedRunStatus; counts?: { found: number; added: number };
}): Promise<string> {
  const store = server.ctx.stores.researchLocations;
  const threads: ThreadId[] = ['neighborhood', 'competitors'];
  const run = await store.insertRun(t.scope, { locationId: t.locationId, key: input.key, trigger: 'press', placeId: null, town: 'hanover-nh', threads, now: input.at });
  if (run === null) throw new Error('run refused');
  await store.insertThreads(t.scope, run, threads.map((thread) => ({ thread, notBefore: input.at })), input.at);
  await store.markRunRunning(t.scope, run.id, input.at);
  for (const row of await store.threadsOf(t.scope, run.id)) {
    await server.connection.collection('tw_location_research_threads').updateOne({ _id: new Types.ObjectId(row.id) }, { $set: { status: 'running', owner: 'lane' } });
    await store.finishThread(t.scope, row.id, 'lane', ended(input.at, input.ends[row.thread] ?? {}));
  }
  if (input.finish !== undefined) {
    const counts = { found: input.counts?.found ?? 0, added: input.counts?.added ?? 0, updated: 0, dropped: 0 };
    await store.finishRun(t.scope, run.id, { status: input.finish, code: null, counts, costMicroUsd: 2_000, now: input.at });
  }
  return run.id;
}

async function townRun(at: Date): Promise<void> {
  const towns = server.ctx.stores.researchTowns;
  const run = await towns.insertRun({ townKey: 'hanover-nh', key: `w:${at.toISOString()}`, threads: ['schools', 'sports'], now: at });
  if (run === null) throw new Error('town run refused');
  await towns.markRunRunning(run.id, at);
  await towns.finishRun(run.id, { status: 'done', code: null, counts: { found: 12, added: 5, updated: 2, dropped: 3 }, costMicroUsd: 9_000, now: at });
}

async function competitorEvent(t: Tenant, runId: string, origin: 'competitor' | 'neighborhood' = 'competitor', title = SENTINEL): Promise<void> {
  const at = server.clock.now();
  await server.ctx.stores.researchLocations.insertEvent(t.scope, t.locationId, {
    title, titleKey: title.toLowerCase(), kind: 'event', category: 'dining', start: '2026-06-10', end: '2026-06-10',
    weekdays: null, startTime: null, status: 'scheduled', venueId: null, hostId: null, confidence: 'medium',
    sources: [{ label: 'example.test', url: 'https://example.test/rival' }], firstRunId: runId, lastRunId: runId, firstSeenAt: at, lastSeenAt: at,
    seenCount: 1, placeId: null, town: 'hanover-nh', origin, competitorEntityId: null, competitorPlaceId: null,
  });
}

describe('research_done in TownwiseAI’s activity', () => {
  it('lists the location’s and the town’s ended runs newest first, the town’s with status and counts only, and no live or stopped run', async () => {
    const t = await tenant();
    await locationRun(t, { key: 'p1', at: minutes(1), ends: { competitors: { status: 'failed', code: 'provider_error' } }, finish: 'partial', counts: { found: 4, added: 2 } });
    const done = await locationRun(t, { key: 'p2', at: minutes(3), ends: {}, finish: 'done', counts: { found: 9, added: 3 } });
    await competitorEvent(t, done);
    // Not a competitor's: not counted.
    await competitorEvent(t, done, 'neighborhood', `${SENTINEL} Fair`);
    await townRun(minutes(2));
    // Stopped (`off`) and still running: neither shows.
    await locationRun(t, { key: 'p3', at: minutes(4), ends: {}, finish: 'off' });
    await locationRun(t, { key: 'p4', at: minutes(5), ends: {} });

    const items = await activity(t);
    expect(items).toEqual([
      {
        at: minutes(3).toISOString(), kind: 'research_done', subject: 'location', status: 'done', found: 9, added: 3, competitors: 1,
        threadsFailed: 0, threadsBudget: 0, finishedAt: minutes(3).toISOString(),
      },
      {
        at: minutes(2).toISOString(), kind: 'research_done', subject: 'town', status: 'done', found: 12, added: 5, competitors: null,
        threadsFailed: 0, threadsBudget: 0, finishedAt: minutes(2).toISOString(),
      },
      {
        at: minutes(1).toISOString(), kind: 'research_done', subject: 'location', status: 'partial', found: 4, added: 2, competitors: 0,
        threadsFailed: 1, threadsBudget: 0, finishedAt: minutes(1).toISOString(),
      },
    ]);
    expect(JSON.stringify(items)).not.toContain(SENTINEL);
    expect(JSON.stringify(items)).not.toContain('press');
  });

  it('shows another organization the shared town run but never this location’s runs', async () => {
    const a = await tenant();
    const b = await tenant();
    await locationRun(a, { key: 'p1', at: minutes(1), ends: {}, finish: 'done', counts: { found: 1, added: 1 } });
    await townRun(minutes(2));
    expect(await activity(b)).toEqual([expect.objectContaining({ subject: 'town', status: 'done' })]);
    expect((await activity(a)).map((item) => item.subject)).toEqual(['town', 'location']);
  });

  it('shows nothing once the organization turned research off', async () => {
    const t = await tenant();
    await locationRun(t, { key: 'p1', at: minutes(1), ends: {}, finish: 'done' });
    await townRun(minutes(2));
    expect(await activity(t)).toHaveLength(2);
    await server.ctx.stores.orgs.setResearch(t.scope, { on: false, at: server.clock.now(), by: t.admin.userId });
    expect(await activity(t)).toEqual([]);
  });
});
