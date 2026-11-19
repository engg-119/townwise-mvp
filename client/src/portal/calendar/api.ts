import { z } from 'zod';

import type { ApiClient } from '../../api/client';
import type { WEEKLY_TITLES_NOTICE } from './calendars';

// The owner calendar routes (spec 10.18, api/src/handlers/owner-calendars.ts; connect-owner-calendar design decision
// 11), through the portal ApiClient: a location's own calendars, each an imported .ics file, a subscription link or a
// Google calendar, and their stored events. No answer carries a link's address, only its host, nor a Google calendar's
// id or token. The Google routes (api/src/handlers/google-calendars.ts; connect-google-calendar design decisions 8 and
// 15) connect the person's own Google account, list the calendars they could add, and drop an unused connection; a
// code and a Google calendar id travel only in a JSON body, never a path or query. `z.object` strips unknown keys.

function calendarsPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/owner-calendars`;
}

function googleCalendarsPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/google-calendars`;
}

function calendarPath(locationId: string, calendarId: string): `/${string}` {
  return `${calendarsPath(locationId)}/${encodeURIComponent(calendarId)}`;
}

/** A booking label on a file calendar's event (D58): what an org admin or TownwiseAI's sort set. */
export const BOOKING_LABELS = ['buyout', 'party', 'own_event', 'other'] as const;
export type BookingLabel = (typeof BOOKING_LABELS)[number];

/**
 * A file calendar's labels (D58): `state` is `unsorted`, `sorted` (TownwiseAI sorted it, or anyone labeled it, and no
 * org admin has pressed Use for forecasts) or `confirmed` (the labels are used for forecasts since `confirmedAt`),
 * parsed as a string so a state a later API adds still parses; `counts` holds each label's events and those with none.
 */
export const bookingsSchema = z.object({
  state: z.string(),
  sortedAt: z.string().nullable().default(null),
  confirmedAt: z.string().nullable().default(null),
  counts: z.object({
    buyout: z.number().default(0),
    party: z.number().default(0),
    own_event: z.number().default(0),
    other: z.number().default(0),
    unlabeled: z.number().default(0),
  }),
});
export type CalendarBookings = z.infer<typeof bookingsSchema>;

/** An event's label as the API sends it: a label the client doesn't know reads as none. */
const bookingLabelSchema = z.enum(BOOKING_LABELS).nullable().catch(null);

/**
 * A calendar, never its address. `kind` is `file`, `link` or `google`, and `status` is `ok` or the code of the last
 * failed refresh, both parsed as strings so a kind or a code a later API adds still parses (calendars.ts gives an
 * unknown kind a generic row and an unknown code generic words). A link's `host` is `calendar.google.com`; a file's and
 * a Google calendar's are null.
 */
export const ownerCalendarSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.string(),
  host: z.string().nullable(),
  eventCount: z.number(),
  /** Repeating events counted, not imported. */
  skippedRepeating: z.number(),
  status: z.string(),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  createdAt: z.string(),
  /**
   * The person's own Google calendar, added through their own connection, which they can reconnect; false for a file,
   * a link, a teammate's Google calendar, under view-as, and from an API older than it.
   */
  mine: z.boolean().default(false),
  /** A file's format, `ics` or `csv` (D58); null for a link or a Google calendar, and from an API older than it. */
  format: z.string().nullable().default(null),
  /** A file calendar's booking labels (D58); null for a link or a Google calendar, and from an API older than them. */
  bookings: bookingsSchema.nullable().default(null),
  /**
   * D61, on the list only: the Your data item (`f_<id>`) a file calendar was imported from, while that file is kept; null
   * otherwise, on every other answer, and from an API older than it.
   */
  fromFile: z.string().nullable().default(null),
});
export type OwnerCalendar = z.infer<typeof ownerCalendarSchema>;

/** A stored event: `calendar` is its calendar's name, `endDate` is included, and the times are the town's 'HH:MM'. */
export const ownerCalendarEventSchema = z.object({
  calendarId: z.string(),
  calendar: z.string(),
  uid: z.string(),
  title: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  /** A file calendar's event's label (D58), and who set it; null for none, any other calendar, and an older API. */
  booking: bookingLabelSchema,
  bookingBy: z.string().nullable().default(null),
});
export type OwnerCalendarEvent = z.infer<typeof ownerCalendarEventSchema>;

/**
 * The list's `google`: whether Google calendars are on (`available`), whether the caller has a Google connection that
 * is not revoked (`connected`, false under view-as), the public OAuth client id the browser asks Google with
 * (`clientId`, null unless available, and open as admin), and whether the caller may connect one (`canConnect`: false
 * for staff, under view-as or open as admin, who see the option disabled; true from an API older than it, which never
 * answered staff `available`).
 */
export const googleCalendarsSchema = z.object({
  available: z.boolean(),
  connected: z.boolean(),
  clientId: z.string().nullable(),
  canConnect: z.boolean().default(true),
});
export type GoogleCalendars = z.infer<typeof googleCalendarsSchema>;

/** Google calendars off: what an API without `google` in its list answer means. */
export const GOOGLE_OFF: GoogleCalendars = { available: false, connected: false, clientId: null, canConnect: false };

/**
 * One calendar the person could add, from their own Google calendar list: Google's id (only ever posted back in an add's
 * body), its name in their Google account (shown in the picker, never stored by the client), whether it is their
 * primary calendar, and whether it is already one of this location's.
 */
export const googleChoiceSchema = z.object({
  id: z.string(),
  name: z.string(),
  primary: z.boolean(),
  added: z.boolean(),
});
export type GoogleChoice = z.infer<typeof googleChoiceSchema>;

/** The list's `bookingSort` (D58): whether Sort with TownwiseAI can run (false with no model key, and from an older API). */
export const bookingSortSchema = z.object({ available: z.boolean() });
export type BookingSort = z.infer<typeof bookingSortSchema>;

const calendarsSchema = z.object({
  calendars: z.array(ownerCalendarSchema), google: googleCalendarsSchema.optional(), bookingSort: bookingSortSchema.optional(),
});
const eventsSchema = z.object({ events: z.array(ownerCalendarEventSchema) });
const savedCalendarSchema = z.object({ calendar: ownerCalendarSchema });
/** An add's answer: `skippedRows` counts a calendar CSV's rows whose start couldn't be read (0 for anything else). */
const addedCalendarSchema = z.object({ calendar: ownerCalendarSchema, skippedRows: z.number().default(0) });
const sortedSchema = z.object({ calendar: ownerCalendarSchema, sent: z.number(), labeled: z.number(), batchesFailed: z.number().default(0) });
const labeledSchema = z.object({ calendar: ownerCalendarSchema, noteMade: z.boolean().default(false), noteKept: z.boolean().default(false) });
const confirmedSchema = z.object({
  calendar: ownerCalendarSchema,
  notesMade: z.number(),
  notesLeft: z.number().default(0),
  calibration: z.object({ status: z.string(), id: z.string().nullable().default(null) }).nullable().default(null),
});
const choicesSchema = z.object({ calendars: z.array(googleChoiceSchema) });

/**
 * A calendar file's text (at most 1 MB, parsed by the API), a link the API fetches before it stores anything, or one of
 * the person's Google calendars by its Google id, which the API checks and reads before it stores anything. A file or
 * link carries `titlesNotice` only when sent from the screen that says its titles are read weekly.
 */
export type NewOwnerCalendar =
  | { kind: 'file'; label: string; ics: string; titlesNotice?: typeof WEEKLY_TITLES_NOTICE }
  | { kind: 'link'; label: string; url: string; titlesNotice?: typeof WEEKLY_TITLES_NOTICE }
  | { kind: 'google'; googleCalendarId: string };

/** 200: the location's calendars, oldest first, `google` and `bookingSort`, which an older API leaves out (read as off). */
export async function fetchOwnerCalendars(
  api: ApiClient, locationId: string,
): Promise<{ calendars: OwnerCalendar[]; google: GoogleCalendars; bookingSort: BookingSort }> {
  const body = await api.json(calendarsPath(locationId), calendarsSchema);
  return { calendars: body.calendars, google: body.google ?? GOOGLE_OFF, bookingSort: body.bookingSort ?? { available: false } };
}

/**
 * 200: every stored event overlapping `from` to `to` (inclusive, at most 92 days, ending at most 400 days ahead), by
 * start; 400 bad_range otherwise. A file calendar keeps events from up to 1,096 days back (D58).
 */
export async function fetchOwnerCalendarEvents(
  api: ApiClient, locationId: string, range: { from: string; to: string },
): Promise<OwnerCalendarEvent[]> {
  const body = await api.json(`${calendarsPath(locationId)}/events?from=${range.from}&to=${range.to}`, eventsSchema);
  return body.events;
}

/**
 * 201 with the calendar and `skippedRows` (a calendar CSV's rows whose start couldn't be read; 0 otherwise, and from an
 * older API). A file, an .ics or a calendar CSV in `ics` (D58): 400 too_large or not_calendar. A link: 503 calendar_links_unavailable, 429
 * rate_limited, or 400 with the fetch's failure code. A Google calendar: 503 google_calendar_unavailable, 409
 * google_not_connected or google_reconnect, 429 rate_limited, 400 google_not_found or google_forbidden, 409
 * calendar_already_added, or 503 google_unavailable. 409 calendar_limit for a sixth.
 */
export async function addOwnerCalendar(
  api: ApiClient, locationId: string, calendar: NewOwnerCalendar,
): Promise<{ calendar: OwnerCalendar; skippedRows: number }> {
  return api.json(calendarsPath(locationId), addedCalendarSchema, { method: 'POST', body: calendar });
}

/**
 * "Refresh now", a link or a Google calendar, with no body (the route parses none): 200 with the calendar after one
 * read, its `status` `ok` or the failure's code; 429 rate_limited within 5 minutes of the last; 503
 * calendar_links_unavailable, or for a Google calendar google_calendar_unavailable or google_unavailable; 400
 * not_a_link for a file.
 */
export async function refreshOwnerCalendar(api: ApiClient, locationId: string, calendarId: string): Promise<OwnerCalendar> {
  const body = await api.json(`${calendarPath(locationId, calendarId)}/refresh`, savedCalendarSchema, { method: 'POST' });
  return body.calendar;
}

/** The sort runs in the request, within 150 seconds (design decision 8); the wait stays under the ingress's 240. */
const SORT_TIMEOUT_MS = 180_000;

/**
 * Sort with TownwiseAI (D58), no body: 200 with the calendar, how many unlabeled events were sent, how many TownwiseAI
 * labeled and how many batches failed. 403 for a member, under view-as or open as admin (open_as_admin_refused); 404;
 * 409 not_a_file_calendar or chat_budget_exhausted; 503 chat_unavailable; 429 rate_limited (3 a calendar an hour).
 */
export async function sortBookings(
  api: ApiClient, locationId: string, calendarId: string,
): Promise<{ calendar: OwnerCalendar; sent: number; labeled: number; batchesFailed: number }> {
  return api.json(`${calendarPath(locationId, calendarId)}/bookings/sort`, sortedSchema, { method: 'POST', timeoutMs: SORT_TIMEOUT_MS });
}

/**
 * One event's label (D58), its uid in the body, never the path or query: 200 with the calendar, whether a note was made
 * for it (an upcoming buyout or party on a confirmed calendar) and whether its note was kept (an upcoming event's label
 * moved away from buyout or party). 403 for a member or under view-as; 404 for an unknown calendar or uid.
 */
export async function labelBooking(
  api: ApiClient, locationId: string, calendarId: string, change: { uid: string; booking: BookingLabel | null },
): Promise<{ calendar: OwnerCalendar; noteMade: boolean; noteKept: boolean }> {
  return api.json(`${calendarPath(locationId, calendarId)}/bookings`, labeledSchema, { method: 'PATCH', body: change });
}

/**
 * Use for forecasts (D58), no body, again after confirming too (it makes any notes still missing): 200 with the
 * calendar, the notes made for upcoming bookings, those left without one, and the refit it started (`calibration.status`
 * `started`) or why not. 403 for a member or under view-as; 404; 409 not_a_file_calendar.
 */
export async function confirmBookings(
  api: ApiClient, locationId: string, calendarId: string,
): Promise<{ calendar: OwnerCalendar; notesMade: number; notesLeft: number; calibration: { status: string; id: string | null } | null }> {
  return api.json(`${calendarPath(locationId, calendarId)}/bookings/confirm`, confirmedSchema, { method: 'POST' });
}

/** 204: the calendar and all of its events; 404 not_found when it is already gone. */
export async function removeOwnerCalendar(api: ApiClient, locationId: string, calendarId: string): Promise<void> {
  await api.request(calendarPath(locationId, calendarId), { method: 'DELETE' });
}

/**
 * Connects the person's own Google account with the code Google's window gave (connect-google-calendar design decision
 * 3), posting `{ code, agreed: true }`: pressing "Continue to Google" after the explainer is the agreement, and
 * `titlesNotice` says that explainer said titles are read weekly (calendar-event-suggestions). 200 with the
 * choices. 503 google_calendar_unavailable; 400 google_code_invalid or google_scope_missing; 409 google_other_account,
 * google_connect_again or google_reconnect; 503 google_unavailable; 429 rate_limited.
 */
export async function connectGoogleCalendars(
  api: ApiClient, locationId: string, code: string, titlesNotice: typeof WEEKLY_TITLES_NOTICE,
): Promise<GoogleChoice[]> {
  const body = await api.json(`${googleCalendarsPath(locationId)}/connect`, choicesSchema, { method: 'POST', body: { code, agreed: true, titlesNotice } });
  return body.calendars;
}

/**
 * 200: the calendars the connected person could add to this location, the primary first. 409 google_not_connected or
 * google_reconnect; 503 google_calendar_unavailable or google_unavailable; 429 rate_limited; 403 under view-as.
 */
export async function fetchGoogleChoices(api: ApiClient, locationId: string): Promise<GoogleChoice[]> {
  const body = await api.json(googleCalendarsPath(locationId), choicesSchema);
  return body.calendars;
}

/**
 * 204: ends the caller's Google connection when it backs no calendar (the picker's Cancel after a fresh connect). 404
 * when there is none, 409 google_connection_in_use when it backs one.
 */
export async function dropGoogleConnection(api: ApiClient): Promise<void> {
  await api.request('/api/org/google-connection', { method: 'DELETE' });
}
