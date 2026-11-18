// The active days recorder (openspec change staff-overview, design decisions 2 and 3): the route chain calls it once a
// request has passed its policy (routes.ts authorize, after recordResolution), never resolveAccess, which stays a pure
// read. It records only a member or org admin on their own seat: not staff, not view-as (whose principal carries the
// target's id), not open as admin, and nobody without a seat. Each replica keeps the `<orgId>:<userId>:<day>` keys it has
// written today and writes a key at most once while its write succeeds; the write is never awaited, so it never delays
// or fails the request, and a failure logs the organization id and the error's code, then drops its key so the next
// request tries again. The first write of each UTC day also removes rows dated before the 180 days kept. Ids and counts
// only reach the log.
import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { utcDay } from '../dates.ts';
import type { ActivityDayStore } from '../stores/activity-days.ts';
import { removeOldActivityDays } from '../stores/cross-tenant.ts';
import type { Principal } from './policy.ts';

/**
 * Days kept: today and the 179 before it (owner, 2026-11-17). [CONFIRM: Townwise keeps the dates on which each signed-in
 * person used the app, for 180 days]
 */
export const ACTIVITY_KEEP_DAYS = 180;

export interface ActivityRecorder {
  /** Records the principal's active day when it is a member on their own seat. Returns at once; never throws. */
  record(principal: Principal): void;
  /** Resolves when every write started so far has settled: for tests. */
  idle(): Promise<void>;
}

/** Records nothing: the test harness's default, so other suites' write checks stay about their own routes. */
export const OFF_ACTIVITY: ActivityRecorder = {
  record: () => undefined,
  idle: () => Promise.resolve(),
};

/** The error's own code (a Mongo number or a driver string), never its message. */
function codeOf(err: unknown): number | string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'number' || typeof code === 'string' ? code : 'internal';
}

export function createActivityRecorder(deps: {
  connection: Connection;
  activityDays: Pick<ActivityDayStore, 'record'>;
  logger: Logger;
  now: () => Date;
}): ActivityRecorder {
  const inFlight = new Set<Promise<void>>();
  const written = new Set<string>();
  let today: string | null = null;

  const track = (work: Promise<void>): void => {
    const settled = work.finally(() => inFlight.delete(settled));
    inFlight.add(settled);
  };

  return {
    record(principal) {
      if (principal.kind !== 'member' || principal.memberId === null || principal.viewAs !== null || principal.openAsAdmin !== null) return;
      const at = deps.now();
      const day = utcDay(at);
      if (day !== today) {
        today = day;
        written.clear();
        // The first write of the day: rows before today's 180 days go, every organization's.
        track(removeOldActivityDays(deps.connection, utcDay(at, -(ACTIVITY_KEEP_DAYS - 1))).then(
          (deleted) => { deps.logger.info({ deleted }, 'townwise.activity_days_removed'); },
          (err: unknown) => { deps.logger.warn({ code: codeOf(err) }, 'townwise.activity_days_remove_failed'); },
        ));
      }
      const { scope } = principal;
      // The organization is in the key, as in the row's id: someone who joins another organization that day counts there too.
      const key = `${scope.orgId}:${principal.userId}:${day}`;
      if (written.has(key)) return;
      written.add(key);
      track(deps.activityDays.record(scope, principal.userId, day).catch((err: unknown) => {
        written.delete(key);
        deps.logger.warn({ orgId: scope.orgId, code: codeOf(err) }, 'townwise.activity_write_failed');
      }));
    },
    idle: async () => {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}
