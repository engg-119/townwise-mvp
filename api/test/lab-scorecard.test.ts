import { describe, expect, it } from 'vitest';

import { scorecardWith } from './helpers/lab-scorecard.ts';
import { scorecardSchema } from '../src/lab/scorecard.ts';

describe('scorecardSchema', () => {
  it('accepts a well-formed scorecard', () => {
    expect(scorecardSchema.safeParse(scorecardWith()).success).toBe(true);
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
