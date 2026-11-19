// A calendar refresh brings the weekly pass forward (D59 slice 3, openspec change auto-apply-agent-reads design
// decisions 1 and 4): when a link or Google calendar's refresh (the refresh loop, or Refresh now) switches in events that
// add a keyed event, or move one, on a day from tomorrow to today plus 91 in the town, the location is marked
// (stores/locations.ts `earlyPass`, `$max`). Nothing is sent from here: the hourly worker pass (lab/schedule.ts) runs that
// location's weekly suggestions early, at most once a day, while TOWNWISE_AGENT_AUTO, the organization's `agentAuto`, its
// weekly suggestions and its calendar titles switch are all on, and otherwise clears the mark. Never throws: a failure is
// logged by the calendar's id, and the refresh it follows stands. Logs carry the calendar id and a count only.
import type { Logger } from '@ckeith26/server-core';

import type { OrgScope } from '../access/policy.ts';
import { utcDay } from '../dates.ts';
import { SUGGESTIONS_DAYS } from '../lab/suggestions.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { LocationRecord } from '../stores/locations.ts';
import type { ChangedDates } from '../stores/owner-calendars.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';

/** How many of `changed` touch a day from tomorrow to `today` plus 91 (the days a weekly pass reviews). Pure. */
export function changedAhead(changed: readonly ChangedDates[], today: string): number {
  const at = new Date(`${today}T00:00:00.000Z`);
  const from = utcDay(at, 1);
  const to = utcDay(at, SUGGESTIONS_DAYS);
  return changed.filter((each) => each.startDate <= to && each.endDate >= from).length;
}

/** Marks the location's weekly pass to be brought forward when `changed` touches the days ahead (see the top). */
export async function bringPassForward(
  deps: { readonly stores: TownwiseStores; readonly logger: Logger }, scope: OrgScope, location: LocationRecord, calendarId: string,
  changed: readonly ChangedDates[], now: Date,
): Promise<void> {
  try {
    const ahead = changedAhead(changed, localDay(now, timeZoneOf(location.town).timeZone));
    if (ahead === 0) return;
    if (await deps.stores.locations.wantEarlyPass(scope, location.id, now)) {
      deps.logger.info({ calendarId, changed: ahead }, 'townwise.weekly_pass_brought_forward');
    }
  } catch {
    deps.logger.warn({ calendarId }, 'townwise.weekly_pass_forward_failed');
  }
}
