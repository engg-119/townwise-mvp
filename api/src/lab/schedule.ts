// The weekly refresh (D42, spec 14.6, design decisions 2 to 4 and 13): one pass of the background worker
// (workers/weekly-forecasts.ts), never a loop in the API. A pass acts only while it holds the lease on the schedule
// document (10 minutes, renewed before each location; a failed renewal stops it at once), and does nothing while the lab
// runner is off, TOWNWISE_WEEKLY_FORECASTS is false or staff paused it. It then
//   1. resolves week rows a dead pass left `starting` (started, when a system calibration of the location came after the
//      row, else start_failed),
//   2. counts the live calibrations it started (a stale one timed out first, and counted failed), for the live cap of 3,
//   3. considers each location of an active organization whose forecasts are on (an absent switch counting as on),
//      found by a cross-tenant lookup and scoped by access/policy.ts: from 03:00 on Monday in the town's time zone to
//      the end of that week (dueWeek: one the live cap held back on Monday is caught up later), a location with no row
//      for that Monday and no calibration of its own live is fingerprinted (its lab input without
//      calibrationId, today and champion, with the input version and LAB_MODEL_VERSION) and skipped `unchanged` when the
//      fingerprint equals its reference calibration's (stores/calibrations.ts reference), unless the run that calibration
//      published ends at its today plus 91 days and would stop being current before the next Monday (refitExtends: a
//      refit on the same days reaches further, since a run's end moves with today), `not_enough_history` under the
//      baseline's 230 days, held without a row past the live cap, `cap_reached` past the weekly cap, and otherwise
//      started as the system (no charge, not one of the 4 a day) with the regimeStart of the calibration that made its
//      newest published run (dropped, with a log line of ids, when the history no longer holds it, so the start is not
//      refused every week). A job that cannot start leaves no row, so a later pass that week tries again, up to
//      SCHEDULE_START_TRIES starts in a day; the last records start_failed.
// After the calibrations, under the same lease, the pass runs TownwiseAI's weekly suggestions (openspec change
// weekly-forecast-suggestions, lab/suggestions.ts) while TOWNWISE_WEEKLY_SUGGESTIONS is true and the model is set
// (ANTHROPIC_API_KEY), with or without the lab: for each location of an active organization whose weekly suggestions
// are on (an absent switch counting as on), found by a cross-tenant lookup, one call a week from 03:00 on Monday in the
// town (a location missed on Monday is caught up later that week). The staff pause stops the whole worker, calibrations
// and weekly suggestions alike. Before the suggestions, the pass resolves pass rows a dead pass left `running` longer
// than a lease (failed, handing back the reservation they held, or removed when they held none, so their week still
// runs), and records on the schedule document that it ran them, which TownwiseAI's panel reads.
// A pass has SCHEDULE_PASS_BUDGET_MS (inside the job's replica timeout): it takes another location only while it could
// finish it in the time left, and otherwise ends that part `deadline`, leaving the rest to the next hour's pass.
// Nothing here names a town, an organization or a location. The pass logs one line of counts and its state for each
// part; a location whose turn throws logs its ids and the pass goes on. No figure is ever logged.
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { Types } from 'mongoose';

import { scopeForWeeklyRefresh, type OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { recordAfter, SYSTEM_ACTOR } from '../audit.ts';
import { SCHEDULE_START_HOUR } from '../calibration.ts';
import { daysBetween, utcDay } from '../dates.ts';
import { LIVE_STATUSES } from '../stores/calibrations.ts';
import type { ChatModel } from '../chat/model.ts';
import {
  countedWeekRows, liveScheduledCalibrations, staleStartingWeeks, staleSuggestionPasses, suggestionCandidates, weeklyCandidates,
  type WeeklyCandidate,
} from '../stores/cross-tenant.ts';
import { localDay, localMinutes, timeZoneOf } from '../time-zones.ts';
import { currentChampion, GATE } from './gate.ts';
import { buildLabInput, labInputFingerprint } from './input.ts';
import { checkStart, expireStale, launch, regimeStartFits, SYSTEM_REQUESTER, type LabStartContext, type StartRequest } from './service.ts';
import { suggestFor, SUGGESTIONS_TIME_MS, suggestionsWeek } from './suggestions.ts';

/** The lease a pass holds and renews before each location. */
export const SCHEDULE_LEASE_MS = 10 * 60_000;
/** Scheduled calibrations live at once across all organizations. [CONFIRM] */
export const SCHEDULE_LIVE_CAP = 3;
// SCHEDULE_START_HOUR lives with the calibration state, whose next refresh reads it too (calibration.ts cannot import
// this module, which reaches it back through the chat's tools).
export { SCHEDULE_START_HOUR };
/** Starts a location's job may fail (the runner refusing it) on its Monday before its row records start_failed. [CONFIRM] */
export const SCHEDULE_START_TRIES = 3;
/**
 * A pass's whole time, from its start: inside the worker job's 600-second replica timeout (infra jobs.tf) and the lease,
 * so an execution is never killed mid-location. A pass that reaches it ends `deadline`, and the next hour's goes on.
 */
export const SCHEDULE_PASS_BUDGET_MS = 8 * 60_000;
/**
 * The time left a pass needs to take one more location besides a suggestions call (its reads, a calibration's start and
 * the pass's own end); a suggestions location needs SUGGESTIONS_TIME_MS more, the call's whole time.
 */
export const SCHEDULE_STEP_MS = 60_000;
/** A lab run reaches its calibration's today plus this many days, when its data reaches that far (forecast.REACH_DAYS). */
export const RUN_REACH_DAYS = 91;
/** How far back the staff console looks for each location's latest week row. */
export const WEEK_ROWS_LOOKBACK_DAYS = 56;
/**
 * TownwiseAI's panel says weekly suggestions run only when a pass ran them within this long (the worker runs hourly, so
 * this is three passes missed). [CONFIRM]
 */
export const SUGGESTIONS_SEEN_MS = 3 * 60 * 60_000;

/**
 * What a pass reads: starting a calibration's context, the connection its cross-tenant lookups use, and the model the
 * weekly suggestions call (null or absent while TownwiseAI is off).
 */
export type ScheduleContext = LabStartContext & Pick<TownwiseContext, 'connection'> & { readonly chat?: ChatModel | null };

/**
 * How a pass ended: it ran, or it found the refresh off (the lab runner or TOWNWISE_WEEKLY_FORECASTS), paused by staff,
 * the lease held by another pass, its own lease taken mid-pass, or its time budget too short for another location.
 */
export type PassState = 'ran' | 'off' | 'paused' | 'lease_held' | 'lease_lost' | 'deadline';

export interface PassCounts {
  /** Calibrations started. */
  started: number;
  /**
   * Starts that failed, week rows left starting by a dead pass that it resolved as start_failed, and scheduled
   * calibrations it timed out (their job never called back), which are not retried that week.
   */
  failed: number;
  /** Rows recorded `unchanged` or `not_enough_history`, and due locations someone else is calibrating. */
  skipped: number;
  /** Due locations held by the live cap (no row) or recorded `cap_reached`. */
  capped: number;
}

/**
 * How the weekly suggestions part of a pass ended: it ran, was off, paused by staff, lost the lease mid-way, or had too
 * little of the pass's time left for another call (the rest wait for the next pass, as a location missed on Monday does).
 */
export type SuggestionsState = 'ran' | 'off' | 'paused' | 'lease_held' | 'lease_lost' | 'deadline';

export interface SuggestionsCounts {
  /** Locations whose call stored at least one suggestion, and the suggestions stored. */
  passes: number;
  suggested: number;
  /** Calls that stored none; locations skipped because the organization's TownwiseAI month had less than $0.30 left. */
  none: number;
  budget: number;
  /** Calls that failed, locations whose turn threw, and pass rows a dead pass left running with a reservation. */
  failed: number;
}

export interface SuggestionsResult extends SuggestionsCounts { state: SuggestionsState; ms: number }

export interface PassResult extends PassCounts { state: PassState; ms: number; suggestions: SuggestionsResult }

export interface ForecastSchedule {
  /** One pass. Never throws for one location's error (it logs that location's ids and goes on). */
  pass(): Promise<PassResult>;
}

/**
 * The Monday of the week a location is due for: from 03:00 that Monday in its town to the end of Sunday; null before
 * 03:00 on a Monday. A location with no row for that Monday is considered on every pass of its week, not only on Monday:
 * at 3 live at once and one pass an hour, Monday alone starts at most 63, so the locations the live cap held back (the
 * newest, by the candidates' order) are caught up later that week instead of missing it, as the suggestions are.
 */
export function dueWeek(now: Date, timeZone: string): string | null {
  return suggestionsWeek(localDay(now, timeZone), localMinutes(now, timeZone), SCHEDULE_START_HOUR);
}

function isLive(status: string): boolean {
  return (LIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * `dueClock` decides which locations are due (the worker's development-only --now moves it); everything the pass records
 * (calibrations, week rows, the lease) keeps `ctx.now`, the real clock, so a job it starts can still call back in time.
 */
export function createForecastSchedule(deps: { ctx: ScheduleContext; owner?: string; dueClock?: () => Date }): ForecastSchedule {
  const { ctx } = deps;
  const dueClock = deps.dueClock ?? ctx.now;
  const { stores } = ctx;
  const owner = deps.owner ?? randomUUID();

  /** Week rows a dead pass left starting longer than a lease: started with the system calibration made after, else failed. */
  async function resolveStale(counts: PassCounts): Promise<void> {
    const now = ctx.now();
    for (const row of await staleStartingWeeks(ctx.connection, new Date(now.getTime() - SCHEDULE_LEASE_MS))) {
      const scope = scopeForWeeklyRefresh(row);
      const made = await stores.calibrations.scheduledSince(scope, row.locationId, row.createdAt);
      const outcome = made === null ? { status: 'start_failed' as const } : { status: 'started' as const, calibrationId: made.id };
      if (await stores.forecastWeeks.resolve(scope, row.id, outcome, now) && made === null) counts.failed += 1;
    }
  }

  /** The scheduled calibrations still live, each past its 20 minutes timed out first and counted failed. */
  async function liveCount(counts: PassCounts): Promise<number> {
    let live = 0;
    for (const found of await liveScheduledCalibrations(ctx.connection)) {
      const scope = scopeForWeeklyRefresh(found);
      const record = await stores.calibrations.find(scope, found.id);
      if (record === null || !isLive(record.status)) continue;
      const now = await expireStale(ctx, scope, record);
      if (isLive(now.status)) live += 1;
      else if (now.failure === 'timeout') counts.failed += 1;
    }
    return live;
  }

  /** The regimeStart of the calibration that made the location's newest published run (null without one). */
  async function regimeOf(scope: OrgScope, locationId: string): Promise<string | null> {
    const [newest] = await stores.forecasts.published(scope, locationId);
    if (newest?.lab == null) return null;
    return (await stores.calibrations.find(scope, newest.lab.calibrationId))?.regimeStart ?? null;
  }

  /**
   * Whether unchanged data should still be refit this `week` (D42: a published forecast reaching 91 days past today): no
   * published run will be current (28 days ahead) at next Monday's pass, and the run `reference` published ended at its
   * today plus 91 days, so a refit on the same days ends later. A run that ended where its data or its backtest stops
   * (forecast.run_end) would end there again, and a draft the gate held is left for staff, so neither is refit.
   */
  async function refitExtends(scope: OrgScope, locationId: string, runId: string | null, week: string): Promise<boolean> {
    if (runId === null) return false;
    const published = await stores.forecasts.published(scope, locationId);
    const nextWeek = utcDay(new Date(`${week}T00:00:00.000Z`), 7);
    if (currentChampion(published, nextWeek) !== null) return false;
    const run = published.find((each) => each.id === runId);
    if (run === undefined) return false;
    return run.range.to === utcDay(new Date(`${run.madeAt}T00:00:00.000Z`), RUN_REACH_DAYS);
  }

  /** A pass's running tally: its counts, the live scheduled calibrations and each week's counted rows. */
  interface PassRun { counts: PassCounts; live: number; weekCounts: Map<string, number> }

  async function consider(candidate: WeeklyCandidate, pass: PassRun): Promise<void> {
    const scope = scopeForWeeklyRefresh(candidate);
    const location = await stores.locations.find(scope, candidate.locationId);
    if (location === null) return;
    const timeZone = timeZoneOf(location.town).timeZone;
    const week = dueWeek(dueClock(), timeZone);
    if (week === null || await stores.forecastWeeks.find(scope, location.id, week) !== null) return;
    const { counts } = pass;
    // Someone is calibrating it: no row, so a later pass tries again until the town's week ends.
    const own = await stores.calibrations.live(scope, location.id);
    if (own !== null && isLive((await expireStale(ctx, scope, own)).status)) {
      counts.skipped += 1;
      return;
    }
    const now = ctx.now();
    let regimeStart = await regimeOf(scope, location.id);
    if (regimeStart !== null && !(await regimeStartFits(ctx, scope, location.id, localDay(now, timeZone), regimeStart))) {
      // The history moved past it (an upload turned off, D28): refit without it rather than fail every week.
      ctx.logger.info({ orgId: scope.orgId, locationId: location.id }, 'townwise.weekly_refresh_regime_dropped');
      regimeStart = null;
    }
    const input = await buildLabInput(ctx, scope, { id: new Types.ObjectId().toHexString(), locationId: location.id, regimeStart, championRunId: null });
    const record = (status: 'unchanged' | 'not_enough_history' | 'cap_reached', dataSha256: string | null) =>
      stores.forecastWeeks.insert(scope, { locationId: location.id, week, status, dataSha256, now });
    const first = input?.days[0]?.date;
    if (input === null || first === undefined || daysBetween(first, input.dataThrough) < GATE.baselineMinHistoryDays) {
      if (await record('not_enough_history', null)) counts.skipped += 1;
      return;
    }
    const dataSha256 = labInputFingerprint(input);
    const reference = await stores.calibrations.reference(scope, location.id);
    if (reference?.dataSha256 === dataSha256 && !(await refitExtends(scope, location.id, reference.runId, week))) {
      if (await record('unchanged', dataSha256)) counts.skipped += 1;
      return;
    }
    if (pass.live >= SCHEDULE_LIVE_CAP) {
      counts.capped += 1;
      return;
    }
    const counted = pass.weekCounts.get(week) ?? await countedWeekRows(ctx.connection, week);
    pass.weekCounts.set(week, counted);
    if (counted >= ctx.config.weeklyForecastCap) {
      if (await record('cap_reached', dataSha256)) counts.capped += 1;
      return;
    }
    const req: StartRequest = {
      id: new Types.ObjectId().toHexString(), scope, location, requester: SYSTEM_REQUESTER, regimeStart, today: localDay(now, timeZone),
    };
    const refusal = await checkStart(ctx, req);
    if (refusal === 'in_progress') {
      counts.skipped += 1;
      return;
    }
    if (!(await stores.forecastWeeks.insert(scope, { locationId: location.id, week, status: 'starting', dataSha256, now }))) return;
    const row = await stores.forecastWeeks.find(scope, location.id, week);
    if (row === null) return;
    pass.weekCounts.set(week, counted + 1);
    const launched = refusal === null ? await launch(ctx, req) : { ok: false as const, code: refusal };
    if (launched.ok) {
      await stores.forecastWeeks.resolve(scope, row.id, { status: 'started', calibrationId: launched.calibration.id }, ctx.now());
      await recordAfter(ctx, {
        ...SYSTEM_ACTOR, at: ctx.now(), orgId: scope.orgId, action: 'calibration.scheduled',
        target: { type: 'calibration', id: launched.calibration.id },
        details: { locationId: location.id, calibrationId: launched.calibration.id },
      });
      counts.started += 1;
      pass.live += 1;
      return;
    }
    if (launched.code === 'in_progress') {
      // Another start won the location between the check and the insert: the week is still open for it.
      await stores.forecastWeeks.removeStarting(scope, row.id);
      pass.weekCounts.set(week, counted);
      counts.skipped += 1;
      return;
    }
    counts.failed += 1;
    // The runner refused the job (an outage): leave the week open for a later pass, up to the tries in a day.
    if (launched.code === 'start_failed') {
      const since = new Date(now.getTime() - 24 * 60 * 60_000);
      if (await stores.calibrations.scheduledStartFailures(scope, location.id, since) < SCHEDULE_START_TRIES) {
        await stores.forecastWeeks.removeStarting(scope, row.id);
        pass.weekCounts.set(week, counted);
        return;
      }
    }
    await stores.forecastWeeks.resolve(scope, row.id, { status: 'start_failed' }, ctx.now());
  }

  /**
   * Pass rows a dead pass left running longer than a lease (a live pass finishes its row within the call's 2 minutes):
   * one that held a reservation fails and hands it back to its month, once; one that held none is removed.
   */
  async function resolveStaleSuggestions(counts: SuggestionsCounts): Promise<void> {
    const now = ctx.now();
    const before = new Date(now.getTime() - SCHEDULE_LEASE_MS);
    for (const row of await staleSuggestionPasses(ctx.connection, before)) {
      const scope = scopeForWeeklyRefresh(row);
      const held = await stores.agentSuggestions.resolveStalePass(scope, { locationId: row.locationId, week: row.week, before, now });
      if (held === null || held.microUsd === 0) continue;
      await stores.chatUsage.add(scope, held.month, -held.microUsd, now);
      counts.failed += 1;
    }
  }

  /** The weekly suggestions for each due location, until the lease is lost or a call could outlast the pass's deadline. */
  async function suggestAll(model: ChatModel, counts: SuggestionsCounts, deadline: number): Promise<SuggestionsState> {
    const roomForCall = (): boolean => deadline - ctx.now().getTime() >= SUGGESTIONS_TIME_MS + SCHEDULE_STEP_MS;
    if (!roomForCall()) return 'deadline';
    await stores.forecastSchedule.markSuggestionsRan({ owner, now: ctx.now() });
    await resolveStaleSuggestions(counts);
    for (const candidate of await suggestionCandidates(ctx.connection)) {
      if (!roomForCall()) return 'deadline';
      if (!(await stores.forecastSchedule.renew({ owner, now: ctx.now(), leaseMs: SCHEDULE_LEASE_MS }))) return 'lease_lost';
      try {
        const scope = scopeForWeeklyRefresh(candidate);
        const location = await stores.locations.find(scope, candidate.locationId);
        if (location === null) continue;
        const timeZone = timeZoneOf(location.town).timeZone;
        const at = dueClock();
        const week = suggestionsWeek(localDay(at, timeZone), localMinutes(at, timeZone), SCHEDULE_START_HOUR);
        if (week === null || await stores.agentSuggestions.findPass(scope, location.id, week) !== null) continue;
        const outcome = await suggestFor({ config: ctx.config, now: ctx.now, stores, chat: model }, scope, location, week);
        if (outcome.status === 'suggested') {
          counts.passes += 1;
          counts.suggested += outcome.suggested;
        } else if (outcome.status === 'none') counts.none += 1;
        else if (outcome.status === 'budget') counts.budget += 1;
        else if (outcome.status === 'failed') counts.failed += 1;
      } catch {
        counts.failed += 1;
        ctx.logger.warn({ orgId: candidate.orgId, locationId: candidate.locationId }, 'townwise.weekly_suggestions_location_failed');
      }
    }
    return 'ran';
  }

  return {
    async pass() {
      const began = performance.now();
      const deadline = ctx.now().getTime() + SCHEDULE_PASS_BUDGET_MS;
      const counts: PassCounts = { started: 0, failed: 0, skipped: 0, capped: 0 };
      const suggestionCounts: SuggestionsCounts = { passes: 0, suggested: 0, none: 0, budget: 0, failed: 0 };
      const model = ctx.config.weeklySuggestions ? ctx.chat ?? null : null;
      const refreshOn = ctx.labRunner !== null && ctx.config.weeklyForecasts;
      let suggestionsBegan = performance.now();
      const end = (state: PassState, suggestionsState: SuggestionsState): PassResult => {
        const suggestions = { state: suggestionsState, ...suggestionCounts, ms: Math.round(performance.now() - suggestionsBegan) };
        const result = { state, ...counts, ms: Math.round(performance.now() - began) };
        ctx.logger.info(result, 'townwise.weekly_refresh_pass');
        ctx.logger.info(suggestions, 'townwise.weekly_suggestions_pass');
        return { ...result, suggestions };
      };
      if (!refreshOn && model === null) return end('off', 'off');
      const claim = await stores.forecastSchedule.claim({ owner, now: ctx.now(), leaseMs: SCHEDULE_LEASE_MS });
      if (!claim.claimed) return end(refreshOn ? 'lease_held' : 'off', model === null ? 'off' : 'lease_held');
      try {
        let state: PassState = 'ran';
        if (!refreshOn) state = 'off';
        else if (claim.paused !== null) state = 'paused';
        else {
          await resolveStale(counts);
          const pass: PassRun = { counts, live: await liveCount(counts), weekCounts: new Map() };
          for (const candidate of await weeklyCandidates(ctx.connection)) {
            if (deadline - ctx.now().getTime() < SCHEDULE_STEP_MS) {
              // Out of time: the rest wait for the next hour's pass (their week stays open until Sunday ends).
              state = 'deadline';
              break;
            }
            if (!(await stores.forecastSchedule.renew({ owner, now: ctx.now(), leaseMs: SCHEDULE_LEASE_MS }))) {
              return end('lease_lost', model === null ? 'off' : 'lease_lost');
            }
            try {
              await consider(candidate, pass);
            } catch {
              counts.failed += 1;
              ctx.logger.warn({ orgId: candidate.orgId, locationId: candidate.locationId }, 'townwise.weekly_refresh_location_failed');
            }
          }
        }
        if (model === null) return end(state, 'off');
        if (claim.paused !== null) return end(state, 'paused');
        suggestionsBegan = performance.now();
        return end(state, await suggestAll(model, suggestionCounts, deadline));
      } finally {
        await stores.forecastSchedule.release({ owner, now: ctx.now() });
      }
    },
  };
}
