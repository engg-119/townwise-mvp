// The research runner (D66, openspec change town-research-agent, design decisions 1, 6, 7 and 8): leased lanes in each
// API replica, beside the file reader and the calendar refresher and shaped like them, so it can move to a job
// unchanged. main.ts starts it only while TOWNWISE_RESEARCH, ANTHROPIC_API_KEY and TOWNWISE_CHAT_WEB_SEARCH are all set.
//
// Each of RESEARCH_LANES lanes claims a queued thread (town and location threads alternate, the one due first; an
// organization has at most one live location thread), checks its subject, reserves the thread's ceiling (budget.ts) by
// compare-and-set (a town's against the system month and its town's slice; a location's against its organization's
// TownwiseAI month, held for an automatic run to its share and $5 of headroom), runs it (call.ts runThread) under a
// 90-second lease whose 30-second heartbeat writes the spend tally, settles the reservation to what it cost, and ends
// the thread recorded, empty, budget or failed (a retryable failure waits 10 minutes; a thread is tried at most twice).
// A missed heartbeat (the thread was ended by a place change, a deletion or a reclaim) aborts the call: the lane
// settles (unless a reclaim already did) and writes nothing else. A graceful shutdown aborts the calls, settles and puts
// the threads back with the attempt counted; a thread claimed while shutting down, before its call, goes back with the
// attempt not counted. A dead replica's thread is reclaimed by the stale sweep, which charges its last written tally
// plus 30 seconds of streaming at the ceiling rate and refunds the rest.
//
// The lane that ends a run's last thread claims its merge (the fast path); the planner's sweep (plan.ts) claims any run
// that lane missed. The merge (merge.ts planMerge, applied here) is the only writer of researched events and entities.
// It renews its merge lease before each write and stops at a miss (the run ended, or its lease passed and another merge
// took it over), so two merges of a run never write side by side. A location's first checks that the location still
// has the run's place and town and that its organization is active (else the run ends `off` and nothing is written; a
// location deleted meanwhile has its research rows removed, the late-writer rule), and after its writes checks the
// location again: deleted meanwhile, its rows go; its place or town changed meanwhile, the rows of any other place or
// town go, as the change's own cleanup does. Then retention, the run ended with its counts, and only then `found`
// cleared, so a merge replayed after a crash still counts what it found.
//
// It reads the research stores for the prompts' base values only, never a revision (test/isolation.test.ts): a member's
// edit never reaches Anthropic. Google is asked (the restaurant's profile, its competitors: research/places.ts) only
// while TOWNWISE_RESEARCH_PLACES_TO_AI lets Google's names go to Anthropic (production since the owner's go of
// 2026-11-19); with it off (the code default) the restaurant is named by the
// location's own typed name and competitors are found on the web, and nothing Google answered is sent (decision 10).
// With it on and no profile (Places off, Google failing, a place it doesn't know), the restaurant's two threads end
// `empty` with `places_off` and no call, since the typed name is not sent then; with a profile and no competitors list,
// the competitors thread searches the web. Logs carry ids, codes and counts: never a title, a URL, a query or a name.
import { randomUUID } from 'node:crypto';

import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { scopeForResearch, type OrgScope } from '../access/policy.ts';
import type { ChatModel } from '../chat/model.ts';
import { ceilingCostMicroUsd } from '../chat/pricing.ts';
import type { ResolvedTownwiseConfig } from '../config.ts';
import { utcDay } from '../dates.ts';
import {
  claimLocationResearchMerge, claimNextLocationResearchThread, researchTownsInUse, staleLocationResearchThreads,
} from '../stores/cross-tenant.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { LocationRunRecord } from '../stores/research-locations.ts';
import type {
  EntityRecordBase, EventRecordBase, RunCounts, RunRecordBase, StoredDrops, ThreadEnd, ThreadRecordBase, ThreadTallyWrite,
} from '../stores/research-shared.ts';
import { timeZoneOf } from '../time-zones.ts';
import { townEvents } from '../town-calendar.ts';
import type { Town, TownId } from '../towns.ts';
import { GATHER_MAX_TOKENS, reserveMicroUsd, threadLimits } from './budget.ts';
import { createThreadTally, RESEARCH_REQUEST_MS, runThread, type FetchSwitch, type ThreadOutcome } from './call.ts';
import { competitorInputs, placesByN, type Competitor } from './competitors.ts';
import { nameKey } from './dedupe.ts';
import { planMerge, type MergeInput, type MergePlan, type StoredEvent, type ThreadFound } from './merge.ts';
import { isTownId, MERGE_LEASE_MS, planTick, townOf, townStamp, type ClaimedMerge, type PlanContext, type PlanCounts } from './plan.ts';
import {
  gatherPrompt, knownRows, namedAfterTown, promptTown, restaurantFor, seedsFrom, type GatherInput, type RestaurantProfile, type StoredBaseRow,
} from './prompt.ts';
import { researchWindow, threadDef, type ThreadDef } from './threads.ts';

const MINUTE = 60_000;
const DAY_MS = 86_400_000;
export const RESEARCH_LANES = 2;
export const PER_ORG_LIVE = 1;
export const RESEARCH_MAX_ATTEMPTS = 2;
/** The wait after a failed attempt that may be retried; with at most 2 attempts only the first attempt is ever retried. */
export const RESEARCH_RETRY_WAITS_MS: readonly number[] = [10 * MINUTE];
/**
 * How long a town thread whose reservation the month or its slice refused waits while another town thread's reservation
 * is in flight (second UI review): that one settles to far less within minutes, so this one is tried again rather than
 * ended `budget`.
 */
export const BUDGET_WAIT_MS = MINUTE;
export const RESEARCH_LEASE_MS = 90_000;
export const RESEARCH_HEARTBEAT_MS = 30_000;
/** What an automatic location thread leaves of the TownwiseAI month: $5. */
export const AUTOMATIC_HEADROOM_MICRO_USD = 5_000_000;
export const STALE_GRACE_MS = 30_000;
export const RETENTION_DAYS = 400;
export const ENTITY_UNSEEN_DAYS = 365;
const POLL_MS = 30_000;
const PLAN_DELAY_MS = 60_000;
const PLAN_EVERY_MS = 15 * MINUTE;

/** 30 seconds of a gather's output streamed at its ceiling rate (GATHER_MAX_TOKENS over a request's time limit), priced at the ceiling. */
export function staleGraceMicroUsd(): number {
  const tokens = Math.ceil(GATHER_MAX_TOKENS * STALE_GRACE_MS / RESEARCH_REQUEST_MS);
  return ceilingCostMicroUsd({ input: 0, output: tokens, cacheRead: 0, cacheWrite: 0 });
}

export interface ResearchRunnerDeps {
  readonly connection: Connection;
  readonly stores: TownwiseStores;
  readonly logger: Logger;
  readonly now: () => Date;
  readonly model: ChatModel;
  readonly config: Pick<
    ResolvedTownwiseConfig,
    'chatMonthlyBudgetUsd' | 'researchTownMonthlyUsd' | 'researchOrgMonthlyUsd' | 'researchWebFetch' | 'researchPlacesToAi'
  >;
  /**
   * The restaurant's Google profile (Place Details name and address), live and never stored; asked for only while
   * Google's names may go to Anthropic. Absent or null then, the restaurant's threads end `places_off`.
   */
  readonly profile?: (placeId: string) => Promise<RestaurantProfile | null>;
  /**
   * The restaurant's competitors (research/competitors.ts), live and never stored but their place ids; asked for only
   * by the competitors thread while Google's names may go to Anthropic. Absent, null or empty, it searches the web.
   */
  readonly competitors?: (placeId: string) => Promise<readonly Competitor[] | null>;
  /** This replica's name in leases; a random one when absent. */
  readonly owner?: string;
  readonly lanes?: number;
  readonly pollMs?: number;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly planDelayMs?: number;
  readonly planEveryMs?: number;
  readonly retryWaitsMs?: readonly number[];
  /** Tests shorten the calls' time limits. */
  readonly callLimits?: { readonly requestMs: number; readonly threadMs: number };
}

export interface ResearchRunner {
  readonly name: string;
  start(): void;
  /** Look for threads now. */
  nudge(): void;
  /** One planner tick now: the stale sweep, the week's runs, the merge sweep. */
  plan(): Promise<PlanCounts>;
  /** Resolves when no lane has work left it can claim and no plan is running (tests). */
  settled(): Promise<void>;
  close(): Promise<void>;
}

/** A claimed thread with the moves its subject's store makes. */
interface Job {
  readonly subject: 'town' | 'location';
  readonly thread: ThreadRecordBase;
  readonly owner: string;
  readonly townKey: TownId | null;
  readonly scope: OrgScope | null;
  readonly locationId: string | null;
  readonly ids: Record<string, string>;
  findRun(): Promise<RunRecordBase | null>;
  /** The thread's row as it is now; null once deleted. */
  findThread(): Promise<ThreadRecordBase | null>;
  markRunning(now: Date): Promise<boolean>;
  reserveThread(input: { reservedMicroUsd: number; month: string }): Promise<boolean>;
  heartbeat(input: ThreadTallyWrite & { now: Date; leaseMs: number }): Promise<boolean>;
  finish(end: ThreadEnd): Promise<boolean>;
  requeue(input: ThreadTallyWrite & { notBefore: Date; code: string | null }): Promise<boolean>;
  /** Back in the queue with the attempt not counted, due at `notBefore` when given. */
  release(notBefore?: Date): Promise<boolean>;
  /** Whether another thread's reservation is in flight against the same money (town threads only; a location's never stack). */
  othersReserving(): Promise<boolean>;
}

/** A merge whose lease another took over, or whose run ended meanwhile: it stops writing. */
class MergeLost extends Error {
  override name = 'MergeLost';
}

const NO_DROPS: StoredDrops = {
  events: { bad_shape: 0, over_cap: 0, no_source: 0, unknown_source: 0, bad_dates: 0, bad_title: 0, bad_competitor: 0 },
  entities: { bad_shape: 0, over_cap: 0, bad_ref: 0, bad_name: 0, no_source: 0 },
};

const sum = (counts: Readonly<Record<string, number>>): number => Object.values(counts).reduce((total, n) => total + n, 0);
const errType = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');

export function createResearchRunner(deps: ResearchRunnerDeps): ResearchRunner {
  const { connection, stores, logger, now, config } = deps;
  const replica = deps.owner ?? randomUUID();
  const lanes = deps.lanes ?? RESEARCH_LANES;
  const leaseMs = deps.leaseMs ?? RESEARCH_LEASE_MS;
  const heartbeatMs = deps.heartbeatMs ?? RESEARCH_HEARTBEAT_MS;
  const waits = deps.retryWaitsMs ?? RESEARCH_RETRY_WAITS_MS;
  const fetchSwitch: FetchSwitch = { on: config.researchWebFetch };
  const closing = new AbortController();
  /** Read through a call, so a check after an await is not narrowed by one before it. */
  const shuttingDown = (): boolean => closing.signal.aborted;
  const planContext: PlanContext = { connection, stores, logger, now, config };
  let stopped = false;
  let preferTown = true;
  const running = new Set<Promise<void>>();
  let planning: Promise<PlanCounts> | null = null;
  let poll: NodeJS.Timeout | undefined;
  let planTimer: NodeJS.Timeout | undefined;
  let planEvery: NodeJS.Timeout | undefined;

  // ---- Claiming ------------------------------------------------------------------------------------------------------

  function townJob(thread: ThreadRecordBase & { townKey: TownId }, owner: string): Job {
    const store = stores.researchTowns;
    return {
      subject: 'town', thread, owner, townKey: thread.townKey, scope: null, locationId: null,
      ids: { townKey: thread.townKey, runId: thread.runId, threadId: thread.id },
      findRun: () => store.findRun(thread.runId),
      findThread: async () => (await store.threadsOf(thread.runId)).find((each) => each.id === thread.id) ?? null,
      markRunning: (at) => store.markRunRunning(thread.runId, at),
      reserveThread: (input) => store.reserveThread(thread.id, owner, input),
      heartbeat: (input) => store.heartbeat(thread.id, owner, input),
      finish: (end) => store.finishThread(thread.id, owner, end),
      requeue: (input) => store.requeueThread(thread.id, owner, input),
      release: (notBefore) => store.releaseThread(thread.id, owner, notBefore),
      othersReserving: () => store.othersReserving(thread.id),
    };
  }

  function locationJob(scope: OrgScope, locationId: string, thread: ThreadRecordBase, owner: string): Job {
    const store = stores.researchLocations;
    return {
      subject: 'location', thread, owner, townKey: null, scope, locationId,
      ids: { orgId: scope.orgId, locationId, runId: thread.runId, threadId: thread.id },
      findRun: () => store.findRun(scope, thread.runId),
      findThread: async () => (await store.threadsOf(scope, thread.runId)).find((each) => each.id === thread.id) ?? null,
      markRunning: (at) => store.markRunRunning(scope, thread.runId, at),
      reserveThread: (input) => store.reserveThread(scope, thread.id, owner, input),
      heartbeat: (input) => store.heartbeat(scope, thread.id, owner, input),
      finish: (end) => store.finishThread(scope, thread.id, owner, end),
      requeue: (input) => store.requeueThread(scope, thread.id, owner, input),
      release: () => store.releaseThread(scope, thread.id, owner),
      // One live location thread an organization (PER_ORG_LIVE), so its reservations never stack.
      othersReserving: () => Promise.resolve(false),
    };
  }

  async function claimTown(owner: string): Promise<Job | null> {
    const thread = await stores.researchTowns.claimThread({ owner, now: now(), leaseMs });
    return thread === null ? null : townJob(thread, owner);
  }

  async function claimLocation(owner: string): Promise<Job | null> {
    const claimed = await claimNextLocationResearchThread(connection, { owner, now: now(), leaseMs, perOrgLive: PER_ORG_LIVE });
    if (claimed === null) return null;
    const scope = scopeForResearch(claimed);
    const thread = (await stores.researchLocations.threadsOf(scope, claimed.runId)).find((each) => each.id === claimed.id);
    // Deleted between the claim and the read (a location's deletion removes its threads first).
    return thread === undefined ? null : locationJob(scope, claimed.locationId, thread, owner);
  }

  /** The next thread, town and location alternating. */
  async function claim(): Promise<Job | null> {
    const owner = `${replica}:${randomUUID()}`;
    const order = preferTown ? [claimTown, claimLocation] : [claimLocation, claimTown];
    preferTown = !preferTown;
    for (const next of order) {
      const job = await next(owner);
      if (job !== null) return job;
    }
    return null;
  }

  // ---- Spend ---------------------------------------------------------------------------------------------------------

  const month = (at: Date): string => at.toISOString().slice(0, 7);

  async function reserve(job: Job, run: RunRecordBase, cost: number, inMonth: string): Promise<boolean> {
    if (job.townKey !== null) {
      const cap = Math.round(config.researchTownMonthlyUsd * 1_000_000);
      const towns = Math.max(1, (await researchTownsInUse(connection)).length);
      return stores.researchSpend.reserve({ month: inMonth, townKey: job.townKey, costMicroUsd: cost, capMicroUsd: cap, sliceMicroUsd: Math.floor(cap / towns) });
    }
    if (job.scope === null) return false;
    const automatic = (run as LocationRunRecord).trigger === 'press'
      ? null
      : { shareMicroUsd: Math.round(config.researchOrgMonthlyUsd * 1_000_000), headroomMicroUsd: AUTOMATIC_HEADROOM_MICRO_USD };
    return stores.chatUsage.reserveResearch(job.scope, inMonth, cost, { budgetMicroUsd: Math.round(config.chatMonthlyBudgetUsd * 1_000_000), automatic }, now());
  }

  /** Adds `delta` (negative to give back) to the month the reservation was made in. */
  async function settle(subject: { townKey: TownId | null; scope: OrgScope | null }, inMonth: string, delta: number): Promise<void> {
    if (delta === 0) return;
    if (subject.townKey !== null) await stores.researchSpend.add({ month: inMonth, townKey: subject.townKey, costMicroUsd: delta });
    else if (subject.scope !== null) await stores.chatUsage.addResearch(subject.scope, inMonth, delta, now());
  }

  // ---- A thread ------------------------------------------------------------------------------------------------------

  type Prepared =
    | {
      readonly kind: 'ready'; readonly input: GatherInput; readonly location: LocationRecord | null;
      /** The competitors' place ids in `n` order, as sent; empty when none were. */
      readonly competitorPlaceIds: readonly string[];
    }
    | { readonly kind: 'end'; readonly status: 'empty' | 'failed'; readonly code: string };

  /** The base values of stored rows a prompt's `known` reads: no revision, never a suppressed row as known. */
  function baseRows(events: readonly (EventRecordBase & { suppressed?: unknown })[], entities: readonly EntityRecordBase[]): StoredBaseRow[] {
    const names = new Map(entities.map((entity) => [entity.id, entity.name]));
    return events.map((event) => ({
      title: event.title, start: event.start, end: event.end, host: event.hostId === null ? null : names.get(event.hostId) ?? null,
      lastRunId: event.lastRunId, suppressed: event.suppressed !== undefined && event.suppressed !== null,
    }));
  }

  /** Whether the location still has the run's place and town, under an active organization with research on. */
  async function locationState(scope: OrgScope, locationId: string, run: { placeId: string | null; town: string }): Promise<
    { readonly kind: 'ok'; readonly location: LocationRecord; readonly orgName: string } | { readonly kind: 'gone'; readonly code: string }
  > {
    const [org, location] = await Promise.all([stores.orgs.findById(scope.orgId), stores.locations.find(scope, locationId)]);
    if (location === null || org === null) return { kind: 'gone', code: 'location_gone' };
    if (org.status !== 'active') return { kind: 'gone', code: 'org_inactive' };
    if (!org.research.on) return { kind: 'gone', code: 'research_off' };
    if (location.placeId !== run.placeId || townStamp(location.town) !== run.town) return { kind: 'gone', code: 'place_changed' };
    return { kind: 'ok', location, orgName: org.name };
  }

  async function prepare(job: Job, run: RunRecordBase): Promise<Prepared> {
    let def: ThreadDef = threadDef(job.thread.thread, { placesToAi: config.researchPlacesToAi });
    const at = now();
    let town: Town;
    let stored: StoredBaseRow[];
    let latestRunId: string | null;
    let location: LocationRecord | null = null;
    let orgName = '';
    if (job.townKey !== null) {
      town = townOf(job.townKey);
      const [events, entities, latest] = await Promise.all([
        stores.researchTowns.events(job.townKey), stores.researchTowns.entities(job.townKey), stores.researchTowns.lastFinishedRun(job.townKey),
      ]);
      stored = baseRows(events, entities);
      latestRunId = latest?.id ?? null;
    } else {
      const scope = job.scope;
      const locationId = job.locationId;
      if (scope === null || locationId === null) return { kind: 'end', status: 'failed', code: 'internal' };
      const state = await locationState(scope, locationId, run as LocationRunRecord);
      if (state.kind === 'gone') return { kind: 'end', status: 'failed', code: state.code };
      location = state.location;
      orgName = state.orgName;
      if (def.namesRestaurant && location.placeId === null) return { kind: 'end', status: 'empty', code: 'no_place' };
      town = location.town;
      const stamp = { placeId: location.placeId, town: townStamp(location.town) };
      const [events, entities, latest] = await Promise.all([
        stores.researchLocations.events(scope, locationId), stores.researchLocations.entities(scope, locationId),
        stores.researchLocations.lastFinishedRun(scope, locationId),
      ]);
      stored = baseRows(events.filter((event) => event.placeId === stamp.placeId && event.town === stamp.town), entities);
      latestRunId = latest?.id ?? null;
    }
    const { timeZone } = timeZoneOf(town);
    const window = researchWindow(at, timeZone);
    const curated = town.townId === null ? [] : townEvents(town.townId, window);
    let restaurant = null;
    let competitors: readonly Competitor[] = [];
    if (def.namesRestaurant && location !== null) {
      const placeId = location.placeId;
      if (!config.researchPlacesToAi) {
        // Nothing Google answered: the location's own typed name (decision 3), and Google is not asked.
        restaurant = restaurantFor(location, null, false, orgName);
      } else if (placeId !== null) {
        const profile = deps.profile === undefined ? null : await deps.profile(placeId);
        if (profile === null) return { kind: 'end', status: 'empty', code: 'places_off' };
        restaurant = restaurantFor(location, profile, true, orgName);
        if (def.id === 'competitors') {
          competitors = (deps.competitors === undefined ? null : await deps.competitors(placeId)) ?? [];
          // No list: the web-search focus, which names no listed competitor.
          if (competitors.length === 0) def = threadDef(def.id, { placesToAi: false });
        }
      }
    }
    return {
      kind: 'ready', location, competitorPlaceIds: competitors.map((competitor) => competitor.placeId),
      input: {
        thread: def, town: promptTown(town), today: window.from, window, known: knownRows({ curated, stored, latestRunId }),
        seeds: seedsFrom(curated), restaurant, competitors: competitors.length === 0 ? null : competitorInputs(competitors),
      },
    };
  }

  function logThread(job: Job, fields: { outcome: string; code: string | null; kept: number; dropped: number; costMicroUsd: number; searches: number; fetches: number; started: number }): void {
    logger.info({
      ...job.ids, subject: job.subject, thread: job.thread.thread, outcome: fields.outcome, code: fields.code, searches: fields.searches,
      fetches: fields.fetches, kept: fields.kept, dropped: fields.dropped, attempts: job.thread.attempts, ms: now().getTime() - fields.started,
      costMicroUsd: fields.costMicroUsd,
    }, 'townwise.research_thread');
  }

  /** Ends the thread with no call made (nothing reserved, nothing spent). */
  async function endWithout(job: Job, status: ThreadEnd['status'], code: string, started: number): Promise<boolean> {
    const ended = await job.finish({ status, code, found: null, drops: null, spentMicroUsd: 0, searches: 0, fetches: 0, now: now() });
    if (ended) logThread(job, { outcome: status, code, kept: 0, dropped: 0, costMicroUsd: 0, searches: 0, fetches: 0, started });
    return ended;
  }

  /** Runs one claimed thread to its end, a requeue, or (lease lost) nothing; true when it ended the thread. */
  async function runJob(job: Job): Promise<boolean> {
    const started = now().getTime();
    // Claimed while this replica shuts down: back in the queue untouched, so a deploy never uses up an attempt.
    if (shuttingDown()) {
      await job.release();
      return false;
    }
    const run = await job.findRun();
    if (run === null || !['queued', 'running'].includes(run.status)) return endWithout(job, 'failed', 'run_ended', started);
    await job.markRunning(now());
    if (job.thread.attempts > RESEARCH_MAX_ATTEMPTS) return endWithout(job, 'failed', 'interrupted', started);
    const prepared = await prepare(job, run);
    if (prepared.kind === 'end') return endWithout(job, prepared.status, prepared.code, started);

    // Shutting down while it prepared: nothing reserved or called yet, so back untouched too.
    if (shuttingDown()) {
      await job.release();
      return false;
    }
    const prompt = gatherPrompt(prepared.input);
    const reserved = reserveMicroUsd(threadLimits(prepared.input.thread, fetchSwitch.on, prompt));
    const inMonth = month(now());
    if (!await reserve(job, run, reserved, inMonth)) {
      // Refused while another town thread's reservation is in flight: it settles to far less (a town thread costs a
      // tenth or less of its reservation), so this one waits a minute, the attempt not counted, rather than ending
      // `budget` for money that was never spent (second UI review). With none in flight the month or slice is spent.
      if (await job.othersReserving() && await job.release(new Date(now().getTime() + BUDGET_WAIT_MS))) {
        logThread(job, { outcome: 'waiting', code: 'budget', kept: 0, dropped: 0, costMicroUsd: 0, searches: 0, fetches: 0, started });
        return false;
      }
      return endWithout(job, 'budget', 'budget', started);
    }
    if (!await job.reserveThread({ reservedMicroUsd: reserved, month: inMonth })) {
      // Ended by someone else meanwhile (a place change, a deletion): give the reservation back.
      await settle(job, inMonth, -reserved);
      return false;
    }

    const tally = createThreadTally(now);
    const lost = new AbortController();
    const heartbeat = setInterval(() => {
      void job.heartbeat({ spentMicroUsd: tally.costMicroUsd(), searches: tally.searches(), fetches: tally.fetches(), now: now(), leaseMs })
        .then((held) => { if (!held) lost.abort(); }, () => undefined);
    }, heartbeatMs);
    let outcome: ThreadOutcome;
    try {
      outcome = await runThread({
        model: deps.model, gather: prepared.input, reservedMicroUsd: reserved, fetch: fetchSwitch, signal: AbortSignal.any([closing.signal, lost.signal]),
        now, tally, onFetchOff: () => { logger.warn({ ...job.ids }, 'townwise.research_fetch_off'); },
        ...(deps.callLimits === undefined ? {} : { limits: deps.callLimits }),
      });
    } finally {
      clearInterval(heartbeat);
    }
    const spent = { spentMicroUsd: outcome.costMicroUsd, searches: outcome.searches, fetches: outcome.fetches };
    const log = (status: string, code: string | null, kept = 0, dropped = 0): void => {
      logThread(job, { outcome: status, code, kept, dropped, ...spent, costMicroUsd: outcome.costMicroUsd, started });
    };
    // The reservation becomes what the thread cost, settled exactly once. After this lane moved its own row (requeue or
    // finish) it is the only one that can. When the row was moved under it, it settles only if the row still holds this
    // attempt's reservation (a place change ended it) or is gone (a deletion); a stale reclaim gave the reservation up
    // in its own write and settled it then. A crash between the move and the settle leaves the month charged the
    // reservation: too much, never too little.
    const settleOwn = (): Promise<void> => settle(job, inMonth, outcome.costMicroUsd - reserved);
    const settleLost = async (): Promise<void> => {
      const row = await job.findThread();
      if (row === null || (row.attempts === job.thread.attempts && row.month === inMonth && row.reservedMicroUsd === reserved)) await settleOwn();
    };

    if (outcome.kind === 'aborted') {
      if (lost.signal.aborted || !closing.signal.aborted) {
        await settleLost();
        log('lost', null);
        return false;
      }
      // A graceful shutdown: back in the queue, the attempt counted.
      if (await job.requeue({ ...spent, notBefore: now(), code: 'interrupted' })) {
        await settleOwn();
        log('requeued', 'interrupted');
      } else {
        await settleLost();
      }
      return false;
    }
    if (outcome.kind === 'failed' && outcome.retry && job.thread.attempts < RESEARCH_MAX_ATTEMPTS) {
      const wait = waits[Math.min(job.thread.attempts, waits.length) - 1] ?? 0;
      if (await job.requeue({ ...spent, notBefore: new Date(now().getTime() + wait), code: outcome.code })) {
        await settleOwn();
        log('retry', outcome.code);
      } else {
        await settleLost();
      }
      return false;
    }
    let end: ThreadEnd;
    let kept = 0;
    let dropped = 0;
    if (outcome.kind === 'recorded') {
      const { verified } = outcome;
      kept = verified.events.length;
      dropped = sum(verified.drops) + sum(verified.entityDrops);
      end = {
        status: 'recorded', code: null, found: { events: verified.events, entities: verified.entities, competitorPlaceIds: prepared.competitorPlaceIds },
        drops: { events: verified.drops, entities: verified.entityDrops }, ...spent, now: now(),
      };
      // A location may have gone or moved while the model searched: what it found is not kept then.
      if (job.scope !== null && job.locationId !== null) {
        const state = await locationState(job.scope, job.locationId, run as LocationRunRecord);
        if (state.kind === 'gone') end = { ...end, status: 'failed', code: state.code, found: null, drops: null };
      }
    } else if (outcome.kind === 'empty') {
      end = { status: 'empty', code: outcome.code, found: null, drops: NO_DROPS, ...spent, now: now() };
    } else {
      end = { status: 'failed', code: outcome.code, found: null, drops: null, ...spent, now: now() };
    }
    if (!await job.finish(end)) {
      await settleLost();
      log('lost', null);
      return false;
    }
    await settleOwn();
    log(end.status, end.code, end.status === 'recorded' ? kept : 0, dropped);
    return true;
  }

  /** After a thread ended: the merge's fast path, when it was the run's last. */
  async function mergeIfLast(job: Job): Promise<void> {
    const owner = `${replica}:merge:${randomUUID()}`;
    if (job.townKey !== null) {
      if (await stores.researchTowns.claimMerge({ runId: job.thread.runId, owner, now: now(), leaseMs: MERGE_LEASE_MS })) {
        await merge({ kind: 'town', runId: job.thread.runId, owner });
      }
      return;
    }
    const claimed = await claimLocationResearchMerge(connection, { runId: job.thread.runId, owner, now: now(), leaseMs: MERGE_LEASE_MS });
    if (claimed !== null) await merge({ kind: 'location', scope: scopeForResearch(claimed), runId: claimed.runId, locationId: claimed.locationId, owner });
  }

  // ---- The merge -----------------------------------------------------------------------------------------------------

  function storedEvents(events: readonly EventRecordBase[], entities: readonly EntityRecordBase[]): StoredEvent[] {
    const keys = new Map(entities.map((entity) => [entity.id, entity.nameKey]));
    return events.map((event) => ({
      id: event.id, title: event.title, start: event.start, end: event.end, category: event.category, status: event.status,
      confidence: event.confidence, sources: event.sources, seenCount: event.seenCount, lastRunId: event.lastRunId,
      venueKey: event.venueId === null ? null : keys.get(event.venueId) ?? null,
    }));
  }

  /** The run's end from its threads: done when every thread recorded or found nothing, partial when some did, else budget or failed. */
  function runStatus(threads: readonly ThreadRecordBase[]): 'done' | 'partial' | 'budget' | 'failed' {
    const ok = threads.filter((thread) => thread.status === 'recorded' || thread.status === 'empty').length;
    if (ok === threads.length) return 'done';
    if (ok > 0) return 'partial';
    return threads.every((thread) => thread.status === 'budget') ? 'budget' : 'failed';
  }

  function foundOf(threads: readonly ThreadRecordBase[]): ThreadFound[] {
    return threads.flatMap((thread) => (thread.status === 'recorded' && thread.found !== null
      ? [{ thread: thread.thread, events: thread.found.events, entities: thread.found.entities }]
      : []));
  }

  /**
   * The run's counts. A merge replayed after a crash before its run ended finds its own earlier writes stored (rows whose
   * `lastRunId` is this run), which the plan leaves out, so they are counted here: added when this run inserted them,
   * else updated.
   */
  function countsOf(
    runId: string, threads: readonly ThreadRecordBase[], stored: readonly EventRecordBase[],
    plan: MergePlan,
  ): RunCounts {
    const verifyDrops = threads.reduce((total, thread) => total + (thread.drops === null ? 0 : sum(thread.drops.events)), 0);
    const planned = new Set(plan.updates.map((update) => update.id));
    const earlier = stored.filter((event) => event.lastRunId === runId && !planned.has(event.id));
    const added = earlier.filter((event) => event.firstRunId === runId).length;
    return {
      found: plan.found, added: plan.inserts.length + added, updated: planned.size + earlier.length - added, dropped: sum({ ...plan.drops }) + verifyDrops,
    };
  }

  const retention = (at: Date) => ({
    endedBefore: utcDay(at, -RETENTION_DAYS), unseenBefore: new Date(at.getTime() - ENTITY_UNSEEN_DAYS * DAY_MS),
    createdBefore: new Date(at.getTime() - RETENTION_DAYS * DAY_MS),
  });

  /** Renews the merge lease before a write; throws MergeLost once the run ended or another merge took it over. */
  function holder(hold: (input: { owner: string; now: Date; leaseMs: number }) => Promise<boolean>, owner: string): () => Promise<void> {
    return async () => {
      if (!await hold({ owner, now: now(), leaseMs: MERGE_LEASE_MS })) throw new MergeLost();
    };
  }

  /** Merges a claimed town run; answers its town once the merge ran to its end, else null. */
  async function mergeTown(runId: string, owner: string): Promise<TownId | null> {
    const store = stores.researchTowns;
    const run = await store.findRun(runId);
    if (run?.status !== 'merging') return null;
    const held = holder((input) => store.holdMerge(runId, input), owner);
    const townKey = run.townKey;
    const at = now();
    const threads = await store.threadsOf(runId);
    const [events, entities] = await Promise.all([store.events(townKey), store.entities(townKey)]);
    const window = researchWindow(at, timeZoneOf(townOf(townKey)).timeZone);
    const input: MergeInput = {
      runId, subject: 'town', found: foundOf(threads), stored: storedEvents(events, entities),
      storedEntities: entities.map((entity) => ({ id: entity.id, type: entity.type, nameKey: entity.nameKey })),
      curated: townEvents(townKey, window), townRows: [], competitorPlaces: null, ownNames: [],
    };
    const plan = planMerge(input);
    const ids = new Map<string, string>();
    for (const entity of plan.entities) {
      await held();
      ids.set(`${entity.key.type}|${entity.key.nameKey}`, await store.upsertEntity(townKey, { type: entity.key.type, name: entity.name, nameKey: entity.key.nameKey, sources: entity.sources, now: at }));
    }
    const idOf = (key: { type: string; nameKey: string } | null): string | null => (key === null ? null : ids.get(`${key.type}|${key.nameKey}`) ?? null);
    for (const insert of plan.inserts) {
      await held();
      await store.insertEvent(townKey, {
        title: insert.title, titleKey: insert.titleKey, kind: insert.kind, category: insert.category, start: insert.start, end: insert.end,
        weekdays: insert.weekdays, startTime: insert.startTime, status: insert.status, venueId: idOf(insert.venue), hostId: idOf(insert.host),
        confidence: insert.confidence, sources: insert.sources, firstRunId: runId, lastRunId: runId, firstSeenAt: at, lastSeenAt: at, seenCount: 1,
      });
    }
    for (const update of plan.updates) {
      await held();
      await store.updateEvent(townKey, update.id, { ...update, lastSeenAt: at });
    }
    await held();
    await store.removeOld(townKey, retention(at));
    const counts = countsOf(runId, threads, events, plan);
    const status = runStatus(threads);
    const cost = threads.reduce((total, thread) => total + thread.spentMicroUsd, 0);
    // Ended before `found` is cleared, so a replay after a crash in between never finds nothing and ends with zero counts.
    if (await store.finishRun(runId, { status, code: null, counts, costMicroUsd: cost, now: now() }, owner)) {
      await store.clearFound(runId);
      logger.info({ townKey, runId, subject: 'town', status, added: counts.added, updated: counts.updated }, 'townwise.research_run');
    }
    return townKey;
  }

  /**
   * The town's location runs whose threads all ended while its run was live (held back by decision 8), merged as soon as
   * it ends instead of at the planner's next sweep (UI review: up to 15 minutes of "running" with every topic done).
   * A failed merge holds its lease, so this ends; the sweep takes it over later.
   */
  async function mergeHeldLocations(townKey: TownId): Promise<void> {
    for (;;) {
      const owner = `${replica}:merge:${randomUUID()}`;
      const claimed = await claimLocationResearchMerge(connection, { town: townKey, owner, now: now(), leaseMs: MERGE_LEASE_MS });
      if (claimed === null) return;
      try {
        await merge({ kind: 'location', scope: scopeForResearch(claimed), runId: claimed.runId, locationId: claimed.locationId, owner });
      } catch (err) {
        logger.warn({ runId: claimed.runId, errType: errType(err) }, 'townwise.research_merge_failed');
      }
    }
  }

  async function mergeLocation(scope: OrgScope, locationId: string, runId: string, owner: string): Promise<void> {
    const store = stores.researchLocations;
    const run = await store.findRun(scope, runId);
    if (run?.status !== 'merging') return;
    const held = holder((input) => store.holdMerge(scope, runId, input), owner);
    const at = now();
    const ids = { orgId: scope.orgId, locationId, runId };
    const threads = await store.threadsOf(scope, runId);
    const cost = threads.reduce((total, thread) => total + thread.spentMicroUsd, 0);
    const before = await locationState(scope, locationId, run);
    if (before.kind === 'gone') {
      if (before.code === 'location_gone') {
        // The late-writer rule: a planner tick or a lane can leave a run and threads behind a location deleted meanwhile.
        await store.removeForLocation(scope, locationId);
        logger.info({ ...ids, subject: 'location', status: 'off', code: before.code, added: 0, updated: 0 }, 'townwise.research_run');
        return;
      }
      const counts = { found: 0, added: 0, updated: 0, dropped: 0 };
      if (await store.finishRun(scope, runId, { status: 'off', code: before.code, counts, costMicroUsd: cost, now: at }, owner)) {
        await store.clearFound(scope, runId);
        logger.info({ ...ids, subject: 'location', status: 'off', code: before.code, added: 0, updated: 0 }, 'townwise.research_run');
      }
      return;
    }
    const { location } = before;
    const stamp = { placeId: location.placeId, town: townStamp(location.town) };
    const townId = location.town.townId !== null && isTownId(location.town.townId) ? location.town.townId : null;
    const [events, entities, townEventsStored, townEntities] = await Promise.all([
      store.events(scope, locationId), store.entities(scope, locationId),
      townId === null ? Promise.resolve([]) : stores.researchTowns.events(townId),
      townId === null ? Promise.resolve([]) : stores.researchTowns.entities(townId),
    ]);
    const mine = events.filter((event) => event.placeId === stamp.placeId && event.town === stamp.town);
    const window = researchWindow(at, timeZoneOf(location.town).timeZone);
    const competitorsThread = threads.find((thread) => thread.thread === 'competitors' && thread.status === 'recorded');
    // The restaurant's own names, so its own events are never a competitor's: the organization's name, the location's
    // typed name unless it is only a town's ("Hanover" would claim the Hanover Inn), and Google's, read live and only
    // compared here (never stored or sent, so whatever TOWNWISE_RESEARCH_PLACES_TO_AI says), only when the competitors
    // thread found something.
    const ownNames = [nameKey(before.orgName), ...(namedAfterTown(location) ? [] : [nameKey(location.name)])];
    if (location.placeId !== null && deps.profile !== undefined && (competitorsThread?.found?.events.length ?? 0) > 0) {
      const profile = await deps.profile(location.placeId);
      if (profile !== null) ownNames.push(nameKey(profile.name));
    }
    const plan = planMerge({
      runId, subject: 'location', found: foundOf(threads), stored: storedEvents(mine, entities),
      storedEntities: entities.map((entity) => ({ id: entity.id, type: entity.type, nameKey: entity.nameKey })),
      curated: townId === null ? [] : townEvents(townId, window), townRows: storedEvents(townEventsStored, townEntities),
      competitorPlaces: placesByN(competitorsThread?.found?.competitorPlaceIds), ownNames,
    });
    const townEntityIds = new Map(townEntities.map((entity) => [`${entity.type}|${entity.nameKey}`, entity.id]));
    const entityIds = new Map<string, string>();
    for (const entity of plan.entities) {
      const key = `${entity.key.type}|${entity.key.nameKey}`;
      await held();
      entityIds.set(key, await store.upsertEntity(scope, locationId, {
        ...stamp, type: entity.key.type, name: entity.name, nameKey: entity.key.nameKey, townEntityId: townEntityIds.get(key) ?? null,
        sources: entity.sources, now: at,
      }));
    }
    const idOf = (key: { type: string; nameKey: string } | null): string | null => (key === null ? null : entityIds.get(`${key.type}|${key.nameKey}`) ?? null);
    for (const insert of plan.inserts) {
      await held();
      await store.insertEvent(scope, locationId, {
        ...stamp, title: insert.title, titleKey: insert.titleKey, kind: insert.kind, category: insert.category, start: insert.start, end: insert.end,
        weekdays: insert.weekdays, startTime: insert.startTime, status: insert.status, venueId: idOf(insert.venue), hostId: idOf(insert.host),
        confidence: insert.confidence, sources: insert.sources, firstRunId: runId, lastRunId: runId, firstSeenAt: at, lastSeenAt: at, seenCount: 1,
        origin: insert.origin ?? 'neighborhood', competitorEntityId: idOf(insert.competitorEntity), competitorPlaceId: insert.competitorPlaceId,
      });
    }
    for (const update of plan.updates) {
      await held();
      await store.updateEvent(scope, locationId, update.id, { ...update, lastSeenAt: at });
    }
    // The location again, after the writes: a change landing before this read is seen here, and one landing after it
    // runs its own cleanup after these writes, so no row of an old place or a deleted location outlives both.
    const after = await stores.locations.find(scope, locationId);
    if (after === null) {
      // The late-writer rule: deleted while this merge wrote, its rows go now (removeLocation sweeps them again too).
      await store.removeForLocation(scope, locationId);
      logger.info({ ...ids, subject: 'location', status: 'off', code: 'location_gone', added: 0, updated: 0 }, 'townwise.research_run');
      return;
    }
    const current = { placeId: after.placeId, town: townStamp(after.town) };
    if (current.placeId !== stamp.placeId || current.town !== stamp.town) {
      // Its place or town changed while this merge wrote: what it wrote under the old one goes, as the change's own
      // cleanup (handlers/research.ts researchAfterWrite) does, and the run ends `off` unless that change ended it.
      await store.removeOtherStamps(scope, locationId, current);
      const counts = { found: 0, added: 0, updated: 0, dropped: 0 };
      if (await store.finishRun(scope, runId, { status: 'off', code: 'place_changed', counts, costMicroUsd: cost, now: now() }, owner)) {
        await store.clearFound(scope, runId);
      }
      logger.info({ ...ids, subject: 'location', status: 'off', code: 'place_changed', added: 0, updated: 0 }, 'townwise.research_run');
      return;
    }
    await held();
    await store.removeOld(scope, locationId, retention(at));
    const counts = countsOf(runId, threads, mine, plan);
    const status = runStatus(threads);
    // Ended before `found` is cleared, so a replay after a crash in between never finds nothing and ends with zero counts.
    if (await store.finishRun(scope, runId, { status, code: null, counts, costMicroUsd: cost, now: now() }, owner)) {
      await store.clearFound(scope, runId);
      logger.info({ ...ids, subject: 'location', status, added: counts.added, updated: counts.updated }, 'townwise.research_run');
    }
  }

  async function merge(claimed: ClaimedMerge): Promise<void> {
    let town: TownId | null = null;
    try {
      if (claimed.kind === 'town') town = await mergeTown(claimed.runId, claimed.owner);
      else await mergeLocation(claimed.scope, claimed.locationId, claimed.runId, claimed.owner);
    } catch (err) {
      if (!(err instanceof MergeLost)) throw err;
      logger.info({ runId: claimed.runId, subject: claimed.kind }, 'townwise.research_merge_lost');
    }
    if (town !== null) await mergeHeldLocations(town);
  }

  // ---- The stale sweep -----------------------------------------------------------------------------------------------

  /**
   * Running threads whose lease passed (a dead replica's), put back in the queue at once and their reservation settled
   * to the last written tally plus STALE_GRACE_MS of streaming, the rest refunded. One past its attempts is failed at
   * its next claim (`interrupted`).
   */
  async function sweepStale(): Promise<number> {
    let swept = 0;
    const grace = staleGraceMicroUsd();
    const reclaimed = async (subject: { townKey: TownId | null; scope: OrgScope | null }, thread: ThreadRecordBase | null): Promise<void> => {
      if (thread === null) return;
      swept += 1;
      if (thread.month !== null && thread.reservedMicroUsd > 0) {
        const charged = Math.min(thread.reservedMicroUsd, thread.spentMicroUsd + grace);
        await settle(subject, thread.month, charged - thread.reservedMicroUsd);
      }
      logger.warn({ runId: thread.runId, threadId: thread.id, attempts: thread.attempts }, 'townwise.research_thread_reclaimed');
    };
    const at = now();
    for (const id of await stores.researchTowns.staleThreads(at)) {
      const thread = await stores.researchTowns.reclaimThread(id, { now: at, next: { status: 'queued', notBefore: at } });
      await reclaimed({ townKey: thread?.townKey ?? null, scope: null }, thread);
    }
    for (const found of await staleLocationResearchThreads(connection, at)) {
      const scope = scopeForResearch(found);
      await reclaimed({ townKey: null, scope }, await stores.researchLocations.reclaimThread(scope, found.id, { now: at, next: { status: 'queued', notBefore: at } }));
    }
    return swept;
  }

  // ---- Lanes and timers ----------------------------------------------------------------------------------------------

  async function lane(): Promise<void> {
    while (!stopped) {
      const job = await claim();
      if (job === null) return;
      try {
        if (await runJob(job)) await mergeIfLast(job);
      } catch (err) {
        // The thread's lease runs out and the stale sweep puts it back; a merge left `merging` is taken over by the sweep.
        logger.warn({ ...job.ids, errType: errType(err) }, 'townwise.research_thread_failed');
      }
    }
  }

  function nudge(): void {
    while (!stopped && running.size < lanes) {
      const done: Promise<void> = lane()
        .catch((err: unknown) => { logger.error({ errType: errType(err) }, 'townwise.research_runner_failed'); })
        .finally(() => { running.delete(done); });
      running.add(done);
    }
  }

  async function planOnce(): Promise<PlanCounts> {
    await sweepStale();
    const counts = await planTick(planContext, `${replica}:plan`, merge);
    nudge();
    return counts;
  }

  function plan(): Promise<PlanCounts> {
    const next = (planning ?? Promise.resolve()).catch(() => undefined).then(planOnce);
    const tracked = next.finally(() => { if (planning === tracked) planning = null; });
    planning = tracked;
    return next;
  }

  const runPlan = (): void => {
    if (stopped) return;
    plan().catch((err: unknown) => { logger.error({ errType: errType(err) }, 'townwise.research_plan_failed'); });
  };

  return {
    name: 'research-runner',
    start() {
      poll = setInterval(nudge, deps.pollMs ?? POLL_MS);
      planTimer = setTimeout(() => {
        runPlan();
        planEvery = setInterval(runPlan, deps.planEveryMs ?? PLAN_EVERY_MS);
      }, deps.planDelayMs ?? PLAN_DELAY_MS);
      nudge();
    },
    nudge,
    plan,
    async settled() {
      while (running.size > 0 || planning !== null) {
        await Promise.allSettled([...running, ...(planning === null ? [] : [planning])]);
      }
    },
    async close() {
      stopped = true;
      clearInterval(poll);
      clearTimeout(planTimer);
      clearInterval(planEvery);
      closing.abort();
      await Promise.allSettled([...running, ...(planning === null ? [] : [planning])]);
    },
  };
}
