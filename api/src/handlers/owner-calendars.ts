// Owner calendars (openspec change connect-owner-calendar: the owner-calendar and calendar-subscription specs, design
// decision 7): a location's own calendars, each an imported .ics file, a subscription link or a Google calendar
// (openspec change connect-google-calendar: the google-calendar spec, design decisions 8, 9 and 12), and their stored
// events. Every route is a member's, staff opened as admin included, except that a Google add needs the caller's own
// Google connection and so is refused open as admin; the chain refuses the writes under view-as. A calendar of another
// location or organization answers 404, as an unknown id does. A link or a Google calendar is read before anything is
// stored, so a failed one stores nothing. A link's address and a Google calendar's id are secrets: sealed
// (calendar/secret.ts) before they are stored, opened only to read them, and never answered, logged or audited; a link
// shows as its label and host, a Google calendar as its label with a null host, and to staff, under view-as or with the
// organization open as its admin, a Google calendar as "Google calendar" and its events as "Google calendar event"
// (Google's rule on people reading its users' data). Every use of a Google token goes through
// calendar/google-access.ts, which logs each Google failure; nothing else here logs, and the audit events carry ids,
// the kind, the event count and the status only, never a label, host, address, Google calendar id or title.
// Where Refresh now or an add switches in a calendar's events, notes linked to them follow (calendar/follow-up.ts,
// openspec change calendar-event-suggestions), which never fails the request.
import type { KeyObject } from 'node:crypto';

import { objectId } from '@ckeith26/mongo';
import { createRateLimiter, RateLimiterUnavailableError, type RateLimiter } from '@ckeith26/rate-limit';
import { AppError, parseInput } from '@ckeith26/server-core';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { MemberPrincipal, OrgScope, Principal } from '../access/policy.ts';
import type { TownwiseContext } from '../app.ts';
import { recordAfter } from '../audit.ts';
import type { CalendarFetchCode } from '../calendar/fetch.ts';
import { queueAutoSort } from '../calendar/auto-sort.ts';
import { bringPassForward } from '../calendar/early-pass.ts';
import { answerFromCalendars } from '../calendar/answers.ts';
import { followLinkedNotes } from '../calendar/follow-up.ts';
import {
  endUnusedGoogleAccess, googleAccessDeps, googleAccessToken, logGoogleFailure, markCalendarForCheck,
  readConnectedCalendar, readGoogleSource, type GoogleCalendarRead,
} from '../calendar/google-access.ts';
import { GoogleCalendarError, type GoogleCalendarEntry } from '../calendar/google.ts';
import { parseCalendarFile } from '../calendar/csv-events.ts';
import { MAX_ICS_BYTES, parseIcs, WINDOW_DAYS, type IcsTown } from '../calendar/ics.ts';
import { open, seal } from '../calendar/secret.ts';
import { WEEKLY_TITLES_NOTICE } from '../calendar/titles-notice.ts';
import { daysBetween, isoDate } from '../dates.ts';
import type { AuditDetails } from '../stores/audit-events.ts';
import type { LocationRecord } from '../stores/locations.ts';
import {
  ADDED_REPLACE, MANUAL_REFRESH_INTERVAL_MS, MAX_CALENDARS, MAX_LABEL_CHARS,
  type BookingCounts, type BookingsState, type CalendarFailure, type CalendarKind, type CalendarStatus, type NewCalendar, type OwnerCalendarEvent,
  type OwnerCalendarRecord, type ParsedCalendar,
} from '../stores/owner-calendars.ts';
import { localDay, timeZoneOf } from '../time-zones.ts';
import {
  accessRefusal, GOOGLE_CALENDAR_LABEL, GOOGLE_EVENT_TITLE, googleCalendarUnavailable, googleNotConnected, googleOn, googleReconnect,
  googleUnavailable, storedGoogleIds,
} from './google-calendars.ts';
import { loadLocation, memberOf } from './locations.ts';
import { actorOf } from './team.ts';

/** A calendar as every answer shows it: never its address or Google calendar id. */
export interface OwnerCalendarView {
  id: string;
  label: string;
  kind: CalendarKind;
  /** A link's host (`calendar.google.com`); null for a file or a Google calendar. */
  host: string | null;
  eventCount: number;
  /** Repeating events counted, not imported. */
  skippedRepeating: number;
  /** `ok`, or the code of the last failed refresh. */
  status: CalendarStatus;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  createdAt: string;
  /**
   * The caller's own Google calendar, which they can reconnect: true only for a Google calendar the caller added, so
   * read through their own connection; false for a file or a link, and for staff under view-as or open as admin.
   */
  mine: boolean;
  /** A file's format, `ics` or `csv` (D58); null for a link or a Google calendar. */
  format: 'ics' | 'csv' | null;
  /** A file calendar's booking labels (D58): their state and counts; null for a link or a Google calendar. */
  bookings: { state: BookingsState; sortedAt: string | null; confirmedAt: string | null; counts: BookingCounts } | null;
  /**
   * D61, on the list only: the Your data item (`f_<fileId>`) a file calendar was imported from (D60), while that file is
   * still kept and stored files are on; null otherwise. Your data shows such a file once, as this calendar, so the
   * calendar's page links to it.
   */
  fromFile?: string | null;
}

/**
 * Whether Google calendars are on, whether the caller has a connection that is not revoked, the public client id, and
 * whether the caller may connect one: false for staff, who see the option but never use it (owner decision, 2026-11-17).
 */
export interface GoogleCalendarsView {
  available: boolean;
  connected: boolean;
  clientId: string | null;
  canConnect: boolean;
}

/** A link's address, as pasted. */
const MAX_LINK_CHARS = 2048;
/** A Google calendar id as the picker answered it, or `primary`. */
const MAX_GOOGLE_ID_CHARS = 1024;
/** The calendar list's roles that may read events; `freeBusyReader` sees free and busy times only. */
const READER_ROLES: ReadonlySet<string> = new Set(['reader', 'writer', 'owner']);
/** An events read spans at most this many days, both ends counted. */
const MAX_RANGE_DAYS = 92;

/**
 * Each account's adds that fetch, links and Google calendars together: 12 an hour, so removing a calendar and adding it
 * again reads it no more often than "Refresh now" may. [CONFIRM: 12 link adds an hour]
 */
export const LINK_ADD_BUDGET = { name: 'townwise:calendar-links', limit: 12, windowSeconds: 3600 } as const;
const linkAddBudgets = new WeakMap<TownwiseContext['redis'], RateLimiter>();

const labelSchema = z.string().trim().min(1).max(MAX_LABEL_CHARS);
/** Sent only by the add screen that says TownwiseAI reads the titles weekly (calendar-event-suggestions design decision 11). */
const titlesNoticeSchema = z.literal(WEEKLY_TITLES_NOTICE).optional();
/**
 * A calendar file as its text (the handler holds it to 1 MB; the route's body limit leaves room for JSON escaping), a
 * link, or a Google calendar by the id the picker answered (its label comes from Google).
 */
const calendarBody = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('file'), label: labelSchema, ics: z.string(), titlesNotice: titlesNoticeSchema }),
  z.object({ kind: z.literal('link'), label: labelSchema, url: z.string().trim().min(1).max(MAX_LINK_CHARS), titlesNotice: titlesNoticeSchema }),
  z.object({ kind: z.literal('google'), googleCalendarId: z.string().min(1).max(MAX_GOOGLE_ID_CHARS) }),
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

/** A file calendar with no labels read: every event unlabeled (a new calendar's). */
function unlabeled(calendar: OwnerCalendarRecord): BookingCounts {
  return { buyout: 0, party: 0, own_event: 0, other: 0, unlabeled: calendar.eventCount };
}

/** The calendar as answered; a file's bookings carry `counts`, or every event unlabeled when none are given. */
export function ownerCalendarView(calendar: OwnerCalendarRecord, mine: boolean, counts?: BookingCounts): OwnerCalendarView {
  const { bookings } = calendar;
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
    mine,
    format: calendar.format,
    bookings: bookings === null ? null : {
      state: bookings.state, sortedAt: bookings.sortedAt?.toISOString() ?? null, confirmedAt: bookings.confirmedAt?.toISOString() ?? null,
      counts: counts ?? unlabeled(calendar),
    },
  };
}

function linksUnavailable(): AppError {
  return new AppError(503, 'calendar_links_unavailable', 'Calendar links aren’t available right now');
}

/** The calendar key; 503 calendar_links_unavailable without one (file imports still work). */
function linksKey(ctx: TownwiseContext): KeyObject {
  if (ctx.calendarKey === null) throw linksUnavailable();
  return ctx.calendarKey;
}

/**
 * Spends one of the caller's link adds before the fetch: 429 rate_limited when they are used up, and, since the
 * budget is what bounds the fetches, `unavailable` (503) when the store can't count it.
 */
async function spendLinkAdd(ctx: TownwiseContext, userId: string, unavailable: () => AppError): Promise<void> {
  let limiter = linkAddBudgets.get(ctx.redis);
  if (limiter === undefined) {
    limiter = createRateLimiter({ redis: ctx.redis, ...LINK_ADD_BUDGET });
    linkAddBudgets.set(ctx.redis, limiter);
  }
  let decision;
  try {
    decision = await limiter.consume(`acct:${userId}`);
  } catch (err) {
    if (!(err instanceof RateLimiterUnavailableError)) throw err;
    throw unavailable();
  }
  if (!decision.allowed) {
    throw new AppError(429, 'rate_limited', 'Too many requests. Try again later.', { retryAfterSeconds: decision.retryAfterSeconds });
  }
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

type CalendarAction = 'owner_calendar.added' | 'owner_calendar.removed' | 'owner_calendar.refreshed';

/**
 * Ids, the kind, the event count, (but on removal) the status and (D60, on an add from a stored file) the file's id:
 * never the label, host, address or a title.
 */
function recordCalendar(ctx: TownwiseContext, caller: MemberPrincipal, action: CalendarAction, calendar: OwnerCalendarRecord, at: Date): Promise<void> {
  const details: AuditDetails = {
    locationId: calendar.locationId, calendarId: calendar.id, kind: calendar.kind, eventCount: calendar.eventCount,
    ...(action === 'owner_calendar.added' && calendar.fromFileId !== null ? { fileId: calendar.fromFileId } : {}),
  };
  return recordAfter(ctx, {
    ...actorOf(caller), at, orgId: caller.scope.orgId, action,
    target: { type: 'owner_calendar', id: calendar.id },
    details: action === 'owner_calendar.removed' ? details : { ...details, status: calendar.status },
  });
}

/**
 * Whether the caller is Townwise staff, under view-as or with the organization open as its admin (D25, which outlasts
 * the first join): either way they read no Google calendar's name or event title (design decision 12).
 */
export function staffReads(caller: MemberPrincipal): boolean {
  return caller.viewAs !== null || caller.openAsAdmin !== null;
}

/**
 * A calendar as the caller may see it: to staff a Google calendar is "Google calendar" (design decision 12). It is
 * `mine` when it is a Google calendar the caller added: a Google add stores the adder's own connection (one per person
 * per organization, kept across a reconnect) and ending a connection removes its calendars, so the adder's connection
 * is the one that reads it. Never for staff: under view-as `userId` is the target's.
 */
export function shownView(calendar: OwnerCalendarRecord, caller: MemberPrincipal, counts?: BookingCounts): OwnerCalendarView {
  const staff = staffReads(caller);
  const view = ownerCalendarView(calendar, !staff && calendar.kind === 'google' && calendar.createdBy === caller.userId, counts);
  return staff && calendar.kind === 'google' ? { ...view, label: GOOGLE_CALENDAR_LABEL } : view;
}

/**
 * The list's `google`. Staff see that Google calendars are on but can't connect one (`canConnect` false; owner decision,
 * 2026-11-17), and every Google route and add still refuses them: under view-as `connected` is the staff member's own
 * state, which is never a connection here, and open as admin there is no client id either, so nothing can start
 * Google's window.
 */
async function googleView(ctx: TownwiseContext, caller: MemberPrincipal): Promise<GoogleCalendarsView> {
  const clientId = ctx.googleCalendar === null || ctx.calendarKey === null ? null : ctx.googleCalendarClientId;
  if (clientId === null) return { available: false, connected: false, clientId: null, canConnect: false };
  if (caller.openAsAdmin !== null) return { available: true, connected: false, clientId: null, canConnect: false };
  if (caller.viewAs !== null) return { available: true, connected: false, clientId, canConnect: false };
  const connection = await ctx.stores.googleConnections.findForUser(caller.scope, caller.userId);
  return { available: true, connected: connection !== null && connection.revokedAt === null, clientId, canConnect: true };
}

/**
 * The Your data refs of the files `calendars` were imported from (D60) that are still kept, by file id (D61): none
 * while stored files are off, and never a file being deleted or another location's.
 */
async function keptSourceFiles(
  ctx: TownwiseContext, scope: OrgScope, locationId: string, calendars: readonly OwnerCalendarRecord[],
): Promise<ReadonlySet<string>> {
  const ids = calendars.flatMap((calendar) => calendar.fromFileId ?? []);
  if (ctx.files === null || ids.length === 0) return new Set();
  const files = await ctx.stores.files.byIds(scope, ids);
  return new Set(files.filter((file) => file.locationId === locationId && file.status !== 'deleting' && file.uploadId === null).map((file) => file.id));
}

/**
 * GET /api/org/locations/:locationId/owner-calendars: the location's calendars, oldest first, each with `mine` (a Google
 * calendar the caller added, which they can reconnect), for a file its format and booking labels' state and counts
 * (D58), and `fromFile`, the Your data item it was imported from while that file is kept (D61); `google`: whether
 * Google calendars are on, whether the caller has a connection that is not revoked, and the public client id; and
 * `bookingSort`: whether Sort with TownwiseAI is available (a model key is set).
 */
export async function listOwnerCalendars(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const location = await loadLocation(ctx, caller.scope, req.params.locationId);
  const [calendars, counts] = await Promise.all([
    ctx.stores.ownerCalendars.list(caller.scope, location.id), ctx.stores.ownerCalendars.labelCounts(caller.scope, location.id),
  ]);
  const kept = await keptSourceFiles(ctx, caller.scope, location.id, calendars);
  res.status(200).json({
    calendars: calendars.map((calendar) => ({
      ...shownView(calendar, caller, counts.get(calendar.id)),
      fromFile: calendar.fromFileId !== null && kept.has(calendar.fromFileId) ? `f_${calendar.fromFileId}` : null,
    })),
    google: await googleView(ctx, caller),
    bookingSort: { available: ctx.chat !== null },
  });
}

function googleNotFound(): AppError {
  return new AppError(400, 'google_not_found', 'That calendar is no longer in your Google account');
}

function googleForbidden(): AppError {
  return new AppError(400, 'google_forbidden', 'Google won’t share that calendar’s events with Townwise');
}

/** A Google read that failed, as an add answers it: nothing is stored. */
function googleReadRefusal(code: Exclude<GoogleCalendarRead, { ok: true }>['code']): AppError {
  switch (code) {
    case 'google_not_found': return googleNotFound();
    case 'google_forbidden': return googleForbidden();
    case 'google_revoked':
    case 'key_mismatch': return googleReconnect();
    default: return googleUnavailable();
  }
}

/**
 * A Google calendar's label (design decision 9): its Google name cut at 60 UTF-16 code units without splitting a
 * surrogate pair, or "Google calendar" for the primary calendar and any name with "@" in it, which is often an email
 * address, and labels are shown to the whole team and sent to Anthropic.
 */
function googleLabel(entry: GoogleCalendarEntry): string {
  const name = entry.name.trim();
  if (entry.primary || name === '' || name.includes('@')) return GOOGLE_CALENDAR_LABEL;
  if (name.length <= MAX_LABEL_CHARS) return name;
  const cut = name.slice(0, MAX_LABEL_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  return (last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trimEnd();
}

/**
 * A Google add, checked and read before anything is stored (design decision 8), in this order so a refused add costs
 * no Google call where it can: 403 open_as_admin_refused (staff never hold a Google connection); 503 while off; 409
 * google_not_connected or google_reconnect; 409 calendar_limit; one of the account's adds that fetch (429, or 503
 * google_calendar_unavailable when they can't be counted); the calendar in the caller's own calendar list (400
 * google_not_found; 400 google_forbidden for free and busy only); 409 calendar_already_added against the id Google
 * answered, so the `primary` alias matches and a calendar the caller can't see never tells them whose the location
 * holds; then its events.
 */
async function googleToAdd(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord, googleCalendarId: string, town: IcsTown,
): Promise<{ calendar: Extract<NewCalendar, { kind: 'google' }>; parsed: ParsedCalendar }> {
  if (caller.openAsAdmin !== null) throw new AppError(403, 'open_as_admin_refused', 'Not available while setting up as Townwise staff');
  const { client, key } = googleOn(ctx);
  const { scope } = caller;
  const connection = await ctx.stores.googleConnections.findForUser(scope, caller.userId);
  if (connection === null) throw googleNotConnected();
  if (connection.revokedAt !== null) throw googleReconnect();
  // Before any Google call; the add itself holds the limit against concurrent adds.
  if ((await ctx.stores.ownerCalendars.list(scope, location.id)).length >= MAX_CALENDARS) throw calendarLimit();
  await spendLinkAdd(ctx, caller.userId, googleCalendarUnavailable);
  const deps = googleAccessDeps(ctx);
  const access = await googleAccessToken(deps, scope, connection);
  if (!access.ok) throw accessRefusal(access.code);
  let entry: GoogleCalendarEntry;
  try {
    entry = await client.getCalendar(access.accessToken, googleCalendarId);
  } catch (err) {
    if (!(err instanceof GoogleCalendarError)) throw err;
    logGoogleFailure(ctx.logger, 'calendar', err);
    if (err.code === 'not_found') throw googleNotFound();
    if (err.code === 'unauthorized') throw googleReconnect();
    throw googleUnavailable();
  }
  if (!READER_ROLES.has(entry.accessRole)) throw googleForbidden();
  if ((await storedGoogleIds(ctx, scope, location.id, key)).has(entry.id)) {
    throw new AppError(409, 'calendar_already_added', 'This calendar is already on this location');
  }
  const read = await readConnectedCalendar(deps, scope, connection, entry.id, town);
  if (!read.ok) throw googleReadRefusal(read.code);
  return {
    calendar: { kind: 'google', label: googleLabel(entry), sealedAddress: seal(key, entry.id), googleConnectionId: connection.id },
    parsed: read.parsed,
  };
}

/**
 * D60: a stored file's name as its calendar's, as Your calendars words it (client/src/portal/calendar/calendars.ts
 * labelOfFile): a final `.ics`, `.ical` or `.csv` off, trimmed, at most 60 code units (one fewer when the last would
 * open a surrogate pair), and "Calendar file" when empty.
 */
export function labelOfFile(name: string): string {
  const bare = name.replace(/\.(?:ics|ical|csv)$/i, '').trim();
  const cut = bare.length <= MAX_LABEL_CHARS ? bare : bare.slice(0, MAX_LABEL_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  const label = (cut.length < bare.length && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut).trim();
  return label === '' ? 'Calendar file' : label;
}

/** D60: the location's calendar imported from the stored file, if it still exists (its page in Your data says so). */
export async function calendarOfFile(ctx: TownwiseContext, scope: OrgScope, locationId: string, fileId: string): Promise<OwnerCalendarRecord | null> {
  return (await ctx.stores.ownerCalendars.list(scope, locationId)).find((calendar) => calendar.fromFileId === fileId) ?? null;
}

/** Why a file calendar was not added: over 1 MB, not a calendar, or the location already has 5. */
export type FileCalendarRefusal = 'too_large' | 'not_calendar' | 'calendar_limit';

/** The 400 or 409 a refused file add answers. */
function fileRefusal(code: FileCalendarRefusal): AppError {
  return code === 'calendar_limit' ? calendarLimit() : new AppError(400, code, READ_FAILURES[code]);
}

/**
 * Adds a calendar file, .ics or CSV, as a file calendar of the location: at most 1 MB of UTF-8 (too_large), parsed with
 * the town's today and time zone in the file window (calendar/csv-events.ts parseCalendarFile; not_calendar), stored
 * with its format and, when its screen said so, `titlesNotice`, then recorded as `owner_calendar.added`. The add of
 * POST .../owner-calendars and (D60) of a calendar file kept in Your data (files/calendar-import.ts), which passes the
 * stored file's id: 'file_imported' when that file already made a calendar, and nothing is stored. D59 slice 2: either
 * add is then queued for TownwiseAI's sort on its own (calendar/auto-sort.ts queueAutoSort says when).
 */
export async function addFileCalendar(
  ctx: TownwiseContext, caller: MemberPrincipal, location: LocationRecord,
  input: { label: string; text: string; titlesNotice?: typeof WEEKLY_TITLES_NOTICE; fromFileId?: string },
): Promise<{ calendar: OwnerCalendarRecord; skippedRows: number } | FileCalendarRefusal | 'file_imported'> {
  const { scope } = caller;
  const now = ctx.now();
  if (Buffer.byteLength(input.text, 'utf8') > MAX_ICS_BYTES) return 'too_large';
  const read = parseCalendarFile(input.text, townOf(location, now));
  if ('error' in read) return read.error;
  const calendar = {
    kind: 'file', label: input.label, format: read.format, ...(input.titlesNotice === undefined ? {} : { titlesNotice: input.titlesNotice }),
  } as const;
  const by = { createdBy: caller.userId, now };
  const calendars = ctx.stores.ownerCalendars;
  const added = input.fromFileId === undefined
    ? await calendars.add(scope, location.id, calendar, read, by)
    : await calendars.addFromFile(scope, location.id, input.fromFileId, calendar, read, by);
  if (added === 'calendar_limit' || added === 'file_imported') return added;
  // As at the other switch points; a new calendar's events have no linked notes yet, so this finds none. D59 slice 5:
  // the location's calendars answer its open closure questions (calendar/answers.ts); neither fails the add.
  await followLinkedNotes(ctx, scope, location, added.id, ADDED_REPLACE, now);
  await answerFromCalendars(answerDeps(ctx), scope, location);
  await recordCalendar(ctx, caller, 'owner_calendar.added', added, now);
  // D59 slice 2: TownwiseAI sorts a file on its own, after the add is recorded; it never fails the add.
  await queueAutoSort(ctx, scope, added, { openAsAdmin: caller.openAsAdmin !== null });
  return { calendar: added, skippedRows: read.skippedRows };
}

/**
 * POST /api/org/locations/:locationId/owner-calendars: `{ kind: 'file', label, ics }`, `{ kind: 'link', label, url }` or
 * `{ kind: 'google', googleCalendarId }`. A file of at most 1 MB (400 too_large), whose text `ics` carries whether it is
 * an .ics file or a calendar CSV (D58; the field keeps its name for shipped builds), is parsed with the town's today and
 * time zone in the file window (calendar/csv-events.ts parseCalendarFile; 400 not_calendar) and stored with its format. A link needs the calendar key (503 calendar_links_unavailable), spends one of the
 * account's link adds (429 rate_limited), and is fetched and parsed before anything is stored (400 with the failure's
 * code); its address is stored sealed, with its host. A Google calendar is checked and read as googleToAdd says, stored
 * with its Google calendar id sealed and its connection, and checked again after storing: a connection ended meanwhile
 * takes the new calendar with it (409 google_not_connected). A sixth calendar answers 409 calendar_limit. 201 with the
 * calendar and `skippedRows`, a CSV's rows whose start could not be read (0 otherwise). D59 slice 2: a file is then
 * queued for TownwiseAI's sort on its own (calendar/auto-sort.ts queueAutoSort says when).
 */
export async function createOwnerCalendar(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const body = parseInput(calendarBody, req.body);
  const location = await loadLocation(ctx, scope, req.params.locationId);
  if (body.kind === 'file') {
    const added = await addFileCalendar(ctx, caller, location, {
      label: body.label, text: body.ics, ...(body.titlesNotice === undefined ? {} : { titlesNotice: body.titlesNotice }),
    });
    // No fromFileId was passed, so the store never answers file_imported here.
    if (added === 'file_imported') throw new Error('a file add without a stored file answered file_imported');
    if (typeof added === 'string') throw fileRefusal(added);
    res.status(201).json({ calendar: shownView(added.calendar, caller), skippedRows: added.skippedRows });
    return;
  }
  const calendars = ctx.stores.ownerCalendars;
  const now = ctx.now();
  const town = townOf(location, now);
  let calendar: NewCalendar;
  let parsed: ParsedCalendar;
  if (body.kind === 'link') {
    const key = linksKey(ctx);
    // Before the fetch, so a full location costs no request; the add itself holds the limit against concurrent adds.
    if ((await calendars.list(scope, location.id)).length >= MAX_CALENDARS) throw calendarLimit();
    await spendLinkAdd(ctx, caller.userId, linksUnavailable);
    const read = await readLink(ctx, body.url, town);
    if (!read.ok) throw new AppError(400, read.code, READ_FAILURES[read.code]);
    calendar = {
      kind: 'link', label: body.label, sealedAddress: seal(key, body.url), host: read.host,
      ...(body.titlesNotice === undefined ? {} : { titlesNotice: body.titlesNotice }),
    };
    parsed = read.parsed;
  } else {
    ({ calendar, parsed } = await googleToAdd(ctx, caller, location, body.googleCalendarId, town));
  }
  const added = await calendars.add(scope, location.id, calendar, parsed, { createdBy: caller.userId, now });
  if (added === 'calendar_limit') throw calendarLimit();
  // The connection is in use: its check is pushed on. False when its access ended meanwhile, so the calendar goes too.
  if (calendar.kind === 'google' && !(await ctx.stores.googleConnections.clearCheck(scope, calendar.googleConnectionId, now))) {
    await calendars.remove(scope, location.id, added.id);
    throw googleNotConnected();
  }
  // As at the other switch points; a new calendar's events have no linked notes yet, so this finds none. D59 slice 5:
  // the location's calendars answer its open closure questions (calendar/answers.ts); neither fails the add.
  await followLinkedNotes(ctx, scope, location, added.id, ADDED_REPLACE, now);
  await answerFromCalendars(answerDeps(ctx), scope, location);
  await recordCalendar(ctx, caller, 'owner_calendar.added', added, now);
  res.status(201).json({ calendar: shownView(added, caller), skippedRows: 0 });
}

/** D59 slice 5: what a calendar's answers to TownwiseAI's open questions read and write through (calendar/answers.ts). */
function answerDeps(ctx: TownwiseContext): Parameters<typeof answerFromCalendars>[0] {
  return { stores: ctx.stores, logger: ctx.logger, now: ctx.now, agentAuto: ctx.config.agentAuto };
}

/** 429 rate_limited until 5 minutes after the calendar's last "Refresh now". */
function tooSoon(calendar: OwnerCalendarRecord, now: Date): AppError {
  const next = (calendar.lastManualRefreshAt ?? now).getTime() + MANUAL_REFRESH_INTERVAL_MS;
  const retryAfterSeconds = Math.max(1, Math.ceil((next - now.getTime()) / 1000));
  return new AppError(429, 'rate_limited', 'This calendar was refreshed in the last 5 minutes', { retryAfterSeconds });
}

type Refreshed = { readonly ok: true; readonly parsed: ParsedCalendar } | { readonly ok: false; readonly code: CalendarFailure };

/** A link's "Refresh now": its address opened, fetched and parsed. */
async function refreshLink(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, calendarId: string, key: KeyObject, now: Date): Promise<Refreshed> {
  const sealed = await ctx.stores.ownerCalendars.sealedAddress(scope, location.id, calendarId);
  if (sealed === null) throw notFound();
  const address = open(key, sealed);
  return address.ok ? readLink(ctx, address.text, townOf(location, now)) : address;
}

/**
 * A Google calendar's "Refresh now", the refresh loop's own read (calendar/google-access.ts readGoogleSource): a
 * connection that is gone, or whose person holds no seat here any more, takes the calendar with it, so the answer is
 * 404; `invalid_grant` marks the connection revoked, and a new refresh token from Google replaces the stored one. A
 * person whose seat here was removed moments ago, by a removal that may yet be refused, gets no read and no record:
 * 503 google_unavailable, and a later try decides.
 */
async function refreshGoogle(ctx: TownwiseContext, scope: OrgScope, location: LocationRecord, calendarId: string, now: Date): Promise<Refreshed> {
  const source = await readGoogleSource(googleAccessDeps(ctx), scope, location.id, calendarId, townOf(location, now));
  if (source.kind === 'unsettled') throw googleUnavailable();
  if (source.kind !== 'read') throw notFound();
  const { read } = source;
  if (read.ok) return read;
  // Only the refresh loop's close stops a read, and a handler passes no signal.
  if (read.code === 'stopped') throw googleUnavailable();
  return { ok: false, code: read.code };
}

/**
 * POST /api/org/locations/:locationId/owner-calendars/:calendarId/refresh, "Refresh now": a link or a Google calendar (a
 * file answers 400 not_a_link), with the calendar key (503 calendar_links_unavailable) or Google calendars on (503
 * google_calendar_unavailable), at most once per calendar per 5 minutes (429 rate_limited, and nothing is fetched). The
 * calendar is read: success replaces the events, and a failure keeps them and records its code as the calendar's
 * status. 200 with the calendar either way, a Google calendar's named "Google calendar" for staff open as admin.
 */
export async function refreshOwnerCalendar(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const found = await loadCalendar(ctx, scope, location.id, req.params.calendarId);
  if (found.kind === 'file') throw new AppError(400, 'not_a_link', 'Only a calendar link or a Google calendar can be refreshed');
  const key = found.kind === 'google' ? googleOn(ctx).key : linksKey(ctx);
  const calendars = ctx.stores.ownerCalendars;
  const now = ctx.now();
  if (!(await calendars.claimManualRefresh(scope, location.id, found.id, now))) {
    const current = await calendars.find(scope, location.id, found.id);
    if (current === null) throw notFound();
    throw tooSoon(current, now);
  }
  const read = found.kind === 'google'
    ? await refreshGoogle(ctx, scope, location, found.id, now)
    : await refreshLink(ctx, scope, location, found.id, key, now);
  // A replace that loses to a concurrent one leaves that one's events, which are as new.
  if (read.ok) {
    const replaced = await calendars.replaceEvents(scope, location.id, found.id, read.parsed, now);
    // Notes linked to its events follow them (calendar-event-suggestions), and (D59 slice 3) an event added or moved in
    // the next 91 days brings the weekly pass forward; neither fails the refresh.
    if (replaced.switched) {
      await followLinkedNotes(ctx, scope, location, found.id, replaced, now);
      await answerFromCalendars(answerDeps(ctx), scope, location);
      await bringPassForward(ctx, scope, location, found.id, replaced.changed, now);
    }
  } else {
    await calendars.recordFailure(scope, location.id, found.id, read.code, now);
  }
  const refreshed = await calendars.find(scope, location.id, found.id);
  if (refreshed === null) throw notFound();
  await recordCalendar(ctx, caller, 'owner_calendar.refreshed', refreshed, now);
  res.status(200).json({ calendar: shownView(refreshed, caller) });
}

/**
 * DELETE /api/org/locations/:locationId/owner-calendars/:calendarId: the calendar and all of its events. 204. A Google
 * calendar's connection is marked for a check first (so a request that stops here leaves it due at once), and ended
 * after when it backs no other calendar of the organization, whoever pressed Remove: an unused grant is a credential
 * Townwise should not hold (audited `google_calendar.disconnected`, reason `last_calendar`).
 */
export async function removeOwnerCalendar(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const calendar = await loadCalendar(ctx, scope, location.id, req.params.calendarId);
  const deps = googleAccessDeps(ctx);
  const connectionId = calendar.kind === 'google' ? await markCalendarForCheck(deps, scope, location.id, calendar.id) : null;
  if (!(await ctx.stores.ownerCalendars.remove(scope, location.id, calendar.id))) throw notFound();
  const now = ctx.now();
  await recordCalendar(ctx, caller, 'owner_calendar.removed', calendar, now);
  const calendarCount = connectionId === null ? null : await endUnusedGoogleAccess(deps, scope, connectionId, 'last_calendar');
  if (connectionId !== null && calendarCount !== null) {
    await recordAfter(ctx, {
      ...actorOf(caller), at: now, orgId: scope.orgId, action: 'google_calendar.disconnected',
      target: { type: 'google_connection', id: connectionId },
      details: { connectionId, calendarCount, reason: 'last_calendar' },
    });
  }
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
 * To staff, under view-as or open as admin, every event of a calendar that is not a file or a link shows as "Google
 * calendar event" from "Google calendar", with its dates and hours (design decision 12): the calendars are read first,
 * so one added meanwhile is covered too.
 */
export async function listOwnerCalendarEvents(ctx: TownwiseContext, req: Request, res: Response, principal: Principal): Promise<void> {
  const caller = memberOf(principal);
  const { scope } = caller;
  const location = await loadLocation(ctx, scope, req.params.locationId);
  const range = rangeOf(req.query, townOf(location, ctx.now()).today);
  const shown = !staffReads(caller)
    ? null
    : new Set((await ctx.stores.ownerCalendars.list(scope, location.id)).filter((calendar) => calendar.kind !== 'google').map((calendar) => calendar.id));
  const events = await ctx.stores.ownerCalendars.eventsBetween(scope, location.id, range);
  res.status(200).json({
    events: shown === null ? events : events.map((event): OwnerCalendarEvent => (shown.has(event.calendarId)
      ? event
      : { ...event, calendar: GOOGLE_CALENDAR_LABEL, title: GOOGLE_EVENT_TITLE })),
  });
}
