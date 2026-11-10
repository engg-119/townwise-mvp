// The scorecard a calibration returns (the lab result's `scorecard`). Strict: unknown keys and non-finite numbers are
// refused, and so are a negative error and more weeks inside a range than weeks with one, since the gate trusts them.
import { z } from 'zod';

import { isoDate } from '../dates.ts';

const num = z.number();
/** An error measure (a WAPE, a week's error, a mean absolute bias): zero or more. */
const error = z.number().min(0);
const count = z.number().int().min(0);
const nullableNum = num.nullable();

const bias = z.strictObject({
  Mon: nullableNum,
  Tue: nullableNum,
  Wed: nullableNum,
  Thu: nullableNum,
  Fri: nullableNum,
  Sat: nullableNum,
  Sun: nullableNum,
});

export const metricsSchema = z.strictObject({
  weeklyWape: error,
  dailyWape: error,
  typicalWeek: error,
  weeksOver20: count,
  worstWeek: error,
  coverage80: z.strictObject({ inside: count, weeks: count })
    .refine((coverage) => coverage.inside <= coverage.weeks, { message: 'more weeks inside than weeks with a range' }),
  dailyCoverage80: nullableNum,
  weekdayBias: bias,
  weekdayBiasMeanAbs: error,
});

export const scorecardSchema = z.strictObject({
  horizonDays: z.literal(28),
  history: z.strictObject({ firstDate: isoDate, lastDate: isoDate, days: count, spanDays: count }),
  backtest: z.strictObject({
    from: isoDate,
    to: isoDate,
    origins: z.array(isoDate),
    weeks: count,
    weeksWithRange: count,
    metrics: metricsSchema,
    metrics7: metricsSchema,
    weekdayMedianWeeklyWape: error,
    folds: z.array(
      z.strictObject({ trainThrough: isoDate, from: isoDate, to: isoDate, weeks: count, weeklyWape: error, weeksOver20: count }),
    ),
    series: z.array(
      z.strictObject({ week: isoDate, actual: z.number().int(), mid: num, low: nullableNum, high: nullableNum }),
    ),
  }),
  comparison: z
    .strictObject({
      championRunId: z.string().min(1),
      championDataThrough: isoDate,
      from: isoDate,
      to: isoDate,
      weeks: count,
      champion: metricsSchema,
      challenger: metricsSchema,
      series: z.array(
        z.strictObject({
          week: isoDate,
          actual: z.number().int(),
          champion: num,
          challenger: num,
          challengerLow: nullableNum,
          challengerHigh: nullableNum,
        }),
      ),
    })
    .nullable(),
});

export type Scorecard = z.infer<typeof scorecardSchema>;
export type Metrics = z.infer<typeof metricsSchema>;
