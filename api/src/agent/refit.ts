// Refit wanted (D59, openspec change auto-apply-agent-reads design decision 12): a change that can move the forecast
// lab's input marks the location, and the hourly worker pass (lab/schedule.ts) refits it once things are quiet. A note
// or rule touching only days after the location's last stored day changes the forecast on read (forecasts/adjust.ts)
// and marks nothing. Nothing here logs or sends anything anywhere.
import type { OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';

/** The dates a change touches, both counted. */
export interface TouchedDates { readonly startDate: string; readonly endDate: string }

/**
 * Marks the location as wanting a refit when `touched` reaches a day on or before its last stored sales day (`'always'`:
 * a sales upload, which always changes the training days). Resolves whether it marked.
 */
export async function wantRefitFor(
  ctx: Pick<TownwiseContext, 'stores' | 'now'>, scope: OrgScope, locationId: string, touched: TouchedDates | 'always',
): Promise<boolean> {
  if (touched !== 'always') {
    const { lastDate } = await ctx.stores.salesDays.coverage(scope, locationId);
    if (lastDate === null || touched.startDate > lastDate) return false;
  }
  return ctx.stores.locations.wantRefit(scope, locationId, ctx.now());
}
