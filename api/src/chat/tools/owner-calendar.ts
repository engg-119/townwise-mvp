// get_owner_calendar (openspec change connect-owner-calendar: the townwise-ai-owner-calendar spec, design decision 8):
// the location's own stored calendars, imported, subscribed or connected from Google (connect-google-calendar), for a
// range of at most 92 days, with the limits of get_town_calendar. Each single event with its calendar's name, its
// title, its dates with their weekdays and its hours, at most the first 100 by start, plus how many calendars the
// location has and how many repeating events they hold that were not imported. Read through the calendar store, never
// its addresses or Google calendar ids. Titles name customers: the cards show the dates and counts only, never a title
// or a calendar's name, and tool inputs and results are never logged. An event's title reaches the model only in the
// turn that read it: the saved conversation keeps a stub with the counts (`saved`, connect-google-calendar design
// decision 16), so a later turn calls the tool again and reads what is stored then, and a removed calendar's events
// never come back. The tool's name, description and input are unchanged by that (its frozen prefix). In a turn staff
// run with the organization open as its admin, a Google calendar's events are listed as "Google calendar event" from
// "Google calendar", as the Calendar shows them to staff (connect-google-calendar design decision 12), so its reply
// can't quote one. An event becomes a note only through propose_note, which the owner saves.
import { z } from 'zod';

import { daysBetween, EARLIEST_DATE, isoDate, utcDay } from '../../dates.ts';
import { GOOGLE_CALENDAR_LABEL, GOOGLE_EVENT_TITLE } from '../../handlers/google-calendars.ts';
import { weekdayOf } from '../../time-zones.ts';
import type { ChatTool } from './registry.ts';
import { DATE, viewOf } from './shared.ts';

const MAX_RANGE_DAYS = 92;
const MAX_DAYS_AHEAD = 400;
/**
 * At most this many events in one result, as read_data_item keeps to 20,000 characters: a location may hold 10,000
 * (5 calendars of 2,000), and 100 at the longest (a 200 character title, a 60 character name) are about 41,000.
 */
const MAX_EVENTS_LISTED = 100;

const NO_CALENDAR = 'No calendar is connected to this location.';
/** What a later turn reads in place of the events (docs/portal/tuning-chat.md section 3). */
const ELIDED = 'Read in an earlier turn; call get_owner_calendar again for the current events.';

export interface OwnerCalendarRange { from: string; to: string }

function rangeSchema(today: string) {
  return z.object({ from: isoDate, to: isoDate }).refine((range) => range.from >= EARLIEST_DATE && range.from <= range.to
    && daysBetween(range.from, range.to) < MAX_RANGE_DAYS && range.to <= utcDay(new Date(`${today}T00:00:00.000Z`), MAX_DAYS_AHEAD));
}

const count = z.number().int().nonnegative();
const listedResult = z.object({ events: z.array(z.unknown()), truncated: z.boolean(), calendars: count, skippedRepeating: count });
const calendarResult = z.union([
  listedResult,
  // The saved stub of a read that listed events.
  z.object({ calendars: count, eventCount: count, truncated: z.boolean(), skippedRepeating: count, elided: z.literal(true) }),
  z.object({ available: z.literal(false), reason: z.string() }),
]);

export const ownerCalendarTool: ChatTool<OwnerCalendarRange> = {
  definition: {
    name: 'get_owner_calendar',
    description: 'The restaurant\'s own calendars that the owner connected to this location (imported files and subscribed links), for a date range of at most 92 days, both ends included: each single event overlapping the range, by start, at most the first 100 (truncated is true when there are more: call again from the last listed startDate for the rest), with its calendar\'s name, its title, its start and end dates (the end included) with their weekdays, and its start and end times in the town (HH:MM; null when it has none, as for an all-day or multi-day event; an end time before the start time ends after midnight). calendars is how many calendars the location has. skippedRepeating is how many repeating events they hold that Townwise does not import, so none of those are listed. available is false when the location has no calendar.',
    input_schema: {
      type: 'object',
      properties: { from: DATE, to: DATE },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input: from and to are YYYY-MM-DD dates from 2010-01-01, from on or before to, at most 92 days apart counting both ends, and to at most 400 days after today.',
  parse(raw, today) {
    const range = rangeSchema(today).safeParse(raw);
    return range.success ? { from: range.data.from, to: range.data.to } : null;
  },
  inputView: (range) => ({ from: range.from, to: range.to }),
  // Counts only: never a title or a calendar's name. A stub shows the counts the read showed.
  resultView: (content) => viewOf(content, calendarResult, (value) => {
    if ('events' in value) {
      return { available: true, calendars: value.calendars, eventCount: value.events.length, truncated: value.truncated, skippedRepeating: value.skippedRepeating };
    }
    if ('elided' in value) {
      return { available: true, calendars: value.calendars, eventCount: value.eventCount, truncated: value.truncated, skippedRepeating: value.skippedRepeating };
    }
    return { available: false, calendars: 0, eventCount: 0, truncated: false, skippedRepeating: 0 };
  }),
  // A read that listed events keeps its counts only; one with no calendar holds no title and is kept as it is.
  saved(content) {
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      return content;
    }
    const listed = listedResult.safeParse(raw);
    if (!listed.success) return content;
    const { calendars, events, truncated, skippedRepeating } = listed.data;
    return JSON.stringify({ calendars, eventCount: events.length, truncated, skippedRepeating, elided: true, reason: ELIDED });
  },
  async run(tc, range) {
    const store = tc.ctx.stores.ownerCalendars;
    const calendars = await store.list(tc.scope, tc.location.id);
    if (calendars.length === 0) return { content: JSON.stringify({ available: false, reason: NO_CALENDAR }) };
    // Staff open as admin (actorOf's `superadmin`; view-as sends no turn): only files' and links' events keep their
    // names and titles, the calendars read first, so a Google calendar added meanwhile is covered too.
    const shown = tc.actor.actorRole === 'superadmin'
      ? new Set(calendars.filter((calendar) => calendar.kind !== 'google').map((calendar) => calendar.id))
      : null;
    const events = await store.eventsBetween(tc.scope, tc.location.id, range);
    return {
      content: JSON.stringify({
        events: events.slice(0, MAX_EVENTS_LISTED).map((event) => {
          const hidden = shown !== null && !shown.has(event.calendarId);
          return {
            calendar: hidden ? GOOGLE_CALENDAR_LABEL : event.calendar, title: hidden ? GOOGLE_EVENT_TITLE : event.title,
            startDate: event.startDate, startWeekday: weekdayOf(event.startDate), endDate: event.endDate, endWeekday: weekdayOf(event.endDate),
            startTime: event.startTime, endTime: event.endTime,
          };
        }),
        truncated: events.length > MAX_EVENTS_LISTED,
        calendars: calendars.length,
        skippedRepeating: calendars.reduce((sum, calendar) => sum + calendar.skippedRepeating, 0),
      }),
    };
  },
};
