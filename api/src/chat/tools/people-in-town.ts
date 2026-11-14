// get_people_in_town (U13A, spec 13.2): who is likely in the location's town each day of a range of at most 92 days,
// from public sources, and how this location's own open regular days ran by term state and weekday. A headcount
// range only where every input has a source; otherwise null with the reason. The same window the people in town route
// serves, read through ctx.ports.peopleInTown.
import { z } from 'zod';

import { daysBetween, EARLIEST_DATE, isoDate, utcDay } from '../../dates.ts';
import { MAX_PEOPLE_RANGE_DAYS } from '../../people-in-town/estimate.ts';
import type { ChatTool } from './registry.ts';
import { DATE, sourceLinks, viewOf } from './shared.ts';

/** How far back a range may start: two years, so past terms can explain last year. */
const MAX_DAYS_BACK = 730;
const MAX_DAYS_AHEAD = 400;

export interface PeopleRange { from: string; to: string }

function rangeSchema(today: string) {
  const at = new Date(`${today}T00:00:00.000Z`);
  const earliest = utcDay(at, -MAX_DAYS_BACK);
  return z.object({ from: isoDate, to: isoDate }).refine((range) => range.from >= EARLIEST_DATE && range.from >= earliest
    && range.from <= range.to && daysBetween(range.from, range.to) < MAX_PEOPLE_RANGE_DAYS && range.to <= utcDay(at, MAX_DAYS_AHEAD));
}

const peopleResult = z.object({
  available: z.boolean(),
  town: z.object({ name: z.string(), state: z.string() }),
  periods: z.array(z.object({ headcount: z.unknown() })),
  sources: z.array(z.object({ url: z.string() })),
});

export const peopleInTownTool: ChatTool<PeopleRange> = {
  definition: {
    name: 'get_people_in_town',
    description: 'Who is likely in the location\'s town each day of a date range of at most 92 days (both ends included, starting at most two years before today), from public sources: the college term (in session, finals, between terms, summer session, or unknown when Townwise has no term dates for the day), town events and holidays, the county\'s seasonal food-service jobs index, and a headcount range only where public counts support one. Also how this location\'s own guests (or net sales, in whole US dollars) differed by term state and weekday on its open regular days, with day counts. Every figure lists its source ids; a null headcount says why in headcountWhy.',
    input_schema: {
      type: 'object',
      properties: { from: DATE, to: DATE },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input: from and to are YYYY-MM-DD dates, from on or before to, at most 92 days apart counting both ends, from at most 730 days before today and to at most 400 days after it.',
  parse(raw, today) {
    const range = rangeSchema(today).safeParse(raw);
    return range.success ? { from: range.data.from, to: range.data.to } : null;
  },
  inputView: (range) => ({ from: range.from, to: range.to }),
  resultView: (content) => viewOf(content, peopleResult, ({ available, town, periods, sources }) => ({
    available, town, periods: periods.length,
    headcount: periods.some((period) => period.headcount !== null) ? 'range' : 'none',
    sources: sourceLinks(sources.map((source) => source.url)),
  })),
  async run(tc, range) {
    const window = await tc.ctx.ports.peopleInTown.window({ scope: tc.scope, location: tc.location, range, today: tc.today });
    return { content: JSON.stringify(window) };
  },
};
