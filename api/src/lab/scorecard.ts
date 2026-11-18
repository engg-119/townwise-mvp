// The scorecard a calibration returns (the lab result's `scorecard`). Strict: unknown keys and non-finite numbers are
// refused, and so are a negative error and more weeks inside a range than weeks with one, since the gate trusts them.
// Since lab-input/2 (D42) the lab also names the engine it returned, both engines' figures on the same weeks, its weekly
// bias and the longer-horizon reports. Those are optional in scorecardSchema, so a stored scorecard from before still
// parses (lab/views.ts, chat/tools/calibration.ts), and required in labScorecardSchema, the one a result is posted
// with (lab/result.ts), since the gate reads them (lab/gate.ts).
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

const coverage = z.strictObject({ inside: count, weeks: count })
  .refine((value) => value.inside <= value.weeks, { message: 'more weeks inside than weeks with a range' });

/** One engine's backtest on the weeks both engines are scored on. */
const engineFiguresSchema = z.strictObject({ weeks: count, weeklyWape: error, weeklyBias: num, coverage80: coverage });

/** Backtest weeks forecast at least 91 days (or the run's longest lead) before their Monday: reported, never gated. */
const horizonReportSchema = z.strictObject({ weeks: count, weeklyWape: error, coverage80: coverage }).nullable();

export const metricsSchema = z.strictObject({
  weeklyWape: error,
  dailyWape: error,
  typicalWeek: error,
  weeksOver20: count,
  worstWeek: error,
  coverage80: coverage,
  dailyCoverage80: nullableNum,
  weekdayBias: bias,
  weekdayBiasMeanAbs: error,
});

const engineSchema = z.enum(['model', 'baseline']);
export type Engine = z.infer<typeof engineSchema>;

const backtestSchema = z.strictObject({
  from: isoDate,
  to: isoDate,
  origins: z.array(isoDate),
  weeks: count,
  weeksWithRange: count,
  metrics: metricsSchema,
  metrics7: metricsSchema,
  weekdayMedianWeeklyWape: error,
  /** The backtest weeks' forecasts minus actuals, over the actuals. */
  weeklyBias: num.optional(),
  folds: z.array(
    z.strictObject({ trainThrough: isoDate, from: isoDate, to: isoDate, weeks: count, weeklyWape: error, weeksOver20: count }),
  ),
  series: z.array(
    z.strictObject({ week: isoDate, actual: z.number().int(), mid: num, low: nullableNum, high: nullableNum }),
  ),
});

/** Each engine's figures on the same weeks; the model's null when it did not run (a span under 595 days). */
const enginesSchema = z.strictObject({ model: engineFiguresSchema.nullable(), baseline: engineFiguresSchema });

/** Rounds a learning curve may hold: the model's 400 (model.py XGB_PARAMS), with room for a longer fit. */
const MAX_ROUNDS = 2000;
const losses = z.array(error).min(1).max(MAX_ROUNDS);

/**
 * How a model run's trees learned (pipeline.py _learning): their loss after each boosting round on the days before the
 * latest half-year fold (train) and on that fold's days, which they never saw (valid). The loss is the mean absolute
 * log residual, a ratio and never a guest figure (D7), so staff may read it in the console.
 */
export const learningSchema = z
  .strictObject({
    trainThrough: isoDate,
    from: isoDate,
    to: isoDate,
    trainDays: count,
    validDays: count,
    metric: z.literal('mae_log'),
    train: losses,
    valid: losses,
  })
  .refine((value) => value.train.length === value.valid.length, { message: 'train and valid differ in rounds' });

/** A scorecard as stored: one from before lab-input/2 has no engine fields. */
export const scorecardSchema = z.strictObject({
  horizonDays: z.literal(28),
  /** The engine whose run this is. */
  engine: engineSchema.optional(),
  history: z.strictObject({ firstDate: isoDate, lastDate: isoDate, days: count, spanDays: count }),
  backtest: backtestSchema,
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
  engines: enginesSchema.optional(),
  horizon91: horizonReportSchema.optional(),
  horizonReach: horizonReportSchema.optional(),
  /** Absent on a baseline run and on any run made before the lab recorded it; null when no fold was long enough. */
  learning: learningSchema.nullable().optional(),
});

/** The scorecard a lab result is posted with (lab-input/2): every engine field present, since the gate reads them. */
export const labScorecardSchema = scorecardSchema.extend({
  engine: engineSchema,
  backtest: backtestSchema.extend({ weeklyBias: num }),
  engines: enginesSchema,
  horizon91: horizonReportSchema,
  horizonReach: horizonReportSchema,
});

export type Scorecard = z.infer<typeof scorecardSchema>;
export type LabScorecard = z.infer<typeof labScorecardSchema>;
export type Learning = z.infer<typeof learningSchema>;
export type Metrics = z.infer<typeof metricsSchema>;
