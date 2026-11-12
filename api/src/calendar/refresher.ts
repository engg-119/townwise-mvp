// The calendar refresh loop (openspec change connect-owner-calendar: the calendar-subscription spec, design decision 6):
// a loop in each API replica, while TOWNWISE_CALENDAR_KEY is set, that looks for due link calendars every 15 minutes
// and once shortly after start, and claims them one at a time (a lease in Mongo, through stores/cross-tenant.ts) until
// none is due. For each it opens the sealed address (calendar/secret.ts), fetches it with the guarded fetcher
// (calendar/fetch.ts), parses it in the location's town (calendar/ics.ts) and replaces the events by generation, through
// the tenant store under scopeForCalendarRefresh. A success is next due in 6 hours. A failure, an address the key no
// longer opens (`key_mismatch`) included, keeps the last good events, records its code and backs off: 6 hours after
// the first failure in a row, 24 after two or more. A calendar of a suspended organization (deleting one suspends it
// first) is not fetched and is looked at again in 6 hours. The location and the calendar are checked before the fetch
// and after the writes: a calendar whose location is gone, or that is gone itself, keeps nothing this refresh wrote.
// Shaped as createCalendarRefresher(deps) so it can move to a job unchanged. Logs carry the calendar id, the status
// code, event counts and the duration only: never an address, host, label or title.
import type { KeyObject } from 'node:crypto';

import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { scopeForCalendarRefresh } from '../access/policy.ts';
import { claimDueCalendar, type ClaimedCalendar } from '../stores/cross-tenant.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { REFRESH_INTERVAL_MS, type CalendarFailure, type ParsedCalendar } from '../stores/owner-calendars.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { createCalendarFetcher, type CalendarFetcher } from './fetch.ts';
import { parseIcs, type IcsTown } from './ics.ts';
import { open } from './secret.ts';

export interface CalendarRefresherDeps {
  readonly connection: Connection;
  readonly stores: TownwiseStores;
  /** TOWNWISE_CALENDAR_KEY, which opens the sealed addresses; main.ts builds the loop only when it is set. */
  readonly key: KeyObject;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Absent, calendar/fetch.ts's guarded fetcher. Tests pass one. */
  readonly fetcher?: CalendarFetcher;
  /** How often the loop looks for due calendars; tests shorten it. */
  readonly tickMs?: number;
  /** The first look after start; tests shorten it. */
  readonly firstTickMs?: number;
}

export interface CalendarRefresher {
  start(): void;
  /**
   * Refreshes due calendars one at a time until none is due, and resolves how many it claimed. A call while one runs
   * joins it. Never rejects.
   */
  drain(): Promise<number>;
  /** Stops the loop and waits for a drain still running. */
  close(): Promise<void>;
  readonly name: string;
}

const TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 30_000;
/** A claim's hold on a calendar: well past a fetch's 10 seconds and the writes after it. */
const LEASE_MS = 2 * 60_000;
/** The wait after two or more failures in a row. */
const BACKOFF_MS = 24 * 60 * 60_000;

/** When a link is next due after a refresh at `at` that left `failuresInARow` failures in a row (0 after a success). */
function nextRefreshAt(at: Date, failuresInARow: number): Date {
  return new Date(at.getTime() + (failuresInARow >= 2 ? BACKOFF_MS : REFRESH_INTERVAL_MS));
}

/** The location's town, as the parser reads it: its today and its time zone. */
function townOf(location: LocationRecord, at: Date): IcsTown {
  const { timeZone } = timeZoneOf(location.town);
  return { today: localDay(at, timeZone), timeZone };
}

type Read = { readonly ok: true; readonly parsed: ParsedCalendar } | { readonly ok: false; readonly code: CalendarFailure };

export function createCalendarRefresher(deps: CalendarRefresherDeps): CalendarRefresher {
  const { stores, logger, now } = deps;
  const calendars = stores.ownerCalendars;
  const fetcher = deps.fetcher ?? createCalendarFetcher();
  let stopped = false;
  let running: Promise<number> | null = null;
  let first: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;

  /** Opens the address, fetches it, and parses what it answers in the location's town. */
  async function read(sealed: string, location: LocationRecord): Promise<Read> {
    const address = open(deps.key, sealed);
    if (!address.ok) return address;
    const fetched = await fetcher.fetch(address.text);
    if (!fetched.ok) return fetched;
    const parsed = parseIcs(fetched.text, townOf(location, now()));
    return 'error' in parsed ? { ok: false, code: parsed.error } : { ok: true, parsed };
  }

  /** One claimed calendar, from its lease to its release. */
  async function refresh(claim: ClaimedCalendar, leaseUntil: Date): Promise<void> {
    const startedAt = now();
    const scope = scopeForCalendarRefresh(claim);
    const { calendarId, locationId } = claim;
    const skipped = (reason: 'removed' | 'org_inactive'): void => {
      logger.info({ calendarId, reason }, 'townwise.calendar_refresh_skipped');
    };
    /** The calendar's events, the calendar, and its events again: what a location's deletion would take. */
    const removed = async (): Promise<void> => {
      await calendars.remove(scope, locationId, calendarId);
      skipped('removed');
    };
    // Before: a location being deleted (or deleted) has nothing left that could read its calendar, so it goes now.
    const location = await stores.locations.find(scope, locationId);
    if (location === null) return removed();
    if ((await stores.orgs.findById(claim.orgId))?.status !== 'active') {
      await calendars.releaseRefresh(scope, locationId, calendarId, { leaseUntil, nextRefreshAt: nextRefreshAt(startedAt, 0) });
      skipped('org_inactive');
      return;
    }
    const sealed = await calendars.sealedAddress(scope, locationId, calendarId);
    if (sealed === null) {
      skipped('removed');
      return;
    }
    const result = await read(sealed, location);
    const at = now();
    // The store's replace switches only a calendar still there, and a failure updates one, so neither writes a new one.
    if (result.ok) await calendars.replaceEvents(scope, locationId, calendarId, result.parsed, at);
    else await calendars.recordFailure(scope, locationId, calendarId, result.code, at);
    // After: a location or calendar removed meanwhile keeps nothing this refresh wrote.
    const after = await calendars.find(scope, locationId, calendarId);
    if (after === null || (await stores.locations.find(scope, locationId)) === null) return removed();
    await calendars.releaseRefresh(scope, locationId, calendarId, {
      leaseUntil, nextRefreshAt: nextRefreshAt(at, result.ok ? 0 : after.consecutiveFailures),
    });
    logger.info({
      calendarId, status: result.ok ? 'ok' : result.code, eventCount: after.eventCount, skippedRepeating: after.skippedRepeating,
      durationMs: now().getTime() - startedAt.getTime(),
    }, 'townwise.calendar_refreshed');
  }

  async function drainDue(): Promise<number> {
    let claimed = 0;
    try {
      while (!stopped) {
        const at = now();
        const leaseUntil = new Date(at.getTime() + LEASE_MS);
        const claim = await claimDueCalendar(deps.connection, { now: at, leaseUntil });
        if (claim === null) break;
        claimed += 1;
        try {
          await refresh(claim, leaseUntil);
        } catch (err) {
          // The lease runs out and a later look tries it again.
          logger.error({ calendarId: claim.calendarId, errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.calendar_refresh_failed');
        }
      }
    } catch (err) {
      logger.error({ errType: err instanceof Error ? err.name : 'unknown' }, 'townwise.calendar_refresh_failed');
    }
    return claimed;
  }

  const refresher: CalendarRefresher = {
    name: 'calendar-refresher',
    start() {
      first = setTimeout(() => { void refresher.drain(); }, deps.firstTickMs ?? FIRST_TICK_MS);
      first.unref();
      timer = setInterval(() => { void refresher.drain(); }, deps.tickMs ?? TICK_MS);
      timer.unref();
    },
    drain() {
      if (stopped) return Promise.resolve(0);
      running ??= drainDue().finally(() => { running = null; });
      return running;
    },
    async close() {
      stopped = true;
      clearTimeout(first);
      clearInterval(timer);
      await running;
    },
  };
  return refresher;
}
