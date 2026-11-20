// D66's runner (openspec change town-research-agent, design decisions 1, 6, 7, 8 and 16), against a model that answers
// each gather with one search and each extract with one event: two runners racing run each thread once and merge once;
// a lost lease aborts and writes nothing; a retryable failure is retried then fails; a refusal fails at once; a refused
// reservation ends `budget`; a shutdown puts the thread back; a dead replica's thread is settled to its tally plus 30
// seconds; a merge redone after a crash adds nothing twice; two lanes ending a run's last threads at once merge it once;
// a location deleted mid-thread keeps no row; an organization's automatic research stops at its share; logs hold no
// title, URL or query; and no request holds the organization's name, a revision's text or (by the switch) the typed or
// Google name. Competitors (task 4.2): with Google's names kept from Anthropic, Google is never asked and a competitor
// event is stored with its web-found business; with them allowed, the list goes in the request and an event naming one
// keeps its place id only; with no profile the restaurant's threads end `places_off`, and with no list the competitors
// thread searches the web. Synthetic pages, hosts and names only.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { BadRequestError, InternalServerError } from '@anthropic-ai/sdk';
import type { BetaMessage, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { scopeForNewOrg, type OrgScope } from '../src/access/policy.ts';
import type { ChatModel } from '../src/chat/model.ts';
import { messageCostMicroUsd } from '../src/chat/pricing.ts';
import type { Competitor } from '../src/research/competitors.ts';
import { researchRuns } from '../src/research/plan.ts';
import { researchedEventsFor } from '../src/research/read.ts';
import { createResearchRunner, staleGraceMicroUsd, type ResearchRunner, type ResearchRunnerDeps } from '../src/research/runner.ts';
import type { ThreadId } from '../src/research/threads.ts';
import type { TownwiseStores } from '../src/stores/index.ts';
import { citedQuotes, message, scriptedModel, text, webResults, webSearch, type Step } from './helpers/chat-model.ts';
import { addLocation, createOrg } from './helpers/fixtures.ts';
import { startTownwiseServer, type TownwiseTestServer } from './helpers/server.ts';

const STAFF = { kind: 'staff', actor: { userId: 'staff-0000', email: 'staff@example.test', sessionId: 'session-0000', verifiedUntil: '' } } as const;
const NOW = new Date('2026-11-19T15:00:00Z');
const MONTH = '2026-11';
const PAGE_A = 'https://calendar.sentinel-college.example.org/winter';
const PAGE_B = 'https://www.sentinel-town.example.gov/events';
const TITLE = 'Sentinel Lantern Walk';
const QUOTE = 'Sentinel Lantern Walk on January 16, 2027 at the Green';
const CONFIG: ResearchRunnerDeps['config'] = {
  chatMonthlyBudgetUsd: 20, researchTownMonthlyUsd: 40, researchOrgMonthlyUsd: 6, researchWebFetch: false, researchPlacesToAi: false,
};

let server: TownwiseTestServer;
let stores: TownwiseStores;
let clock = NOW;
const runners: ResearchRunner[] = [];

beforeAll(async () => {
  server = await startTownwiseServer();
  ({ stores } = server.ctx);
});
afterAll(async () => { await server.close(); });
beforeEach(async () => {
  clock = NOW;
  server.logs.length = 0;
  for (const name of [
    'tw_orgs', 'tw_locations', 'tw_chat_usage', 'tw_research_spend', 'tw_research_revisions', 'tw_town_research_runs', 'tw_town_research_threads',
    'tw_town_events', 'tw_town_entities', 'tw_location_research_runs', 'tw_location_research_threads', 'tw_location_events', 'tw_location_entities',
  ]) await server.connection.collection(name).deleteMany({});
});
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.close();
});

function gathered(usage: { input?: number; output?: number } = {}): BetaMessage {
  return message([
    webSearch('s1'), webResults('s1', [PAGE_A, PAGE_B]), citedQuotes(`EVENT: ${TITLE}, January 16, 2027.`, [{ url: PAGE_A, quote: QUOTE }]),
  ], { usage: { input: 4_000, output: 600, searches: 1, ...usage } });
}

function answer(usage: { input?: number; output?: number } = {}): BetaMessage {
  const event = {
    title: TITLE, kind: 'event', category: 'community', startDate: '2027-01-16', endDate: '2027-01-16', weekdays: null, startTime: null,
    status: 'scheduled', venueRef: 'v1', hostRef: null, competitor: null, sourceIds: ['S1'], dateQuote: 'January 16, 2027', confidence: 'high',
  };
  const entity = { ref: 'v1', type: 'venue', name: 'Sentinel Green', sourceIds: ['S1'] };
  return message([text(JSON.stringify({ events: [event], entities: [entity] }))], { usage: { input: 900, output: 300, ...usage } });
}

/** The extract's answer for a competitors thread: a trivia night hosted by a business found on the web, naming `competitor`. */
function competitorAnswer(competitor: number | null): BetaMessage {
  const event = {
    title: 'Sentinel Trivia Night', kind: 'event', category: 'dining', startDate: '2027-01-16', endDate: '2027-01-16', weekdays: null, startTime: '19:00',
    status: 'scheduled', venueRef: null, hostRef: 'b1', competitor, sourceIds: ['S1'], dateQuote: 'January 16, 2027', confidence: 'high',
  };
  const entity = { ref: 'b1', type: 'business', name: 'Sentinel Tavern', sourceIds: ['S1'] };
  return message([text(JSON.stringify({ events: [event], entities: [entity] }))], { usage: { input: 900, output: 300 } });
}

const PROFILE = { name: 'Fixture Google Bistro', address: '1 Fixture Lane, Hanover, NH' };
/** Google's live competitors, as research/places.ts answers them. */
const RIVALS: Competitor[] = [
  { n: 1, placeId: 'ChIJFixtureRival0001', name: 'Fixture Rival Cafe', primaryType: 'cafe', family: 'cafe', website: null, distanceM: 120 },
  { n: 2, placeId: 'ChIJFixtureRival0002', name: 'Fixture Rival Tavern', primaryType: 'bar', family: 'bar', website: 'https://rival.example.com/', distanceM: 300 },
];
const GOOGLE_CONTENT = ['Fixture Google Bistro', '1 Fixture Lane', 'Fixture Rival', 'rival.example.com'];

/** A model answering each gather (a request with tools) and each extract by the given steps, recording what was sent. */
function answering(steps: { gather?: () => Step; extract?: () => Step } = {}) {
  const calls: BetaMessageStreamParams[] = [];
  const model: ChatModel = {
    stream(params, options) {
      calls.push(JSON.parse(JSON.stringify(params)) as BetaMessageStreamParams);
      const one = scriptedModel();
      one.script(params.tools === undefined
        ? steps.extract?.() ?? { kind: 'message', message: answer() }
        : steps.gather?.() ?? { kind: 'message', message: gathered() });
      return one.stream(params, options);
    },
  };
  return { model, calls };
}

function runner(model: ChatModel, over: Partial<ResearchRunnerDeps> = {}): ResearchRunner {
  const made = createResearchRunner({
    connection: server.connection, stores, logger: server.ctx.logger, now: () => clock, model, config: CONFIG, owner: `replica-${randomUUID().slice(0, 4)}`,
    lanes: 1, pollMs: 3_600_000, planDelayMs: 3_600_000, heartbeatMs: 20, retryWaitsMs: [0, 0], ...over,
  });
  runners.push(made);
  return made;
}

async function run(r: ResearchRunner): Promise<void> {
  r.nudge();
  await r.settled();
}

async function townRun(threads: readonly ThreadId[] = ['schools']) {
  const created = await stores.researchTowns.insertRun({ townKey: 'hanover-nh', key: `w:${randomUUID()}`, threads, now: clock });
  if (created === null) throw new Error('no run');
  await stores.researchTowns.insertThreads(created, threads.map((thread) => ({ thread, notBefore: clock })), clock);
  return created;
}

interface Tenant { orgId: string; scope: OrgScope; locationIds: string[] }

async function tenant(opts: { name?: string; locations?: string[]; placeId?: string | null } = {}): Promise<Tenant> {
  const orgId = await createOrg(server, { name: opts.name ?? `Research Cafe ${randomUUID().slice(0, 6)}` });
  const locationIds: string[] = [];
  for (const name of opts.locations ?? ['Main Room']) {
    const id = await addLocation(server, { orgId, name });
    await server.connection.collection('tw_locations').updateOne({ _id: new Types.ObjectId(id) }, { $set: { placeId: opts.placeId === undefined ? `place-${id}` : opts.placeId } });
    locationIds.push(id);
  }
  return { orgId, scope: scopeForNewOrg(STAFF, orgId), locationIds };
}

async function locationRun(t: Tenant, locationId: string, threads: readonly ThreadId[] = ['neighborhood'], trigger: 'weekly' | 'press' = 'weekly') {
  const location = await stores.locations.find(t.scope, locationId);
  const created = await stores.researchLocations.insertRun(t.scope, {
    locationId, key: `w:${randomUUID()}`, trigger, placeId: location?.placeId ?? null, town: 'hanover-nh', threads, now: clock,
  });
  if (created === null) throw new Error('no run');
  await stores.researchLocations.insertThreads(t.scope, created, threads.map((thread) => ({ thread, notBefore: clock })), clock);
  return created;
}

const lines = (msg: string) => server.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => line.msg === msg);

/** Waits (real time) until `check` holds. */
async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
  throw new Error('timed out waiting');
}

const threadDoc = async (filter: Record<string, unknown> = {}) => server.connection.collection('tw_town_research_threads').findOne(filter);

describe('the runner: threads', () => {
  it('two runners racing run each thread once, and the run merges once into one deduplicated event', async () => {
    const created = await townRun(['schools', 'sports']);
    const { model, calls } = answering();
    await Promise.all([run(runner(model, { lanes: 2 })), run(runner(model, { lanes: 2 }))]);
    expect(calls).toHaveLength(4);
    const doneRun = await stores.researchTowns.findRun(created.id);
    expect(doneRun).toMatchObject({ status: 'done', counts: { found: 2, added: 1, updated: 0 } });
    expect(lines('townwise.research_run').filter((line) => line.runId === created.id)).toHaveLength(1);
    const events = await stores.researchTowns.events('hanover-nh');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ title: TITLE, start: '2027-01-16', seenCount: 1, firstRunId: created.id });
    expect(events[0]?.venueId).not.toBeNull();
    // Found cleared, counts and drops kept; the spend settled to what the threads cost.
    const threads = await stores.researchTowns.threadsOf(created.id);
    expect(threads.every((thread) => thread.status === 'recorded' && thread.found === null && thread.drops !== null)).toBe(true);
    const cost = messageCostMicroUsd(gathered()) + messageCostMicroUsd(answer());
    expect(await stores.researchSpend.spent(MONTH, 'hanover-nh')).toEqual({ month: 2 * cost, town: 2 * cost });
  });

  it('a lost lease aborts the call, settles its reservation and writes nothing else', async () => {
    const created = await townRun();
    const { model, calls } = answering({ gather: () => ({ kind: 'hang', before: [] }) });
    const r = runner(model);
    r.nudge();
    await until(async () => ((await threadDoc())?.reservedMicroUsd as number) > 0);
    // A place change or a deletion ends the thread under the lane.
    await server.connection.collection('tw_town_research_threads').updateOne({ runId: new Types.ObjectId(created.id) }, { $set: { status: 'failed', code: 'test_ended', owner: null } });
    await r.settled();
    expect(calls).toHaveLength(1);
    expect(await threadDoc()).toMatchObject({ status: 'failed', code: 'test_ended' });
    expect(await stores.researchSpend.spent(MONTH, 'hanover-nh')).toEqual({ month: 0, town: 0 });
    expect(lines('townwise.research_thread').map((line) => line.outcome)).toEqual(['lost']);
  });

  it('a retryable failure is tried again, then fails the thread and the run', async () => {
    const created = await townRun();
    const down = () => new InternalServerError(500, { type: 'error', error: { type: 'api_error', message: 'down' } }, undefined, new Headers());
    const { model, calls } = answering({ gather: () => ({ kind: 'error', error: down() }) });
    await run(runner(model));
    expect(calls).toHaveLength(2);
    expect(await threadDoc()).toMatchObject({ status: 'failed', code: 'provider_unavailable', attempts: 2 });
    expect((await stores.researchTowns.findRun(created.id))?.status).toBe('failed');
    expect(lines('townwise.research_thread').map((line) => [line.outcome, line.code])).toEqual([['retry', 'provider_unavailable'], ['failed', 'provider_unavailable']]);
  });

  it('a request the API refuses fails at once', async () => {
    await townRun();
    const refused = new BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad tool' } }, undefined, new Headers());
    const { model, calls } = answering({ gather: () => ({ kind: 'error', error: refused }) });
    await run(runner(model));
    expect(calls).toHaveLength(1);
    expect(await threadDoc()).toMatchObject({ status: 'failed', code: 'request_refused', attempts: 1 });
  });

  it('a reservation the month refuses ends the thread and the run `budget`, with no call', async () => {
    const created = await townRun();
    const { model, calls } = answering();
    await run(runner(model, { config: { ...CONFIG, researchTownMonthlyUsd: 1 } }));
    expect(calls).toHaveLength(0);
    expect(await threadDoc()).toMatchObject({ status: 'budget', code: 'budget' });
    expect((await stores.researchTowns.findRun(created.id))?.status).toBe('budget');
  });

  it('a shutdown aborts the call, settles, and puts the thread back with the attempt counted', async () => {
    await townRun();
    const { model } = answering({ gather: () => ({ kind: 'hang', before: [] }) });
    const r = runner(model);
    r.nudge();
    await until(async () => ((await threadDoc())?.reservedMicroUsd as number) > 0);
    await r.close();
    // The lane settled the reservation, so the row holds none for a later reclaim to give back again.
    expect(await threadDoc()).toMatchObject({ status: 'queued', code: 'interrupted', attempts: 1, owner: null, reservedMicroUsd: 0, month: null });
    expect(await stores.researchSpend.spent(MONTH, 'hanover-nh')).toEqual({ month: 0, town: 0 });
  });

  it('a thread claimed while the replica shuts down goes back untouched, its attempt not counted and nothing reserved', async () => {
    await townRun();
    // Its second try, claimed during a rolling deploy.
    await server.connection.collection('tw_town_research_threads').updateMany({}, { $set: { attempts: 1 } });
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let claiming = false;
    const slow = { ...stores, researchTowns: { ...stores.researchTowns, claimThread: async (...args: Parameters<TownwiseStores['researchTowns']['claimThread']>) => {
      claiming = true;
      const claimed = await stores.researchTowns.claimThread(...args);
      await gate;
      return claimed;
    } } };
    const { model, calls } = answering();
    const r = runner(model, { stores: slow });
    r.nudge();
    await until(() => Promise.resolve(claiming));
    const closed = r.close();
    release();
    await closed;
    expect(calls).toHaveLength(0);
    expect(await threadDoc()).toMatchObject({ status: 'queued', attempts: 1, owner: null, reservedMicroUsd: 0 });
    expect(await stores.researchSpend.spent(MONTH, 'hanover-nh')).toEqual({ month: 0, town: 0 });
  });

  it('a lane whose lease the stale sweep took settles nothing itself: the sweep’s charge stands alone', async () => {
    await townRun();
    const { model } = answering({ gather: () => ({ kind: 'hang', before: [] }) });
    // No heartbeat: the lane stalls past its lease while still alive.
    const stalled = runner(model, { heartbeatMs: 3_600_000 });
    stalled.nudge();
    await until(async () => ((await threadDoc())?.reservedMicroUsd as number) > 0);
    const reserved = (await threadDoc())?.reservedMicroUsd as number;
    clock = new Date(NOW.getTime() + 10 * 60_000);
    await runner(answering().model, { lanes: 0 }).plan();
    expect(await threadDoc()).toMatchObject({ status: 'queued', owner: null, reservedMicroUsd: 0, month: null });
    const charged = Math.min(reserved, staleGraceMicroUsd());
    expect(await stores.researchSpend.spent(MONTH, 'hanover-nh')).toEqual({ month: charged, town: charged });
    // The stalled lane's call ends; its row was taken, so it gives nothing back.
    await stalled.close();
    expect(await stores.researchSpend.spent(MONTH, 'hanover-nh')).toEqual({ month: charged, town: charged });
  });

  it('a dead replica’s thread is put back and charged its last tally plus 30 seconds, the rest refunded', async () => {
    const created = await townRun();
    await stores.researchSpend.add({ month: MONTH, townKey: 'hanover-nh', costMicroUsd: 5_000_000 });
    await server.connection.collection('tw_town_research_threads').updateOne({ runId: new Types.ObjectId(created.id) }, {
      $set: { status: 'running', owner: 'dead', leaseUntil: new Date(NOW.getTime() - 1000), reservedMicroUsd: 5_000_000, spentMicroUsd: 1_000_000, month: MONTH, attempts: 1 },
    });
    // No lane: only the sweep runs.
    await runner(answering().model, { lanes: 0 }).plan();
    expect(await threadDoc()).toMatchObject({ status: 'queued', owner: null, attempts: 1 });
    const charged = 1_000_000 + staleGraceMicroUsd();
    expect(charged).toBeLessThan(5_000_000);
    expect(await stores.researchSpend.spent(MONTH, 'hanover-nh')).toEqual({ month: charged, town: charged });
    // The next claim dies too, before its reservation: the second reclaim has nothing to give back.
    await server.connection.collection('tw_town_research_threads').updateOne({ runId: new Types.ObjectId(created.id) }, {
      $set: { status: 'running', owner: 'dead-2', leaseUntil: new Date(NOW.getTime() - 1000), attempts: 2 },
    });
    await runner(answering().model, { lanes: 0 }).plan();
    expect(await threadDoc()).toMatchObject({ status: 'queued', owner: null, attempts: 2 });
    expect(await stores.researchSpend.spent(MONTH, 'hanover-nh')).toEqual({ month: charged, town: charged });
  });

  it('a thread past its attempts is failed at its next claim', async () => {
    await townRun();
    await server.connection.collection('tw_town_research_threads').updateMany({}, { $set: { attempts: 2 } });
    const { model, calls } = answering();
    await run(runner(model));
    expect(calls).toHaveLength(0);
    expect(await threadDoc()).toMatchObject({ status: 'failed', code: 'interrupted', attempts: 3 });
  });
});

describe('the runner: merges', () => {
  it('a merge redone after a crash adds nothing twice, and still counts what it found and added', async () => {
    const created = await townRun();
    const crashing = { ...stores, researchTowns: { ...stores.researchTowns, finishRun: () => Promise.reject(new Error('crash')) } };
    await run(runner(answering().model, { stores: crashing }));
    expect((await stores.researchTowns.findRun(created.id))?.status).toBe('merging');
    expect(await stores.researchTowns.events('hanover-nh')).toHaveLength(1);
    // The merge lease passes and the sweep takes it over.
    clock = new Date(NOW.getTime() + 2 * 60_000);
    await runner(answering().model, { lanes: 0 }).plan();
    expect(await stores.researchTowns.findRun(created.id)).toMatchObject({ status: 'done', counts: { found: 1, added: 1, updated: 0 } });
    // Found is cleared once the run ended.
    expect((await stores.researchTowns.threadsOf(created.id)).map((thread) => thread.found)).toEqual([null]);
    const events = await stores.researchTowns.events('hanover-nh');
    expect(events).toHaveLength(1);
    expect(events[0]?.seenCount).toBe(1);
  });

  it('two lanes ending a run’s last two threads at once merge it exactly once', async () => {
    const created = await townRun(['schools', 'sports']);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { model } = answering({ gather: () => ({ kind: 'message', message: gathered(), gate }) });
    const r = runner(model, { lanes: 2 });
    r.nudge();
    await until(async () => (await server.connection.collection('tw_town_research_threads').countDocuments({ status: 'running', reservedMicroUsd: { $gt: 0 } })) === 2);
    release();
    await r.settled();
    expect((await stores.researchTowns.findRun(created.id))?.status).toBe('done');
    expect(lines('townwise.research_run')).toHaveLength(1);
    expect(await stores.researchTowns.events('hanover-nh')).toHaveLength(1);
  });

  it('a location deleted while its thread searches keeps no research row', async () => {
    const t = await tenant();
    const [locationId = ''] = t.locationIds;
    await locationRun(t, locationId);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { model } = answering({ gather: () => ({ kind: 'message', message: gathered(), gate }) });
    const r = runner(model);
    r.nudge();
    await until(async () => (await server.connection.collection('tw_location_research_threads').countDocuments({ status: 'running', reservedMicroUsd: { $gt: 0 } })) === 1);
    // handlers/locations.ts removeLocation: the location's research first, then the location.
    await stores.researchLocations.removeForLocation(t.scope, locationId);
    await server.connection.collection('tw_locations').deleteOne({ _id: new Types.ObjectId(locationId) });
    release();
    await r.settled();
    for (const name of ['tw_location_research_runs', 'tw_location_research_threads', 'tw_location_events', 'tw_location_entities']) {
      expect(await server.connection.collection(name).countDocuments({})).toBe(0);
    }
    // Its reservation was settled to what the thread cost.
    const cost = messageCostMicroUsd(gathered()) + messageCostMicroUsd(answer());
    expect(await stores.chatUsage.researchMicroUsd(t.scope, MONTH)).toBe(cost);
  });

  it('a location whose place changed before the merge ends `off` and writes nothing', async () => {
    const t = await tenant();
    const [locationId = ''] = t.locationIds;
    const created = await locationRun(t, locationId);
    const crashing = { ...stores, locations: { ...stores.locations, find: async (scope: OrgScope, id: string) => {
      const found = await stores.locations.find(scope, id);
      return found === null ? null : { ...found, placeId: 'place-elsewhere' };
    } } };
    await run(runner(answering().model, { stores: crashing }));
    expect(await stores.researchLocations.findRun(t.scope, created.id)).toMatchObject({ status: 'off', code: 'place_changed' });
    expect(await server.connection.collection('tw_location_events').countDocuments({})).toBe(0);
  });

  it('a place changed while the merge writes: the rows of the old place go and the run ends `off`', async () => {
    const t = await tenant();
    const [locationId = ''] = t.locationIds;
    const created = await locationRun(t, locationId);
    // The change lands mid-merge, after the merge's first check: its own cleanup ran before this insert.
    const moving = { ...stores, researchLocations: { ...stores.researchLocations, insertEvent: async (...args: Parameters<TownwiseStores['researchLocations']['insertEvent']>) => {
      await server.connection.collection('tw_locations').updateOne({ _id: new Types.ObjectId(locationId) }, { $set: { placeId: 'place-elsewhere' } });
      return stores.researchLocations.insertEvent(...args);
    } } };
    await run(runner(answering().model, { stores: moving }));
    expect(await stores.researchLocations.findRun(t.scope, created.id)).toMatchObject({ status: 'off', code: 'place_changed' });
    expect(await server.connection.collection('tw_location_events').countDocuments({})).toBe(0);
    expect(await server.connection.collection('tw_location_entities').countDocuments({})).toBe(0);
  });

  it('a location deleted before its merge leaves no run or thread behind (the late-writer rule)', async () => {
    const t = await tenant();
    const [locationId = ''] = t.locationIds;
    const created = await locationRun(t, locationId);
    // The thread ended, then the location went with both research sweeps done before a tick's run and thread landed.
    await server.connection.collection('tw_location_research_threads').updateMany({}, { $set: { status: 'empty', code: 'no_sources', finishedAt: clock } });
    await server.connection.collection('tw_location_research_runs').updateOne({ _id: new Types.ObjectId(created.id) }, { $set: { status: 'running' } });
    await server.connection.collection('tw_locations').deleteOne({ _id: new Types.ObjectId(locationId) });
    await runner(answering().model, { lanes: 0 }).plan();
    for (const name of ['tw_location_research_runs', 'tw_location_research_threads']) {
      expect(await server.connection.collection(name).countDocuments({})).toBe(0);
    }
  });

  it('a merge whose lease another merge took over stops writing and ends nothing', async () => {
    const created = await townRun();
    const takenOver = { ...stores, researchTowns: { ...stores.researchTowns, insertEvent: async (...args: Parameters<TownwiseStores['researchTowns']['insertEvent']>) => {
      const inserted = await stores.researchTowns.insertEvent(...args);
      // It stalled past its lease, and the sweep handed the merge to another owner.
      await server.connection.collection('tw_town_research_runs').updateOne({ _id: new Types.ObjectId(created.id) }, { $set: { mergeOwner: 'other-replica' } });
      return inserted;
    } } };
    await run(runner(answering().model, { stores: takenOver }));
    expect(await stores.researchTowns.findRun(created.id)).toMatchObject({ status: 'merging' });
    expect(lines('townwise.research_merge_lost')).toHaveLength(1);
    expect(lines('townwise.research_run')).toHaveLength(0);
    // Found is kept for the merge that holds the run now.
    expect((await stores.researchTowns.threadsOf(created.id)).every((thread) => thread.found !== null)).toBe(true);
  });

  it('a location run merged before its town’s run shows the event once: the town’s view, with both runs’ sources', async () => {
    const t = await tenant();
    const [locationId = ''] = t.locationIds;
    await locationRun(t, locationId);
    await run(runner(answering().model));
    expect(await stores.researchLocations.events(t.scope, locationId)).toHaveLength(1);
    const town = await townRun();
    const otherPage = 'https://news.sentinel-valley.example.com/lantern';
    const townGathered = message([
      webSearch('s1'), webResults('s1', [otherPage]), citedQuotes(`EVENT: ${TITLE}, January 16, 2027.`, [{ url: otherPage, quote: QUOTE }]),
    ], { usage: { input: 4_000, output: 600, searches: 1 } });
    await run(runner(answering({ gather: () => ({ kind: 'message', message: townGathered }) }).model));
    expect(await stores.researchTowns.findRun(town.id)).toMatchObject({ status: 'done', counts: { added: 1 } });
    const location = await stores.locations.find(t.scope, locationId);
    if (location === null) throw new Error('fixture location missing');
    const found = await researchedEventsFor(server.ctx, t.scope, location, { from: '2027-01-01', to: '2027-01-31' });
    expect(found).toHaveLength(1);
    expect(found?.[0]?.id.startsWith('t-')).toBe(true);
    expect(found?.[0]?.sources.map((source) => source.url).sort()).toEqual([PAGE_A, otherPage].sort());
  });

  it('a location run waits to merge while its town’s run is under way, then merges after it and stores no copy', async () => {
    const t = await tenant();
    const [locationId = ''] = t.locationIds;
    // The town's run has started, its thread not due for an hour.
    const town = await stores.researchTowns.insertRun({ townKey: 'hanover-nh', key: `w:${randomUUID()}`, threads: ['schools'], now: clock });
    if (town === null) throw new Error('no run');
    await stores.researchTowns.insertThreads(town, [{ thread: 'schools', notBefore: new Date(NOW.getTime() + 3_600_000) }], clock);
    await server.connection.collection('tw_town_research_runs').updateOne({ _id: new Types.ObjectId(town.id) }, { $set: { status: 'running', startedAt: clock } });
    const own = await locationRun(t, locationId);
    await run(runner(answering().model));
    expect((await stores.researchLocations.findRun(t.scope, own.id))?.status).toBe('running');
    expect(await stores.researchLocations.events(t.scope, locationId)).toHaveLength(0);
    clock = new Date(NOW.getTime() + 2 * 3_600_000);
    await run(runner(answering().model));
    expect((await stores.researchTowns.findRun(town.id))?.status).toBe('done');
    await runner(answering().model, { lanes: 0 }).plan();
    expect(await stores.researchLocations.findRun(t.scope, own.id)).toMatchObject({ status: 'done', counts: { added: 0 } });
    expect(await stores.researchLocations.events(t.scope, locationId)).toHaveLength(0);
    expect(await stores.researchTowns.events('hanover-nh')).toHaveLength(1);
  });

  it('merges a location run into the location’s rows, stamped with its place and town', async () => {
    const t = await tenant();
    const [locationId = ''] = t.locationIds;
    const created = await locationRun(t, locationId, ['neighborhood', 'competitors']);
    await run(runner(answering().model));
    expect(await stores.researchLocations.findRun(t.scope, created.id)).toMatchObject({ status: 'done', counts: { added: 1 } });
    const [event] = await stores.researchLocations.events(t.scope, locationId);
    expect(event).toMatchObject({ title: TITLE, placeId: `place-${locationId}`, town: 'hanover-nh', origin: 'neighborhood' });
  });
});

describe('the runner: budgets', () => {
  it('a three-location organization’s automatic research stops at its share, while Research now may go on', async () => {
    const t = await tenant({ locations: ['Room A', 'Room B', 'Room C'] });
    for (const locationId of t.locationIds) await locationRun(t, locationId);
    // About $3 a thread: past the $6 share once one more thread's ceiling is added.
    const big = { gather: () => ({ kind: 'message' as const, message: gathered({ output: 100_000 }) }), extract: () => ({ kind: 'message' as const, message: answer({ output: 50_000 }) }) };
    const cost = messageCostMicroUsd(gathered({ output: 100_000 })) + messageCostMicroUsd(answer({ output: 50_000 }));
    expect(cost).toBeGreaterThan(2_500_000);
    const { model, calls } = answering(big);
    await run(runner(model));
    expect(calls).toHaveLength(2);
    const statuses = await server.connection.collection('tw_location_research_threads').find({}).sort({ _id: 1 }).toArray();
    expect(statuses.map((thread) => thread.status as string)).toEqual(['recorded', 'budget', 'budget']);
    expect(await stores.chatUsage.researchMicroUsd(t.scope, MONTH)).toBe(cost);
    // Research now is not held to the share.
    const [first = ''] = t.locationIds;
    await server.connection.collection('tw_location_research_runs').updateMany({}, { $set: { status: 'done' }, $unset: { liveSubject: '' } });
    await locationRun(t, first, ['neighborhood'], 'press');
    await run(runner(model));
    expect(calls).toHaveLength(4);
  });
});

describe('the runner: privacy', () => {
  it('logs hold ids, codes and counts: no title, URL, query or name', async () => {
    await townRun();
    const t = await tenant({ name: 'Qwertyp Holdings', locations: ['Zyxwvut Kitchen'] });
    await locationRun(t, t.locationIds[0] ?? '');
    await run(runner(answering().model));
    const all = server.logs.join('\n');
    for (const secret of ['Lantern', 'Sentinel Green', 'sentinel-college', 'sentinel-town', 'Sentinel-query', 'Zyxwvut', 'Qwertyp']) expect(all).not.toContain(secret);
    expect(lines('townwise.research_thread').length).toBeGreaterThan(0);
  });

  async function sentinelRequests(placesToAi: boolean): Promise<string[]> {
    const t = await tenant({ name: 'Qwertyp Holdings', locations: ['Zyxwvut Kitchen'] });
    const [locationId = ''] = t.locationIds;
    await server.connection.collection('tw_research_revisions').insertOne({
      orgId: new Types.ObjectId(t.orgId), locationId: new Types.ObjectId(locationId), eventId: 'l-0123456789abcdef01234567', op: 'edit',
      fields: { title: 'Zyxwvut private party', start: '2027-01-16', end: '2027-01-16', weekdays: null, startTime: null, where: 'Qwertyp room' },
      reverts: null, basedOn: 'base', by: { kind: 'person', userId: 'user-0001' }, createdAt: clock,
    });
    await locationRun(t, locationId, ['neighborhood', 'competitors']);
    const { model, calls } = answering();
    await run(runner(model, {
      config: { ...CONFIG, researchPlacesToAi: placesToAi },
      profile: () => Promise.resolve(PROFILE), competitors: () => Promise.resolve(RIVALS),
    }));
    expect(calls).toHaveLength(4);
    return calls.map((call) => JSON.stringify(call));
  }

  it('with Google names not allowed, the typed name goes only as restaurant.name, and no Google content goes at all', async () => {
    const bodies = await sentinelRequests(false);
    for (const body of bodies) {
      for (const secret of ['Qwertyp', 'Zyxwvut private party', ...GOOGLE_CONTENT]) expect(body).not.toContain(secret);
    }
    const gathers = bodies.filter((_body, index) => index % 2 === 0);
    for (const body of gathers) {
      const params = JSON.parse(body) as { messages: { content: string }[] };
      const user = JSON.parse(params.messages[0]?.content ?? '{}') as { restaurant?: unknown };
      expect(user.restaurant).toEqual({ name: 'Zyxwvut Kitchen' });
      expect(body.split('Zyxwvut').length - 1).toBe(1);
    }
    for (const body of bodies.filter((_body, index) => index % 2 === 1)) expect(body).not.toContain('Zyxwvut');
  });

  it('with Google names allowed, Google’s name and address go instead, and the typed name never', async () => {
    const bodies = await sentinelRequests(true);
    for (const body of bodies) for (const secret of ['Qwertyp', 'Zyxwvut']) expect(body).not.toContain(secret);
    expect(bodies[0]).toContain('Fixture Google Bistro');
    expect(bodies[0]).toContain('1 Fixture Lane');
  });
});

describe('the runner: competitors (design decision 10)', () => {
  /** The gather requests' user messages. */
  const usersOf = (calls: BetaMessageStreamParams[]) => calls.filter((call) => call.tools !== undefined)
    .map((call) => JSON.parse(typeof call.messages[0]?.content === 'string' ? call.messages[0].content : '{}') as Record<string, unknown>);

  /** Every research document of the tenant collections, as text. */
  async function storedText(): Promise<string> {
    const names = ['tw_location_research_runs', 'tw_location_research_threads', 'tw_location_events', 'tw_location_entities'];
    const docs = await Promise.all(names.map((name) => server.connection.collection(name).find({}).toArray()));
    return JSON.stringify(docs);
  }

  it('with Google names not allowed, Google is never asked, and a competitor event is stored with its business entity', async () => {
    const t = await tenant({ locations: ['Zyxwvut Kitchen'] });
    const [locationId = ''] = t.locationIds;
    const created = await locationRun(t, locationId, ['competitors']);
    let asked = 0;
    const { model, calls } = answering({ extract: () => ({ kind: 'message', message: competitorAnswer(null) }) });
    await run(runner(model, {
      profile: () => { asked += 1; return Promise.resolve(PROFILE); },
      competitors: () => { asked += 1; return Promise.resolve(RIVALS); },
    }));
    expect(asked).toBe(0);
    expect(calls).toHaveLength(2);
    for (const body of calls.map((call) => JSON.stringify(call))) for (const secret of GOOGLE_CONTENT) expect(body).not.toContain(secret);
    const [user] = usersOf(calls);
    expect(user?.restaurant).toEqual({ name: 'Zyxwvut Kitchen' });
    expect(user).not.toHaveProperty('competitors');
    expect(user?.focus).toContain('Name each business');
    expect(await stores.researchLocations.findRun(t.scope, created.id)).toMatchObject({ status: 'done', counts: { added: 1 } });
    const [event] = await stores.researchLocations.events(t.scope, locationId);
    const [business] = await stores.researchLocations.entities(t.scope, locationId);
    expect(business).toMatchObject({ type: 'business', name: 'Sentinel Tavern', nameKey: 'sentinel tavern' });
    expect(event).toMatchObject({ title: 'Sentinel Trivia Night', origin: 'competitor', competitorEntityId: business?.id, competitorPlaceId: null, hostId: business?.id });
  });

  it('an event the competitors thread found at the restaurant itself is stored as its own, not a competitor’s', async () => {
    const t = await tenant({ locations: ['Sentinel Tavern'] });
    const [locationId = ''] = t.locationIds;
    await locationRun(t, locationId, ['competitors']);
    await run(runner(answering({ extract: () => ({ kind: 'message', message: competitorAnswer(null) }) }).model));
    const [event] = await stores.researchLocations.events(t.scope, locationId);
    expect(event).toMatchObject({ title: 'Sentinel Trivia Night', origin: 'neighborhood', competitorEntityId: null, competitorPlaceId: null });
  });

  it('with Google names allowed, the list goes in the request, and an event naming a competitor keeps its place id and nothing else of Google’s', async () => {
    const t = await tenant({ locations: ['Zyxwvut Kitchen'] });
    const [locationId = ''] = t.locationIds;
    await locationRun(t, locationId, ['competitors']);
    const { model, calls } = answering({ extract: () => ({ kind: 'message', message: competitorAnswer(2) }) });
    await run(runner(model, {
      config: { ...CONFIG, researchPlacesToAi: true }, profile: () => Promise.resolve(PROFILE), competitors: () => Promise.resolve(RIVALS),
    }));
    expect(calls).toHaveLength(2);
    const [user] = usersOf(calls);
    expect(user?.restaurant).toEqual(PROFILE);
    expect(user?.competitors).toEqual([
      { n: 1, name: 'Fixture Rival Cafe', type: 'cafe', website: null },
      { n: 2, name: 'Fixture Rival Tavern', type: 'bar', website: 'https://rival.example.com/' },
    ]);
    expect(user?.focus).toContain('listed in the request');
    const [event] = await stores.researchLocations.events(t.scope, locationId);
    const [business] = await stores.researchLocations.entities(t.scope, locationId);
    expect(event).toMatchObject({ origin: 'competitor', competitorEntityId: business?.id, competitorPlaceId: 'ChIJFixtureRival0002' });
    // Merged: the kept list is cleared with the thread's findings, and no name, address or website of Google's is stored.
    const stored = await storedText();
    for (const secret of GOOGLE_CONTENT) expect(stored).not.toContain(secret);
    expect(stored).not.toContain('ChIJFixtureRival0001');
  });

  it('with Google names allowed and no profile, the restaurant’s threads end `places_off` with no call', async () => {
    const t = await tenant();
    const [locationId = ''] = t.locationIds;
    const created = await locationRun(t, locationId, ['neighborhood', 'competitors']);
    const { model, calls } = answering();
    await run(runner(model, { config: { ...CONFIG, researchPlacesToAi: true }, profile: () => Promise.resolve(null), competitors: () => Promise.resolve(RIVALS) }));
    expect(calls).toHaveLength(0);
    const threads = await stores.researchLocations.threadsOf(t.scope, created.id);
    expect(threads.map((thread) => [thread.status, thread.code])).toEqual([['empty', 'places_off'], ['empty', 'places_off']]);
    expect(await stores.researchLocations.findRun(t.scope, created.id)).toMatchObject({ status: 'done' });
  });

  it('with Google names allowed, a profile and no competitors list, the competitors thread searches the web', async () => {
    const t = await tenant();
    const [locationId = ''] = t.locationIds;
    await locationRun(t, locationId, ['competitors']);
    const { model, calls } = answering({ extract: () => ({ kind: 'message', message: competitorAnswer(null) }) });
    await run(runner(model, { config: { ...CONFIG, researchPlacesToAi: true }, profile: () => Promise.resolve(PROFILE), competitors: () => Promise.resolve(null) }));
    const [user] = usersOf(calls);
    expect(user?.restaurant).toEqual(PROFILE);
    expect(user).not.toHaveProperty('competitors');
    expect(user?.focus).toContain('Name each business');
    const [event] = await stores.researchLocations.events(t.scope, locationId);
    expect(event).toMatchObject({ origin: 'competitor', competitorPlaceId: null });
  });
});

describe('the runner: its start gate (design decision 1)', () => {
  it('runs only with research, an Anthropic key and TownwiseAI’s web search all on', () => {
    for (const research of [true, false]) {
      for (const chatWebSearch of [true, false]) {
        for (const anthropicKey of [true, false]) {
          expect(researchRuns({ research, chatWebSearch, anthropicKey })).toBe(research && chatWebSearch && anthropicKey);
        }
      }
    }
  });

  it('main.ts builds the runner only behind the gate and the chat model, starts it, and stops it on shutdown', () => {
    const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    expect(main).toMatch(/const researchRunner = chat === undefined\s*\|\| !researchRuns\(\{ research: resolvedConfig\.research, chatWebSearch: resolvedConfig\.chatWebSearch, anthropicKey: true \}\)\s*\? undefined/);
    expect(main).toContain('researchRunner?.start();');
    expect(main.slice(main.indexOf('onShutdown: ['))).toContain('...(researchRunner === undefined ? [] : [researchRunner])');
  });
});
