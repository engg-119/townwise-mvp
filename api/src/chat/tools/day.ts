// get_day (F2, docs/portal/tuning-chat.md section 4): everything Townwise has for one day of the location, as the
// Analytics day panel shows it: the stored row (guests, net sales), the notes and town calendar entries that cover the
// day, whether it was closed or likely closed (the day classes of people-in-town/history.ts, the client's, pinned by
// the shared fixture; spec D32, read with the town's today: only a day before it is ever likely closed, and only there do
// a day's real guests beat a rule's closure), and when the upload that last wrote it was made. Never who uploaded it, a
// note's author or a file name.
import { z } from 'zod';

import { scheduledRules } from '../../forecasts/adjust.ts';
import { typicalGuests } from '../../closed-days.ts';
import { EARLIEST_DATE, isoDate, utcDay } from '../../dates.ts';
import { classOfDay, closureOfDay } from '../../people-in-town/history.ts';
import type { NoteRecord } from '../../stores/notes.ts';
import { localDay, weekdayOf } from '../../time-zones.ts';
import { townCalendarCovers, townEvents } from '../../town-calendar.ts';
import type { ChatTool } from './registry.ts';
import { DATE, dollars, sourceLinks, viewOf } from './shared.ts';

const MAX_DAYS_AHEAD = 400;

export interface DayInput { date: string }

function dateSchema(today: string) {
  return z.object({ date: isoDate }).refine(({ date }) => date >= EARLIEST_DATE
    && date <= utcDay(new Date(`${today}T00:00:00.000Z`), MAX_DAYS_AHEAD));
}

function covers(note: NoteRecord, date: string): boolean {
  if (date < note.startDate || date > note.endDate) return false;
  return note.weekdays === null || note.weekdays.includes(new Date(`${date}T00:00:00.000Z`).getUTCDay());
}

const dayResult = z.object({
  date: z.string(),
  sales: z.object({}).nullable(),
  closed: z.boolean(),
  notes: z.array(z.unknown()),
  events: z.array(z.object({ sources: z.array(z.object({ url: z.string() })) })),
});

export const dayTool: ChatTool<DayInput> = {
  definition: {
    name: 'get_day',
    description: 'Everything Townwise has for one day of this location: its weekday, its stored guests and net sales in US dollars (sales is null when the day has no stored row; a null value was not recorded), whether it was closed (a covering note says closed; a business rule\'s schedule closes it, unless a note on the day says it was open, and before today only when it had no guests or guests under the likely-closed line; every recorded value is zero; or it was likely closed), likelyClosed (true when the day is before today, its guests were under a tenth of the typical guests of the same weekday over the 8 weeks before and no note or business rule schedule says more or fewer guests: the restaurant was most likely shut, so treat it as closed, never as a slow day, and say it was likely closed; today and later days never are, since their uploads may be partial), the day\'s class (closed, noted, holiday, event or regular), the notes that cover it (each with its title, the event’s name, or null), the town calendar entries on it with their sources (covered is false when Townwise\'s researched calendar for the town doesn\'t reach the day, so only holidays are known), and the date in the town when the upload that last wrote the day was made, and whether it finished.',
    input_schema: {
      type: 'object',
      properties: { date: DATE },
      required: ['date'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input: date is a YYYY-MM-DD date from 2010-01-01 to at most 400 days after today.',
  parse(raw, today) {
    const input = dateSchema(today).safeParse(raw);
    return input.success ? { date: input.data.date } : null;
  },
  inputView: (input) => ({ date: input.date }),
  resultView: (content) => viewOf(content, dayResult, ({ date, sales, closed, notes, events }) => ({
    date, hasSales: sales !== null, closed, noteCount: notes.length, eventCount: events.length,
    sources: sourceLinks(events.flatMap((event) => event.sources.map((source) => source.url))),
  })),
  async run(tc, { date }) {
    const { ctx, scope, location } = tc;
    const { town } = location;
    const [history, allNotes, scheduled] = await Promise.all([
      ctx.stores.salesDays.history(scope, location.id),
      ctx.stores.notes.list(scope, location.id),
      ctx.stores.businessRules.scheduled(scope, location.id),
    ]);
    const rules = scheduledRules(scheduled).map((rule) => rule.schedule);
    const row = history.find((day) => day.date === date);
    const notes = allNotes.filter((note) => covers(note, date));
    const events = townEvents(town.townId, { from: date, to: date });
    const [upload] = row === undefined ? [] : await ctx.stores.uploads.byIds(scope, location.id, [row.uploadId]);
    const guests = new Map(history.map((day) => [day.date, day.guests]));
    const typical = typicalGuests(date, (other) => guests.get(other));
    const dayClass = classOfDay(date, row, notes, events, typical, rules, tc.today);
    const range = townCalendarCovers(town.townId);
    return {
      content: JSON.stringify({
        date, weekday: weekdayOf(date),
        sales: row === undefined ? null : { guests: row.guests, netSalesUsd: dollars(row.netSalesCents) },
        closed: dayClass === 'closed',
        likelyClosed: closureOfDay(date, row, notes, typical, rules, tc.today) === 'likely_closed',
        dayClass,
        notes: notes.map((note) => ({
          kind: note.kind, startDate: note.startDate, endDate: note.endDate, weekdays: note.weekdays, startTime: note.startTime,
          endTime: note.endTime, effect: note.effect, expectedGuests: note.expectedGuests, title: note.title, detail: note.detail,
        })),
        town: { name: town.name, state: town.state },
        covered: range !== null && range.from <= date && date <= range.to,
        events: events.map((event) => ({
          id: event.id, title: event.title, start: event.start, startWeekday: weekdayOf(event.start), end: event.end,
          endWeekday: weekdayOf(event.end), kind: event.kind, scope: event.scope, groupLabel: event.groupLabel,
          confidence: event.confidence, sources: event.sources,
        })),
        upload: upload === undefined ? null : { uploadedOn: localDay(upload.uploadedAt, tc.timeZone), finished: upload.status === 'applied' },
      }),
    };
  },
};
