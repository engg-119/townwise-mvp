// The calendar refresh loop (openspec change connect-owner-calendar: the calendar-subscription spec, design decision 6;
// openspec change connect-google-calendar: the google-calendar spec, design decision 10): a loop in each API replica,
// while TOWNWISE_CALENDAR_KEY is set, that looks for due link and Google calendars every 15 minutes and once shortly
// after start, and claims them one at a time (a lease in Mongo, through stores/cross-tenant.ts) until none is due, the
// longest due first whatever its kind. A link's sealed address is opened (calendar/secret.ts), fetched with the guarded
// fetcher (calendar/fetch.ts) and parsed in the location's town (calendar/ics.ts). A Google calendar is read through
// calendar/google-access.ts's readGoogleSource, the path "Refresh now" takes too: a calendar whose connection is gone is
// removed with its events; a connection whose person holds no seat in the organization any more has its access ended
// (reason seat_gone) without reading Google, and one whose seat was removed moments ago, by a removal that may yet be
// refused (a last admin), is neither read nor ended, nothing is written, and its lease runs out; a revoked connection
// records google_revoked and the Google client off google_unavailable, with no Google call; otherwise Google is read,
// and a refused refresh token marks the connection revoked and a new one replaces the stored one, both in
// google-access.ts, never here. Either way the events are replaced by generation through the tenant store under
// scopeForCalendarRefresh. A success is next due in 6 hours. A failure, a sealed secret the key no longer opens
// (`key_mismatch`) included, keeps the last good events, records its code and backs off: 6 hours after the first
// failure in a row, 24 after two or more. A calendar of a suspended organization (deleting one suspends it first) is
// not read and is looked at again in 6 hours. The location and the calendar are checked before the read and after the
// writes: a calendar whose location is gone, or that is gone itself, keeps nothing this refresh wrote, and a Google
// calendar removed this way has its connection marked for a check first, so a connection left backing nothing is ended
// at the next look.
// After the due calendars, the loop claims due Google connection checks one at a time (checkAt passed, under the same
// lease, scoped by scopeForGoogleCheck): a connection whose person holds no seat in the organization has its access
// ended (seat_gone), one that backs no calendar a day or more after its connect too (unused), and one whose seat was
// removed moments ago is left due for a later look; any other is checked again 24 hours on, or, unused and younger
// than a day, a day after its connect, and only while no mark came in during the check (else it stays due). Every
// connection is looked at at least daily, and at once after any step that may leave it unused or unowned (they mark it
// first), so this check also finishes an end of access, a seat removal or a location deletion that stopped part way.
// Closing drops a link fetch in flight, which may take 10 seconds where a shutdown hook has 2, and aborts every Google
// call in flight through the loop's AbortController (a Google read checks it between pages, and ending access checks it
// before the revoke): nothing is written, and the lease runs out so a later look refreshes the calendar or checks the
// connection. Closing waits for writes in flight, while the database is open. The lease is 5 minutes for every claim:
// a Google read's worst case is one token call and 8 event pages of 10 seconds each (90 seconds) plus writing 2,000
// events, and ending access adds a revoke of 10 seconds, so a claim ends well within it; a longer lease only delays the
// retry of a claim whose replica died.
// Shaped as createCalendarRefresher(deps) so it can move to a job unchanged. Its own log lines carry the calendar id or
// the connection id, the status code, event counts and the duration only: never an address, host, Google calendar id,
// label, title or token. Google's lines (a failed call, a failed revoke, an ended access) are written by
// google-access.ts.
import type { KeyObject } from 'node:crypto';

import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import { scopeForCalendarRefresh, scopeForGoogleCheck, type OrgScope } from '../access/policy.ts';
import { claimDueCalendar, claimDueGoogleConnection, type ClaimedCalendar, type ClaimedGoogleConnection } from '../stores/cross-tenant.ts';
import { CHECK_INTERVAL_MS } from '../stores/google-connections.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { LocationRecord } from '../stores/locations.ts';
import { REFRESH_INTERVAL_MS, type CalendarFailure, type ParsedCalendar, type ReplaceResult } from '../stores/owner-calendars.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { createCalendarFetcher, type CalendarFetcher, type CalendarFetchResult } from './fetch.ts';
import { followLinkedNotes } from './follow-up.ts';
import type { GoogleCalendarClient, revokeGoogleGrant } from './google.ts';
import { endGoogleAccess, endUnusedGoogleAccess, markCalendarForCheck, readGoogleSource, seatOf, type GoogleAccessDeps } from './google-access.ts';
import { parseIcs, type IcsTown } from './ics.ts';
import { open } from './secret.ts';

export interface CalendarRefresherDeps {
  readonly connection: Connection;
  readonly stores: TownwiseStores;
  /** TOWNWISE_CALENDAR_KEY, which opens the sealed addresses, Google calendar ids and tokens; main.ts builds the loop only when it is set. */
  readonly key: KeyObject;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Absent, calendar/fetch.ts's guarded fetcher. Tests pass one. */
  readonly fetcher?: CalendarFetcher;
  /**
   * Google's token and events endpoints (calendar/google.ts); null or absent while Google calendars are off, when a
   * Google calendar records google_unavailable and keeps its events. Tests pass a fake.
   */
  readonly googleCalendar?: GoogleCalendarClient | null | undefined;
  /**
   * Revokes a grant when the loop ends access (calendar/google.ts revokeGoogleGrant), Google calendars on or off (design
   * decision 14); null or absent, nothing is revoked. Tests pass a fake.
   */
  readonly revokeGoogle?: typeof revokeGoogleGrant | null | undefined;
  /** How often the loop looks for due calendars; tests shorten it. */
  readonly tickMs?: number;
  /** The first look after start; tests shorten it. */
  readonly firstTickMs?: number;
}

export interface CalendarRefresher {
  start(): void;
  /**
   * Refreshes due calendars, then checks due Google connections, one at a time until none is due, and resolves how many
   * it claimed of both. A call while one runs joins it. Never rejects.
   */
  drain(): Promise<number>;
  /**
   * Stops the loop, drops a link fetch and aborts a Google call in flight (its claim's lease runs out), and waits for the
   * writes still running.
   */
  close(): Promise<void>;
  readonly name: string;
}

const TICK_MS = 15 * 60_000;
const FIRST_TICK_MS = 30_000;
/**
 * A claim's hold on a calendar or a connection check: well past a link fetch's 10 seconds, and past a Google read's
 * worst case (a token call and 8 event pages, 10 seconds each, then writing 2,000 events) or a revoke's 10 seconds.
 */
const LEASE_MS = 5 * 60_000;
/** The wait after two or more failures in a row. */
const BACKOFF_MS = 24 * 60 * 60_000;

/** When a calendar is next due after a refresh at `at` that left `failuresInARow` failures in a row (0 after a success). */
function nextRefreshAt(at: Date, failuresInARow: number): Date {
  return new Date(at.getTime() + (failuresInARow >= 2 ? BACKOFF_MS : REFRESH_INTERVAL_MS));
}

/** The location's town, as the parser and the Google read take it: its today and its time zone. */
function townOf(location: LocationRecord, at: Date): IcsTown {
  const { timeZone } = timeZoneOf(location.town);
  return { today: localDay(at, timeZone), timeZone };
}

type Read = { readonly ok: true; readonly parsed: ParsedCalendar } | { readonly ok: false; readonly code: CalendarFailure };

/**
 * Why a claimed calendar wrote nothing: `removed` (it, or its location, is gone, or its access ended), `org_inactive`,
 * `stopped` (the loop closed mid-read), or `unsettled` (its Google connection's person lost their seat moments ago).
 */
type Skip = 'removed' | 'org_inactive' | 'stopped' | 'unsettled';

export function createCalendarRefresher(deps: CalendarRefresherDeps): CalendarRefresher {
  const { stores, logger, now } = deps;
  const calendars = stores.ownerCalendars;
  const fetcher = deps.fetcher ?? createCalendarFetcher();
  /** Aborted by close: ends a Google call in flight, and stops a Google read between pages and before a revoke. */
  const closing = new AbortController();
  /** Google access as the loop uses it: its own deps, no TownwiseContext, every Google call under the close signal. */
  const google: GoogleAccessDeps = {
    connection: deps.connection, stores, key: deps.key, logger, now, client: deps.googleCalendar ?? null, revoke: deps.revokeGoogle ?? null,
    signal: closing.signal,
  };
  let stopped = false;
  /** Set while a link fetch is in flight: answers it `stopped` at once, so close does not wait for it. */
  let dropFetch: (() => void) | null = null;
  let running: Promise<number> | null = null;
  let first: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;

  /** A link: its address opened, fetched and parsed in the location's town; `stopped` once close is called. */
  async function readLink(scope: OrgScope, claim: ClaimedCalendar, location: LocationRecord): Promise<Read | Skip> {
    const sealed = await calendars.sealedAddress(scope, claim.locationId, claim.calendarId);
    if (sealed === null) return 'removed';
    const address = open(deps.key, sealed);
    if (!address.ok) return address;
    if (stopped) return 'stopped';
    const fetched = await new Promise<CalendarFetchResult | 'stopped'>((resolve, reject) => {
      dropFetch = () => { resolve('stopped'); };
      fetcher.fetch(address.text).then(resolve, reject);
    }).finally(() => { dropFetch = null; });
    if (fetched === 'stopped') return fetched;
    if (!fetched.ok) return fetched;
    const parsed = parseIcs(fetched.text, townOf(location, now()));
    return 'error' in parsed ? { ok: false, code: parsed.error } : { ok: true, parsed };
  }

  /**
   * A Google calendar, through google-access.ts (design decision 10): gone, or its access ended, is `removed` (the
   * calendar already went with its events); a seat removed moments ago is `unsettled`; a read the close aborted is
   * `stopped`; otherwise its events or the status it records.
   */
  async function readGoogle(scope: OrgScope, claim: ClaimedCalendar, location: LocationRecord): Promise<Read | Skip> {
    const source = await readGoogleSource(google, scope, claim.locationId, claim.calendarId, townOf(location, now()));
    if (source.kind === 'unsettled') return 'unsettled';
    if (source.kind !== 'read') return 'removed';
    const { read } = source;
    if (read.ok) return read;
    return read.code === 'stopped' ? 'stopped' : { ok: false, code: read.code };
  }

  /** One claimed calendar, from its lease to its release. */
  async function refresh(claim: ClaimedCalendar, leaseUntil: Date): Promise<void> {
    const startedAt = now();
    const scope = scopeForCalendarRefresh(claim);
    const { calendarId, locationId } = claim;
    const skipped = (reason: Skip): void => {
      logger.info({ calendarId, reason }, 'townwise.calendar_refresh_skipped');
    };
    /**
     * The calendar's events, the calendar, and its events again: what a location's deletion would take. A Google
     * calendar's connection is marked for a check first, so one left backing nothing is ended at the next look.
     */
    const removed = async (): Promise<void> => {
      if (claim.kind === 'google') await markCalendarForCheck(google, scope, locationId, calendarId);
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
    const result = claim.kind === 'google' ? await readGoogle(scope, claim, location) : await readLink(scope, claim, location);
    // Gone, closed mid-read, or a seat not yet settled: nothing is written, and a live calendar's lease runs out.
    if (typeof result === 'string') {
      skipped(result);
      return;
    }
    const at = now();
    // The store's replace switches only a calendar still there, and a failure updates one, so neither writes a new one.
    let replaced: ReplaceResult | null = null;
    if (result.ok) replaced = await calendars.replaceEvents(scope, locationId, calendarId, result.parsed, at);
    else await calendars.recordFailure(scope, locationId, calendarId, result.code, at);
    // After: a location or calendar removed meanwhile keeps nothing this refresh wrote.
    const after = await calendars.find(scope, locationId, calendarId);
    if (after === null || (await stores.locations.find(scope, locationId)) === null) return removed();
    // Notes linked to its events follow them (calendar-event-suggestions); never fails the refresh.
    if (replaced?.switched === true) await followLinkedNotes({ stores, logger }, scope, location, calendarId, replaced, at);
    await calendars.releaseRefresh(scope, locationId, calendarId, {
      leaseUntil, nextRefreshAt: nextRefreshAt(at, result.ok ? 0 : after.consecutiveFailures),
    });
    logger.info({
      calendarId, status: result.ok ? 'ok' : result.code, eventCount: after.eventCount, skippedRepeating: after.skippedRepeating,
      durationMs: now().getTime() - startedAt.getTime(),
    }, 'townwise.calendar_refreshed');
  }

  /**
   * One claimed connection check (design decision 10): no seat in the organization ends the access (seat_gone), a seat
   * removed moments ago leaves it due for a later look (nothing is written, so the lease runs out first), no calendar a
   * day or more after its connect ends it (unused), and otherwise it is checked again 24 hours on, or, unused and
   * younger than that, a day after its connect (a last admin's refused removal marks a new one, and changes nothing).
   * The next check is set only while checkAt is still the one claimed: a mark written during the check (a calendar
   * removed, a seat lost) leaves the connection due, and the next look checks it again.
   */
  async function check(claim: ClaimedGoogleConnection, leaseUntil: Date): Promise<void> {
    const scope = scopeForGoogleCheck(claim);
    const { connectionId } = claim;
    const found = await stores.googleConnections.find(scope, connectionId);
    // Ended meanwhile: nothing is left to check.
    if (found === null) return;
    const seat = await seatOf(google, scope, found.userId);
    if (seat === 'unsettled') return;
    if (seat === 'gone') {
      await endGoogleAccess(google, scope, connectionId, 'seat_gone');
      return;
    }
    const at = now();
    const unusedUntil = new Date(found.connectedAt.getTime() + CHECK_INTERVAL_MS);
    let nextCheckAt = new Date(at.getTime() + CHECK_INTERVAL_MS);
    if (at.getTime() < unusedUntil.getTime()) {
      if ((await calendars.countForConnection(scope, connectionId)) === 0) nextCheckAt = unusedUntil;
    } else if ((await endUnusedGoogleAccess(google, scope, connectionId, 'unused')) !== null) {
      return;
    }
    await stores.googleConnections.releaseCheck(scope, connectionId, { leaseUntil, checkAt: claim.checkAt, nextCheckAt });
  }

  async function drainDue(): Promise<number> {
    let claimed = 0;
    const errType = (err: unknown): string => (err instanceof Error ? err.name : 'unknown');
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
          logger.error({ calendarId: claim.calendarId, errType: errType(err) }, 'townwise.calendar_refresh_failed');
        }
      }
      while (!stopped) {
        const at = now();
        const leaseUntil = new Date(at.getTime() + LEASE_MS);
        const claim = await claimDueGoogleConnection(deps.connection, { now: at, leaseUntil });
        if (claim === null) break;
        claimed += 1;
        try {
          await check(claim, leaseUntil);
        } catch (err) {
          // The lease runs out and a later look checks it again.
          logger.error({ connectionId: claim.connectionId, errType: errType(err) }, 'townwise.calendar_refresh_failed');
        }
      }
    } catch (err) {
      logger.error({ errType: errType(err) }, 'townwise.calendar_refresh_failed');
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
      closing.abort();
      dropFetch?.();
      clearTimeout(first);
      clearInterval(timer);
      await running;
    },
  };
  return refresher;
}
