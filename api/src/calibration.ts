// Calibration states (spec 14.1, 14.3): derived from a location's own sales data and its newest published forecast on
// every read, never stored. No forecast, no progress, no “calibrating” and no day threshold until a run is published
// (14.2). Once one is (D42), `calibrated` when its last day of data is the last day with guests, `stale` when days with
// guests came after it, each with the Monday the weekly refresh next considers the location (none for a stale one whose
// days a refused refit already read). Notes and rules are left out of `stale` on purpose: they act on the forecast at
// read time (14.5). queued, calibrating and failed stay reserved: they would name a stored model's state.
//
// D65 (openspec change forecast-training-status, design decisions 1, 2 and 4): beside the state, `updating` says the
// forecast is being updated, as a field and not a state, so an older client strips it and parses as before. `running`
// is a live calibration of the location inside its 20 minutes, whoever started it; `waiting` is a first forecast the
// hourly pass will start from the location's refit mark, by the pass's own predicate (REFIT_EVERY_MS, the 230 days and
// nextRefreshFor's conditions) and only while nothing of the location has succeeded with a judged gate. A
// `not_calibrated` location also carries `lastRun`, its newest calibration's owner outcome once it finished, so Home can
// say why a first forecast was not published. Everything here is a read: a live calibration past its 20 minutes reads
// as not updating and as a failed run, and expireStale (a write) is left to the next start, staff read or pass (7.3).
// Codes, dates and day counts only, never a figure.
import type { OrgScope } from './access/policy.ts';
import type { TownwiseContext } from './app.ts';
import { daysBetween, utcDay } from './dates.ts';
import { GATE } from './lab/gate.ts';
import { guestSpan } from './lab/input.ts';
import { firstForecastOf, ownerOutcomeOf, runningAt, type OwnerOutcome, type OwnerReason } from './lab/owner-outcome.ts';
import type { CalibrationRecord } from './stores/calibrations.ts';
import type { RunState } from './stores/forecasts.ts';
import { shortDate } from './orders/dates.ts';
import type { LocationRecord, RefitState } from './stores/locations.ts';
import type { Coverage } from './stores/sales-days.ts';
import { localDay, localMinutes, timeZoneOf } from './time-zones.ts';

/** A location's week starts at this hour on Monday, in its town's time zone (lab/schedule.ts). */
export const SCHEDULE_START_HOUR = 3;
/**
 * D59: a location's refits start at most once in this long (lab/schedule.ts). Here, beside SCHEDULE_START_HOUR, since
 * `waiting` reads the hourly pass's own predicate and this module cannot import the schedule.
 */
export const REFIT_EVERY_MS = 24 * 60 * 60_000;

interface HistoryFields { dayCount: number; firstDate: string; lastDate: string }
interface PublishedFields extends HistoryFields { dataThrough: string; newerDays: number; nextRefresh: string | null }

/** D65: the forecast is being updated since `since` (ISO): a live calibration, or a first forecast the pass will start. */
export interface Updating { stage: 'running' | 'waiting'; since: string }

/**
 * D65: a not_calibrated location's newest calibration once it finished (ISO `finishedAt`), in owner codes, and whether it
 * was to be the location's first forecast, by the history's rule (false once a run was published before it, since
 * withdrawn), so Home never calls it the first when the history shows a first forecast published.
 */
export interface LastRun { outcome: OwnerOutcome; reason: OwnerReason; firstForecast: boolean; finishedAt: string }

export type Calibration =
  | { state: 'no_sales_data'; updating: null }
  | ({ state: 'not_calibrated'; updating: Updating | null; lastRun: LastRun | null } & HistoryFields)
  | ({ state: 'calibrated' | 'stale'; updating: Updating | null } & PublishedFields);

/** The newest published run's last day of data, and the days with guests after it. */
export interface PublishedFacts { dataThrough: string; newerDays: number }

/**
 * [DECISION NEEDED: minimum days of history before calibration] Until it is decided, no threshold applies.
 * `published` is the newest published run's facts (null without one); `nextRefresh` is nextRefreshOf's; `updating` is
 * updatingOf's and `lastRun` lastRunOf's (D65). With no sales data nothing is updating.
 */
export function calibrationOf(
  coverage: Coverage, published: PublishedFacts | null = null, nextRefresh: string | null = null, updating: Updating | null = null,
  lastRun: LastRun | null = null,
): Calibration {
  if (coverage.dayCount === 0 || coverage.firstDate === null || coverage.lastDate === null) return { state: 'no_sales_data', updating: null };
  const history = { dayCount: coverage.dayCount, firstDate: coverage.firstDate, lastDate: coverage.lastDate };
  if (published === null) return { state: 'not_calibrated', ...history, updating, lastRun };
  return { state: published.newerDays > 0 ? 'stale' : 'calibrated', ...history, ...published, nextRefresh, updating };
}

/**
 * The hourly pass's candidate predicate (stores/cross-tenant.ts refitCandidates) without its 15 quiet minutes: a refit
 * mark is set and the pass last tried a refit of the location at least REFIT_EVERY_MS ago, or never.
 */
export function refitDue(refit: RefitState, now: Date): boolean {
  return refit.wantedAt !== null && (refit.startedAt === null || refit.startedAt.getTime() <= now.getTime() - REFIT_EVERY_MS);
}

/**
 * D65 design decision 2, pure. `newest` is the location's newest calibration (the live one when one is live); `refit`
 * its refit mark (null when not read); `reference` calibrations.reference's answer (null when there is none or it was
 * not read); `published` whether the location has a published run; `on` nextRefreshFor's conditions, its 230 days
 * included. `running` while the newest is live inside its 20 minutes, since its request. `waiting`, since the mark, for
 * a location with no published run whose mark the pass will take and whose first try would be judged on its own data:
 * nothing of the location succeeded with a judged gate, so the pass cannot find the fingerprint unchanged. A location
 * whose first run the gate held, or whose last try was within a day, reads null until the pass starts one.
 */
export function updatingOf(
  newest: CalibrationRecord | null, refit: RefitState | null, reference: CalibrationRecord | null, published: boolean, on: boolean,
  now: Date,
): Updating | null {
  if (newest !== null && runningAt(newest, now)) return { stage: 'running', since: newest.requestedAt.toISOString() };
  if (published || refit === null || !refitDue(refit, now) || reference !== null || !on) return null;
  return refit.wantedAt === null ? null : { stage: 'waiting', since: refit.wantedAt.toISOString() };
}

/**
 * D65 design decision 4, pure: the newest calibration's owner outcome (lab/owner-outcome.ts), null while the location
 * is updating or has none. `run` is its run's state (null when it has none, it is gone, or it was not read); `first` is
 * forecasts.firstPublished's answer, for `firstForecast` (firstForecastOf, as the history reads it).
 */
export function lastRunOf(
  newest: CalibrationRecord | null, run: RunState | null, first: { runId: string; publishedAt: Date } | null, updating: Updating | null,
  now: Date,
): LastRun | null {
  if (newest === null || updating !== null) return null;
  const result = ownerOutcomeOf(newest, run, now);
  if (result === null) return null;
  return {
    outcome: result.outcome, reason: result.reason, firstForecast: firstForecastOf(first, newest.runId, result.finishedAt),
    finishedAt: result.finishedAt.toISOString(),
  };
}

/**
 * The Monday the weekly refresh next considers a location (D42): the first Monday after the town's `today` (`minutes`
 * past its midnight), or null while it is off. `on` is nextRefreshFor's: the lab runner on, TOWNWISE_WEEKLY_FORECASTS
 * true, the schedule not paused by staff, the organization active with its forecasts on, and a history the schedule
 * would start. On a Monday from 03:00 it is the next one, the day's pass having had its turn; before 03:00 it is that
 * same Monday, whose pass is still to come.
 */
export function nextRefreshOf(today: string, minutes: number, on: boolean): string | null {
  if (!on) return null;
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
  if (weekday === 1 && minutes < SCHEDULE_START_HOUR * 60) return today;
  return utcDay(new Date(`${today}T00:00:00.000Z`), ((8 - weekday) % 7) || 7);
}

function daysSince(count: number): string {
  return count === 1 ? 'the 1 day since' : `the ${String(count)} days since`;
}

/**
 * Words for `stale`, null for every other state. D65: while a refit runs they say the days aren't in it yet rather than
 * when Townwise refits, which the updating sentence after them would contradict.
 */
function staleWords(calibration: Calibration): string | null {
  if (calibration.state !== 'stale') return null;
  const made = `Forecast made from your sales through ${shortDate(calibration.dataThrough)}.`;
  const since = daysSince(calibration.newerDays);
  if (calibration.nextRefresh === null || calibration.updating?.stage === 'running') {
    return `${made} ${since.charAt(0).toUpperCase()}${since.slice(1)} ${calibration.newerDays === 1 ? 'isn’t' : 'aren’t'} in it yet.`;
  }
  return `${made} Townwise refits on ${shortDate(calibration.nextRefresh)} with ${since}.`;
}

/** "2:14 PM" in `timeZone`, after the short date ("Sun, Nov 15, 11:58 PM") when it is not that zone's today. */
function startedTime(since: string, timeZone: string, now: Date): string {
  const at = new Date(since);
  const minutes = localMinutes(at, timeZone);
  const hours = Math.floor(minutes / 60);
  const time = `${String(hours % 12 === 0 ? 12 : hours % 12)}:${String(minutes % 60).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  const day = localDay(at, timeZone);
  return day === localDay(now, timeZone) ? time : `${shortDate(day)}, ${time}`;
}

const count = (n: number): string => n.toLocaleString('en-US');

/**
 * D65: the model card's updating sentence (design decision 3), null while nothing updates. "Building" only while a
 * first forecast runs, with no day count: the coverage's days include likely-closed ones, so the count would disagree
 * with the card's days with a guest count and the run's own in the history. `waiting` states no time and promises no
 * publish (14.1).
 */
function updatingWords(calibration: Calibration, timeZone: string, now: Date): string | null {
  const { updating } = calibration;
  if (updating === null) return null;
  if (updating.stage === 'waiting') return 'Your first forecast is next. Townwise starts building it soon.';
  const started = startedTime(updating.since, timeZone, now);
  if (calibration.state === 'not_calibrated') return `Building your first forecast, started ${started}.`;
  if (calibration.newerDays === 0) return `Updating your forecast, started ${started}.`;
  const days = calibration.newerDays === 1 ? '1 new day' : `${count(calibration.newerDays)} new days`;
  return `Updating your forecast with ${days}, started ${started}.`;
}

/**
 * Where the state shows (the model card and TownwiseAI's overview tool): words for `stale`, then (D65) the sentence for
 * a forecast being updated, with its start time in `timeZone` (the town's); null when there is neither.
 */
export function calibrationWords(calibration: Calibration, timeZone: string, now: Date): string | null {
  const words = [staleWords(calibration), updatingWords(calibration, timeZone, now)].filter((each) => each !== null);
  return words.length === 0 ? null : words.join(' ');
}

/**
 * The location's calibration state as a read answers it: its coverage, its newest published run (newest dataThrough
 * first) with the days with guests after that run's last day, and the next refresh in the town's today. A stale
 * location whose reference calibration (the weekly refresh's, stores/calibrations.ts) already read every day with
 * guests has no next refresh: that refit was refused, so the next Monday finds the same data and records unchanged, and
 * the words say the days aren't in it yet rather than promise a refit that won't come.
 *
 * D65: it also reads the location's newest calibration for `updating`, and, with no published run, the refit mark
 * unless that calibration is running, the reference only when the mark is due, nextRefreshFor's conditions only with no reference, and, for a
 * `lastRun`, the first published run and the newest calibration's run (only when it succeeded). It never writes.
 */
export async function calibrationFor(
  ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, coverage: Coverage,
): Promise<Calibration> {
  if (coverage.lastDate === null) return calibrationOf(coverage);
  const now = ctx.now();
  // The newest calibration before the published runs, not beside them: the lab publishes a run before it finishes its
  // calibration (lab/service.ts storeDraft), so a calibration read as finished always comes with its run already
  // published. Read side by side, a publish landing between the two could answer not_calibrated with a published
  // lastRun, and the pages' poll, seeing nothing updating, would stop on it.
  const [latest] = await ctx.stores.calibrations.list(scope, 1, location.id);
  const [newest] = await ctx.stores.forecasts.published(scope, location.id);
  const calibration = latest ?? null;
  if (newest === undefined) {
    const refit = calibration !== null && runningAt(calibration, now) ? null : await ctx.stores.locations.refitState(scope, location.id);
    const due = refit !== null && refitDue(refit, now);
    const reference = due ? await ctx.stores.calibrations.reference(scope, location.id) : null;
    const on = due && reference === null && await refreshOn(ctx, scope, location, localDay(now, timeZoneOf(location.town).timeZone));
    const updating = updatingOf(calibration, refit, reference, false, on, now);
    if (updating !== null || calibration === null) return calibrationOf(coverage, null, null, updating);
    const runId = calibration.status === 'succeeded' ? calibration.runId : null;
    const [runs, first] = await Promise.all([
      runId === null ? null : ctx.stores.forecasts.runStates(scope, [runId]), ctx.stores.forecasts.firstPublished(scope, location.id),
    ]);
    const run = runId === null ? null : runs?.get(runId) ?? null;
    return calibrationOf(coverage, null, null, null, lastRunOf(calibration, run, first, null, now));
  }
  const { salesDays } = ctx.stores;
  const newerDays = await salesDays.guestDayCountAfter(scope, location.id, newest.dataThrough);
  let nextRefresh = await nextRefreshFor(ctx, scope, location);
  if (newerDays > 0 && nextRefresh !== null) {
    const read = (await ctx.stores.calibrations.reference(scope, location.id))?.dataThrough ?? null;
    if (read !== null && read > newest.dataThrough && await salesDays.guestDayCountAfter(scope, location.id, read) === 0) nextRefresh = null;
  }
  const updating = updatingOf(calibration, null, null, true, false, now);
  return calibrationOf(coverage, { dataThrough: newest.dataThrough, newerDays }, nextRefresh, updating);
}

/**
 * nextRefreshOf for the location, in the town's today: on while the lab runner is on, TOWNWISE_WEEKLY_FORECASTS is true,
 * staff have not paused the schedule, its organization is active with forecasts on (an absent switch is on, D42), and
 * its history (first to last day with guests, as the lab's input holds it) spans the weekly refresh's 230 days. Under
 * them the schedule only records not_enough_history, so a location with a run published another way (a staff import)
 * is promised no refit.
 */
export async function nextRefreshFor(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord): Promise<string | null> {
  const { timeZone } = timeZoneOf(location.town);
  const now = ctx.now();
  const today = localDay(now, timeZone);
  return nextRefreshOf(today, localMinutes(now, timeZone), await refreshOn(ctx, scope, location, today));
}

/** nextRefreshFor's conditions in the town's `today`; `waiting` (D65) reads the same. */
async function refreshOn(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, today: string): Promise<boolean> {
  const running = ctx.labRunner !== null && ctx.config.weeklyForecasts && (await ctx.stores.forecastSchedule.paused()) === null;
  const org = running ? await ctx.stores.orgs.findById(scope.orgId) : null;
  return org !== null && org.status === 'active' && org.forecasts.on && await refitsHistory(ctx, scope, location.id, today);
}

/** Whether the location's guest span, as the lab's input holds it in the town's `today`, is one the schedule starts. */
async function refitsHistory(ctx: TownwiseContext, scope: OrgScope, locationId: string, today: string): Promise<boolean> {
  const coverage = await ctx.stores.salesDays.coverage(scope, locationId);
  if (coverage.firstDate === null || coverage.lastDate === null) return false;
  const span = guestSpan(await ctx.stores.salesDays.days(scope, locationId, { from: coverage.firstDate, to: coverage.lastDate }), today);
  return span !== null && daysBetween(span.first, span.last) >= GATE.baselineMinHistoryDays;
}
