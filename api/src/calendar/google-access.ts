// Every use of a stored Google token (openspec change connect-google-calendar: the google-calendar spec, design
// decisions 7, 10 and 11). This is the one file that opens a connection's sealed refresh token, replaces it when Google
// sends a new one, or revokes a grant, and the one writer of Townwise's three Google log lines, so a token is read in
// one place and every Google line's fields are pinned in one place (test/isolation.test.ts). The refresh loop, "Refresh
// now", the add, connect, the picker's list, seat loss, and location, organization and person deletion all come here.
// Handlers build the deps from their context (googleAccessDeps); the refresh loop, which has no context, builds its own
// with its close signal, and every Google call takes that signal.
//
// Why endGoogleAccess runs in its order: it marks the connection for a check first, so a request that stops part way
// is finished by the refresh loop's connection check (checkAt now); it removes the Google calendars the connection
// backs (events first), so a departed person's events leave the location before anything else; it revokes at Google,
// best effort; it deletes the row whether or not the revoke worked, so Townwise holds nothing; and it logs. A retry or
// the check completes any step left, and a closed loop stops before the revoke, leaving the mark.
// Why the other-organization rule: Google's revoke ends every grant the account gave the project, so a row in one
// organization is deleted without revoking while the same person holds a connection in another (cross-tenant's
// hasGoogleConnectionElsewhere).
// Logs carry ids, counts, Google's HTTP status and the client's fixed codes only: never a token, a code, a calendar id,
// an email address, a name, a title, a URL or Google's error body.
import type { KeyObject } from 'node:crypto';

import type { Logger } from '@ckeith26/server-core';
import type { Connection } from 'mongoose';

import type { OrgScope } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { findActiveSeat, hasGoogleConnectionElsewhere } from '../stores/cross-tenant.ts';
import type { GoogleConnectionRecord } from '../stores/google-connections.ts';
import type { TownwiseStores } from '../stores/index.ts';
import type { CalendarFailure, ParsedCalendar } from '../stores/owner-calendars.ts';
import { GoogleCalendarError, type GoogleCalendarClient, type revokeGoogleGrant } from './google.ts';
import { readGoogleCalendar } from './google-events.ts';
import type { IcsTown } from './ics.ts';
import { open, seal } from './secret.ts';

export interface GoogleAccessDeps {
  readonly connection: Connection;
  readonly stores: TownwiseStores;
  /** TOWNWISE_CALENDAR_KEY; null when unset, when no stored token or calendar id opens. */
  readonly key: KeyObject | null;
  readonly logger: Logger;
  readonly now: () => Date;
  /** Null while Google calendars are off. */
  readonly client: GoogleCalendarClient | null;
  /** Null when nothing can be revoked (no TOWNWISE_CALENDAR_KEY in main.ts, or a test that passes none). */
  readonly revoke: typeof revokeGoogleGrant | null;
  /** The refresh loop's close: aborts a Google call in flight, and stops before a revoke. */
  readonly signal?: AbortSignal | undefined;
}

/** Why access ended, as `townwise.google_access_ended` and `google_calendar.disconnected` carry it. */
export type GoogleEndReason =
  | 'seat_removed' | 'left' | 'seat_gone' | 'unused' | 'last_calendar' | 'location_deleted' | 'org_deleted' | 'person_deleted';

/** The Google call a `townwise.google_calendar_failed` line is about. */
export type GoogleOp = 'token' | 'calendar_list' | 'calendar' | 'events' | 'revoke';

/** A handler's deps, from its context. */
export function googleAccessDeps(ctx: TownwiseContext): GoogleAccessDeps {
  return {
    connection: ctx.connection, stores: ctx.stores, key: ctx.calendarKey, logger: ctx.logger, now: ctx.now, client: ctx.googleCalendar,
    revoke: ctx.revokeGoogle,
  };
}

/**
 * The only writer of `townwise.google_calendar_failed`: exactly the call, Google's HTTP status (or null) and the client's
 * code from its fixed list (design decision 7), never Google's `error`, `error_description`, message or body.
 */
export function logGoogleFailure(logger: Logger, op: GoogleOp, error: GoogleCalendarError): void {
  logger.warn({ op, status: error.status, code: error.code }, 'townwise.google_calendar_failed');
}

/** The connection's refresh token, opened; null with no key, no row, or a key that no longer opens it. */
async function openedToken(deps: GoogleAccessDeps, scope: OrgScope, connectionId: string): Promise<string | null> {
  if (deps.key === null) return null;
  const sealed = await deps.stores.googleConnections.sealedToken(scope, connectionId);
  if (sealed === null) return null;
  const opened = open(deps.key, sealed);
  return opened.ok ? opened.text : null;
}

/** Revokes a token at Google, best effort: a failure logs its status only, and is never thrown. */
async function revokeBestEffort(deps: GoogleAccessDeps, token: string): Promise<void> {
  if (deps.revoke === null) return;
  try {
    await deps.revoke(token, { signal: deps.signal });
  } catch (err) {
    deps.logger.warn({ status: err instanceof GoogleCalendarError ? err.status : null }, 'townwise.google_revoke_failed');
  }
}

/**
 * Connect's refusal when Google sent no refresh token and none stored can be kept (design decision 8): revokes the
 * access token just given, which ends the whole grant, so the next press consents afresh. Best effort.
 */
export async function revokeAccessToken(deps: GoogleAccessDeps, accessToken: string): Promise<void> {
  await revokeBestEffort(deps, accessToken);
}

/**
 * Ends a connection (design decision 11), in an order a retry or the connection check completes: marks it for a check,
 * removes the organization's Google calendars it backs with their events, revokes the grant at Google unless the person
 * holds a connection in another organization (best effort; skipped when no key opens the token), deletes the row
 * whether or not the revoke worked, and logs `townwise.google_access_ended`. Resolves how many calendars it removed.
 * With the deps' signal aborted it stops before the revoke and keeps the row, which the mark makes due at once.
 */
export async function endGoogleAccess(deps: GoogleAccessDeps, scope: OrgScope, connectionId: string, reason: GoogleEndReason): Promise<number> {
  const { googleConnections, ownerCalendars } = deps.stores;
  /** Read afresh each time: the signal may abort during any await. */
  const stopped = (): boolean => deps.signal?.aborted === true;
  const found = await googleConnections.find(scope, connectionId);
  await googleConnections.markForCheck(scope, connectionId, deps.now());
  const calendars = await ownerCalendars.removeForConnection(scope, connectionId);
  if (found !== null) {
    if (stopped()) return calendars;
    if (!(await hasGoogleConnectionElsewhere(deps.connection, found.userId, scope.orgId))) {
      const token = await openedToken(deps, scope, connectionId);
      if (token !== null) await revokeBestEffort(deps, token);
      // Closed during the revoke: it may not have reached Google, so the row stays for the check.
      if (stopped()) return calendars;
    }
    await googleConnections.remove(scope, connectionId);
  }
  deps.logger.info({ connectionId, calendars, reason }, 'townwise.google_access_ended');
  return calendars;
}

/**
 * Ends the connection when it backs no calendar of the organization (the last one removed, a location deleted).
 * Resolves the calendars removed with it, or null when it still backs one and stays.
 */
export async function endUnusedGoogleAccess(deps: GoogleAccessDeps, scope: OrgScope, connectionId: string, reason: GoogleEndReason): Promise<number | null> {
  if ((await deps.stores.ownerCalendars.countForConnection(scope, connectionId)) > 0) return null;
  return endGoogleAccess(deps, scope, connectionId, reason);
}

/**
 * Seat loss's first step, before removeActiveSeat: the person's connection in the organization is due for a check at
 * once, so the check finishes a request that stops after the seat is gone (its retry answers 404). Resolves the
 * connection's id, or null when the person has none.
 */
export async function markPersonForCheck(deps: GoogleAccessDeps, scope: OrgScope, userId: string): Promise<string | null> {
  const found = await deps.stores.googleConnections.findForUser(scope, userId);
  if (found === null) return null;
  await deps.stores.googleConnections.markForCheck(scope, found.id, deps.now());
  return found.id;
}

/**
 * Location deletion's first step, before the location row goes: every connection backing one of its Google calendars
 * is due for a check at once. Resolves those connections' ids.
 */
export async function markLocationForCheck(deps: GoogleAccessDeps, scope: OrgScope, locationId: string): Promise<string[]> {
  const ids = [...new Set((await deps.stores.ownerCalendars.googleSources(scope, locationId)).map((source) => source.connectionId))];
  for (const id of ids) await deps.stores.googleConnections.markForCheck(scope, id, deps.now());
  return ids;
}

/**
 * Before a Google calendar is removed (Remove, the refresh loop's removed() path): its connection is due for a check at
 * once, so one left backing nothing is ended at the next look. Resolves the connection's id, or null when the calendar
 * is not a Google calendar of this location.
 */
export async function markCalendarForCheck(deps: GoogleAccessDeps, scope: OrgScope, locationId: string, calendarId: string): Promise<string | null> {
  const source = await deps.stores.ownerCalendars.googleSource(scope, locationId, calendarId);
  if (source === null) return null;
  await deps.stores.googleConnections.markForCheck(scope, source.connectionId, deps.now());
  return source.connectionId;
}

/** Why no access token: off (no client), revoked (now or before), the key, the row gone, or Google failing. */
export type GoogleAccessFailure = 'off' | 'revoked' | 'key_mismatch' | 'gone' | 'unavailable';

export type GoogleAccessToken = { readonly ok: true; readonly accessToken: string } | { readonly ok: false; readonly code: GoogleAccessFailure };

/**
 * An access token for one use (the add, connect's choices, the picker's list): opens the stored refresh token and
 * refreshes access. A new refresh token from Google replaces the stored one; `invalid_grant` marks the connection
 * revoked; every Google failure is logged. A revoked connection fails at once, with no Google call.
 */
export async function googleAccessToken(deps: GoogleAccessDeps, scope: OrgScope, connection: GoogleConnectionRecord): Promise<GoogleAccessToken> {
  const { client, key } = deps;
  if (client === null) return { ok: false, code: 'off' };
  if (connection.revokedAt !== null) return { ok: false, code: 'revoked' };
  if (key === null) return { ok: false, code: 'key_mismatch' };
  const sealed = await deps.stores.googleConnections.sealedToken(scope, connection.id);
  if (sealed === null) return { ok: false, code: 'gone' };
  const token = open(key, sealed);
  if (!token.ok) return { ok: false, code: 'key_mismatch' };
  let access;
  try {
    access = await client.refreshAccess(token.text, { signal: deps.signal });
  } catch (err) {
    if (!(err instanceof GoogleCalendarError)) throw err;
    logGoogleFailure(deps.logger, 'token', err);
    if (err.code !== 'invalid_grant') return { ok: false, code: 'unavailable' };
    await deps.stores.googleConnections.markRevoked(scope, connection.id, deps.now());
    return { ok: false, code: 'revoked' };
  }
  if (access.refreshToken !== null) await deps.stores.googleConnections.replaceToken(scope, connection.id, seal(key, access.refreshToken), deps.now());
  return { ok: true, accessToken: access.accessToken };
}

/** A Google calendar's read: its events, or the status it records (a `google_` code or `key_mismatch`), or stopped. */
export type GoogleCalendarRead =
  | { readonly ok: true; readonly parsed: ParsedCalendar }
  | { readonly ok: false; readonly code: CalendarFailure | 'stopped' };

/**
 * Reads one Google calendar through the connection (design decision 7): a revoked connection records `google_revoked`
 * with no Google call, the client off `google_unavailable`, a token the key no longer opens `key_mismatch`. Then
 * readGoogleCalendar with the deps' signal: a failure is logged, `invalid_grant` marks the connection revoked, and a
 * new refresh token from Google replaces the stored one. `calendarId` is the Google calendar's own id, opened.
 */
export async function readConnectedCalendar(
  deps: GoogleAccessDeps, scope: OrgScope, connection: GoogleConnectionRecord, calendarId: string, town: IcsTown,
): Promise<GoogleCalendarRead> {
  const { client, key } = deps;
  if (connection.revokedAt !== null) return { ok: false, code: 'google_revoked' };
  if (client === null) return { ok: false, code: 'google_unavailable' };
  if (key === null) return { ok: false, code: 'key_mismatch' };
  const sealed = await deps.stores.googleConnections.sealedToken(scope, connection.id);
  // Ended meanwhile: its calendars are being removed, so what this records is not kept.
  if (sealed === null) return { ok: false, code: 'google_revoked' };
  const token = open(key, sealed);
  if (!token.ok) return token;
  const read = await readGoogleCalendar(client, { refreshToken: token.text, calendarId, town, signal: deps.signal });
  if (!read.ok) {
    if (read.code === 'stopped') return read;
    logGoogleFailure(deps.logger, read.op, read.error);
    if (read.error.code === 'invalid_grant') await deps.stores.googleConnections.markRevoked(scope, connection.id, deps.now());
    return { ok: false, code: read.code };
  }
  if (read.refreshToken !== null) await deps.stores.googleConnections.replaceToken(scope, connection.id, seal(key, read.refreshToken), deps.now());
  return { ok: true, parsed: read.parsed };
}

/**
 * What reading a stored Google calendar came to: `missing` (not a Google calendar of this location), `removed` (its
 * connection is gone, so the calendar was removed with its events: the remains of an interrupted end), `ended` (the
 * connection's person holds no seat in this organization, so their access ended without reading Google), or the read.
 */
export type GoogleSourceRead =
  | { readonly kind: 'missing' | 'removed' | 'ended' }
  | { readonly kind: 'read'; readonly read: GoogleCalendarRead };

/**
 * The refresh loop's and "Refresh now"'s read of a stored Google calendar (design decision 10), in its order: the
 * source, its connection, the seat check (findActiveSeat: none, or one in another organization, ends the access with
 * reason `seat_gone`), then readConnectedCalendar, the calendar id opened only once the connection may be read.
 */
export async function readGoogleSource(
  deps: GoogleAccessDeps, scope: OrgScope, locationId: string, calendarId: string, town: IcsTown,
): Promise<GoogleSourceRead> {
  const source = await deps.stores.ownerCalendars.googleSource(scope, locationId, calendarId);
  if (source === null) return { kind: 'missing' };
  const connection = await deps.stores.googleConnections.find(scope, source.connectionId);
  if (connection === null) {
    await deps.stores.ownerCalendars.remove(scope, locationId, calendarId);
    return { kind: 'removed' };
  }
  const seat = await findActiveSeat(deps.connection, connection.userId);
  if (seat?.orgId !== scope.orgId) {
    await endGoogleAccess(deps, scope, connection.id, 'seat_gone');
    return { kind: 'ended' };
  }
  if (connection.revokedAt !== null) return { kind: 'read', read: { ok: false, code: 'google_revoked' } };
  if (deps.client === null) return { kind: 'read', read: { ok: false, code: 'google_unavailable' } };
  if (deps.key === null) return { kind: 'read', read: { ok: false, code: 'key_mismatch' } };
  const id = open(deps.key, source.sealedCalendarId);
  if (!id.ok) return { kind: 'read', read: id };
  return { kind: 'read', read: await readConnectedCalendar(deps, scope, connection, id.text, town) };
}

/**
 * Connect's rule when Google sends no refresh token (design decision 8): the stored one is kept only when the person's
 * connection is not revoked and its token opens under the current key.
 */
export async function storedTokenOpens(deps: GoogleAccessDeps, scope: OrgScope, userId: string): Promise<boolean> {
  const found = await deps.stores.googleConnections.findForUser(scope, userId);
  if (found?.revokedAt !== null) return false;
  return (await openedToken(deps, scope, found.id)) !== null;
}

/**
 * Organization deletion: ends each of the organization's connections (reason `org_deleted`), revoking each grant best
 * effort under the other-organization rule, so handlers/deletion.ts never opens a token. Resolves how many it ended.
 */
export async function revokeForOrg(deps: GoogleAccessDeps, scope: OrgScope): Promise<number> {
  const connections = await deps.stores.googleConnections.listForOrg(scope);
  for (const each of connections) await endGoogleAccess(deps, scope, each.id, 'org_deleted');
  return connections.length;
}
