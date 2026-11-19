// The research planner (D66, openspec change town-research-agent, design decision 2): what runs to insert, and the
// merge sweep. The runner (research/runner.ts) calls a tick 60 seconds after boot and then every 15 minutes in each
// replica; handlers/locations.ts calls queueEarlyRun when a location is created or its place or town changes.
//
// It only inserts, so two replicas planning at once do no harm: a run is unique by subject and key, and a subject has
// one live run (the `liveSubject` index), so a second insert answers null, read as "already running".
//
// - Town run: each town of the twelve that has a location in an active organization with research on, the week's run
//   (`w:{Monday}` in the town's time zone), skipped when the town's last run was created less than 6 days before. A town
//   run records no trigger and no requester.
// - Location run: each such location, the same week's run, skipped the same way, so an early run counts as that week's.
// - Weekly threads are due over the Monday by a hash of their subject (0 to 12 hours), so the Monday batch is spread.
// - Early run (`s:{id}`): due at once; the location's town gets its week's run now unless it has one from the last 6 days.
// - A live run missing thread rows (a plan that crashed between the run and its threads) is completed.
// - Merge sweep: claims the merge of any `running` run whose threads are all terminal, or a merge whose lease passed,
//   and hands it to the runner's merge, so a run never stays `running` because the lane that settled its last thread
//   died.
// - Revision retention: deletes the revisions of events that no longer exist (stores/cross-tenant.ts
//   removeOrphanResearchRevisions, ids only), so an edit never outlives its event or counts toward the 1,000.
//
// TOWNWISE_RESEARCH_TOWN_MONTHLY_USD at 0 plans no town run, and TOWNWISE_RESEARCH_ORG_MONTHLY_USD at 0 no automatic
// location run (design decision 17). Logs carry counts only, never a town's or a location's name.
import { createHash } from 'node:crypto';

import type { Logger } from '@ckeith26/server-core';
import { Types, type Connection } from 'mongoose';

import { scopeForResearch, type OrgScope } from '../access/policy.ts';
import type { ResolvedTownwiseConfig } from '../config.ts';
import {
  claimLocationResearchMerge, removeOrphanResearchRevisions, researchLocationCandidates, researchTownsInUse,
} from '../stores/cross-tenant.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { LocationRunRecord, RunTrigger } from '../stores/research-locations.ts';
import type { RunRecordBase } from '../stores/research-shared.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { TOWN_IDS, TOWNS, type Town, type TownId } from '../towns.ts';
import { nameKey } from './dedupe.ts';
import { threadsFor, type ThreadId } from './threads.ts';

const DAY_MS = 86_400_000;
/** [CONFIRM: each location researched weekly, on its creation, and when its place is picked or changed; a run in the last 6 days counts as the week's] */
export const RESEARCH_REPEAT_MS = 6 * DAY_MS;
/** A weekly thread is due within this many minutes of its Monday's start. */
export const STAGGER_MINUTES = 12 * 60;
/** How long a merge claim holds before the sweep may take it over. */
export const MERGE_LEASE_MS = 90_000;

export interface PlanContext {
  readonly connection: Connection;
  readonly stores: TownwiseStores;
  readonly logger: Logger;
  readonly now: () => Date;
  /** `researchTownMonthlyUsd` at 0 plans no town run; `researchOrgMonthlyUsd` at 0 no automatic location run. */
  readonly config: Pick<ResolvedTownwiseConfig, 'researchTownMonthlyUsd' | 'researchOrgMonthlyUsd'>;
}

/**
 * Whether research runs in this process (design decision 1): TOWNWISE_RESEARCH, an Anthropic key and TownwiseAI's web
 * search all on. main.ts starts the runner only then, and handlers/locations.ts queues an early run only then, so no
 * run waits in a deploy that never runs one.
 */
export function researchRuns(input: { readonly research: boolean; readonly chatWebSearch: boolean; readonly anthropicKey: boolean }): boolean {
  return input.research && input.chatWebSearch && input.anthropicKey;
}

/** A merge the sweep claimed, for the runner to carry out under `owner`. */
export type ClaimedMerge =
  | { readonly kind: 'town'; readonly runId: string; readonly owner: string }
  | { readonly kind: 'location'; readonly scope: OrgScope; readonly runId: string; readonly locationId: string; readonly owner: string };

// ---- Keys and times ------------------------------------------------------------------------------------------------

function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The Monday of `now`'s week in `timeZone`, as YYYY-MM-DD. */
export function mondayOf(now: Date, timeZone: string): string {
  const day = localDay(now, timeZone);
  const weekday = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return plusDays(day, -((weekday + 6) % 7));
}

/** A weekly run's key: `w:{Monday}` in the subject's time zone. */
export function weekKey(now: Date, timeZone: string): string {
  return `w:${mondayOf(now, timeZone)}`;
}

/** What `timeZone`'s wall clock is ahead of UTC at `at`, in milliseconds. */
function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((each) => each.type === type)?.value ?? 0);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant `day` starts in `timeZone`. */
export function startOfLocalDay(day: string, timeZone: string): Date {
  const guess = Date.parse(`${day}T00:00:00.000Z`);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}

/** When a weekly thread of `subject` is due: its Monday's start plus 0 to 12 hours by a hash of the subject. */
export function staggeredStart(monday: string, timeZone: string, subject: string): Date {
  const minutes = createHash('sha256').update(subject).digest().readUInt32BE(0) % STAGGER_MINUTES;
  return new Date(startOfLocalDay(monday, timeZone).getTime() + minutes * 60_000);
}

/**
 * The town a location row is stamped with (design decision 9): the TownId of one of the twelve, else a key of the typed
 * town's name and state, which never becomes a shared key.
 */
export function townStamp(town: Town): string {
  return town.townId ?? `typed:${town.state}:${nameKey(town.name)}`;
}

/** A town of the twelve as a Town. */
export function townOf(townId: TownId): Town {
  const found = TOWNS.find((town) => town.townId === townId);
  return { townId, name: found?.name ?? townId, state: found?.state ?? '' };
}

/** When a run's threads are due: a weekly run's over its Monday, any other at once. */
function dueAt(key: string, timeZone: string, subject: string, now: Date): Date {
  return key.startsWith('w:') ? staggeredStart(key.slice(2), timeZone, subject) : now;
}

export const isTownId = (value: string): value is TownId => (TOWN_IDS as readonly string[]).includes(value);

/**
 * The day (in `timeZone`) the planner will next insert a subject's weekly run and its threads fall due, by the rule
 * above: not within 6 days of the subject's last run, once a week by its `w:{Monday}` key, due over that Monday by the
 * subject's stagger. For the research read's `next` (the Town tab); the caller answers null while a run is live.
 */
export function nextWeeklyRunDay(last: { readonly key: string; readonly createdAt: Date } | null, now: Date, timeZone: string, subject: string): string {
  let at = last === null ? now : new Date(Math.max(now.getTime(), last.createdAt.getTime() + RESEARCH_REPEAT_MS));
  // This week's run already exists: the next one is next week's.
  if (last?.key === weekKey(at, timeZone)) at = startOfLocalDay(plusDays(mondayOf(at, timeZone), 7), timeZone);
  const due = staggeredStart(mondayOf(at, timeZone), timeZone, subject);
  return localDay(new Date(Math.max(at.getTime(), due.getTime())), timeZone);
}

function recent(last: RunRecordBase | null, now: Date): boolean {
  return last !== null && now.getTime() - last.createdAt.getTime() < RESEARCH_REPEAT_MS;
}

// ---- Inserting runs --------------------------------------------------------------------------------------------------

export type PlanOutcome = 'inserted' | 'recent' | 'running' | 'off';

/** The town's week's run, unless one was created in the last 6 days or one is live; a live run's missing threads are completed. */
export async function planTownRun(ctx: PlanContext, townId: TownId): Promise<PlanOutcome> {
  if (ctx.config.researchTownMonthlyUsd <= 0) return 'off';
  const now = ctx.now();
  const { timeZone } = timeZoneOf(townOf(townId));
  const store = ctx.stores.researchTowns;
  if (recent(await store.lastRun(townId), now)) {
    await completeTownThreads(ctx, townId);
    return 'recent';
  }
  const threads = threadsFor({ kind: 'town', townId }, { placesToAi: false }).map((def) => def.id);
  const run = await store.insertRun({ townKey: townId, key: weekKey(now, timeZone), threads, now });
  if (run === null) {
    await completeTownThreads(ctx, townId);
    return 'running';
  }
  const notBefore = dueAt(run.key, timeZone, townId, now);
  await store.insertThreads(run, threads.map((thread) => ({ thread, notBefore })), now);
  return 'inserted';
}

/** Inserts the thread rows a live town run is missing; resolves how many. */
async function completeTownThreads(ctx: PlanContext, townId: TownId): Promise<number> {
  const store = ctx.stores.researchTowns;
  const live = await store.liveRun(townId);
  if (live === null || live.status === 'merging') return 0;
  const have = new Set((await store.threadsOf(live.id)).map((thread) => thread.thread));
  const missing = live.threads.filter((thread) => !have.has(thread));
  if (missing.length === 0) return 0;
  const notBefore = dueAt(live.key, timeZoneOf(townOf(townId)).timeZone, townId, ctx.now());
  return store.insertThreads(live, missing.map((thread) => ({ thread, notBefore })), ctx.now());
}

/** The location's threads, as threadsFor names them (their ids do not depend on whether Google's names go to Anthropic). */
function locationThreads(location: LocationRecord): ThreadId[] {
  return threadsFor({ kind: 'location', townId: location.town.townId }, { placesToAi: false }).map((def) => def.id);
}

/** Inserts the thread rows the location's live run is missing; resolves how many. */
async function completeLocationThreads(ctx: PlanContext, scope: OrgScope, location: LocationRecord): Promise<number> {
  const store = ctx.stores.researchLocations;
  const live = await store.liveRun(scope, location.id);
  if (live === null || live.status === 'merging') return 0;
  const have = new Set((await store.threadsOf(scope, live.id)).map((thread) => thread.thread));
  const missing = live.threads.filter((thread) => !have.has(thread));
  if (missing.length === 0) return 0;
  const notBefore = dueAt(live.key, timeZoneOf(location.town).timeZone, location.id, ctx.now());
  return store.insertThreads(scope, live, missing.map((thread) => ({ thread, notBefore })), ctx.now());
}

/** Inserts one location run and its threads; null when the location already has a live run or a run of this key. */
async function insertLocationRun(
  ctx: PlanContext, scope: OrgScope, location: LocationRecord, input: { key: string; trigger: RunTrigger },
): Promise<LocationRunRecord | null> {
  const now = ctx.now();
  const threads = locationThreads(location);
  const run = await ctx.stores.researchLocations.insertRun(scope, {
    locationId: location.id, key: input.key, trigger: input.trigger, placeId: location.placeId, town: townStamp(location.town), threads, now,
  });
  if (run === null) return null;
  const notBefore = dueAt(run.key, timeZoneOf(location.town).timeZone, location.id, now);
  await ctx.stores.researchLocations.insertThreads(scope, run, threads.map((thread) => ({ thread, notBefore })), now);
  return run;
}

/** The location's week's run, unless one was created in the last 6 days or one is live. */
export async function planLocationRun(ctx: PlanContext, scope: OrgScope, location: LocationRecord): Promise<PlanOutcome> {
  if (ctx.config.researchOrgMonthlyUsd <= 0) {
    // The share at 0 plans no automatic run, but Research now still queues one: complete it if its threads went missing,
    // or the location would hold a live run with nothing to claim.
    await completeLocationThreads(ctx, scope, location);
    return 'off';
  }
  const now = ctx.now();
  if (recent(await ctx.stores.researchLocations.lastRun(scope, location.id), now)) {
    await completeLocationThreads(ctx, scope, location);
    return 'recent';
  }
  const key = weekKey(now, timeZoneOf(location.town).timeZone);
  if (await insertLocationRun(ctx, scope, location, { key, trigger: 'weekly' }) !== null) return 'inserted';
  await completeLocationThreads(ctx, scope, location);
  return 'running';
}

/**
 * The early run of a location just created or whose place or town just changed (design decision 2): due at once, for an
 * active organization with research on, with its town's week's run asked for now. The caller (handlers/locations.ts)
 * checks the deploy switch and that the caller is not staff with the organization open as admin, and never fails its
 * request on a throw from here.
 *
 * A planner tick that read the location before its place changed can insert a weekly run stamped with the old place
 * after the change's endLive found none, and so hold the one live slot. When the insert meets a live run of another
 * place or town, that run is ended `off` (`place_changed`) and the insert tried once more, so the new place is
 * researched now rather than after the old run's 6 days.
 */
export async function queueEarlyRun(ctx: PlanContext, scope: OrgScope, location: LocationRecord): Promise<PlanOutcome> {
  if (ctx.config.researchOrgMonthlyUsd <= 0) return 'off';
  const org = await ctx.stores.orgs.findById(scope.orgId);
  if (org?.status !== 'active' || !org.research.on) return 'off';
  const early = () => insertLocationRun(ctx, scope, location, { key: `s:${new Types.ObjectId().toHexString()}`, trigger: 'early' });
  let inserted = await early() !== null;
  if (!inserted) {
    const live = await ctx.stores.researchLocations.liveRun(scope, location.id);
    if (live !== null && (live.placeId !== location.placeId || live.town !== townStamp(location.town))) {
      await ctx.stores.researchLocations.endLive(scope, location.id, { code: 'place_changed', now: ctx.now() });
      inserted = await early() !== null;
    }
  }
  const { townId } = location.town;
  if (townId !== null && isTownId(townId)) await planTownRun(ctx, townId);
  return inserted ? 'inserted' : 'running';
}

/**
 * Research now (design decisions 2 and 13): a run of the location's own threads, key `p:{id}`, trigger `press`, due at
 * once. It never asks for the town's run. Null when the location already has a live run (the one-live-run index), which
 * the route answers 409 research_running. The route checks the switches, the 6 hours and the caller first.
 */
export async function queuePressRun(ctx: PlanContext, scope: OrgScope, location: LocationRecord): Promise<LocationRunRecord | null> {
  return insertLocationRun(ctx, scope, location, { key: `p:${new Types.ObjectId().toHexString()}`, trigger: 'press' });
}

// ---- The tick --------------------------------------------------------------------------------------------------------

export interface PlanCounts {
  towns: number;
  locations: number;
  merges: number;
}

/**
 * The merge sweep: claims each town and location run ready to merge (or whose merge lease passed) and hands it to
 * `merge`. A merge that throws is left `merging` for a later sweep to take over once its lease passes.
 */
export async function sweepMerges(ctx: PlanContext, owner: string, merge: (claimed: ClaimedMerge) => Promise<void>): Promise<number> {
  let merges = 0;
  const run = async (claimed: ClaimedMerge): Promise<void> => {
    merges += 1;
    try {
      await merge(claimed);
    } catch (err) {
      ctx.logger.warn({ runId: claimed.runId, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.research_merge_failed');
    }
  };
  for (const runId of await ctx.stores.researchTowns.mergeableRuns(ctx.now())) {
    if (await ctx.stores.researchTowns.claimMerge({ runId, owner, now: ctx.now(), leaseMs: MERGE_LEASE_MS })) await run({ kind: 'town', runId, owner });
  }
  // A claimed run leaves `running`, and a failed merge holds its lease, so this ends.
  for (;;) {
    const claimed = await claimLocationResearchMerge(ctx.connection, { owner, now: ctx.now(), leaseMs: MERGE_LEASE_MS });
    if (claimed === null) break;
    await run({ kind: 'location', scope: scopeForResearch(claimed), runId: claimed.runId, locationId: claimed.locationId, owner });
  }
  return merges;
}

/** One planner tick: the week's town and location runs, then the merge sweep. One subject's error is logged by id and skipped. */
export async function planTick(ctx: PlanContext, owner: string, merge: (claimed: ClaimedMerge) => Promise<void>): Promise<PlanCounts> {
  const counts: PlanCounts = { towns: 0, locations: 0, merges: 0 };
  for (const townId of await researchTownsInUse(ctx.connection)) {
    if (!isTownId(townId)) continue;
    try {
      if (await planTownRun(ctx, townId) === 'inserted') counts.towns += 1;
    } catch (err) {
      ctx.logger.warn({ townKey: townId, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.research_plan_failed');
    }
  }
  for (const candidate of await researchLocationCandidates(ctx.connection)) {
    const scope = scopeForResearch(candidate);
    try {
      const location = await ctx.stores.locations.find(scope, candidate.locationId);
      if (location !== null && await planLocationRun(ctx, scope, location) === 'inserted') counts.locations += 1;
    } catch (err) {
      ctx.logger.warn({ orgId: candidate.orgId, locationId: candidate.locationId, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.research_plan_failed');
    }
  }
  counts.merges = await sweepMerges(ctx, owner, merge);
  // Revision retention: the edits of events the merges' retention removed go too (ids only; no edit's text is read).
  try {
    await removeOrphanResearchRevisions(ctx.connection);
  } catch (err) {
    ctx.logger.warn({ errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.research_plan_failed');
  }
  if (counts.towns + counts.locations + counts.merges > 0) ctx.logger.info({ ...counts }, 'townwise.research_plan');
  return counts;
}
