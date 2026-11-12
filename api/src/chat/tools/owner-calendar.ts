// get_owner_calendar (openspec change connect-owner-calendar: the townwise-ai-owner-calendar spec, design decision 8):
// the location's own stored calendars, imported or subscribed, for a range of at most 92 days, with the limits of
// get_town_calendar. Each single event with its calendar's name, its title, its dates with their weekdays and its hours,
// at most the first 100 by start, plus how many calendars the location has and how many repeating events they hold
// that were not imported. Read through the calendar store, never its addresses. Titles name customers: the cards show
// the dates and counts only, never a title or a calendar's name, and tool inputs and results are never logged. An event
// becomes a note only through propose_note, which the owner saves.
import { z } from 'zod';

import { daysBetween, EARLIEST_DATE, isoDate, utcDay } from '../../dates.ts';
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

export interface OwnerCalendarRange { from: string; to: string }

function rangeSchema(today: string) {
  return z.object({ from: isoDate, to: isoDate }).refine((range) => range.from >= EARLIEST_DATE && range.from <= range.to
    && daysBetween(range.from, range.to) < MAX_RANGE_DAYS && range.to <= utcDay(new Date(`${today}T00:00:00.000Z`), MAX_DAYS_AHEAD));
}

const count = z.number().int().nonnegative();
const calendarResult = z.union([
  z.object({ events: z.array(z.unknown()), truncated: z.boolean(), calendars: count, skippedRepeating: count }),
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
  // Counts only: never a title or a calendar's name.
  resultView: (content) => viewOf(content, calendarResult, (value) => ('events' in value
    ? { available: true, calendars: value.calendars, eventCount: value.events.length, truncated: value.truncated, skippedRepeating: value.skippedRepeating }
    : { available: false, calendars: 0, eventCount: 0, truncated: false, skippedRepeating: 0 })),
  async run(tc, range) {
    const store = tc.ctx.stores.ownerCalendars;
    const calendars = await store.list(tc.scope, tc.location.id);
    if (calendars.length === 0) return { content: JSON.stringify({ available: false, reason: NO_CALENDAR }) };
    const events = await store.eventsBetween(tc.scope, tc.location.id, range);
    return {
      content: JSON.stringify({
        events: events.slice(0, MAX_EVENTS_LISTED).map((event) => ({
          calendar: event.calendar, title: event.title, startDate: event.startDate, startWeekday: weekdayOf(event.startDate),
          endDate: event.endDate, endWeekday: weekdayOf(event.endDate), startTime: event.startTime, endTime: event.endTime,
        })),
        truncated: events.length > MAX_EVENTS_LISTED,
        calendars: calendars.length,
        skippedRepeating: calendars.reduce((sum, calendar) => sum + calendar.skippedRepeating, 0),
      }),
    };
  },
};
