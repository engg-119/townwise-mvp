import { describe, expect, it } from 'vitest';

import { scorecardWith } from './helpers/lab-scorecard.ts';
import { scorecardSchema } from '../src/lab/scorecard.ts';

describe('scorecardSchema', () => {
  it('accepts a well-formed scorecard', () => {
    expect(scorecardSchema.safeParse(scorecardWith()).success).toBe(true);
  });

  it('accepts the engine fields of a lab-input/2 calibration (D42), and a stored scorecard from before without them', () => {
    const figures = { weeks: 37, weeklyWape: 0.097, weeklyBias: -0.034, coverage80: { inside: 15, weeks: 25 } };
    const report = { weeks: 28, weeklyWape: 0.094, coverage80: { inside: 4, weeks: 7 } };
    const base = scorecardWith();
    const withEngines = {
      ...base, engine: 'baseline', backtest: { ...base.backtest, weeklyBias: -0.034 },
      engines: { model: { ...figures, weeklyWape: 0.168 }, baseline: figures }, horizon91: report, horizonReach: null,
    };
    expect(scorecardSchema.safeParse(withEngines).success).toBe(true);
    expect(scorecardSchema.safeParse({ ...withEngines, engines: { model: null, baseline: figures } }).success).toBe(true);
    expect(scorecardSchema.safeParse(base).success).toBe(true);
    // Strict as the rest: an unknown engine, a negative WAPE or more weeks inside than with a range is refused.
    expect(scorecardSchema.safeParse({ ...withEngines, engine: 'xgboost' }).success).toBe(false);
    expect(scorecardSchema.safeParse({ ...withEngines, horizon91: { ...report, weeklyWape: -1 } }).success).toBe(false);
    expect(scorecardSchema.safeParse({ ...withEngines, engines: { model: null, baseline: { ...figures, coverage80: { inside: 26, weeks: 25 } } } }).success)
      .toBe(false);
    expect(scorecardSchema.safeParse({ ...withEngines, horizon91: { ...report, extra: 1 } }).success).toBe(false);
  });

  it('refuses unknown keys and NaN', () => {
    expect(scorecardSchema.safeParse({ ...scorecardWith(), extra: 1 }).success).toBe(false);
    const base = scorecardWith();
    const nan = { ...base, backtest: { ...base.backtest, weekdayMedianWeeklyWape: Number.NaN } };
    expect(scorecardSchema.safeParse(nan).success).toBe(false);
    const nested = { ...base, history: { ...base.history, extra: 1 } };
    expect(scorecardSchema.safeParse(nested).success).toBe(false);
  });
});
