// Calibration states (spec 14.1, 14.3): derived from a location's own sales data and its newest published forecast on
// every read, never stored. No forecast, no progress, no “calibrating” and no day threshold until a run is published
// (14.2). Once one is (D42), `calibrated` when its last day of data is the last day with guests, `stale` when days with
// guests came after it, each with the Monday the weekly refresh next considers the location (none for a stale one whose
// days a refused refit already read). Notes and rules are left out of `stale` on purpose: they act on the forecast at
// read time (14.5). queued, calibrating and failed stay reserved.
import type { OrgScope } from './access/policy.ts';
import type { TownwiseContext } from './app.ts';
import { daysBetween, utcDay } from './dates.ts';
import { GATE } from './lab/gate.ts';
import { guestSpan } from './lab/input.ts';
import { shortDate } from './orders/dates.ts';
import type { LocationRecord } from './stores/locations.ts';
import type { Coverage } from './stores/sales-days.ts';
import { localDay, localMinutes, timeZoneOf } from './time-zones.ts';

/** A location's week starts at this hour on Monday, in its town's time zone (lab/schedule.ts). */
export const SCHEDULE_START_HOUR = 3;

interface HistoryFields { dayCount: number; firstDate: string; lastDate: string }
interface PublishedFields extends HistoryFields { dataThrough: string; newerDays: number; nextRefresh: string | null }

export type Calibration =
  | { state: 'no_sales_data' }
  | ({ state: 'not_calibrated' } & HistoryFields)
  | ({ state: 'calibrated' | 'stale' } & PublishedFields);

/** The newest published run's last day of data, and the days with guests after it. */
export interface PublishedFacts { dataThrough: string; newerDays: number }

/**
 * [DECISION NEEDED: minimum days of history before calibration] Until it is decided, no threshold applies.
 * `published` is the newest published run's facts (null without one); `nextRefresh` is nextRefreshOf's.
 */
export function calibrationOf(coverage: Coverage, published: PublishedFacts | null = null, nextRefresh: string | null = null): Calibration {
  if (coverage.dayCount === 0 || coverage.firstDate === null || coverage.lastDate === null) return { state: 'no_sales_data' };
  const history = { dayCount: coverage.dayCount, firstDate: coverage.firstDate, lastDate: coverage.lastDate };
  if (published === null) return { state: 'not_calibrated', ...history };
  return { state: published.newerDays > 0 ? 'stale' : 'calibrated', ...history, ...published, nextRefresh };
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

/** Where the state shows (the model card and TownwiseAI): words for `stale`, null for every other state. */
export function calibrationWords(calibration: Calibration): string | null {
  if (calibration.state !== 'stale') return null;
  const made = `Forecast made from your sales through ${shortDate(calibration.dataThrough)}.`;
  const since = daysSince(calibration.newerDays);
  if (calibration.nextRefresh === null) {
    return `${made} ${since.charAt(0).toUpperCase()}${since.slice(1)} ${calibration.newerDays === 1 ? 'isn’t' : 'aren’t'} in it yet.`;
  }
  return `${made} Townwise refits on ${shortDate(calibration.nextRefresh)} with ${since}.`;
}

/**
 * The location's calibration state as a read answers it: its coverage, its newest published run (newest dataThrough
 * first) with the days with guests after that run's last day, and the next refresh in the town's today. A stale
 * location whose reference calibration (the weekly refresh's, stores/calibrations.ts) already read every day with
 * guests has no next refresh: that refit was refused, so the next Monday finds the same data and records unchanged, and
 * the words say the days aren't in it yet rather than promise a refit that won't come.
 */
export async function calibrationFor(
  ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, coverage: Coverage,
): Promise<Calibration> {
  if (coverage.lastDate === null) return calibrationOf(coverage);
  const [newest] = await ctx.stores.forecasts.published(scope, location.id);
  if (newest === undefined) return calibrationOf(coverage);
  const { salesDays } = ctx.stores;
  const newerDays = await salesDays.guestDayCountAfter(scope, location.id, newest.dataThrough);
  let nextRefresh = await nextRefreshFor(ctx, scope, location);
  if (newerDays > 0 && nextRefresh !== null) {
    const read = (await ctx.stores.calibrations.reference(scope, location.id))?.dataThrough ?? null;
    if (read !== null && read > newest.dataThrough && await salesDays.guestDayCountAfter(scope, location.id, read) === 0) nextRefresh = null;
  }
  return calibrationOf(coverage, { dataThrough: newest.dataThrough, newerDays }, nextRefresh);
}

/**
 * nextRefreshOf for the location, in the town's today: on while the lab runner is on, TOWNWISE_WEEKLY_FORECASTS is true,
 * staff have not paused the schedule, its organization is active with forecasts on (an absent switch is on, D42), and
 * its history (first to last day with guests, as the lab's input holds it) spans the weekly refresh's 230 days. Under
 * them the schedule only records not_enough_history, so a location with a run published another way (a staff import)
 * is promised no refit.
 */
export async function nextRefreshFor(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord): Promise<string | null> {
  const running = ctx.labRunner !== null && ctx.config.weeklyForecasts && (await ctx.stores.forecastSchedule.paused()) === null;
  const org = running ? await ctx.stores.orgs.findById(scope.orgId) : null;
  const { timeZone } = timeZoneOf(location.town);
  const now = ctx.now();
  const today = localDay(now, timeZone);
  const on = org !== null && org.status === 'active' && org.forecasts.on && await refitsHistory(ctx, scope, location.id, today);
  return nextRefreshOf(today, localMinutes(now, timeZone), on);
}

/** Whether the location's guest span, as the lab's input holds it in the town's `today`, is one the schedule starts. */
async function refitsHistory(ctx: TownwiseContext, scope: OrgScope, locationId: string, today: string): Promise<boolean> {
  const coverage = await ctx.stores.salesDays.coverage(scope, locationId);
  if (coverage.firstDate === null || coverage.lastDate === null) return false;
  const span = guestSpan(await ctx.stores.salesDays.days(scope, locationId, { from: coverage.firstDate, to: coverage.lastDate }), today);
  return span !== null && daysBetween(span.first, span.last) >= GATE.baselineMinHistoryDays;
}
