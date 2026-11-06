// get_sales_days: the location's daily rows for a range of at most 92 days.
import { z } from 'zod';

import { daysBetween, isoDate } from '../../dates.ts';
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
    description: 'Daily rows for a date range of at most 92 days, both ends included: date, guests and net sales in US dollars. A day with no row has no data; a null value was not recorded.',
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
    const days = await tc.ctx.stores.salesDays.days(tc.scope, tc.location.id, range);
    return {
      content: JSON.stringify({
        from: range.from, to: range.to,
        days: days.map((day) => ({ date: day.date, guests: day.guests, netSalesUsd: dollars(day.netSalesCents) })),
      }),
    };
  },
};
