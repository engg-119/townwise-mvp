// get_location_overview: the location, today's date, its sales coverage and its latest monthly totals.
import { z } from 'zod';

import { calibrationFor, calibrationWords } from '../../calibration.ts';
import { townProfileOf } from '../../handlers/towns.ts';
import { weekdayOf } from '../../time-zones.ts';
import type { ChatTool } from './registry.ts';
import { dollars, INVALID_INPUT, NO_INPUT, parseNoInput, viewOf } from './shared.ts';

const OVERVIEW_MONTHS = 24;

const overviewResult = z.object({
  coverage: z.object({
    firstDate: z.string().nullable(), lastDate: z.string().nullable(), dayCount: z.number(), missingDays: z.number(),
  }),
  months: z.array(z.unknown()),
});

export const overviewTool: ChatTool<Record<string, never>> = {
  definition: {
    name: 'get_location_overview',
    description: 'The location: its name, its town, today\'s date and weekday in the town\'s time zone (and that time zone), its sales coverage (first and last date, day counts, days missing), its calibration state, and monthly totals for its 24 latest months with sales (days, guests, net sales in US dollars).',
    input_schema: NO_INPUT,
    eager_input_streaming: true,
  },
  invalidInput: INVALID_INPUT,
  parse: parseNoInput,
  inputView: () => null,
  resultView: (content) => viewOf(content, overviewResult, ({ coverage, months }) => ({
    firstDate: coverage.firstDate, lastDate: coverage.lastDate, dayCount: coverage.dayCount,
    missingDays: coverage.missingDays, monthCount: months.length,
  })),
  async run(tc) {
    const { ctx, scope, location } = tc;
    const [coverage, months] = await Promise.all([
      ctx.stores.salesDays.coverage(scope, location.id),
      ctx.stores.salesDays.months(scope, location.id),
    ]);
    const calibration = await calibrationFor(ctx, scope, location, coverage);
    return {
      content: JSON.stringify({
        location: { name: location.name, town: { name: location.town.name, state: location.town.state } },
        today: tc.today,
        // U13A: the town's local date, its weekday and the zone it is read in.
        todayWeekday: weekdayOf(tc.today),
        timeZone: tc.timeZone,
        coverage: {
          firstDate: coverage.firstDate, lastDate: coverage.lastDate, dayCount: coverage.dayCount,
          guestsDayCount: coverage.guestsDayCount, netSalesDayCount: coverage.netSalesDayCount, missingDays: coverage.missingDays,
        },
        calibration: calibration.state,
        // D42: "Townwise refits on {Mon} with the {n} days since." for a stale forecast; D65: then the model card's
        // sentence while the forecast is updating, its start in the town's time; else null.
        calibrationWords: calibrationWords(calibration, tc.timeZone, ctx.now()),
        townProfile: location.town.townId !== null && townProfileOf(location.town.townId) !== undefined,
        months: months.slice(-OVERVIEW_MONTHS).map((month) => ({
          month: month.month, days: month.dayCount, guests: month.guests, netSalesUsd: dollars(month.netSalesCents),
        })),
      }),
    };
  },
};
