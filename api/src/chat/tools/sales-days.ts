// get_sales_days: the location's daily rows for a range of at most 92 days, each likely-closed day marked (spec D32): only
// a day before the town's today, since today's upload may be partial, and the notes and rule schedules covering it
// read apart, since a note on a day beats a rule there (closed-days.ts).
import { z } from 'zod';

import { noteCovers } from '../../agent/questions.ts';
import { closureOf, TYPICAL_LOOKBACK_DAYS, typicalByDate } from '../../closed-days.ts';
import { daysBetween, isoDate, utcDay } from '../../dates.ts';
import { scheduledRules } from '../../forecasts/adjust.ts';
import type { ChatTool } from './registry.ts';
import { DATE, dollars, viewOf } from './shared.ts';

const MAX_SALES_RANGE_DAYS = 92;

const salesRange = z.object({ from: isoDate, to: isoDate })
  .refine((range) => range.from <= range.to && daysBetween(range.from, range.to) < MAX_SALES_RANGE_DAYS);

const salesResult = z.object({
  from: z.string(), to: z.string(),
  days: z.array(z.object({ guests: z.number().nullable(), netSalesUsd: z.number().nullable() })),
});

export interface SalesRange { from: string; to: string }

export const salesDaysTool: ChatTool<SalesRange> = {
  definition: {
    name: 'get_sales_days',
    description: 'Daily rows for a date range of at most 92 days, both ends included: date, guests and net sales in US dollars. A day with no row has no data; a null value was not recorded. A day with likelyClosed true was before today, had guests under a tenth of the typical guests of the same weekday over the 8 weeks before, and no note or business rule schedule says more or fewer guests: the restaurant was most likely shut, so treat it as closed, never as a slow day, and say it was likely closed. Today and later days are never marked, since their uploads may be partial.',
    input_schema: {
      type: 'object',
      properties: { from: DATE, to: DATE },
      required: ['from', 'to'],
      additionalProperties: false,
    },
    eager_input_streaming: true,
  },
  invalidInput: 'Invalid input: from and to are YYYY-MM-DD dates, from on or before to, at most 92 days apart counting both ends.',
  parse(raw) {
    const range = salesRange.safeParse(raw);
    return range.success ? range.data : null;
  },
  inputView: (range) => ({ from: range.from, to: range.to }),
  resultView: (content) => viewOf(content, salesResult, ({ from, to, days }) => ({
    from, to, dayCount: days.length,
    guestsDayCount: days.filter((day) => day.guests !== null).length,
    netSalesDayCount: days.filter((day) => day.netSalesUsd !== null).length,
  })),
  async run(tc, range) {
    // The 8 weeks before the range too, for each day's typical guests.
    const read = { from: utcDay(new Date(`${range.from}T00:00:00.000Z`), -TYPICAL_LOOKBACK_DAYS), to: range.to };
    const [stored, notes, scheduled] = await Promise.all([
      tc.ctx.stores.salesDays.days(tc.scope, tc.location.id, read),
      tc.ctx.stores.notes.list(tc.scope, tc.location.id),
      tc.ctx.stores.businessRules.scheduled(tc.scope, tc.location.id),
    ]);
    const rules = scheduledRules(scheduled);
    const typical = typicalByDate(stored);
    const days = stored.filter((day) => day.date >= range.from).map((day) => {
      const covering = rules.map((rule) => rule.schedule).filter((schedule) => noteCovers(schedule, day.date));
      const likely = closureOf(day, typical.get(day.date) ?? null, notes.filter((note) => noteCovers(note, day.date)), {
        rules: covering, past: day.date < tc.today,
      }) === 'likely_closed';
      return { date: day.date, guests: day.guests, netSalesUsd: dollars(day.netSalesCents), ...(likely ? { likelyClosed: true } : {}) };
    });
    return { content: JSON.stringify({ from: range.from, to: range.to, days }) };
  },
};
