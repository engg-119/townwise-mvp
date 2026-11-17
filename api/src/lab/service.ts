// The forecast lab's calibrations (design calls 3, 4, 5 and 7): starting one, timing out one whose job never called
// back, and storing what its job posts back as a draft forecast run, which the system publishes when it passes the gate
// (G2) and the organization's forecasts are switched on (G1). No transactions (D17): every step is ordered so a retry
// completes it, and every change of a calibration is a compare-and-set, so a duplicated or retried result ends with one
// run, at most one publish and one calibration.finished event. Logs and audit events carry ids, codes and counts only,
// never a figure, a date with a value, or anything from the input or the result.
import { createRateLimiter, RateLimiterUnavailableError, type RateLimiter } from '@ckeith26/rate-limit';
import { Types } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { applyRecorded, recordAfter, recordBefore, recordNotApplied, SYSTEM_ACTOR } from '../audit.ts';
import { daysBetween, utcDay } from '../dates.ts';
import { runFileSha256, type FileIssue, type LabRunFile } from '../forecasts/file.ts';
import { engineOf } from '../forecasts/reader.ts';
import { rowsOf } from '../handlers/forecast-runs.ts';
import { LIVE_STATUSES, type CalibrationFailure, type CalibrationOutcome, type CalibrationRecord } from '../stores/calibrations.ts';
import type { AuditEventInput } from '../stores/audit-events.ts';
import type { ForecastRunRecord } from '../stores/forecasts.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { currentChampion, decideGate, GATE, jumpSums, streakOf, type CurrentRun } from './gate.ts';
import { guestSpan, recordedBacktest } from './input.ts';
import { checkLabResult, type LabSuccess } from './result.ts';
import { LabStartError } from './runner.ts';
import type { LabScorecard } from './scorecard.ts';

export { HORIZON_DAYS } from './input.ts';

/** What one calibration costs the organization's TownwiseAI month (the job's list price is about $0.03). [CONFIRM] */
export const CALIBRATION_CHARGE_MICRO_USD = 100_000;
/** Calibrations an organization may start in a day (townwise:calibrations; a store outage denies). [CONFIRM] */
export const CALIBRATIONS_PER_ORG_PER_DAY = 4;
/** A calibration still live this long after it was requested has failed (timeout); its callback closes at the same time. [CONFIRM] */
export const CALIBRATION_TIMEOUT_MS = 1_200_000;
/** A pattern change needs this many days of history after it, so the new pattern has weeks to learn from. [CONFIRM] */
const REGIME_TAIL_DAYS = 56;

const CALIBRATIONS_LIMIT = { name: 'townwise:calibrations', limit: CALIBRATIONS_PER_ORG_PER_DAY, windowSeconds: 86_400 } as const;
const limiters = new WeakMap<TownwiseContext['redis'], RateLimiter>();

export type StartRefusal =
  | 'lab_unavailable' | 'not_enough_history' | 'invalid_regime_start' | 'budget_exhausted' | 'in_progress' | 'rate_limited'
  | 'start_failed';

export const START_REFUSAL_WORDS: Record<StartRefusal, string> = {
  lab_unavailable: 'Calibration isn’t available right now.',
  not_enough_history: 'Calibration needs at least 595 days from the first to the last day of sales history.',
  invalid_regime_start: 'The pattern change date must fall inside the sales history, at least 8 weeks before its last day.',
  budget_exhausted: 'This month’s TownwiseAI budget is used up, so a calibration can’t start until it resets.',
  in_progress: 'A calibration for this location is already running.',
  rate_limited: 'This organization has started 4 calibrations in the last day. Try again tomorrow.',
  start_failed: 'The calibration couldn’t start. Try again in a few minutes.',
};

export const FAILURE_WORDS: Record<CalibrationFailure, string> = {
  start_failed: 'It couldn’t start.',
  timeout: 'It didn’t finish within 20 minutes.',
  job_failed: 'The job stopped with an error.',
  not_enough_history: 'There wasn’t enough sales history.',
  invalid_result: 'Its result didn’t pass Townwise’s checks.',
};

/** Who starts a calibration: a person (D27), or the weekly refresh (D42), which no person started. */
export type StartRequester =
  | { readonly userId: string; readonly role: 'org_admin' | 'superadmin'; readonly via: 'chat' | 'console' | 'file' }
  | { readonly userId: null; readonly role: 'system'; readonly via: 'scheduled' };

/** The weekly refresh's requester: Townwise pays (no charge, not one of the 4 a day) and 230 days may start it (D42). */
export const SYSTEM_REQUESTER = { userId: null, role: 'system', via: 'scheduled' } as const satisfies StartRequester;

export interface StartRequest {
  /** The new calibration's id, made by the caller so the event it records before the effect can name it. */
  readonly id: string;
  readonly scope: OrgScope;
  readonly location: LocationRecord;
  readonly requester: StartRequester;
  readonly regimeStart: string | null;
  /** The town's local date. */
  readonly today: string;
}

export interface IngestAnswer { status: number; body: object }

const NOT_FOUND: IngestAnswer = { status: 404, body: { error: 'not_found', message: 'Not found' } };

function isLive(record: CalibrationRecord): boolean {
  return LIVE_STATUSES.includes(record.status);
}

/**
 * What starting a calibration reads (D42): the API's context, or the weekly worker's (workers/weekly-forecasts.ts),
 * which has no Valkey (it is the API's sidecar). Only a person's start uses `redis`, for the 4 a day.
 */
export type LabStartContext = Pick<TownwiseContext, 'config' | 'logger' | 'now' | 'stores' | 'labRunner'> & {
  readonly redis: TownwiseContext['redis'] | null;
};

/** The tuning chat's month (UTC), which calibrations are charged to. */
function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/** Spent once the month's cost reaches the limit, as the tuning chat counts it. */
async function budgetSpent(ctx: LabStartContext, scope: OrgScope): Promise<boolean> {
  const used = await ctx.stores.chatUsage.costMicroUsd(scope, monthOf(ctx.now()));
  return used >= Math.round(ctx.config.chatMonthlyBudgetUsd * 1_000_000);
}

/** The span the job's input will hold (lab/input.ts guestSpan), in the town's `today`. */
async function historyOf(
  ctx: Pick<TownwiseContext, 'stores'>, scope: OrgScope, locationId: string, today: string,
): Promise<{ first: string; last: string } | null> {
  const coverage = await ctx.stores.salesDays.coverage(scope, locationId);
  if (coverage.firstDate === null || coverage.lastDate === null) return null;
  return guestSpan(await ctx.stores.salesDays.days(scope, locationId, { from: coverage.firstDate, to: coverage.lastDate }), today);
}

/** What a finished calibration's event names besides its status: its run, the gate's reason and the weeks it judged. */
interface FinishFacts { runId: string | null; gate: string | null; heldOutWeeks: number | null }

/**
 * Finishes a live calibration by compare-and-set. Only the call that finishes it records calibration.finished (by the
 * system, after the effect) and logs townwise.calibration_finished, so a retry or a race records it once.
 */
export async function finishCalibration(
  ctx: Pick<TownwiseContext, 'stores' | 'logger' | 'now'>, scope: OrgScope, record: CalibrationRecord, outcome: CalibrationOutcome,
  facts: FinishFacts = { runId: null, gate: null, heldOutWeeks: null },
): Promise<boolean> {
  if (!(await ctx.stores.calibrations.finish(scope, record.id, outcome, ctx.now()))) return false;
  const failure = outcome.status === 'failed' ? outcome.failure : null;
  await recordAfter(ctx, {
    ...SYSTEM_ACTOR, at: ctx.now(), orgId: scope.orgId, action: 'calibration.finished',
    target: { type: 'calibration', id: record.id },
    details: {
      locationId: record.locationId, calibrationId: record.id, status: outcome.status, gate: facts.gate, failure,
      runId: facts.runId, heldOutWeeks: facts.heldOutWeeks,
    },
  });
  ctx.logger.info({
    orgId: scope.orgId, locationId: record.locationId, calibrationId: record.id, status: outcome.status, failure,
    gate: facts.gate, heldOutWeeks: facts.heldOutWeeks,
  }, 'townwise.calibration_finished');
  return true;
}

/**
 * A live calibration requested 20 minutes ago or more has failed (timeout): its job never called back, or never
 * finished. There is no background sweep: the next start or read of it does this. Resolves the record as it is now.
 */
export async function expireStale(ctx: Pick<TownwiseContext, 'stores' | 'logger' | 'now'>, scope: OrgScope, record: CalibrationRecord): Promise<CalibrationRecord> {
  if (!isLive(record) || ctx.now().getTime() < record.requestedAt.getTime() + CALIBRATION_TIMEOUT_MS) return record;
  await finishCalibration(ctx, scope, record, { status: 'failed', failure: 'timeout' });
  return (await ctx.stores.calibrations.find(scope, record.id)) ?? record;
}

/** Whether Townwise pays for the start (D42): the weekly refresh's, which no person asked for. */
function systemPaid(req: StartRequest): boolean {
  return req.requester.role === 'system';
}

/** A pattern change date falls inside the history, at least 8 weeks before its last day. */
function regimeFits(regimeStart: string, history: { first: string; last: string }): boolean {
  return regimeStart >= history.first && daysBetween(regimeStart, history.last) >= REGIME_TAIL_DAYS;
}

/**
 * Whether checkStart would take `regimeStart` for the location now: the weekly refresh (D42) carries the date of the
 * calibration that made the newest published run, which the history can since have moved past (an upload turned off,
 * D28). False with no history.
 */
export async function regimeStartFits(
  ctx: Pick<TownwiseContext, 'stores'>, scope: OrgScope, locationId: string, today: string, regimeStart: string,
): Promise<boolean> {
  const history = await historyOf(ctx, scope, locationId, today);
  return history !== null && regimeFits(regimeStart, history);
}

/**
 * The checks before a start, in order: the lab is on; the history (first to last day with guests) spans at least
 * GATE.minHistoryDays, the span that always gives the gate 12 weeks to judge (GATE.baselineMinHistoryDays for the
 * weekly refresh, D42, whose calibration below 595 days can only make a baseline); a pattern change date falls inside
 * it, at least 8 weeks before its last day; the month's TownwiseAI budget is not spent (a person's start only); and no
 * calibration of the location is live (a stale one is timed out first).
 */
export async function checkStart(ctx: LabStartContext, req: StartRequest): Promise<StartRefusal | null> {
  if (ctx.labRunner === null) return 'lab_unavailable';
  const { scope, location } = req;
  const history = await historyOf(ctx, scope, location.id, req.today);
  const minDays = systemPaid(req) ? GATE.baselineMinHistoryDays : GATE.minHistoryDays;
  if (history === null || daysBetween(history.first, history.last) < minDays) return 'not_enough_history';
  if (req.regimeStart !== null && !regimeFits(req.regimeStart, history)) return 'invalid_regime_start';
  if (!systemPaid(req) && await budgetSpent(ctx, scope)) return 'budget_exhausted';
  const live = await ctx.stores.calibrations.live(scope, location.id);
  if (live !== null && isLive(await expireStale(ctx, scope, live))) return 'in_progress';
  return null;
}

/**
 * Starts a calibration after checkStart passed: one of the organization's 4 a day, a queued calibration holding the
 * location's live slot with its callback open for 20 minutes, the job (handed the calibration's id and no secret: it
 * signs in as the lab identity), then running, then the charge to the month. A job that can't start fails the
 * calibration start_failed and is not charged. The weekly refresh's start (D42) takes none of the 4 a day and is not
 * charged (chargedMicroUsd stays 0).
 */
export async function launch(
  ctx: LabStartContext, req: StartRequest,
): Promise<{ ok: true; calibration: CalibrationRecord } | { ok: false; code: StartRefusal }> {
  const runner = ctx.labRunner;
  if (runner === null) return { ok: false, code: 'lab_unavailable' };
  const { scope, location } = req;
  if (!systemPaid(req)) {
    // No Valkey (the weekly worker) denies a person's start, as a store outage does; it never makes one.
    if (ctx.redis === null) return { ok: false, code: 'rate_limited' };
    let limiter = limiters.get(ctx.redis);
    if (limiter === undefined) {
      limiter = createRateLimiter({ redis: ctx.redis, ...CALIBRATIONS_LIMIT });
      limiters.set(ctx.redis, limiter);
    }
    try {
      if (!(await limiter.consume(`org:${scope.orgId}`)).allowed) return { ok: false, code: 'rate_limited' };
    } catch (err) {
      // Every calibration costs money, so a store outage denies.
      if (!(err instanceof RateLimiterUnavailableError)) throw err;
      return { ok: false, code: 'rate_limited' };
    }
  }
  const champion = currentChampion(await ctx.stores.forecasts.published(scope, location.id), req.today);
  const now = ctx.now();
  const queued = await ctx.stores.calibrations.insertQueued(scope, {
    id: req.id, locationId: location.id, regimeStart: req.regimeStart, championRunId: champion?.id ?? null,
    requestedBy: { userId: req.requester.userId, role: req.requester.role, via: req.requester.via },
    tokenExpiresAt: new Date(now.getTime() + CALIBRATION_TIMEOUT_MS), now,
  });
  if (queued === null) return { ok: false, code: 'in_progress' };
  let started;
  try {
    started = await runner.start({ calibrationId: queued.id });
  } catch (err) {
    ctx.logger.warn({ calibrationId: queued.id, code: err instanceof LabStartError ? err.code : 'internal' }, 'townwise.lab_start_failed');
    await finishCalibration(ctx, scope, queued, { status: 'failed', failure: 'start_failed' });
    return { ok: false, code: 'start_failed' };
  }
  // The job's input fetch may have marked it running first; the image it runs is recorded either way (G3).
  if (!(await ctx.stores.calibrations.markRunning(scope, queued.id, { now: ctx.now(), imageDigest: started.imageDigest }))
    && started.imageDigest !== null) {
    await ctx.stores.calibrations.recordImageDigest(scope, queued.id, started.imageDigest);
  }
  if (!systemPaid(req)) {
    await ctx.stores.chatUsage.add(scope, monthOf(now), CALIBRATION_CHARGE_MICRO_USD, ctx.now());
    await ctx.stores.calibrations.setCharge(scope, queued.id, CALIBRATION_CHARGE_MICRO_USD);
  }
  ctx.logger.info({ orgId: scope.orgId, locationId: location.id, calibrationId: queued.id, via: req.requester.via }, 'townwise.calibration_started');
  return { ok: true, calibration: (await ctx.stores.calibrations.find(scope, queued.id)) ?? queued };
}

/** The held-out weeks the result was judged on: compared with the current forecast, else backtest weeks with a range. */
function heldOutWeeksOf(result: LabSuccess): number {
  return result.scorecard.comparison?.weeks ?? result.scorecard.backtest.weeksWithRange;
}

/**
 * The system publishes the draft (G1): forecast.published before the effect, then draft to published by
 * compare-and-set. A staff withdrawal or deletion of the draft meanwhile wins, and the event says it did not apply.
 */
async function publishDraft(ctx: TownwiseContext, scope: OrgScope, calibration: CalibrationRecord, run: ForecastRunRecord): Promise<void> {
  const now = ctx.now();
  const event: AuditEventInput = {
    ...SYSTEM_ACTOR, at: now, orgId: scope.orgId, action: 'forecast.published',
    target: { type: 'forecast_run', id: run.id },
    details: {
      locationId: run.locationId, modelVersion: run.model.version, from: run.range.from, to: run.range.to, dayCount: run.dayCount,
      via: 'lab', calibrationId: calibration.id,
    },
  };
  const eventId = await recordBefore(ctx, event);
  const published = await applyRecorded(ctx, event, eventId, () => ctx.stores.forecasts.setStatus(scope, run.id, {
    from: ['draft'], to: 'published', at: now, by: null,
  }));
  if (!published) {
    await recordNotApplied(ctx, event, eventId, 'conflict');
    return;
  }
  ctx.logger.info({ orgId: scope.orgId, runId: run.id, status: 'published' }, 'townwise.forecast_status');
}

/** The current run as the gate judges a draft against it (D42): its engine, its recorded backtest and its streak's best. */
async function currentRunOf(
  ctx: TownwiseContext, scope: OrgScope, published: readonly ForecastRunRecord[], run: ForecastRunRecord, today: string,
): Promise<CurrentRun> {
  const recorded = await recordedBacktest(ctx, scope, run);
  const streak = await Promise.all(streakOf(published, run.id, today).map((each) => recordedBacktest(ctx, scope, each)));
  const wapes = streak.flatMap((metrics) => (metrics === null ? [] : [metrics.weeklyWape]));
  return {
    engine: engineOf(run.model.family),
    recorded: recorded === null ? null : { weeklyWape: recorded.weeklyWape, weekdayBiasMeanAbs: recorded.weekdayBiasMeanAbs },
    streakBest: wapes.length === 0 ? null : Math.min(...wapes),
  };
}

/**
 * The gate (G2) on the draft this calibration made, once: forecasts on means switched on with the organization active
 * (G1); the current forecast is read again, in the town's today, to compare with the one the calibration was given; and
 * the decision is set on the calibration by compare-and-set. A request that finds the gate already set and saying
 * publish (a retry after an outage between the gate and the publish, or a concurrent post) publishes the run if it is
 * still the draft and the gate still publishes now; publishDraft's draft-to-published compare-and-set lets at most one
 * publish apply, and a racer that loses records its event as not applied. A run that is no longer a draft, or that
 * another calibration made (the same file again), is never gated or changed (G3).
 */
async function gateDraft(
  ctx: TownwiseContext, scope: OrgScope, calibration: CalibrationRecord, location: LocationRecord, runId: string,
  result: { scorecard: LabScorecard; run: LabRunFile },
): Promise<void> {
  const { forecasts, orgs } = ctx.stores;
  const run = await forecasts.find(scope, runId);
  if (run?.status !== 'draft' || run.lab?.calibrationId !== calibration.id) return;
  const org = await orgs.findById(scope.orgId);
  const today = localDay(ctx.now(), timeZoneOf(location.town).timeZone);
  const published = await forecasts.published(scope, location.id);
  const championNow = currentChampion(published, today);
  // The current run the calibration was given, while it is still the current one (else the gate says champion_changed).
  const given = championNow !== null && championNow.id === calibration.championRunId ? championNow : null;
  // The jump guard reads both runs over the 28 days from the calibration's today, the draft's madeAt: the current run,
  // or, when there was none at the start and is none now (it lapsed), the newest published run, so a draft after a lapse
  // is not published unseen. A first forecast has none to compare with.
  const lapsed = calibration.championRunId === null && championNow === null ? published.find((each) => each.status === 'published') ?? null : null;
  const against = given ?? lapsed;
  const from = result.run.madeAt;
  const jumpRows = against === null ? [] : await forecasts.rows(scope, location.id, [against.id], {
    from, to: utcDay(new Date(`${from}T00:00:00.000Z`), GATE.jumpDays - 1),
  });
  const decision = decideGate({
    forecastsOn: org !== null && org.forecasts.on && org.status === 'active',
    championAtStart: calibration.championRunId,
    championNow: championNow?.id ?? null,
    scorecard: result.scorecard,
    current: given === null ? null : await currentRunOf(ctx, scope, published, given, today),
    jump: against === null ? null : jumpSums(result.run.days, jumpRows, from),
  });
  const gate = { published: decision.publish, reason: decision.reason };
  if (await ctx.stores.calibrations.recordGate(scope, calibration.id, gate)) {
    if (decision.publish) await publishDraft(ctx, scope, calibration, run);
    return;
  }
  // The gate was recorded first by a concurrent post, or by an earlier try of this one whose publish never happened.
  const recorded = (await ctx.stores.calibrations.find(scope, calibration.id))?.gate ?? null;
  if (recorded?.published !== true || !decision.publish) return;
  const current = await forecasts.find(scope, runId);
  if (current?.status === 'draft') await publishDraft(ctx, scope, calibration, current);
}

/**
 * The draft run of a checked result, in retry-safe order: the run upserted on its file's hash (the lab never changes a
 * run that already exists), its rows, draft, then the result on the calibration, its gate (and the publish the gate
 * decides) and its finish, each by compare-and-set. A calibration deleted meanwhile (its sales data, its location or its
 * organization) takes the run this calibration made with it, and answers 404.
 */
async function storeDraft(
  ctx: TownwiseContext, scope: OrgScope, calibration: CalibrationRecord, result: LabSuccess, inputSha256: string, now: Date,
): Promise<IngestAnswer> {
  const { calibrations, forecasts } = ctx.stores;
  const location = await ctx.stores.locations.find(scope, calibration.locationId);
  if (location === null) return NOT_FOUND;
  const file = result.run;
  const { run, inserted } = await forecasts.upsertRun(scope, location.id, {
    id: new Types.ObjectId().toHexString(), file, fileSha256: runFileSha256(file), importedBy: null,
    lab: {
      calibrationId: calibration.id, codeVersion: result.codeVersion, imageDigest: calibration.imageDigest, inputSha256,
      paramsJson: JSON.stringify(result.params),
    },
    now,
  });
  if (run.status === 'importing') {
    await forecasts.writeRows(scope, location.id, run.id, rowsOf(file, location.town.townId));
    if (await forecasts.countRows(scope, run.id) !== run.dayCount + run.weekCount) throw new Error('forecast rows incomplete');
    await forecasts.setStatus(scope, run.id, { from: ['importing'], to: 'draft', at: now, by: null });
  }
  // Deleting sales data, a location or an organization removes calibrations before runs, so a calibration that is gone
  // now means the run may have been written after that deletion.
  if ((await calibrations.find(scope, calibration.id)) === null) {
    if (run.lab?.calibrationId === calibration.id) await forecasts.remove(scope, run.id);
    return NOT_FOUND;
  }
  const recorded = await calibrations.recordResult(scope, calibration.id, {
    runId: run.id, scorecardJson: JSON.stringify(result.scorecard), codeVersion: result.codeVersion,
  });
  // A concurrent post of the same result recorded it first: carry on. Anything else (another result, or the calibration
  // finished first) leaves no run of this post behind.
  if (!recorded && (await calibrations.find(scope, calibration.id))?.runId !== run.id) {
    if (inserted) await forecasts.remove(scope, run.id);
    return NOT_FOUND;
  }
  await gateDraft(ctx, scope, calibration, location, run.id, result);
  // The gate as recorded, by this request or a concurrent one.
  const gated = await calibrations.find(scope, calibration.id);
  await finishCalibration(ctx, scope, calibration, { status: 'succeeded' }, {
    runId: run.id, gate: gated?.gate?.reason ?? null, heldOutWeeks: heldOutWeeksOf(result),
  });
  const current = await calibrations.find(scope, calibration.id);
  return { status: 200, body: { status: current?.status ?? 'succeeded' } };
}

/**
 * POST /lab/calibrations/:id/result, for a calibration the callback found live: 200 { status } once stored (a draft
 * run, published when the gate says so, or a failure the job reported); 400 invalid_lab_result { issues } (paths and
 * codes) for a result that fails its checks, which fails the calibration invalid_result; 404 when the calibration is
 * gone or no longer live.
 */
export async function ingestLabResult(ctx: TownwiseContext, scope: OrgScope, calibrationId: string, raw: unknown): Promise<IngestAnswer> {
  const calibration = await ctx.stores.calibrations.find(scope, calibrationId);
  if (calibration === null || !isLive(calibration)) return NOT_FOUND;
  const invalid = async (issues: FileIssue[]): Promise<IngestAnswer> => {
    await finishCalibration(ctx, scope, calibration, { status: 'failed', failure: 'invalid_result' });
    return { status: 400, body: { error: 'invalid_lab_result', message: 'Invalid lab result', issues } };
  };
  const now = ctx.now();
  const check = checkLabResult(raw, calibration, utcDay(now));
  if (!check.ok) return invalid(check.issues);
  const { result } = check;
  if (!result.ok) {
    const failure: CalibrationFailure = result.code === 'not_enough_history' ? 'not_enough_history' : 'job_failed';
    await finishCalibration(ctx, scope, calibration, { status: 'failed', failure });
    return { status: 200, body: { status: 'failed' } };
  }
  // recordInput sets the hash with dataThrough, which the result matched, so a draft always names the input it came from.
  const { inputSha256 } = calibration;
  if (inputSha256 === null) return invalid([{ path: 'calibrationId', code: 'input_not_fetched' }]);
  return storeDraft(ctx, scope, calibration, result, inputSha256, now);
}
