// Calibration states (spec 14.1, 14.3): derived from a location's own sales data and its newest published forecast on
// every read, never stored. No forecast, no progress, no “calibrating” and no day threshold until a run is published
// (14.2). Once one is (D42), `calibrated` when its last day of data is the last day with guests, `stale` when days with
// guests came after it, each with the Monday the weekly refresh next considers the location. Notes and rules are left
// out of `stale` on purpose: they act on the forecast at read time (14.5). queued, calibrating and failed stay reserved.
import type { OrgScope } from './access/policy.ts';
import type { TownwiseContext } from './app.ts';
import { utcDay } from './dates.ts';
import { shortDate } from './orders/dates.ts';
import type { LocationRecord } from './stores/locations.ts';
import type { Coverage } from './stores/sales-days.ts';
import { localDay, timeZoneOf } from './time-zones.ts';

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
 * The Monday the weekly refresh next considers a location (D42): the first Monday after the town's `today`, or null
 * while it is off. `on` is the lab runner on and the organization active with its forecasts on; phase 3b adds
 * TOWNWISE_WEEKLY_FORECASTS and the staff pause. On a Monday it is the next one, the day's pass (from 03:00) having had
 * its turn.
 */
export function nextRefreshOf(today: string, on: boolean): string | null {
  if (!on) return null;
  const weekday = new Date(`${today}T00:00:00.000Z`).getUTCDay();
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
 * first) with the days with guests after that run's last day, and the next refresh in the town's today.
 */
export async function calibrationFor(
  ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, coverage: Coverage,
): Promise<Calibration> {
  if (coverage.lastDate === null) return calibrationOf(coverage);
  const [newest] = await ctx.stores.forecasts.published(scope, location.id);
  if (newest === undefined) return calibrationOf(coverage);
  const newerDays = await ctx.stores.salesDays.guestDayCountAfter(scope, location.id, newest.dataThrough);
  return calibrationOf(coverage, { dataThrough: newest.dataThrough, newerDays }, await nextRefreshFor(ctx, scope, location));
}

/** nextRefreshOf for the location: the lab runner on and its organization active with forecasts on, in the town's today. */
export async function nextRefreshFor(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord): Promise<string | null> {
  const org = ctx.labRunner === null ? null : await ctx.stores.orgs.findById(scope.orgId);
  const on = org !== null && org.status === 'active' && org.forecasts.on;
  return nextRefreshOf(localDay(ctx.now(), timeZoneOf(location.town).timeZone), on);
}
