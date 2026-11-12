// Owner calendars (openspec change connect-owner-calendar: the owner-calendar and calendar-subscription specs, design
// decision 7): a location's own calendars, each an imported .ics file or a subscription link, and their stored events.
// Every route is a member's, staff opened as admin included, and the chain refuses the writes under view-as. A calendar
// of another location or organization answers 404, as an unknown id does. A link is fetched and parsed before anything
// is stored, so a failed one stores nothing. Its address is a secret: sealed (calendar/secret.ts) before it is stored,
// opened only to fetch it, and never answered, logged or audited; a link shows as its label and host. Nothing here
// logs, and the audit events carry ids, the kind, the event count and the status only, never a label, host, address or
// title.
import type { KeyObject } from 'node:crypto';

import { objectId } from '@ckeith26/mongo';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { MemberPrincipal, OrgScope, Principal } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { recordAfter } from '../audit.ts';
import type { CalendarFetchCode } from '../calendar/fetch.ts';
import { parseIcs, WINDOW_DAYS, type IcsTown } from '../calendar/ics.ts';
import { open, seal } from '../calendar/secret.ts';
import { daysBetween, isoDate } from '../dates.ts';
import type { AuditDetails } from '../stores/audit-events.ts';
import type { LocationRecord } from '../stores/locations.ts';
import {
  MANUAL_REFRESH_INTERVAL_MS, MAX_CALENDARS, MAX_LABEL_CHARS,
  type CalendarKind, type CalendarStatus, type NewCalendar, type OwnerCalendarRecord, type ParsedCalendar,
} from '../stores/owner-calendars.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf } from './team.ts';

/** A calendar as every answer shows it: never its address. */
export interface OwnerCalendarView {
  id: string;
  label: string;
  kind: CalendarKind;
  /** A link's host (`calendar.google.com`); null for a file. */
  host: string | null;
  eventCount: number;
  /** Repeating events counted, not imported. */
  skippedRepeating: number;
  /** `ok`, or the code of the last failed refresh. */
  status: CalendarStatus;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
}

/** A link's address, as pasted. */
const MAX_LINK_CHARS = 2048;
/** An events read spans at most this many days, both ends counted. */
const MAX_RANGE_DAYS = 92;

const labelSchema = z.string().trim().min(1).max(MAX_LABEL_CHARS);
/** A calendar file as its text (the route's 1 MB body limit bounds it), or a link. */
const calendarBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), label: labelSchema, ics: z.string() }),
  z.object({ kind: z.literal('link'), label: labelSchema, url: z.string().trim().min(1).max(MAX_LINK_CHARS) }),
]);
const rangeQuery = z.strictObject({ from: isoDate, to: isoDate });

type ReadFailure = CalendarFetchCode | 'not_calendar';

/** The 400 each failed add answers, by its code. */
const READ_FAILURES: Readonly<Record<ReadFailure, string>> = {
  bad_link: 'A calendar link starts with https:// or webcal://',
  blocked_address: 'Townwise doesn’t fetch from that address',
  unreachable: 'Townwise couldn’t reach that link',
  timeout: 'That link took too long to answer',
  too_large: 'That calendar is over 1 MB',
  http_error: 'That link answered with an error',
  not_calendar: 'That isn’t a calendar',
};

function notFound(): AppError {
  return new AppError(404, 'not_found', 'Not found');
}

function calendarLimit(): AppError {
  return new AppError(409, 'calendar_limit', `This location already has ${String(MAX_CALENDARS)} calendars`);
}

export function ownerCalendarView(calendar: OwnerCalendarRecord): OwnerCalendarView {
  return {
    id: calendar.id,
    label: calendar.label,
    kind: calendar.kind,
    host: calendar.host,
    eventCount: calendar.eventCount,
    skippedRepeating: calendar.skippedRepeating,
    status: calendar.status,
    lastSuccessAt: calendar.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: calendar.lastAttemptAt?.toISOString() ?? null,
    createdAt: calendar.createdAt.toISOString(),
  };
}

/** The calendar key; 503 calendar_links_unavailable without one (file imports still work). */
function linksKey(ctx: TownwiseContext): KeyObject {
  if (ctx.calendarKey === null) throw new AppError(503, 'calendar_links_unavailable', 'Calendar links aren’t available right now');
  return ctx.calendarKey;
}

/** The location's town, as the parser reads it: its today and its time zone. */
function townOf(location: LocationRecord, now: Date): IcsTown {
  const { timeZone } = timeZoneOf(location.town);
  return { today: localDay(now, timeZone), timeZone };
}

/** Fetches the address and parses what it answers: the events and the address's host, or the failure's code. */
async function readLink(
  ctx: TownwiseContext, address: string, town: IcsTown,
): Promise<{ readonly ok: true; readonly host: string; readonly parsed: ParsedCalendar } | { readonly ok: false; readonly code: ReadFailure }> {
  const fetched = await ctx.calendarFetcher.fetch(address);
  if (!fetched.ok) return fetched;
  const parsed = parseIcs(fetched.text, town);
  return 'error' in parsed ? { ok: false, code: parsed.error } : { ok: true, host: fetched.host, parsed };
}

/** A calendar of this location; 404 for any other id, another location's or organization's included. */
async function loadCalendar(ctx: TownwiseContext, scope: OrgScope, locationId: string, rawId: unknown): Promise<OwnerCalendarRecord> {
  const calendar = await ctx.stores.ownerCalendars.find(scope, locationId, parseInput(objectId, rawId));
  if (calendar === null) throw notFound();
  return calendar;
}

type CalendarAction = 'townwise.owner_calendar_added' | 'townwise.owner_calendar_removed' | 'townwise.owner_calendar_refreshed';

/** Ids, the kind, the event count and (but on removal) the status: never the label, host, address or a title. */
function recordCalendar(ctx: TownwiseContext, caller: MemberPrincipal, action: CalendarAction, calendar: OwnerCalendarRecord, at: Date): Promise<void> {
  const details: AuditDetails = { locationId: calendar.locationId, calendarId: calendar.id, kind: calendar.kind, eventCount: calendar.eventCount };
  return recordAfter(ctx, {
    ...actorOf(caller), at, orgId: caller.scope.orgId, action,
    target: { type: 'owner_calendar', id: calendar.id },
    details: action === 'townwise.owner_calendar_removed' ? details : { ...details, status: calendar.status },
  });
}

/** GET /api/org/locations/:locationId/owner-calendars: the location's calendars, oldest first. */
export async function listOwnerCalendars(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const calendars = await ctx.stores.ownerCalendars.list(scope, location.id);
  res.status(200).json({ calendars: calendars.map(ownerCalendarView) });
}

/**
 * POST /api/org/locations/:locationId/owner-calendars: `{ kind: 'file', label, ics }` or `{ kind: 'link', label, url }`.
 * A file is parsed with the town's today and time zone (400 not_calendar). A link needs the calendar key (503
 * calendar_links_unavailable) and is fetched and parsed before anything is stored (400 with the failure's code); its
 * address is stored sealed, with its host. A sixth calendar answers 409 calendar_limit. 201 with the calendar.
 */
export async function createOwnerCalendar(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const body = parseInput(calendarBody, req.body);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const calendars = ctx.stores.ownerCalendars;
  const now = ctx.now();
  const town = townOf(location, now);
  let calendar: NewCalendar;
  let parsed: ParsedCalendar;
  if (body.kind === 'file') {
    const read = parseIcs(body.ics, town);
    if ('error' in read) throw new AppError(400, read.error, READ_FAILURES[read.error]);
    calendar = { kind: 'file', label: body.label };
    parsed = read;
  } else {
    const key = linksKey(ctx);
    // Before the fetch, so a full location costs no request; the add itself holds the limit against concurrent adds.
    if ((await calendars.list(scope, location.id)).length >= MAX_CALENDARS) throw calendarLimit();
    const read = await readLink(ctx, body.url, town);
    if (!read.ok) throw new AppError(400, read.code, READ_FAILURES[read.code]);
    calendar = { kind: 'link', label: body.label, sealedAddress: seal(key, body.url), host: read.host };
    parsed = read.parsed;
  }
  const added = await calendars.add(scope, location.id, calendar, parsed, { createdBy: caller.userId, now });
  if (added === 'calendar_limit') throw calendarLimit();
  await recordCalendar(ctx, caller, 'townwise.owner_calendar_added', added, now);
  res.status(201).json({ calendar: ownerCalendarView(added) });
}

/** 429 rate_limited until 5 minutes after the calendar's last "Refresh now". */
function tooSoon(calendar: OwnerCalendarRecord, now: Date): AppError {
  const next = (calendar.lastManualRefreshAt ?? now).getTime() + MANUAL_REFRESH_INTERVAL_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil((next - now.getTime()) / 1000));
  return new AppError(429, 'rate_limited', 'This calendar was refreshed in the last 5 minutes', { retryAfterSeconds });
}

/**
 * POST /api/org/locations/:locationId/owner-calendars/:calendarId/refresh, "Refresh now": a link only (400 not_a_link),
 * with the calendar key (503 calendar_links_unavailable), at most once per calendar per 5 minutes (429 rate_limited,
 * and nothing is fetched). The address is opened, fetched and parsed: success replaces the events, and a failure keeps
 * them and records its code as the calendar's status. 200 with the calendar either way.
 */
export async function refreshOwnerCalendar(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const found = await loadCalendar(ctx, scope, location.id, req.params.calendarId);
  if (found.kind !== 'link') throw new AppError(400, 'not_a_link', 'Only a calendar link can be refreshed');
  const key = linksKey(ctx);
  const calendars = ctx.stores.ownerCalendars;
  const now = ctx.now();
  if (!(await calendars.claimManualRefresh(scope, location.id, found.id, now))) {
    const current = await calendars.find(scope, location.id, found.id);
    if (current === null) throw notFound();
    throw tooSoon(current, now);
  }
  const sealed = await calendars.sealedAddress(scope, location.id, found.id);
  if (sealed === null) throw notFound();
  const address = open(key, sealed);
  const read = address.ok ? await readLink(ctx, address.text, townOf(location, now)) : address;
  // A replace that loses to a concurrent one leaves that one's events, which are as new.
  if (read.ok) await calendars.replaceEvents(scope, location.id, found.id, read.parsed, now);
  else await calendars.recordFailure(scope, location.id, found.id, read.code, now);
  const refreshed = await calendars.find(scope, location.id, found.id);
  if (refreshed === null) throw notFound();
  await recordCalendar(ctx, caller, 'townwise.owner_calendar_refreshed', refreshed, now);
  res.status(200).json({ calendar: ownerCalendarView(refreshed) });
}

/** DELETE /api/org/locations/:locationId/owner-calendars/:calendarId: the calendar and all of its events. 204. */
export async function removeOwnerCalendar(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const calendar = await loadCalendar(ctx, scope, location.id, req.params.calendarId);
  if (!(await ctx.stores.ownerCalendars.remove(scope, location.id, calendar.id))) throw notFound();
  await recordCalendar(ctx, caller, 'townwise.owner_calendar_removed', calendar, ctx.now());
  res.status(204).end();
}

/** `from` and `to` are dates, at most 92 days apart counting both, and `to` at most 400 days after the town's today. */
function rangeOf(raw: unknown, today: string): { from: string; to: string } {
  const parsed = rangeQuery.safeParse(raw);
  const range = parsed.success ? parsed.data : null;
  if (range === null || range.from > range.to || daysBetween(range.from, range.to) >= MAX_RANGE_DAYS || daysBetween(today, range.to) > WINDOW_DAYS) {
    throw new AppError(400, 'bad_range', `Choose at most ${String(MAX_RANGE_DAYS)} days, ending within ${String(WINDOW_DAYS)} days of today`);
  }
  return range;
}

/**
 * GET /api/org/locations/:locationId/owner-calendars/events?from=&to=: the location's stored events overlapping the
 * range (inclusive dates), each with its calendar's id and label, by start; any other range answers 400 bad_range.
 */
export async function listOwnerCalendarEvents(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const { scope } = memberOf(principal);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const range = rangeOf(req.query, townOf(location, ctx.now()).today);
  res.status(200).json({ events: await ctx.stores.ownerCalendars.eventsBetween(scope, location.id, range) });
}
