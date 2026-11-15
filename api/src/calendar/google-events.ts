// Reading a Google calendar's events (openspec change connect-google-calendar: the google-calendar spec's "A Google
// calendar is read with a fixed, minimal request", design decision 7). One refresh of access, then the calendar's
// single events through the Google client (calendar/google.ts, which fixes the minimal fields): first the window ahead,
// from the town's today less 1 day to a day past the 400-day window ahead, then, with what is left of 2,000 events and
// 8 pages, the window before, from a day before the 400-day window back to today, each at 00:00Z (a day of margin
// each side of the window) and each followed page by page. Google orders by start ascending only and bounds a window's end by an event's end, so
// reading the window ahead first is what lets a busy calendar keep what is coming. An event read in both windows counts
// once, by its id. A caller's signal is checked before each page, and an aborted read answers `stopped`, writing
// nothing.
// The events are mapped with calendar/ics.ts's rules (its exports): the id is the UID (Google gives each instance of a
// repeating event its own), the title is cut at 200 characters, an all-day end date is exclusive, a timed instant is
// the town's wall time with the 06:00 rule for hours, canceled events are skipped, and keepWindow keeps those ending on
// or after the town's today first. Repeating events arrive expanded, so none is reported skipped. A failure answers
// the calendar status by the Google client's code, with the client's error and the call it came from, for the caller to
// log through logGoogleFailure (calendar/google-access.ts). Nothing here logs.
import { isCalendarDate, utcDay } from '../dates.ts';
import type { CalendarFailure, ParsedCalendar } from '../stores/owner-calendars.ts';
import {
  GoogleCalendarError, type GoogleAccess, type GoogleCalendarClient, type GoogleEventItem, type GoogleEventsPage, type GoogleEventTime, type GoogleFailure,
} from './google.ts';
import { keepWindow, MAX_EVENTS, spanOf, titleOf, townClock, WINDOW_DAYS, type IcsEvent, type IcsTown, type Moment, type TownClock } from './ics.ts';

/** Pages read from one calendar in all, both windows together. */
export const MAX_EVENT_PAGES = 8;

/** The calendar statuses a Google read can record. */
export type GoogleReadFailure = Extract<CalendarFailure, 'google_revoked' | 'google_rate_limited' | 'google_unavailable' | 'google_forbidden' | 'google_not_found'>;

export type GoogleRead =
  | {
    readonly ok: true;
    readonly parsed: ParsedCalendar;
    /** A new refresh token Google sent with the access, which replaces the stored one; else null. */
    readonly refreshToken: string | null;
  }
  | { readonly ok: false; readonly code: GoogleReadFailure; readonly op: 'token' | 'events'; readonly error: GoogleCalendarError }
  | { readonly ok: false; readonly code: 'stopped' };

const STOPPED: GoogleRead = { ok: false, code: 'stopped' };

/** Design decision 7's error mapping, by the client's codes. */
const STATUS_OF: Readonly<Record<GoogleFailure, GoogleReadFailure>> = {
  invalid_grant: 'google_revoked',
  unauthorized: 'google_revoked',
  rate_limited: 'google_rate_limited',
  forbidden: 'google_forbidden',
  not_found: 'google_not_found',
  api_disabled: 'google_unavailable',
  invalid_client: 'google_unavailable',
  unavailable: 'google_unavailable',
  bad_response: 'google_unavailable',
};

function plusDays(day: string, days: number): string {
  return utcDay(new Date(`${day}T00:00:00.000Z`), days);
}

function midnightUtc(day: string): string {
  return `${day}T00:00:00Z`;
}

/** A Google start or end: an all-day date as it is, a timed instant as the town's wall time; null when unreadable. */
function momentOf(time: GoogleEventTime | null, clock: TownClock): Moment | null {
  if (time === null) return null;
  if (time.dateTime !== null) {
    const at = new Date(time.dateTime);
    return Number.isNaN(at.getTime()) ? null : clock(at);
  }
  return time.date !== null && isCalendarDate(time.date) ? { date: time.date, time: null } : null;
}

/** Google's items as Townwise keeps them, by ics.ts's rules, the events ahead of the town's today first. Pure. */
export function eventsOfGoogle(items: readonly GoogleEventItem[], town: IcsTown): IcsEvent[] {
  const clock = townClock(town.timeZone);
  const events: IcsEvent[] = [];
  for (const item of items) {
    if (item.status === 'cancelled') continue;
    const start = momentOf(item.start, clock);
    if (start === null) continue;
    events.push({ uid: item.id, title: titleOf(item.summary ?? undefined), ...spanOf(start, momentOf(item.end, clock)) });
  }
  return keepWindow(events, town.today, { aheadFirst: true });
}

/** One Google calendar's events, read with a refresh token. Never throws a GoogleCalendarError: it answers it. */
export async function readGoogleCalendar(
  client: GoogleCalendarClient,
  input: { readonly refreshToken: string; readonly calendarId: string; readonly town: IcsTown; readonly signal?: AbortSignal | undefined },
): Promise<GoogleRead> {
  const { signal, town } = input;
  /** Read afresh each time: the signal may abort during any await. */
  const stopped = (): boolean => signal?.aborted === true;
  const failed = (op: 'token' | 'events', err: unknown): GoogleRead => {
    // Aborted mid-call: the caller writes nothing, whatever the call answered.
    if (stopped()) return STOPPED;
    if (err instanceof GoogleCalendarError) return { ok: false, code: STATUS_OF[err.code], op, error: err };
    throw err;
  };
  if (stopped()) return STOPPED;
  let access: GoogleAccess;
  try {
    access = await client.refreshAccess(input.refreshToken, { signal });
  } catch (err) {
    return failed('token', err);
  }
  const windows = [
    { timeMin: midnightUtc(plusDays(town.today, -1)), timeMax: midnightUtc(plusDays(town.today, WINDOW_DAYS + 1)) },
    { timeMin: midnightUtc(plusDays(town.today, -(WINDOW_DAYS + 1))), timeMax: midnightUtc(town.today) },
  ];
  const items = new Map<string, GoogleEventItem>();
  let pages = 0;
  for (const range of windows) {
    let pageToken: string | null = null;
    do {
      if (items.size >= MAX_EVENTS || pages >= MAX_EVENT_PAGES) break;
      if (stopped()) return STOPPED;
      let page: GoogleEventsPage;
      try {
        page = await client.listEvents(access.accessToken, input.calendarId, { ...range, timeZone: town.timeZone, pageToken }, { signal });
      } catch (err) {
        return failed('events', err);
      }
      pages += 1;
      for (const item of page.items) if (!items.has(item.id)) items.set(item.id, item);
      pageToken = page.nextPageToken;
    } while (pageToken !== null);
  }
  // Aborted as the last page arrived: still nothing to write.
  if (stopped()) return STOPPED;
  return { ok: true, parsed: { events: eventsOfGoogle([...items.values()], town), skippedRepeating: 0 }, refreshToken: access.refreshToken };
}
