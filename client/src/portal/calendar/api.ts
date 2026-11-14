import { z } from 'zod';

import type { ApiClient } from '../../api/client';

// The owner calendar routes (spec 10.18, api/src/handlers/owner-calendars.ts; connect-owner-calendar design decision
// 11), through the portal ApiClient: a location's own calendars, each an imported .ics file or a subscription link, and
// their stored events. No answer carries a link's address, only its host. `z.object` strips unknown keys.

function calendarsPath(locationId: string): `/${string}` {
  return `/api/org/locations/${encodeURIComponent(locationId)}/owner-calendars`;
}

function calendarPath(locationId: string, calendarId: string): `/${string}` {
  return `${calendarsPath(locationId)}/${encodeURIComponent(calendarId)}`;
}

/**
 * A calendar, never its address. `status` is `ok` or the code of the last failed refresh, parsed as a string so a code
 * a later API adds still parses (calendars.ts gives it generic words). A link's `host` is `calendar.google.com`; a
 * file's is null.
 */
export const ownerCalendarSchema = z.object({
  id: z.string(),
  label: z.string(),
  kind: z.enum(['file', 'link']),
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

const calendarsSchema = z.object({ calendars: z.array(ownerCalendarSchema) });
const eventsSchema = z.object({ events: z.array(ownerCalendarEventSchema) });
const savedCalendarSchema = z.object({ calendar: ownerCalendarSchema });

/** A calendar file's text (at most 1 MB, parsed by the API), or a link the API fetches before it stores anything. */
export type NewOwnerCalendar = { kind: 'file'; label: string; ics: string } | { kind: 'link'; label: string; url: string };

/** 200: the location's calendars, oldest first. */
export async function fetchOwnerCalendars(api: ApiClient, locationId: string): Promise<OwnerCalendar[]> {
  const body = await api.json(calendarsPath(locationId), calendarsSchema);
  return body.calendars;
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
 * rate_limited, or 400 with the fetch's failure code. 409 calendar_limit for a sixth.
 */
export async function addOwnerCalendar(api: ApiClient, locationId: string, calendar: NewOwnerCalendar): Promise<OwnerCalendar> {
  const body = await api.json(calendarsPath(locationId), savedCalendarSchema, { method: 'POST', body: calendar });
  return body.calendar;
}

/**
 * "Refresh now", a link only, with no body (the route parses none): 200 with the calendar after one fetch, its
 * `status` `ok` or the failure's code; 429 rate_limited within 5 minutes of the last; 503 calendar_links_unavailable.
 */
export async function refreshOwnerCalendar(api: ApiClient, locationId: string, calendarId: string): Promise<OwnerCalendar> {
  const body = await api.json(`${calendarPath(locationId, calendarId)}/refresh`, savedCalendarSchema, { method: 'POST' });
  return body.calendar;
}

/** 204: the calendar and all of its events; 404 not_found when it is already gone. */
export async function removeOwnerCalendar(api: ApiClient, locationId: string, calendarId: string): Promise<void> {
  await api.request(calendarPath(locationId, calendarId), { method: 'DELETE' });
}
