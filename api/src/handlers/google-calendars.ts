// Connecting a Google calendar (openspec change connect-google-calendar: the google-calendar spec, design decisions 3,
// 4, 8 and 11): the connect route exchanges the browser's code for the person's own Google account and answers the
// picker's choices, the choices route lists them again, and the disconnect drops a connection that backs no calendar.
// All three are a member's own, never staff's: none runs open as admin, the chain refuses the writes under view-as, and
// the choices refuse it here, since under view-as the person is the target. A location of another organization answers
// 404 first, as an unknown one does. Google's code and tokens arrive and leave only in JSON bodies, never a path or a
// query: the refresh token is sealed (calendar/secret.ts) before it is stored, and every other use of a stored token
// goes through calendar/google-access.ts. A calendar's Google name is answered to its person only and never stored.
// Nothing here logs but through google-access.ts (logGoogleFailure for every Google failure), and the audit events
// carry the connection's id, a count and a reason only. The Google errors and words the owner calendar routes share
// are here too.
import type { KeyObject } from 'node:crypto';

import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { OrgScope, Principal } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { recordAfter } from '../audit.ts';
import {
  endUnusedGoogleAccess, googleAccessDeps, googleAccessToken, logGoogleFailure, revokeAccessToken, storedTokenOpens,
  type GoogleAccessFailure,
} from '../calendar/google-access.ts';
import {
  CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE, GoogleCalendarError, type GoogleCalendarClient, type GoogleCodeExchange,
} from '../calendar/google.ts';
import { open, seal } from '../calendar/secret.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf } from './team.ts';

/** A Google calendar's name for the primary calendar, an email-like name, and every Google calendar under view-as. */
export const GOOGLE_CALENDAR_LABEL = 'Google calendar';
/** A Google calendar's event's title under view-as (design decision 12). */
export const GOOGLE_EVENT_TITLE = 'Google calendar event';

/** One of the picker's choices: the calendar's id and Google name go to its person only. */
export interface GoogleChoice {
  id: string;
  name: string;
  primary: boolean;
  /** Already one of this location's calendars. */
  added: boolean;
}

/** A Google code is about 75 characters; 512 keeps the JSON under the route's 2 KB. */
const connectBody = z.strictObject({ code: z.string().min(1).max(512), agreed: z.literal(true) });

export function googleCalendarUnavailable(): AppError {
  return new AppError(503, 'google_calendar_unavailable', 'Google calendars aren’t available right now');
}

/**
 * Google busy, down, refusing the client, or the Calendar API off. Never an unauthenticated answer, which the client
 * takes as a lost session (only access/resolve.ts's userGone answers one).
 */
export function googleUnavailable(): AppError {
  return new AppError(503, 'google_unavailable', 'Townwise couldn’t reach Google');
}

export function googleNotConnected(): AppError {
  return new AppError(409, 'google_not_connected', 'Connect your Google account first');
}

export function googleReconnect(): AppError {
  return new AppError(409, 'google_reconnect', 'Connect your Google account again');
}

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

/** The Google client and the calendar key; 503 google_calendar_unavailable while Google calendars are off. */
export function googleOn(ctx: TownwiseContext): { client: GoogleCalendarClient; key: KeyObject } {
  if (ctx.googleCalendar === null || ctx.calendarKey === null || ctx.googleCalendarClientId === null) throw googleCalendarUnavailable();
  return { client: ctx.googleCalendar, key: ctx.calendarKey };
}

/** The answer when no access token could be had. */
export function accessRefusal(code: GoogleAccessFailure): AppError {
  switch (code) {
    case 'off': return googleCalendarUnavailable();
    case 'gone': return googleNotConnected();
    case 'revoked':
    case 'key_mismatch': return googleReconnect();
    case 'unavailable': return googleUnavailable();
  }
}

/** The Google calendar ids of this location's Google calendars, opened; one the key no longer opens is left out. */
export async function storedGoogleIds(ctx: TownwiseContext, scope: OrgScope, locationId: string, key: KeyObject): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const source of await ctx.stores.ownerCalendars.googleSources(scope, locationId)) {
    const opened = open(key, source.sealedCalendarId);
    if (opened.ok) ids.add(opened.text);
  }
  return ids;
}

/**
 * The picker's choices from the person's calendar list (one page of 250), the primary first and then Google's order.
 * Google refusing the access token (`unauthorized`) marks the connection revoked and answers 409 google_reconnect; any
 * other failure answers 503 google_unavailable; each is logged.
 */
async function choicesOf(
  ctx: TownwiseContext, scope: OrgScope, input: { connectionId: string; locationId: string; accessToken: string },
): Promise<GoogleChoice[]> {
  const { client, key } = googleOn(ctx);
  let entries;
  try {
    entries = await client.listCalendars(input.accessToken);
  } catch (err) {
    if (!(err instanceof GoogleCalendarError)) throw err;
    logGoogleFailure(ctx.logger, 'calendar_list', err);
    if (err.code !== 'unauthorized') throw googleUnavailable();
    await ctx.stores.googleConnections.markRevoked(scope, input.connectionId, ctx.now());
    throw googleReconnect();
  }
  const added = await storedGoogleIds(ctx, scope, input.locationId, key);
  return [...entries.filter((entry) => entry.primary), ...entries.filter((entry) => !entry.primary)]
    .map((entry) => ({ id: entry.id, name: entry.name, primary: entry.primary, added: added.has(entry.id) }));
}

function connectAgain(): AppError {
  return new AppError(409, 'google_connect_again', 'Google didn’t give Townwise lasting access');
}

/**
 * POST /api/org/locations/:locationId/google-calendars/connect `{ code, agreed: true }`: 503 google_calendar_unavailable
 * while off; the code exchanged at Google (`invalid_grant` 400 google_code_invalid, any other failure 503
 * google_unavailable); 400 google_scope_missing unless both calendar scopes were granted; 409 google_other_account unless
 * the ID token names the caller's own Google sign-in account. With no refresh token from Google, the stored one is kept
 * only when the connection is not revoked and the key opens it; otherwise the access token just given is revoked and
 * the answer is 409 google_connect_again, storing nothing. Then the connection is stored (its token sealed, agreedAt and
 * connectedAt now, revokedAt cleared, the check 24 hours on), the person's Google calendars in the organization are due
 * at once, and `google_calendar.connected` is audited. 200 with the choices, as the choices route answers them.
 */
export async function connectGoogle(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const { client, key } = googleOn(ctx);
  const { code } = parseInput(connectBody, req.body);
  const deps = googleAccessDeps(ctx);
  let exchange: GoogleCodeExchange;
  try {
    exchange = await client.exchangeCode(code);
  } catch (err) {
    if (!(err instanceof GoogleCalendarError)) throw err;
    logGoogleFailure(ctx.logger, 'token', err);
    if (err.code === 'invalid_grant') throw new AppError(400, 'google_code_invalid', 'Google’s sign-in expired');
    throw googleUnavailable();
  }
  // Consent is granular: Townwise keeps nothing, and the next try asks Google again (no revoke, design decision 2).
  if (!exchange.scopes.includes(CALENDAR_LIST_SCOPE) || !exchange.scopes.includes(CALENDAR_EVENTS_SCOPE)) {
    throw new AppError(400, 'google_scope_missing', 'Townwise needs to see your calendars and their events');
  }
  const user = await ctx.authStores.users.findById(caller.userId);
  if (user?.googleSubject !== exchange.subject) {
    throw new AppError(409, 'google_other_account', 'Choose the Google account you sign in to Townwise with');
  }
  const now = ctx.now();
  let sealedRefreshToken: string | null = null;
  if (exchange.refreshToken !== null) sealedRefreshToken = seal(key, exchange.refreshToken);
  else if (!(await storedTokenOpens(deps, scope, caller.userId))) {
    await revokeAccessToken(deps, exchange.accessToken);
    throw connectAgain();
  }
  const connection = await ctx.stores.googleConnections.upsert(scope, caller.userId, { sealedRefreshToken, scopes: exchange.scopes, now });
  // Revoked since storedTokenOpens read it: keeping that token would clear the refusal over a token that fails.
  if (connection === null) {
    await revokeAccessToken(deps, exchange.accessToken);
    throw connectAgain();
  }
  await ctx.stores.ownerCalendars.markDueForConnection(scope, connection.id, now);
  await recordAfter(ctx, {
    ...actorOf(caller), at: now, orgId: scope.orgId, action: 'google_calendar.connected',
    target: { type: 'google_connection', id: connection.id },
    details: { connectionId: connection.id },
  });
  const calendars = await choicesOf(ctx, scope, { connectionId: connection.id, locationId: location.id, accessToken: exchange.accessToken });
  res.status(200).json({ calendars });
}

/**
 * GET /api/org/locations/:locationId/google-calendars: the caller's own Google calendars to pick from, with whether each
 * is already one of this location's. 403 view_as_read_only under view-as, where the person is the target, before
 * anything is read; 503 while off; 409 google_not_connected with no connection and google_reconnect for a revoked one
 * (a refresh answered `invalid_grant` marks it so first) or one the key no longer opens. 200 `{ calendars }`.
 */
export async function listGoogleChoices(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  if (caller.viewAs !== null) throw new AppError(403, 'view_as_read_only', 'View-as is read-only');
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  googleOn(ctx);
  const connection = await ctx.stores.googleConnections.findForUser(scope, caller.userId);
  if (connection === null) throw googleNotConnected();
  const access = await googleAccessToken(googleAccessDeps(ctx), scope, connection);
  if (!access.ok) throw accessRefusal(access.code);
  const calendars = await choicesOf(ctx, scope, { connectionId: connection.id, locationId: location.id, accessToken: access.accessToken });
  res.status(200).json({ calendars });
}

/**
 * DELETE /api/org/google-connection, the picker's Cancel after a fresh connect: ends the caller's connection when it
 * backs no calendar (revoking the grant; reason `unused`), and audits `google_calendar.disconnected`. 503 while off;
 * 404 with no connection; 409 google_connection_in_use when it backs a calendar. 204.
 */
export async function dropGoogleConnection(ctx: TownwiseContext, _req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  googleOn(ctx);
  const connection = await ctx.stores.googleConnections.findForUser(scope, caller.userId);
  if (connection === null) throw notFound();
  const calendarCount = await endUnusedGoogleAccess(googleAccessDeps(ctx), scope, connection.id, 'unused');
  if (calendarCount === null) throw new AppError(409, 'google_connection_in_use', 'This Google account backs a calendar');
  await recordAfter(ctx, {
    ...actorOf(caller), at: ctx.now(), orgId: scope.orgId, action: 'google_calendar.disconnected',
    target: { type: 'google_connection', id: connection.id },
    details: { connectionId: connection.id, calendarCount, reason: 'unused' },
  });
  res.status(204).end();
}
