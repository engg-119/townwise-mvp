import { z } from 'zod';

// The visuals the server draws for a reply (tuning-chat.md, show_visual), mirrored from the API's Visual type.
// Unknown keys are stripped; a visual of an unknown kind or a bad shape fails to parse and is dropped by the caller.
// Net sales values are in dollars, as the API sends them. A daily day's `mid` and `status` default to null, so a visual
// stored before the forecast reached days with no sales replays as it did.

const metric = z.enum(['guests', 'netSales']);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const count = z.number().nullable();

export const visualSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('daily'),
    metric,
    from: date,
    to: date,
    // The forecast's middle and a closed or booked day's status; a visual stored before the API sent them still parses.
    days: z.array(z.object({
      date, value: count, low: count, mid: count.default(null), high: count, status: z.enum(['closed', 'booked']).nullable().default(null),
    })),
    forecast: z.object({ model: z.string(), madeAt: z.string() }).nullable(),
  }),
  z.object({
    kind: z.literal('breakdown'),
    metric,
    from: date,
    to: date,
    by: z.enum(['weekday', 'month']),
    bars: z.array(z.object({ key: z.string(), value: count, days: z.number() })),
  }),
  z.object({
    kind: z.literal('days_table'),
    from: date,
    to: date,
    rows: z.array(z.object({ date, guests: count, netSales: count })),
  }),
  z.object({
    kind: z.literal('metrics'),
    metric,
    from: date,
    to: date,
    total: count,
    dailyAverage: count,
    dayCount: z.number(),
    compare: z.object({
      basis: z.enum(['last_year', 'previous_period']),
      from: date,
      to: date,
      total: count,
      dayCount: z.number(),
    }).nullable(),
  }),
]);

export type Visual = z.infer<typeof visualSchema>;
