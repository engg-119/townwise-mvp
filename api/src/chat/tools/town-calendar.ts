// get_town_calendar (U13A): the town calendar (spec 13.1) for a range of at most 92 days: researched term dates and
// events with their sources and confidence, the town profile's key dates and US federal holidays, each dated row with
// its weekdays. The same calendar the calendar route serves. Public data only.
import { z } from 'zod';

import { daysBetween, EARLIEST_DATE, isoDate, utcDay } from '../../dates.ts';
import { weekdayOf } from '../../time-zones.ts';
import { townCalendarCovers, townEvents } from '../../town-calendar.ts';
import type { ChatTool } from './registry.ts';
import { DATE, sourceLinks, viewOf } from './shared.ts';

const MAX_RANGE_DAYS = 92;
const MAX_DAYS_AHEAD = 400;

export interface CalendarRange { from: string; to: string }

function rangeSchema(today: string) {
  return z.object({ from: isoDate, to: isoDate }).refine((range) => range.from >= EARLIEST_DATE && range.from <= range.to
    && daysBetween(range.from, range.to) < MAX_RANGE_DAYS && range.to <= utcDay(new Date(`${today}T00:00:00.000Z`), MAX_DAYS_AHEAD));
}

const calendarResult = z.object({
  from: z.string(), to: z.string(),
  town: z.object({ name: z.string(), state: z.string() }),
  researched: z.boolean(),
  events: z.array(z.object({ sources: z.array(z.object({ url: z.string() })) })),
});

export const townCalendarTool: ChatTool<CalendarRange> = {
  definition: {
    name: 'get_town_calendar',
    description: 'The public calendar of the location\'s town for a date range of at most 92 days, both ends included: researched term dates (classes and finals), town events and key dates with their sources and the research\'s confidence, and US federal holidays on their actual day. Each event has its start and end weekdays. researched is false when Townwise has researched no events for the town; then only holidays are listed. covers is the span the research covers, all years.',
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
  resultView: (content) => viewOf(content, calendarResult, ({ from, to, town, researched, events }) => ({
    from, to, town, researched, eventCount: events.length, sources: sourceLinks(events.flatMap((event) => event.sources.map((source) => source.url))),
  })),
  run(tc, range) {
    const { town } = tc.location;
    return Promise.resolve({
      content: JSON.stringify({
        from: range.from, to: range.to,
        town: { name: town.name, state: town.state },
        researched: townCalendarCovers(town.townId) !== null,
        covers: townCalendarCovers(town.townId),
        events: townEvents(town.townId, range).map((event) => ({
          id: event.id, title: event.title, start: event.start, startWeekday: weekdayOf(event.start), end: event.end,
          endWeekday: weekdayOf(event.end), kind: event.kind, scope: event.scope, groupLabel: event.groupLabel,
          confidence: event.confidence, sources: event.sources,
        })),
      }),
    });
  },
};
