// The scorecard a calibration returns (the lab result's `scorecard`). Strict: unknown keys and non-finite numbers are refused.
import { z } from 'zod';

import { isoDate } from '../dates.ts';

const num = z.number();
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
  weeklyWape: num,
  dailyWape: num,
  typicalWeek: num,
  weeksOver20: count,
  worstWeek: num,
  coverage80: z.strictObject({ inside: count, weeks: count }),
  dailyCoverage80: nullableNum,
  weekdayBias: bias,
  weekdayBiasMeanAbs: num,
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
    weekdayMedianWeeklyWape: num,
    folds: z.array(
      z.strictObject({ trainThrough: isoDate, from: isoDate, to: isoDate, weeks: count, weeklyWape: num, weeksOver20: count }),
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
