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
});
export type OwnerCalendarEvent = z.infer<typeof ownerCalendarEventSchema>;

/**
 * The list's `google`: whether Google calendars are on (`available`), whether the caller has a Google connection that
 * is not revoked (`connected`, false under view-as), and the public OAuth client id the browser asks Google with
 * (`clientId`, null unless available).
 */
export const googleCalendarsSchema = z.object({
  available: z.boolean(),
  connected: z.boolean(),
  clientId: z.string().nullable(),
});
export type GoogleCalendars = z.infer<typeof googleCalendarsSchema>;

/** Google calendars off: what an API without `google` in its list answer means. */
export const GOOGLE_OFF: GoogleCalendars = { available: false, connected: false, clientId: null };

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

const calendarsSchema = z.object({ calendars: z.array(ownerCalendarSchema), google: googleCalendarsSchema.optional() });
const eventsSchema = z.object({ events: z.array(ownerCalendarEventSchema) });
const savedCalendarSchema = z.object({ calendar: ownerCalendarSchema });
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

/** 200: the location's calendars, oldest first, and `google`, which an older API leaves out (read as off). */
export async function fetchOwnerCalendars(
  api: ApiClient, locationId: string,
): Promise<{ calendars: OwnerCalendar[]; google: GoogleCalendars }> {
  const body = await api.json(calendarsPath(locationId), calendarsSchema);
  return { calendars: body.calendars, google: body.google ?? GOOGLE_OFF };
}

/** 200: every stored event overlapping `from` to `to` (inclusive, at most 92 days), by start; 400 bad_range otherwise. */
export async function fetchOwnerCalendarEvents(
  api: ApiClient, locationId: string, range: { from: string; to: string },
): Promise<OwnerCalendarEvent[]> {
  const body = await api.json(`${calendarsPath(locationId)}/events?from=${range.from}&to=${range.to}`, eventsSchema);
  return body.events;
}

/**
 * 201 with the calendar. A file: 400 too_large or not_calendar. A link: 503 calendar_links_unavailable, 429
 * rate_limited, or 400 with the fetch's failure code. A Google calendar: 503 google_calendar_unavailable, 409
 * google_not_connected or google_reconnect, 429 rate_limited, 400 google_not_found or google_forbidden, 409
 * calendar_already_added, or 503 google_unavailable. 409 calendar_limit for a sixth.
 */
export async function addOwnerCalendar(api: ApiClient, locationId: string, calendar: NewOwnerCalendar): Promise<OwnerCalendar> {
  const body = await api.json(calendarsPath(locationId), savedCalendarSchema, { method: 'POST', body: calendar });
  return body.calendar;
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
